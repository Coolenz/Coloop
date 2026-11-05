import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudHIDRelay, browserSteps, isBrowserPilot } from '../src/main/services/cloud-hid-relay'
import { CloudGateway } from '../src/main/infrastructure/cloud'

const directories: string[] = []
afterEach(async () => {
  for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true })
})
const signal = new AbortController().signal
it('network-only forwarding leaves semantic JSON validation to the RK Agent', async () => {
  const payload = '{"command":"click","command":"invalid duplicate"}'
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: payload } }] }),
      ),
  )
  const gateway = new CloudGateway(fetcher as typeof fetch)
  const config = {
    name: 'test',
    protocol: 'openai' as const,
    baseUrl: 'https://example.com/v1',
    model: 'test',
  }
  await expect(gateway.relayText(config, 'dummy', 'RK policy', 'RK context', signal)).resolves.toBe(
    payload,
  )
  await expect(gateway.relay(config, 'dummy', 'RK policy', 'RK context', signal)).rejects.toThrow()
})
it('admits only the browser pilot, never trailing instructions or arbitrary URLs', () => {
  for (const t of ['打开 Bilibili', '帮我在电脑上打开谷歌浏览器，然后进入Bilibili网站', '打开B站'])
    expect(isBrowserPilot(t)).toBe(true)
  for (const t of [
    '打开Bilibili并登录',
    '打开Bilibili https://evil.test',
    '不要打开Bilibili',
    '打开QQ',
  ])
    expect(isBrowserPilot(t)).toBe(false)
})
it('admits the user-authorized triple task while rejecting additional account operations', () => {
  expect(isBrowserPilot('打开bilibili，点击主页的一个任意视频，然后三连点赞')).toBe(true)
  expect(isBrowserPilot('打开bilibili，点击主页的一个任意视频，然后三连点赞并关注')).toBe(false)
})
it('learns only after verified execution, and reuses the exact procedure with fresh cloud planning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-'))
  directories.push(directory)
  const rk = vi.fn(async () => JSON.stringify({ macro: 'chrome_bilibili_mouse_v1' }))
  const cloud = vi.fn(async (_s, content) =>
    JSON.parse(content).stage === 'plan'
      ? { command: 'open_browser', url: 'https://www.bilibili.com', method: 'mouse_same_window' }
      : { summary: '实际打开Chrome并核验首页。', lessons: ['每次重新检查窗口。'] },
  )
  const relay = new CloudHIDRelay({ directory, cloud, rk })
  expect(await relay.call('plan', '打开 Bilibili', {}, signal)).toMatchObject({
    translationSource: 'rk_model_template',
  })
  await expect(readFile(join(directory, 'open-bilibili-mouse.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(relay.call('review', '打开 Bilibili', { verified: false }, signal)).rejects.toThrow()
  await relay.call(
    'review',
    '打开 Bilibili',
    { verified: true, elapsedMs: 123, receipts: [1, 2, 3, 4], observation: {} },
    signal,
  )
  expect(await relay.call('plan', '打开 Bilibili', {}, signal)).toMatchObject({
    translationSource: 'verified_procedure',
  })
  expect(rk).toHaveBeenCalledTimes(1)
  expect(JSON.parse(cloud.mock.calls.at(-1)![1]).previous[0].reviewVerified).toBe(false)
})
it('rejects wrong cloud target or modified RK command without repairing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-'))
  directories.push(directory)
  const rk = vi.fn(async () =>
    JSON.stringify([...browserSteps, { action: 'hotkey', keys: 'ENTER' }]),
  )
  const relay = new CloudHIDRelay({
    directory,
    rk,
    cloud: async () => ({
      command: 'open_browser',
      url: 'https://www.bilibili.com',
      method: 'mouse_same_window',
    }),
  })
  await expect(relay.call('plan', '打开B站', {}, signal)).rejects.toThrow('TRANSLATION_REJECTED')
  const wrong = new CloudHIDRelay({
    directory,
    rk,
    cloud: async () => ({ command: 'open_browser', url: 'https://evil.test' }),
  })
  await expect(wrong.call('plan', '打开B站', {}, signal)).rejects.toThrow()
  expect(rk).toHaveBeenCalledTimes(1)
})
it('strict cloud channel rejects truncated JSON even when the JSON text itself parses', async () => {
  const fetcher = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: 'length', message: { content: '{"command":"open_browser"}' } },
          ],
        }),
      ),
  )
  const gateway = new CloudGateway(fetcher as typeof fetch)
  await expect(
    gateway.relay(
      { name: 'test', protocol: 'openai', baseUrl: 'https://example.com/v1', model: 'test' },
      'dummy',
      'policy',
      '{}',
      signal,
    ),
  ).rejects.toThrow()
  const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
  expect(body.messages[0].content).toBe('policy')
  expect(body.stream).toBe(false)
})
