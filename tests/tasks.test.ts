import { describe, it, expect, vi } from 'vitest'
import { TaskService } from '../src/main/services/tasks'
import { shellQuote, fingerprintOf } from '../src/main/infrastructure/board'
import type { AppStore } from '../src/main/infrastructure/store'
import type { CloudGateway } from '../src/main/infrastructure/cloud'
import type { BoardGateway } from '../src/main/infrastructure/board'

const request = { prompt: 'test', context: '', target: 'cloud' as const, source: 'text' as const }
function setup(generate: (...args: any[]) => Promise<string>, screen = async () => 'screen text') {
  const store = {
    tasks: [],
    config: { provider: { model: 'test' } },
    apiKey: 'key',
    persist: vi.fn(),
  } as unknown as AppStore
  const cloud = { generate } as CloudGateway
  const board = { generate } as unknown as BoardGateway
  return { store, service: new TaskService(store, cloud, board, screen, vi.fn()) }
}
describe('task lifecycle', () => {
  it('prevents duplicate concurrent jobs and records completion', async () => {
    let finish!: (value: string) => void
    const { service, store } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    service.start(request)
    expect(() => service.start(request)).toThrow('已有任务')
    finish('done')
    await vi.waitFor(() => expect(store.tasks[0].status).toBe('completed'))
    expect(store.tasks[0].answer).toBe('done')
    expect(service.running).toBe(false)
  })
  it('stops an active job and does not turn it into completed', async () => {
    const { service, store } = setup(
      async (...args) =>
        new Promise((_resolve, reject) =>
          args[4].addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          ),
        ),
    )
    const id = service.start(request)
    service.cancel(id)
    await vi.waitFor(() => expect(store.tasks[0].status).toBe('cancelled'))
    expect(service.running).toBe(false)
  })
  it('does not contact a provider if OCR fails', async () => {
    const generate = vi.fn().mockResolvedValue('answer')
    const { service, store } = setup(generate, async () => {
      throw new Error('OCR failed')
    })
    service.start({ ...request, source: 'screen' })
    await vi.waitFor(() => expect(store.tasks[0].status).toBe('failed'))
    expect(generate).not.toHaveBeenCalled()
    expect(store.tasks[0].error).toBe('OCR failed')
  })
  it('treats shell metacharacters and quotes in a user prompt as literal data', () => {
    expect(shellQuote("it's $(whoami); `touch x`\nnext")).toBe(
      "'it'\\''s $(whoami); `touch x`\nnext'",
    )
    expect(fingerprintOf(Buffer.from('example'))).toHaveLength(43)
  })
  it('includes both attached text and live screen context', async () => {
    const generate = vi.fn().mockResolvedValue('answer')
    const { service, store } = setup(generate)
    service.start({ ...request, context: 'attached text', source: 'screen' })
    await vi.waitFor(() => expect(store.tasks[0].status).toBe('completed'))
    expect(generate.mock.calls[0][3]).toBe('attached text\n\nscreen text')
  })
  it('rolls back cleanly when the initial task record cannot be saved', () => {
    const generate = vi.fn().mockResolvedValue('answer')
    const { service, store } = setup(generate)
    vi.mocked(store.persist).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => service.start(request)).toThrow('disk full')
    expect(service.running).toBe(false)
    expect(store.tasks).toEqual([])
    expect(generate).not.toHaveBeenCalled()
  })
})
