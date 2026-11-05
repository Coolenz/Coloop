import { createServer, request as httpRequest, type ServerResponse } from 'node:http'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { mkdtemp, rm, readFile, readdir, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHarnessRuntime,
  HARNESS_VERSION,
  harnessRkResponse,
  type HarnessRuntimeOptions,
} from '../src/main/infrastructure/harness-runtime'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function reply(response: ServerResponse, delta: unknown, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [part, finish] of [
    [delta, null],
    [{}, reason],
  ])
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'response-1',
          model: 'test-model',
          object: 'chat.completion.chunk',
          created: 1,
          choices: [{ index: 0, delta: part, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }
            : {}),
        }) +
        '\n\n',
    )
  response.end('data: [DONE]\n\n')
}
async function fixture(handler: (body: any, response: ServerResponse) => void) {
  const bodies: any[] = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    bodies.push(body)
    handler(body, response)
  })
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((yes) => server.close(() => yes()))
  })
  const address = server.address() as { port: number }
  return { bodies, baseURL: `http://127.0.0.1:${address.port}/v1` }
}
async function agent(baseURL: string, extra: Partial<HarnessRuntimeOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coloop-harness-test-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const events: any[] = []
  const fetcher = vi.fn(globalThis.fetch)
  const execute = vi.fn(async (args: unknown) => args)
  const options: HarnessRuntimeOptions = {
    id: 'harness-test',
    workspace: process.cwd(),
    home,
    runtimeResources: resolve('resources/harness'),
    model: { provider: 'openai', id: 'test-model', apiKey: 'fixture-only', baseURL },
    instructions: 'Call only coloop_echo, then report its actual result.',
    maxIterations: 6,
    maxTokens: 1024,
    tools: [
      {
        name: 'coloop_echo',
        description: 'Echo a value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute,
      },
    ],
    onEvent: (event) => events.push(event),
    fetch: fetcher,
    ...extra,
  }
  const runtime = createHarnessRuntime(options)
  cleanup.push(() => runtime.dispose())
  return { runtime, home, execute, fetcher, events, options }
}

/** Exercise the actual authenticated HTTP bridge without a paid provider or
 * asking the SDK model loop to synthesize a malformed concurrent request. */
async function bridge(extra: Partial<HarnessRuntimeOptions>) {
  let env: NodeJS.ProcessEnv | undefined
  const start = HarnessClient.prototype.start
  const spy = vi.spyOn(HarnessClient.prototype, 'start').mockImplementation(function (
    this: HarnessClient,
  ) {
    // This is the same pinned SDK launch-options seam verified above. Only
    // this test runtime's generated loopback credential is captured.
    env = (this as unknown as { options: { env: NodeJS.ProcessEnv } }).options.env
    return start.call(this)
  })
  const fixture = await agent('https://fixture.invalid/v1', extra)
  try {
    await fixture.runtime.initialize()
  } finally {
    spy.mockRestore()
  }
  const url = env!.COLOOP_HARNESS_BRIDGE + '/v1/chat/completions'
  const headers = {
    authorization: `Bearer ${env!.COLOOP_HARNESS_BRIDGE_TOKEN}`,
    'content-type': 'application/json',
  }
  const body = JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'fixture' }],
  })
  return { ...fixture, url, headers, body }
}
const call = {
  role: 'assistant',
  tool_calls: [
    {
      index: 0,
      id: 'call-echo-1',
      type: 'function',
      function: { name: 'coloop_echo', arguments: '{"value":"observed"}' },
    },
  ],
}

describe('official DeepSeek Harness integration', () => {
  it('cancels a disconnected model request and rejects overlapping retries until it settles', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => {
      release = resolve
    })
    let signal: AbortSignal | undefined
    const upstream = vi.fn(async (_input, init) => {
      signal = init?.signal as AbortSignal
      entered()
      // Deliberately ignore abort to model a provider transport still settling.
      return delayed
    })
    const target = await bridge({ fetch: upstream as typeof fetch })
    const first = httpRequest(target.url, { method: 'POST', headers: target.headers })
    first.on('error', () => {})
    first.end(target.body)
    await started
    const overlap = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: target.body,
    })
    expect(overlap.status).toBe(409)
    expect(await overlap.json()).toMatchObject({
      error: { message: 'HARNESS_MODEL_REQUEST_IN_PROGRESS' },
    })
    expect(upstream).toHaveBeenCalledTimes(1)
    first.destroy()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    const retry = await fetch(target.url, {
      method: 'POST',
      headers: target.headers,
      body: target.body,
    })
    expect(retry.status).toBe(409)
    await retry.arrayBuffer()
    expect(upstream).toHaveBeenCalledTimes(1)
    release(new Response('cancelled before headers'))
  }, 120_000)

  it('cancels the provider body when its downstream streaming consumer disconnects', async () => {
    let signal: AbortSignal | undefined
    const cancelled = vi.fn()
    const upstream = vi.fn(async (_input, init) => {
      signal = init?.signal as AbortSignal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: fixture\n\n'))
          },
          cancel: cancelled,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const target = await bridge({ fetch: upstream as typeof fetch })
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        target.url,
        { method: 'POST', headers: target.headers },
        (response) => {
          response.once('data', () => {
            response.destroy()
            resolve()
          })
        },
      )
      request.on('error', reject)
      request.end(target.body)
    })
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true)
      expect(cancelled).toHaveBeenCalledTimes(1)
    })
    expect(upstream).toHaveBeenCalledTimes(1)
  }, 120_000)

  it('uses the exact SDK and CLI versions required by the executable injection seam', () => {
    const require = createRequire(import.meta.url)
    expect(require('@deepseek-ai/dsh-sdk-client/package.json').version).toBe(HARNESS_VERSION)
    expect(require('@deepseek-ai/dsh/package.json').version).toBe(HARNESS_VERSION)
  })

  it('runs the installed official SDK loop, constrained tool and host model transport', async () => {
    const api = await fixture((body, response) =>
      reply(
        response,
        body.messages.some((message: any) => message.role === 'tool')
          ? { content: 'Verified: observed' }
          : call,
        body.messages.some((message: any) => message.role === 'tool') ? 'stop' : 'tool_calls',
      ),
    )
    const { runtime, execute, fetcher, events } = await agent(api.baseURL)
    const result = await runtime.run('Echo observed.')
    expect(result).toEqual({ content: 'Verified: observed', finishReason: 'stop' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(api.bodies[0].tools.map((tool: any) => tool.function.name)).toEqual(['coloop_echo'])
    expect(events.some((event) => event.type === 'tool_call' && event.name === 'coloop_echo')).toBe(
      true,
    )
  }, 120_000)

  it.each([
    '<tool_call>{"name":"coloop_echo","parameters":{"value":"x"}}}</tool_call>',
    '<tool_call>{"name":"coloop_echo","parameters":{"value":"x"}}</tool_call><tool_call>{"name":"coloop_echo","parameters":{"value":"y"}}</tool_call>',
    '<tool_call>{"name":"coloop_echo","parameters":',
    '<tool_call>{"name":"coloop_echo","parameters":{},"arguments":{"value":"conflict"}}</tool_call>',
  ])(
    'rejects an entire invalid RK reply before emitting any partial tool call: %s',
    async (answer) => {
      const response = new Response(
        'data: ' +
          JSON.stringify({ choices: [{ delta: { content: answer } }] }) +
          '\n\ndata: [DONE]\n\n',
      )
      const result = await harnessRkResponse(response)
      expect(result.status).toBe(400)
      expect(await result.json()).toMatchObject({
        error: { code: 'HARNESS_RK_TOOL_ENVELOPE_INVALID' },
      })
    },
  )

  it('regenerates malformed local syntax once through the metered transport before dispatching', async () => {
    let attempts = 0
    const api = await fixture((body, response) => {
      attempts++
      const hasResult = body.messages.some((m: any) => m.content.includes('Tool: coloop_echo'))
      reply(response, {
        content: hasResult
          ? 'Verified: observed'
          : attempts === 1
            ? '<tool_call>{"name":"coloop_echo","parameters":{"value":"rejected"}}}</tool_call>'
            : '<tool_call>{"name":"coloop_echo","parameters":{"value":"observed"}}</tool_call>',
      })
    })
    const { runtime, execute, fetcher, events } = await agent(api.baseURL, {
      historyBoundary: 'local',
      model: {
        provider: 'openai',
        id: 'test-model',
        apiKey: 'fixture-only',
        baseURL: api.baseURL,
        toolCallEngine: 'prompt_engineering',
      },
    })
    expect((await runtime.run('Echo actual result.')).finishReason).toBe('stop')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'observed' }, expect.anything())
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(
      api.bodies[1].messages.some(
        (m: any) => m.role === 'system' && m.content.includes('未执行任何工具'),
      ),
    ).toBe(true)
    expect(JSON.stringify(api.bodies[1])).not.toContain('"rejected"')
    expect(events.filter((e) => e.type === 'coloop_local_protocol_retry')).toHaveLength(1)
  }, 120_000)

  it.each([1, 6])(
    'stops invalid local syntax within the %i-request budget without SDK retry or input',
    async (maxIterations) => {
      const api = await fixture((_body, response) =>
        reply(response, {
          content: '<tool_call>{"name":"coloop_echo","parameters":{"value":"x"}}}</tool_call>',
        }),
      )
      const { runtime, execute, fetcher } = await agent(api.baseURL, {
        maxIterations,
        historyBoundary: 'local',
        model: {
          provider: 'openai',
          id: 'test-model',
          apiKey: 'fixture-only',
          baseURL: api.baseURL,
          toolCallEngine: 'prompt_engineering',
        },
      })
      expect((await runtime.run('Reject invalid syntax.')).finishReason).toBe('error')
      expect(fetcher).toHaveBeenCalledTimes(maxIterations === 1 ? 1 : 2)
      expect(execute).not.toHaveBeenCalled()
    },
    120_000,
  )

  it('never regenerates remote output even when that route uses the text tool protocol', async () => {
    const api = await fixture((_body, response) =>
      reply(response, {
        content: '<tool_call>{"name":"coloop_echo","parameters":{}}}</tool_call>',
      }),
    )
    const { runtime, fetcher, execute } = await agent(api.baseURL, {
      historyBoundary: 'remote',
      model: {
        provider: 'openai',
        id: 'test-model',
        apiKey: 'fixture-only',
        baseURL: api.baseURL,
        toolCallEngine: 'prompt_engineering',
      },
    })
    expect((await runtime.run('Reject malformed remote output.')).finishReason).toBe('error')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  }, 120_000)

  it('does not enter a second transport when stopped at the local regeneration boundary', async () => {
    const api = await fixture((_body, response) =>
      reply(response, {
        content: '<tool_call>{"name":"coloop_echo","parameters":{}}}</tool_call>',
      }),
    )
    let active: ReturnType<typeof createHarnessRuntime>
    const { runtime, fetcher, execute } = await agent(api.baseURL, {
      historyBoundary: 'local',
      model: {
        provider: 'openai',
        id: 'test-model',
        apiKey: 'fixture-only',
        baseURL: api.baseURL,
        toolCallEngine: 'prompt_engineering',
      },
      onEvent: (event) => {
        if (event.type === 'coloop_local_protocol_retry') active.abort()
      },
    })
    active = runtime
    expect((await runtime.run('Stop before regeneration.')).finishReason).toBe('abort')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  }, 120_000)

  it('keeps the text-only RK request protocol and parses its tool reply through Harness', async () => {
    const api = await fixture((body, response) => {
      expect(body.tools).toBeUndefined()
      expect(
        body.messages.every(
          (message: any) =>
            ['system', 'user', 'assistant'].includes(message.role) &&
            typeof message.content === 'string',
        ),
      ).toBe(true)
      const hasResult = body.messages.some((message: any) =>
        message.content.startsWith('Tool: coloop_echo'),
      )
      reply(response, {
        content: hasResult
          ? '本地核验完成'
          : '<tool_call>{"name":"coloop_echo","parameters":{"value":"observed"}}</tool_call>',
      })
    })
    const { runtime, execute } = await agent(api.baseURL, {
      model: {
        provider: 'openai',
        id: 'test-model',
        apiKey: 'fixture-only',
        baseURL: api.baseURL,
        toolCallEngine: 'prompt_engineering',
      },
    })
    expect((await runtime.run('执行本地工具')).content).toBe('本地核验完成')
    expect(execute).toHaveBeenCalledTimes(1)
  }, 120_000)

  it('keeps completion checking inside the official turn-stopping extension', async () => {
    let checked = 0
    const api = await fixture((_body, response) =>
      reply(response, { content: 'An answer is not proof.' }),
    )
    const { runtime } = await agent(api.baseURL, {
      completion: () => ({ finished: ++checked > 1, message: 'Actual proof is still missing.' }),
    })
    expect((await runtime.run('Complete and verify')).finishReason).toBe('stop')
    expect(api.bodies).toHaveLength(2)
    expect(JSON.stringify(api.bodies[1])).toContain('Actual proof is still missing.')
  }, 120_000)

  it('refuses unregistered tools and validates arguments before the host body', async () => {
    let index = 0
    const api = await fixture((_body, response) => {
      index++
      if (index === 1)
        return reply(
          response,
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'denied-shell',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"echo unauthorized"}' },
              },
            ],
          },
          'tool_calls',
        )
      if (index === 2)
        return reply(
          response,
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'bad-args',
                type: 'function',
                function: { name: 'coloop_echo', arguments: '{"value":42}' },
              },
            ],
          },
          'tool_calls',
        )
      reply(response, { content: 'Both calls were rejected.' })
    })
    const { runtime, execute } = await agent(api.baseURL)
    await runtime.run('Attempt invalid calls.')
    expect(execute).not.toHaveBeenCalled()
    expect(JSON.stringify(api.bodies[2])).toContain('COLOOP_TOOL_ARGUMENTS_INVALID')
  }, 120_000)

  it('caps actual model requests and reports a budget termination', async () => {
    const api = await fixture((_body, response) =>
      reply(response, { content: 'Still unfinished.' }),
    )
    const { runtime, fetcher } = await agent(api.baseURL, {
      maxIterations: 2,
      completion: () => ({ finished: false }),
    })
    expect((await runtime.run('Keep working')).finishReason).toBe('max_iterations')
    expect(fetcher).toHaveBeenCalledTimes(2)
  }, 120_000)

  it('does not report a token-truncated response as a completed task', async () => {
    const api = await fixture((_body, response) =>
      reply(response, { content: 'Incomplete answer' }, 'length'),
    )
    const { runtime, events } = await agent(api.baseURL)
    expect((await runtime.run('Complete the work.')).finishReason).toBe('error')
    expect(
      events.some(
        (event) => event.type === 'agent_error' && event.error === 'HARNESS_TURN_MAX_TOKENS',
      ),
    ).toBe(true)
  }, 120_000)

  it('stops the official process and waits for a cancelled host tool to settle', async () => {
    const api = await fixture((_body, response) => reply(response, call, 'tool_calls'))
    let started!: () => void
    const entered = new Promise<void>((yes) => {
      started = yes
    })
    let settled = false
    const { runtime } = await agent(api.baseURL, {
      tools: [
        {
          name: 'coloop_echo',
          description: 'Wait',
          parameters: { type: 'object' },
          async execute(_args, context) {
            started()
            await new Promise<void>((yes) =>
              context!.signal.addEventListener('abort', () => setTimeout(yes, 100), { once: true }),
            )
            settled = true
            throw new Error('HOST_TOOL_CANCELLED')
          },
        },
      ],
    })
    const run = runtime.run('Start long tool')
    await entered
    await expect(runtime.run('overlap')).rejects.toThrow('already executing')
    expect(runtime.abort()).toBe(true)
    expect((await run).finishReason).toBe('abort')
    expect(settled).toBe(true)
  }, 120_000)

  it('requires explicit recovery and restores the official persisted conversation', async () => {
    const api = await fixture((body, response) =>
      reply(response, {
        content: body.messages.some((message: any) => message.content === 'first durable answer')
          ? 'history restored'
          : 'first durable answer',
      }),
    )
    const original = await agent(api.baseURL)
    await original.runtime.run('remember this')
    await original.runtime.dispose()
    const accidental = createHarnessRuntime(original.options)
    cleanup.push(() => accidental.dispose())
    await expect(accidental.initialize()).rejects.toThrow('HARNESS_EXPLICIT_RESUME_REQUIRED')
    const resumed = createHarnessRuntime({ ...original.options, resume: true })
    cleanup.push(() => resumed.dispose())
    expect((await resumed.run('continue')).content).toBe('history restored')
  }, 120_000)

  it('can safely resume a queued task that failed before any SDK session was created', async () => {
    const api = await fixture((_body, response) =>
      reply(response, { content: 'first successful turn' }),
    )
    const original = await agent(api.baseURL, { nodePath: resolve('does-not-exist-node.exe') })
    await expect(original.runtime.initialize()).rejects.toThrow('HARNESS_NODE_RUNTIME_NOT_FOUND')
    await original.runtime.dispose()
    const resumed = createHarnessRuntime({
      ...original.options,
      nodePath: process.execPath,
      resume: true,
    })
    cleanup.push(() => resumed.dispose())
    expect((await resumed.run('Continue the queued task.')).content).toBe('first successful turn')
    expect(api.bodies).toHaveLength(1)
  }, 120_000)

  it('binds persisted history to its recipient and protocol before reconciliation or network access', async () => {
    const api = await fixture((_body, response) => reply(response, { content: 'private history' }))
    const original = await agent(api.baseURL)
    await original.runtime.run('PRIVATE_MEMORY_CANARY')
    await original.runtime.dispose()
    const [taskFolder] = await readdir(original.home)
    const marker = await readFile(join(original.home, taskFolder, 'session-owner.json'), 'utf8')
    expect(JSON.parse(marker).routeBinding).toMatch(/^[a-f0-9]{64}$/)
    expect(marker).not.toContain('fixture-only')
    expect(marker).not.toContain(api.baseURL)
    const reconcileUnknown = vi.fn()
    const fetcher = vi.fn()
    for (const changed of [
      { baseURL: 'https://other-recipient.invalid/v1' },
      { id: 'another-model' },
      { provider: 'another-provider' },
      { toolCallEngine: 'prompt_engineering' as const },
      { headers: { 'x-tenant-id': 'another-tenant' } },
    ]) {
      const resumed = createHarnessRuntime({
        ...original.options,
        resume: true,
        model: { ...original.options.model, ...changed },
        fetch: fetcher,
        reconcileUnknown,
      })
      cleanup.push(() => resumed.dispose())
      await expect(resumed.initialize()).rejects.toThrow('HARNESS_SESSION_ROUTE_MISMATCH')
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(reconcileUnknown).not.toHaveBeenCalled()
    expect(api.bodies).toHaveLength(1)
    expect(await readFile(join(original.home, taskFolder, 'session-owner.json'), 'utf8')).toBe(
      marker,
    )
    // Key rotation does not change the destination. Same-route history remains resumable.
    const rotated = createHarnessRuntime({
      ...original.options,
      resume: true,
      model: {
        ...original.options.model,
        apiKey: 'rotated-fixture-key',
        baseURL: api.baseURL + '/',
      },
    })
    cleanup.push(() => rotated.dispose())
    await rotated.run('continue')
    expect(api.bodies).toHaveLength(2)
    expect(JSON.stringify(api.bodies[1])).toContain('PRIVATE_MEMORY_CANARY')
  }, 120_000)

  it('retains but refuses unbound and invalid legacy owner markers', async () => {
    const api = await fixture((_body, response) => reply(response, { content: 'saved' }))
    const original = await agent(api.baseURL)
    await original.runtime.run('remember locally')
    await original.runtime.dispose()
    const [taskFolder] = await readdir(original.home)
    const path = join(original.home, taskFolder, 'session-owner.json')
    for (const [marker, error] of [
      [
        JSON.stringify({ sessionId: original.options.id, version: HARNESS_VERSION }),
        'HARNESS_SESSION_ROUTE_UNBOUND',
      ],
      [
        JSON.stringify({ sessionId: 'different', version: HARNESS_VERSION }),
        'HARNESS_SESSION_OWNER_INVALID',
      ],
      ['null', 'HARNESS_SESSION_OWNER_INVALID'],
      ['{bad json', 'HARNESS_SESSION_OWNER_INVALID'],
    ]) {
      await writeFile(path, marker)
      const resumed = createHarnessRuntime({ ...original.options, resume: true })
      cleanup.push(() => resumed.dispose())
      await expect(resumed.initialize()).rejects.toThrow(error)
      expect(await readFile(path, 'utf8')).toBe(marker)
    }
    expect(api.bodies).toHaveLength(1)
  }, 120_000)

  it('allows host-declared remote-to-local recovery and permanently prevents outward replay', async () => {
    const remote = await fixture((_body, response) => reply(response, { content: 'remote answer' }))
    const local = await fixture((_body, response) => reply(response, { content: 'local answer' }))
    const original = await agent(remote.baseURL, { historyBoundary: 'remote' })
    await original.runtime.run('prior remote context')
    await original.runtime.dispose()
    const [taskFolder] = await readdir(original.home)
    const marker = join(original.home, taskFolder, 'session-owner.json')
    const inward = createHarnessRuntime({
      ...original.options,
      resume: true,
      historyBoundary: 'local',
      model: { ...original.options.model, baseURL: local.baseURL, id: 'local-model' },
    })
    cleanup.push(() => inward.dispose())
    await inward.initialize()
    expect(JSON.parse(await readFile(marker, 'utf8')).historyBoundary).toBe('local')
    await inward.run('PRIVATE_LOCAL_CANARY')
    await inward.dispose()
    expect(JSON.stringify(local.bodies)).toContain('prior remote context')
    expect(JSON.stringify(remote.bodies)).not.toContain('PRIVATE_LOCAL_CANARY')
    for (const model of [
      original.options.model,
      { ...original.options.model, baseURL: local.baseURL, id: 'local-model' },
    ]) {
      const outward = createHarnessRuntime({
        ...original.options,
        model,
        resume: true,
        historyBoundary: 'remote',
      })
      cleanup.push(() => outward.dispose())
      await expect(outward.initialize()).rejects.toThrow('HARNESS_SESSION_ROUTE_MISMATCH')
    }
    expect(remote.bodies).toHaveLength(1)
    expect(local.bodies).toHaveLength(1)
    expect(JSON.parse(await readFile(marker, 'utf8')).historyBoundary).toBe('local')
  }, 120_000)

  it('detaches the active model route from subsequent caller mutations', async () => {
    const api = await fixture((_body, response) => reply(response, { content: 'original route' }))
    const original = await agent(api.baseURL)
    original.options.model.baseURL = 'https://changed-recipient.invalid/v1'
    original.options.model.id = 'mutated-model'
    expect((await original.runtime.run('use bound route')).content).toBe('original route')
    expect(api.bodies[0].model).toBe('test-model')
  }, 120_000)

  it('refuses fresh creation when an owner marker is missing but durable intents exist', async () => {
    const api = await fixture((_body, response) => reply(response, { content: 'must not run' }))
    const original = await agent(api.baseURL, { nodePath: resolve('does-not-exist-node.exe') })
    await expect(original.runtime.initialize()).rejects.toThrow('HARNESS_NODE_RUNTIME_NOT_FOUND')
    await original.runtime.dispose()
    const [taskFolder] = await readdir(original.home)
    await appendFile(
      join(original.home, taskFolder, 'host-events.jsonl'),
      JSON.stringify({
        type: 'tool_intent',
        callId: 'unknown-side-effect',
        name: 'coloop_echo',
        signature: '["coloop_echo",{}]',
      }) + '\n',
    )
    const resumed = createHarnessRuntime({
      ...original.options,
      nodePath: process.execPath,
      resume: true,
    })
    cleanup.push(() => resumed.dispose())
    await expect(resumed.run('Continue')).rejects.toThrow('HARNESS_SESSION_NOT_FOUND')
    expect(api.bodies).toHaveLength(0)
  }, 120_000)

  it('blocks resumed execution with an unresolved durable tool intent', async () => {
    const api = await fixture((_body, response) => reply(response, { content: 'done' }))
    const original = await agent(api.baseURL)
    await original.runtime.run('first task')
    await original.runtime.dispose()
    const [taskFolder] = await readdir(original.home)
    await appendFile(
      join(original.home, taskFolder, 'host-events.jsonl'),
      JSON.stringify({
        type: 'tool_intent',
        callId: 'interrupted-send',
        name: 'coloop_echo',
        signature: '["coloop_echo",{}]',
      }) + '\n',
    )
    const resumed = createHarnessRuntime({ ...original.options, resume: true })
    cleanup.push(() => resumed.dispose())
    await expect(resumed.run('continue')).rejects.toThrow(
      'HARNESS_TOOL_OUTCOME_UNKNOWN_REQUIRES_VERIFICATION',
    )
    expect(api.bodies).toHaveLength(1)
    const readOnlyRecovery = createHarnessRuntime({
      ...original.options,
      resume: true,
      reconcileUnknown: (intent) =>
        intent.name === 'coloop_echo' ? { kind: 'retry_read_only' } : undefined,
    })
    cleanup.push(() => readOnlyRecovery.dispose())
    expect(
      (await readOnlyRecovery.run('Recheck the current read-only evidence.')).finishReason,
    ).toBe('stop')
    expect(await readFile(join(original.home, taskFolder, 'host-events.jsonl'), 'utf8')).toContain(
      'tool_interrupted_read_only',
    )
  }, 120_000)

  it('routes automatic context compaction through the same host transport', async () => {
    let index = 0
    const api = await fixture((body, response) => {
      index++
      if (index === 1) return reply(response, call, 'tool_calls')
      reply(response, { content: 'A compact verified summary.' })
    })
    const { runtime, fetcher, events } = await agent(api.baseURL, {
      contextWindow: 4096,
      tools: [
        {
          name: 'coloop_echo',
          description: 'Read evidence',
          parameters: { type: 'object' },
          execute: () => ({ text: 'observed evidence '.repeat(1200) }),
        },
      ],
    })
    await runtime.run('Read and summarize the evidence.')
    expect(
      events.some(
        (event) =>
          event.type === 'harness_session_event' &&
          String(event.event.type).startsWith('compaction/'),
      ),
    ).toBe(true)
    expect(api.bodies.length).toBeGreaterThanOrEqual(3)
    expect(fetcher).toHaveBeenCalledTimes(api.bodies.length)
  }, 120_000)

  it('preserves streamed DeepSeek reasoning with its subsequent tool history', async () => {
    const api = await fixture((body, response) => {
      const result = body.messages.some((message: any) => message.role === 'tool')
      reply(
        response,
        result
          ? { content: 'verified' }
          : { ...call, reasoning_content: 'Use the observed evidence.' },
        result ? 'stop' : 'tool_calls',
      )
    })
    const { runtime } = await agent(api.baseURL)
    await runtime.run('Use a tool')
    expect(
      api.bodies[1].messages.find((message: any) => message.role === 'assistant')
        ?.reasoning_content,
    ).toBe('Use the observed evidence.')
  }, 120_000)
})
