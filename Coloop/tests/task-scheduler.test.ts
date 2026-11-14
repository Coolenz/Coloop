import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { TaskScheduler } from '../src/main/services/task-scheduler'
import { NativeScheduler } from '../src/main/infrastructure/native-scheduler'
import type { Task, TaskRequest } from '../src/shared/contracts'

let directory: string
let scheduler: TaskScheduler
let now: number
let available: boolean
let tasks: Map<string, Task>
let dispatch: Mock<(request: TaskRequest, id: string) => string>
const request = () => ({
  runAt: new Date(now + 1200).toISOString(),
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
  now = Date.now()
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
afterEach(async () => {
  await scheduler.dispose()
  rmSync(directory, { recursive: true, force: true })
})

it('waits for the real due time and device, admits one stable UUID, and records final results', async () => {
  const entry = await scheduler.create(request())
  scheduler.tick()
  expect(dispatch).not.toHaveBeenCalled()
  available = false
  await vi.waitFor(() => expect(scheduler.snapshot().entries[0].status).toBe('waiting'), {
    timeout: 5000,
  })
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
  await scheduler.dispose()
  scheduler = makeScheduler()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
})
it('persists future work, cancellation and its request without admitting early', async () => {
  const entry = await scheduler.create({ ...request(), runAt: new Date(now + 60000).toISOString() })
  await scheduler.dispose()
  scheduler = makeScheduler()
  expect(scheduler.snapshot().entries[0].request.prompt).toBe(request().request.prompt)
  await scheduler.cancel(entry.id)
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  scheduler.tick()
  expect(dispatch).not.toHaveBeenCalled()
  expect(scheduler.snapshot().entries[0].status).toBe('cancelled')
})
it('preserves an uncertain previous admission and never replays it', async () => {
  const entry = await scheduler.create(request())
  writeFileSync(
    join(directory, 'task-schedules.json'),
    JSON.stringify([{ ...entry, status: 'dispatching' }]),
  )
  await scheduler.dispose()
  scheduler = makeScheduler()
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  scheduler.tick()
  scheduler.tick()
  expect(scheduler.snapshot().entries[0]).toMatchObject({
    status: 'unconfirmed',
    error: 'SCHEDULE_ADMISSION_UNCONFIRMED',
  })
  expect(dispatch).not.toHaveBeenCalled()
})
it('reconciles an admitted task when the dispatch callback loses its return', async () => {
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
  await scheduler.create(request())
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  scheduler.tick()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(scheduler.snapshot().entries[0].status).toBe('running')
})
it('keeps an unreadable store intact and refuses to overwrite it', async () => {
  await scheduler.dispose()
  writeFileSync(join(directory, 'task-schedules.json'), 'invalid retained data')
  scheduler = makeScheduler()
  await expect(scheduler.create(request())).rejects.toThrow('SCHEDULE_STORE_UNREADABLE')
  expect(readFileSync(join(directory, 'task-schedules.json'), 'utf8')).toBe('invalid retained data')
})
it('rejects invalid timezone, past time and cancellation after admission', async () => {
  await expect(scheduler.create({ ...request(), timezone: 'Invalid/Zone' })).rejects.toThrow()
  await expect(
    scheduler.create({ ...request(), runAt: new Date(now).toISOString() }),
  ).rejects.toThrow('SCHEDULE_TIME_MUST_BE_FUTURE')
  const entry = await scheduler.create({ ...request(), sourceTaskId: randomUUID() })
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  scheduler.tick()
  await expect(scheduler.cancel(entry.id)).rejects.toThrow('SCHEDULE_NOT_PENDING')
})

it('migrates an overdue legacy entry through native delivery without changing its task ID', async () => {
  const legacy = {
    ...request(),
    runAt: new Date(now - 1000).toISOString(),
    id: randomUUID(),
    taskId: randomUUID(),
    createdAt: new Date(now - 2000).toISOString(),
    status: 'pending',
  }
  await scheduler.dispose()
  writeFileSync(join(directory, 'task-schedules.json'), JSON.stringify([legacy]))
  scheduler = makeScheduler()
  scheduler.start()
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce(), { timeout: 5000 })
  expect(dispatch.mock.calls[0][1]).toBe(legacy.taskId)
  expect(scheduler.snapshot().entries[0].nativeId).toMatch(/^schedule-/)
  await scheduler.dispose()
  scheduler = makeScheduler()
  scheduler.start()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(dispatch).toHaveBeenCalledOnce()
})

it('reconnects one native process and retains one registration after an unexpected exit', async () => {
  available = false
  const entry = await scheduler.create({
    ...request(),
    runAt: new Date(Date.now() + 3000).toISOString(),
  })
  const native = (scheduler as any).native
  native.child.kill()
  await vi.waitFor(() => expect(scheduler.snapshot().runtime.state).toBe('recovering'))
  await vi.waitFor(() => expect(scheduler.snapshot().runtime.state).toBe('ready'), {
    timeout: 10000,
  })
  const records = await (scheduler as any).native.call('catalog')
  expect(records.filter((record: any) => record.sessionId === entry.id)).toHaveLength(1)
  await vi.waitFor(() => expect(scheduler.snapshot().entries[0].nativeDue).toBe(true), {
    timeout: 10000,
  })
  available = true
  scheduler.tick()
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
}, 20000)

it('reconciles a native create committed before its response was lost', async () => {
  available = false
  const original = NativeScheduler.prototype.call
  let lose = true
  const spy = vi.spyOn(NativeScheduler.prototype, 'call').mockImplementation(async function (
    this: NativeScheduler,
    method,
    params,
  ) {
    const result = await original.call(this, method, params)
    if (method === 'create' && lose) {
      lose = false
      ;(this as any).child.kill()
      throw new Error('NATIVE_SCHEDULER_DISCONNECTED')
    }
    return result
  })
  try {
    await expect(
      scheduler.create({ ...request(), runAt: new Date(Date.now() + 60000).toISOString() }),
    ).rejects.toThrow('OUTCOME_UNKNOWN')
    await vi.waitFor(() => expect(scheduler.snapshot().runtime.state).toBe('ready'), {
      timeout: 10000,
    })
    expect(await (scheduler as any).native.call('catalog')).toHaveLength(1)
    expect(scheduler.snapshot().entries[0].nativeId).toMatch(/^schedule-/)
    await scheduler.cancel(scheduler.snapshot().entries[0].id)
  } finally {
    spy.mockRestore()
  }
}, 20000)

it('reports missing runtime files and closes without a pending startup wait', async () => {
  await scheduler.dispose()
  scheduler = new TaskScheduler({
    directory,
    available: () => true,
    findTask: () => undefined,
    dispatch,
    onChange() {},
    runtime: { resources: join(directory, 'missing'), node: process.execPath },
  })
  await expect(scheduler.create(request())).rejects.toThrow('FILES_MISSING')
  expect(scheduler.snapshot().runtime.state).toBe('error')
  await scheduler.dispose()
})

it('finishes a durable cancellation after the native delete response is lost', async () => {
  const entry = await scheduler.create({
    ...request(),
    runAt: new Date(Date.now() + 60000).toISOString(),
  })
  const original = NativeScheduler.prototype.call
  let lose = true
  const spy = vi.spyOn(NativeScheduler.prototype, 'call').mockImplementation(async function (
    this: NativeScheduler,
    method,
    params,
  ) {
    const result = await original.call(this, method, params)
    if (method === 'delete' && lose) {
      lose = false
      ;(this as any).child.kill()
      throw new Error('NATIVE_SCHEDULER_DISCONNECTED')
    }
    return result
  })
  try {
    await expect(scheduler.cancel(entry.id)).rejects.toThrow('DISCONNECTED')
    await vi.waitFor(() => expect(scheduler.snapshot().entries[0].status).toBe('cancelled'), {
      timeout: 10000,
    })
    expect(await (scheduler as any).native.call('catalog')).toHaveLength(0)
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
  }
}, 20000)

it('does not dispatch twice when the scheduler exits during host admission', async () => {
  const accept = dispatch.getMockImplementation()!
  dispatch.mockImplementation((request, id) => {
    const value = accept(request, id)
    ;(scheduler as any).native.child.kill()
    return value
  })
  await scheduler.create({ ...request(), runAt: new Date(Date.now() + 1500).toISOString() })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), { timeout: 10000 })
  await vi.waitFor(() => expect(scheduler.snapshot().runtime.state).toBe('ready'), {
    timeout: 10000,
  })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  scheduler.tick()
  expect(dispatch).toHaveBeenCalledTimes(1)
}, 20000)
