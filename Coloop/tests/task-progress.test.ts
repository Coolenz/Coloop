import { expect, it } from 'vitest'
import { projectTaskProgress } from '../src/main/domain/task-progress'
import type { ScheduledTask, Task } from '../src/shared/contracts'

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  prompt: 'private goal',
  target: 'cloud',
  source: 'text',
  status: 'completed',
  createdAt: '2026-11-05T01:00:00Z',
  finishedAt: '2026-11-05T02:00:00Z',
  answer: '已完成。产物 D:/test/日报.pdf',
  stage: '已完成',
  model: 'test',
}
const schedule: ScheduledTask = {
  id: 'schedule-id',
  taskId: task.id,
  runAt: '2026-11-05T01:30:00+08:00',
  timezone: 'Asia/Shanghai',
  createdAt: task.createdAt,
  status: 'pending',
  request: { prompt: 'goal', target: 'cloud', context: '', source: 'text' },
}

it('projects the actual final path once under the scheduled business UUID on every refresh', () => {
  const result = projectTaskProgress([task], [schedule])
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ sessionHandle: task.id, at: task.finishedAt })
  expect(result[0].text).toContain('D:/test/日报.pdf')
  expect(result[0].text).not.toContain('private goal')
  expect(projectTaskProgress([task], [schedule])).toEqual(result)
})
it('exposes the future UUID and exact time before admission and bounds wire sizes', () => {
  expect(projectTaskProgress([], [schedule])[0].text).toContain(schedule.runAt)
  const long = projectTaskProgress([{ ...task, answer: '字'.repeat(4000) }], [])
  expect(long[0].text.length).toBe(2000)
})
it('keeps legacy non-UUID history from invalidating the handset snapshot contract', () => {
  expect(projectTaskProgress([{ ...task, id: 'legacy-local-id' }, task], [])).toHaveLength(1)
})
