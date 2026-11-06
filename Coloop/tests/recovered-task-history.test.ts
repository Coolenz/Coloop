import { describe, expect, it, vi } from 'vitest'
import { syncRecoveredTaskHistory } from '../src/main/services/recovered-task-history'
import type { Task } from '../src/shared/contracts'

const old = (): Task => ({
  id: 'same-id',
  prompt: 'keep goal',
  target: 'rk',
  source: 'text',
  execution: 'desktop',
  status: 'failed',
  createdAt: '2026-11-06T00:00:00Z',
  finishedAt: 'old',
  answer: 'old result',
  error: 'old failure',
  stage: 'failed',
  model: 'local',
})
describe('recovered task history', () => {
  it('tracks the same record through recovery and a verified terminal result', () => {
    const original = old()
    const store = { tasks: [original], persist: vi.fn() }
    syncRecoveredTaskHistory(
      store,
      { taskId: original.id, active: true, phase: 'queued' },
      '恢复中',
    )
    expect(store.tasks).toHaveLength(1)
    expect(store.tasks[0]).toMatchObject({
      id: original.id,
      status: 'running',
      prompt: original.prompt,
      createdAt: original.createdAt,
    })
    expect(store.tasks[0].error).toBeUndefined()
    expect(store.tasks[0].finishedAt).toBeUndefined()
    syncRecoveredTaskHistory(
      store,
      { taskId: original.id, active: false, phase: 'completed', summary: 'independently verified' },
      '已完成',
    )
    expect(store.tasks[0]).toMatchObject({ status: 'completed', answer: 'independently verified' })
    expect(store.tasks[0].finishedAt).not.toBe('old')
    expect(original.status).toBe('failed')
  })
  it.each(['failed', 'blocked', 'input_unknown', 'cancelled'])(
    'preserves the actual %s result instead of claiming success',
    (phase) => {
      const store = { tasks: [{ ...old(), status: 'running' as const }], persist: vi.fn() }
      syncRecoveredTaskHistory(
        store,
        { taskId: 'same-id', active: false, phase, error: 'not verified' },
        phase,
      )
      expect(store.tasks[0].status).toBe(phase === 'cancelled' ? 'cancelled' : 'failed')
    },
  )
  it('ignores unrelated records and restores in-memory state if persistence fails', () => {
    const store = {
      tasks: [old()],
      persist: vi.fn(() => {
        throw new Error('disk unavailable')
      }),
    }
    syncRecoveredTaskHistory(store, { taskId: 'other', active: true, phase: 'queued' }, 'queued')
    expect(store.persist).not.toHaveBeenCalled()
    const previous = store.tasks
    expect(() =>
      syncRecoveredTaskHistory(
        store,
        { taskId: 'same-id', active: true, phase: 'queued' },
        'queued',
      ),
    ).toThrow('disk unavailable')
    expect(store.tasks).toBe(previous)
  })
})
