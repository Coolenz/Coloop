import { describe, it, expect, vi } from 'vitest'
import { CloudGateway } from '../src/main/infrastructure/cloud'
const limits = { maxTokens: 8192, maxResponseBytes: 32768 }
const signal = () => new AbortController().signal
const config = {
  name: 'test',
  protocol: 'openai' as const,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
}
describe('script command generation budget', () => {
  it('reserves the command budget for actual content without changing analysis requests', async () => {
    const fetcher = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '{"type":"script"}' } }],
          }),
        ),
    )
    const cloud = new CloudGateway(fetcher as typeof fetch)
    await cloud.relayText(config, 'test-key', 'planner', 'goal', signal(), limits)
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(body.max_tokens).toBe(8192)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })
  it('does not send provider-specific options to other endpoints', async () => {
    const fetcher = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }),
        ),
    )
    await new CloudGateway(fetcher as typeof fetch).relayText(
      { ...config, baseUrl: 'https://example.com/v1' },
      'test-key',
      'planner',
      'goal',
      signal(),
      limits,
    )
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).thinking).toBeUndefined()
  })
  it('reports truncation without accepting or executing even parseable partial output', async () => {
    const fetcher = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
        ),
    )
    await expect(
      new CloudGateway(fetcher as typeof fetch).relayText(
        config,
        'test-key',
        'planner',
        'goal',
        signal(),
        limits,
      ),
    ).rejects.toThrow('RELAY_OUTPUT_TRUNCATED')
  })
})
