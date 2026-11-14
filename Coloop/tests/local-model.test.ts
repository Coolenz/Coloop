import { expect, it } from 'vitest'
import {
  localOutputBudget,
  localOutputReserve,
  localPromptBytes,
  type LocalModelCapacity,
} from '../src/shared/local-model'
import { createRkTarsFetch, rkTarsModel } from '../src/main/infrastructure/rk-tars-model'
import { harnessRkResponse } from '../src/main/infrastructure/harness-runtime'

const capacity: LocalModelCapacity = {
  contextWindow: 16384,
  defaultOutputTokens: 256,
  maximumOutputTokens: 2048,
  source: 'health',
}

it.each(['<tool_call>{"name":', '<tool_call>{"name":"coloop_files","parameters":{}}</tool_call>'])(
  'does not dispatch a length-terminated tool envelope %s',
  async (content) => {
    const response = new Response(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'length' }] }) +
        '\n\ndata: [DONE]\n\n',
    )
    const body = await (await harnessRkResponse(response)).text()
    const frames = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
    expect(frames.every((frame) => frame.choices[0].delta.tool_calls === undefined)).toBe(true)
    expect(frames.at(-1).choices[0].finish_reason).toBe('length')
  },
)
it('resolves explicit, configured, declared and custom budgets in order', () => {
  expect(localOutputBudget(capacity)).toEqual({ tokens: 256, source: 'health' })
  expect(localOutputBudget(capacity, undefined, 1024)).toEqual({ tokens: 1024, source: 'settings' })
  expect(localOutputBudget(capacity, 2048, 1024)).toEqual({ tokens: 2048, source: 'request' })
  expect(localOutputBudget(capacity, 2048, undefined, 512)).toEqual({
    tokens: 512,
    source: 'custom-limit',
  })
  expect(() => localOutputBudget(capacity, 2049)).toThrow('LOCAL_MODEL_OUTPUT_LIMIT')
  expect(() => localOutputBudget(capacity, undefined, 4096)).toThrow('LOCAL_MODEL_OUTPUT_LIMIT')
  expect(localOutputReserve(2048)).toBe(2176)
  expect(localPromptBytes('中', [{ content: '文' }, { content: '路径' }])).toBe(13)
})
it.each([256, 1024, 2048])(
  'preserves a real length result with a %i output budget through both adapters',
  async (tokens) => {
    const fetcher = createRkTarsFetch(async (_system, _messages, _signal, maxTokens) => {
      expect(maxTokens).toBe(tokens)
      return {
        text: '部分结果',
        finishReason: 'length',
        requestedOutputTokens: tokens,
        completionTokens: tokens,
      }
    }, capacity)
    const response = await fetcher(rkTarsModel.baseURL + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: rkTarsModel.id,
        stream: true,
        max_tokens: tokens,
        messages: [{ role: 'user', content: '读取' }],
      }),
    })
    const translated = await (await harnessRkResponse(response)).text()
    expect(translated).toContain('"finish_reason":"length"')
    expect(translated).toContain(`"completion_tokens":${tokens}`)
  },
)
