import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { DesktopPipe } from '../infrastructure/desktop-pipe'
import type { ProactiveState } from '../../shared/proactive'
export type { ProactiveState } from '../../shared/proactive'

export interface ProactiveObservation {
  observation_id: string
  window_id: string | number
  ocr_text: string
  [key: string]: unknown
}
interface Options {
  script: string
  openRuntime(source: string): Promise<Readable & Writable & { close(): void }>
  available(): boolean
  assertStart(): void
  observe(): Promise<ProactiveObservation>
  cloud(system: string, content: string, signal: AbortSignal): Promise<string>
  input(
    op: string,
    observation: ProactiveObservation,
    value: Record<string, unknown>,
  ): Promise<unknown>
  clipboard(op: string, value: Record<string, unknown>): Promise<unknown>
  executeScript?: (taskId: string, input: unknown, signal: AbortSignal) => Promise<unknown>
  releaseClipboard(taskId: string): Promise<void>
  prepareInput(): Promise<void>
  onChange(): void
}

/** Host transport only: the task loop, local memory review and USB sender stay on RK; cloud understands OCR. */
export class ProactiveAgentService {
  private pipe?: DesktopPipe
  private opening?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private abort = new AbortController()
  private passiveAbort = new AbortController()
  private observations = new Map<string, ProactiveObservation>()
  private latestPassiveId?: string
  private current: ProactiveState = { connected: false, active: false, phase: 'idle' }
  private disposed = false
  private stopped = false
  constructor(private readonly options: Options) {}

  snapshot(): ProactiveState {
    return { ...this.current }
  }
  get active() {
    return this.current.active
  }
  private changed(patch: Partial<ProactiveState>) {
    this.current = { ...this.current, ...patch }
    this.options.onChange()
  }
  async connect() {
    if (this.disposed) throw new Error('PROACTIVE_DISPOSED')
    if (this.pipe) return
    if (!this.options.available()) throw new Error('RK_NOT_READY')
    if (this.opening) return this.opening
    this.opening = (async () => {
      const source = await readFile(this.options.script, 'utf8')
      const channel = await this.options.openRuntime(source)
      if (this.disposed) {
        channel.close()
        return
      }
      const pipe = new DesktopPipe(channel, channel, () => channel.close())
      this.pipe = pipe
      pipe.on('packet', (packet) => {
        void this.packet(packet).catch(() => this.changed({ error: 'RK_EVENT_INVALID' }))
      })
      pipe.on('closed', () => {
        if (this.pipe !== pipe) return
        this.pipe = undefined
        clearInterval(this.heartbeat)
        this.abort.abort()
        this.passiveAbort.abort()
        if (this.current.taskId)
          void this.options.releaseClipboard(this.current.taskId).catch(() => {})
        this.changed({
          connected: false,
          active: false,
          phase: this.current.active ? 'input_unknown' : 'offline',
          error: 'RK_CONNECTION_CLOSED',
        })
      })
      this.heartbeat = setInterval(() => {
        try {
          pipe.send({ type: 'heartbeat' })
        } catch {
          pipe.close()
        }
      }, 1000)
      this.heartbeat.unref()
      await pipe.ready
      if (!this.current.active) {
        this.abort = new AbortController()
        this.passiveAbort = new AbortController()
      }
      this.changed({ connected: true, error: undefined })
    })().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }
  private remember(view: ProactiveObservation) {
    this.observations.set(view.observation_id, view)
    if (this.observations.size > 8) this.observations.delete(this.observations.keys().next().value!)
    return view
  }
  async submitObservation(view: ProactiveObservation) {
    if (
      this.current.active ||
      this.current.phase === 'input_unknown' ||
      this.disposed ||
      !this.options.available()
    )
      return
    await this.connect()
    if (this.current.active || this.disposed) return
    if (this.current.suggestion && this.current.suggestion.observation_id !== view.observation_id)
      this.changed({ suggestion: undefined, phase: 'idle' })
    this.latestPassiveId = view.observation_id
    this.pipe!.send({ type: 'observe', value: this.remember(view) })
  }
  async startTask(goal: string, taskId: string = randomUUID()) {
    this.options.assertStart()
    if (!goal.trim() || Buffer.byteLength(goal) > 16000) throw new Error('INVALID_TASK_GOAL')
    if (this.active) throw new Error('TASK_BUSY')
    this.stopped = false
    this.passiveAbort.abort()
    this.passiveAbort = new AbortController()
    this.abort = new AbortController()
    this.changed({
      active: true,
      taskId,
      phase: 'queued',
      suggestion: undefined,
      question: undefined,
      error: undefined,
      summary: undefined,
      memorySaved: undefined,
    })
    try {
      await this.connect()
      if (this.stopped || this.disposed) throw new Error('TASK_STOPPED')
      this.options.assertStart()
      this.pipe!.send({ type: 'task.start', value: { task_id: taskId, goal: goal.trim() } })
    } catch (error) {
      this.changed({
        active: false,
        phase: this.stopped ? 'cancelled' : 'failed',
        error: this.stopped ? 'TASK_STOPPED' : 'TASK_START_FAILED',
      })
      throw error
    }
    return taskId
  }
  async acceptSuggestion(id: string) {
    this.options.assertStart()
    if (this.active || this.current.suggestion?.suggestion_id !== id)
      throw new Error('STALE_SUGGESTION')
    this.stopped = false
    this.passiveAbort.abort()
    this.passiveAbort = new AbortController()
    this.abort = new AbortController()
    const taskId = randomUUID()
    this.changed({
      active: true,
      taskId,
      phase: 'queued',
      suggestion: undefined,
      question: undefined,
      error: undefined,
      summary: undefined,
      memorySaved: undefined,
    })
    try {
      await this.connect()
      if (this.stopped || this.disposed) throw new Error('TASK_STOPPED')
      this.options.assertStart()
      this.pipe!.send({ type: 'suggestion.accept', value: { suggestion_id: id, task_id: taskId } })
    } catch (error) {
      this.changed({
        active: false,
        phase: this.stopped ? 'cancelled' : 'failed',
        error: this.stopped ? 'TASK_STOPPED' : 'TASK_START_FAILED',
      })
      throw error
    }
  }
  dismissSuggestion(id: string) {
    if (this.current.suggestion?.suggestion_id !== id) throw new Error('STALE_SUGGESTION')
    this.pipe?.send({ type: 'suggestion.ignore', value: { suggestion_id: id } })
    this.changed({ suggestion: undefined, phase: 'idle' })
  }
  answer(taskId: string, questionId: string, answer: string) {
    if (
      !this.active ||
      this.current.taskId !== taskId ||
      this.current.question?.question_id !== questionId ||
      !answer.trim() ||
      answer.length > 4000
    )
      throw new Error('STALE_OR_INVALID_ANSWER')
    this.pipe!.send({
      type: 'task.answer',
      value: { task_id: taskId, question_id: questionId, answer },
    })
    this.changed({ question: undefined, phase: 'planning' })
  }
  async stop() {
    if (!this.active) return
    this.stopped = true
    this.abort.abort()
    this.changed({ phase: 'stopping' })
    this.pipe?.send({ type: 'task.stop', value: { task_id: this.current.taskId } })
  }
  acknowledgeStopped() {
    if (this.active || this.current.phase !== 'input_unknown') return
    this.changed({
      phase: 'blocked',
      summary: 'Previous input result was not verified. No automatic retry was made.',
    })
  }
  private async packet(packet: {
    type: string
    id?: string
    op?: string
    value?: Record<string, unknown>
  }) {
    const value = packet.value ?? {}
    if (packet.type !== 'suggestion')
      console.info(
        '[rk-loop]',
        JSON.stringify({
          type: packet.type,
          op: packet.op,
          phase: value.phase,
          code: value.code,
          reason: value.reason,
          stage: value.stage,
        }),
      )
    if (packet.type === 'request') {
      const pipe = this.pipe
      try {
        const result = await this.tool(packet.op!, value)
        pipe?.send({ type: 'reply', id: packet.id, value: result })
      } catch (error) {
        // Fixed diagnostic only; provider errors and clipboard contents stay private.
        const code =
          error instanceof Error &&
          /^(CLIPBOARD|DESKTOP|INPUT|TASK|OBSERVATION|RK|RELAY|SCRIPT)_[A-Z_]{1,80}$/.test(error.message)
            ? error.message
            : 'HOST_TOOL_FAILED'
        console.info(
          '[rk-tool-error]',
          JSON.stringify({
            op: packet.op,
            code,
            error: error instanceof Error ? error.message : 'unknown',
          }),
        )
        pipe?.send({
          type: 'reply',
          id: packet.id,
          error: this.stopped ? 'TASK_STOPPED' : code,
        })
      }
    } else if (packet.type === 'suggestion') {
      if (!this.active && value.observation_id === this.latestPassiveId)
        this.changed({ suggestion: value, phase: 'suggestion', error: undefined })
    } else if (packet.type === 'question') {
      if (value.task_id === this.current.taskId)
        this.changed({ question: value, phase: 'waiting_user' })
    } else if (packet.type === 'task.state') {
      if (value.task_id === this.current.taskId) this.changed({ phase: String(value.phase) })
    } else if (packet.type === 'task.result') {
      if (value.task_id !== this.current.taskId) return
      this.changed({
        active: false,
        question: undefined,
        phase: String(value.phase),
        summary: String(value.summary ?? value.reason ?? ''),
        error: value.phase === 'completed' ? undefined : String(value.reason ?? value.phase),
      })
      await this.options.releaseClipboard(String(value.task_id))
    } else if (packet.type === 'memory.saved') {
      if (value.task_id === this.current.taskId) this.changed({ memorySaved: value.saved === true })
    } else if (packet.type === 'agent.error') {
      this.changed({ error: String(value.code ?? 'RK_AGENT_ERROR') })
    }
  }
  private async tool(op: string, value: Record<string, unknown>) {
    if (op === 'cloud_transport') {
      if (typeof value.system !== 'string' || typeof value.content !== 'string')
        throw new Error('INVALID_CLOUD_REQUEST')
      let passive = false
      try {
        passive = JSON.parse(value.content).mode === 'suggest'
      } catch {
        throw new Error('INVALID_CLOUD_CONTEXT')
      }
      if (passive && this.active) throw new Error('PASSIVE_SUPERSEDED')
      return this.options.cloud(
        value.system,
        value.content,
        passive ? this.passiveAbort.signal : this.abort.signal,
      )
    }
    if (!this.active || value.task_id !== this.current.taskId) throw new Error('TASK_MISMATCH')
    if (this.stopped && op !== 'clipboard.finish') throw new Error('TASK_STOPPED')
    if (op === 'script.execute') {
      if (!this.options.executeScript) throw new Error('SCRIPT_EXECUTOR_UNAVAILABLE')
      return this.options.executeScript(this.current.taskId!, value.script, this.abort.signal)
    }
    if (op === 'observe.request') {
      try {
        return this.remember(await this.options.observe())
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'OBSERVATION_RETRY' ||
          !this.options.executeScript
        )
          throw error
        return this.remember({
          observation_id: randomUUID(),
          window_id: '0',
          process_id: 0,
          window_rect: [0, 0, 0, 0],
          ocr_text: '',
          ocr_items: [],
          targets: [],
          editable_focus: false,
          observation_error: 'screen_unavailable',
          available_tools: ['script', 'ask_user'],
        })
      }
    }
    if (
      op === 'input.validate' ||
      op === 'input.guard' ||
      op === 'clipboard.verify' ||
      op === 'completion.verify' ||
      op === 'clipboard.prepare' ||
      op === 'clipboard.guard'
    ) {
      const view = this.observations.get(String(value.observation_id))
      if (!view || view.window_id === '0') throw new Error('OBSERVATION_EXPIRED')
      if (op === 'input.validate') await this.options.prepareInput()
      if (this.stopped || !this.active || value.task_id !== this.current.taskId)
        throw new Error('TASK_STOPPED')
      if (
        op === 'input.validate' ||
        op === 'input.guard' ||
        op === 'clipboard.verify' ||
        op === 'completion.verify'
      ) {
        const result = await this.options.input(op, view, value)
        if (op === 'input.guard' && typeof value.lease_id === 'string') {
          const clipboard = (await this.options.clipboard('clipboard.guard', value)) as {
            allowed?: boolean
          }
          if (clipboard?.allowed !== true) throw new Error('CLIPBOARD_LEASE_CHANGED')
        }
        if (this.stopped || !this.active || value.task_id !== this.current.taskId)
          throw new Error('TASK_STOPPED')
        return result
      }
      const guarded = (await this.options.input('input.guard', view, value)) as {
        allowed?: boolean
      }
      if (guarded?.allowed !== true) throw new Error('INPUT_GUARD_CHANGED')
      if (this.stopped || !this.active || value.task_id !== this.current.taskId)
        throw new Error('TASK_STOPPED')
      return this.options.clipboard(op, value)
    }
    if (op === 'clipboard.finish') return this.options.clipboard(op, value)
    throw new Error('HOST_TOOL_UNSUPPORTED')
  }
  async dispose() {
    this.disposed = true
    this.passiveAbort.abort()
    await this.stop().catch(() => {})
    clearInterval(this.heartbeat)
    if (this.current.taskId) await this.options.releaseClipboard(this.current.taskId)
    this.pipe?.close()
  }
}
