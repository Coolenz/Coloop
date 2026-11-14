import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTarsRuntime,
  type TarsRuntimeEvent,
  type TarsRuntimeOptions,
} from '../src/main/infrastructure/tars-runtime'
import { TarsAgentService } from '../src/main/services/tars-agent'
import { ModelUsageLedger } from '../src/main/infrastructure/model-usage'

const require = createRequire(import.meta.url)
const official = require('@agent-tars/core') as typeof import('@agent-tars/core')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function endpoint(handle: (body: any, response: ServerResponse) => void) {
  const requests: any[] = []
  const server = createServer(async (request: IncomingMessage, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    handle(body, response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_TEST_ADDRESS')
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests }
}

function respond(response: ServerResponse, delta: unknown, finishReason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [value, finish] of [
    [delta, null],
    [{}, finishReason],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test-cloud',
        choices: [{ index: 0, delta: value, finish_reason: finish }],
      })}\n\n`,
    )
  }
  response.end('data: [DONE]\n\n')
}

function toolCall(name: string, args = '{}') {
  return {
    role: 'assistant',
    tool_calls: [
      { index: 0, id: 'call-test', type: 'function', function: { name, arguments: args } },
    ],
  }
}

const testInstructions = 'Use coloop_echo and report its actual result.'
function runtime(
  baseURL: string,
  execute: (args: unknown) => Promise<unknown> | unknown,
  options: Pick<TarsRuntimeOptions, 'maxIterations' | 'completion' | 'requestContext'> = {
    maxIterations: 5,
  },
) {
  const events: TarsRuntimeEvent[] = []
  const fetcher = vi.fn(globalThis.fetch)
  const agent = createTarsRuntime({
    id: 'tars-integration-test',
    workspace: process.cwd(),
    model: { provider: 'openai', id: 'test-cloud', apiKey: 'test-only', baseURL },
    instructions: testInstructions,
    ...options,
    tools: [
      {
        name: 'coloop_echo',
        description: 'Return the input.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        execute,
      },
    ],
    onEvent: (event) => events.push(event),
    fetch: fetcher,
  })
  cleanups.push(() => agent.dispose())
  return { agent, events, fetcher }
}

describe('official Agent TARS runtime integration', () => {
  it('enforces an actual HTTP request cap through the official SDK client', async () => {
    const api = await endpoint((_body, response) => {
      respond(response, toolCall('coloop_echo', '{"value":"same-state"}'), 'tool_calls')
    })
    const directory = await mkdtemp(join(tmpdir(), 'coloop-sdk-budget-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const ledger = new ModelUsageLedger(directory, () => ({
      usageBudgetEnabled: true,
      minRequestIntervalMs: 0,
      maxRequestsPerTask: 2,
    }))
    const agent = createTarsRuntime({
      id: 'bounded',
      workspace: directory,
      model: { provider: 'openai', id: 'test-cloud', apiKey: 'test-only', baseURL: api.baseURL },
      instructions: 'Call the echo tool.',
      fetch: ledger.wrap(globalThis.fetch, { taskId: 'bounded-task', source: 'sdk_integration' }),
      tools: [
        {
          name: 'coloop_echo',
          description: 'Echo',
          parameters: { type: 'object' },
          execute: () => ({ same: true }),
        },
      ],
    })
    cleanups.push(() => agent.dispose())
    const result = await agent.run('Repeat until stopped.')
    expect(result.finishReason).toBe('error')
    expect(api.requests).toHaveLength(2)
    expect(ledger.snapshot().requests).toBe(2)
    expect(await readFile(join(directory, 'model-usage.jsonl'), 'utf8')).toContain(
      'MODEL_TASK_REQUEST_LIMIT',
    )
  })
  it('refreshes diagnostic context through the official request hook', async () => {
    let diagnostic = ''
    const { agent } = runtime('http://127.0.0.1:1/v1', vi.fn(), {
      requestContext: () => diagnostic,
    })
    const context = {
      systemPrompt: 'upstream defaults',
      tools: agent.getTools(),
      sessionId: 'diagnostic',
      iteration: 1,
    }
    expect((await agent.onPrepareRequest(context)).systemPrompt).not.toContain('停滞')
    diagnostic = '停滞诊断，请根据真实进展继续。'
    expect((await agent.onPrepareRequest(context)).systemPrompt).toContain(diagnostic)
    diagnostic = ''
    expect((await agent.onPrepareRequest(context)).systemPrompt).not.toContain('停滞')
    expect(agent.run).toBe(official.AgentTARS.prototype.run)
  })
  it('keeps the official loop running after an unverified final answer and supplies completion feedback', async () => {
    let step = 0
    let verified = false
    const api = await endpoint((body, response) => {
      step++
      if (step === 1)
        respond(response, {
          role: 'assistant',
          content: '提前声称完成',
          reasoning_content: 'provider-final-reasoning',
        })
      else if (step === 2) {
        expect(body.messages[0].content).toContain('缺少实际核验')
        expect(
          body.messages.find((message: any) => message.role === 'assistant').reasoning_content,
        ).toBe('provider-final-reasoning')
        respond(
          response,
          {
            ...toolCall('coloop_echo', '{"value":"实际结果"}'),
            reasoning_content: 'provider-tool-reasoning',
          },
          'tool_calls',
        )
      } else {
        expect(
          body.messages
            .filter((message: any) => message.role === 'assistant')
            .map((message: any) => message.reasoning_content),
        ).toEqual(['provider-final-reasoning', 'provider-tool-reasoning'])
        respond(response, { role: 'assistant', content: '实际核验完成' })
      }
    })
    const execute = vi.fn(() => {
      verified = true
      return { verified }
    })
    const { agent } = runtime(api.baseURL, execute, {
      maxIterations: 5,
      completion: () => ({ finished: verified, message: '缺少实际核验，请继续调用工具。' }),
    })
    const result = await agent.run('完成并核验')
    expect(result.finishReason).toBe('stop')
    expect(result.content).toBe('实际核验完成')
    expect(execute).toHaveBeenCalledOnce()
    expect(step).toBe(3)
    expect(agent.run).toBe(official.AgentTARS.prototype.run)
  })
  it('continues the default execution loop beyond 32 iterations until the model finishes', async () => {
    let step = 0
    const api = await endpoint((_body, response) => {
      step++
      if (step <= 36)
        respond(
          response,
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `step-${step}`,
                type: 'function',
                function: {
                  name: 'coloop_echo',
                  arguments: JSON.stringify({ value: `progress-${step}` }),
                },
              },
            ],
          },
          'tool_calls',
        )
      else respond(response, { role: 'assistant', content: 'All 36 steps completed.' })
    })
    const execute = vi.fn((args: unknown) => args)
    const { agent } = runtime(api.baseURL, execute, {})
    const result = await agent.run('Continue through all 36 steps.')
    expect(result.finishReason).toBe('stop')
    expect(result.content).toBe('All 36 steps completed.')
    expect(execute).toHaveBeenCalledTimes(36)
    expect(api.requests).toHaveLength(37)
  }, 15000)

  it('runs the published AgentTARS loop through real HTTP, tools, feedback and events', async () => {
    const api = await endpoint((body, response) => {
      if (body.messages.some((message: any) => message.role === 'tool')) {
        respond(response, { role: 'assistant', content: 'Verified tool result.' })
      } else
        respond(response, toolCall('coloop_echo', '{"value":"OCR page context"}'), 'tool_calls')
    })
    const execute = vi.fn((args: unknown) => ({ verified: args }))
    const { agent, events, fetcher } = runtime(api.baseURL, execute)
    expect(agent).toBeInstanceOf(official.AgentTARS)
    expect(agent.run).toBe(official.AgentTARS.prototype.run)
    const result = await agent.run({
      input: 'Read OCR context.',
      sessionId: 'one-task',
      stream: false,
    })
    expect(result.content).toBe('Verified tool result.')
    expect(result.finishReason).toBe('stop')
    expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 'OCR page context' })
    expect(api.requests).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(api.requests[0].stream).toBe(true)
    for (const request of api.requests) {
      const system = request.messages.find((message: any) => message.role === 'system').content
      expect(system.slice(0, testInstructions.length)).toBe(testInstructions)
      expect(system.slice(testInstructions.length)).toMatch(/^\n\nCurrent time: [^\r\n]+$/)
      for (const defaultInstruction of [
        'write_file',
        '<shell_rules>',
        '<browser_rules>',
        'several thousand words',
      ])
        expect(system).not.toContain(defaultInstruction)
    }
    const tools = agent.getTools()
    const prepared = await agent.onPrepareRequest({
      systemPrompt: 'Default prompt supplied by the SDK',
      tools,
      sessionId: 'one-task',
      iteration: 2,
    })
    expect(prepared.systemPrompt).toBe(testInstructions)
    expect(prepared.tools).toBe(tools)
    expect(api.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['coloop_echo'])
    expect(
      api.requests[1].messages.some(
        (message: any) => message.role === 'tool' && message.content.includes('OCR page context'),
      ),
    ).toBe(true)
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'agent_run_start',
        'tool_call',
        'tool_result',
        'assistant_message',
        'agent_run_end',
      ]),
    )
  })

  it.each([
    [
      'suggestion',
      '{"type":"suggestion","title":"补充正文","text":"目前只有标题","goal":"追加正文"}',
    ],
    ['ignore', '{"type":"ignore"}'],
    ['invalid', '{"type":"suggestion"}'],
  ])(
    'keeps passive decisions local without starting the cloud runtime (%s)',
    async (kind, answer) => {
      const api = await endpoint((_body, response) =>
        respond(response, { content: 'Cloud forbidden' }),
      )
      const directory = await mkdtemp(join(tmpdir(), 'coloop-tars-recommend-'))
      cleanups.push(() => rm(directory, { recursive: true, force: true }))
      const recommendLocal = vi.fn(async () => answer)
      const onObservationRetry = vi.fn()
      const service = new TarsAgentService({
        workspace: directory,
        model: () => ({
          provider: 'openai',
          id: 'test-cloud',
          apiKey: 'test-only',
          baseURL: api.baseURL,
        }),
        recommendLocal,
        available: () => true,
        assertStart: vi.fn(),
        observe: vi.fn(),
        input: vi.fn(),
        prepareInput: vi.fn(),
        onChange: vi.fn(),
        onObservationRetry,
        execution: {
          connect: vi.fn(),
          begin: vi.fn(),
          execute: vi.fn(),
          stop: vi.fn(),
          dispose: vi.fn(),
        },
        memory: { enqueue: vi.fn(), catalog: vi.fn(), get: vi.fn(), dispose: vi.fn() },
      })
      cleanups.push(() => service.dispose())
      await service.submitObservation({
        observation_id: 'page',
        window_id: 'window',
        ocr_text: '标题',
      })
      await vi.waitFor(() => expect(recommendLocal).toHaveBeenCalledOnce())
      expect(api.requests).toHaveLength(0)
      expect(!!service.snapshot().suggestion).toBe(kind === 'suggestion')
      expect(onObservationRetry).toHaveBeenCalledTimes(kind === 'invalid' ? 1 : 0)
      await service.dispose()
    },
  )

  it('does not register or execute an unapproved tool even when the model invents its name', async () => {
    const api = await endpoint((body, response) => {
      if (body.messages.some((message: any) => message.role === 'tool'))
        respond(response, { content: 'Unavailable.' })
      else respond(response, toolCall('browser_navigate'), 'tool_calls')
    })
    const { agent, events } = runtime(api.baseURL, vi.fn())
    const manager = agent.getBrowserManager()!
    const launch = vi.spyOn(manager, 'launchBrowser').mockResolvedValue()
    cleanups.push(async () => {
      launch.mockRestore()
    })
    const forbidden = vi.fn()
    agent.registerTool(
      new official.Tool({
        id: 'browser_navigate',
        description: 'Forbidden tool',
        parameters: { type: 'object' },
        function: forbidden,
      }),
    )
    await agent.run('Attempt an unapproved tool.')
    expect(launch).not.toHaveBeenCalled()
    expect(forbidden).not.toHaveBeenCalled()
    expect(agent.getTools().map((tool) => tool.name)).toEqual(['coloop_echo'])
    expect(
      events.some((event) => event.type === 'tool_result' && event.error?.includes('not found')),
    ).toBe(true)
  })

  it('aborts an in-flight HTTP request through the custom OpenAI client', async () => {
    let received!: () => void
    const ready = new Promise<void>((resolve) => {
      received = resolve
    })
    const api = await endpoint(() => received())
    const { agent } = runtime(api.baseURL, vi.fn())
    const pending = agent.run('Wait for the cloud.')
    await ready
    expect(agent.abort()).toBe(true)
    const result = await pending
    expect(result.finishReason).toBe('abort')
    expect(api.requests).toHaveLength(1)
  }, 5000)

  it('keeps tool cancellation explicit and does not start another loop after abort', async () => {
    const api = await endpoint((_body, response) =>
      respond(response, toolCall('coloop_echo', '{"value":"wait"}'), 'tool_calls'),
    )
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { agent } = runtime(api.baseURL, async () => {
      const signal = agent.getAbortSignal()!
      entered()
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('RK stopped')), { once: true }),
      )
    })
    const pending = agent.run('Wait for an RK tool.')
    await ready
    await expect(agent.run('Do not start another task.')).rejects.toThrow('already executing')
    agent.abort()
    expect((await pending).finishReason).toBe('abort')
    expect(api.requests).toHaveLength(1)
  }, 5000)

  it('reports provider errors as error finishReason without hidden HTTP retries', async () => {
    const api = await endpoint((_body, response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'test provider failure', type: 'server_error' } }),
      )
    })
    const { agent } = runtime(api.baseURL, vi.fn())
    const result = await agent.run('The provider fails.')
    expect(result.finishReason).toBe('error')
    expect(api.requests).toHaveLength(1)
  })
})
