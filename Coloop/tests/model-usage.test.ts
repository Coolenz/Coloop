import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelUsageLedger } from '../src/main/infrastructure/model-usage'
import { CloudGateway } from '../src/main/infrastructure/cloud'
import type { ModelLimits } from '../src/shared/model-usage'

const directories: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(policy: Partial<ModelLimits> = {}, now?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), 'coloop-model-usage-'))
  directories.push(directory)
  const limits = () => ({
    usageBudgetEnabled: true,
    costLimitEnabled: false,
    minRequestIntervalMs: 0,
    maxOutputTokens: 512,
    ...policy,
  })
  const ledger = new ModelUsageLedger(directory, limits, now)
  return { ledger, directory, limits }
}
const request = (signal?: AbortSignal) => ({
  method: 'POST',
  signal,
  headers: { authorization: 'Bearer private-api-canary' },
  body: JSON.stringify({
    model: 'test',
    stream: true,
    messages: [{ role: 'user', content: 'private-prompt-canary' }],
  }),
})
const context = { taskId: 'task-1', source: 'task_execution' }
const stream = () =>
  new Response(
    'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

it('fails closed when monetary protection has no complete pricing', async () => {
  const { ledger } = fixture({ costLimitEnabled: true, inputYuanPerMillion: 2 })
  const network = vi.fn(async () => stream())
  await expect(ledger.wrap(network, context)('https://model.invalid', request())).rejects.toThrow(
    'MODEL_PRICING_REQUIRED',
  )
  expect(network).not.toHaveBeenCalled()
})

it('retains the total monetary ceiling across midnight, restart and task IDs', async () => {
  let now = Date.parse('2026-11-05T00:00:00Z')
  const { ledger, directory, limits } = fixture(
    {
      costLimitEnabled: true,
      maxCostYuanTotal: 0.01,
      inputYuanPerMillion: 1,
      outputYuanPerMillion: 16,
    },
    () => now,
  )
  const network = vi.fn(async () => new Response('{}'))
  await (await ledger.wrap(network, context)('https://model.invalid', request())).text()
  now += 86400000
  const reopened = new ModelUsageLedger(directory, limits, () => now)
  await expect(
    reopened.wrap(network, { ...context, taskId: 'tomorrow' })('https://model.invalid', request()),
  ).rejects.toThrow('MODEL_TOTAL_COST_LIMIT')
  expect(network).toHaveBeenCalledOnce()
})

it.each([429, 500, 503])(
  'persists HTTP %i cooldown across routes, tasks and restart',
  async (status) => {
    let now = Date.parse('2026-11-05T00:00:00Z')
    const { ledger, directory, limits } = fixture({}, () => now)
    const network = vi.fn(
      async () => new Response('{}', { status, headers: { 'retry-after': '60' } }),
    )
    await (await ledger.wrap(network, context)('https://model.invalid', request())).text()
    const reopened = new ModelUsageLedger(directory, limits, () => now)
    await expect(
      reopened.wrap(network, { taskId: 'other', source: 'browser' })(
        'https://model.invalid',
        request(),
      ),
    ).rejects.toThrow('MODEL_PROVIDER_COOLDOWN')
    expect(network).toHaveBeenCalledOnce()
    now += 60001
    await (await reopened.wrap(network, context)('https://model.invalid', request())).text()
    expect(network).toHaveBeenCalledTimes(2)
  },
)

it('requests streamed usage, reconciles provider tokens and logs only metadata', async () => {
  const { ledger, directory } = fixture()
  const fetcher = vi.fn(async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toMatchObject({
      max_tokens: 512,
      stream_options: { include_usage: true },
    })
    return stream()
  })
  await (
    await ledger.wrap(fetcher, context)('https://model.invalid/v1/chat/completions', request())
  ).text()
  expect(ledger.snapshot()).toMatchObject({ requests: 1, tokenUnits: 120 })
  const log = readFileSync(join(directory, 'model-usage.jsonl'), 'utf8')
  expect(log).toContain('"usageSource":"provider"')
  expect(log).not.toContain('private-api-canary')
  expect(log).not.toContain('private-prompt-canary')
  expect(log).toContain('task-1')
})

it('keeps the daily request cap across restart and different task IDs', async () => {
  const { ledger, directory, limits } = fixture({ maxRequestsPerDay: 1 })
  const fetcher = vi.fn(async () => stream())
  await (await ledger.wrap(fetcher, context)('https://model.invalid', request())).text()
  const reopened = new ModelUsageLedger(directory, limits)
  await expect(
    reopened.wrap(fetcher, { ...context, taskId: 'task-2' })('https://model.invalid', request()),
  ).rejects.toThrow('MODEL_DAY_REQUEST_LIMIT')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('reserves concurrent admissions atomically before either response is consumed', async () => {
  const { ledger } = fixture({ maxRequestsPerDay: 1 })
  const fetcher = vi.fn(async () => stream())
  const results = await Promise.allSettled(
    [1, 2].map((id) =>
      ledger.wrap(fetcher, { ...context, taskId: String(id) })('https://model.invalid', request()),
    ),
  )
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(fetcher).toHaveBeenCalledOnce()
  for (const result of results) if (result.status === 'fulfilled') await result.value.text()
})

it('retains conservative charges for missing usage and network failures', async () => {
  const { ledger } = fixture({ maxTokenUnitsPerTask: 1000 })
  const fetcher = vi.fn(
    async () =>
      new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  )
  await (await ledger.wrap(fetcher, context)('https://model.invalid', request())).text()
  expect(ledger.snapshot().tokenUnits).toBeGreaterThan(512)
  await expect(ledger.wrap(fetcher, context)('https://model.invalid', request())).rejects.toThrow(
    'MODEL_TASK_TOKEN_LIMIT',
  )
  expect(fetcher).toHaveBeenCalledOnce()
  const failed = fixture()
  await expect(
    failed.ledger.wrap(async () => {
      throw Error('network')
    }, context)('https://model.invalid', request()),
  ).rejects.toThrow('network')
  expect(failed.ledger.snapshot().requests).toBe(1)
  expect(failed.ledger.snapshot().tokenUnits).toBeGreaterThan(512)
})

it('cancels an interval wait without sending or charging another request', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const { ledger } = fixture({ minRequestIntervalMs: 1000 })
  const fetcher = vi.fn(async () => stream())
  await (await ledger.wrap(fetcher, context)('https://model.invalid', request())).text()
  const abort = new AbortController()
  const pending = ledger.wrap(fetcher, context)('https://model.invalid', request(abort.signal))
  const rejection = expect(pending).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(100)
  expect(fetcher).toHaveBeenCalledOnce()
  abort.abort()
  await rejection
  expect(ledger.snapshot().requests).toBe(1)
})

it('charges an aborted stream conservatively and cancels the upstream reader', async () => {
  const { ledger } = fixture()
  const abort = new AbortController()
  const cancel = vi.fn()
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  )
  const response = await ledger.wrap(fetcher, context)(
    'https://model.invalid',
    request(abort.signal),
  )
  const text = response.text()
  const rejection = expect(text).rejects.toThrow()
  abort.abort()
  await rejection
  expect(cancel).toHaveBeenCalledOnce()
  expect(ledger.snapshot().tokenUnits).toBeGreaterThan(512)
})

it('blocks unreadable ledgers and persistence failures before sending', async () => {
  const first = fixture()
  writeFileSync(join(first.directory, 'model-usage-state.json'), '{invalid')
  const reopened = new ModelUsageLedger(first.directory, first.limits)
  const fetcher = vi.fn(async () => stream())
  await expect(reopened.wrap(fetcher, context)('https://model.invalid', request())).rejects.toThrow(
    'MODEL_USAGE_STORAGE_UNAVAILABLE',
  )
  expect(readFileSync(join(first.directory, 'model-usage-state.json'), 'utf8')).toBe('{invalid')
  const second = fixture()
  mkdirSync(join(second.directory, 'model-usage-state.json'))
  await expect(
    second.ledger.wrap(fetcher, context)('https://model.invalid', request()),
  ).rejects.toThrow('MODEL_USAGE_STORAGE_UNAVAILABLE')
  expect(fetcher).not.toHaveBeenCalled()
})

it('blocks oversized context before the network and keeps a lifetime task cap across midnight', async () => {
  let now = Date.parse('2026-11-05T00:00:00Z')
  const { ledger } = fixture({ maxInputBytes: 1000, maxRequestsPerTask: 1 }, () => now)
  const fetcher = vi.fn(async () => stream())
  await expect(
    ledger.wrap(fetcher, context)('https://model.invalid', {
      ...request(),
      body: JSON.stringify({ model: 'test', messages: ['x'.repeat(2000)] }),
    }),
  ).rejects.toThrow('MODEL_INPUT_LIMIT')
  expect(fetcher).not.toHaveBeenCalled()
  await (await ledger.wrap(fetcher, context)('https://model.invalid', request())).text()
  now += 86400000
  await expect(ledger.wrap(fetcher, context)('https://model.invalid', request())).rejects.toThrow(
    'MODEL_TASK_REQUEST_LIMIT',
  )
  expect(ledger.snapshot().requests).toBe(0)
})

it.each([
  { usage: { input_tokens: 100, output_tokens: 20 } },
  { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } },
])('records actual usage from supported nonstreaming provider envelopes', async (envelope) => {
  const { ledger } = fixture()
  const response = await ledger.wrap(
    async () =>
      new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }),
    context,
  )('https://model.invalid', request())
  await response.text()
  expect(ledger.snapshot().tokenUnits).toBe(120)
})

it('reconciles configured prices and leaves unpriced requests explicitly identified', async () => {
  const priced = fixture({ inputYuanPerMillion: 2, outputYuanPerMillion: 8 })
  await (
    await priced.ledger.wrap(async () => stream(), context)('https://model.invalid', request())
  ).text()
  expect(priced.ledger.snapshot()).toMatchObject({
    estimatedCostYuan: 0.00036,
    pricingConfigured: true,
    unpricedRequests: 0,
  })
  const unpriced = fixture()
  await (
    await unpriced.ledger.wrap(async () => stream(), context)('https://model.invalid', request())
  ).text()
  expect(unpriced.ledger.snapshot()).toMatchObject({
    estimatedCostYuan: 0,
    pricingConfigured: false,
    unpricedRequests: 1,
  })
})

it.each([
  { maxCostYuanPerTask: 0.01, maxCostYuanPerDay: 10, code: 'MODEL_TASK_COST_LIMIT' },
  { maxCostYuanPerTask: 2, maxCostYuanPerDay: 0.01, code: 'MODEL_DAY_COST_LIMIT' },
])('blocks configured monetary budget overruns before sending', async ({ code, ...policy }) => {
  const { ledger } = fixture({
    ...policy,
    costLimitEnabled: true,
    inputYuanPerMillion: 1,
    outputYuanPerMillion: 40,
  })
  const fetcher = vi.fn(async () => stream())
  await expect(ledger.wrap(fetcher, context)('https://model.invalid', request())).rejects.toThrow(
    code,
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it('preserves reserved monetary charges across restart and task changes', async () => {
  const { ledger, directory, limits } = fixture({
    costLimitEnabled: true,
    maxCostYuanPerDay: 0.01,
    inputYuanPerMillion: 1,
    outputYuanPerMillion: 8,
  })
  const fetcher = vi.fn(
    async () =>
      new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  )
  for (const id of ['first', 'second'])
    await (
      await ledger.wrap(fetcher, { ...context, taskId: id })('https://model.invalid', request())
    ).text()
  const restarted = new ModelUsageLedger(directory, limits)
  await expect(
    restarted.wrap(fetcher, { ...context, taskId: 'third' })('https://model.invalid', request()),
  ).rejects.toThrow('MODEL_DAY_COST_LIMIT')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(restarted.snapshot().estimatedCostYuan).toBeGreaterThan(0.008)
})

it('keeps cumulative and monetary budgets disabled when the user opts out', async () => {
  const { ledger } = fixture({
    usageBudgetEnabled: false,
    costLimitEnabled: false,
    maxRequestsPerDay: 1,
    maxTokenUnitsPerTask: 1000,
    maxCostYuanPerDay: 0.01,
    inputYuanPerMillion: 1,
    outputYuanPerMillion: 40,
  })
  const fetcher = vi.fn(async () => new Response('{}'))
  for (let index = 0; index < 2; index++)
    await (await ledger.wrap(fetcher, context)('https://model.invalid', request())).text()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(ledger.snapshot().requests).toBe(2)
  expect(ledger.snapshot().tokenUnits).toBeGreaterThan(1000)
  expect(ledger.snapshot().estimatedCostYuan).toBeGreaterThan(0.01)
})

it('shares request accounting across cloud generation and analysis under the real task ID', async () => {
  const { ledger, directory } = fixture({ maxRequestsPerTask: 2 })
  let calls = 0
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content:
                  ++calls === 1
                    ? '连接成功'
                    : JSON.stringify({ summary: '分析完成', steps: [], uncertainties: [] }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  )
  const cloud = new CloudGateway(fetcher, ledger)
  const signal = new AbortController().signal
  cloud.bindTask(signal, 'real-task-id')
  const config = {
    protocol: 'openai' as const,
    name: 'test',
    model: 'test',
    baseUrl: 'https://model.invalid/v1',
  }
  await cloud.generate(config, 'test-key', '测试连接', '', signal, () => {})
  await cloud.analyze(config, 'test-key', { question: '测试分析', facts: [] }, signal)
  await expect(
    cloud.analyze(config, 'test-key', { question: '重复分析', facts: [] }, signal),
  ).rejects.toThrow('MODEL_TASK_REQUEST_LIMIT')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(ledger.snapshot().tokenUnits).toBe(240)
  const events = readFileSync(join(directory, 'model-usage.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(
    events
      .filter((event) => event.type === 'request')
      .every((event) => event.taskId === 'real-task-id'),
  ).toBe(true)
  expect(events.filter((event) => event.type === 'request').map((event) => event.source)).toEqual([
    'cloud_generate',
    'cloud_analysis',
  ])
})
