import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { TaskScheduler } from '../src/main/services/task-scheduler'
import type { Task, TaskRequest } from '../src/shared/contracts'

let directory: string
let scheduler: TaskScheduler
let now: number
let available: boolean
let tasks: Map<string, Task>
let dispatch: Mock<(request: TaskRequest, id: string) => string>
const request = () => ({
  runAt: new Date(now + 600000).toISOString(),
  timezone: 'Asia/Shanghai',
  request: {
    prompt: '处理触发时的测试销售表',
    target: 'cloud' as const,
    context: '',
    source: 'text' as const,
    intent: 'execute' as const,
  },
})
const makeScheduler = () =>
  new TaskScheduler({
    directory,
    available: () => available,
    findTask: (id) => tasks.get(id),
    dispatch,
    now: () => now,
    onChange: () => {},
  })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'coloop-scheduler-'))
  now = Date.parse('2026-11-05T00:00:00Z')
  available = true
  tasks = new Map()
  dispatch = vi.fn((request, id) => {
    tasks.set(id, {
      id,
      prompt: request.prompt,
      target: request.target,
      source: 'text',
      status: 'running',
      createdAt: new Date(now).toISOString(),
      answer: '',
      stage: '执行中',
      model: 'test',
    })
    return id
  })
  scheduler = makeScheduler()
})
afterEach(() => {
  scheduler.dispose()
  rmSync(directory, { recursive: true, force: true })
})

it('waits for the real due time and device, admits one stable UUID, and records final results', () => {
  const entry = scheduler.create(request())
  scheduler.tick()
  expect(dispatch).not.toHaveBeenCalled()
  now += 600000
  available = false
  scheduler.tick()
  expect(scheduler.snapshot().entries[0].status).toBe('waiting')
  available = true
  scheduler.tick()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(dispatch.mock.calls[0][1]).toBe(entry.taskId)
  tasks.get(entry.taskId)!.status = 'completed'
  scheduler.tick()
  expect(scheduler.snapshot().entries[0].status).toBe('completed')
  scheduler.dispose()
  scheduler = makeScheduler()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
})
it('persists future work, cancellation and its request without admitting early', () => {
  const entry = scheduler.create(request())
  scheduler.dispose()
  scheduler = makeScheduler()
  expect(scheduler.snapshot().entries[0].request.prompt).toBe(request().request.prompt)
  scheduler.cancel(entry.id)
  now += 600001
  scheduler.tick()
  expect(dispatch).not.toHaveBeenCalled()
  expect(scheduler.snapshot().entries[0].status).toBe('cancelled')
})
it('preserves an uncertain previous admission and never replays it', () => {
  const entry = scheduler.create(request())
  writeFileSync(
    join(directory, 'task-schedules.json'),
    JSON.stringify([{ ...entry, status: 'dispatching' }]),
  )
  scheduler.dispose()
  scheduler = makeScheduler()
  now += 600001
  scheduler.tick()
  scheduler.tick()
  expect(scheduler.snapshot().entries[0]).toMatchObject({
    status: 'unconfirmed',
    error: 'SCHEDULE_ADMISSION_UNCONFIRMED',
  })
  expect(dispatch).not.toHaveBeenCalled()
})
it('reconciles an admitted task when the dispatch callback loses its return', () => {
  dispatch.mockImplementation((request, id) => {
    tasks.set(id, {
      id,
      prompt: request.prompt,
      target: request.target,
      source: 'text',
      status: 'running',
      createdAt: new Date(now).toISOString(),
      answer: '',
      stage: '',
      model: '',
    })
    throw new Error('lost admission response')
  })
  scheduler.create(request())
  now += 600001
  scheduler.tick()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(scheduler.snapshot().entries[0].status).toBe('running')
})
it('keeps an unreadable store intact and refuses to overwrite it', () => {
  scheduler.dispose()
  writeFileSync(join(directory, 'task-schedules.json'), 'invalid retained data')
  scheduler = makeScheduler()
  expect(() => scheduler.create(request())).toThrow('SCHEDULE_STORE_UNREADABLE')
  expect(readFileSync(join(directory, 'task-schedules.json'), 'utf8')).toBe('invalid retained data')
})
it('rejects invalid timezone, past time and cancellation after admission', () => {
  expect(() => scheduler.create({ ...request(), timezone: 'Invalid/Zone' })).toThrow()
  expect(() => scheduler.create({ ...request(), runAt: new Date(now).toISOString() })).toThrow(
    'SCHEDULE_TIME_MUST_BE_FUTURE',
  )
  const entry = scheduler.create({ ...request(), sourceTaskId: randomUUID() })
  now += 600001
  scheduler.tick()
  expect(() => scheduler.cancel(entry.id)).toThrow('SCHEDULE_NOT_PENDING')
})
