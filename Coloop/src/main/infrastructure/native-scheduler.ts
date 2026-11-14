import { fork, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
export interface NativeSchedulerPaths {
  resources: string
  node: string
}
export class NativeScheduler {
  private child: ChildProcess
  private sequence = 0
  private requests = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  readonly ready: Promise<void>
  private exited: Promise<void>
  private closing = false
  private failed = false
  private closePromise?: Promise<void>
  constructor(
    directory: string,
    due: (id: string) => void,
    failed: (error: Error) => void,
    paths: NativeSchedulerPaths = {
      resources: resolve('resources/harness'),
      node: process.execPath,
    },
  ) {
    const script = join(paths.resources, 'coloop-scheduler.mjs')
    if (!existsSync(script) || !existsSync(paths.node))
      throw new Error('NATIVE_SCHEDULER_FILES_MISSING')
    const temporary = resolve('D:/Coloop/.cache/temp/native-scheduler')
    mkdirSync(temporary, { recursive: true })
    this.child = fork(script, [], {
      execPath: paths.node,
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(
              name,
            ),
          ),
        ),
        TEMP: temporary,
        TMP: temporary,
        TMPDIR: temporary,
        COLOOP_SCHEDULER_MANIFEST: join(
          dirname(require.resolve('@deepseek-ai/dsh/package.json')),
          'package.json',
        ),
        COLOOP_SCHEDULER_HOME: join(directory, 'native-schedules'),
      },
    })
    let diagnostic = ''
    this.child.stderr?.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-4000)
    })
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()))
    this.ready = new Promise((resolveReady, rejectReady) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('NATIVE_SCHEDULER_START_TIMEOUT')), 30000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        rejectReady(error)
        for (const pending of this.requests.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.requests.clear()
        if (this.closing || this.failed) return
        this.failed = true
        failed(error)
        this.child.kill()
      }
      this.child.on('error', (error) =>
        fail(ready ? error : new Error(`NATIVE_SCHEDULER_START_FAILED: ${error.message}`)),
      )
      this.child.once('exit', (code) =>
        fail(
          new Error(
            `${ready ? 'NATIVE_SCHEDULER_EXITED' : 'NATIVE_SCHEDULER_START_FAILED'} (${code}): ${diagnostic}`,
          ),
        ),
      )
      this.child.once('disconnect', () => {
        if (ready) fail(new Error('NATIVE_SCHEDULER_DISCONNECTED'))
      })
      this.child.on('message', (message: any) => {
        if (message.event === 'ready') {
          ready = true
          clearTimeout(timer)
          resolveReady()
        } else if (message.event === 'due') {
          try {
            due(message.sessionId)
            this.child.send({ reply: message.id }, () => {})
          } catch (error) {
            this.child.send({ reply: message.id, error: String(error) }, () => {})
          }
        } else {
          const pending = this.requests.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.requests.delete(message.id)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.value)
        }
      })
    })
  }
  async call(method: string, parameters: Record<string, unknown> = {}): Promise<any> {
    await this.ready
    if (!this.child.connected) throw new Error('NATIVE_SCHEDULER_DISCONNECTED')
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error('NATIVE_SCHEDULER_OUTCOME_UNKNOWN'))
        this.child.kill()
      }, 30000)
      this.requests.set(id, { resolve, reject, timer })
      this.child.send({ id, method, ...parameters }, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.requests.delete(id)
        reject(error)
      })
    })
  }
  dispose() {
    return (this.closePromise ??= this.close())
  }
  private async close() {
    this.closing = true
    const timer = setTimeout(() => this.child.kill(), 5000)
    try {
      await this.ready
      if (this.child.connected) await this.call('close')
    } catch {
      /* Exit and IPC errors have already settled their callers. */
    } finally {
      await this.exited
      clearTimeout(timer)
    }
  }
}
