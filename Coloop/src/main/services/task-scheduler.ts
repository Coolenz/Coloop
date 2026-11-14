import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { NativeScheduler, type NativeSchedulerPaths } from '../infrastructure/native-scheduler'
import {
  scheduleRequestSchema,
  type ScheduleRequest,
  type ScheduledTask,
  type Task,
  type TaskRequest,
} from '../../shared/contracts'

const savedSchema = scheduleRequestSchema.extend({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum([
    'pending',
    'waiting',
    'dispatching',
    'running',
    'completed',
    'failed',
    'cancelled',
    'unconfirmed',
  ]),
  error: z.string().optional(),
  nativeId: z.string().optional(),
  nativeDue: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
})
interface Options {
  runtime?: NativeSchedulerPaths
  directory: string
  available(request: TaskRequest): boolean
  findTask(id: string): Task | undefined
  dispatch(request: TaskRequest, taskId: string): string
  onChange(): void
  now?(): number
}

/** Durable one-shot admission. An uncertain previous admission is never automatically replayed. */
export class TaskScheduler {
  private entries: z.infer<typeof savedSchema>[] = []
  private native?: NativeScheduler
  private ready?: Promise<void>
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private retryCount = 0
  private nextRetryAt?: number
  private runtimeState: 'starting' | 'ready' | 'recovering' | 'error' | 'stopped' = 'stopped'
  private error?: string
  private loadError = false
  private timer?: ReturnType<typeof setInterval>
  private file: string
  private disposed = false
  constructor(private options: Options) {
    mkdirSync(options.directory, { recursive: true })
    this.file = join(options.directory, 'task-schedules.json')
    if (existsSync(this.file)) {
      try {
        this.entries = z
          .array(savedSchema)
          .max(1000)
          .parse(JSON.parse(readFileSync(this.file, 'utf8')))
      } catch {
        this.loadError = true
        this.error = 'SCHEDULE_STORE_UNREADABLE'
      }
    }
  }
  snapshot() {
    return {
      entries: structuredClone(this.entries),
      error: this.error,
      runtime: {
        state: this.runtimeState,
        retryCount: this.retryCount,
        nextRetryAt: this.nextRetryAt,
      },
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private commit(entries: ScheduledTask[]) {
    if (this.loadError) throw new Error('SCHEDULE_STORE_UNREADABLE')
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify(entries, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    })
    renameSync(temporary, this.file)
    this.entries = entries
    if (this.runtimeState === 'ready') this.error = undefined
    this.options.onChange()
  }
  private update(id: string, patch: Partial<z.infer<typeof savedSchema>>) {
    this.commit(this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  }
  private initialize() {
    if (this.disposed) return Promise.reject(new Error('SCHEDULER_DISPOSED'))
    if (this.recoveryTimer) return Promise.reject(new Error('NATIVE_SCHEDULER_RECOVERING'))
    return (this.ready ??= this.connect().catch((error) => {
      this.recover(error)
      throw error
    }))
  }
  private recover(error: Error) {
    if (this.disposed || this.recoveryTimer) return
    this.error = error.message
    this.runtimeState =
      /FILES_MISSING|START_FAILED|STORE_UNREADABLE|VERSION|corrupt|invalid.record|malformed/i.test(
        error.message,
      )
        ? 'error'
        : 'recovering'
    if (this.runtimeState === 'recovering') {
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5))
      this.nextRetryAt = Date.now() + delay
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined
        void this.replaceRuntime()
      }, delay)
    }
    this.options.onChange()
  }
  private async replaceRuntime() {
    await this.native?.dispose()
    if (this.disposed) return
    this.native = undefined
    this.ready = undefined
    void this.initialize().catch(() => {})
  }
  private async connect() {
    if (this.loadError) throw new Error('SCHEDULE_STORE_UNREADABLE')
    this.runtimeState = this.retryCount ? 'recovering' : 'starting'
    this.native = new NativeScheduler(
      this.options.directory,
      (id) => {
        const entry = this.entries.find((entry) => entry.id === id)
        if (!entry) throw new Error('SCHEDULE_NOT_FOUND')
        this.update(id, { nativeDue: true })
        this.tick()
      },
      (error) => this.recover(error),
      this.options.runtime,
    )
    await this.native.ready
    const catalog = await this.native.call('catalog')
    for (const entry of this.entries) {
      if (!['pending', 'waiting'].includes(entry.status)) continue
      const existing = catalog.find((item: any) => item.sessionId === entry.id)
      if (entry.cancelRequested) {
        if (existing)
          await this.native.call('delete', { request: { sessionId: entry.id, id: existing.id } })
        this.update(entry.id, {
          status: 'cancelled',
          finishedAt: new Date(this.now()).toISOString(),
        })
        continue
      }
      if (existing) {
        this.update(entry.id, {
          nativeId: existing.id,
          nativeDue: existing.status === 'inactive' || entry.nativeDue,
        })
      } else await this.register(entry)
    }
    this.runtimeState = 'ready'
    this.retryCount = 0
    this.nextRetryAt = undefined
    this.error = undefined
    this.options.onChange()
    this.tick()
  }
  private async register(entry: ScheduledTask) {
    const record = await this.native!.call('create', {
      sessionId: entry.id,
      request: {
        title: entry.request.prompt.trim().slice(0, 120),
        prompt: entry.request.prompt,
        ...(Date.parse(entry.runAt) > Date.now() ? { at: entry.runAt } : { after_seconds: 1 }),
      },
    })
    this.update(entry.id, { nativeId: record.id })
  }
  async create(input: ScheduleRequest) {
    if (this.disposed) throw new Error('SCHEDULER_DISPOSED')
    const request = scheduleRequestSchema.parse(input)
    new Intl.DateTimeFormat('en', { timeZone: request.timezone }).format(this.now())
    if (Date.parse(request.runAt) <= this.now()) throw new Error('SCHEDULE_TIME_MUST_BE_FUTURE')
    if (this.entries.length >= 1000) throw new Error('SCHEDULE_LIMIT_REACHED')
    await this.initialize()
    if (this.disposed) throw new Error('SCHEDULER_DISPOSED')
    if (this.entries.length >= 1000) throw new Error('SCHEDULE_LIMIT_REACHED')
    const entry: ScheduledTask = {
      ...request,
      id: randomUUID(),
      taskId: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      status: 'pending',
    }
    this.commit([...this.entries, entry])
    try {
      await this.register(entry)
    } catch (error) {
      this.update(entry.id, { error: 'SCHEDULE_REGISTRATION_OUTCOME_UNKNOWN' })
      this.recover(error instanceof Error ? error : new Error(String(error)))
      throw new Error(`OUTCOME_UNKNOWN: schedule=${entry.id} task=${entry.taskId}`)
    }
    return structuredClone(entry)
  }
  async cancel(id: string) {
    await this.initialize()
    const entry = this.entries.find((entry) => entry.id === id)
    if (!entry || !['pending', 'waiting'].includes(entry.status))
      throw new Error('SCHEDULE_NOT_PENDING')
    this.update(id, { cancelRequested: true })
    if (entry.nativeId)
      await this.native!.call('delete', { request: { sessionId: entry.id, id: entry.nativeId } })
    this.update(id, { status: 'cancelled', finishedAt: new Date(this.now()).toISOString() })
  }
  tick() {
    if (this.disposed || this.loadError) return
    try {
      for (const entry of this.entries) {
        if (['dispatching', 'running'].includes(entry.status)) {
          const task = this.options.findTask(entry.taskId)
          if (!task) {
            this.update(entry.id, {
              status: 'unconfirmed',
              error: 'SCHEDULE_ADMISSION_UNCONFIRMED',
            })
          } else if (task.status === 'running') {
            if (entry.status !== 'running') this.update(entry.id, { status: 'running' })
          } else
            this.update(entry.id, {
              status: task.status,
              finishedAt: task.finishedAt,
              error: task.error,
            })
          continue
        }
        if (
          !['pending', 'waiting'].includes(entry.status) ||
          !entry.nativeDue ||
          entry.cancelRequested
        )
          continue
        if (!this.options.available(entry.request)) {
          if (entry.status !== 'waiting')
            this.update(entry.id, { status: 'waiting', error: 'WAITING_FOR_DEVICE_OR_ACTIVE_TASK' })
          continue
        }
        // Commit the UUID before starting, so a crash cannot create an untracked second dispatch.
        this.update(entry.id, {
          status: 'dispatching',
          startedAt: new Date(this.now()).toISOString(),
          error: undefined,
        })
        try {
          const id = this.options.dispatch(entry.request, entry.taskId)
          if (id !== entry.taskId) throw new Error('SCHEDULE_TASK_ID_MISMATCH')
          this.update(entry.id, { status: 'running' })
        } catch {
          const task = this.options.findTask(entry.taskId)
          this.update(
            entry.id,
            task
              ? { status: task.status, error: task.error }
              : { status: 'unconfirmed', error: 'SCHEDULE_ADMISSION_UNCONFIRMED' },
          )
        }
      }
    } catch {
      this.error = 'SCHEDULE_STATE_SAVE_FAILED'
      this.options.onChange()
    }
  }
  start() {
    if (this.timer || this.disposed) return
    this.timer = setInterval(() => this.tick(), 1000)
    void this.initialize().catch(() => {})
  }
  async dispose() {
    this.disposed = true
    clearInterval(this.timer)
    clearTimeout(this.recoveryTimer)
    await this.ready?.catch(() => undefined)
    await this.native?.dispose()
    this.runtimeState = 'stopped'
    this.nextRetryAt = undefined
  }
}
