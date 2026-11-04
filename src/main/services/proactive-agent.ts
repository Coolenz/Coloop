import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { DesktopPipe } from '../infrastructure/desktop-pipe'
import type { ProactiveState } from '../../shared/proactive'
import {
  parseSuggestion,
  suggestionContent,
  suggestionSystem,
} from '../domain/proactive-suggestion'
import { parseStrictJson } from '../domain/strict-json'
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
  onObservationRetry?: (observationId: string) => void
}

/** The host asks the cloud for passive suggestions; RK owns accepted task execution. */
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
    if (this.opening) return this.opening
    if (this.pipe) return
    if (!this.options.available()) throw new Error('RK_NOT_READY')
    this.opening = (async () => {
      const source = await readFile(this.options.script, 'utf8')
      const channel = await this.options.openRuntime(source)
      if (this.disposed) {
        channel.close()
        throw new Error('PROACTIVE_DISPOSED')
      }
      const pipe = new DesktopPipe(channel, channel, () => channel.close())
      this.pipe = pipe
      pipe.on('packet', (packet) => {
        void this.packet(pipe, packet).catch(() => {
          if (this.pipe === pipe && !this.disposed) this.changed({ error: 'RK_EVENT_INVALID' })
        })
      })
      pipe.on('closed', () => {
        if (this.pipe !== pipe) return
        this.pipe = undefined
        clearInterval(this.heartbeat)
        this.abort.abort()
        this.cancelObservation()
        this.observations.clear()
        if (this.current.taskId)
          void this.options.releaseClipboard(this.current.taskId).catch(() => {})
        this.changed({
          connected: false,
          active: false,
          question: undefined,
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
      if (this.pipe !== pipe || this.disposed) throw new Error('RK_CONNECTION_CLOSED')
      if (!this.current.active) {
        this.abort = new AbortController()
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
    if (this.current.active || this.current.phase === 'input_unknown' || this.disposed) return
    if (!this.options.available()) {
      this.options.onObservationRetry?.(view.observation_id)
      return
    }
    this.cancelObservation()
    this.latestPassiveId = view.observation_id
    this.remember(view)
    const signal = this.passiveAbort.signal
    void this.recommend(view, signal)
  }
  cancelObservation() {
    this.passiveAbort.abort()
    this.passiveAbort = new AbortController()
    this.latestPassiveId = undefined
    if (this.current.suggestion) this.changed({ suggestion: undefined, phase: 'idle' })
  }
  private async recommend(view: ProactiveObservation, signal: AbortSignal) {
    const current = () =>
      !signal.aborted &&
      !this.disposed &&
      !this.active &&
      this.current.phase !== 'input_unknown' &&
      this.latestPassiveId === view.observation_id
    try {
      const content = suggestionContent(view)
      for (let attempt = 0; attempt < 2; attempt++) {
        const system =
          suggestionSystem +
          (attempt ? '\nReturn exactly one valid JSON object using the specified fields.' : '')
        const raw = await this.options.cloud(system, content, signal)
        if (!current()) return
        if (!this.options.available()) {
          this.options.onObservationRetry?.(view.observation_id)
          return
        }
        let response: ReturnType<typeof parseSuggestion>
        try {
          response = parseSuggestion(raw)
        } catch (error) {
          if (!attempt) continue
          throw error
        }
        if (response.type === 'defer') this.options.onObservationRetry?.(view.observation_id)
        if (response.type === 'suggestion') {
          this.changed({
            suggestion: {
              ...response,
              suggestion_id: randomUUID(),
              observation_id: view.observation_id,
            },
            phase: 'suggestion',
            error: undefined,
          })
        }
        return
      }
    } catch {
      if (current()) {
        this.changed({ error: 'PROACTIVE_RECOMMENDATION_FAILED' })
        this.options.onObservationRetry?.(view.observation_id)
      }
    }
  }
  async startTask(goal: string, taskId: string = randomUUID()) {
    this.options.assertStart()
    if (!goal.trim() || Buffer.byteLength(goal) > 16000) throw new Error('INVALID_TASK_GOAL')
    if (this.active) throw new Error('TASK_BUSY')
    if (this.current.phase === 'input_unknown') throw new Error('INPUT_OUTCOME_UNKNOWN')
    this.stopped = false
    this.cancelObservation()
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
    const proposal = this.current.suggestion
    if (
      this.active ||
      proposal?.suggestion_id !== id ||
      proposal.observation_id !== this.latestPassiveId
    )
      throw new Error('STALE_SUGGESTION')
    await this.startTask(`${String(proposal.goal)}\n\n已接纳的页面建议：\n${String(proposal.text)}`)
  }
  dismissSuggestion(id: string) {
    if (this.current.suggestion?.suggestion_id !== id) throw new Error('STALE_SUGGESTION')
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
  private async packet(
    pipe: DesktopPipe,
    packet: {
      type: string
      id?: string
      op?: string
      value?: Record<string, unknown>
    },
  ) {
    if (this.pipe !== pipe || this.disposed) return
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
      try {
        const result = await this.tool(pipe, packet.op!, value)
        if (this.pipe === pipe && !this.disposed)
          pipe.send({ type: 'reply', id: packet.id, value: result })
      } catch (error) {
        // Fixed diagnostic only; provider errors and clipboard contents stay private.
        const code =
          error instanceof Error &&
          /^(CLIPBOARD|DESKTOP|INPUT|TASK|OBSERVATION|RK|RELAY|SCRIPT)_[A-Z_]{1,80}$/.test(
            error.message,
          )
            ? error.message
            : 'HOST_TOOL_FAILED'
        console.info(
          '[rk-tool-error]',
          JSON.stringify({
            op: packet.op,
            code,
          }),
        )
        if (this.pipe !== pipe || this.disposed) return
        pipe.send({
          type: 'reply',
          id: packet.id,
          error: this.stopped ? 'TASK_STOPPED' : code,
        })
      }
    } else if (packet.type === 'question') {
      if (this.active && !this.stopped && value.task_id === this.current.taskId)
        this.changed({ question: value, phase: 'waiting_user' })
    } else if (packet.type === 'task.state') {
      if (this.active && !this.stopped && value.task_id === this.current.taskId)
        this.changed({ phase: String(value.phase) })
    } else if (packet.type === 'task.result') {
      if (!this.active || value.task_id !== this.current.taskId) return
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
  private async tool(pipe: DesktopPipe, op: string, value: Record<string, unknown>) {
    if (op === 'cloud_transport') {
      if (typeof value.system !== 'string' || typeof value.content !== 'string')
        throw new Error('INVALID_CLOUD_REQUEST')
      let context: Record<string, unknown>
      try {
        let parsed = parseStrictJson(value.content)
        for (let depth = 0; depth < 4; depth++) {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('INVALID_CLOUD_CONTEXT')
          const row = parsed as Record<string, unknown>
          if (!row.original_request) break
          parsed = row.original_request
        }
        context = parsed as Record<string, unknown>
      } catch {
        throw new Error('INVALID_CLOUD_CONTEXT')
      }
      const mode = value.mode ?? context.mode ?? 'task'
      if (mode !== 'task' && mode !== 'suggest') throw new Error('INVALID_CLOUD_CONTEXT')
      const passive = mode === 'suggest'
      const taskId =
        value.task_id ?? context.task_id ?? (value.mode ? undefined : this.current.taskId)
      const observationId = value.observation_id ?? context.observation_id
      const signal = passive ? this.passiveAbort.signal : this.abort.signal
      const assertCurrent = () => {
        if (this.pipe !== pipe || this.disposed) throw new Error('RK_CONNECTION_CLOSED')
        if (passive) {
          if (
            signal.aborted ||
            this.active ||
            !this.latestPassiveId ||
            observationId !== this.latestPassiveId
          )
            throw new Error('OBSERVATION_EXPIRED')
        } else {
          if (!this.active || taskId !== this.current.taskId) throw new Error('TASK_MISMATCH')
          if (signal.aborted || this.stopped) throw new Error('TASK_STOPPED')
        }
      }
      assertCurrent()
      const result = await this.options.cloud(value.system, value.content, signal)
      assertCurrent()
      return result
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
      if (
        this.pipe !== pipe ||
        this.stopped ||
        !this.active ||
        value.task_id !== this.current.taskId
      )
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
        if (
          this.pipe !== pipe ||
          this.stopped ||
          !this.active ||
          value.task_id !== this.current.taskId
        )
          throw new Error('TASK_STOPPED')
        return result
      }
      const guarded = (await this.options.input('input.guard', view, value)) as {
        allowed?: boolean
      }
      if (guarded?.allowed !== true) throw new Error('INPUT_GUARD_CHANGED')
      if (
        this.pipe !== pipe ||
        this.stopped ||
        !this.active ||
        value.task_id !== this.current.taskId
      )
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
