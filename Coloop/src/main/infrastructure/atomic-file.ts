import { renameSync } from 'node:fs'

const retryClock = new Int32Array(new SharedArrayBuffer(4))

/** Windows readers can briefly retain a sharing lock after a file is closed.
 * Keep the old destination intact and bound retries for synchronous admission. */
export function replaceFileSync(temporary: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporary, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        attempt >= 4
      )
        throw error
      Atomics.wait(retryClock, 0, 0, 10 * (attempt + 1))
    }
  }
}
