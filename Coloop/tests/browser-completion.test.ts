import { expect, it, vi } from 'vitest'
import { createBrowserCompletion } from '../src/main/infrastructure/browser-completion'

it('uses only the selected model transport and propagates cancellation without retry', async () => {
  const abort = new AbortController()
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).model).toBe('local-rk')
    expect(JSON.parse(String(init?.body)).max_tokens).toBe(1024)
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('stopped', 'AbortError')),
        { once: true },
      )
    })
  })
  const complete = createBrowserCompletion(
    {
      provider: 'openai',
      id: 'local-rk',
      apiKey: 'local',
      baseURL: 'http://local.invalid/v1',
      toolCallEngine: 'prompt_engineering',
    },
    fetcher,
  )
  const pending = complete(
    { system: 'Extract fields', messages: [{ role: 'user', content: 'Synthetic source' }] },
    abort.signal,
  )
  const rejection = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  abort.abort()
  await rejection
  expect(fetcher).toHaveBeenCalledOnce()
})
