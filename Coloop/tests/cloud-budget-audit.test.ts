import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelUsageLedger } from '../src/main/infrastructure/model-usage'
import { CloudGateway } from '../src/main/infrastructure/cloud'
import { createBrowserCompletion } from '../src/main/infrastructure/browser-completion'

// Integration audit: use the real OpenAI adapter and shared ledger, with a
// synthetic transport only. These tests never access a real model endpoint.
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'coloop-cloud-budget-audit-'))
  directories.push(directory)
  return new ModelUsageLedger(directory, () => ({
    usageBudgetEnabled: true,
    maxRequestsPerTask: 2,
    maxRequestsPerDay: 3,
    maxOutputTokens: 512,
    minRequestIntervalMs: 0,
  }))
}
const config = {
  protocol: 'openai' as const,
  name: 'synthetic',
  baseUrl: 'https://model.invalid/v1',
  model: 'test-model',
}
const model = {
  provider: 'openai' as const,
  id: config.model,
  apiKey: 'synthetic-key',
  baseURL: config.baseUrl,
}
const extraction = {
  system: 'Return synthetic JSON only',
  messages: [{ role: 'user' as const, content: 'Synthetic source' }],
}

it.each([429, 500])('browser extraction does not silently retry HTTP %i', async (status) => {
  const ledger = fixture()
  const network = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ error: { message: 'synthetic failure', type: 'test', code: 'test' } }),
        { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } },
      ),
  )
  const complete = createBrowserCompletion(
    model,
    ledger.wrap(network, {
      taskId: 'browser-task',
      source: 'task_execution',
    }),
  )
  await expect(complete(extraction, new AbortController().signal)).rejects.toThrow()
  expect(network).toHaveBeenCalledTimes(1)
  expect(ledger.snapshot().requests).toBe(1)
})

it('browser extraction and CloudGateway share the same task cap before another network call', async () => {
  const ledger = fixture()
  const network = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.max_tokens).toBe(512)
    if (body.stream)
      return new Response(
        'data: {"id":"synthetic","choices":[{"delta":{"content":"{}"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: 'Synthetic analysis',
                steps: [],
                uncertainties: [],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  })
  const taskId = 'shared-task'
  const signal = new AbortController().signal
  const cloud = new CloudGateway(network, ledger)
  cloud.bindTask(signal, taskId)
  const complete = createBrowserCompletion(
    model,
    ledger.wrap(network, { taskId, source: 'task_execution' }),
  )
  expect(await complete(extraction, signal)).toBe('{}')
  await cloud.analyze(config, model.apiKey, { question: 'Synthetic analysis', facts: [] }, signal)
  await expect(
    cloud.relayText(config, model.apiKey, 'Synthetic system', 'Synthetic input', signal),
  ).rejects.toThrow('MODEL_TASK_REQUEST_LIMIT')
  expect(network).toHaveBeenCalledTimes(2)
  expect(ledger.snapshot()).toMatchObject({ requests: 2, tokenUnits: 36 })
})
