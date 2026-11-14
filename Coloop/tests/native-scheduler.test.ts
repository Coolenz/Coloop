import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeScheduler } from '../src/main/infrastructure/native-scheduler'

let directory: string
let runtime: NativeScheduler | undefined
async function fixture(script: string) {
  directory = await mkdtemp(join(tmpdir(), 'coloop-native-lifecycle-'))
  await writeFile(join(directory, 'coloop-scheduler.mjs'), script)
  return { resources: directory, node: process.execPath }
}
afterEach(async () => {
  vi.useRealTimers()
  await runtime?.dispose()
  runtime = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
})
it('bounds startup and settles dispose when the child never announces readiness', async () => {
  const paths = await fixture('process.on("message", () => {});')
  vi.useFakeTimers()
  runtime = new NativeScheduler(
    directory,
    () => {},
    () => {},
    paths,
  )
  const rejected = expect(runtime.ready).rejects.toThrow('START_TIMEOUT')
  await vi.advanceTimersByTimeAsync(30000)
  await rejected
  vi.useRealTimers()
  await runtime.dispose()
})
it('marks a timed-out management RPC as outcome unknown and drains shutdown', async () => {
  const paths = await fixture('process.send({event:"ready"}); process.on("message", () => {});')
  runtime = new NativeScheduler(
    directory,
    () => {},
    () => {},
    paths,
  )
  await runtime.ready
  vi.useFakeTimers()
  const rejected = expect(runtime.call('create')).rejects.toThrow('OUTCOME_UNKNOWN')
  await vi.advanceTimersByTimeAsync(30000)
  await rejected
  vi.useRealTimers()
  await runtime.dispose()
})
it('preserves a startup failure diagnosis and settles all lifecycle waits', async () => {
  const paths = await fixture(
    'console.error("NATIVE_SCHEDULER_VERSION_MISMATCH"); process.exit(1);',
  )
  runtime = new NativeScheduler(
    directory,
    () => {},
    () => {},
    paths,
  )
  await expect(runtime.ready).rejects.toThrow('VERSION_MISMATCH')
  await runtime.dispose()
})
