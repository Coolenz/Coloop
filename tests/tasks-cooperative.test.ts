import { describe, expect, it, vi } from 'vitest'
import { TaskService } from '../src/main/services/tasks'
import { localAgentPolicies } from '../src/main/services/cooperative'
import type { AppStore } from '../src/main/infrastructure/store'
import type { BoardGateway } from '../src/main/infrastructure/board'
import type { CloudGateway } from '../src/main/infrastructure/cloud'

function fixture() {
  const store = {
    tasks: [],
    config: { provider: { model: 'synthetic-cloud' } },
    apiKey: 'synthetic-key',
    persist: vi.fn(),
  } as unknown as AppStore
  const board = {
    state: { qwenReady: true, modelPrivacyReady: true, model: 'synthetic-rk' },
    generate: vi.fn(),
    privacyAgent: vi.fn(async (system: string, input: string) => {
      if (system === localAgentPolicies.route) return '{"route":"cloud"}'
      if (system === localAgentPolicies.identify) return '[]'
      if (system === localAgentPolicies.sanitize)
        return JSON.stringify([{ id: JSON.parse(input).spans[0].id }])
      if (system === localAgentPolicies.verify) return '{"safe":true}'
      if (system === localAgentPolicies.final)
        return JSON.stringify({
          entity_ids: Object.keys(JSON.parse(input).local_entities),
          answer: '已结合本地信息完成分析',
        })
      return '已结合本地信息完成分析'
    }),
  }
  const cloud = {
    generate: vi.fn(),
    analyze: vi.fn(
      async (
        _config: unknown,
        _key: string,
        _projection: { question: string; facts: string[] },
      ) => ({
        summary: '未发布的中间结论',
        steps: [],
        uncertainties: [],
      }),
    ),
  }
  const service = new TaskService(
    store,
    cloud as unknown as CloudGateway,
    board as unknown as BoardGateway,
    async () => '本次屏幕内容',
    vi.fn(),
  )
  return { store, board, cloud, service }
}

describe('cooperative task lifecycle and legacy ingress', () => {
  it.each(['hybrid', 'cloud'] as const)(
    'uses the private pipeline for %s and never calls direct cloud generation',
    async (target) => {
      const f = fixture()
      f.service.start({ target, prompt: '请分析', context: '', source: 'text' })
      expect(() => f.service.start({ target, prompt: 'x', context: '', source: 'text' })).toThrow(
        '已有任务',
      )
      await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
      expect(f.cloud.analyze).toHaveBeenCalledTimes(1)
      expect(f.cloud.generate).not.toHaveBeenCalled()
      expect(f.store.tasks[0].answer).toBe('已结合本地信息完成分析')
      expect(JSON.stringify(f.store.tasks)).not.toContain('未发布的中间结论')
      expect(JSON.stringify(f.store.tasks)).not.toContain('private_values')
    },
  )
  it('requires privacy-capable RK before creating a cooperative history record', () => {
    const f = fixture()
    f.board.state.modelPrivacyReady = false
    expect(() =>
      f.service.start({ target: 'hybrid', prompt: 'x', context: '', source: 'text' }),
    ).toThrow('日志隐私保护')
    expect(f.store.tasks).toEqual([])
    expect(f.cloud.generate).not.toHaveBeenCalled()
    expect(f.cloud.analyze).not.toHaveBeenCalled()
  })
  it('records the rendered local identity without sending it or its mapping to the cloud', async () => {
    const f = fixture()
    f.service.start({
      target: 'hybrid',
      prompt: '请分析<private>CLIENT-A97F</private>',
      context: '',
      source: 'text',
    })
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('completed'))
    expect(f.store.tasks[0].answer).toBe('CLIENT-A97F：已结合本地信息完成分析')
    expect(f.cloud.analyze).toHaveBeenCalledTimes(1)
    const projection = JSON.stringify(f.cloud.analyze.mock.calls[0][2])
    expect(projection).not.toContain('CLIENT-A97F')
    expect(projection).not.toContain('local_entities')
    expect(projection).not.toContain(f.store.tasks[0].answer)
    expect(f.cloud.generate).not.toHaveBeenCalled()
  })
  it('does not publish a late cloud analysis or begin final RK processing after cancellation', async () => {
    const f = fixture()
    let finish!: () => void
    f.cloud.analyze.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { summary: '私密中间结果', steps: [], uncertainties: [] }
    })
    const id = f.service.start({ target: 'hybrid', prompt: 'x', context: '', source: 'text' })
    await vi.waitFor(() => expect(f.cloud.analyze).toHaveBeenCalledTimes(1))
    expect(f.store.tasks[0].answer).toBe('')
    f.service.cancel(id)
    finish()
    await vi.waitFor(() => expect(f.store.tasks[0].status).toBe('cancelled'))
    expect(f.store.tasks[0].answer).toBe('')
    expect(f.board.privacyAgent).toHaveBeenCalledTimes(4)
  })
})
