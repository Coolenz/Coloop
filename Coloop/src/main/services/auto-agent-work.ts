import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  autoAgentCreateSchema,
  autoAgentDecisionSchema,
  autoAgentFeedbackSchema,
  type AutoAgentAction,
  type AutoAgentDraftRecoveryProof,
  type AutoAgentDecisionOutput,
  type AutoAgentEvent,
  type AutoAgentFeedback,
  type AutoAgentHookStatus,
  type AutoAgentMemory,
  type AutoAgentSession,
  type AutoAgentTask,
  type AutoAgentWorkSnapshot,
} from '../../shared/auto-agent-work'

export interface AutoAgentWorkOptions {
  directory: string
  canAutoBind?(): boolean
  sessions(): AutoAgentSession[]
  events?(sessionId: string): AutoAgentEvent[]
  hooks(): AutoAgentHookStatus
  memory(task: AutoAgentTask): Promise<AutoAgentMemory>
  decide(
    task: AutoAgentTask,
    signal: AbortSignal,
  ): Promise<{ output: AutoAgentDecisionOutput; model: string }>
  channel(task: AutoAgentTask): AutoAgentAction['channel']
  dispatch(
    task: AutoAgentTask,
    action: AutoAgentAction,
    signal: AbortSignal,
  ): Promise<{ status: AutoAgentAction['status']; receipt?: string }>
  recoverDraft?(
    task: AutoAgentTask,
    action: AutoAgentAction,
    signal: AbortSignal,
    claim: (proof: AutoAgentDraftRecoveryProof) => void,
  ): Promise<{ status: AutoAgentAction['status']; receipt?: string }>
  stopAgent(task: AutoAgentTask): Promise<void>
  invalidate?(sessionId: string): void
  feedback?(task: AutoAgentTask, feedback: AutoAgentFeedback): Promise<void>
  usage?(id: string): AutoAgentTask['usage']
  onChange?(): void
  onUserChoice?(task: AutoAgentTask, event: AutoAgentEvent): Promise<'stored' | 'ignored' | void>
}

const isActive = (task: AutoAgentTask) =>
  ['watching', 'deciding', 'waiting_receipt'].includes(task.state)
const uncertain = (action: AutoAgentAction) =>
  ['dispatching', 'accepted', 'unknown'].includes(action.status)
const pending = (action: AutoAgentAction) => action.status === 'prepared' || uncertain(action)
const copy = <T>(value: T): T => structuredClone(value)
const requirementsHash = (task: AutoAgentTask) =>
  createHash('sha256')
    .update(JSON.stringify([task.goal, task.authorization, task.acceptance, task.supplements]))
    .digest('hex')
const recoveryProofSchema = z
  .object({
    draftSha256: z.string().regex(/^[a-f0-9]{64}$/),
    draftLength: z.number().int().positive().max(24000),
    pasteReceipt: z.string().min(1).max(16384),
    sendAbsent: z.literal(true),
  })
  .strict()
function executionReceipt(error: unknown): string | undefined {
  const receipt = (error as { receipt?: unknown } | null)?.receipt
  if (!receipt || typeof receipt !== 'object') return
  try {
    const serialized = JSON.stringify(receipt)
    if (Buffer.byteLength(serialized) <= 16384) return serialized
  } catch {
    /* Malformed diagnostics never replace the execution outcome. */
  }
}

/** Durable supervisor. DSH decides; this service validates ownership and writes once. */
export class AutoAgentWorkService {
  private tasks: AutoAgentTask[] = []
  private controllers = new Map<string, AbortController>()
  private running = new Set<string>()
  private recovering = new Set<string>()
  private error?: string
  private disposed = false
  private enabled = false
  private feedbackFlush?: Promise<void>
  private feedbackFlushRequested = false
  private feedbackRetry?: ReturnType<typeof setTimeout>
  private feedbackRetryDelay = 1000
  constructor(private options: AutoAgentWorkOptions) {
    mkdirSync(options.directory, { recursive: true })
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8'))
        if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('VERSION')
        this.tasks = saved.tasks
        this.enabled = saved.enabled === true
        for (const task of this.tasks) {
          if (!task.id || !Array.isArray(task.actions) || !Array.isArray(task.events))
            throw new Error('TASK')
          if (isActive(task)) {
            task.state = 'paused'
            task.pauseReason = '应用重新启动；恢复前核对原会话与动作结果。'
          }
          for (const action of task.actions) {
            if (action.status === 'prepared') action.status = 'cancelled'
            else if (action.status === 'dispatching' || action.status === 'accepted')
              action.status = 'unknown'
          }
        }
        this.persist()
      } catch {
        this.error = 'AUTO_AGENT_JOURNAL_UNAVAILABLE'
      }
    }
    // Attribution is an independent durable outbox. Restart never makes a
    // completed delivery wait for memory, and never invents a new feedback ID.
    queueMicrotask(() => {
      void this.retryFeedback()
    })
  }
  private get path() {
    return join(this.options.directory, 'auto-agent-work.json')
  }
  private persist() {
    if (this.error) throw new Error(this.error)
    try {
      writeFileSync(
        this.path + '.tmp',
        JSON.stringify({ version: 1, enabled: this.enabled, tasks: this.tasks }),
        {
          mode: 0o600,
          flush: true,
        },
      )
      renameSync(this.path + '.tmp', this.path)
    } catch (error) {
      this.error = 'AUTO_AGENT_JOURNAL_UNAVAILABLE'
      throw error
    }
    this.options.onChange?.()
  }
  get active() {
    return this.tasks.some(isActive)
  }
  get bound() {
    return this.tasks.some((task) => !['completed', 'unbound'].includes(task.state))
  }
  snapshot(): AutoAgentWorkSnapshot {
    return {
      enabled: this.enabled,
      sessions: copy(this.options.sessions()),
      tasks: this.tasks.map((task) => ({
        ...copy(task),
        usage: this.options.usage?.(task.costTaskId),
      })),
      hooks: this.options.hooks(),
      active: this.active,
      journalError: this.error,
    }
  }
  setEnabled(enabled: boolean) {
    if (this.disposed || this.error) throw new Error(this.error ?? 'AUTO_AGENT_DISPOSED')
    this.enabled = enabled
    if (!enabled) this.pauseAll('主页自动推进开关已关闭')
    this.persist()
    return { enabled }
  }
  private task(id: string) {
    const task = this.tasks.find((value) => value.id === id)
    if (!task) throw new Error('AUTO_AGENT_TASK_NOT_FOUND')
    return task
  }
  private live(task: AutoAgentTask, allowReconnect = false) {
    const sessions = this.options.sessions().filter((value) => value.state !== 'closed')
    const exact = sessions.find(
      (value) => value.id === task.session.id && value.instanceId === task.session.instanceId,
    )
    if (exact) return exact
    const matches = allowReconnect
      ? sessions.filter(
          (value) =>
            value.source === task.session.source && value.sessionId === task.session.sessionId,
        )
      : []
    if (matches.length !== 1) throw new Error('原会话未连接或存在多个匹配；请核对后恢复。')
    const live = matches[0]
    if (
      this.tasks.some(
        (value) =>
          value.id !== task.id &&
          value.session.id === live.id &&
          !['completed', 'unbound'].includes(value.state),
      )
    )
      throw new Error('恢复的会话已有其他任务绑定')
    return live
  }
  create(input: unknown) {
    if (this.disposed || this.error) throw new Error(this.error ?? 'AUTO_AGENT_DISPOSED')
    const value = autoAgentCreateSchema.parse(input)
    const session = this.options.sessions().find((item) => item.id === value.sessionId)
    if (!session || session.state === 'closed') throw new Error('请选择已连接的 Agent 会话')
    if (
      this.tasks.some(
        (task) => task.session.id === session.id && !['completed', 'unbound'].includes(task.state),
      )
    )
      throw new Error('此会话已绑定任务，请补充或恢复现有任务')
    const id = randomUUID(),
      now = new Date().toISOString()
    const seenEvents = new Set<string>()
    const events = (this.options.events?.(session.id) ?? [])
      .filter((event) => {
        if (
          event.sessionId !== session.id ||
          event.instanceId !== session.instanceId ||
          event.agentId ||
          event.parentTurnId ||
          event.revision > session.revision ||
          seenEvents.has(event.id)
        )
          return false
        seenEvents.add(event.id)
        return true
      })
      .sort((a, b) => a.revision - b.revision)
      .slice(-120)
      .map((event) => {
        const observed = copy(event)
        delete observed.choiceMemory
        return observed
      })
    const task: AutoAgentTask = {
      id,
      version: 1,
      session: copy(session),
      goal: value.goal,
      authorization: value.authorization,
      acceptance: value.acceptance,
      supplements: [],
      state: 'watching',
      createdAt: now,
      updatedAt: now,
      lastEvaluatedRevision: -1,
      events: copy(events),
      decisions: [],
      actions: [],
      feedback: [],
      costTaskId: id,
    }
    this.tasks.unshift(task)
    this.persist()
    this.schedule(task)
    return id
  }
  private invalidate(task: AutoAgentTask) {
    this.controllers.get(task.id)?.abort()
    this.options.invalidate?.(task.session.id)
    for (const action of task.actions) if (action.status === 'prepared') action.status = 'cancelled'
  }
  private requireSourceApproval(task: AutoAgentTask) {
    this.invalidate(task)
    task.version++
    if (task.state !== 'paused') {
      task.state = 'needs_user'
      task.pauseReason = '原 Agent 正在请求权限审批；请在原会话处理后显式恢复自动推进。'
      task.error = undefined
    }
  }
  async update(input: unknown) {
    if (this.disposed || this.error) throw new Error(this.error ?? 'AUTO_AGENT_DISPOSED')
    const value = z
      .object({
        taskId: z.string().uuid(),
        action: z.enum(['pause', 'resume', 'unbind', 'stop_agent', 'supplement']),
        text: z.string().trim().min(1).max(24000).optional(),
      })
      .strict()
      .parse(input)
    const task = this.task(value.taskId)
    if (value.action === 'resume' && this.recovering.has(task.id))
      throw new Error('原动作仍在处理中；请等待本次核对结束')
    if (['completed', 'unbound'].includes(task.state))
      throw new Error('任务已结束；如有新目标请新建任务')
    if (value.action === 'supplement' && !value.text) throw new Error('请输入补充要求')
    const outstanding = task.actions.filter(uncertain)
    const recovery =
      value.action === 'resume' && outstanding.length
        ? outstanding.length === 1 &&
          outstanding[0].status === 'unknown' &&
          outstanding[0].channel === 'desktop'
          ? outstanding[0]
          : undefined
        : undefined
    if (recovery && this.options.recoverDraft && this.running.has(task.id))
      throw new Error('原动作仍在处理中；请等待本次核对结束')
    const live =
      value.action === 'resume' || value.action === 'supplement'
        ? this.live(task, value.action === 'resume')
        : undefined
    this.invalidate(task)
    task.version++
    task.updatedAt = new Date().toISOString()
    task.error = undefined
    if (value.action === 'stop_agent') {
      task.state = 'paused'
      task.pauseReason = '已请求停止外部 Agent'
      this.persist()
      await this.options.stopAgent(copy(task))
      return
    }
    if (value.action === 'pause') {
      task.state = 'paused'
      task.pauseReason = '用户暂停自动推进'
    }
    if (value.action === 'unbind') {
      task.state = 'unbound'
      task.pauseReason = undefined
    }
    if (value.action === 'supplement') {
      task.supplements.push(value.text!)
      // Additional requirements are authoritative and never relax existing ones implicitly.
      task.acceptance.push(value.text!)
    }
    if (value.action === 'resume' || value.action === 'supplement') {
      task.session = copy(live!)
      task.state = 'watching'
      task.pauseReason = undefined
      task.lastEvaluatedRevision = -1
      task.memory = undefined
    }
    this.persist()
    if (recovery && this.options.recoverDraft) {
      // The async method reserves its controller and ownership synchronously.
      // Keep UI pause/takeover available while foreground reconciliation waits.
      void this.recoverDraft(task, recovery).catch(() => {
        /* Execution errors are recorded inside; persistence failure closes the journal. */
      })
      return
    }
    this.schedule(task)
  }
  private async recoverDraft(task: AutoAgentTask, action: AutoAgentAction) {
    const controller = new AbortController()
    const version = task.version,
      revision = task.session.revision,
      context = requirementsHash(task)
    let claimed = false
    const sameContext = () =>
      action.requirementsHash
        ? action.requirementsHash === requirementsHash(task)
        : // Older records have no hash. Existing APIs only change requirements via
          // supplement; goal and authorization have no mutation endpoint.
          task.supplements.length === 0
    const current = () =>
      !this.disposed &&
      !this.error &&
      !controller.signal.aborted &&
      isActive(task) &&
      task.version === version &&
      task.session.revision === revision &&
      requirementsHash(task) === context
    this.controllers.set(task.id, controller)
    this.running.add(task.id)
    this.recovering.add(task.id)
    task.state = 'waiting_receipt'
    task.lastEvaluatedRevision = revision
    try {
      if (!sameContext()) throw new Error('任务要求已变化，不能发送旧的推进草稿')
      if (task.session.state !== 'idle') throw new Error('原会话尚未空闲；不能恢复发送草稿')
      const decision = task.decisions.find((item) => item.id === action.decisionId)
      if (
        !decision ||
        decision.taskVersion !== action.taskVersion ||
        decision.message !== action.message ||
        !['continue', 'reply'].includes(decision.action)
      )
        throw new Error('旧动作缺少对应决定，不能恢复发送')
      this.persist()
      const result = await this.options.recoverDraft!(
        copy(task),
        copy(action),
        controller.signal,
        (input) => {
          controller.signal.throwIfAborted()
          const proof = recoveryProofSchema.parse(input)
          const expected = `[Coloop Auto Agent Work:${action.id}]\n${action.message}`.replace(
            /\r\n/g,
            '\n',
          )
          const live = this.live(task)
          if (
            claimed ||
            !current() ||
            !sameContext() ||
            action.status !== 'unknown' ||
            task.actions.filter(pending).length !== 1 ||
            live.state !== 'idle' ||
            live.revision !== revision ||
            live.turnId !== task.session.turnId ||
            proof.draftLength !== expected.length ||
            proof.draftSha256 !== createHash('sha256').update(expected).digest('hex')
          )
            throw new Error('草稿恢复证据或任务状态已变化；未发送')
          action.recovery = {
            taskVersion: version,
            eventRevision: revision,
            phase: 'send_claimed',
            proof,
          }
          action.status = 'dispatching'
          action.error = undefined
          action.updatedAt = new Date().toISOString()
          this.persist() // Persist the sole Enter claim before the executor can act.
          claimed = true
        },
      )
      if (!claimed) throw new Error('草稿恢复没有取得持久化发送凭证')
      if (!['accepted', 'confirmed', 'unknown'].includes(result.status))
        throw new Error('草稿恢复发送结果不明确')
      if (action.status === 'dispatching' || action.status === 'accepted') {
        action.status = result.status
        action.receipt = result.receipt
      }
      if (current()) this.applyReceiptState(task, action)
    } catch (error) {
      if (action.status !== 'confirmed') {
        action.status = 'unknown' // A pasted draft is never a proof of no effects.
        action.error = error instanceof Error ? error.message : '草稿恢复结果未知'
        action.receipt = executionReceipt(error) ?? action.receipt
        if (
          !this.disposed &&
          !controller.signal.aborted &&
          isActive(task) &&
          task.version === version
        ) {
          task.state = 'needs_user'
          task.error = action.error
        }
      }
    } finally {
      action.updatedAt = new Date().toISOString()
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id)
      this.running.delete(task.id)
      this.recovering.delete(task.id)
      if (!this.disposed && !this.error) {
        try {
          this.persist()
        } catch {
          /* persist records journalError; no detached rejection. */
        }
      }
      // Only a newer confirmed native result may trigger normal acceptance.
      // Resuming the same revision never launches the planner.
      if (
        action.status === 'confirmed' &&
        task.version === version &&
        task.session.revision > revision
      )
        this.schedule(task)
    }
  }
  async observe(event: AutoAgentEvent, session: AutoAgentSession) {
    if (this.disposed || this.error) return
    // Attribution belongs to this journal, never to an incoming hook payload.
    event = copy(event)
    delete event.choiceMemory
    if (
      this.enabled &&
      (this.options.canAutoBind?.() ?? true) &&
      !event.agentId &&
      !event.parentTurnId &&
      session.id === event.sessionId &&
      session.instanceId === event.instanceId &&
      session.revision === event.revision &&
      ((event.type === 'started' && session.source === 'opencode' && session.state === 'running') ||
        (event.type === 'user_input' && event.origin === 'user')) &&
      !this.tasks.some(
        (task) => task.session.id === session.id && !['completed', 'unbound'].includes(task.state),
      )
    ) {
      const id = this.create({
        sessionId: session.id,
        goal: (event.text?.trim() || session.title || '跟进当前 Agent 任务').slice(0, 24000),
        acceptance: ['完成原会话中用户要求的任务，并提供实际结果与验证证据'],
        authorization: '在原会话用户已授权的任务范围内推进、核验和回答业务选择。',
      })
      const created = this.task(id)
      if (!created.events.some((item) => item.id === event.id)) {
        created.events.push(copy(event))
        this.persist()
      }
      return
    }
    const task = this.tasks.find(
      (value) =>
        value.session.id === event.sessionId &&
        value.session.instanceId === event.instanceId &&
        !['completed', 'unbound'].includes(value.state),
    )
    if (
      !task ||
      event.agentId ||
      event.parentTurnId ||
      task.events.some((value) => value.id === event.id)
    )
      return
    if (
      session.id !== event.sessionId ||
      session.instanceId !== event.instanceId ||
      session.revision !== event.revision
    )
      return
    if (event.revision <= task.session.revision && task.events.length) return
    const receiptAction =
      event.type === 'receipt' && event.origin === 'coloop' && event.actionId
        ? task.actions.find(
            (value) =>
              value.id === event.actionId && (uncertain(value) || value.status === 'confirmed'),
          )
        : undefined
    // A late round must never finish the active round.
    if (
      event.turnId &&
      task.session.turnId &&
      event.turnId !== task.session.turnId &&
      event.type !== 'started' &&
      event.type !== 'user_input' &&
      !receiptAction
    )
      return
    // A new event invalidates any unclaimed offer made against the previous revision.
    if (
      event.revision > task.session.revision &&
      task.actions.some((action) => action.status === 'prepared')
    )
      this.invalidate(task)
    const directUserChoice =
      event.type === 'user_input' && event.origin === 'user' && !event.actionId
    if (directUserChoice && this.options.onUserChoice)
      event.choiceMemory = { attribution: 'pending', workspace: session.workspace }
    task.session = copy(session)
    task.events.push(event)
    // Unacknowledged source events remain durable until the writer has handled them.
    task.events = task.events.filter(
      (item, index) =>
        index >= task.events.length - 120 ||
        ['pending', 'failed'].includes(item.choiceMemory?.attribution ?? ''),
    )
    task.updatedAt = event.at
    if (receiptAction) {
      receiptAction.status = 'confirmed'
      receiptAction.receipt = event.id
      receiptAction.updatedAt = event.at
      this.applyReceiptState(task, receiptAction)
    }
    if (event.type === 'question' && event.questionKind === 'approval') {
      this.requireSourceApproval(task)
    } else if (
      (event.type === 'user_input' && event.origin !== 'coloop') ||
      event.type === 'interrupted' ||
      event.type === 'closed'
    ) {
      this.invalidate(task)
      task.version++
      task.state = 'paused'
      task.pauseReason = '用户接管或会话中断，待明确恢复'
    } else if (isActive(task)) {
      if (event.type === 'started' || event.type === 'progress') task.state = 'watching'
      if (['stopped', 'question', 'error'].includes(event.type))
        this.controllers.get(task.id)?.abort()
    }
    this.persist()
    if (directUserChoice) void this.retryFeedback()
    this.schedule(task)
  }
  /** Called before returning native Stop output. Must flush ownership before any effect. */
  claimNative(actionId: string, sessionId: string, version: number): boolean {
    const task = this.tasks.find(
      (value) => value.session.id === sessionId && value.version === version && isActive(value),
    )
    const action = task?.actions.find((value) => value.id === actionId)
    if (!task || !action || action.status !== 'prepared' || action.channel !== 'native')
      return false
    action.status = 'dispatching'
    action.updatedAt = new Date().toISOString()
    this.persist()
    return true
  }
  /** Atomically move an unclaimed native offer to desktop; a claimed offer can never fall back. */
  fallbackNativeAction(actionId: string): AutoAgentAction {
    const task = this.tasks.find((value) => value.actions.some((action) => action.id === actionId))
    const action = task?.actions.find((value) => value.id === actionId)
    if (
      !task ||
      !action ||
      !isActive(task) ||
      task.version !== action.taskVersion ||
      action.status !== 'prepared' ||
      action.channel !== 'native'
    )
      throw new Error('原生续推已领取或失效，不能切换通道重发')
    const live = this.live(task)
    if (
      live.state === 'running' ||
      live.revision !== action.eventRevision ||
      task.session.revision !== action.eventRevision
    )
      throw new Error('会话状态已更新，不能执行旧的界面回写')
    action.channel = 'desktop'
    action.status = 'dispatching'
    action.updatedAt = new Date().toISOString()
    this.persist()
    return copy(action)
  }
  receipt(
    actionId: string,
    status: 'accepted' | 'confirmed' | 'unknown' | 'failed',
    receipt?: string,
  ) {
    const task = this.tasks.find((value) => value.actions.some((action) => action.id === actionId))
    const action = task?.actions.find((value) => value.id === actionId)
    if (!task || !action || ['confirmed', 'cancelled', 'failed'].includes(action.status)) return
    if (action.status === 'unknown' && status === 'accepted') return
    action.status = status
    action.receipt = receipt
    action.updatedAt = new Date().toISOString()
    this.applyReceiptState(task, action)
    this.persist()
  }
  private applyReceiptState(task: AutoAgentTask, action: AutoAgentAction) {
    if (!isActive(task) || task.version !== (action.recovery?.taskVersion ?? action.taskVersion))
      return
    if (action.status === 'failed') {
      task.state = 'needs_user'
      task.error = `推进消息未发送；处理原因后恢复：${action.error ?? action.receipt ?? '执行通道拒绝发送'}`
    } else if (action.status === 'unknown') {
      task.state = 'needs_user'
      task.error = `上一动作结果尚未核对，不能重发：${action.error ?? action.receipt ?? '发送回执缺失'}`
    } else if (action.status === 'confirmed') task.state = 'watching'
  }
  private schedule(task: AutoAgentTask) {
    if (
      this.disposed ||
      !isActive(task) ||
      this.running.has(task.id) ||
      task.session.state === 'running'
    )
      return
    if (task.session.revision <= task.lastEvaluatedRevision) return
    this.running.add(task.id)
    queueMicrotask(
      () =>
        void this.evaluate(task)
          .finally(() => {
            this.running.delete(task.id)
            this.schedule(task)
          })
          .catch(() => {
            /* A failed persist already exposes journalError; detached evaluation must not reject. */
          }),
    )
  }
  private async evaluate(task: AutoAgentTask) {
    // Scheduling and execution are separated by a microtask. A pause, unbind,
    // shutdown or a new running event can win that gap before a controller
    // exists to abort. Revalidate before changing state or invoking any model.
    if (
      this.disposed ||
      !isActive(task) ||
      task.session.state === 'running' ||
      task.session.revision <= task.lastEvaluatedRevision
    )
      return
    // Binding an already-awaiting session or resuming before its source approval
    // has been handled must enforce the same boundary as a live approval event.
    const latestQuestion = [...task.events]
      .reverse()
      .find(
        (event) =>
          event.type === 'question' &&
          (!event.turnId || !task.session.turnId || event.turnId === task.session.turnId),
      )
    if (task.session.state === 'awaiting_input' && latestQuestion?.questionKind === 'approval') {
      this.requireSourceApproval(task)
      this.persist()
      return
    }
    const controller = new AbortController(),
      version = task.version,
      revision = task.session.revision
    this.controllers.set(task.id, controller)
    const current = () =>
      !this.disposed &&
      !controller.signal.aborted &&
      isActive(task) &&
      task.version === version &&
      task.session.revision === revision
    try {
      task.state = 'deciding'
      task.lastEvaluatedRevision = revision
      this.persist()
      if (task.memory?.version !== version)
        task.memory = await this.options.memory(copy(task)).catch((): AutoAgentMemory => ({
          status: 'unavailable',
          references: [],
          version,
          error: '记忆服务暂不可用；依据当前要求继续',
        }))
      if (!current()) return
      const result = await this.options.decide(copy(task), controller.signal)
      if (!current()) return
      const output = autoAgentDecisionSchema.parse(result.output)
      const decision = {
        ...output,
        id: randomUUID(),
        taskVersion: version,
        eventRevision: revision,
        trigger: task.events.at(-1)?.type ?? 'bound',
        model: result.model,
        createdAt: new Date().toISOString(),
        memoryReferences: task.memory?.references.map((value) => value.id) ?? [],
      }
      task.decisions.push(decision)
      task.state = 'watching'
      if (output.action === 'complete') {
        const verdict = output.acceptance
        const covered =
          verdict?.verdict === 'pass' &&
          !verdict.gaps.length &&
          task.acceptance.every((requirement) =>
            verdict.requirements.some(
              (row) => row.requirement === requirement && row.satisfied && row.evidence.trim(),
            ),
          )
        if (!covered || task.actions.some(pending))
          throw new Error('验收证据不完整，不能标记完成。请核对未确认的动作及每项要求。')
        task.state = 'completed'
        this.invalidate(task)
      } else if (output.action === 'ask_user') {
        task.state = 'needs_user'
        task.pauseReason = output.message ?? output.reason
      } else if (['continue', 'reply'].includes(output.action)) {
        if (task.events.at(-1)?.questionKind === 'approval')
          throw new Error(
            '这是原 Agent 的权限审批，不能通过业务回复代替批准。请在原会话处理后恢复。',
          )
        if (!output.message?.trim() || !output.expectedChange?.trim())
          throw new Error('推进决定必须包含具体缺口、消息和预期变化')
        if (task.actions.some(pending))
          throw new Error('上一动作结果尚未核对；不能重复发送或切换通道补发')
        if (
          task.actions
            .slice(-3)
            .some(
              (action) =>
                action.message === output.message &&
                action.status !== 'failed' &&
                action.status !== 'cancelled',
            )
        )
          throw new Error('重复推进未提供新的变化；请诊断阻塞或补充要求')
        const live = this.live(task)
        if (live.revision !== revision || live.turnId !== task.session.turnId)
          throw new Error('会话状态已更新；等待最新事件')
        const channel = this.options.channel(copy(task))
        const action: AutoAgentAction = {
          id: randomUUID(),
          decisionId: decision.id,
          taskVersion: version,
          eventRevision: revision,
          channel,
          status: channel === 'native' ? 'prepared' : 'dispatching',
          message: output.message,
          expectedChange: output.expectedChange,
          createdAt: decision.createdAt,
          updatedAt: decision.createdAt,
          requirementsHash: requirementsHash(task),
        }
        task.actions.push(action)
        task.state = 'waiting_receipt'
        this.persist()
        try {
          const result = await this.options.dispatch(copy(task), copy(action), controller.signal)
          if (
            action.status !== 'confirmed' &&
            action.status !== 'cancelled' &&
            action.status !== 'failed' &&
            !(
              action.status === 'unknown' &&
              ['accepted', 'prepared', 'dispatching'].includes(result.status)
            ) &&
            !(result.status === 'prepared' && action.status !== 'prepared')
          ) {
            action.status = result.status
            action.receipt = result.receipt
          }
        } catch (error) {
          if (!['confirmed', 'cancelled', 'failed', 'unknown'].includes(action.status)) {
            action.status = (error as { notSent?: boolean }).notSent ? 'failed' : 'unknown'
            action.error = error instanceof Error ? error.message : '发送结果未知'
            action.receipt = executionReceipt(error) ?? action.receipt
          }
        }
        action.updatedAt = new Date().toISOString()
        this.applyReceiptState(task, action)
      }
      this.persist()
    } catch (error) {
      if (current()) {
        task.state = 'needs_user'
        task.error = error instanceof Error ? error.message : 'AUTO_AGENT_DECISION_FAILED'
        this.persist()
      }
    } finally {
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id)
      if (task.state === 'deciding' && task.version === version) {
        task.state = 'watching'
        this.persist()
      }
    }
  }
  async feedback(input: unknown) {
    const value = autoAgentFeedbackSchema.parse(input),
      task = this.task(value.taskId)
    if (task.state !== 'completed') throw new Error('任务结束后可提交评价')
    if (value.decisionId && !task.decisions.some((row) => row.id === value.decisionId))
      throw new Error('评价关联决定不存在')
    const supersedes = [...task.feedback]
      .reverse()
      .find((item) => item.scope === value.scope && item.decisionId === value.decisionId)?.id
    const feedback: AutoAgentFeedback = {
      ...value,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      supersedes,
      attribution: value.scope === 'task' ? 'stored' : 'pending',
    }
    task.feedback.push(feedback)
    this.persist()
    // Delivery never depends on feedback or its semantic processing.
    void this.retryFeedback()
  }
  retryFeedback(): Promise<void> {
    if (this.disposed || this.error || (!this.options.feedback && !this.options.onUserChoice))
      return Promise.resolve()
    if (this.feedbackFlush) {
      this.feedbackFlushRequested = true
      return this.feedbackFlush
    }
    if (this.feedbackRetry) {
      clearTimeout(this.feedbackRetry)
      this.feedbackRetry = undefined
    }
    const flush = async () => {
      let failed = false
      for (const task of this.tasks) {
        for (const feedback of task.feedback ?? []) {
          if (this.disposed || this.error) return
          if (
            !this.options.feedback ||
            feedback.scope !== 'future' ||
            !['pending', 'failed'].includes(feedback.attribution)
          )
            continue
          feedback.attribution = 'pending'
          this.persist()
          try {
            await this.options.feedback!(copy(task), copy(feedback))
            if (this.disposed) return
            feedback.attribution = 'stored'
          } catch {
            if (this.disposed) return
            feedback.attribution = 'failed'
            failed = true
          }
          this.persist()
        }
        for (const event of task.events) {
          if (this.disposed || this.error) return
          const memory = event.choiceMemory
          if (
            !this.options.onUserChoice ||
            !memory ||
            !['pending', 'failed'].includes(memory.attribution)
          )
            continue
          memory.attribution = 'pending'
          this.persist()
          try {
            // A reconnect can change the live session. Attribute the source to
            // the original event identity and workspace that we journaled.
            const source = copy(task)
            source.session.id = event.sessionId
            source.session.instanceId = event.instanceId
            source.session.workspace = memory.workspace
            const result = await this.options.onUserChoice(source, copy(event))
            if (this.disposed) return
            memory.attribution = result === 'ignored' ? 'ignored' : 'stored'
          } catch {
            if (this.disposed) return
            memory.attribution = 'failed'
            failed = true
          }
          this.persist()
        }
      }
      if (!this.disposed && !this.error && failed) {
        this.feedbackRetry = setTimeout(() => {
          this.feedbackRetry = undefined
          void this.retryFeedback()
        }, this.feedbackRetryDelay)
        this.feedbackRetry.unref?.()
        this.feedbackRetryDelay = Math.min(60000, this.feedbackRetryDelay * 2)
      } else this.feedbackRetryDelay = 1000
    }
    this.feedbackFlush = Promise.resolve()
      .then(flush)
      .catch(() => {})
      .finally(() => {
        this.feedbackFlush = undefined
        if (this.feedbackFlushRequested) {
          this.feedbackFlushRequested = false
          const pending = this.tasks.some(
            (task) =>
              (this.options.feedback &&
                (task.feedback ?? []).some(
                  (feedback) => feedback.scope === 'future' && feedback.attribution === 'pending',
                )) ||
              (this.options.onUserChoice &&
                task.events.some((event) => event.choiceMemory?.attribution === 'pending')),
          )
          if (pending) void this.retryFeedback()
        }
      })
    return this.feedbackFlush
  }
  pauseAll(reason: string) {
    for (const task of this.tasks.filter(isActive)) {
      this.invalidate(task)
      task.version++
      task.state = 'paused'
      task.pauseReason = reason
    }
    this.persist()
  }
  dispose() {
    if (this.disposed) return
    try {
      this.pauseAll('应用退出；恢复前核对会话')
    } catch {
      /* A failed journal remains failed; cancellation still must drain. */
    } finally {
      this.disposed = true
      for (const controller of this.controllers.values()) controller.abort()
      if (this.feedbackRetry) clearTimeout(this.feedbackRetry)
    }
  }
}
