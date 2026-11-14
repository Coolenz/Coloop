import { describe, it, expect, vi } from 'vitest'
import { TaskService } from '../src/main/services/tasks'
import type { AppStore } from '../src/main/infrastructure/store'
import type { BoardGateway } from '../src/main/infrastructure/board'
import type { CloudGateway } from '../src/main/infrastructure/cloud'
const request = {
  prompt: '打开 Edge 收集 Bilibili 视频',
  context: '',
  target: 'cloud' as const,
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
    state: { status: 'connected', qwenReady: false, modelPrivacyReady: false, model: 'rk' },
    generate: vi.fn(
      async (
        _prompt: string,
        _context: string,
        _signal: AbortSignal,
        _update: (text: string) => void,
      ) => '我不能控制设备',
    ),
    privacyAgent: vi.fn(async () => '{"type":"execute"}'),
  }
  const execute = vi.fn(
    async (_id: string, _goal: string, _signal: AbortSignal, _stage: (text: string) => void) =>
      '屏幕确认得到十个视频',
  )
  const screen = vi.fn(async () => 'screen')
  const cloud = {
    generate: vi.fn(async (..._args: unknown[]) => '{"type":"execute"}'),
  }
  const service = new TaskService(
    store,
    cloud as unknown as CloudGateway,
    board as unknown as BoardGateway,
    screen,
    vi.fn(),
    execute,
  )
  return { service, store, board, cloud, execute, screen }
}
describe('cloud task planning and verified execution', () => {
  it('incorporates supplements accepted while the initial model is planning', async () => {
    const f = fixture()
    let reply!: (value: string) => void
    f.cloud.generate.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          reply = resolve
        }),
    )
    f.cloud.generate.mockResolvedValueOnce('{"type":"answer","answer":"已包含补充要求"}')
    const id = f.service.start(request)
    await vi.waitFor(() => expect(f.cloud.generate).toHaveBeenCalledOnce())
    f.service.append(id, '加入最新一周的数据')
    reply('{"type":"answer","answer":"首轮分析"}')
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.cloud.generate.mock.calls[1][2]).toContain('加入最新一周的数据')
    expect(f.store.tasks[0].answer).toBe('已包含补充要求')
  })
  it('plans explicit local-mode requests without contacting the cloud', async () => {
    const f = fixture()
    f.board.state.qwenReady = true
    f.board.state.modelPrivacyReady = true
    const id = f.service.start({ ...request, target: 'rk' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.cloud.generate).not.toHaveBeenCalled()
    expect(f.board.privacyAgent).toHaveBeenCalledOnce()
    expect(f.execute).toHaveBeenCalledWith(
      id,
      request.prompt,
      expect.any(AbortSignal),
      expect.any(Function),
      'rk',
      undefined,
      undefined,
      { mode: 'local', cloudFallback: false },
    )
  })
  it('answers local-mode questions without desktop input or cloud traffic', async () => {
    const f = fixture()
    f.board.privacyAgent.mockResolvedValueOnce('{"type":"answer","answer":"本地答案"}')
    f.service.start({ ...request, target: 'rk' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.store.tasks[0].answer).toBe('本地答案')
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.cloud.generate).not.toHaveBeenCalled()
  })
  it('keeps a hybrid task local even when a cloud credential is configured', async () => {
    const f = fixture()
    f.board.state.qwenReady = true
    f.board.state.modelPrivacyReady = true
    // An available cloud credential must not change hybrid planning into raw-data egress.
    Object.defineProperty(f.store, 'apiKey', { value: 'synthetic-key' })
    f.cloud.generate.mockRejectedValueOnce(new Error('模型服务返回 HTTP 402。'))
    const id = f.service.start({ ...request, target: 'hybrid' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.cloud.generate).not.toHaveBeenCalled()
    expect(f.board.privacyAgent).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls[0][0]).toBe(id)
  })
  it('runs explicit computer tasks through the execution entry and records their capability', async () => {
    const f = fixture()
    const id = f.service.start({ ...request, intent: 'execute' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.cloud.generate).not.toHaveBeenCalled()
    expect(f.board.generate).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(
      id,
      request.prompt,
      expect.any(AbortSignal),
      expect.any(Function),
      'cloud',
      undefined,
      undefined,
      { mode: 'cloud', cloudFallback: true },
    )
    expect(f.store.tasks[0].execution).toBe('desktop')
  })
  it('keeps a computer task running while its executor is confirming cancellation', async () => {
    const f = fixture()
    let finish!: (value: string) => void
    f.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const id = f.service.start({ ...request, intent: 'execute' })
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled())
    f.service.cancel(id)
    expect(f.store.tasks[0]).toMatchObject({
      status: 'running',
      stage: '正在停止操作，等待 RK 释放确认',
    })
    finish('late result')
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('cancelled'))
    expect(f.store.tasks[0].stage).toBe('操作已停止')
    expect(f.store.tasks[0].answer).toBe('')
  })
  it('retains an unknown hardware result as failed even after cancellation', async () => {
    const f = fixture()
    let fail!: (error: Error) => void
    f.execute.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const id = f.service.start({ ...request, intent: 'execute' })
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled())
    f.service.cancel(id)
    fail(new Error('INPUT_OUTCOME_UNKNOWN'))
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('failed'))
    expect(f.store.tasks[0]).toMatchObject({
      execution: 'desktop',
      error: 'INPUT_OUTCOME_UNKNOWN',
      stage: '输入结果未确认，请检查目标窗口',
    })
  })
  it('understands and executes without a local model under the original task identity', async () => {
    const f = fixture()
    const id = f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.store.tasks).toHaveLength(1)
    expect(f.execute.mock.calls[0][0]).toBe(id)
    expect(f.execute.mock.calls[0][1]).toContain(request.prompt)
    expect(f.store.tasks[0].answer).toBe('屏幕确认得到十个视频')
    expect(f.board.generate).not.toHaveBeenCalled()
    expect(f.board.privacyAgent).not.toHaveBeenCalled()
    expect(f.cloud.generate).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('answers questions in the cloud without requiring desktop input', async () => {
    const f = fixture()
    f.cloud.generate.mockResolvedValueOnce('{"type":"answer","answer":"完整答案"}')
    f.service.start({ ...request, prompt: '解释这段文字', source: 'screen', context: '附加资料' })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.board.generate).not.toHaveBeenCalled()
    expect(f.board.privacyAgent).not.toHaveBeenCalled()
    expect(f.cloud.generate.mock.calls[0][3]).toBe('附加资料\n\nscreen')
    expect(f.store.tasks[0].answer).toBe('完整答案')
  })
  it('does not publish a planned answer while tools are still running', async () => {
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
  it('retries malformed cloud decisions before any execution', async () => {
    const f = fixture()
    f.cloud.generate.mockResolvedValueOnce('我不能使用工具')
    f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.cloud.generate).toHaveBeenCalledTimes(2)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('does not redispatch an execution whose outcome is unknown', async () => {
    const f = fixture()
    f.execute.mockRejectedValue(new Error('INPUT_OUTCOME_UNKNOWN'))
    f.service.start(request)
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('failed'))
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.cloud.generate).toHaveBeenCalledTimes(1)
    expect(f.store.tasks[0].error).toBe('INPUT_OUTCOME_UNKNOWN')
  })
  it('keeps cancellation effective during execution', async () => {
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
  it('discards a late cloud decision after cancellation', async () => {
    const f = fixture()
    let finish!: (value: string) => void
    f.cloud.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const id = f.service.start(request)
    await vi.waitFor(() => expect(f.cloud.generate).toHaveBeenCalled())
    f.service.cancel(id)
    finish('{"type":"execute"}')
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('cancelled'))
    expect(f.execute).not.toHaveBeenCalled()
  })
})
