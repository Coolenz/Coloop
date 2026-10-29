import { generateKeyPairSync } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { Server, utils } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardGateway, fingerprintOf } from '../src/main/infrastructure/board'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs1' },
  publicKeyEncoding: { format: 'pem', type: 'pkcs1' },
})
const key = utils.parseKey(privateKey)
if (key instanceof Error || Array.isArray(key)) throw new Error('Cannot generate SSH fixture')
const fingerprint = fingerprintOf(key.getPublicSSH())
const apiKey = 'fixture-local-key-that-must-stay-out-of-device-state'
const health = {
  hostname: 'fixture-board',
  chip: 'rk3588',
  memoryTotalMb: 16000,
  memoryAvailableMb: 14000,
  temperatureC: 40,
  uptimeSeconds: 100,
}
const modelHealth = {
  ready: true,
  model: 'qwen35-4b-rkllm',
  context: 16384,
  runtime: '1.3.0',
  cache_mode: 'native',
  worker_protocol: 2,
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function answer(response: ServerResponse, content = '五。已收到中文参考文本。') {
  reply(response, 200, {
    model: modelHealth.model,
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  })
}

type ChatBody = {
  model: string
  messages: { role: string; content: string }[]
  stream: boolean
  max_tokens: number
  tools: unknown[]
  tool_choice: string
}

async function fixture(
  options: {
    online?: boolean
    modelHealth?: Record<string, unknown>
    healthStatus?: number
    startSucceeds?: boolean
    chat?: (body: ChatBody, response: ServerResponse, request: IncomingMessage) => void
  } = {},
) {
  let authentications = 0
  let modelOnline = options.online ?? true
  let holdHealth = false
  const requests: { url: string; authorization?: string; body?: ChatBody }[] = []
  const chatStarted = deferred<ServerResponse>()
  const healthStarted = deferred<ServerResponse>()
  const service = createServer(async (request, response) => {
    const url = request.url ?? ''
    const record: (typeof requests)[number] = {
      url,
      authorization: request.headers.authorization,
    }
    requests.push(record)
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      reply(response, 401, { error: { message: 'Invalid fixture API key' } })
      return
    }
    if (url === '/health') {
      if (holdHealth) {
        healthStarted.resolve(response)
        return
      }
      reply(response, options.healthStatus ?? 200, options.modelHealth ?? modelHealth)
      return
    }
    if (url !== '/v1/chat/completions' || request.method !== 'POST') {
      reply(response, 404, { error: { message: 'Unknown fixture endpoint' } })
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw) as ChatBody
    record.body = body
    chatStarted.resolve(response)
    if (options.chat) options.chat(body, response, request)
    else answer(response)
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => {
    service.closeAllConnections()
    service.close()
  })
  const serviceAddress = service.address()
  if (typeof serviceAddress !== 'object' || !serviceAddress) throw new Error('Missing service port')

  const commands: string[] = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    cleanup.push(() => client.end())
    client.on('error', () => {})
    client.on('authentication', (context) => {
      authentications++
      context.method === 'password' && context.password === 'test-password'
        ? context.accept()
        : context.reject()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          const encoded = info.command.match(/b64decode\(['"]([A-Za-z0-9+/=]+)['"]\)/)?.[1]
          const script = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : info.command
          commands.push(script)
          if (script.includes('scripts/start.sh') && options.startSucceeds) modelOnline = true
          const result = script.includes('scripts/start.sh')
            ? '{}'
            : script.includes('/proc/meminfo')
              ? JSON.stringify(health)
              : script.includes('api-key')
                ? apiKey
                : JSON.stringify({ ready: true, active_sessions: 0 })
          stream.write(result + '\n')
          stream.exit(0)
          stream.end()
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        if (!modelOnline || info.destIP !== '127.0.0.1' || info.destPort !== 8088) {
          reject()
          return
        }
        const socket = connectSocket(serviceAddress.port, '127.0.0.1', () => {
          const channel = accept()
          channel.pipe(socket).pipe(channel)
          channel.on('error', () => socket.destroy())
          channel.on('close', () => socket.destroy())
          socket.on('close', () => channel.close())
        })
        socket.on('error', () => reject())
        cleanup.push(() => socket.destroy())
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('Missing SSH port')
  return {
    config: {
      host: '127.0.0.1',
      port: address.port,
      username: 'cat',
      fingerprint,
      serviceDirectory: '/home/cat/rk-opencode',
      servicePort: 8088,
    },
    authentications: () => authentications,
    requests,
    commands,
    chatStarted: chatStarted.promise,
    healthStarted: healthStarted.promise,
    holdHealth(value: boolean) {
      holdHealth = value
    },
    setOnline(value: boolean) {
      modelOnline = value
    },
  }
}

function gateway() {
  const instance = new BoardGateway(vi.fn())
  cleanup.push(() => instance.disconnect())
  return instance
}

describe('SSH identity and tunneled RK model service', () => {
  it('reads real board health and authenticated model readiness through pinned SSH', async () => {
    const { config, requests } = await fixture()
    const device = gateway()
    const state = await device.connect(config, 'test-password')
    expect(state).toMatchObject({
      status: 'connected',
      hostname: 'fixture-board',
      temperatureC: 40,
      qwenReady: true,
      model: 'qwen35-4b-rkllm',
      modelContext: 16384,
      modelRuntime: '1.3.0',
      modelServiceStatus: 'ready',
    })
    expect(requests.find((request) => request.url === '/health')?.authorization).toBe(
      `Bearer ${apiKey}`,
    )
    expect(JSON.stringify(state)).not.toContain(apiKey)
    expect(JSON.stringify(device.state)).not.toContain(apiKey)
    device.disconnect()
    expect(device.state.status).toBe('disconnected')
  })

  it('refuses a substituted host before transmitting the password', async () => {
    const { config, authentications, requests } = await fixture()
    const device = gateway()
    await expect(
      device.connect({ ...config, fingerprint: 'A'.repeat(43) }, 'test-password'),
    ).rejects.toThrow('设备指纹不匹配')
    expect(authentications()).toBe(0)
    expect(requests).toHaveLength(0)
    expect(device.state.status).toBe('error')
  })

  it('keeps SSH connected when the optional model service is stopped', async () => {
    const { config, setOnline } = await fixture({ online: false })
    const device = gateway()
    const state = await device.connect(config, 'test-password')
    expect(state).toMatchObject({
      status: 'connected',
      hostname: 'fixture-board',
      qwenReady: false,
      modelServiceStatus: 'stopped',
    })
    setOnline(true)
    expect(await device.refresh()).toMatchObject({
      status: 'connected',
      qwenReady: true,
      modelServiceStatus: 'ready',
    })
  })

  it.each([
    { ready: false },
    { model: 'unrelated-model' },
    { context: 512 },
    { worker_protocol: 1 },
  ])('does not call an incompatible service ready: %j', async (override) => {
    const { config } = await fixture({ modelHealth: { ...modelHealth, ...override } })
    const device = gateway()
    const state = await device.connect(config, 'test-password')
    expect(state.status).toBe('connected')
    expect(state.qwenReady).toBe(false)
    expect(state.modelServiceStatus).not.toBe('ready')
  })

  it('sends Chinese task/context as text and returns only the actual assistant answer', async () => {
    const { config, requests, commands } = await fixture()
    const device = gateway()
    await device.connect(config, 'test-password')
    const onText = vi.fn()
    const result = await device.generate(
      '请概括订单，并计算2+3。',
      '订单编号：中文测试-08；金额128.50元。',
      new AbortController().signal,
      onText,
    )
    const body = requests.find((request) => request.url === '/v1/chat/completions')?.body
    expect(body).toMatchObject({
      model: 'qwen35-4b-rkllm',
      max_tokens: 512,
      stream: false,
      tools: [],
      tool_choice: 'none',
    })
    const text = body?.messages.map((message) => message.content).join('\n')
    expect(text).toContain('请概括订单，并计算2+3。')
    expect(text).toContain('订单编号：中文测试-08；金额128.50元。')
    expect(result).toBe('五。已收到中文参考文本。')
    expect(onText).toHaveBeenLastCalledWith(result)
    expect(commands.join('\n')).not.toContain('qwen35/run.sh')
  })

  it.each([429, 503])('surfaces HTTP %i as a failed model request', async (status) => {
    const { config } = await fixture({
      chat: (_body, response) => reply(response, status, { error: { message: 'Model busy' } }),
    })
    const device = gateway()
    await device.connect(config, 'test-password')
    const onText = vi.fn()
    await expect(
      device.generate('测试', '', new AbortController().signal, onText),
    ).rejects.toThrow()
    expect(onText).not.toHaveBeenCalled()
    expect(JSON.stringify(device.state)).not.toContain(apiKey)
  })

  it('does not publish a late answer after cancellation', async () => {
    const { config, chatStarted } = await fixture({ chat: () => {} })
    const device = gateway()
    await device.connect(config, 'test-password')
    const controller = new AbortController()
    const onText = vi.fn()
    const generated = device.generate('慢任务', '', controller.signal, onText)
    const rejected = expect(generated).rejects.toMatchObject({ name: 'AbortError' })
    const response = await chatStarted
    controller.abort()
    await rejected
    answer(response, '取消后才返回的答案')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(onText).not.toHaveBeenCalled()
    expect(device.state.status).toBe('connected')
  })

  it('fails an outstanding model request when the SSH connection is disconnected', async () => {
    const { config, chatStarted } = await fixture({ chat: () => {} })
    const device = gateway()
    await device.connect(config, 'test-password')
    const onText = vi.fn()
    const generated = device.generate('慢任务', '', new AbortController().signal, onText)
    const rejected = expect(generated).rejects.toThrow()
    await chatStarted
    device.disconnect()
    await rejected
    expect(onText).not.toHaveBeenCalled()
    expect(device.state.status).toBe('disconnected')
  })

  it('reports a transport failure when a disconnected board is queried', async () => {
    await expect(gateway().refresh()).rejects.toThrow('请先')
  })

  it('does not restore connected state when a refresh finishes after disconnect', async () => {
    const board = await fixture()
    const device = gateway()
    await device.connect(board.config, 'test-password')
    board.holdHealth(true)
    const refreshing = device.refresh()
    const rejected = expect(refreshing).rejects.toThrow()
    const response = await board.healthStarted
    device.disconnect()
    await rejected
    reply(response, 200, modelHealth)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(device.state.status).toBe('disconnected')
  })

  it('does not let an old refresh overwrite a reconnected session', async () => {
    const board = await fixture()
    const device = gateway()
    await device.connect(board.config, 'test-password')
    board.holdHealth(true)
    const refreshing = device.refresh()
    const rejected = expect(refreshing).rejects.toThrow()
    const response = await board.healthStarted
    board.holdHealth(false)
    board.setOnline(false)
    const reconnected = device.connect(board.config, 'test-password')
    await rejected
    expect(await reconnected).toMatchObject({ status: 'connected', qwenReady: false })
    reply(response, 200, modelHealth)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(device.state).toMatchObject({
      status: 'connected',
      qwenReady: false,
      modelServiceStatus: 'stopped',
    })
  })

  it('rejects oversized Chinese input by UTF-8 budget before submitting inference', async () => {
    const { config, requests } = await fixture()
    const device = gateway()
    await device.connect(config, 'test-password')
    const onText = vi.fn()
    await expect(
      device.generate('中'.repeat(5500), '', new AbortController().signal, onText),
    ).rejects.toThrow(/预算|UTF-8/)
    expect(requests.filter((request) => request.url === '/v1/chat/completions')).toHaveLength(0)
    expect(onText).not.toHaveBeenCalled()
  })

  it.each([
    { message: { content: '   ' }, finish_reason: 'stop' },
    { message: { content: '被截断的答案' }, finish_reason: 'length' },
    {
      message: { content: '不应执行工具', tool_calls: [{ function: { name: 'desktop' } }] },
      finish_reason: 'tool_calls',
    },
  ])('rejects empty, truncated or tool-only answers: %j', async (choice) => {
    const { config } = await fixture({
      chat: (_body, response) =>
        reply(response, 200, { model: modelHealth.model, choices: [choice] }),
    })
    const device = gateway()
    await device.connect(config, 'test-password')
    const onText = vi.fn()
    await expect(
      device.generate('测试', '', new AbortController().signal, onText),
    ).rejects.toThrow()
    expect(onText).not.toHaveBeenCalled()
  })

  it('reuses an already ready model service without running a startup command', async () => {
    const { config, commands } = await fixture()
    const device = gateway()
    await device.connect(config, 'test-password')
    expect(await device.startModelService()).toMatchObject({ qwenReady: true })
    expect(commands.some((command) => command.includes('scripts/start.sh'))).toBe(false)
  })

  it('starts an installed idle service and checks its HTTP readiness again', async () => {
    const { config, commands } = await fixture({ online: false, startSucceeds: true })
    const device = gateway()
    await device.connect(config, 'test-password')
    expect(await device.startModelService()).toMatchObject({
      status: 'connected',
      qwenReady: true,
      modelServiceStatus: 'ready',
    })
    const startup = commands.filter((command) => command.includes('scripts/start.sh'))
    expect(startup).toHaveLength(1)
    expect(startup[0]).toContain('qwen35-4b')
    expect(startup[0]).toContain('Existing bridge process')
  })
})
