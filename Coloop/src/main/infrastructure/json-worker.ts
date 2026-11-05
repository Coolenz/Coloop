import { spawn } from 'node:child_process'

/** Static resource workers receive data-only JSON, without provider credentials. */
export function runJsonWorker(
  script: string,
  input: unknown,
  options: {
    signal: AbortSignal
    timeoutMs?: number
    drainOnAbort?: boolean
    errorPrefix?: string
  },
): Promise<Record<string, unknown>> {
  const { signal, timeoutMs = 120000, drainOnAbort = false, errorPrefix = 'WORKER' } = options
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          USERPROFILE: process.env.USERPROFILE,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          APPDATA: process.env.APPDATA,
        },
      },
    )
    let output = ''
    let failed: Error | undefined
    const stop = () => {
      failed = new DOMException('Operation stopped', 'AbortError')
      if (!drainOnAbort) child.kill()
    }
    const timer = setTimeout(() => {
      failed = new Error(`${errorPrefix}_OPERATION_TIMEOUT`)
      child.kill()
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part: string) => {
      output += part
      if (Buffer.byteLength(output) > 1024 * 1024) {
        failed = new Error(`${errorPrefix}_RESPONSE_TOO_LARGE`)
        child.kill()
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', (error) => {
      failed = error
    })
    child.stdin.on('error', () => {})
    child.once('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (failed || signal.aborted)
        return reject(failed ?? new DOMException('Stopped', 'AbortError'))
      if (code !== 0) return reject(new Error(`${errorPrefix}_PROCESS_EXITED`))
      try {
        const result = JSON.parse(output)
        if (result.ok !== true)
          throw new Error(
            typeof result.error === 'string' && /^[A-Z_]{1,100}$/.test(result.error)
              ? `${result.error}${typeof result.stage === 'string' && /^[a-z_]{1,50}$/.test(result.stage) ? ` (${result.stage})` : ''}`
              : `${errorPrefix}_OPERATION_FAILED`,
          )
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    else child.stdin.end(JSON.stringify(input) + '\n')
  })
}
