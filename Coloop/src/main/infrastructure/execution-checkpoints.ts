import { mkdir, open, readFile, readdir, rename, rm, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { cloudFieldSchema, type CloudField } from '../../shared/contracts'

export interface ExecutionCheckpoint {
  taskId: string
  goal: string
  preference: 'auto' | 'cloud' | 'rk'
  workspace?: string
  approvedFields: CloudField[]
  supplements: string[]
  commands: Record<string, unknown>[]
  artifacts: { id: string; path: string; sha256: string }[]
  phase: string
  runtime: 'harness'
  updatedAt: number
}

const idSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const checkpointSchema = z
  .object({
    taskId: idSchema,
    goal: z.string().min(1).max(24000),
    preference: z.enum(['auto', 'cloud', 'rk']),
    workspace: z.string().min(1).max(2048).optional(),
    approvedFields: z.array(cloudFieldSchema).max(64),
    supplements: z.array(z.string().max(24000)).max(200),
    commands: z.array(z.record(z.string(), z.json())).max(2000),
    artifacts: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            path: z.string().min(1).max(2048),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(2000),
    phase: z.string().regex(/^[a-z_]{1,64}$/),
    runtime: z.literal('harness'),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()

const recoverable = new Set([
  'queued',
  'planning',
  'observing',
  'executing',
  'verifying',
  'waiting_user',
  'waiting_source',
  'stopping',
  'cancelled',
  'blocked',
  'failed',
  'input_unknown',
  'offline',
])
const MAX_BYTES = 16 * 1024 * 1024

/** Durable evidence for explicit recovery only. No constructor replay, scheduling,
 * artifact reads or command execution. The host owns and supplies the directory. */
export class ExecutionCheckpointStore {
  private writes = Promise.resolve()
  constructor(private readonly directory: string) {
    if (!isAbsolute(directory)) throw new Error('CHECKPOINT_DIRECTORY_MUST_BE_ABSOLUTE')
  }

  save(record: ExecutionCheckpoint): Promise<void> {
    // Validate before queuing and detach from mutable caller state immediately.
    const parsed = checkpointSchema.parse(record)
    const encoded = JSON.stringify(parsed)
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('CHECKPOINT_TOO_LARGE')
    const work = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const file = join(this.directory, parsed.taskId + '.json')
      const previous = await this.read(parsed.taskId)
      if (previous && previous.updatedAt > parsed.updatedAt)
        throw new Error('CHECKPOINT_STALE_WRITE')
      const temporary = join(this.directory, `${parsed.taskId}.${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(encoded, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, file)
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
    })
    this.writes = work.catch(() => {})
    return work
  }

  private async read(taskId: string): Promise<ExecutionCheckpoint | undefined> {
    const id = idSchema.parse(taskId)
    const file = join(this.directory, id + '.json')
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
        throw new Error('CHECKPOINT_UNREADABLE')
      const value = checkpointSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      if (value.taskId !== id) throw new Error('CHECKPOINT_ID_MISMATCH')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('CHECKPOINT_UNREADABLE', { cause: error })
    }
  }

  async get(taskId: string): Promise<ExecutionCheckpoint | undefined> {
    const id = idSchema.parse(taskId)
    await this.writes
    return this.read(id)
  }

  async listRecoverable(): Promise<ExecutionCheckpoint[]> {
    await this.writes
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: ExecutionCheckpoint[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || !idSchema.safeParse(name.slice(0, -5)).success) continue
      const record = await this.read(name.slice(0, -5))
      if (record && recoverable.has(record.phase)) records.push(record)
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}
