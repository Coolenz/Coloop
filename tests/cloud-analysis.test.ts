import { describe, expect, it, vi } from 'vitest'
import { CloudGateway } from '../src/main/infrastructure/cloud'
import type { ProviderConfig } from '../src/shared/contracts'

const config: ProviderConfig = {
  protocol: 'openai',
  name: 'Test',
  baseUrl: 'https://example.com/v1',
  model: 'analysis-test',
}
const projection = { question: '分析 [PERSON_1] 的任务', facts: ['[PROJECT_1] 需要先核查输入'] }
const analysis = { summary: '先核查依赖', steps: ['核查 [PROJECT_1] 的输入'], uncertainties: [] }
const signal = () => new AbortController().signal

function envelope(protocol: ProviderConfig['protocol'], text = JSON.stringify(analysis)): unknown {
  if (protocol === 'anthropic')
    return { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocol === 'gemini')
    return {
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }],
    }
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }
}

function gateway(body: unknown, protocol: ProviderConfig['protocol'] = 'openai') {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))
  const cloud = new CloudGateway(fetcher as typeof fetch)
  const run = () => cloud.analyze({ ...config, protocol }, 'SECRET_KEY', projection, signal())
  return { fetcher, cloud, run }
}

describe('bounded cloud analysis Agent', () => {
  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    'reserves bounded reasoning headroom and short JSON for official DeepSeek %s',
    async (model) => {
      const { fetcher, cloud } = gateway(envelope('openai'))
      await cloud.analyze(
        { ...config, baseUrl: 'https://api.deepseek.com', model },
        'SECRET_KEY',
        projection,
        signal(),
      )
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
        thinking: { type: 'enabled' },
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
        max_tokens: 2048,
        tools: [],
        tool_choice: 'none',
        stream: false,
      })
    },
  )
  it.each([
    ['https://example.com/v1', 'deepseek-flash'],
    ['https://api.deepseek.com.evil.example', 'deepseek-flash'],
    ['https://api.deepseek.com', 'other-model'],
  ])('does not send DeepSeek-specific fields to %s / %s', async (baseUrl, model) => {
    const { fetcher, cloud } = gateway(envelope('openai'))
    await cloud.analyze({ ...config, baseUrl, model }, 'SECRET_KEY', projection, signal())
    const body = JSON.parse(fetcher.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })
  it.each(['openai', 'anthropic', 'gemini'] as const)(
    'sends only the validated projection with a fixed tool-free policy for %s',
    async (protocol) => {
      const { fetcher, run } = gateway(envelope(protocol), protocol)
      expect(await run()).toEqual(analysis)
      expect(fetcher).toHaveBeenCalledTimes(1)
      const [url, options] = fetcher.mock.calls[0]
      const body = JSON.parse(options.body)
      expect(url).not.toContain('SECRET_KEY')
      expect(options.redirect).toBe('error')
      expect(JSON.stringify(body)).not.toContain('SECRET_KEY')
      const system =
        protocol === 'anthropic'
          ? body.system
          : protocol === 'gemini'
            ? body.systemInstruction.parts[0].text
            : body.messages[0].content
      const user =
        protocol === 'gemini'
          ? body.contents[0].parts[0].text
          : body.messages[protocol === 'openai' ? 1 : 0].content
      expect(system).toContain('不可信')
      expect(system).toContain('占位符映射')
      expect(system).toContain('只返回一个 JSON')
      expect(JSON.parse(user)).toEqual(projection)
      if (protocol === 'openai') {
        expect(body).toMatchObject({
          stream: false,
          max_tokens: 512,
          tools: [],
          tool_choice: 'none',
          store: false,
        })
      } else {
        expect(body.tools).toBeUndefined()
        expect(
          protocol === 'anthropic' ? body.max_tokens : body.generationConfig.maxOutputTokens,
        ).toBe(512)
      }
    },
  )

  it('does not serialize undeclared local mapping fields or invalid projections', async () => {
    const { fetcher, cloud } = gateway(envelope('openai'))
    await expect(
      cloud.analyze(
        config,
        'SECRET_KEY',
        { ...projection, mapping: { PERSON_1: 'LOCAL_CANARY' } } as typeof projection,
        signal(),
      ),
    ).rejects.toThrow('投影格式无效')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    'plain text',
    '```json\n{"summary":"ok","steps":[],"uncertainties":[]}\n```',
    '{"summary":"first","summary":"second","steps":[],"uncertainties":[]}',
    '{"summary":"first","summ\\u0061ry":"second","steps":[],"uncertainties":[]}',
    JSON.stringify({ ...analysis, mapping: 'do not disclose raw data' }),
    JSON.stringify({ ...analysis, summary: ' ' }),
    JSON.stringify({ ...analysis, summary: 'x'.repeat(801) }),
    JSON.stringify({ ...analysis, steps: Array(7).fill('step') }),
    JSON.stringify({ ...analysis, steps: ['x'.repeat(201)] }),
    JSON.stringify({ ...analysis, uncertainties: Array(5).fill('unknown') }),
    JSON.stringify({ ...analysis, uncertainties: ['x'.repeat(201)] }),
    JSON.stringify({ ...analysis, steps: [17] }),
  ])(
    'rejects ambiguous or out-of-contract analysis without returning provider text',
    async (text) => {
      const { run } = gateway(envelope('openai', text))
      await expect(run()).rejects.toThrow('云端分析响应无效')
    },
  )

  it('enforces the 4096 UTF-8 byte budget even for schema-sized Chinese fields', async () => {
    const text = JSON.stringify({
      summary: '中'.repeat(800),
      steps: ['文'.repeat(200), '字'.repeat(200), '节'.repeat(200)],
      uncertainties: [],
    })
    expect(text.length).toBeLessThan(4096)
    const { run } = gateway(envelope('openai', text))
    await expect(run()).rejects.toThrow('超出限制')
  })

  it.each([
    ['openai', { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }],
    ['openai', { choices: [{ message: { content: JSON.stringify(analysis) } }] }],
    [
      'openai',
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(analysis), tool_calls: [{ id: 'tool' }] },
          },
        ],
      },
    ],
    [
      'openai',
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(analysis), function_call: { name: 'read' } },
          },
        ],
      },
    ],
    ['openai', { choices: [{ finish_reason: 'stop', message: { content: ['json'] } }] }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }],
    ['anthropic', { stop_reason: 'end_turn', content: [{ type: 'tool_use', name: 'read' }] }],
    [
      'anthropic',
      {
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: 'private' },
          { type: 'text', text: JSON.stringify(analysis) },
        ],
      },
    ],
    [
      'gemini',
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    ],
    [
      'gemini',
      {
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'read' } }] } },
        ],
      },
    ],
    ['gemini', { candidates: [] }],
    ['openai', { error: { message: 'SECRET_UPSTREAM_BODY' }, ...(envelope('openai') as object) }],
  ] as const)('rejects incomplete or tool-calling %s envelopes', async (protocol, body) => {
    const { run } = gateway(body, protocol)
    await expect(run()).rejects.toThrow('云端分析响应无效')
  })

  it('rejects duplicate keys in the provider envelope', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `{"choices":[],"choices":${JSON.stringify((envelope('openai') as any).choices)}}`,
        ),
      )
    await expect(
      new CloudGateway(fetcher as typeof fetch).analyze(config, 'key', projection, signal()),
    ).rejects.toThrow('云端分析响应无效')
  })

  it('bounds and cancels a streaming response before buffering unlimited data', async () => {
    const cancel = vi.fn()
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(10000).fill(32))
      },
      cancel,
    })
    const fetcher = vi.fn().mockResolvedValue(new Response(stream))
    await expect(
      new CloudGateway(fetcher as typeof fetch).analyze(config, 'key', projection, signal()),
    ).rejects.toThrow('超出限制')
    expect(cancel).toHaveBeenCalledOnce()
    expect(pulled).toBeLessThanOrEqual(6)
  })

  it('cancels a body waiting for data when the task is cancelled', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        reading()
      },
      cancel,
    })
    const fetcher = vi.fn().mockResolvedValue(new Response(stream))
    const pending = new CloudGateway(fetcher as typeof fetch).analyze(
      config,
      'key',
      projection,
      controller.signal,
    )
    await started
    controller.abort('PRIVATE_CANCEL_REASON')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: '云端分析已取消' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not fetch for a cancelled task and does not accept a late response', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetcher, cloud } = gateway(envelope('openai'))
    await expect(cloud.analyze(config, 'key', projection, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    )
    expect(fetcher).not.toHaveBeenCalled()
    const lateController = new AbortController()
    const lateCancel = vi.fn()
    const lateFetch = vi.fn().mockImplementation(async () => {
      lateController.abort()
      return new Response(new ReadableStream({ cancel: lateCancel }))
    })
    await expect(
      new CloudGateway(lateFetch as typeof fetch).analyze(
        config,
        'key',
        projection,
        lateController.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(lateCancel).toHaveBeenCalledOnce()
  })

  it('does not expose upstream network errors or HTTP response bodies', async () => {
    for (const response of [
      new Response('SECRET_UPSTREAM_BODY', { status: 401 }),
      new Error('SECRET_NETWORK_ERROR'),
    ]) {
      const fetcher = vi.fn().mockImplementation(async () => {
        if (response instanceof Error) throw response
        return response
      })
      let message = ''
      try {
        await new CloudGateway(fetcher as typeof fetch).analyze(config, 'key', projection, signal())
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('云端分析')
      expect(message).not.toContain('SECRET')
    }
  })

  it('validates secure endpoint configuration before transmitting a credential', async () => {
    const { fetcher, cloud } = gateway(envelope('openai'))
    await expect(
      cloud.analyze(
        { ...config, baseUrl: 'http://remote.example/v1' },
        'key',
        projection,
        signal(),
      ),
    ).rejects.toThrow('连接配置无效')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(cloud.analyze(config, '', projection, signal())).rejects.toThrow('API Key')
    expect(fetcher).not.toHaveBeenCalled()
    expect(
      await cloud.analyze(
        { ...config, baseUrl: 'http://localhost:8080/v1' },
        '',
        projection,
        signal(),
      ),
    ).toEqual(analysis)
  })
})
