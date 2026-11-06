import { Duplex } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RkTarsBridge, rkMemoryNamespace } from '../src/main/infrastructure/rk-tars-bridge'
import { DesktopPipeError } from '../src/main/infrastructure/desktop-pipe'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(namespace?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'coloop-tars-bridge-'))
  await writeFile(join(dir, 'support.py'), 'class Agent: pass')
  await writeFile(join(dir, 'executor.py'), '# executor')
  await writeFile(join(dir, 'memory.py'), '# memory')
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const received: any[] = [],
    sources: string[] = [],
    channels: Duplex[] = []
  const input = vi.fn(async () => ({ allowed: true }))
  const clipboard = vi.fn(async () => ({ allowed: true, lease_id: 'lease', status: 'restored' }))
  const onMemorySaved = vi.fn()
  const releaseClipboard = vi.fn(async () => {})
  const prepareInput = vi.fn(async () => {})
  const bridge = new RkTarsBridge({
    namespace,
    supportScript: join(dir, 'support.py'),
    executorScript: join(dir, 'executor.py'),
    memoryScript: join(dir, 'memory.py'),
    input,
    clipboard,
    releaseClipboard,
    prepareInput,
    onMemorySaved,
    openRuntime: async (source) => {
      sources.push(source)
      const memory = source.endsWith('# memory')
      const channel = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const packet = JSON.parse(chunk.toString())
          received.push(packet)
          if (packet.type === 'request')
            queueMicrotask(() =>
              channel.push(
                JSON.stringify({
                  type: 'reply',
                  id: packet.id,
                  value: {
                    ok: true,
                    stopped: true,
                    neutral: true,
                    receipt: { command_id: packet.value?.command_id, outcome: 'input_sent' },
                  },
                }) + '\n',
              ),
            )
          callback()
        },
      }) as Duplex & { close(): void }
      channel.close = () => channel.push(null)
      channels.push(channel)
      setTimeout(
        () =>
          channel.push(
            JSON.stringify({
              type: 'ready',
              value: { protocol: memory ? 'coloop-rk-memory-v1' : 'coloop-rk-executor-v1' },
            }) + '\n',
          ),
        1,
      )
      return channel
    },
  })
  cleanups.push(() => bridge.dispose())
  const task = { task_id: 'task', generation: 'generation' }
  const observation = { observation_id: 'view', window_id: '1', ocr_text: 'test' }
  const execute = () =>
    bridge.execute({
      ...task,
      command_id: 'command',
      observation,
      action: { action: 'click', target_id: 1 },
    })
  const rpc = async (op: string, value: Record<string, unknown> = {}) => {
    channels[0].push(
      JSON.stringify({
        type: 'request',
        id: 'host-rpc',
        op,
        value: { ...task, observation_id: 'view', ...value },
      }) + '\n',
    )
    await vi.waitFor(() => expect(received.some((row) => row.id === 'host-rpc')).toBe(true))
    return received.splice(
      received.findIndex((row) => row.id === 'host-rpc'),
      1,
    )[0]
  }
  return {
    bridge,
    task,
    execute,
    rpc,
    input,
    clipboard,
    releaseClipboard,
    prepareInput,
    received,
    sources,
    channels,
    onMemorySaved,
  }
}

it('starts an executor without starting the memory model process and shares concurrent connect', async () => {
  const f = await fixture()
  await Promise.all([f.bridge.connect(), f.bridge.connect()])
  expect(f.sources).toHaveLength(1)
  expect(f.sources[0]).toContain("types.ModuleType('coloop_rk_support')")
  expect(f.sources[0]).toContain('os.environ[\'COLOOP_MEMORY_NAMESPACE\']="production"')
  await f.bridge.begin(f.task)
  await f.execute()
  await f.bridge.stop(f.task)
  expect(f.received.filter((row) => row.op === 'execute')).toHaveLength(1)
  await expect(f.execute()).rejects.toThrow('RK_ADAPTER_STALE_TASK')
})

it('keeps isolated profile memory stable across restart and separate from other profiles', () => {
  const profile = join(tmpdir(), 'coloop-profile-a')
  const namespace = rkMemoryNamespace(profile)
  expect(rkMemoryNamespace()).toBe('production')
  expect(namespace).toMatch(/^qa:profile:[a-f0-9]{64}$/)
  expect(rkMemoryNamespace(join(profile, 'nested', '..'))).toBe(namespace)
  expect(rkMemoryNamespace(join(tmpdir(), 'coloop-profile-b'))).not.toBe(namespace)
  if (process.platform === 'win32') expect(rkMemoryNamespace(profile.toUpperCase())).toBe(namespace)
})

it('uses the isolated profile namespace for both executor reads and queued memory writes', async () => {
  const namespace = rkMemoryNamespace(join(tmpdir(), 'coloop-memory-isolation'))
  const f = await fixture(namespace)
  await f.bridge.connect()
  await f.bridge.enqueue({ task_id: 'isolated-task', verified: true })
  expect(f.sources).toHaveLength(2)
  for (const source of f.sources) {
    expect(source).toContain(`os.environ['COLOOP_MEMORY_NAMESPACE']=${JSON.stringify(namespace)}`)
    expect(source).not.toContain('os.environ[\'COLOOP_MEMORY_NAMESPACE\']="production"')
  }
})

it('rejects cloud RPC and unbound observation requests from the executor', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  expect((await f.rpc('cloud_transport')).error).toBe('RK_ADAPTER_RPC_NOT_ALLOWED')
  expect((await f.rpc('input.guard')).error).toBe('OBSERVATION_EXPIRED')
  expect((await f.rpc('clipboard.finish', { generation: 'old-generation' })).error).toBe(
    'RK_ADAPTER_STALE_TASK',
  )
  expect(f.input).not.toHaveBeenCalled()
})

it('returns a not-sent receipt when preparation fails before the executor request', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  f.prepareInput.mockRejectedValueOnce(new Error('INDICATOR_UNAVAILABLE'))
  await expect(f.execute()).rejects.toMatchObject({
    message: 'INDICATOR_UNAVAILABLE',
    receipt: {
      ...f.task,
      command_id: 'command',
      outcome: 'not_sent',
      release_confirmed: true,
      rejected_before_input: true,
    },
  })
  expect(f.received.filter((packet) => packet.op === 'execute')).toHaveLength(0)
  await f.execute()
  expect(f.received.filter((packet) => packet.op === 'execute')).toHaveLength(1)
})

it('returns not-sent if stop wins while input preparation is pending', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  let finish!: () => void
  f.prepareInput.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const execution = f.execute()
  const rejected = expect(execution).rejects.toMatchObject({
    receipt: { outcome: 'not_sent', release_confirmed: true },
  })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await f.bridge.stop(f.task)
  finish()
  await rejected
  expect(f.received.filter((packet) => packet.op === 'execute')).toHaveLength(0)
})

it('keeps a lost post-dispatch receipt unknown instead of claiming not-sent', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  f.channels[0]._write = (chunk, _encoding, callback) => {
    const packet = JSON.parse(chunk.toString())
    f.received.push(packet)
    if (packet.op === 'execute') queueMicrotask(() => f.channels[0].push(null))
    callback()
  }
  await expect(f.execute()).rejects.not.toHaveProperty('receipt')
  expect(f.received.filter((packet) => packet.op === 'execute')).toHaveLength(1)
})

it('preserves fixed clipboard error codes across the native pipe and RK host RPC', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  await f.execute()
  f.clipboard.mockRejectedValueOnce(new DesktopPipeError('CLIPBOARD_FORMAT_UNSUPPORTED'))
  expect((await f.rpc('clipboard.prepare', { text: '中文测试' })).error).toBe(
    'CLIPBOARD_FORMAT_UNSUPPORTED',
  )
})
it('checks the target before preparing the clipboard and rechecks the lease per report', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  await f.execute()
  f.input.mockResolvedValueOnce({ allowed: false })
  expect((await f.rpc('clipboard.prepare')).error).toBe('INPUT_GUARD_CHANGED')
  expect(f.clipboard).not.toHaveBeenCalled()
  await f.rpc('input.guard', { lease_id: 'lease' })
  expect(f.clipboard).toHaveBeenCalledWith(
    'clipboard.guard',
    expect.objectContaining({ lease_id: 'lease' }),
  )
  await f.rpc('clipboard.prepare', {
    text: '甲\n乙\r\n丙\r丁',
    action: { action: 'paste', text: '甲\n乙\r\n丙\r丁' },
  })
  expect(f.clipboard).toHaveBeenCalledWith(
    'clipboard.prepare',
    expect.objectContaining({
      text: '甲\r\n乙\r\n丙\r\n丁',
      action: { action: 'paste', text: '甲\n乙\r\n丙\r丁' },
    }),
  )
})

it('rejects an in-flight guard result after stop', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  await f.execute()
  let resolve!: (value: { allowed: boolean }) => void
  f.input.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const response = f.rpc('input.guard')
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  await f.bridge.stop(f.task)
  resolve({ allowed: true })
  expect((await response).error).toBe('RK_ADAPTER_STALE_TASK')
})

it('uses a separate memory process and forwards its real save acknowledgement', async () => {
  const f = await fixture()
  await f.bridge.connect()
  await f.bridge.enqueue({ task_id: 'task', verified: true })
  expect(f.sources).toHaveLength(2)
  f.channels[1].push(
    JSON.stringify({ type: 'memory.saved', value: { task_id: 'task', saved: true } }) + '\n',
  )
  await vi.waitFor(() => expect(f.onMemorySaved).toHaveBeenCalledWith('task', true))
})
it('persists explicit preferences through the independent memory service', async () => {
  const f = await fixture()
  const value = { key: 'preference:coloop:signature', value: '署名小林', source_task_id: 'task' }
  await f.bridge.remember(value)
  expect(f.received).toContainEqual(expect.objectContaining({ op: 'memory.remember', value }))
})

it('waits for an in-flight clipboard preparation and cleans its late lease before stop completes', async () => {
  const f = await fixture()
  await f.bridge.begin(f.task)
  await f.execute()
  let finish!: (value: { allowed: boolean; lease_id: string; status: string }) => void
  f.clipboard.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const preparation = f.rpc('clipboard.prepare')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  let stopped = false
  const stopping = f.bridge.stop(f.task).then(() => {
    stopped = true
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(stopped).toBe(false)
  finish({ allowed: true, lease_id: 'late-lease', status: 'prepared' })
  await stopping
  expect(f.releaseClipboard).toHaveBeenCalledWith(f.task.task_id)
  expect((await preparation).error).toBe('RK_ADAPTER_STALE_TASK')
})
