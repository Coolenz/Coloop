import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Native metadata only: window focus, US keyboard layout, Caps Lock and modifier state. */
export class PrivateLoginFocus {
  private process: ChildProcessWithoutNullStreams
  private pending?: (safe: boolean) => void
  private output = ''
  private stopped = false
  private first = true
  constructor(scriptPath: string, handle: Buffer) {
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())
    this.process = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-WindowHandle',
        String(hwnd),
      ],
      { windowsHide: true, stdio: 'pipe' },
    )
    this.process.stderr.resume()
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (data: string) => {
      this.output += data
      while (this.output.includes('\n')) {
        const end = this.output.indexOf('\n')
        const value = this.output.slice(0, end).trim()
        this.output = this.output.slice(end + 1)
        this.pending?.(value === 'true')
      }
      if (this.output.length > 100) this.dispose()
    })
    this.process.on('error', () => this.dispose())
    this.process.on('close', () => this.dispose())
    this.process.stdin.on('error', () => this.dispose())
  }
  async probe(initial: boolean): Promise<boolean> {
    if (this.stopped || this.pending) return false
    const timeout = this.first ? 5_000 : 170
    this.first = false
    return new Promise((resolve) => {
      const finish = (safe: boolean) => {
        clearTimeout(timer)
        this.pending = undefined
        resolve(safe)
      }
      const timer = setTimeout(() => {
        finish(false)
        this.dispose()
      }, timeout)
      this.pending = finish
      this.process.stdin.write(initial ? 'initial\n' : 'continue\n')
    })
  }
  dispose() {
    if (this.stopped) return
    this.stopped = true
    this.pending?.(false)
    this.process.kill()
  }
}
