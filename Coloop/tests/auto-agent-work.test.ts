import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutoAgentWorkService,
  type AutoAgentWorkOptions,
} from '../src/main/services/auto-agent-work'
import type {
  AutoAgentDecisionOutput,
  AutoAgentAction,
  AutoAgentDraftRecoveryProof,
  AutoAgentEvent,
  AutoAgentSession,
} from '../src/shared/auto-agent-work'

let directory: string
const services: AutoAgentWorkService[] = []
const testRoot = resolve('.cache/tmp/auto-agent-work-tests')
beforeEach(async () => {
  await mkdir(testRoot, { recursive: true })
  directory = await mkdtemp(join(testRoot, 'case-'))
})
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  await settle()
  if (!resolve(directory).startsWith(testRoot + sep)) throw new Error('INVALID_TEST_CLEANUP')
  await rm(directory, { recursive: true, force: true })
})
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const wait: AutoAgentDecisionOutput = {
  action: 'wait',
  reason: '正在运行，等待新证据',
  evidence: [],
}
const proceed: AutoAgentDecisionOutput = {
  action: 'continue',
  reason: '测试尚未执行',
  message: '运行相关测试并报告实际结果。',
  expectedChange: '获得测试结果',
  evidence: [],
}
const recoveryProof = (action: AutoAgentAction): AutoAgentDraftRecoveryProof => {
  const text = `[Coloop Auto Agent Work:${action.id}]\n${action.message}`.replace(/\r\n/g, '\n')
  return {
    draftSha256: createHash('sha256').update(text).digest('hex'),
    draftLength: text.length,
    pasteReceipt: JSON.stringify({ outcome: 'unknown', release_confirmed: true }),
    sendAbsent: true,
  }
}
const completed = (changes: Partial<AutoAgentDecisionOutput> = {}): AutoAgentDecisionOutput => ({
  action: 'complete',
  reason: '所有要求已逐项核验',
  evidence: ['tests passed'],
  acceptance: {
    verdict: 'pass',
    requirements: [{ requirement: '测试通过', satisfied: true, evidence: '退出码0，回归测试通过' }],
    gaps: [],
    imperfections: [],
  },
  ...changes,
})
function fixture(
  patch: Partial<AutoAgentWorkOptions> = {},
  sessionPatch: Partial<AutoAgentSession> = {},
) {
  let session: AutoAgentSession = {
    id: 'chatgpt-1',
    source: 'chatgpt-desktop',
    instanceId: 'instance-1',
    sessionId: 'native-1',
    title: 'UI fixture',
    workspace: directory,
    turnId: 'turn-1',
    revision: 1,
    state: 'running',
    lastSeenAt: new Date().toISOString(),
    capabilities: {
      events: 'verified',
      nativeContinue: 'available',
      reply: 'unknown',
      stop: 'unknown',
      desktopWrite: 'unsupported',
    },
    ...sessionPatch,
  }
  const memory = vi.fn<AutoAgentWorkOptions['memory']>(async (task) => ({
    status: 'empty',
    references: [],
    version: task.version,
  }))
  const decide = vi.fn<AutoAgentWorkOptions['decide']>(async () => ({
    output: wait,
    model: 'decision-model',
  }))
  const dispatch = vi.fn<AutoAgentWorkOptions['dispatch']>(async () => ({
    status: 'confirmed',
    receipt: 'native-message-1',
  }))
  const feedback = vi.fn<NonNullable<AutoAgentWorkOptions['feedback']>>(async () => {})
  const invalidate = vi.fn()
  const options: AutoAgentWorkOptions = {
    directory,
    sessions: () => [session],
    hooks: () => ({ installed: true, trust: 'observed' }),
    memory,
    decide,
    channel: () => 'desktop',
    dispatch,
    stopAgent: async () => {},
    feedback,
    invalidate,
    ...patch,
  }
  const service = new AutoAgentWorkService(options)
  services.push(service)
  const create = () =>
    service.create({ sessionId: session.id, goal: '修复导出功能并验证', acceptance: ['测试通过'] })
  async function event(
    type: AutoAgentEvent['type'],
    patch: Partial<AutoAgentEvent> = {},
    next: Partial<AutoAgentSession> = {},
  ) {
    const value: AutoAgentEvent = {
      id: randomUUID(),
      sessionId: session.id,
      instanceId: session.instanceId,
      turnId: session.turnId,
      revision: session.revision + 1,
      type,
      at: new Date().toISOString(),
      origin: 'agent',
      ...patch,
    }
    session = {
      ...session,
      revision: value.revision,
      state: type === 'started' || type === 'progress' ? 'running' : 'idle',
      ...next,
    }
    await service.observe(value, session)
    return value
  }
  return {
    service,
    options,
    create,
    event,
    decide,
    dispatch,
    memory,
    feedback,
    invalidate,
    session: () => session,
    task: () => service.snapshot().tasks[0],
  }
}

describe('Auto Agent Work event-driven supervision', () => {
  it('automatically binds a new user task once, persists the switch and pauses on disable', async () => {
    const f = fixture()
    await f.event('user_input', { origin: 'user', text: 'disabled task' }, { state: 'running' })
    expect(f.service.snapshot().tasks).toHaveLength(0)
    f.service.setEnabled(true)
    await f.event('user_input', { origin: 'user', text: '实现导出并验证' }, { state: 'running' })
    expect(f.task().goal).toBe('实现导出并验证')
    expect(f.task().state).toBe('watching')
    await f.event('progress', { text: '正在修改文件' })
    expect(f.service.snapshot().tasks).toHaveLength(1)
    expect(f.task().events.at(-1)?.text).toBe('正在修改文件')
    expect(JSON.parse(readFileSync(join(directory, 'auto-agent-work.json'), 'utf8')).enabled).toBe(
      true,
    )
    f.service.setEnabled(false)
    expect(f.task().state).toBe('paused')
    expect(f.service.snapshot().enabled).toBe(false)
  })
  it('does not bind session startup or subagent activity', async () => {
    const f = fixture()
    f.service.setEnabled(true)
    await f.event('started', { text: 'SessionStart' })
    await f.event('user_input', { origin: 'user', agentId: 'child', text: '子任务' })
    expect(f.service.snapshot().tasks).toHaveLength(0)
  })

  it('recovers only on explicit resume, persists the same-action Enter claim, and waits for native confirmation', async () => {
    const recoverDraft = vi.fn<NonNullable<AutoAgentWorkOptions['recoverDraft']>>(
      async (task, action, _signal, claim) => {
        expect(action.status).toBe('unknown')
        claim(recoveryProof(action))
        const saved = JSON.parse(readFileSync(join(directory, 'auto-agent-work.json'), 'utf8'))
          .tasks[0]
        expect(saved.actions[0]).toMatchObject({
          id: action.id,
          status: 'dispatching',
          taskVersion: action.taskVersion,
          recovery: {
            taskVersion: task.version,
            eventRevision: task.session.revision,
            phase: 'send_claimed',
          },
        })
        expect(() => claim(recoveryProof(action))).toThrow('草稿恢复证据')
        return { status: 'accepted', receipt: 'same-action-send' }
      },
    )
    const receipt = { outcome: 'unknown', release_confirmed: true, error: 'INPUT_EFFECT_UNKNOWN' }
    const f = fixture({
      recoverDraft,
      dispatch: vi.fn(async () => {
        throw Object.assign(new Error('INPUT_EFFECT_UNKNOWN'), { receipt })
      }),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const action = f.task().actions[0]
    expect(action.receipt).toBe(JSON.stringify(receipt))
    expect(recoverDraft).not.toHaveBeenCalled()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(f.task().actions).toHaveLength(1)
    expect(f.task().actions[0]).toMatchObject({
      id: action.id,
      taskVersion: action.taskVersion,
      status: 'accepted',
    })
    expect(f.task().state).toBe('waiting_receipt')
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.options.dispatch).toHaveBeenCalledOnce()
    f.service.receipt(action.id, 'confirmed', 'native-receipt')
    expect(f.task().state).toBe('watching')
    await f.event(
      'receipt',
      { actionId: action.id, origin: 'coloop', turnId: 'turn-2' },
      { turnId: 'turn-2', state: 'running' },
    )
    expect(f.task().session.turnId).toBe('turn-2')
    expect(f.task().events.at(-1)?.actionId).toBe(action.id)
    expect(f.decide).toHaveBeenCalledOnce()
  })
  it('refuses a second resume and invalidates a pending recovery when paused', async () => {
    const held = deferred<void>()
    let entered = false
    const f = fixture({
      dispatch: vi.fn(async () => {
        throw new Error('INPUT_EFFECT_UNKNOWN')
      }),
      recoverDraft: async (_task, action, _signal, claim) => {
        await held.promise
        claim(recoveryProof(action))
        entered = true
        return { status: 'accepted' }
      },
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    expect(f.task().state).toBe('waiting_receipt') // UI is free while the driver still awaits foreground.
    await expect(f.service.update({ taskId: f.task().id, action: 'resume' })).rejects.toThrow(
      '原动作仍在处理中',
    )
    await f.service.update({ taskId: f.task().id, action: 'pause' })
    held.resolve()
    await settle()
    expect(entered).toBe(false)
    expect(f.task().state).toBe('paused')
    expect(f.task().actions[0].status).toBe('unknown')
  })
  it.each(['progress', 'user_input'] as const)(
    'refuses a recovery claim after a newer %s event',
    async (type) => {
      const held = deferred<void>()
      let entered = false
      const f = fixture({
        dispatch: vi.fn(async () => {
          throw new Error('INPUT_EFFECT_UNKNOWN')
        }),
        recoverDraft: async (_task, action, _signal, claim) => {
          await held.promise
          claim(recoveryProof(action))
          entered = true
          return { status: 'accepted' }
        },
      })
      f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
      f.create()
      await f.event('stopped')
      await settle()
      await f.service.update({ taskId: f.task().id, action: 'resume' })
      await f.event(type, { origin: type === 'user_input' ? 'user' : 'agent' })
      held.resolve()
      await settle()
      expect(entered).toBe(false)
      expect(f.task().actions[0].status).toBe('unknown')
      expect(f.task().actions[0].recovery).toBeUndefined()
      expect(f.decide).toHaveBeenCalledOnce()
      expect(f.task().state).toBe(type === 'user_input' ? 'paused' : 'needs_user')
    },
  )
  it('rejects changed requirements and an incorrect full-draft proof before recovery input', async () => {
    const recoverDraft = vi.fn<NonNullable<AutoAgentWorkOptions['recoverDraft']>>(
      async (_task, action, _signal, claim) => {
        claim({ ...recoveryProof(action), draftLength: 1 })
        return { status: 'accepted' }
      },
    )
    const f = fixture({
      recoverDraft,
      dispatch: vi.fn(async () => {
        throw new Error('INPUT_EFFECT_UNKNOWN')
      }),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.task().actions[0].recovery).toBeUndefined()
    await f.service.update({
      taskId: f.task().id,
      action: 'supplement',
      text: '现在禁止发送之前的消息',
    })
    await settle()
    recoverDraft.mockClear()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(recoverDraft).not.toHaveBeenCalled()
    expect(f.task().error).toContain('任务要求已变化')
  })
  it('keeps a lost recovery result unknown across restart and never infers send absence from failure', async () => {
    const f = fixture({
      dispatch: vi.fn(async () => {
        throw new Error('INPUT_EFFECT_UNKNOWN')
      }),
      recoverDraft: async (_task, action, _signal, claim) => {
        claim(recoveryProof(action))
        throw Object.assign(new Error('send transport lost'), {
          receipt: { outcome: 'unknown', command_id: action.id + ':send' },
        })
      },
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    const before = f.task().actions[0]
    expect(before.status).toBe('unknown')
    expect(before.recovery?.phase).toBe('send_claimed')
    f.service.dispose()
    const recoverDraft = vi.fn<NonNullable<AutoAgentWorkOptions['recoverDraft']>>(async () => {
      throw new Error('SEND_ALREADY_RECORDED')
    })
    const recovered = new AutoAgentWorkService({ ...f.options, recoverDraft })
    services.push(recovered)
    await recovered.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(recoverDraft).toHaveBeenCalledOnce()
    expect(recovered.snapshot().tasks[0].actions[0]).toMatchObject({
      id: before.id,
      status: 'unknown',
      recovery: before.recovery,
      receipt: before.receipt,
    })
    expect(recovered.snapshot().tasks[0].state).toBe('needs_user')
    expect(f.options.dispatch).toHaveBeenCalledOnce()
  })
  it.each([false, true])(
    'handles legacy action requirements without task-specific exceptions (supplement=%s)',
    async (hasSupplement) => {
      const f = fixture({
        dispatch: vi.fn(async () => {
          throw new Error('INPUT_EFFECT_UNKNOWN')
        }),
      })
      f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
      f.create()
      await f.event('stopped')
      await settle()
      f.service.dispose()
      const saved = JSON.parse(readFileSync(join(directory, 'auto-agent-work.json'), 'utf8'))
      delete saved.tasks[0].actions[0].requirementsHash
      if (hasSupplement) saved.tasks[0].supplements.push('要求已补充')
      writeFileSync(join(directory, 'auto-agent-work.json'), JSON.stringify(saved))
      const recoverDraft = vi.fn<NonNullable<AutoAgentWorkOptions['recoverDraft']>>(
        async (_task, action, _signal, claim) => {
          claim(recoveryProof(action))
          return { status: 'accepted' }
        },
      )
      const recovered = new AutoAgentWorkService({ ...f.options, recoverDraft })
      services.push(recovered)
      await recovered.update({ taskId: f.task().id, action: 'resume' })
      await settle()
      expect(recoverDraft).toHaveBeenCalledTimes(hasSupplement ? 0 : 1)
    },
  )
  it.each(['pause', 'unbind'] as const)(
    'preserves a synchronous %s before a queued idle-session evaluation starts',
    async (action) => {
      const f = fixture({}, { state: 'idle' })
      f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
      const id = f.create()
      await f.service.update({ taskId: id, action })
      await settle()
      expect(f.task().state).toBe(action === 'pause' ? 'paused' : 'unbound')
      expect(f.memory).not.toHaveBeenCalled()
      expect(f.decide).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.task().actions).toEqual([])
    },
  )
  it('does not start a queued evaluation after synchronous disposal', async () => {
    const f = fixture({}, { state: 'idle' })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    f.service.dispose()
    await settle()
    expect(f.task().state).toBe('paused')
    expect(f.memory).not.toHaveBeenCalled()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('waits if a running event wins the queued-evaluation gap, then evaluates the next stop', async () => {
    const f = fixture({}, { state: 'idle' })
    f.create()
    await f.event('started')
    await settle()
    expect(f.task().state).toBe('watching')
    expect(f.task().session.state).toBe('running')
    expect(f.memory).not.toHaveBeenCalled()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await f.event('stopped')
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
  })
  it('requires source approval and explicit resume, despite later progress or an early resume', async () => {
    const f = fixture()
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('question', { questionKind: 'approval' }, { state: 'awaiting_input' })
    await f.event('progress', { text: 'PostToolUse' }, { state: 'awaiting_input' })
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.task().pauseReason).toContain('原会话处理后显式恢复')
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.memory).not.toHaveBeenCalled()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    await f.event('started')
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.decide).not.toHaveBeenCalled()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.dispatch).toHaveBeenCalledOnce()
  })
  it('does not block an ordinary business question as a permission request', async () => {
    const f = fixture()
    f.decide.mockResolvedValue({ output: { ...proceed, action: 'reply' }, model: 'strong' })
    f.create()
    await f.event('question', { questionKind: 'business' }, { state: 'awaiting_input' })
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.dispatch).toHaveBeenCalledOnce()
    expect(f.task().state).toBe('watching')
  })
  it('invalidates an in-flight decision when the source requests permission', async () => {
    const decision = deferred<{ output: AutoAgentDecisionOutput; model: string }>()
    const f = fixture({ decide: vi.fn(async () => decision.promise) })
    f.create()
    await f.event('question', { questionKind: 'business' }, { state: 'awaiting_input' })
    await settle()
    const signal = vi.mocked(f.options.decide).mock.calls[0][1]
    await f.event('question', { questionKind: 'approval' }, { state: 'awaiting_input' })
    expect(signal.aborted).toBe(true)
    decision.resolve({ output: proceed, model: 'strong' })
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.task().decisions).toEqual([])
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('does not infer or dispatch when binding a session already awaiting source approval', async () => {
    const approval: AutoAgentEvent = {
      id: 'existing-approval',
      sessionId: 'chatgpt-1',
      instanceId: 'instance-1',
      turnId: 'turn-1',
      revision: 1,
      type: 'question',
      questionKind: 'approval',
      at: new Date().toISOString(),
      origin: 'agent',
      text: 'PermissionRequest',
    }
    const f = fixture(
      {
        events: () => [
          approval,
          {
            ...approval,
            id: 'later-progress',
            type: 'progress',
            questionKind: undefined,
            revision: 2,
          },
        ],
      },
      { state: 'awaiting_input', revision: 2 },
    )
    f.create()
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.memory).not.toHaveBeenCalled()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it('does not invoke models while a running task streams progress; duplicate and older events cannot repeat a decision', async () => {
    const f = fixture()
    f.create()
    for (let i = 0; i < 20; i++) await f.event('progress')
    await settle()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.memory).not.toHaveBeenCalled()
    const stop = await f.event('stopped')
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.memory).toHaveBeenCalledOnce()
    await f.service.observe(stop, f.session())
    await f.service.observe({ ...stop, id: randomUUID(), revision: stop.revision - 1 }, f.session())
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.task().state).toBe('watching')
  })
  it('ignores late previous-round completion and child-agent events', async () => {
    const f = fixture()
    f.create()
    await f.event('stopped', { turnId: 'old-turn' })
    await settle()
    expect(f.decide).not.toHaveBeenCalled()
    await f.event('stopped', { parentTurnId: 'parent', agentId: 'child' })
    await settle()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.task().events).toHaveLength(0)
  })
  it('has only one task owner per session, including while paused', async () => {
    const f = fixture()
    const id = f.create()
    expect(() => f.create()).toThrow('此会话已绑定任务')
    await f.service.update({ taskId: id, action: 'pause' })
    expect(() => f.create()).toThrow('此会话已绑定任务')
    await f.service.update({ taskId: id, action: 'unbind' })
    expect(() => f.create()).not.toThrow()
  })
  it('invalidates an in-flight decision when the user takes over', async () => {
    const pending = deferred<{ output: AutoAgentDecisionOutput; model: string }>()
    const f = fixture({ decide: vi.fn(async () => pending.promise) })
    f.create()
    await f.event('question')
    await settle()
    const signal = vi.mocked(f.options.decide).mock.calls[0][1]
    await f.event('user_input', { origin: 'user', text: '先暂停，我来处理。' })
    expect(signal.aborted).toBe(true)
    pending.resolve({ output: proceed, model: 'decision-model' })
    await settle()
    expect(f.task().state).toBe('paused')
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.task().decisions).toHaveLength(0)
  })
  it('waits after a DSH decision and does not start another run without a relevant new revision', async () => {
    const f = fixture({}, { state: 'idle' })
    f.create()
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    await settle()
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.task().state).toBe('watching')
  })
  it('marks a lost dispatch receipt unknown and never retries that write on a new stop', async () => {
    const f = fixture({
      dispatch: vi.fn(async () => {
        throw new Error('connection lost')
      }),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong-model' })
    f.create()
    await f.event('stopped')
    await settle()
    expect(f.task().actions[0].status).toBe('unknown')
    expect(f.task().state).toBe('needs_user')
    await f.event('stopped')
    await settle()
    expect(f.options.dispatch).toHaveBeenCalledTimes(1)
    expect(f.task().state).toBe('needs_user')
    expect(f.task().error).toContain('上一动作结果尚未核对')
  })
  it('exposes a proven unsent failure immediately and retries only after explicit resume', async () => {
    const f = fixture({
      dispatch: vi.fn(async () => {
        throw Object.assign(new Error('EDITOR_BINDING_CHANGED'), { notSent: true })
      }),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.task().actions[0].status).toBe('failed')
    expect(f.task().error).toContain('EDITOR_BINDING_CHANGED')
    await f.event('stopped')
    await settle()
    expect(f.options.dispatch).toHaveBeenCalledOnce()
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    await settle()
    expect(f.options.dispatch).toHaveBeenCalledTimes(2)
  })
  it('does not overwrite a user pause when a late dispatch reports an unsent failure', async () => {
    const result = deferred<{ status: 'failed' }>()
    const f = fixture({ dispatch: vi.fn(async () => result.promise) })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    await f.service.update({ taskId: f.task().id, action: 'pause' })
    result.resolve({ status: 'failed' })
    await settle()
    expect(f.task().state).toBe('paused')
    expect(f.task().actions[0].status).toBe('failed')
  })
  it('records a late native confirmation without resuming a user-paused task', async () => {
    const f = fixture({ dispatch: vi.fn(async () => ({ status: 'accepted' as const })) })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const actionId = f.task().actions[0].id
    await f.service.update({ taskId: f.task().id, action: 'pause' })
    await f.event('receipt', { actionId, origin: 'coloop' }, { state: 'running' })
    await settle()
    expect(f.task().actions[0].status).toBe('confirmed')
    expect(f.task().state).toBe('paused')
    expect(f.task().pauseReason).toBe('用户暂停自动推进')
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.options.dispatch).toHaveBeenCalledOnce()
  })
  it('surfaces an asynchronous failed receipt without waiting for another agent event', async () => {
    const f = fixture({ dispatch: vi.fn(async () => ({ status: 'accepted' as const })) })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    f.service.receipt(f.task().actions[0].id, 'failed', 'Native request rejected before submission')
    expect(f.task().state).toBe('needs_user')
    expect(f.task().error).toContain('Native request rejected before submission')
  })
  it.each(['failed', 'unknown'] as const)(
    'does not downgrade an asynchronous %s receipt when dispatch later acknowledges acceptance',
    async (status) => {
      const result = deferred<{ status: 'accepted' }>()
      const f = fixture({ dispatch: vi.fn(async () => result.promise) })
      f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
      f.create()
      await f.event('stopped')
      await settle()
      f.service.receipt(f.task().actions[0].id, status, 'authoritative delivery result')
      expect(f.task().state).toBe('needs_user')
      result.resolve({ status: 'accepted' })
      await settle()
      expect(f.task().actions[0]).toMatchObject({
        status,
        receipt: 'authoritative delivery result',
      })
      expect(f.task().state).toBe('needs_user')
      expect(f.options.dispatch).toHaveBeenCalledOnce()
    },
  )
  it('rejects completion while a previous action has no confirmed outcome', async () => {
    const f = fixture({ dispatch: vi.fn(async () => ({ status: 'accepted' as const })) })
    f.decide
      .mockResolvedValueOnce({ output: proceed, model: 'strong' })
      .mockResolvedValue({ output: completed(), model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('needs_user')
    expect(f.task().error).toContain('验收证据不完整')
  })
  it('persists before dispatch and leaves interrupted native offers cancelled after restart', async () => {
    const f = fixture({
      channel: () => 'native',
      dispatch: vi.fn(async (_task, action) => {
        const saved = JSON.parse(readFileSync(join(directory, 'auto-agent-work.json'), 'utf8'))
        expect(saved.tasks[0].actions[0].id).toBe(action.id)
        expect(saved.tasks[0].actions[0].status).toBe('prepared')
        return { status: 'prepared' as const }
      }),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    f.service.dispose()
    services.splice(services.indexOf(f.service), 1)
    const restarted = new AutoAgentWorkService(f.options)
    services.push(restarted)
    await settle()
    expect(restarted.snapshot().tasks[0].state).toBe('paused')
    expect(restarted.snapshot().tasks[0].actions[0].status).toBe('cancelled')
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.options.dispatch).toHaveBeenCalledOnce()
  })
  it('requires explicit resume after restart and preserves unknown dispatched results', async () => {
    const f = fixture({ dispatch: vi.fn(async () => ({ status: 'accepted' as const })) })
    f.decide
      .mockResolvedValueOnce({ output: proceed, model: 'strong' })
      .mockResolvedValue({ output: wait, model: 'strong' })
    const id = f.create()
    await f.event('stopped')
    await settle()
    f.service.dispose()
    services.splice(services.indexOf(f.service), 1)
    const restarted = new AutoAgentWorkService(f.options)
    services.push(restarted)
    await settle()
    expect(restarted.snapshot().tasks[0].state).toBe('paused')
    expect(restarted.snapshot().tasks[0].actions[0].status).toBe('unknown')
    expect(f.decide).toHaveBeenCalledOnce()
    await restarted.update({ taskId: id, action: 'resume' })
    await settle()
    expect(f.decide).toHaveBeenCalledTimes(2)
    expect(f.options.dispatch).toHaveBeenCalledOnce()
  })
  it.each([
    { verdict: 'pass' as const, requirements: [], gaps: [], imperfections: [] },
    {
      verdict: 'pass' as const,
      requirements: [{ requirement: '测试通过', satisfied: true, evidence: '' }],
      gaps: [],
      imperfections: [],
    },
    {
      verdict: 'pass' as const,
      requirements: [{ requirement: '测试通过', satisfied: true, evidence: 'passed' }],
      gaps: ['仍有测试失败'],
      imperfections: [],
    },
  ])('rejects an incomplete acceptance report: %j', async (acceptance) => {
    const f = fixture()
    f.decide.mockResolvedValue({ output: completed({ acceptance }), model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('needs_user')
  })
  it('accepts evidenced requirements with disclosed minor imperfections without learning from silence', async () => {
    const f = fixture()
    const output = completed()
    output.acceptance!.imperfections = ['日志输出格式仍可优化']
    f.decide.mockResolvedValue({ output, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('completed')
    expect(f.task().feedback).toEqual([])
    expect(f.feedback).not.toHaveBeenCalled()
  })
  it('stores only submitted feedback and scopes a correction to the specified decision', async () => {
    const f = fixture()
    const id = f.create()
    await expect(f.service.feedback({ taskId: id, rating: 'negative' })).rejects.toThrow(
      '任务结束后',
    )
    f.decide.mockResolvedValue({ output: completed(), model: 'strong' })
    await f.event('stopped')
    await settle()
    await f.service.feedback({
      taskId: id,
      rating: 'negative',
      reason: '以后小修改直接执行，不重复让我选方案。',
      scope: 'future',
      decisionId: f.task().decisions[0].id,
    })
    await settle()
    expect(f.feedback).toHaveBeenCalledOnce()
    expect(f.task().feedback[0]).toMatchObject({
      rating: 'negative',
      scope: 'future',
      attribution: 'stored',
    })
  })
  it('makes memory unavailability explicit and continues using current task requirements', async () => {
    const f = fixture({
      memory: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    f.create()
    await f.event('stopped')
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.task().memory?.status).toBe('unavailable')
    expect(f.task().memory?.status).not.toBe('empty')
  })
  it.each(['pending', 'failed'] as const)(
    'retries durable %s feedback after restart with the original identity and text',
    async (initialStatus) => {
      const held = deferred<void>()
      const writer = vi.fn<NonNullable<AutoAgentWorkOptions['feedback']>>(async () => {
        if (initialStatus === 'failed') throw new Error('memory offline')
        await held.promise
      })
      const f = fixture({ feedback: writer })
      const id = f.create()
      f.decide.mockResolvedValue({ output: completed(), model: 'strong' })
      await f.event('stopped')
      await settle()
      await f.service.feedback({
        taskId: id,
        rating: 'negative',
        reason: '以后核验安装版再报告。',
        scope: 'future',
      })
      await settle()
      const original = f.task().feedback[0]
      expect(original.attribution).toBe(initialStatus)
      expect(f.task().state).toBe('completed')
      f.service.dispose()
      const recoveredWriter = vi.fn<NonNullable<AutoAgentWorkOptions['feedback']>>(async () => {})
      const recovered = new AutoAgentWorkService({ ...f.options, feedback: recoveredWriter })
      services.push(recovered)
      await settle()
      expect(recoveredWriter).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({
          id: original.id,
          reason: original.reason,
          createdAt: original.createdAt,
        }),
      )
      expect(recovered.snapshot().tasks[0].feedback[0].attribution).toBe('stored')
      expect(recovered.snapshot().tasks[0].state).toBe('completed')
      await recovered.retryFeedback()
      expect(recoveredWriter).toHaveBeenCalledOnce()
      held.resolve()
      await settle()
    },
  )
  it.each(['pending', 'failed'] as const)(
    'retries durable %s user choices after restart with their original source',
    async (initialStatus) => {
      const held = deferred<void>()
      const writer = vi.fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>(async () => {
        if (initialStatus === 'failed') throw new Error('memory offline')
        await held.promise
      })
      const f = fixture({ onUserChoice: writer, feedback: undefined })
      const id = f.create()
      const event = await f.event('user_input', { origin: 'user', text: '本次选择先核验再发布。' })
      await settle()
      const original = f.task().events[0]
      expect(original.choiceMemory?.attribution).toBe(initialStatus)
      expect(f.task().state).toBe('paused')
      f.service.dispose()
      const recoveredWriter = vi.fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>(
        async () => 'stored',
      )
      const recovered = new AutoAgentWorkService({ ...f.options, onUserChoice: recoveredWriter })
      services.push(recovered)
      await settle()
      expect(recoveredWriter).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id,
          session: expect.objectContaining({
            id: event.sessionId,
            instanceId: event.instanceId,
            workspace: directory,
          }),
        }),
        expect.objectContaining({ id: event.id, text: event.text, at: event.at }),
      )
      expect(recovered.snapshot().tasks[0].events[0].choiceMemory?.attribution).toBe('stored')
      await recovered.retryFeedback()
      expect(recoveredWriter).toHaveBeenCalledOnce()
      held.resolve()
      await settle()
    },
  )
  it('backs off choice retries, coalesces concurrent flushes and stops retrying handled events', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const held = deferred<void>()
    const writer = vi
      .fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => {
        await held.promise
        return 'ignored'
      })
    const f = fixture({ onUserChoice: writer })
    f.create()
    const event = await f.event('user_input', { origin: 'user', text: '本次选择离线核验。' })
    await settle()
    expect(f.task().events[0].choiceMemory?.attribution).toBe('failed')
    await vi.advanceTimersByTimeAsync(999)
    expect(writer).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(writer).toHaveBeenCalledTimes(2)
    const first = f.service.retryFeedback(),
      second = f.service.retryFeedback()
    expect(first).toBe(second)
    await f.service.observe(event, f.session())
    held.resolve()
    await first
    await settle()
    expect(f.task().events[0].choiceMemory?.attribution).toBe('ignored')
    await vi.advanceTimersByTimeAsync(60000)
    expect(writer).toHaveBeenCalledTimes(2)
  })
  it('flushes a new choice arriving while the preceding choice is still being written', async () => {
    const held = deferred<void>()
    const writer = vi
      .fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>()
      .mockImplementationOnce(async () => {
        await held.promise
        return 'stored'
      })
      .mockResolvedValue('stored')
    const f = fixture({ onUserChoice: writer })
    f.create()
    const first = await f.event('user_input', { origin: 'user', text: '先检查结果。' })
    await settle()
    const second = await f.event('user_input', { origin: 'user', text: '随后再做本地安装。' })
    await settle()
    expect(writer).toHaveBeenCalledOnce()
    held.resolve()
    await settle()
    expect(writer.mock.calls.map((call) => call[1].id)).toEqual([first.id, second.id])
    expect(f.task().events.map((event) => event.choiceMemory?.attribution)).toEqual([
      'stored',
      'stored',
    ])
  })
  it('flushes submitted feedback after an in-flight choice without delaying task completion', async () => {
    const held = deferred<void>()
    const f = fixture({
      onUserChoice: async () => {
        await held.promise
        return 'stored'
      },
    })
    const id = f.create()
    await f.event('user_input', { origin: 'user', text: '先核验本地结果。' })
    await settle()
    await f.service.update({ taskId: id, action: 'resume' })
    f.decide.mockResolvedValue({ output: completed(), model: 'strong' })
    await f.event('stopped')
    await settle()
    expect(f.task().state).toBe('completed')
    await f.service.feedback({
      taskId: id,
      rating: 'positive',
      scope: 'future',
      reason: '以后也先核验本地结果。',
    })
    expect(f.feedback).not.toHaveBeenCalled()
    held.resolve()
    await settle()
    expect(f.feedback).toHaveBeenCalledOnce()
    expect(f.task().feedback[0].attribution).toBe('stored')
    expect(f.task().state).toBe('completed')
  })
  it('preserves pending choice sources beyond the recent event limit and across session reconnects', async () => {
    const writer = vi
      .fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>()
      .mockRejectedValue(new Error('offline'))
    const f = fixture({ onUserChoice: writer })
    f.create()
    const event = await f.event('user_input', { origin: 'user', text: '选择先核验离线结果。' })
    await settle()
    for (let n = 0; n < 122; n++) await f.event('progress')
    expect(f.task().events.some((item) => item.id === event.id)).toBe(true)
    const reconnected = {
      ...f.session(),
      id: 'reconnected',
      instanceId: 'new-instance',
      workspace: directory + '/new',
    }
    f.options.sessions = () => [reconnected]
    await f.service.update({ taskId: f.task().id, action: 'resume' })
    writer.mockResolvedValue('stored')
    await f.service.retryFeedback()
    expect(writer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          id: event.sessionId,
          instanceId: event.instanceId,
          workspace: directory,
        }),
      }),
      expect.objectContaining({ id: event.id, text: event.text }),
    )
    expect(f.task().events.find((item) => item.id === event.id)?.choiceMemory?.attribution).toBe(
      'stored',
    )
  })
  it('ignores incoming attribution and leaves legacy events without outbox state untouched', async () => {
    const historical: AutoAgentEvent = {
      id: 'old-user',
      sessionId: 'chatgpt-1',
      instanceId: 'instance-1',
      revision: 1,
      type: 'user_input',
      origin: 'user',
      text: '以前的选择',
      at: new Date().toISOString(),
      choiceMemory: { attribution: 'pending', workspace: directory },
    }
    const writer = vi.fn<NonNullable<AutoAgentWorkOptions['onUserChoice']>>(async () => 'stored')
    const f = fixture({ events: () => [historical], onUserChoice: writer })
    f.create()
    await f.event('progress', { choiceMemory: { attribution: 'pending', workspace: directory } })
    await settle()
    expect(f.task().events.every((event) => !event.choiceMemory)).toBe(true)
    f.service.dispose()
    const recovered = new AutoAgentWorkService(f.options)
    services.push(recovered)
    await settle()
    expect(writer).not.toHaveBeenCalled()
  })
  it('seeds a newly bound idle session with its existing scoped hook evidence', async () => {
    const stopped: AutoAgentEvent = {
      id: 'existing-stop',
      sessionId: 'chatgpt-1',
      instanceId: 'instance-1',
      turnId: 'turn-1',
      revision: 1,
      type: 'stopped',
      at: new Date().toISOString(),
      origin: 'agent',
      text: 'Tests: 12 passed',
    }
    const f = fixture(
      {
        events: () => [
          stopped,
          { ...stopped, id: 'foreign', sessionId: 'other' },
          { ...stopped, id: 'old-instance', instanceId: 'other' },
          stopped,
          { ...stopped, id: 'child', agentId: 'child' },
          { ...stopped, id: 'future', revision: 100 },
        ],
      },
      { state: 'idle' },
    )
    f.create()
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.decide.mock.calls[0][0].events).toEqual([stopped])
    expect(f.task().decisions[0].trigger).toBe('stopped')
  })
  it('only explicitly resumes a unique original native session after its instance changes', async () => {
    const f = fixture()
    const id = f.create()
    await f.service.update({ taskId: id, action: 'pause' })
    const reconnected: AutoAgentSession = {
      ...f.session(),
      id: 'chatgpt-new',
      instanceId: 'instance-2',
      revision: 1,
      state: 'idle',
    }
    f.options.sessions = () => [reconnected]
    await f.service.observe(
      {
        id: randomUUID(),
        sessionId: reconnected.id,
        instanceId: reconnected.instanceId,
        turnId: 'turn-1',
        revision: 1,
        type: 'stopped',
        at: new Date().toISOString(),
        origin: 'agent',
      },
      reconnected,
    )
    await settle()
    expect(f.decide).not.toHaveBeenCalled()
    expect(f.task().session.id).toBe('chatgpt-1')
    const before = f.task()
    await expect(
      f.service.update({ taskId: id, action: 'supplement', text: '再看一次' }),
    ).rejects.toThrow('原会话未连接')
    expect(f.task().version).toBe(before.version)
    expect(f.task().supplements).toEqual([])
    await f.service.update({ taskId: id, action: 'resume' })
    await settle()
    expect(f.task().session).toEqual(reconnected)
    expect(f.decide).toHaveBeenCalledOnce()
  })
  it('refuses ambiguous reconnections and sessions already owned by another task', async () => {
    const f = fixture()
    const id = f.create()
    await f.service.update({ taskId: id, action: 'pause' })
    const next = { ...f.session(), id: 'new-1', instanceId: 'instance-2' }
    f.options.sessions = () => [next, { ...next, id: 'new-2', instanceId: 'instance-3' }]
    await expect(f.service.update({ taskId: id, action: 'resume' })).rejects.toThrow('存在多个匹配')
    f.options.sessions = () => [next]
    f.service.create({ sessionId: next.id, goal: '另一个目标', acceptance: ['独立验收'] })
    await expect(f.service.update({ taskId: id, action: 'resume' })).rejects.toThrow(
      '已有其他任务绑定',
    )
  })
  it('atomically falls back only an unclaimed native offer and cannot claim or fall back twice', async () => {
    const f = fixture({
      channel: () => 'native',
      dispatch: vi.fn(async () => ({ status: 'prepared' as const })),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const original = f.task().actions[0]
    const fallback = f.service.fallbackNativeAction(original.id)
    expect(fallback).toMatchObject({ id: original.id, channel: 'desktop', status: 'dispatching' })
    expect(
      JSON.parse(readFileSync(join(directory, 'auto-agent-work.json'), 'utf8')).tasks[0].actions[0],
    ).toMatchObject({ id: original.id, channel: 'desktop', status: 'dispatching' })
    expect(f.service.claimNative(original.id, f.task().session.id, f.task().version)).toBe(false)
    expect(() => f.service.fallbackNativeAction(original.id)).toThrow('已领取或失效')
  })
  it('never falls back after the native hook claimed an action or the user took over', async () => {
    const f = fixture({
      channel: () => 'native',
      dispatch: vi.fn(async () => ({ status: 'prepared' as const })),
    })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    const id = f.create()
    await f.event('stopped')
    await settle()
    const action = f.task().actions[0]
    expect(f.service.claimNative(action.id, f.task().session.id, f.task().version)).toBe(true)
    expect(() => f.service.fallbackNativeAction(action.id)).toThrow('已领取或失效')
    await f.service.update({ taskId: id, action: 'pause' })
    expect(() => f.service.fallbackNativeAction(action.id)).toThrow('已领取或失效')
  })
  it('cancels a stale prepared offer on a newer event without reviving it when dispatch resolves', async () => {
    const result = deferred<{ status: 'prepared' }>()
    const f = fixture({ channel: () => 'native', dispatch: vi.fn(async () => result.promise) })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const action = f.task().actions[0]
    expect(action.status).toBe('prepared')
    await f.event('progress')
    expect(f.task().actions[0].status).toBe('cancelled')
    result.resolve({ status: 'prepared' })
    await settle()
    expect(f.task().actions[0].status).toBe('cancelled')
    expect(f.service.claimNative(action.id, f.task().session.id, f.task().version)).toBe(false)
    expect(() => f.service.fallbackNativeAction(action.id)).toThrow('已领取或失效')
    expect(f.decide).toHaveBeenCalledOnce()
  })
  it('keeps a claimed native action dispatching if its original offer callback resolves late', async () => {
    const result = deferred<{ status: 'prepared' }>()
    const f = fixture({ channel: () => 'native', dispatch: vi.fn(async () => result.promise) })
    f.decide.mockResolvedValue({ output: proceed, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const action = f.task().actions[0]
    expect(f.service.claimNative(action.id, f.task().session.id, f.task().version)).toBe(true)
    result.resolve({ status: 'prepared' })
    await settle()
    expect(f.task().actions[0].status).toBe('dispatching')
    expect(() => f.service.fallbackNativeAction(action.id)).toThrow('已领取或失效')
  })
  it('accepts an owned Coloop receipt starting a new turn and rejects unrelated cross-turn receipts', async () => {
    const f = fixture({ dispatch: vi.fn(async () => ({ status: 'accepted' as const })) })
    f.decide
      .mockResolvedValueOnce({ output: proceed, model: 'strong' })
      .mockResolvedValue({ output: wait, model: 'strong' })
    f.create()
    await f.event('stopped')
    await settle()
    const actionId = f.task().actions[0].id
    await f.event(
      'receipt',
      { actionId: 'foreign', origin: 'coloop', turnId: 'turn-2' },
      { turnId: 'turn-2', state: 'running' },
    )
    expect(f.task().session.turnId).toBe('turn-1')
    expect(f.task().actions[0].status).toBe('accepted')
    await f.event('receipt', { actionId, origin: 'agent', turnId: 'turn-2' }, { state: 'running' })
    expect(f.task().actions[0].status).toBe('accepted')
    await f.event('receipt', { actionId, origin: 'coloop', turnId: 'turn-2' }, { state: 'running' })
    await settle()
    expect(f.task().session.turnId).toBe('turn-2')
    expect(f.task().actions[0].status).toBe('confirmed')
    expect(f.task().state).toBe('watching')
    expect(f.decide).toHaveBeenCalledOnce()
    expect(f.options.dispatch).toHaveBeenCalledOnce()
    await f.event('stopped', { turnId: 'turn-1' })
    await settle()
    expect(f.decide).toHaveBeenCalledOnce()
  })
})
