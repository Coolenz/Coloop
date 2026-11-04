import { describe, it, expect, vi } from 'vitest'
import { TaskService } from '../src/main/services/tasks'
import type { AppStore } from '../src/main/infrastructure/store'
import type { BoardGateway } from '../src/main/infrastructure/board'
import type { CloudGateway } from '../src/main/infrastructure/cloud'
const request = {
  prompt: '打开 Edge 收集 Bilibili 视频',
  context: '',
  target: 'rk' as const,
  source: 'text' as const,
}
function fixture() {
  const store = {
    tasks: [],
    persist: vi.fn(),
    config: { provider: { model: 'cloud' } },
    apiKey: '',
  } as unknown as AppStore
  const board = {
    state: { qwenReady: true, modelPrivacyReady: true, model: 'rk' },
    generate: vi.fn(
      async (
        _prompt: string,
        _context: string,
        _signal: AbortSignal,
        _update: (text: string) => void,
      ) => '我不能控制设备',
    ),
    privacyAgent: vi.fn(async () => '{"decision":"execute","feedback":"实际调用工具完成目标"}'),
  }
  const execute = vi.fn(
    async (_id: string, _goal: string, _signal: AbortSignal, _stage: (text: string) => void) =>
      '屏幕确认得到十个视频',
  )
  const screen = vi.fn(async () => 'screen')
  const service = new TaskService(
    store,
    {} as CloudGateway,
    board as unknown as BoardGateway,
    screen,
    vi.fn(),
    execute,
  )
  return { service, store, board, execute, screen }
}
describe('unified task feedback loop', () => {
  it('recovers an inability reply through tools under the original task identity', async () => {
    const f = fixture()
    f.board.privacyAgent.mockResolvedValueOnce('{"decision":"revise","feedback":"先生成候选回复"}')
    const id = f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.store.tasks).toHaveLength(1)
    expect(f.execute.mock.calls[0][0]).toBe(id)
    expect(f.execute.mock.calls[0][1]).toContain(request.prompt)
    expect(f.execute.mock.calls[0][1]).toContain('实际调用工具完成目标')
    expect(f.store.tasks[0].answer).toBe('屏幕确认得到十个视频')
  })
  it('runs an operation without requiring a successful text answer first', async () => {
    const f = fixture()
    f.board.generate.mockRejectedValue(new Error('answer generation failed'))
    f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.board.generate).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('does not publish the inability reply or finish while tools are still running', async () => {
    const f = fixture()
    let finish!: (value: string) => void
    f.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    f.service.start(request)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled())
    expect(f.store.tasks[0].status).toBe('running')
    expect(f.store.tasks[0].answer).toBe('')
    finish('verified result')
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
  })
  it('regenerates incomplete answers with feedback before accepting completion', async () => {
    const f = fixture()
    f.board.privacyAgent
      .mockResolvedValueOnce('{"decision":"revise","feedback":"先回答问题"}')
      .mockResolvedValueOnce('{"decision":"revise","feedback":"补充遗漏的信息"}')
      .mockResolvedValueOnce('{"decision":"complete","feedback":"已满足目标"}')
    f.board.generate.mockResolvedValueOnce('partial').mockResolvedValueOnce('complete answer')
    f.service.start({ ...request, prompt: '解释这段文字' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.board.generate.mock.calls[1][0]).toContain('补充遗漏的信息')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.tasks[0].answer).toBe('complete answer')
  })
  it('retries malformed completion checks instead of completing or failing the task', async () => {
    const f = fixture()
    f.board.privacyAgent.mockResolvedValueOnce('我不能使用工具')
    f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.board.privacyAgent).toHaveBeenCalledTimes(2)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps cancellation effective during execution feedback', async () => {
    const f = fixture()
    f.execute.mockImplementation(
      async (_id, _goal, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), {
            once: true,
          })
        }),
    )
    const id = f.service.start(request)
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled())
    f.service.cancel(id)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('cancelled'))
    expect(f.store.tasks[0].answer).toBe('')
  })
})
