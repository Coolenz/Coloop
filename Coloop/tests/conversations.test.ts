import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ConversationService } from '../src/main/services/conversations'
import { withTaskIndicatorContext } from '../src/shared/control-indicator'
import type { ExecutionPolicy } from '../src/shared/conversations'
import type { Task } from '../src/shared/contracts'
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(initial: Task[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-conversation-test-'))
  directories.push(directory)
  const tasks = [...initial]
  let policy: ExecutionPolicy = { mode: 'cloud', cloudFallback: true }
  let blocker: string | undefined
  const options = {
    tasks: () => tasks,
    policy: () => policy,
    workspace: () => directory,
    busy: () => ({
      active: tasks.some((task) => task.status === 'running'),
      taskId: tasks.find((task) => task.status === 'running')?.id,
      reason: blocker,
    }),
    start: vi.fn((request, id, _policy: ExecutionPolicy) => {
      tasks.push({
        id,
        prompt: request.prompt,
        target: request.target,
        source: 'text',
        status: 'running',
        createdAt: new Date().toISOString(),
        answer: '',
        stage: '执行中',
        model: 'test',
      })
      return id
    }),
    append: vi.fn(),
    resume: vi.fn(async () => {}),
    history: vi.fn(async () => ({ entries: [] })),
    changed: vi.fn(),
  }
  const service = new ConversationService(directory, options)
  return {
    service,
    directory,
    options,
    tasks,
    setPolicy: (value: ExecutionPolicy) => {
      policy = value
    },
    block: (value?: string) => {
      blocker = value
    },
  }
}
describe('persistent task conversations', () => {
  it('persists per-chat permissions and freezes queued run permissions', async () => {
    const f = await fixture()
    f.service.pause(true)
    const id = f.service.create({ permissionMode: 'ask' })
    f.service.send({ conversationId: id, messageId: randomUUID(), text: '测试授权' })
    f.service.update({ id, permissionMode: 'full' })
    const restored = new ConversationService(f.directory, f.options)
    expect(restored.snapshot().conversations[0].permissionMode).toBe('full')
    expect(restored.snapshot().conversations[0].runs[0].policy.permissionMode).toBe('ask')
    restored.pause(false)
    expect(f.options.start.mock.calls[0][2].permissionMode).toBe('ask')
  })

  it('queues separate chats while binding supplements to the active task', async () => {
    const f = await fixture()
    const a = f.service.create({}),
      b = f.service.create({})
    const first = f.service.send({ conversationId: a, messageId: randomUUID(), text: '任务 A' })
    const second = f.service.send({ conversationId: b, messageId: randomUUID(), text: '任务 B' })
    f.service.send({ conversationId: a, messageId: randomUUID(), text: '只补充 A' })
    expect(f.options.start).toHaveBeenCalledTimes(1)
    expect(f.options.append).toHaveBeenCalledWith(first.runId, '只补充 A')
    expect(f.service.snapshot().queue).toEqual([second.runId])
    f.tasks[0].status = 'completed'
    f.tasks[0].answer = 'A 完成'
    f.service.tick()
    expect(f.options.start).toHaveBeenCalledTimes(2)
    expect(f.options.start.mock.calls[1][1]).toBe(second.runId)
  })
  it('deduplicates sends and captures the policy at admission', async () => {
    const f = await fixture()
    f.service.pause(true)
    const id = f.service.create({}),
      messageId = randomUUID()
    const input = { conversationId: id, messageId, text: '同一消息' }
    f.service.send(input)
    f.service.send(input)
    expect(f.service.snapshot().queue).toHaveLength(1)
    f.setPolicy({ mode: 'local', cloudFallback: false })
    f.service.pause(false)
    expect(f.options.start.mock.calls[0][2]).toEqual({
      mode: 'cloud',
      cloudFallback: true,
      permissionMode: 'auto',
    })
    expect(() => f.service.send({ ...input, text: '不同内容' })).toThrow('消息 ID')
  })
  it('starts another execution in the same chat with previous messages and result', async () => {
    const f = await fixture()
    const id = f.service.create({})
    f.service.send({ conversationId: id, messageId: randomUUID(), text: '创建文档' })
    f.service.send({ conversationId: id, messageId: randomUUID(), text: '署名小林' })
    f.tasks[0].status = 'completed'
    f.tasks[0].answer = '已保存报告.docx'
    f.service.tick()
    f.service.send({ conversationId: id, messageId: randomUUID(), text: '再加一段总结' })
    expect(f.service.snapshot().conversations).toHaveLength(1)
    expect(f.service.snapshot().conversations[0].runs).toHaveLength(2)
    expect(f.options.start.mock.calls[1][0].context).toContain('署名小林')
    expect(f.options.start.mock.calls[1][0].context).toContain('报告.docx')
  })
  it('restores drafts and pauses the queue behind interrupted work', async () => {
    const f = await fixture()
    const a = f.service.create({}),
      b = f.service.create({})
    const first = f.service.send({ conversationId: a, messageId: randomUUID(), text: 'A' })
    f.service.send({ conversationId: b, messageId: randomUUID(), text: 'B' })
    f.service.update({ id: b, draft: '未发送', scrollTop: 222 })
    f.service.dispose()
    f.tasks[0].status = 'failed'
    const reopened = new ConversationService(f.directory, f.options)
    reopened.tick()
    expect(reopened.snapshot().conversations.find((item) => item.id === b)?.draft).toBe('未发送')
    expect(f.options.start).toHaveBeenCalledTimes(1)
    reopened.cancel(first.runId!)
    reopened.tick()
    expect(f.options.start).toHaveBeenCalledTimes(2)
  })
  it('keeps queue waiting for unresolved effects and supports cancellation', async () => {
    const f = await fixture()
    f.block('操作结果等待确认')
    const id = f.service.create({})
    const run = f.service.send({ conversationId: id, messageId: randomUUID(), text: '等待' })
    expect(f.options.start).not.toHaveBeenCalled()
    f.service.cancel(run.runId!)
    f.block()
    f.service.tick()
    expect(f.options.start).not.toHaveBeenCalled()
  })
  it('retains task snapshots after legacy history is pruned', async () => {
    const task: Task = {
      id: randomUUID(),
      prompt: '旧任务',
      target: 'cloud',
      source: 'text',
      status: 'completed',
      createdAt: new Date().toISOString(),
      answer: '旧结果',
      stage: '已完成',
      model: 'legacy',
    }
    const f = await fixture([task])
    f.tasks.splice(0)
    f.service.tick()
    expect(f.service.snapshot().conversations[0].runs[0].task?.answer).toBe('旧结果')
  })
  it('bounds continuation input while retaining all earlier context for the native history tool', async () => {
    const f = await fixture()
    const id = f.service.create({})
    f.service.send({
      conversationId: id,
      messageId: randomUUID(),
      text: '第一轮',
      context: '早期资料' + 'a'.repeat(49000),
    })
    f.tasks[0].status = 'completed'
    f.tasks[0].answer = 'b'.repeat(20000)
    f.service.tick()
    const next = f.service.send({
      conversationId: id,
      messageId: randomUUID(),
      text: '继续',
      context: 'c'.repeat(50000),
    })
    expect(f.options.start.mock.calls[1][0].context.length).toBeLessThanOrEqual(50000)
    expect(f.options.start.mock.calls[1][0].intent).toBe('execute')
    expect((await f.service.contextPage(next.runId!, 0, 4000)).text).toContain('早期资料')
  })
  it('preserves draft and reading state after a supplement is rejected', async () => {
    const f = await fixture(),
      id = f.service.create({})
    f.service.send({ conversationId: id, messageId: randomUUID(), text: '正在执行' })
    f.service.update({
      id,
      draft: '补充内容',
      scrollTop: 0,
      followingLatest: false,
      expandedDetails: ['tool-a'],
    })
    f.options.append.mockImplementation(() => {
      throw new Error('等待问题回答')
    })
    expect(() =>
      f.service.send({ conversationId: id, messageId: randomUUID(), text: '补充内容' }),
    ).toThrow('等待问题回答')
    expect(f.service.snapshot().conversations[0]).toMatchObject({
      draft: '补充内容',
      followingLatest: false,
      expandedDetails: ['tool-a'],
    })
  })
})

it('publishes a running conversation rename synchronously for the island', async () => {
  const { service, tasks, options } = await fixture()
  const id = service.create({ title: '原标题' })
  service.send({ conversationId: id, messageId: randomUUID(), text: '整理资料' })
  let islandTitle: string | undefined
  options.changed.mockImplementation(() => {
    const task = tasks.find((entry) => entry.status === 'running')
    islandTitle = withTaskIndicatorContext(
      { mode: 'controlling' },
      task,
      service.titleOf(task?.id),
    ).title
  })
  service.update({ id, title: '正在进行的课程整理' })
  expect(islandTitle).toBe('正在进行的课程整理')
  expect(service.snapshot().conversations.find((entry) => entry.id === id)?.title).toBe(islandTitle)
})
