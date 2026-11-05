import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { TarsAgentOptions } from '../services/tars-agent'
import type { ProactiveObservation } from '../services/proactive-agent'

type Execution = TarsAgentOptions['execution']
type Session = Parameters<Execution['begin']>[0]
type Command = Parameters<Execution['execute']>[0]
type Row = Record<string, unknown>
type Receipt = Session & {
  command_id: string
  observation_id: string
  channel: 'cua_driver'
  outcome: 'not_sent' | 'input_sent' | 'unknown'
  release_confirmed: boolean
  error?: string
  rejected_before_input?: boolean
  journal_error?: string
}
type Result = { ok: boolean; receipt: Receipt; deduplicated?: boolean }
type Dispatch = { version: 1; digest: string; receipt: Receipt }

export interface CuaExecutionOptions {
  fallback: Execution
  journalDirectory: string
  mouse: {
    execute(
      observation: ProactiveObservation,
      action: Row,
      signal: AbortSignal,
    ): Promise<{ release_confirmed: boolean }>
    dispose?(): void | Promise<void>
  }
  prepareInput(): Promise<void>
  validate(observation: ProactiveObservation, action: Row): Promise<{ allowed: boolean }>
  guard(observation: ProactiveObservation, action: Row): Promise<{ allowed: boolean }>
  now?(): number
  maxObservationAgeMs?: number
}

// In the pinned Driver release window-scoped move_cursor moves the overlay,
// not the physical cursor. Preserve RK movement until that contract changes.
const mouseActions = new Set(['click', 'double_click', 'scroll'])
const fallbackActions = new Set(['hotkey', 'paste', 'move'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical((value as Row)[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
function safeCode(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : ''
  return /^[A-Z][A-Z0-9_]{1,100}$/.test(message) ? message : fallback
}

/** Route only observed mouse actions through Cua. Every issued command is
 * claimed durably before input; a missing completion is unknown, never replayed.
 * The journal contains hashes and receipts, not screen text or typed content. */
export class CuaExecution implements Execution {
  private session?: Session
  private stopping = false
  private disposed = false
  private blocked = false
  private initialized?: Promise<void>
  private starting = false
  private inFlight?: Promise<unknown>
  private inFlightCommand?: { id: string; digest: string }
  private abort?: AbortController
  private stopWork?: Promise<unknown>
  private stopSettled = true

  constructor(private readonly options: CuaExecutionOptions) {
    if (!isAbsolute(options.journalDirectory)) throw new Error('CUA_JOURNAL_PATH_INVALID')
    if (
      options.maxObservationAgeMs !== undefined &&
      (!Number.isFinite(options.maxObservationAgeMs) || options.maxObservationAgeMs <= 0)
    )
      throw new Error('CUA_OBSERVATION_TTL_INVALID')
  }

  private async initialize() {
    this.initialized ??= (async () => {
      await mkdir(this.options.journalDirectory, { recursive: true, mode: 0o700 })
      for (const name of await readdir(this.options.journalDirectory)) {
        if (!/^[a-f0-9]{64}\.dispatch\.json$/.test(name)) continue
        const prior = await this.readPrior(name.slice(0, 64))
        if (prior && !prior.receipt.release_confirmed) this.blocked = true
      }
    })()
    await this.initialized
  }

  async connect() {
    if (this.disposed) throw new Error('CUA_EXECUTOR_DISPOSED')
    await this.initialize()
    await this.options.fallback.connect()
  }

  async begin(session: Session) {
    if (this.starting || this.inFlight || (this.session && (!this.stopping || !this.stopSettled)))
      throw new Error('CUA_EXECUTOR_BUSY')
    this.starting = true
    try {
      await this.connect()
      if (this.blocked) throw new Error('INPUT_OUTCOME_UNKNOWN')
      const result = await this.options.fallback.begin(session)
      if (this.disposed) throw new Error('CUA_EXECUTOR_DISPOSED')
      this.session = { ...session }
      this.stopping = false
      this.stopWork = undefined
      return result
    } finally {
      this.starting = false
    }
  }

  private assertSession(session: Session) {
    if (
      this.disposed ||
      this.stopping ||
      !this.session ||
      session.task_id !== this.session.task_id ||
      session.generation !== this.session.generation
    )
      throw new Error('CUA_EXECUTOR_STALE_TASK')
    if (this.blocked) throw new Error('INPUT_OUTCOME_UNKNOWN')
  }

  private assertFresh(value: Command) {
    this.assertSession(value)
    const age = (this.options.now?.() ?? Date.now()) - Number(value.observation.captured_at)
    if (!Number.isFinite(age) || age < 0 || age > (this.options.maxObservationAgeMs ?? 30_000))
      throw new Error('OBSERVATION_EXPIRED')
  }

  private receipt(value: Command, error?: string): Receipt {
    return {
      task_id: value.task_id,
      generation: value.generation,
      command_id: value.command_id,
      observation_id: value.observation.observation_id,
      channel: 'cua_driver',
      outcome: 'not_sent',
      release_confirmed: true,
      ...(error ? { error, rejected_before_input: true } : {}),
    }
  }

  execute(command: Command): Promise<unknown> {
    // Detach caller-owned objects before the first await (including target lists).
    const value = JSON.parse(JSON.stringify(command)) as Command
    if (this.inFlight && this.inFlightCommand?.id === value.command_id) {
      if (this.inFlightCommand.digest === hash(canonical(value))) return this.inFlight
      return Promise.resolve({
        ok: false,
        receipt: {
          ...this.receipt(value),
          outcome: 'unknown',
          release_confirmed: false,
          error: 'COMMAND_CONFLICT',
        },
      })
    }
    if (this.inFlight || this.starting)
      return Promise.resolve({ ok: false, receipt: this.receipt(value, 'CUA_EXECUTOR_BUSY') })
    const abort = new AbortController()
    this.abort = abort
    const work = this.run(value, abort.signal).finally(() => {
      if (this.inFlight === work) {
        this.inFlight = undefined
        this.inFlightCommand = undefined
        this.abort = undefined
      }
    })
    this.inFlight = work
    this.inFlightCommand = { id: value.command_id, digest: hash(canonical(value)) }
    return work
  }

  private async run(value: Command, signal: AbortSignal): Promise<unknown> {
    const key = hash(value.command_id)
    const digest = hash(canonical(value))
    let prior: Dispatch | undefined
    try {
      await this.initialize()
      prior = await this.readPrior(key)
    } catch {
      this.blocked = true
      return {
        ok: false,
        receipt: {
          ...this.receipt(value),
          outcome: 'unknown',
          release_confirmed: false,
          journal_error: 'CUA_JOURNAL_UNAVAILABLE',
        },
      }
    }
    if (prior) {
      if (prior.digest !== digest) {
        // A malformed retry cannot assert that the original action was not sent.
        return { ok: false, receipt: { ...prior.receipt, error: 'COMMAND_CONFLICT' } }
      }
      return {
        ok: prior.receipt.outcome === 'input_sent',
        receipt: prior.receipt,
        deduplicated: true,
      }
    }
    try {
      this.assertSession(value)
      if (!mouseActions.has(String(value.action.action))) {
        if (!fallbackActions.has(String(value.action.action)))
          throw new Error('CUA_ACTION_UNSUPPORTED')
        try {
          const result = await this.options.fallback.execute(value)
          const receipt = (result as { receipt?: Row } | undefined)?.receipt
          if (
            receipt?.journal_error ||
            (receipt?.outcome === 'unknown' && receipt.release_confirmed !== true)
          )
            this.blocked = true
          return result
        } catch (error) {
          const receipt = (error as { receipt?: Row } | undefined)?.receipt
          if (receipt?.outcome !== 'not_sent' && receipt?.release_confirmed !== true)
            this.blocked = true
          throw error
        }
      }
      this.assertFresh(value)
      if (
        !Number.isSafeInteger(value.action.target_id) ||
        Number(value.action.target_id) < 0 ||
        Object.keys(value.action).some(
          (field) => !['action', 'target_id', 'steps'].includes(field),
        ) ||
        (value.action.action !== 'scroll' && 'steps' in value.action) ||
        (value.action.action === 'scroll' &&
          (!Number.isInteger(value.action.steps) ||
            !Number(value.action.steps) ||
            Math.abs(Number(value.action.steps)) > 32))
      )
        throw new Error('CUA_ACTION_INVALID')
      await this.options.prepareInput()
      this.assertFresh(value)
      signal.throwIfAborted()
      if ((await this.options.validate(value.observation, value.action)).allowed !== true)
        throw new Error('INPUT_TARGET_CHANGED')
      this.assertFresh(value)
      if ((await this.options.guard(value.observation, value.action)).allowed !== true)
        throw new Error('INPUT_GUARD_CHANGED')
      this.assertFresh(value)
      signal.throwIfAborted()
    } catch (error) {
      // Exceptions from the RK execution path already carry its own receipt;
      // never relabel an uncertain keyboard dispatch as a rejected mouse action.
      if (
        !mouseActions.has(String(value.action.action)) &&
        fallbackActions.has(String(value.action.action))
      )
        throw error
      return {
        ok: false,
        receipt: this.receipt(value, safeCode(error, 'INPUT_PREPARATION_FAILED')),
      }
    }

    const record: Dispatch = {
      version: 1,
      digest,
      receipt: {
        ...this.receipt(value),
        outcome: 'unknown',
        release_confirmed: false,
      },
    }
    try {
      await this.writeExclusive(key + '.dispatch.json', record)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // A second process may have claimed it. Do not execute or overwrite it.
        return { ok: false, receipt: { ...record.receipt, error: 'COMMAND_ALREADY_CLAIMED' } }
      }
      this.blocked = true
      return {
        ok: false,
        receipt: {
          ...this.receipt(value, 'CUA_JOURNAL_UNAVAILABLE'),
          journal_error: 'CUA_JOURNAL_UNAVAILABLE',
        },
      }
    }

    let sent = false
    let result: Result
    try {
      // fsync and earlier checks may take time. Recheck immediately before dispatch.
      this.assertFresh(value)
      signal.throwIfAborted()
      if ((await this.options.guard(value.observation, value.action)).allowed !== true)
        throw new Error('INPUT_GUARD_CHANGED')
      this.assertFresh(value)
      signal.throwIfAborted()
      sent = true
      const response = await this.options.mouse.execute(value.observation, value.action, signal)
      if (response?.release_confirmed !== true) throw new Error('CUA_RELEASE_UNCONFIRMED')
      result = {
        ok: true,
        receipt: { ...record.receipt, outcome: 'input_sent', release_confirmed: true },
      }
    } catch (error) {
      const flags = error as
        { rejectedBeforeInput?: boolean; releaseConfirmed?: boolean } | undefined
      const rejected = !sent || flags?.rejectedBeforeInput === true
      result = {
        ok: false,
        receipt: {
          ...record.receipt,
          outcome: rejected ? 'not_sent' : 'unknown',
          release_confirmed: rejected || flags?.releaseConfirmed === true,
          ...(rejected ? { rejected_before_input: true } : {}),
          error: safeCode(error, 'CUA_INPUT_OUTCOME_UNKNOWN'),
        },
      }
    }
    try {
      await this.writeExclusive(key + '.receipt.json', { ...record, receipt: result.receipt })
    } catch {
      result.receipt.journal_error = 'CUA_JOURNAL_UNAVAILABLE'
      result.ok = false
      this.blocked = true
    }
    if (!result.receipt.release_confirmed) this.blocked = true
    return result
  }

  private async writeExclusive(name: string, record: Dispatch) {
    const handle = await open(join(this.options.journalDirectory, name), 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async readRecord(name: string): Promise<Dispatch | undefined> {
    const file = join(this.options.journalDirectory, name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
        throw new Error('CUA_JOURNAL_INVALID')
      const row = JSON.parse(await readFile(file, 'utf8')) as Dispatch
      if (
        row.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(row.digest) ||
        row.receipt?.channel !== 'cua_driver' ||
        !['unknown', 'input_sent', 'not_sent'].includes(row.receipt.outcome) ||
        typeof row.receipt.release_confirmed !== 'boolean' ||
        hash(row.receipt.command_id) !== name.slice(0, 64)
      )
        throw new Error('CUA_JOURNAL_INVALID')
      return row
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readPrior(key: string): Promise<Dispatch | undefined> {
    const dispatch = await this.readRecord(key + '.dispatch.json')
    if (!dispatch) return undefined
    const result = await this.readRecord(key + '.receipt.json')
    if (result && result.digest !== dispatch.digest) throw new Error('CUA_JOURNAL_CONFLICT')
    return result ?? dispatch
  }

  async stop(session: Session) {
    if (
      !this.session ||
      session.task_id !== this.session.task_id ||
      session.generation !== this.session.generation
    )
      throw new Error('CUA_EXECUTOR_STALE_TASK')
    if (this.stopWork) return this.stopWork
    this.stopping = true
    this.stopSettled = false
    this.abort?.abort()
    const pending = this.inFlight
    this.stopWork = (async () => {
      const fallbackStop = this.options.fallback.stop(session)
      // Consume both promises even when stop or dispatch rejects.
      const [stopped] = await Promise.allSettled([fallbackStop, pending])
      if (stopped.status === 'rejected') throw stopped.reason
      const result = stopped.value as Row
      return { ...result, neutral: result.neutral === true && !this.blocked }
    })().finally(() => {
      this.stopSettled = true
    })
    return this.stopWork
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopping = true
    this.abort?.abort()
    await Promise.allSettled([
      this.options.mouse.dispose?.(),
      this.options.fallback.dispose(),
      this.inFlight,
    ])
  }
}

export function createCuaExecution(options: CuaExecutionOptions): Execution {
  return new CuaExecution(options)
}
