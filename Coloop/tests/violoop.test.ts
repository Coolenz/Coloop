import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VioloopService } from '../src/main/services/violoop'
import type { DesktopSnapshot } from '../src/shared/desktop'
import type { ProactiveState } from '../src/shared/proactive'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(
  options: {
    directory?: string
    understand?: (content: string, signal: AbortSignal) => Promise<string>
    recallProcedure?: (goal: string, signal: AbortSignal) => Promise<boolean>
    browserAgentLocation?: 'host' | 'rk'
    execution?: {
      start(goal: string, taskId: string, target?: 'hybrid' | 'cloud' | 'rk'): Promise<unknown>
      snapshot(): ProactiveState
      stop(): Promise<unknown>
      answer(taskId: string, questionId: string, answer: string): void
    }
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'coloop-violoop-'))
  if (!options.directory) directories.push(directory)
  let desktopState: DesktopSnapshot = {
    phase: 'idle',
    active: false,
    steps: 0,
    maxSteps: 8,
    events: [],
  }
  const start = vi.fn((_input: unknown) => {
    const id = randomUUID()
    desktopState = { ...desktopState, taskId: id, active: true, phase: 'preparing' }
    return id
  })
  const stop = vi.fn(async () => {
    desktopState = { ...desktopState, active: false, phase: 'cancelled' }
  })
  const assertAvailable = vi.fn(() => {})
  const understand = vi.fn(
    options.understand ??
      (async () =>
        JSON.stringify({ kind: 'desktop', windowTitle: 'Lab', expectedText: 'Applied: 1234' })),
  )
  const codec = {
    encrypt: (text: string) => Buffer.from(text).toString('base64'),
    decrypt: (text: string) => Buffer.from(text, 'base64').toString(),
  }
  const service = new VioloopService({
    directory,
    ...codec,
    desktop: { windows: vi.fn(async () => ['Lab']), start, stop, snapshot: () => desktopState },
    assertAvailable,
    understand,
    recallProcedure: options.recallProcedure,
    browserAgentLocation: options.browserAgentLocation,
    execution: options.execution,
    onChange: vi.fn(),
  })
  return {
    directory,
    service,
    start,
    stop,
    understand,
    assertAvailable,
    state: (values: Partial<DesktopSnapshot>) => {
      desktopState = { ...desktopState, ...values }
      service.observeDesktop()
    },
    request: {
      commandId: randomUUID(),
      text: 'In Lab fill 1234 and Apply. Result Applied: 1234',
      authorizeInput: true as const,
    },
    deviceId: randomUUID(),
  }
}
describe('Violoop phone task admission and lifecycle', () => {
  it('routes a Chinese multi-application task through the shared executor without the legacy planner', async () => {
    let state: ProactiveState = { connected: true, active: false, phase: 'idle' }
    const execution = {
      start: vi.fn(async (goal: string, taskId: string) => {
        state = { ...state, taskId, active: true, phase: 'planning' }
      }),
      snapshot: () => state,
      stop: vi.fn(async () => {
        state = { ...state, active: false, phase: 'cancelled' }
      }),
      answer: vi.fn(),
    }
    const f = fixture({ execution })
    const request = { ...f.request, text: '整理中文订单并写入台账，保存后核验。' }
    f.service.submit(request, f.deviceId)
    await vi.waitFor(() =>
      expect(execution.start).toHaveBeenCalledWith(request.text, request.commandId),
    )
    expect(f.understand).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.service.taskId).toBe(request.commandId)
    state = { ...state, active: false, phase: 'completed', summary: '已保存并核验中文台账' }
    f.service.observeDesktop()
    expect(f.service.snapshot().tasks[0]).toMatchObject({
      state: 'completed',
      id: request.commandId,
    })
    f.service.submit(request, f.deviceId)
    expect(execution.start).toHaveBeenCalledOnce()
  })
  it('keeps a shared question active and waits for an actual stop acknowledgement', async () => {
    const taskId = randomUUID(),
      questionId = randomUUID()
    let state: ProactiveState = { connected: true, active: false, phase: 'idle' }
    const execution = {
      start: vi.fn(async (_goal: string, id: string) => {
        state = {
          ...state,
          taskId: id,
          active: true,
          phase: 'waiting_user',
          question: { question_id: questionId, question: '请补充数量' },
        }
      }),
      snapshot: () => state,
      stop: vi.fn(async () => {
        state = { ...state, active: false, phase: 'cancelled', question: undefined }
      }),
      answer: vi.fn(),
    }
    const f = fixture({ execution })
    f.service.submit({ ...f.request, commandId: taskId }, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].questionId).toBe(questionId))
    expect(f.service.active).toBe(true)
    await f.service.stop()
    expect(execution.stop).toHaveBeenCalledOnce()
    expect(f.service.snapshot().tasks[0].state).toBe('cancelled')
  })
  it('passes an explicit phone model route into the shared executor and binds it to deduplication', async () => {
    const execute = vi.fn(async () => {})
    const f = fixture({
      execution: {
        start: execute,
        snapshot: () => ({ phase: 'idle', active: false, connected: true }),
        stop: vi.fn(async () => {}),
        answer: vi.fn(),
      },
    })
    const request = { ...f.request, target: 'cloud' as const }
    const accepted = f.service.submit(request, f.deviceId)
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.any(String), accepted.id, 'cloud')
    expect(accepted.target).toBe('cloud')
    f.service.submit(request, f.deviceId)
    expect(execute).toHaveBeenCalledOnce()
    expect(() => f.service.submit({ ...request, target: 'rk' }, f.deviceId)).toThrow()
  })

  it('answers a shared question on the original task and deduplicates the reply command', async () => {
    const questionId = randomUUID()
    let state: ProactiveState = { connected: true, active: false, phase: 'idle' }
    const execution = {
      start: vi.fn(async (_goal: string, id: string) => {
        state = {
          ...state,
          taskId: id,
          active: true,
          phase: 'waiting_user',
          question: { question_id: questionId, question: '补充数量' },
        }
      }),
      snapshot: () => state,
      stop: vi.fn(async () => {}),
      answer: vi.fn((_taskId: string, _questionId: string, _answer: string) => {
        state = { ...state, phase: 'planning', question: undefined }
      }),
    }
    const f = fixture({ execution })
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].questionId).toBe(questionId))
    const reply = {
      ...f.request,
      commandId: randomUUID(),
      replyTo: f.request.commandId,
      text: '数量改为4，署名林悦',
    }
    expect(f.service.submit(reply, f.deviceId).state).toBe('answered')
    f.service.submit(reply, f.deviceId)
    expect(execution.start).toHaveBeenCalledOnce()
    expect(execution.answer).toHaveBeenCalledExactlyOnceWith(
      f.request.commandId,
      questionId,
      reply.text,
    )
    expect(f.service.taskId).toBe(f.request.commandId)
    expect(f.service.active).toBe(true)
  })
  it('waits for a pending shared start before confirming stop', async () => {
    const pending = deferred<void>()
    let state: ProactiveState = { connected: true, active: false, phase: 'idle' }
    const execution = {
      start: vi.fn(async (_goal: string, id: string) => {
        await pending.promise
        state = { ...state, taskId: id, active: true, phase: 'planning' }
      }),
      snapshot: () => state,
      stop: vi.fn(async () => {
        state = { ...state, active: false, phase: 'cancelled' }
      }),
      answer: vi.fn(),
    }
    const f = fixture({ execution })
    f.service.submit(f.request, f.deviceId)
    const stopping = f.service.stop()
    expect(execution.stop).toHaveBeenCalledOnce()
    pending.resolve()
    await stopping
    expect(f.service.active).toBe(false)
    expect(f.service.snapshot().tasks[0].state).toBe('cancelled')
  })
  it('forwards an exact browser task to the RK Agent without host memory or intent inference', async () => {
    const recallProcedure = vi.fn(async () => false)
    const f = fixture({ browserAgentLocation: 'rk', recallProcedure })
    f.service.submit(
      { ...f.request, text: '打开bilibili，点击主页的一个任意视频，然后三连点赞' },
      f.deviceId,
    )
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(recallProcedure).not.toHaveBeenCalled()
    expect(f.understand).not.toHaveBeenCalled()
  })
  it('reuses an explicitly recalled procedure only for the exact admitted triple task', async () => {
    const recallProcedure = vi.fn(async () => true)
    const f = fixture({ recallProcedure })
    f.service.submit(
      { ...f.request, text: '打开bilibili，点击主页的一个任意视频，然后三连点赞' },
      f.deviceId,
    )
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.understand).not.toHaveBeenCalled()
    expect(f.start.mock.calls[0][0]).toMatchObject({
      planner: 'cloud-hid',
      browserTask: 'video-triple',
    })
  })
  it('routes the exact Bilibili home request without generative reclassification', async () => {
    const f = fixture({
      understand: async () => {
        throw new Error('MODEL_MUST_NOT_RUN')
      },
    })
    f.service.submit({ ...f.request, text: '打开 Bilibili' }, f.deviceId)
    expect(f.understand).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.start.mock.calls[0][0]).toMatchObject({
      planner: 'cloud-hid',
      windowTitle: 'Chrome → Bilibili',
      authorizeInput: true,
    })
  })
  it.each(['帮我打开哔哩哔哩', '打开bilibili', '帮我打开bilibili', '请帮我打开B站'])(
    'starts admitted home request %s exactly once without model JSON',
    async (text) => {
      const f = fixture({ understand: async () => '{"kind":"browser_relay","message":"执行三连"}' })
      const request = { ...f.request, text }
      f.service.submit(request, f.deviceId)
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
      f.service.submit(request, f.deviceId)
      expect(f.start).toHaveBeenCalledOnce()
      expect(f.understand).not.toHaveBeenCalled()
      expect(f.start.mock.calls[0][0]).toMatchObject({ browserTask: 'home', maxSteps: 4 })
    },
  )
  it('ignores model explanation but still checks the actual user scope', async () => {
    const f = fixture({ understand: async () => '{"kind":"browser_relay","message":"执行三连"}' })
    f.service.submit({ ...f.request, text: '打开bilibili并登录' }, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('awaiting_input'))
    expect(f.service.snapshot().tasks[0].message).toContain('目前只支持')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('normalizes explanatory and unknown fields before starting an ordinary desktop task', async () => {
    const f = fixture({
      understand: async () =>
        JSON.stringify({
          kind: 'desktop',
          windowId: 0,
          expectedText: 'Applied: 1234',
          message: '已完成',
          shell: 'untrusted command',
          authorizeInput: false,
          maxSteps: 999,
        }),
    })
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.start.mock.calls[0][0]).toEqual({
      goal: f.request.text,
      windowTitle: 'Lab',
      expectedText: 'Applied: 1234',
      planner: 'auto',
      authorizeInput: true,
      maxSteps: 8,
    })
    expect(f.service.snapshot().tasks[0].state).toBe('running')
  })
  it('rejects scope expansion even if the RK suggests the browser pilot', async () => {
    const f = fixture({ understand: async () => '{"kind":"browser_relay"}' })
    f.service.submit({ ...f.request, text: '打开 Bilibili 并登录' }, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('awaiting_input'))
    expect(f.start).not.toHaveBeenCalled()
  })
  it('answers a conversational message with the real local route callback and no desktop input', async () => {
    const f = fixture({
      understand: async () => JSON.stringify({ kind: 'reply', message: '你好，我是 Coloop。' }),
    })
    f.service.submit({ ...f.request, text: '你好' }, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('answered'))
    expect(f.start).not.toHaveBeenCalled()
    expect(f.service.active).toBe(false)
  })
  it('binds a model-selected window number to the exact title explicitly present in the phone message', async () => {
    const f = fixture({
      understand: async () =>
        JSON.stringify({ kind: 'desktop', windowId: 0, expectedText: 'Applied: 1234' }),
    })
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(JSON.parse(f.understand.mock.calls[0][0]).windows).toEqual([
      { windowId: 0, title: 'Lab' },
    ])
    expect(f.start.mock.calls[0][0]).toMatchObject({ windowTitle: 'Lab' })
  })
  it('returns promptly during RK inference, starts the auto planner and projects verified results', async () => {
    const inference = deferred<string>()
    const f = fixture({ understand: () => inference.promise })
    const receipt = f.service.submit(f.request, f.deviceId)
    expect(receipt.id).toBe(f.request.commandId)
    expect(f.service.active).toBe(true)
    expect(f.start).not.toHaveBeenCalled()
    inference.resolve(
      JSON.stringify({ kind: 'desktop', windowTitle: 'Lab', expectedText: 'Applied: 1234' }),
    )
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    expect(f.start.mock.calls[0][0]).toMatchObject({
      planner: 'auto',
      authorizeInput: true,
      windowTitle: 'Lab',
    })
    f.state({ phase: 'planning', planningSource: 'cloud', steps: 1 })
    expect(f.service.snapshot().tasks[0]).toMatchObject({
      state: 'running',
      planningSource: 'cloud',
    })
    f.state({ phase: 'completed', active: false, steps: 2 })
    expect(f.service.snapshot().tasks[0].state).toBe('completed')
    expect(f.service.active).toBe(false)
  })
  it('deduplicates across new frames and restarts, rejecting changed content or another device', async () => {
    const f = fixture()
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    f.service.submit(f.request, f.deviceId)
    expect(f.start).toHaveBeenCalledOnce()
    expect(() => f.service.submit({ ...f.request, text: 'different' }, f.deviceId)).toThrow(
      'VIOLOOP_CONFLICT',
    )
    expect(() => f.service.submit(f.request, randomUUID())).toThrow('VIOLOOP_CONFLICT')
    const restored = fixture({ directory: f.directory })
    expect(restored.service.submit(f.request, f.deviceId).state).toBe('interrupted')
    expect(restored.start).not.toHaveBeenCalled()
    expect(readFileSync(join(f.directory, 'violoop-tasks.encrypted'), 'utf8')).not.toContain(
      f.request.text,
    )
  })
  it('stops pending understanding without late model output starting HID', async () => {
    const inference = deferred<string>()
    const f = fixture({ understand: () => inference.promise })
    f.service.submit(f.request, f.deviceId)
    await f.service.stop()
    inference.resolve(
      JSON.stringify({ kind: 'desktop', windowTitle: 'Lab', expectedText: 'Applied: 1234' }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(f.start).not.toHaveBeenCalled()
    expect(f.service.snapshot().tasks[0].state).toBe('cancelled')
  })
  it('stops the exact running desktop task and retains an unconfirmed stop', async () => {
    const f = fixture()
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    f.stop.mockImplementationOnce(async () => {
      f.state({ phase: 'unconfirmed', active: true })
      throw new Error('STOP_UNCONFIRMED')
    })
    await expect(f.service.stop()).rejects.toThrow()
    expect(f.service.snapshot().tasks[0].state).toBe('unconfirmed')
    expect(() => f.service.submit({ ...f.request, commandId: randomUUID() }, f.deviceId)).toThrow(
      'VIOLOOP_BUSY',
    )
  })
  it('keeps clarification local and admits a linked supplementary message', async () => {
    const f = fixture({
      understand: async () =>
        JSON.stringify({ kind: 'clarify', message: '请给出完成后应出现的文字。' }),
    })
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('awaiting_input'))
    expect(f.start).not.toHaveBeenCalled()
    f.service.submit(
      {
        commandId: randomUUID(),
        text: '应出现 Applied: 1234',
        replyTo: f.request.commandId,
        authorizeInput: true,
      },
      f.deviceId,
    )
    await vi.waitFor(() => expect(f.understand).toHaveBeenCalledTimes(2))
    expect(JSON.parse(f.understand.mock.calls[1][0]).text).toContain('补充：应出现 Applied: 1234')
  })
  it('rejects unknown windows and malformed RK intent with zero input', async () => {
    for (const raw of [
      '{"kind":"desktop","windowTitle":"other","expectedText":"done"}',
      '{"kind":"desktop","windowTitle":"Lab","expectedText":123}',
    ]) {
      const f = fixture({ understand: async () => raw })
      f.service.submit(f.request, f.deviceId)
      await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('failed'))
      expect(f.start).not.toHaveBeenCalled()
    }
  })
  it('requires a completion condition actually supplied by the user instead of trusting an invented one', async () => {
    const f = fixture({
      understand: async () =>
        JSON.stringify({ kind: 'desktop', windowTitle: 'Lab', expectedText: 'Invented done' }),
    })
    f.service.submit(f.request, f.deviceId)
    await vi.waitFor(() => expect(f.service.snapshot().tasks[0].state).toBe('awaiting_input'))
    expect(f.start).not.toHaveBeenCalled()
  })
  it('fails closed on unreadable storage and blocks admission before acceptance when unavailable', () => {
    const f = fixture()
    f.assertAvailable.mockImplementation(() => {
      throw new Error('CONTROL_STOPPED')
    })
    expect(() => f.service.submit(f.request, f.deviceId)).toThrow('CONTROL_STOPPED')
    expect(f.service.snapshot().tasks).toHaveLength(0)
    writeFileSync(join(f.directory, 'violoop-tasks.encrypted'), 'invalid')
    const corrupted = fixture({ directory: f.directory })
    expect(corrupted.service.snapshot().available).toBe(false)
    expect(() => corrupted.service.submit(f.request, f.deviceId)).toThrow()
    expect(corrupted.start).not.toHaveBeenCalled()
  })
})
