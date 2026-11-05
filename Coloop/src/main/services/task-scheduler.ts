import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
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
})
interface Options {
  directory: string
  available(request: TaskRequest): boolean
  findTask(id: string): Task | undefined
  dispatch(request: TaskRequest, taskId: string): string
  onChange(): void
  now?(): number
}

/** Durable one-shot admission. An uncertain previous admission is never automatically replayed. */
export class TaskScheduler {
  private entries: ScheduledTask[] = []
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
    return { entries: structuredClone(this.entries), error: this.error }
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private commit(entries: ScheduledTask[]) {
    if (this.loadError) throw new Error('SCHEDULE_STORE_UNREADABLE')
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    this.entries = entries
    this.error = undefined
    this.options.onChange()
  }
  private update(id: string, patch: Partial<ScheduledTask>) {
    this.commit(this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  }
  create(input: ScheduleRequest) {
    if (this.disposed) throw new Error('SCHEDULER_DISPOSED')
    const request = scheduleRequestSchema.parse(input)
    new Intl.DateTimeFormat('en', { timeZone: request.timezone }).format(this.now())
    if (Date.parse(request.runAt) <= this.now()) throw new Error('SCHEDULE_TIME_MUST_BE_FUTURE')
    if (this.entries.length >= 1000) throw new Error('SCHEDULE_LIMIT_REACHED')
    const entry: ScheduledTask = {
      ...request,
      id: randomUUID(),
      taskId: randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      status: 'pending',
    }
    this.commit([...this.entries, entry])
    return structuredClone(entry)
  }
  cancel(id: string) {
    const entry = this.entries.find((entry) => entry.id === id)
    if (!entry || !['pending', 'waiting'].includes(entry.status))
      throw new Error('SCHEDULE_NOT_PENDING')
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
        if (!['pending', 'waiting'].includes(entry.status) || Date.parse(entry.runAt) > this.now())
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
    this.tick()
  }
  dispose() {
    this.disposed = true
    clearInterval(this.timer)
  }
}
