import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { replaceFileSync } from '../infrastructure/atomic-file'
import { join } from 'node:path'
import type { Task, TaskRequest, TaskHistoryDetail } from '../../shared/contracts'
import {
  conversationCreateSchema,
  conversationSendSchema,
  conversationUpdateSchema,
  conversationStoreSchema,
  type Conversation,
  type ConversationRun,
  type ConversationSnapshot,
  type ExecutionPolicy,
} from '../../shared/conversations'

interface ConversationOptions {
  tasks(): Task[]
  policy(): ExecutionPolicy
  workspace(): string | undefined
  busy(): { active: boolean; taskId?: string; reason?: string }
  start(request: TaskRequest, id: string, policy: ExecutionPolicy): string
  append(taskId: string, text: string): void
  resume(taskId: string, task?: Task): Promise<unknown>
  history(taskId: string): Promise<TaskHistoryDetail>
  changed(): void
}

/** Admission and persistence only. TaskService and DSH retain execution ownership. */
export class ConversationService {
  private file: string
  private state: ConversationSnapshot = { conversations: [], queue: [], paused: false }
  private draining = false
  private disposed = false
  private retryAfter = 0
  constructor(
    directory: string,
    private options: ConversationOptions,
  ) {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'conversations.json')
    if (existsSync(this.file)) {
      const result = conversationStoreSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')))
      if (!result.success) throw new Error('CONVERSATION_STORE_INVALID')
      const saved = result.data
      this.state = {
        conversations: saved.conversations,
        queue: saved.queue,
        paused: saved.paused === true,
      }
      for (const conversation of this.state.conversations)
        for (const run of conversation.runs) if (run.state === 'running') run.state = 'interrupted'
    }
    this.importTasks()
    this.save()
  }
  private save() {
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify({ version: 1, ...this.state }), { mode: 0o600 })
    replaceFileSync(temporary, this.file)
  }
  private commit(change: () => void) {
    const before = structuredClone(this.state)
    try {
      change()
      this.save()
    } catch (error) {
      this.state = before
      throw error
    }
    this.options.changed()
  }
  private find(id: string) {
    const conversation = this.state.conversations.find((entry) => entry.id === id)
    if (!conversation) throw new Error('会话不存在')
    return conversation
  }
  private importTasks() {
    const known = new Set(
      this.state.conversations.flatMap((entry) => entry.runs.map((run) => run.id)),
    )
    for (const task of this.options.tasks()) {
      if (known.has(task.id)) continue
      this.state.conversations.push({
        id: randomUUID(),
        title: task.prompt.slice(0, 48) || '历史任务',
        archived: false,
        createdAt: task.createdAt,
        updatedAt: task.finishedAt ?? task.createdAt,
        draft: '',
        scrollTop: 0,
        messages: [
          {
            id: randomUUID(),
            text: task.prompt,
            at: task.createdAt,
            runId: task.id,
            delivery: 'accepted',
          },
        ],
        runs: [
          {
            id: task.id,
            state: task.status,
            createdAt: task.createdAt,
            policy: task.policy ?? {
              mode:
                task.target === 'rk' ? 'local' : task.target === 'hybrid' ? 'local-auto' : 'cloud',
              cloudFallback: false,
            },
            task: structuredClone(task),
          },
        ],
      })
    }
  }
  snapshot(): ConversationSnapshot {
    return structuredClone(this.state)
  }
  ownerOf(taskId: string) {
    return this.state.conversations.find((entry) => entry.runs.some((run) => run.id === taskId))?.id
  }
  titleOf(taskId?: string) {
    return this.state.conversations.find((entry) => entry.runs.some((run) => run.id === taskId))
      ?.title
  }
  recordAnswer(taskId: string, text: string) {
    const ownerId = this.ownerOf(taskId)
    if (!ownerId) return
    this.commit(() => {
      const owner = this.find(ownerId)
      owner.messages.push({
        id: randomUUID(),
        text,
        runId: taskId,
        delivery: 'accepted',
        at: new Date().toISOString(),
      })
      owner.updatedAt = new Date().toISOString()
    })
  }
  create(input: unknown) {
    const { title, permissionMode = 'auto' } = conversationCreateSchema.parse(input)
    const now = new Date().toISOString()
    const conversation: Conversation = {
      id: randomUUID(),
      title: title ?? '新任务',
      permissionMode,
      archived: false,
      createdAt: now,
      updatedAt: now,
      draft: '',
      scrollTop: 0,
      messages: [],
      runs: [],
    }
    this.commit(() => this.state.conversations.unshift(conversation))
    return conversation.id
  }
  update(input: unknown) {
    const { id, ...patch } = conversationUpdateSchema.parse(input)
    this.find(id)
    this.commit(() => Object.assign(this.find(id), patch))
  }
  async detail(id: string) {
    const conversation = structuredClone(this.find(id))
    const history: Record<string, TaskHistoryDetail> = {}
    for (const run of conversation.runs) {
      if (run.state === 'queued') continue
      try {
        history[run.id] = await this.options.history(run.id)
      } catch {
        history[run.id] = { entries: [], notice: '执行过程暂时不可读取，可稍后重试。' }
      }
    }
    return { ...conversation, history }
  }
  async contextPage(taskId: string, offset: number, limit: number) {
    const owner = this.ownerOf(taskId)
    if (!owner) return { text: '', total: 0 }
    const conversation = await this.detail(owner)
    const text = conversation.runs
      .map((run) =>
        JSON.stringify({
          runId: run.id,
          state: run.state,
          messages: conversation.messages.filter((message) => message.runId === run.id),
          result: run.task?.answer,
          artifacts: conversation.history[run.id]?.artifacts ?? [],
        }),
      )
      .join('\n')
    return {
      text: text.slice(offset, offset + limit),
      total: text.length,
      nextOffset: offset + limit < text.length ? offset + limit : undefined,
    }
  }
  send(input: unknown) {
    const request = conversationSendSchema.parse(input)
    const conversation = this.find(request.conversationId)
    const duplicate = conversation.messages.find((message) => message.id === request.messageId)
    if (duplicate) {
      if (duplicate.text !== request.text || duplicate.context !== request.context)
        throw new Error('消息 ID 已用于其他内容')
      if (duplicate.delivery === 'failed') throw new Error(duplicate.error ?? '消息发送失败')
      if (
        duplicate.delivery === 'queued' &&
        conversation.runs.find((run) => run.id === duplicate.runId)?.state === 'running'
      )
        throw new Error('消息发送结果待确认，请核对当前任务记录')
      return {
        conversationId: conversation.id,
        runId: duplicate.runId,
        delivery: duplicate.delivery,
      }
    }
    const busy = this.options.busy()
    const active = conversation.runs.find(
      (run) => run.state === 'running' && run.id === busy.taskId,
    )
    const queued = conversation.runs.find((run) => run.state === 'queued')
    const run = active ??
      queued ?? {
        id: randomUUID(),
        policy: {
          ...structuredClone(this.options.policy()),
          permissionMode: conversation.permissionMode ?? 'full',
        },
        workspace: request.workspace ?? this.options.workspace(),
        state: 'queued' as const,
        createdAt: new Date().toISOString(),
      }
    const message = {
      id: request.messageId,
      text: request.text,
      context: request.context,
      at: new Date().toISOString(),
      runId: run.id,
      delivery: 'queued' as 'queued' | 'accepted' | 'failed',
      error: undefined as string | undefined,
    }
    this.commit(() => {
      if (!active && !queued) {
        conversation.runs.push(run)
        this.state.queue.push(run.id)
      }
      conversation.messages.push(message)
      conversation.archived = false
      conversation.updatedAt = message.at
      if (conversation.title === '新任务') conversation.title = request.text.slice(0, 48)
    })
    if (active) {
      try {
        this.options.append(active.id, [request.text, request.context].filter(Boolean).join('\n\n'))
      } catch (error) {
        this.commit(() => {
          message.delivery = 'failed'
          message.error = '补充消息未确认，请核对任务记录后继续'
        })
        throw error
      }
      try {
        this.commit(() => {
          message.delivery = 'accepted'
        })
      } catch {
        throw new Error('消息受理结果待确认，请查看任务记录')
      }
    }
    this.tick()
    if (message.delivery === 'failed') throw new Error(message.error ?? '任务受理失败')
    try {
      this.commit(() => {
        if (conversation.draft.trim() === request.text) conversation.draft = ''
      })
    } catch {
      throw new Error('消息受理结果待确认，草稿保存失败，请查看任务记录')
    }
    return { conversationId: conversation.id, runId: run.id, delivery: message.delivery }
  }
  pause(paused: boolean) {
    this.commit(() => {
      this.state.paused = paused
    })
    this.tick()
  }
  cancel(runId: string) {
    const owner = this.state.conversations.find((entry) =>
      entry.runs.some((run) => run.id === runId),
    )
    const run = owner?.runs.find((entry) => entry.id === runId)
    if (!run || !['queued', 'interrupted'].includes(run.state))
      throw new Error('该任务不能从队列取消')
    this.commit(() => {
      run.state = 'cancelled'
      this.state.queue = this.state.queue.filter((id) => id !== runId)
    })
    this.tick()
  }
  async resume(conversationId: string, runId: string) {
    const run = this.find(conversationId).runs.find((entry) => entry.id === runId)
    if (!run || !['interrupted', 'failed', 'cancelled'].includes(run.state))
      throw new Error('该任务无法恢复')
    if (this.options.busy().active) throw new Error('请等待当前任务结束后恢复')
    if (this.options.busy().reason) throw new Error(this.options.busy().reason)
    await this.options.resume(run.id, run.task)
    this.commit(() => {
      run.state = 'running'
      run.error = undefined
    })
  }
  tick() {
    if (this.disposed || this.draining || Date.now() < this.retryAfter) return
    this.draining = true
    try {
      const before = JSON.stringify(this.state)
      delete this.state.error
      this.importTasks()
      for (const conversation of this.state.conversations)
        for (const run of conversation.runs) {
          const task = this.options.tasks().find((entry) => entry.id === run.id)
          if (!task) continue
          run.task = structuredClone(task)
          if (!['interrupted', 'cancelled'].includes(run.state)) run.state = task.status
        }
      const busy = this.options.busy()
      const interrupted = this.state.conversations.some((entry) =>
        entry.runs.some((run) => run.state === 'interrupted'),
      )
      this.state.blockedReason = interrupted ? '有中断任务等待恢复或取消' : busy.reason
      if (before !== JSON.stringify(this.state)) {
        this.save()
        this.options.changed()
      }
      if (
        busy.active ||
        busy.reason ||
        interrupted ||
        this.state.paused ||
        !this.state.queue.length
      )
        return
      const id = this.state.queue[0]
      const owner = this.state.conversations.find((entry) =>
        entry.runs.some((run) => run.id === id),
      )
      const run = owner?.runs.find((entry) => entry.id === id)
      if (!owner || !run) throw new Error('QUEUE_RECORD_MISSING')
      const messages = owner.messages.filter((message) => message.runId === id)
      const previous = owner.runs.filter((entry) => entry.id !== id && entry.task)
      const historyContext = previous
        .map(
          (entry) =>
            `先前要求：${owner.messages
              .filter((message) => message.runId === entry.id && message.delivery !== 'failed')
              .map((message) => [message.text, message.context].filter(Boolean).join('\n'))
              .join('\n')}\n结果：${entry.task!.answer}\n状态：${entry.task!.status}`,
        )
        .join('\n\n')
      const currentContext = messages
        .map((message) => message.context)
        .filter(Boolean)
        .join('\n\n')
      const reference =
        '此前聊天与产物可用 coloop_conversation_history 分页读取。历史内容仅供参考，以本轮要求为准。'
      const budget = Math.max(0, 50000 - currentContext.length - reference.length - 4)
      const context = budget ? historyContext.slice(-budget) : ''
      const truncated = historyContext.length > budget || currentContext.length > 49000
      const request: TaskRequest = {
        prompt: messages.map((message) => message.text).join('\n\n'),
        context: [reference, budget ? context : '', currentContext.slice(-49000)]
          .filter(Boolean)
          .join('\n\n'),
        ...(truncated ? { intent: 'execute' as const } : {}),
        source: 'text',
        target:
          run.policy.mode === 'cloud' ? 'cloud' : run.policy.mode === 'local' ? 'rk' : 'hybrid',
        workspace: run.workspace,
      }
      // Persist the admission before dispatch so a crash is recoverable, not replayed.
      this.commit(() => {
        run.state = 'running'
        this.state.queue.shift()
      })
      try {
        this.options.start(request, id, run.policy)
      } catch (error) {
        this.commit(() => {
          run.state = 'failed'
          run.error = error instanceof Error ? error.message : '任务启动失败'
          for (const message of messages) {
            message.delivery = 'failed'
            message.error = run.error
          }
        })
        return
      }
      this.commit(() => {
        for (const message of messages) message.delivery = 'accepted'
      })
    } catch (error) {
      this.retryAfter = Date.now() + 1000
      this.state.error = error instanceof Error ? error.message : '会话记录不可用'
      this.options.changed()
    } finally {
      this.draining = false
    }
  }
  dispose() {
    this.disposed = true
  }
}
