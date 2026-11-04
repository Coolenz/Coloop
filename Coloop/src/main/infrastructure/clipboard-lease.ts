import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DesktopPipe } from './desktop-pipe'

/** Private native clipboard transaction. Original contents never cross this boundary. */
export class ClipboardLeaseService {
  private child?: ChildProcessWithoutNullStreams
  private pipe?: DesktopPipe
  private leases = new Map<string, string>()
  constructor(private readonly script: string) {}

  async call(op: string, value: Record<string, unknown>): Promise<unknown> {
    if (!['clipboard.prepare', 'clipboard.guard', 'clipboard.finish'].includes(op))
      throw new Error('CLIPBOARD_OPERATION_UNSUPPORTED')
    if (!this.pipe) {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      this.child = child
      const pipe = new DesktopPipe(child.stdout, child.stdin, () => {
        child.stdin.end()
      })
      this.pipe = pipe
      pipe.on('closed', () => {
        if (this.pipe === pipe) {
          this.pipe = undefined
          this.child = undefined
          this.leases.clear()
        }
      })
      child.on('error', () => pipe.close())
      child.on('exit', () => pipe.close())
      child.stderr.on('data', () => {})
    }
    await this.pipe.ready
    const result = (await this.pipe.request(op, value)) as Record<string, unknown>
    if (op === 'clipboard.prepare' && typeof result.lease_id === 'string')
      this.leases.set(result.lease_id, String(value.task_id))
    if (op === 'clipboard.finish') this.leases.delete(String(value.lease_id))
    return result
  }

  async releaseTask(taskId: string) {
    for (const [lease_id, task_id] of this.leases)
      if (task_id === taskId)
        await this.call('clipboard.finish', { lease_id, task_id }).catch(() => {})
  }

  async dispose() {
    for (const [lease_id, task_id] of this.leases)
      await this.call('clipboard.finish', { lease_id, task_id }).catch(() => {})
    const child = this.child
    this.pipe?.close()
    if (child) {
      const timer = setTimeout(() => child.kill(), 2000)
      timer.unref()
      child.once('exit', () => clearTimeout(timer))
    }
  }
}
