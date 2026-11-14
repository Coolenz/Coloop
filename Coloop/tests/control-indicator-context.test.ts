import { describe, expect, it } from 'vitest'
import { withTaskIndicatorContext } from '../src/shared/control-indicator'
import type { Task } from '../src/shared/contracts'
const task: Task = {
  id: 'active-run',
  prompt: '整理今天的课程资料',
  target: 'cloud',
  source: 'text',
  status: 'running',
  createdAt: '2026-11-08T00:00:00Z',
  answer: '',
  stage: '正在连接模型',
  model: 'DeepSeek',
}
describe('island task context', () => {
  it('shows the home title from admission, before proactive execution starts', () => {
    const state = withTaskIndicatorContext({ mode: 'idle', title: 'Coloop' }, task, '课程整理')
    expect(state).toMatchObject({
      mode: 'controlling',
      taskId: task.id,
      title: '课程整理',
      detail: task.stage,
    })
  })
  it('retains the title while native desktop control takes priority', () => {
    expect(
      withTaskIndicatorContext({ mode: 'controlling', sessionCount: 1 }, task, '课程整理'),
    ).toMatchObject({ title: '课程整理', sessionCount: 1, taskId: task.id })
  })
  it('uses a renamed title immediately and keeps question content', () => {
    const state = {
      mode: 'question' as const,
      taskId: task.id,
      questionId: 'q',
      content: '请选择',
      choices: ['继续'],
    }
    expect(withTaskIndicatorContext(state, task, '新标题')).toMatchObject({
      ...state,
      title: '新标题',
    })
  })
  it('replaces an earlier result when the next task begins', () => {
    expect(
      withTaskIndicatorContext(
        { mode: 'failed', taskId: 'old', title: '旧任务', content: '旧结果', error: '旧错误' },
        task,
        '新任务',
      ),
    ).toMatchObject({ mode: 'controlling', title: '新任务', content: '', error: undefined })
  })
  it('preserves stop and unknown safety states and completed conversation titles', () => {
    for (const mode of ['stopping', 'unconfirmed'] as const)
      expect(withTaskIndicatorContext({ mode }, task, '课程整理').mode).toBe(mode)
    expect(
      withTaskIndicatorContext(
        { mode: 'completed', taskId: task.id },
        { ...task, status: 'completed', answer: '已整理' },
        '课程整理',
      ),
    ).toMatchObject({ mode: 'completed', title: '课程整理', content: '已整理' })
  })
  it('keeps external agent context and supports tasks without a conversation', () => {
    const state = { mode: 'controlling' as const, title: 'Auto Agent Work' }
    expect(withTaskIndicatorContext(state, undefined)).toBe(state)
    expect(withTaskIndicatorContext({ mode: 'idle' }, task).title).toBe(task.prompt)
  })
})
