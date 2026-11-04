import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSettings } from '../src/main/infrastructure/connection-settings'
import { AutoConnectionService } from '../src/main/services/auto-connection'
import type { BoardConfig, DeviceState } from '../src/shared/contracts'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const config: BoardConfig = {
  host: '127.0.0.1',
  port: 22,
  username: 'tester',
  fingerprint: 'A'.repeat(43),
}
const codec = {
  encrypt: (text: string) => Buffer.from(text).toString('base64'),
  decrypt: (text: string) => Buffer.from(text, 'base64').toString(),
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coloop-auto-'))
  directories.push(directory)
  const settings = new ConnectionSettings(directory, codec)
  let state: DeviceState = { status: 'disconnected' },
    now = 100000
  const connect = vi.fn(async (_password: string) => {
    state = { status: 'connected', qwenReady: true, modelPrivacyReady: true }
    return state
  })
  const startModel = vi.fn(async () => {
    state = { status: 'connected', qwenReady: true, modelPrivacyReady: true }
  })
  const canAttempt = vi.fn(() => true)
  const service = new AutoConnectionService({
    settings,
    config: () => config,
    state: () => state,
    connect,
    startModel,
    canAttempt,
    now: () => now,
    onChange: vi.fn(),
  })
  return {
    directory,
    settings,
    connect,
    startModel,
    canAttempt,
    service,
    setState: (value: DeviceState) => {
      state = value
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}
describe('automatic connection and credential binding', () => {
  it('stores only a protected credential bound to host identity and reconnects after restart', async () => {
    const f = fixture()
    await f.service.connectManually('synthetic-password')
    expect(readFileSync(join(f.directory, 'auto-connection.json'), 'utf8')).not.toContain(
      'synthetic-password',
    )
    const restored = new ConnectionSettings(f.directory, codec)
    expect(restored.password(config)).toBe('synthetic-password')
    expect(restored.password({ ...config, host: 'other-host' })).toBeUndefined()
    expect(restored.password({ ...config, fingerprint: 'B'.repeat(43) })).toBeUndefined()
    f.setState({ status: 'disconnected' })
    await f.service.tick()
    expect(f.connect).toHaveBeenCalledTimes(2)
    expect(f.service.snapshot().phase).toBe('ready')
  })
  it('retries a dropped connection with backoff without competing with active work', async () => {
    const f = fixture()
    f.settings.remember(config, 'synthetic-password')
    f.connect.mockRejectedValueOnce(new Error('USB disconnected'))
    await f.service.tick()
    expect(f.service.snapshot().phase).toBe('waiting')
    await f.service.tick()
    expect(f.connect).toHaveBeenCalledOnce()
    f.advance(1000)
    f.canAttempt.mockReturnValue(false)
    await f.service.tick()
    expect(f.connect).toHaveBeenCalledOnce()
    f.canAttempt.mockReturnValue(true)
    await f.service.tick()
    expect(f.connect).toHaveBeenCalledTimes(2)
    expect(f.service.snapshot().phase).toBe('ready')
  })
  it('starts the already installed model after SSH recovery and never resumes a desktop task', async () => {
    const f = fixture()
    f.settings.remember(config, 'synthetic-password')
    f.setState({ status: 'connected', qwenReady: false, modelPrivacyReady: false })
    await f.service.tick()
    expect(f.startModel).toHaveBeenCalledOnce()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.service.snapshot().phase).toBe('ready')
  })
  it('returns the SSH connection while local model startup is still pending', async () => {
    const f = fixture()
    f.connect.mockImplementationOnce(async () => {
      const connected: DeviceState = { status: 'connected', qwenReady: false }
      f.setState(connected)
      return connected
    })
    let finish!: () => void
    f.startModel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const connected = await f.service.connectManually('synthetic-password')
    expect(connected.status).toBe('connected')
    expect(connected.qwenReady).toBe(false)
    expect(f.service.snapshot().phase).toBe('ready')
    expect(f.startModel).toHaveBeenCalledOnce()
    finish()
    await f.service.tick()
  })
  it('retries local model failure independently of the usable SSH connection', async () => {
    const f = fixture()
    f.setState({ status: 'connected', qwenReady: false, modelPrivacyReady: false })
    f.startModel.mockRejectedValueOnce(new Error('model unavailable'))
    await f.service.tick()
    expect(f.service.snapshot()).toMatchObject({ phase: 'ready', attempts: 0 })
    await f.service.tick()
    expect(f.startModel).toHaveBeenCalledOnce()
    expect(f.connect).not.toHaveBeenCalled()
    f.advance(30000)
    await f.service.tick()
    expect(f.startModel).toHaveBeenCalledTimes(2)
    expect(f.service.snapshot().phase).toBe('ready')
  })
  it('an explicit disconnect remains disabled and does not fight a pending attempt', async () => {
    const f = fixture()
    f.settings.remember(config, 'synthetic-password')
    let finish!: (state: DeviceState) => void
    f.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = f.service.tick()
    await f.service.tick()
    expect(f.connect).toHaveBeenCalledOnce()
    f.service.disable()
    finish({ status: 'connected', qwenReady: false })
    await pending
    await f.service.tick()
    expect(f.startModel).not.toHaveBeenCalled()
    expect(f.service.snapshot().phase).toBe('disabled')
  })
  it('shows first-time setup rather than silently retrying missing credentials', async () => {
    const f = fixture()
    await f.service.tick()
    expect(f.service.snapshot().phase).toBe('needs_setup')
    expect(f.connect).not.toHaveBeenCalled()
  })
})
