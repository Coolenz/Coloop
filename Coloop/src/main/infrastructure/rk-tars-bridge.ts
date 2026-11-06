import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { DesktopPipe, DesktopPipeError } from './desktop-pipe'
import type { ProactiveObservation } from '../services/proactive-agent'

type Channel = Readable & Writable & { close(): void }
type Row = Record<string, unknown>
/** Test/custom data directories must not read or enqueue production memories. */
export function rkMemoryNamespace(isolatedDirectory?: string): string {
  if (!isolatedDirectory) return 'production'
  const path = resolve(isolatedDirectory)
  const identity = process.platform === 'win32' ? path.toLowerCase() : path
  return 'qa:profile:' + createHash('sha256').update(identity).digest('hex')
}

const errorCode = (error: unknown, fallback: string) => {
  const code =
    error instanceof DesktopPipeError ? error.code : error instanceof Error ? error.message : ''
  return /^[A-Z_]{1,100}$/.test(code) ? code : fallback
}
interface Options {
  executorScript: string
  memoryScript: string
  supportScript: string
  namespace?: string
  openRuntime(source: string): Promise<Channel>
  input(op: string, view: ProactiveObservation, value: Row): Promise<unknown>
  clipboard(op: string, value: Row): Promise<unknown>
  releaseClipboard(taskId: string): Promise<void>
  prepareInput(): Promise<void>
  onMemorySaved?(taskId: string, saved: boolean): void
  onDisconnected?(): void
  onEvent?(event: Row): void
}

/** Transport only: the SDK owns reasoning; RK owns durable input receipts. */
export class RkTarsBridge {
  private executor?: DesktopPipe
  private memory?: DesktopPipe
  private openingExecutor?: Promise<void>
  private openingMemory?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private disposed = false
  private task?: { task_id: string; generation: string | number }
  private stopping = false
  private views = new Map<string, ProactiveObservation>()
  private clipboardPreparations = new Set<Promise<unknown>>()
  constructor(private options: Options) {}

  private async source(path: string) {
    const [support, entry] = await Promise.all([
      readFile(this.options.supportScript, 'utf8'),
      readFile(path, 'utf8'),
    ])
    // Import reusable deterministic helpers and the memory queue without ever
    // instantiating the legacy Agent or entering its planning loop.
    return (
      `import base64,sys,types,os,zlib\n` +
      `support=types.ModuleType('coloop_rk_support')\n` +
      `sys.modules['coloop_rk_support']=support\n` +
      `exec(zlib.decompress(base64.b64decode('${deflateSync(Buffer.from(support)).toString('base64')}')),support.__dict__)\n` +
      `for legacy in ('Agent','DecisionBudget','CLOUD','main'):\n    support.__dict__.pop(legacy,None)\n` +
      `os.environ['COLOOP_MEMORY_NAMESPACE']=${JSON.stringify(this.options.namespace ?? 'production')}\n` +
      entry
    )
  }

  private checkResult(value: unknown): Row {
    if (!value || typeof value !== 'object') throw new Error('RK_ADAPTER_INVALID_REPLY')
    const row = value as Row
    if (row.ok !== true) {
      const error = Object.assign(new Error(String(row.error ?? 'RK_ADAPTER_REJECTED')), {
        code: row.error,
        receipt: row.receipt,
      })
      throw error
    }
    return row
  }

  async connect() {
    if (this.disposed) throw new Error('RK_ADAPTER_DISPOSED')
    if (this.openingExecutor) return this.openingExecutor
    if (this.executor) return
    this.openingExecutor = (async () => {
      const channel = await this.options.openRuntime(await this.source(this.options.executorScript))
      if (this.disposed) {
        channel.close()
        throw new Error('RK_ADAPTER_DISPOSED')
      }
      const pipe = new DesktopPipe(channel, channel, () => channel.close())
      this.executor = pipe
      pipe.on('packet', (packet) => void this.hostRequest(pipe, packet).catch(() => pipe.close()))
      pipe.on('closed', () => {
        if (this.executor !== pipe) return
        this.executor = undefined
        clearInterval(this.heartbeat)
        this.stopping = true
        if (this.task) void this.options.releaseClipboard(this.task.task_id).catch(() => {})
        this.options.onDisconnected?.()
      })
      this.heartbeat = setInterval(() => {
        try {
          pipe.send({ type: 'heartbeat' })
        } catch {
          pipe.close()
        }
      }, 1000)
      this.heartbeat.unref()
      const ready = (await pipe.ready) as Row
      if (this.executor !== pipe || this.disposed || ready?.protocol !== 'coloop-rk-executor-v1') {
        pipe.close()
        throw new Error('RK_ADAPTER_PROTOCOL')
      }
    })().finally(() => {
      this.openingExecutor = undefined
    })
    return this.openingExecutor
  }

  private async connectMemory() {
    if (this.disposed) throw new Error('RK_ADAPTER_DISPOSED')
    if (this.openingMemory) return this.openingMemory
    if (this.memory) return
    this.openingMemory = (async () => {
      const channel = await this.options.openRuntime(await this.source(this.options.memoryScript))
      if (this.disposed) {
        channel.close()
        throw new Error('RK_ADAPTER_DISPOSED')
      }
      const pipe = new DesktopPipe(channel, channel, () => channel.close())
      this.memory = pipe
      pipe.on('packet', (packet: Row) => {
        if (this.memory !== pipe || this.disposed) return
        this.options.onEvent?.(packet)
        const value = packet.value as Row | undefined
        if (packet.type === 'memory.saved' && typeof value?.task_id === 'string')
          this.options.onMemorySaved?.(value.task_id, value.saved === true)
      })
      pipe.on('closed', () => {
        if (this.memory === pipe) this.memory = undefined
      })
      const ready = (await pipe.ready) as Row
      if (this.memory !== pipe || this.disposed || ready?.protocol !== 'coloop-rk-memory-v1') {
        pipe.close()
        throw new Error('RK_MEMORY_PROTOCOL')
      }
    })().finally(() => {
      this.openingMemory = undefined
    })
    return this.openingMemory
  }

  async begin(task: { task_id: string; generation: string | number }) {
    await this.connect()
    if (this.task && !this.stopping) throw new Error('RK_ADAPTER_BUSY')
    const result = this.checkResult(await this.executor!.request('begin', task))
    this.task = task
    this.stopping = false
    this.views.clear()
    return result
  }

  async execute(value: {
    task_id: string
    generation: string | number
    command_id: string
    observation: ProactiveObservation
    action: unknown
  }) {
    let pipe: DesktopPipe
    try {
      this.assertTask(value)
      pipe = this.executor!
      this.views.set(value.observation.observation_id, value.observation)
      if (this.views.size > 16) this.views.delete(this.views.keys().next().value!)
      await this.options.prepareInput()
      this.assertTask(value)
      if (this.executor !== pipe) throw new Error('RK_ADAPTER_DISCONNECTED')
    } catch (error) {
      // No execute request has been sent. Transport errors after the request
      // remain outside this catch because their input outcome may be unknown.
      const code = errorCode(error, 'INPUT_PREPARATION_FAILED')
      throw Object.assign(new Error(code), {
        receipt: {
          task_id: value.task_id,
          generation: value.generation,
          command_id: value.command_id,
          observation_id: value.observation.observation_id,
          outcome: 'not_sent',
          release_confirmed: true,
          rejected_before_input: true,
          error: code,
        },
      })
    }
    const result = await pipe.request('execute', value)
    this.options.onEvent?.({ type: 'execution.receipt', value: result })
    return this.checkResult(result)
  }

  private assertTask(value: Row) {
    if (
      this.disposed ||
      this.stopping ||
      !this.executor ||
      !this.task ||
      this.task.task_id !== value.task_id ||
      this.task.generation !== value.generation
    )
      throw new Error('RK_ADAPTER_STALE_TASK')
  }

  async stop(value: { task_id: string; generation: string | number }) {
    if (
      !this.task ||
      value.task_id !== this.task.task_id ||
      value.generation !== this.task.generation
    )
      throw new Error('RK_ADAPTER_STALE_TASK')
    this.stopping = true
    if (!this.executor) throw new Error('RK_ADAPTER_DISCONNECTED')
    const result = this.checkResult(await this.executor.request('stop', value))
    await Promise.allSettled([...this.clipboardPreparations])
    await this.options.releaseClipboard(value.task_id)
    return result
  }

  async status(value: Row) {
    await this.connect()
    return this.checkResult(await this.executor!.request('status', value))
  }

  async enqueue(evidence: Row) {
    await this.connectMemory()
    return this.checkResult(await this.memory!.request('memory.enqueue', evidence))
  }
  async catalog(value: Row = {}) {
    await this.connectMemory()
    return this.checkResult(await this.memory!.request('memory.catalog', value))
  }
  async get(value: Row) {
    await this.connectMemory()
    return this.checkResult(await this.memory!.request('memory.get', value))
  }
  async remember(value: Row) {
    await this.connectMemory()
    return this.checkResult(await this.memory!.request('memory.remember', value))
  }

  private async hostRequest(pipe: DesktopPipe, packet: Row) {
    if (this.executor !== pipe || this.disposed) return
    this.options.onEvent?.(packet)
    if (packet.type !== 'request') return
    const op = String(packet.op)
    const value = packet.value as Row
    const cleanup = op === 'clipboard.finish'
    try {
      if (
        !value ||
        value.task_id !== this.task?.task_id ||
        value.generation !== this.task?.generation ||
        (!cleanup && this.stopping)
      )
        throw new Error('RK_ADAPTER_STALE_TASK')
      let result: unknown
      if (['clipboard.prepare', 'clipboard.guard', 'clipboard.finish'].includes(op)) {
        if (!cleanup) {
          const view = this.views.get(String(value.observation_id))
          if (!view) throw new Error('OBSERVATION_EXPIRED')
          const guard = (await this.options.input('input.guard', view, value)) as Row
          if (guard?.allowed !== true) throw new Error('INPUT_GUARD_CHANGED')
          if (
            this.stopping ||
            this.task?.task_id !== value.task_id ||
            this.task?.generation !== value.generation ||
            this.executor !== pipe
          )
            throw new Error('RK_ADAPTER_STALE_TASK')
        }
        if (op === 'clipboard.prepare') {
          const preparing = (async () => {
            // Native Windows Edit controls require CRLF to display line breaks.
            // Keep the action's original text for verification (which normalizes
            // line endings); only adapt the temporary clipboard representation.
            const prepared = await this.options.clipboard(op, {
              ...value,
              text:
                typeof value.text === 'string'
                  ? value.text.replace(/\r\n|\r|\n/g, '\r\n')
                  : value.text,
            })
            if (
              this.stopping ||
              this.disposed ||
              this.executor !== pipe ||
              this.task?.task_id !== value.task_id ||
              this.task?.generation !== value.generation
            )
              await this.options.releaseClipboard(String(value.task_id))
            return prepared
          })()
          this.clipboardPreparations.add(preparing)
          try {
            result = await preparing
          } finally {
            this.clipboardPreparations.delete(preparing)
          }
        } else result = await this.options.clipboard(op, value)
      } else if (['input.validate', 'input.guard', 'clipboard.verify'].includes(op)) {
        const view = this.views.get(String(value.observation_id))
        if (!view) throw new Error('OBSERVATION_EXPIRED')
        result = await this.options.input(op, view, value)
        if (op === 'input.guard' && typeof value.lease_id === 'string') {
          const guard = (await this.options.clipboard('clipboard.guard', value)) as Row
          if (guard?.allowed !== true) throw new Error('CLIPBOARD_LEASE_CHANGED')
        }
      } else throw new Error('RK_ADAPTER_RPC_NOT_ALLOWED')
      if (
        this.executor !== pipe ||
        this.disposed ||
        this.task?.task_id !== value.task_id ||
        this.task?.generation !== value.generation ||
        (!cleanup && this.stopping)
      )
        throw new Error('RK_ADAPTER_STALE_TASK')
      pipe.send({ type: 'reply', id: packet.id, value: result })
    } catch (error) {
      if (this.executor === pipe && !this.disposed)
        pipe.send({
          type: 'reply',
          id: packet.id,
          error: errorCode(error, 'RK_ADAPTER_RPC_FAILED'),
        })
    }
  }

  async dispose() {
    if (this.disposed) return
    if (this.task && !this.stopping) await this.stop(this.task).catch(() => {})
    this.disposed = true
    await Promise.allSettled([...this.clipboardPreparations])
    if (this.task) await this.options.releaseClipboard(this.task.task_id).catch(() => {})
    clearInterval(this.heartbeat)
    this.executor?.close()
    this.memory?.close()
    this.views.clear()
  }
}
