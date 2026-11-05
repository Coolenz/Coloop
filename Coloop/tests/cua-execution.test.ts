import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { CuaExecution, type CuaExecutionOptions } from '../src/main/infrastructure/cua-execution'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const session = { task_id: 'task-1', generation: 'generation-1' }
function command(id = 'command-1') {
  return {
    ...session,
    command_id: id,
    observation: {
      observation_id: 'observation-1',
      window_id: '123',
      captured_at: 1000,
      process_id: 456,
      ocr_text: 'Private screen text',
      targets: [{ id: 1, name: 'Calculate' }],
    },
    action: { action: 'click', target_id: 1 } as Record<string, unknown>,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function setup(patch: Partial<CuaExecutionOptions> = {}, directory?: string) {
  const journalDirectory = directory ?? (await mkdtemp(join(tmpdir(), 'coloop-cua-execution-')))
  if (!directory) directories.push(journalDirectory)
  const fallback = {
    connect: vi.fn(async () => {}),
    begin: vi.fn(async () => ({ ok: true })),
    execute: vi.fn(async (_command: unknown) => ({ ok: true, receipt: { channel: 'rk_hid' } })),
    stop: vi.fn(async () => ({ ok: true, stopped: true, neutral: true })),
    dispose: vi.fn(async () => {}),
  }
  const mouse = { execute: vi.fn(async () => ({ release_confirmed: true })), dispose: vi.fn() }
  const options: CuaExecutionOptions = {
    fallback,
    mouse,
    journalDirectory,
    now: () => 1000,
    prepareInput: vi.fn(async () => {}),
    validate: vi.fn(async () => ({ allowed: true })),
    guard: vi.fn(async () => ({ allowed: true })),
    ...patch,
  }
  const executor = new CuaExecution(options)
  await executor.begin(session)
  return { executor, options, fallback, mouse, journalDirectory }
}

it('routes mouse through Cua only, keeps RK keyboard and lifecycle, and records the channel', async () => {
  const { executor, fallback, mouse } = await setup()
  expect(await executor.execute(command())).toMatchObject({
    ok: true,
    receipt: {
      outcome: 'input_sent',
      release_confirmed: true,
      channel: 'cua_driver',
      command_id: 'command-1',
    },
  })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
  expect(fallback.execute).not.toHaveBeenCalled()
  const keyboard = {
    ...command('keyboard'),
    action: { action: 'hotkey', target_id: 1, keys: 'CTRL+A' },
  }
  expect(await executor.execute(keyboard)).toMatchObject({ receipt: { channel: 'rk_hid' } })
  expect(fallback.execute).toHaveBeenCalledWith(keyboard)
  const move = { ...command('move'), action: { action: 'move', target_id: 1 } }
  expect(await executor.execute(move)).toMatchObject({ receipt: { channel: 'rk_hid' } })
  expect(fallback.execute).toHaveBeenLastCalledWith(move)
  expect(await executor.stop(session)).toMatchObject({ ok: true, stopped: true, neutral: true })
  await executor.dispose()
  expect(fallback.connect).toHaveBeenCalledOnce()
  expect(fallback.begin).toHaveBeenCalledWith(session)
  expect(fallback.stop).toHaveBeenCalledWith(session)
  expect(fallback.dispose).toHaveBeenCalledOnce()
})

it('rejects stale observations and mismatched tasks before any input', async () => {
  const { executor, mouse } = await setup()
  expect(await executor.execute({ ...command(), generation: 'different' })).toMatchObject({
    receipt: { outcome: 'not_sent', error: 'CUA_EXECUTOR_STALE_TASK' },
  })
  expect(
    await executor.execute({
      ...command(),
      observation: { ...command().observation, captured_at: -100_000 },
    }),
  ).toMatchObject({ receipt: { outcome: 'not_sent', error: 'OBSERVATION_EXPIRED' } })
  expect(
    await executor.execute({
      ...command(),
      observation: { ...command().observation, captured_at: 1001 },
    }),
  ).toMatchObject({ receipt: { outcome: 'not_sent', error: 'OBSERVATION_EXPIRED' } })
  expect(mouse.execute).not.toHaveBeenCalled()
})

it('rejects coordinates, invalid steps and unknown actions rather than expanding the mouse API', async () => {
  const { executor, mouse, fallback } = await setup()
  for (const action of [
    { action: 'click', target_id: 1, x: 500 },
    { action: 'scroll', target_id: 1, steps: 0 },
    { action: 'scroll', target_id: 1, steps: 33 },
    { action: 'scroll', target_id: 1, steps: 1.5 },
    { action: 'click', target_id: -1 },
    { action: 'shell', command: 'dangerous' },
  ])
    expect(await executor.execute({ ...command(), action })).toMatchObject({
      receipt: { outcome: 'not_sent' },
    })
  expect(mouse.execute).not.toHaveBeenCalled()
  expect(fallback.execute).not.toHaveBeenCalled()
})

it('checks the foreground guard again after durable dispatch recording', async () => {
  const guard = vi
    .fn()
    .mockResolvedValueOnce({ allowed: true })
    .mockResolvedValueOnce({ allowed: false })
  const { executor, mouse, journalDirectory } = await setup({ guard })
  expect(await executor.execute(command())).toMatchObject({
    receipt: {
      outcome: 'not_sent',
      release_confirmed: true,
      error: 'INPUT_GUARD_CHANGED',
    },
  })
  expect(mouse.execute).not.toHaveBeenCalled()
  expect((await readdir(journalDirectory)).filter((name) => name.endsWith('.json'))).toHaveLength(2)
})

it('claims the command before input, deduplicates across restart and persists no screen contents', async () => {
  const { executor, options, mouse, journalDirectory } = await setup()
  mouse.execute.mockImplementation(async () => {
    const names = await readdir(journalDirectory)
    expect(names).toHaveLength(1)
    const marker = JSON.parse(await readFile(join(journalDirectory, names[0]), 'utf8'))
    expect(marker.receipt).toMatchObject({ outcome: 'unknown', release_confirmed: false })
    return { release_confirmed: true }
  })
  await executor.execute(command())
  expect(await executor.execute(command())).toMatchObject({ deduplicated: true })
  await executor.stop(session)
  const reopened = new CuaExecution(options)
  await reopened.begin(session)
  expect(await reopened.execute(command())).toMatchObject({
    deduplicated: true,
    receipt: { outcome: 'input_sent' },
  })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
  for (const name of await readdir(journalDirectory)) {
    const text = await readFile(join(journalDirectory, name), 'utf8')
    expect(text).not.toContain('Private screen text')
    expect(text).not.toContain('Calculate')
  }
})

it('a changed retry cannot falsely report that a successful command was not sent', async () => {
  const { executor, mouse } = await setup()
  await executor.execute(command())
  expect(
    await executor.execute({ ...command(), action: { action: 'click', target_id: 2 } }),
  ).toMatchObject({ ok: false, receipt: { outcome: 'input_sent', error: 'COMMAND_CONFLICT' } })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
})

it('does not fall back or mark released when the mouse returns release_confirmed false', async () => {
  const { executor, mouse, fallback } = await setup()
  mouse.execute.mockResolvedValue({ release_confirmed: false })
  expect(await executor.execute(command())).toMatchObject({
    ok: false,
    receipt: {
      outcome: 'unknown',
      release_confirmed: false,
    },
  })
  expect(fallback.execute).not.toHaveBeenCalled()
  expect(await executor.stop(session)).toMatchObject({ neutral: false })
  await expect(executor.begin({ task_id: 'task-2', generation: '2' })).rejects.toThrow(
    'INPUT_OUTCOME_UNKNOWN',
  )
})

it('blocks new input on restart after an unconfirmed dispatch instead of replaying', async () => {
  const { executor, options, mouse, journalDirectory } = await setup()
  mouse.execute.mockRejectedValue(new Error('DISCONNECTED'))
  expect(await executor.execute(command())).toMatchObject({ receipt: { outcome: 'unknown' } })
  const receiptName = (await readdir(journalDirectory)).find((name) =>
    name.endsWith('.receipt.json'),
  )!
  await rm(join(journalDirectory, receiptName)) // Simulate crash before completion is durable.
  const reopened = new CuaExecution(options)
  await expect(reopened.begin(session)).rejects.toThrow('INPUT_OUTCOME_UNKNOWN')
  expect(await reopened.execute(command())).toMatchObject({
    deduplicated: true,
    receipt: {
      outcome: 'unknown',
      release_confirmed: false,
    },
  })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
})

it('preserves the explicit distinction between pre-input refusal and released unknown effect', async () => {
  const { executor, mouse, fallback } = await setup()
  mouse.execute.mockRejectedValueOnce(
    Object.assign(new Error('CAPTURE_EXPIRED'), { rejectedBeforeInput: true }),
  )
  expect(await executor.execute(command())).toMatchObject({
    receipt: { outcome: 'not_sent', release_confirmed: true },
  })
  mouse.execute.mockRejectedValueOnce(
    Object.assign(new Error('EFFECT_UNKNOWN'), { releaseConfirmed: true }),
  )
  expect(await executor.execute(command('second'))).toMatchObject({
    receipt: { outcome: 'unknown', release_confirmed: true },
  })
  expect(fallback.execute).not.toHaveBeenCalled()
  expect(await executor.stop(session)).toMatchObject({ neutral: true })
})

it('rejects a second action while one is in progress, and stop cancels before dispatch', async () => {
  const barrier = deferred<void>()
  const prepared = deferred<void>()
  const { executor, mouse } = await setup({
    prepareInput: async () => {
      prepared.resolve()
      await barrier.promise
    },
  })
  const first = executor.execute(command())
  await prepared.promise
  expect(await executor.execute(command('second'))).toMatchObject({
    receipt: { outcome: 'not_sent', error: 'CUA_EXECUTOR_BUSY' },
  })
  const stopped = executor.stop(session)
  barrier.resolve()
  expect(await first).toMatchObject({ receipt: { outcome: 'not_sent', release_confirmed: true } })
  expect(await stopped).toMatchObject({ neutral: true })
  expect(mouse.execute).not.toHaveBeenCalled()
})

it('stop waits for the dispatched mouse and cannot turn an aborted unknown into neutral', async () => {
  const started = deferred<AbortSignal>()
  const settled = deferred<{ release_confirmed: boolean }>()
  const { executor } = await setup({
    mouse: {
      execute: async (_view, _action, signal) => {
        started.resolve(signal)
        return settled.promise
      },
    },
  })
  const action = executor.execute(command())
  const signal = await started.promise
  let finished = false
  const stopped = executor.stop(session).then((value) => {
    finished = true
    return value
  })
  expect(signal.aborted).toBe(true)
  await Promise.resolve()
  expect(finished).toBe(false)
  settled.resolve({ release_confirmed: false })
  expect(await action).toMatchObject({ receipt: { outcome: 'unknown', release_confirmed: false } })
  expect(await stopped).toMatchObject({ stopped: true, neutral: false })
})

it('shares an in-flight duplicate and reports a conflicting retry as unknown, never not_sent', async () => {
  const started = deferred<void>()
  const settled = deferred<{ release_confirmed: boolean }>()
  const execute = vi.fn(async () => {
    started.resolve()
    return settled.promise
  })
  const { executor } = await setup({ mouse: { execute } })
  const first = executor.execute(command())
  await started.promise
  const duplicate = executor.execute(command())
  expect(
    await executor.execute({ ...command(), action: { action: 'click', target_id: 2 } }),
  ).toMatchObject({ receipt: { outcome: 'unknown', error: 'COMMAND_CONFLICT' } })
  settled.resolve({ release_confirmed: true })
  expect(await duplicate).toEqual(await first)
  expect(execute).toHaveBeenCalledTimes(1)
})

it('cannot begin another session until fallback stop has settled', async () => {
  const { executor, fallback } = await setup()
  const barrier = deferred<{ ok: boolean; stopped: boolean; neutral: boolean }>()
  fallback.stop.mockReturnValue(barrier.promise)
  const stop = executor.stop(session)
  await expect(executor.begin({ task_id: 'task-2', generation: '2' })).rejects.toThrow(
    'CUA_EXECUTOR_BUSY',
  )
  barrier.resolve({ ok: true, stopped: true, neutral: true })
  await stop
  await expect(executor.begin({ task_id: 'task-2', generation: '2' })).resolves.toEqual({
    ok: true,
  })
})

it('fails closed on an unreadable durable record', async () => {
  const { executor, options, journalDirectory, mouse } = await setup()
  await executor.execute(command())
  const name = (await readdir(journalDirectory)).find((file) => file.endsWith('.dispatch.json'))!
  await writeFile(join(journalDirectory, name), 'partial record')
  const reopened = new CuaExecution(options)
  await expect(reopened.begin(session)).rejects.toThrow()
  expect(await reopened.execute(command())).toMatchObject({
    receipt: {
      outcome: 'unknown',
      release_confirmed: false,
      journal_error: 'CUA_JOURNAL_UNAVAILABLE',
    },
  })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
})

it('retains the fallback receipt when keyboard input has an unknown outcome', async () => {
  const { executor, fallback, mouse } = await setup()
  const failure = Object.assign(new Error('RK_DISCONNECTED'), {
    receipt: { outcome: 'unknown', release_confirmed: false },
  })
  fallback.execute.mockRejectedValue(failure)
  await expect(
    executor.execute({ ...command(), action: { action: 'paste', target_id: 1, text: '正文' } }),
  ).rejects.toBe(failure)
  expect(await executor.execute(command('mouse-after-unknown'))).toMatchObject({
    receipt: { outcome: 'not_sent', error: 'INPUT_OUTCOME_UNKNOWN' },
  })
  expect(mouse.execute).not.toHaveBeenCalled()
})

it('does not send when the dispatch journal becomes unwritable', async () => {
  const { executor, journalDirectory, mouse } = await setup()
  await rm(journalDirectory, { recursive: true })
  await writeFile(journalDirectory, 'not a directory')
  expect(await executor.execute(command())).toMatchObject({
    ok: false,
    receipt: {
      journal_error: 'CUA_JOURNAL_UNAVAILABLE',
    },
  })
  expect(mouse.execute).not.toHaveBeenCalled()
})

it('preserves input_sent but marks journal failure and blocks further input after receipt write fails', async () => {
  const { executor, journalDirectory, mouse } = await setup()
  mouse.execute.mockImplementation(async () => {
    const dispatch = (await readdir(journalDirectory)).find((name) =>
      name.endsWith('.dispatch.json'),
    )!
    await mkdir(join(journalDirectory, dispatch.replace('.dispatch.json', '.receipt.json')))
    return { release_confirmed: true }
  })
  expect(await executor.execute(command())).toMatchObject({
    ok: false,
    receipt: {
      outcome: 'input_sent',
      release_confirmed: true,
      journal_error: 'CUA_JOURNAL_UNAVAILABLE',
    },
  })
  expect(await executor.execute(command('next'))).toMatchObject({
    receipt: {
      outcome: 'not_sent',
      error: 'INPUT_OUTCOME_UNKNOWN',
    },
  })
  expect(mouse.execute).toHaveBeenCalledTimes(1)
})
