import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  retrieveAutoAgentMemory,
  persistAutoAgentFeedback,
  persistAutoAgentChoice,
} from '../src/main/services/auto-agent-memory'
import type { AutoAgentTask, AutoAgentFeedback } from '../src/shared/auto-agent-work'

it('follows an explicit feedback correction even when search returns only the older memory', async () => {
  const oldId = randomUUID(),
    newId = randomUUID()
  const old = {
    id: 'old-record',
    kind: 'task',
    source: 'agent',
    value: '以后先做方案确认。',
    tags: [
      'auto_work_feedback',
      'origin:direct-user',
      'feedback:' + oldId,
      'fbmeta:positive:1:1:1000',
    ],
  }
  const newer = {
    id: 'new-record',
    kind: 'task',
    source: 'agent',
    value: '修正：小修改直接做，不再先问。',
    tags: [
      'auto_work_feedback',
      'origin:direct-user',
      'feedback:' + newId,
      'supersedes:' + oldId,
      'fbmeta:negative:1:1:2000',
    ],
  }
  const records = [old, newer]
  const bridge = {
    catalog: async (input: Record<string, unknown>) =>
      result(
        Array.isArray(input.tags)
          ? records.filter((record) =>
              (input.tags as string[]).every((tag) => record.tags.includes(tag)),
            )
          : [old],
      ),
    get: async ({ ids }: Record<string, unknown>) =>
      result(records.filter((record) => (ids as string[]).includes(record.id))),
  }
  const memory = await retrieveAutoAgentMemory(task(), bridge)
  expect(memory.references).toHaveLength(1)
  expect(memory.references[0]).toMatchObject({ id: 'new-record', kind: 'feedback' })
  expect(memory.references[0].text).toContain('小修改直接做')
  expect(memory.references[0].text).toContain('1970-01-01T00:00:02.000Z')
  expect(JSON.stringify(memory)).not.toContain('以后先做方案确认')
})

it('persists exact journaled human choices but excludes automatic messages and credentials', async () => {
  const current = task()
  const event = {
    id: 'user-event',
    sessionId: current.session.id,
    instanceId: current.session.instanceId,
    revision: 2,
    type: 'user_input' as const,
    at: new Date().toISOString(),
    origin: 'user' as const,
    text: '本次选择先验证再交付。',
  }
  current.events.push(event)
  const choice = vi.fn(async () => ({ ok: true }))
  const bridge = { catalog: async () => result([]), get: async () => result([]), choice }
  await expect(persistAutoAgentChoice(current, event, bridge)).resolves.toBe('stored')
  expect(choice).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      event_id: event.id,
      source_quote: event.text,
      origin: 'user',
      source_task_id: current.id,
    }),
  )
  for (const altered of [
    { ...event, origin: 'coloop' as const },
    { ...event, actionId: randomUUID() },
    { ...event, text: '[Coloop Auto Agent Work:example] 继续' },
  ])
    await expect(persistAutoAgentChoice(current, altered, bridge)).resolves.toBe('ignored')
  const secret = { ...event, id: 'secret-event', text: 'api_key=never-save-this' }
  current.events.push(secret)
  await expect(persistAutoAgentChoice(current, secret, bridge)).resolves.toBe('ignored')
  expect(choice).toHaveBeenCalledOnce()
  await expect(
    persistAutoAgentChoice(current, { ...event, id: 'not-journaled' }, bridge),
  ).rejects.toThrow('AUTO_CHOICE_SOURCE_MISMATCH')
})

it('projects complete human choice groups as cases with task and event provenance', async () => {
  const current = task(),
    group = 'choice:' + 'a'.repeat(48)
  const tags = ['auto_work_choice', 'origin:direct-user', group]
  const records = [
    {
      id: 'meta',
      kind: 'task',
      tags: [...tags, 'part:0/1'],
      value: JSON.stringify({
        event_id: 'human-event',
        source_task_id: current.id,
        created_at: '2026-11-06T12:00:00Z',
        parts: 1,
      }),
    },
    { id: 'quote', kind: 'task', tags: [...tags, 'part:1/1'], value: '选择先核对实际安装结果。' },
  ]
  const memory = await retrieveAutoAgentMemory(current, {
    catalog: async () => result(records),
    get: async () => result(records),
  })
  expect(memory.references).toHaveLength(1)
  expect(memory.references[0].kind).toBe('case')
  expect(memory.references[0].text).toContain('human-event')
  expect(memory.references[0].text).toContain(current.id)
  expect(memory.references[0].text).toContain('选择先核对实际安装结果')
})

it('skips a malformed choice group while preserving independently valid memories', async () => {
  const group = 'choice:' + 'b'.repeat(48)
  const tags = ['auto_work_choice', 'origin:direct-user', group]
  const records = [
    { id: 'meta', kind: 'task', tags: [...tags, 'part:0/1'], value: '{broken metadata' },
    { id: 'quote', kind: 'task', tags: [...tags, 'part:1/1'], value: '先核验再交付。' },
    { id: 'valid', kind: 'preference', source: 'user_message', value: '使用中文回复。' },
  ]
  const memory = await retrieveAutoAgentMemory(task(), {
    catalog: async (input) =>
      result(input.tags ? records.filter((record) => record.tags?.includes(group)) : records),
    get: async ({ ids }) =>
      result(records.filter((record) => (ids as string[]).includes(record.id))),
  })
  expect(memory.status).toBe('matched')
  expect(memory.references).toEqual([{ id: 'valid', kind: 'explicit', text: '使用中文回复。' }])
})

function task(): AutoAgentTask {
  return {
    id: randomUUID(),
    version: 1,
    goal: '完成代码修改和本地验证',
    authorization: '当前工作区',
    acceptance: ['测试通过'],
    supplements: [],
    session: {
      id: 'session',
      source: 'chatgpt-desktop',
      sessionId: 'native',
      instanceId: 'instance',
      title: 'task',
      workspace: 'D:/Coloop',
      revision: 1,
      state: 'idle',
      lastSeenAt: new Date().toISOString(),
      capabilities: {
        events: 'verified',
        nativeContinue: 'verified',
        reply: 'unknown',
        stop: 'unknown',
        desktopWrite: 'unknown',
      },
    },
    state: 'watching',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEvaluatedRevision: -1,
    events: [],
    decisions: [],
    actions: [],
    feedback: [],
    costTaskId: 'cost',
  }
}
const result = (memories: unknown[], extra = {}) => ({ ok: true, result: { memories, ...extra } })

it('reads only ordinary catalog IDs and distinguishes explicit user preferences from inferred memories', async () => {
  const records = [
    { id: 'explicit', kind: 'preference', source: 'user_message', value: '验证后继续完成交付。' },
    { id: 'inferred', kind: 'preference', source: 'agent', value: '可能偏好较少询问。' },
    {
      id: 'private',
      kind: 'preference',
      category: 'private',
      key: 'private:credential:x',
      value: 'must never read',
    },
    { id: 'case', kind: 'procedure', source: 'agent', value: '代码修改后检查安装版。' },
  ]
  const get = vi.fn(async ({ ids }) => result(records.filter((record) => ids.includes(record.id))))
  const value = await retrieveAutoAgentMemory(task(), { catalog: async () => result(records), get })
  expect(get).toHaveBeenCalledWith({ ids: ['explicit', 'inferred', 'case'] })
  expect(value.references.map((record) => record.kind)).toEqual(['explicit', 'inferred', 'case'])
  expect(JSON.stringify(value)).not.toContain('must never read')
})

it('rejects unrelated ranked cases when only generic test, reply or installed-workflow words overlap', async () => {
  const current = task()
  current.goal =
    '这是安装版的独立验收任务。请推进已绑定的测试会话，让 Agent 仅回复 COLOOP_INSTALLED_DONE_91c7e4b6。允许通过原生或 RK 输入发送一次简短续推消息，不能操作其他聊天、文件、账户或网页。得到该字符串的实际回复后结束。'
  current.events.push({
    id: 'ready',
    sessionId: current.session.id,
    instanceId: current.session.instanceId,
    revision: 2,
    at: current.updatedAt,
    type: 'stopped',
    origin: 'agent',
    text: 'COLOOP_INSTALLED_READY_6f80a98b. This is an isolated acceptance conversation. I am ready to receive the next instruction in this same conversation and reply only with the requested code.',
  })
  const records = [
    {
      id: 'email-order',
      kind: 'task',
      value:
        'Read test order email from inbox, match sender to CRM, create ledger entry, then reply via original thread and verify persistence.',
    },
    {
      id: 'draft',
      kind: 'task',
      value:
        'Draft a read receipt reply for test email 无关活动简报 using verified preference memory. Save as draft, do not send.',
    },
    {
      id: 'form',
      kind: 'procedure',
      value:
        '已验证流程：Node.js 脚本调用 Playwright 启动 Edge，定位验收输入框填入 COLOOP_MODEL_WEB_OK，点击确认。最后独立脚本读回 JSON。条件：本机安装 Edge；仅适用于本地静态表单验收。',
    },
    {
      id: 'meeting',
      kind: 'task',
      value:
        'Draft reply to test meeting appointment using verified preferences, Chinese language and conclusion first.',
    },
    {
      id: 'video',
      kind: 'procedure',
      value:
        'RK agent 视频三连流程：点击视频，点赞、投币、收藏；input_sent 仅表示回执已发送，需检查实际业务结果。',
    },
  ]
  const catalog = vi.fn(async () => result(records))
  const memory = await retrieveAutoAgentMemory(current, {
    catalog,
    get: async () => result(records),
  })
  expect(memory).toMatchObject({ status: 'empty', references: [] })
  expect(catalog).toHaveBeenCalledOnce()
})

it('keeps relevant business cases and general explicit preferences without using prohibited topics', async () => {
  const current = task()
  current.goal = '核对发票金额并更新报销台账。不要发送邮件。'
  const records = [
    { id: 'invoice', kind: 'task', value: '发票金额应与报销台账逐条对齐，保存后读回。' },
    { id: 'mail', kind: 'task', value: '邮件处理结束后保存草稿并回复。' },
    {
      id: 'general',
      kind: 'preference',
      source: 'user_message',
      value: '默认使用中文，先给结论。',
    },
  ]
  const memory = await retrieveAutoAgentMemory(current, {
    catalog: async () => result(records),
    get: async () => result(records),
  })
  expect(memory.references.map(({ id, kind }) => ({ id, kind }))).toEqual([
    { id: 'invoice', kind: 'case' },
    { id: 'general', kind: 'explicit' },
  ])
})

it('does not recall a CRM ledger case when the actual ready response shares only new', async () => {
  const current = task()
  current.goal = 'Auto Agent Work acceptance: reply with COLOOP_FRESH_DONE_91c7e4b6.'
  current.events.push({
    id: 'fresh-ready',
    sessionId: current.session.id,
    instanceId: current.session.instanceId,
    revision: 2,
    at: current.updatedAt,
    type: 'stopped',
    origin: 'agent',
    text: 'FRESH_READY. The next instruction will provide a new completion code.',
  })
  const records = [
    {
      id: 'crm-ledger',
      kind: 'task',
      value:
        'Read test order email from inbox, match sender to CRM, create new ledger entry, then reply via original thread and verify persistence.',
    },
  ]
  const memory = await retrieveAutoAgentMemory(current, {
    catalog: async () => result(records),
    get: async () => result(records),
  })
  expect(memory).toMatchObject({ status: 'empty', references: [] })
})

it('still recalls a case sharing a single concrete ledger topic', async () => {
  const current = task()
  current.goal = 'Verify ledger.'
  const records = [{ id: 'ledger', kind: 'task', value: 'Create new ledger entry.' }]
  const memory = await retrieveAutoAgentMemory(current, {
    catalog: async () => result(records),
    get: async () => result(records),
  })
  expect(memory.references.map(({ id, kind }) => ({ id, kind }))).toEqual([
    { id: 'ledger', kind: 'case' },
  ])
})

it('does not treat offline or deferred retrieval as an empty memory search', async () => {
  const current = task(),
    get = vi.fn(async () => result([]))
  expect(
    await retrieveAutoAgentMemory(current, {
      catalog: async () => result([], { deferred: true }),
      get,
    }),
  ).toMatchObject({ status: 'unavailable', error: 'AUTO_MEMORY_DEFERRED' })
  expect(get).not.toHaveBeenCalled()
  expect(
    await retrieveAutoAgentMemory(current, {
      catalog: async () => {
        throw new Error('connection data that must not leak')
      },
      get,
    }),
  ).toMatchObject({ status: 'unavailable', error: 'AUTO_MEMORY_UNAVAILABLE' })
  expect(
    await retrieveAutoAgentMemory(current, { catalog: async () => result([]), get }),
  ).toMatchObject({ status: 'empty', references: [] })
})

it('reuses the memory version for identical live evidence, and rejects unsolicited body IDs', async () => {
  const current = task()
  const records = [{ id: 'one', kind: 'preference', source: 'user', value: '先运行测试。' }]
  const bridge = { catalog: async () => result(records), get: async () => result(records) }
  current.memory = await retrieveAutoAgentMemory(current, bridge)
  expect((await retrieveAutoAgentMemory(current, bridge)).version).toBe(current.memory.version)
  const changed = await retrieveAutoAgentMemory(current, {
    ...bridge,
    get: async () => result([{ ...records[0], value: '先运行相关测试。' }]),
  })
  expect(changed.version).toBe(current.memory.version + 1)
  expect(
    (
      await retrieveAutoAgentMemory(current, {
        ...bridge,
        get: async () => result([{ ...records[0], id: 'unsolicited' }]),
      })
    ).status,
  ).toBe('unavailable')
})

it('keeps task-only feedback local and writes future feedback as direct-source feedback', async () => {
  const current = task()
  const feedback: AutoAgentFeedback = {
    id: randomUUID(),
    taskId: current.id,
    rating: 'negative',
    reason: '以后先验证安装版再报告完成。',
    scope: 'task',
    createdAt: new Date().toISOString(),
    attribution: 'pending',
  }
  current.feedback.push(feedback)
  const writer = vi.fn(async () => ({ ok: true }))
  const bridge = { catalog: async () => result([]), get: async () => result([]), feedback: writer }
  await persistAutoAgentFeedback(current, feedback, bridge)
  expect(writer).not.toHaveBeenCalled()
  feedback.scope = 'future'
  await persistAutoAgentFeedback(current, feedback, bridge)
  expect(writer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      scope: 'future',
      source_quote: feedback.reason,
      feedback_id: feedback.id,
      source_task_id: current.id,
    }),
  )
  await expect(
    persistAutoAgentFeedback(current, { ...feedback, reason: 'model invented preference' }, bridge),
  ).rejects.toThrow('AUTO_FEEDBACK_SOURCE_MISMATCH')
})

it('never uses an incomplete feedback fragment as a complete preference', async () => {
  const id = randomUUID()
  const partial = {
    id: 'part-1',
    kind: 'task',
    source: 'agent',
    key: 'feedback:coloop:' + id + ':1',
    tags: ['auto_work_feedback', 'origin:direct-user', 'feedback:' + id, 'part:1/2'],
    value: '建议自动部署，但是',
  }
  expect(
    await retrieveAutoAgentMemory(task(), {
      catalog: async () => result([partial]),
      get: async () => result([partial]),
    }),
  ).toMatchObject({ status: 'empty', references: [] })
})
