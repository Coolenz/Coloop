import { expect, it, vi } from 'vitest'
import { createDecisionModelFetch } from '../src/main/infrastructure/decision-model'
import type { DecisionModelRoute } from '../src/main/infrastructure/model-role'

const route = (protocol: 'openai' | 'anthropic' | 'gemini'): DecisionModelRoute => ({
  provider: {
    protocol,
    name: 'decision fixture',
    model: 'strong-model',
    baseUrl: 'https://decision.invalid/v1',
    imageInput: 'supported',
  },
  apiKey: 'decision-key',
  role: 'decision',
  pricing: {},
})
const message = {
  role: 'user',
  content: [
    { type: 'text', text: 'Read current image, then call the permitted tool.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
  ],
}
const body = (messages: any[] = [message]) => ({
  model: 'strong-model',
  stream: true,
  max_tokens: 1000,
  messages,
  tools: [
    {
      type: 'function',
      function: {
        name: 'inspect',
        description: 'inspect',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
})
const request = (value = body()) => ({ method: 'POST', body: JSON.stringify(value) })

it('keeps OpenAI requests on their configured route and never switches after failure', async () => {
  const fetcher = vi.fn(async (_url: any, _init: any) => new Response('denied', { status: 401 }))
  const call = createDecisionModelFetch(route('openai'), { taskId: 'task', fetch: fetcher })
  expect((await call('https://decision.invalid/v1/chat/completions', request())).status).toBe(401)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://decision.invalid/v1/chat/completions')
})

it('normalizes Anthropic images, tool calls and corresponding results without another model loop', async () => {
  const fetcher = vi.fn(
    async (_url: any, _init: any) =>
      new Response(
        JSON.stringify({
          id: 'msg-1',
          type: 'message',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'call-1', name: 'inspect', input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
  )
  const call = createDecisionModelFetch(route('anthropic'), { taskId: 'task', fetch: fetcher })
  const answer = await (
    await call('https://decision.invalid/v1/chat/completions', request())
  ).text()
  expect(answer).toContain('"id":"call-1"')
  expect(answer).toContain('"finish_reason":"tool_calls"')
  const first = JSON.parse(fetcher.mock.calls[0][1].body)
  expect(fetcher.mock.calls[0][0]).toBe('https://decision.invalid/v1/messages')
  expect(fetcher.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'decision-key' })
  expect(first.messages[0].content[1]).toEqual({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'YQ==' },
  })
  await call(
    'https://decision.invalid/v1/chat/completions',
    request(
      body([
        message,
        {
          role: 'assistant',
          tool_calls: [{ id: 'call-1', function: { name: 'inspect', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"observed":true}' },
      ]),
    ),
  )
  expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[2].content[0]).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'call-1',
  })
})

it('normalizes Gemini image input and retains native tool thought signatures for the matching turn', async () => {
  const fetcher = vi.fn(
    async (_url: any, _init: any) =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  {
                    functionCall: { id: 'gem-call', name: 'inspect', args: {} },
                    thoughtSignature: 'opaque-signature',
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        }),
      ),
  )
  const call = createDecisionModelFetch(route('gemini'), { taskId: 'task', fetch: fetcher })
  expect(
    await (await call('https://decision.invalid/v1/chat/completions', request())).text(),
  ).toContain('gem-call')
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://decision.invalid/v1/models/strong-model:generateContent',
  )
  expect(JSON.parse(fetcher.mock.calls[0][1].body).contents[0].parts[1]).toEqual({
    inlineData: { mimeType: 'image/png', data: 'YQ==' },
  })
  await call(
    'https://decision.invalid/v1/chat/completions',
    request(
      body([
        {
          role: 'assistant',
          tool_calls: [{ id: 'gem-call', function: { name: 'inspect', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'gem-call', content: 'observed' },
      ]),
    ),
  )
  const second = JSON.parse(fetcher.mock.calls[1][1].body)
  expect(second.contents[0].parts[0].thoughtSignature).toBe('opaque-signature')
  expect(second.contents[1].parts[0].functionResponse.name).toBe('inspect')
})

it('requires a supported image capability and correct route before networking', async () => {
  const fetcher = vi.fn(async () => new Response('{}'))
  const selected = route('openai')
  selected.provider.imageInput = 'unknown'
  const call = createDecisionModelFetch(selected, { taskId: 'task', fetch: fetcher })
  await expect(call('https://decision.invalid/v1/chat/completions', request())).rejects.toThrow(
    'DECISION_IMAGE_CAPABILITY_REQUIRED',
  )
  await expect(call('https://different.invalid/v1/chat/completions', request())).rejects.toThrow(
    'DECISION_MODEL_ROUTE_INVALID',
  )
  expect(fetcher).not.toHaveBeenCalled()
})
