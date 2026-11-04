import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TarsRuntimeOptions } from '../src/main/infrastructure/tars-runtime'
import { TarsAgentService, type TarsAgentOptions } from '../src/main/services/tars-agent'

const factory = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../src/main/infrastructure/tars-runtime', () => ({ createTarsRuntime: factory.create }))
type RuntimeMock = {
  options: TarsRuntimeOptions
  initialize: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  requestLoopTermination: ReturnType<typeof vi.fn>
  isLoopTerminationRequested: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const call = (runtime: RuntimeMock, name: string, args: unknown = {}) =>
  Promise.resolve(runtime.options.tools.find((tool) => tool.name === name)!.execute(args))
const view = (id: string) => ({
  observation_id: id,
  window_id: 'window',
  process_id: 5,
  ocr_text: '正文',
  targets: [{ id: 1 }],
})

describe('TarsAgentService official runtime facade', () => {
  let directory: string
  let options: TarsAgentOptions
  let service: TarsAgentService
  let runtimes: RuntimeMock[]
  let scripts: ((runtime: RuntimeMock) => Promise<unknown>)[]
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'coloop-tars-'))
    runtimes = []
    scripts = []
    factory.create.mockReset().mockImplementation((config: TarsRuntimeOptions) => {
      const script = scripts.shift()
      const runtime: RuntimeMock = {
        options: config,
        initialize: vi.fn(async () => {}),
        run: vi.fn(async () =>
          script ? script(runtime) : { content: '完成', finishReason: 'stop' },
        ),
        requestLoopTermination: vi.fn(() => true),
        isLoopTerminationRequested: vi.fn(
          () => runtime.requestLoopTermination.mock.calls.length > 0,
        ),
        abort: vi.fn(() => true),
        dispose: vi.fn(async () => {}),
      }
      runtimes.push(runtime)
      return runtime
    })
    let observations = 0
    options = {
      workspace: directory,
      model: () => ({
        provider: 'openai',
        id: 'test',
        apiKey: 'test',
        baseURL: 'https://example.invalid/v1',
      }),
      available: vi.fn(() => true),
      assertStart: vi.fn(),
      observe: vi.fn(async () => view(`obs-${++observations}`)),
      input: vi.fn(async () => ({ verified: true, source: 'uia' })),
      prepareInput: vi.fn(async () => {}),
      onChange: vi.fn(),
      onObservationRetry: vi.fn(),
      execution: {
        connect: vi.fn(async () => {}),
        begin: vi.fn(async () => ({ ok: true })),
        execute: vi.fn(async (value) => ({
          ok: true,
          receipt: { command_id: value.command_id, outcome: 'effect_verified' },
        })),
        stop: vi.fn(async () => ({ ok: true, stopped: true, neutral: true })),
        dispose: vi.fn(async () => {}),
      },
      memory: {
        enqueue: vi.fn(async () => ({ ok: true, status: 'pending' })),
        catalog: vi.fn(async () => ({ ok: true, result: [] })),
        get: vi.fn(async () => ({ ok: true, result: [] })),
        dispose: vi.fn(async () => {}),
      },
    }
    service = new TarsAgentService(options)
  })
  afterEach(async () => {
    await service.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  async function completedRun(runtime: RuntimeMock) {
    const before = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
    await call(runtime, 'coloop_execute', {
      observation_id: before.observation_id,
      action: { action: 'paste', target_id: 1, text: '追加中文正文' },
    })
    const after = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
    await call(runtime, 'coloop_verify', {
      observation_id: after.observation_id,
      evidence_mode: 'editor_text',
      expected_text: '追加中文正文',
    })
    return { content: '已追加中文正文', finishReason: 'stop' }
  }
  const settled = async () => {
    await vi.waitFor(() => expect(service.active).toBe(false))
  }

  it('uses a single official run and real verification before memory, after neutral release', async () => {
    const neutral = deferred()
    vi.mocked(options.execution.stop).mockReturnValue(neutral.promise)
    scripts.push(completedRun)
    await service.startTask('追加正文', 'task-1')
    await vi.waitFor(() => expect(options.execution.stop).toHaveBeenCalledOnce())
    expect(service.active).toBe(true)
    expect(options.memory.enqueue).not.toHaveBeenCalled()
    neutral.resolve({ ok: true, stopped: true, neutral: true })
    await settled()
    expect(service.snapshot()).toMatchObject({ phase: 'completed', summary: '已追加中文正文' })
    expect(runtimes[0].run).toHaveBeenCalledOnce()
    expect(runtimes[0].options.tools.map((tool) => tool.name)).toEqual([
      'coloop_observe',
      'coloop_execute',
      'coloop_verify',
      'coloop_memory_catalog',
      'coloop_memory_get',
      'coloop_ask_user',
    ])
    expect(options.input).toHaveBeenCalledWith(
      'completion.verify',
      expect.objectContaining({ observation_id: 'obs-2' }),
      expect.objectContaining({ expected_text: '追加中文正文' }),
    )
    expect(options.memory.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        verified: true,
        verified_texts: ['[excerpt] 追加中文正文'],
        receipts: [expect.objectContaining({ outcome: 'effect_verified' })],
      }),
    )
  })
  it('passes the full 74000-character Chinese task to the official runtime', async () => {
    const goal = '中'.repeat(74000)
    await service.startTask(goal, 'long-task')
    await settled()
    expect(runtimes[0].run).toHaveBeenCalledWith({ input: goal, sessionId: 'long-task' })
    expect(options.execution.begin).toHaveBeenCalledWith({
      task_id: 'long-task',
      generation: expect.any(String),
    })
  })
  it('rejects tasks larger than 240000 UTF-8 bytes before dispatch', async () => {
    const goal = '中'.repeat(80001)
    expect(Buffer.byteLength(goal)).toBeGreaterThan(240000)
    await expect(service.startTask(goal)).rejects.toThrow('INVALID_TASK_GOAL')
    expect(options.execution.connect).not.toHaveBeenCalled()
    expect(factory.create).not.toHaveBeenCalled()
    expect(service.active).toBe(false)
  })
  it('bounds RK memory evidence for a full Chinese goal and multiple 32 KB pastes', async () => {
    const goal = '中'.repeat(74000)
    const summary = '总结'.repeat(1000)
    const texts = Array.from({ length: 20 }, (_, index) => `${index}:`.padEnd(32000, 'x'))
    vi.mocked(options.execution.execute).mockImplementation(async (value) => ({
      ok: true,
      receipt: {
        command_id: value.command_id,
        outcome: 'effect_verified',
        unused_document_body: 'x'.repeat(32000),
      },
    }))
    scripts.push(async (runtime) => {
      let observed = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
      for (const text of texts) {
        await call(runtime, 'coloop_execute', {
          observation_id: observed.observation_id,
          action: { action: 'paste', target_id: 1, text },
        })
        observed = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
      }
      await call(runtime, 'coloop_verify', {
        observation_id: observed.observation_id,
        evidence_mode: 'editor_text',
        expected_text: texts.at(-1)!.slice(0, 100),
      })
      return { content: summary, finishReason: 'stop' }
    })
    await service.startTask(goal, 'long-evidence')
    await settled()
    await vi.waitFor(() => expect(options.memory.enqueue).toHaveBeenCalledOnce())
    expect(runtimes[0].run).toHaveBeenCalledWith({ input: goal, sessionId: 'long-evidence' })
    expect(options.execution.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: expect.objectContaining({ text: texts.at(-1) }) }),
    )
    const evidence = vi.mocked(options.memory.enqueue).mock.calls[0][0]
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(64 * 1024)
    expect(evidence.goal).toBe(goal.slice(0, 1000))
    expect(evidence.summary).toBe(summary.slice(0, 600))
    expect(evidence.verified_texts).toEqual(
      texts.slice(-8).map((text) => '[excerpt] ' + text.slice(0, 490)),
    )
    expect(evidence.receipts).toHaveLength(16)
    for (const receipt of evidence.receipts as Record<string, unknown>[])
      expect(Object.keys(receipt).sort()).toEqual(['action', 'command_id', 'outcome'])
    expect(evidence).not.toHaveProperty('evidence')
    expect(evidence).not.toHaveProperty('commands')
    expect(evidence).not.toHaveProperty('observation')
    expect(service.snapshot().phase).toBe('completed')
  })
  it('keeps verified foreground completion if memory delivery fails', async () => {
    vi.mocked(options.memory.enqueue).mockRejectedValue(new Error('RK_MEMORY_OFFLINE'))
    scripts.push(completedRun)
    await service.startTask('工作')
    await settled()
    await vi.waitFor(() => expect(service.snapshot().memorySaved).toBe(false))
    expect(service.snapshot().phase).toBe('completed')
  })
  it('does not treat assistant prose or an error finish reason as verified completion', async () => {
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
    scripts.push(async (runtime) => ({ ...(await completedRun(runtime)), finishReason: 'error' }))
    await service.startTask('工作2')
    await settled()
    expect(service.snapshot().phase).toBe('failed')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('reports the current verification requirement in flat observation and verification results', async () => {
    scripts.push(async (runtime) => {
      const before = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
      expect(before).toMatchObject({
        observation_id: 'obs-1',
        window_id: 'window',
        completion_verification_required: true,
      })
      await call(runtime, 'coloop_execute', {
        observation_id: before.observation_id,
        action: { action: 'paste', target_id: 1, text: '追加正文' },
      })
      const after = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
      expect(after).toMatchObject({
        observation_id: 'obs-2',
        completion_verification_required: true,
      })
      const verified = await call(runtime, 'coloop_verify', {
        observation_id: after.observation_id,
        evidence_mode: 'editor_text',
        expected_text: '追加正文',
      })
      expect(verified).toEqual({
        verified: true,
        source: 'uia',
        completion_verification_required: false,
        observation_id: 'obs-2',
      })
      return { content: '完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('completed')
    expect(vi.mocked(options.input).mock.calls[0][1]).not.toHaveProperty(
      'completion_verification_required',
    )
  })
  it('does not save memory when the real verification returns false', async () => {
    vi.mocked(options.input).mockResolvedValue({ verified: false, source: 'uia' })
    scripts.push(completedRun)
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('does not reuse a cached observation id after input', async () => {
    vi.mocked(options.observe).mockResolvedValue(view('cached'))
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_execute', {
        observation_id: 'cached',
        action: { action: 'click', target_id: 1 },
      })
      await expect(call(runtime, 'coloop_observe')).rejects.toThrow('FRESH_OBSERVATION_REQUIRED')
      return {}
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
  })
  it('invalidates completion evidence after another observation', async () => {
    scripts.push(async (runtime) => {
      await completedRun(runtime)
      await call(runtime, 'coloop_observe')
      return { content: '完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('invalidates completion evidence when a fresh observation fails', async () => {
    scripts.push(async (runtime) => {
      await completedRun(runtime)
      vi.mocked(options.observe).mockRejectedValueOnce(new Error('OBSERVATION_RETRY'))
      await expect(call(runtime, 'coloop_observe')).rejects.toThrow('OBSERVATION_RETRY')
      return { content: '完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('does not turn verification of existing page text into an executed task', async () => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: 'obs-1',
          evidence_mode: 'visible_text',
          expected_text: '正文',
        }),
      ).rejects.toThrow('VERIFICATION_EFFECT_NOT_PROVEN')
      return { content: '已完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('rejects an existing title after a no-op click and preserves the initial observation', async () => {
    const initial = { ...view('before'), ocr_text: '原有标题\n正文' }
    vi.mocked(options.observe)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...view('after'), ocr_text: '原有标题\n正文' })
    vi.mocked(options.execution.execute).mockImplementation(async (value) => ({
      ok: true,
      receipt: { command_id: value.command_id, outcome: 'input_sent' },
    }))
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      initial.ocr_text = '' // A caller mutating its object cannot change the baseline.
      await call(runtime, 'coloop_execute', {
        observation_id: 'before',
        action: { action: 'click', target_id: 1 },
      })
      await call(runtime, 'coloop_observe')
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: 'after',
          evidence_mode: 'visible_text',
          expected_text: '原有标题',
        }),
      ).rejects.toThrow('VERIFICATION_EFFECT_NOT_PROVEN')
      return { content: '已完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.input).not.toHaveBeenCalled()
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('retains a successful effect proof when an extra original-title predicate is rejected', async () => {
    vi.mocked(options.observe)
      .mockResolvedValueOnce({ ...view('obs-1'), ocr_text: '原有标题' })
      .mockResolvedValueOnce({ ...view('obs-2'), ocr_text: '原有标题\n追加中文正文' })
    scripts.push(async (runtime) => {
      const result = await completedRun(runtime)
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: 'obs-2',
          evidence_mode: 'editor_text',
          expected_text: '原有标题',
        }),
      ).rejects.toThrow('VERIFICATION_EFFECT_NOT_PROVEN')
      return result
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('completed')
    expect(options.input).toHaveBeenCalledOnce()
    expect(options.memory.enqueue).toHaveBeenCalledOnce()
  })
  it.each(['false', 'error'])(
    'clears successful proof when a subsequent native readback returns %s',
    async (outcome) => {
      vi.mocked(options.input).mockResolvedValueOnce({ verified: true, source: 'uia' })
      if (outcome === 'false')
        vi.mocked(options.input).mockResolvedValueOnce({ verified: false, source: 'uia' })
      else vi.mocked(options.input).mockRejectedValueOnce(new Error('READBACK_UNAVAILABLE'))
      scripts.push(async (runtime) => {
        const result = await completedRun(runtime)
        const check = call(runtime, 'coloop_verify', {
          observation_id: 'obs-2',
          evidence_mode: 'editor_text',
          expected_text: '追加中文正文',
        })
        if (outcome === 'false') expect(await check).toMatchObject({ verified: false })
        else await expect(check).rejects.toThrow('READBACK_UNAVAILABLE')
        return result
      })
      await service.startTask('工作')
      await settled()
      expect(service.snapshot().phase).toBe('blocked')
      expect(options.input).toHaveBeenCalledTimes(2)
      expect(options.memory.enqueue).not.toHaveBeenCalled()
    },
  )
  it('accepts real readback of a new textual result absent from the initial screen', async () => {
    vi.mocked(options.observe)
      .mockResolvedValueOnce({ ...view('before'), ocr_text: '标题' })
      .mockResolvedValueOnce({ ...view('after'), ocr_text: '标题\n保存成功' })
    vi.mocked(options.execution.execute).mockImplementation(async (value) => ({
      ok: true,
      receipt: { command_id: value.command_id, outcome: 'input_sent' },
    }))
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_execute', {
        observation_id: 'before',
        action: { action: 'click', target_id: 1 },
      })
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_verify', {
        observation_id: 'after',
        evidence_mode: 'visible_text',
        expected_text: '保存成功',
      })
      return { content: '已保存' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('completed')
    expect(options.input).toHaveBeenCalledOnce()
  })
  it('rejects fabricated control coordinates and unknown observed targets', async () => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_execute', {
        observation_id: 'obs-1',
        action: { action: 'click', target_id: 1 },
      })
      await call(runtime, 'coloop_observe')
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: 'obs-2',
          evidence_mode: 'control_state',
          expected_state: { center: [1, 2], runtime_id: [42, 1], property: 'checked', value: true },
        }),
      ).rejects.toThrow()
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: 'obs-2',
          evidence_mode: 'control_state',
          expected_state: { target_id: 99, property: 'checked', value: true },
        }),
      ).rejects.toThrow('VERIFICATION_CONTROL_TARGET_UNBOUND')
      return {}
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.input).not.toHaveBeenCalled()
  })
  it.each([undefined, true])(
    'rejects control completion without an observed opposite boolean (%s)',
    async (checked) => {
      const target = {
        id: 1,
        runtime_id: [42, 1],
        center: [100, 200],
        ...(checked === undefined ? {} : { checked }),
      }
      vi.mocked(options.observe)
        .mockResolvedValueOnce({ ...view('before'), targets: [target] })
        .mockResolvedValueOnce({ ...view('after'), targets: [{ ...target, checked: true }] })
      scripts.push(async (runtime) => {
        await call(runtime, 'coloop_observe')
        await call(runtime, 'coloop_execute', {
          observation_id: 'before',
          action: { action: 'click', target_id: 1 },
        })
        await call(runtime, 'coloop_observe')
        await expect(
          call(runtime, 'coloop_verify', {
            observation_id: 'after',
            evidence_mode: 'control_state',
            expected_state: { target_id: 1, property: 'checked', value: true },
          }),
        ).rejects.toThrow('VERIFICATION_CONTROL_TRANSITION_UNPROVEN')
        return {}
      })
      await service.startTask('工作')
      await settled()
      expect(service.snapshot().phase).toBe('blocked')
      expect(options.input).not.toHaveBeenCalled()
    },
  )
  it('binds a verified control transition to the clicked runtime identity and observed coordinates', async () => {
    vi.mocked(options.observe)
      .mockResolvedValueOnce({
        ...view('before'),
        targets: [{ id: 1, runtime_id: [42, 1], center: [100, 200], checked: false }],
      })
      .mockResolvedValueOnce({
        ...view('after'),
        targets: [{ id: 8, runtime_id: [42, 1], center: [110, 210], checked: true }],
      })
    vi.mocked(options.input).mockResolvedValue({ verified: true, observable: true, source: 'uia' })
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_execute', {
        observation_id: 'before',
        action: { action: 'click', target_id: 1 },
      })
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_verify', {
        observation_id: 'after',
        evidence_mode: 'control_state',
        expected_state: { target_id: 8, property: 'checked', value: true },
      })
      return { content: '已勾选' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('completed')
    expect(options.input).toHaveBeenCalledWith(
      'completion.verify',
      expect.objectContaining({ observation_id: 'after' }),
      expect.objectContaining({
        expected_state: {
          center: [110, 210],
          runtime_id: [42, 1],
          property: 'checked',
          value: true,
        },
      }),
    )
  })
  it('matches the RK memory read limits before dispatch', async () => {
    scripts.push(async (runtime) => {
      await expect(call(runtime, 'coloop_memory_get', { ids: [] })).rejects.toThrow()
      await expect(
        call(runtime, 'coloop_memory_get', { ids: ['1', '2', '3', '4', '5', '6'] }),
      ).rejects.toThrow()
      await call(runtime, 'coloop_memory_get', { ids: ['1'] })
      await expect(
        call(runtime, 'coloop_memory_catalog', { tags: Array(9).fill('tag') }),
      ).rejects.toThrow()
      await call(runtime, 'coloop_memory_catalog', { query: '编辑', limit: 5 })
      return {}
    })
    await service.startTask('工作')
    await settled()
    expect(options.memory.get).toHaveBeenCalledOnce()
    expect(options.memory.catalog).toHaveBeenCalledOnce()
  })
  it('holds stop through a pending begin and obtains the eventual session release acknowledgement', async () => {
    const begin = deferred()
    vi.mocked(options.execution.begin).mockReturnValue(begin.promise)
    await service.startTask('工作')
    await vi.waitFor(() => expect(options.execution.begin).toHaveBeenCalledOnce())
    let stopFinished = false
    const stop = service.stop().then(() => {
      stopFinished = true
    })
    expect(service.snapshot().phase).toBe('stopping')
    expect(stopFinished).toBe(false)
    begin.resolve({ ok: true })
    await stop
    await settled()
    expect(options.execution.stop).toHaveBeenCalledOnce()
    expect(factory.create).not.toHaveBeenCalled()
    expect(service.snapshot().phase).toBe('cancelled')
  })
  it('requires a new observation after each action and rejects action batches', async () => {
    scripts.push(async (runtime) => {
      const observation = (await call(runtime, 'coloop_observe')) as ReturnType<typeof view>
      const action = {
        observation_id: observation.observation_id,
        action: { action: 'click', target_id: 1 },
      }
      await call(runtime, 'coloop_execute', action)
      await expect(call(runtime, 'coloop_execute', action)).rejects.toThrow(
        'FRESH_OBSERVATION_REQUIRED',
      )
      await expect(
        call(runtime, 'coloop_verify', {
          observation_id: observation.observation_id,
          evidence_mode: 'visible_text',
          expected_text: '正文',
        }),
      ).rejects.toThrow('FRESH_OBSERVATION_REQUIRED')
      await call(runtime, 'coloop_observe')
      await expect(
        call(runtime, 'coloop_execute', { observation_id: 'obs-2', actions: [action.action] }),
      ).rejects.toThrow()
      return { content: '未完成' }
    })
    await service.startTask('工作')
    await settled()
    expect(options.execution.execute).toHaveBeenCalledOnce()
    expect(options.input).not.toHaveBeenCalled()
  })
  it('returns a fresh observation with each single action and verifies without a separate observe call', async () => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      const moved = await call(runtime, 'coloop_execute', {
        observation_id: 'obs-1',
        action: { action: 'hotkey', target_id: 1, keys: 'CTRL+END' },
        observe_after: true,
      })
      expect(moved).toMatchObject({
        receipt: { outcome: 'effect_verified' },
        observation: { observation_id: 'obs-2', completion_verification_required: true },
        completion_verification_required: true,
      })
      await expect(
        call(runtime, 'coloop_execute', {
          observation_id: 'obs-1',
          action: { action: 'click', target_id: 1 },
          observe_after: true,
        }),
      ).rejects.toThrow('FRESH_OBSERVATION_REQUIRED')
      const pasted = await call(runtime, 'coloop_execute', {
        observation_id: 'obs-2',
        action: { action: 'paste', target_id: 1, text: '追加中文正文' },
        observe_after: true,
      })
      expect(pasted).toMatchObject({ observation: { observation_id: 'obs-3' } })
      await call(runtime, 'coloop_verify', {
        observation_id: 'obs-3',
        evidence_mode: 'editor_text',
        expected_text: '追加中文正文',
      })
      return { content: '已追加中文正文', finishReason: 'stop' }
    })
    await service.startTask('追加正文')
    await settled()
    expect(service.snapshot().phase).toBe('completed')
    expect(options.execution.execute).toHaveBeenCalledTimes(2)
    expect(options.observe).toHaveBeenCalledTimes(3)
    expect(options.input).toHaveBeenCalledOnce()
    expect(options.memory.enqueue).toHaveBeenCalledOnce()
  })
  it.each(['failed', 'cached'])(
    'retains the input receipt after a %s post-action observation',
    async (mode) => {
      vi.mocked(options.observe).mockResolvedValueOnce(view('before'))
      if (mode === 'failed')
        vi.mocked(options.observe).mockRejectedValueOnce(new Error('OBSERVATION_RETRY'))
      else vi.mocked(options.observe).mockResolvedValueOnce(view('before'))
      vi.mocked(options.observe).mockResolvedValueOnce(view('after'))
      scripts.push(async (runtime) => {
        await call(runtime, 'coloop_observe')
        const result = await call(runtime, 'coloop_execute', {
          observation_id: 'before',
          action: { action: 'paste', target_id: 1, text: '追加中文正文' },
          observe_after: true,
        })
        expect(result).toMatchObject({
          receipt: { outcome: 'effect_verified' },
          observation_error: 'FRESH_OBSERVATION_REQUIRED',
          completion_verification_required: true,
        })
        expect(result).not.toHaveProperty('observation')
        await expect(
          call(runtime, 'coloop_verify', {
            observation_id: 'before',
            evidence_mode: 'editor_text',
            expected_text: '追加中文正文',
          }),
        ).rejects.toThrow('FRESH_OBSERVATION_REQUIRED')
        await call(runtime, 'coloop_observe')
        await call(runtime, 'coloop_verify', {
          observation_id: 'after',
          evidence_mode: 'editor_text',
          expected_text: '追加中文正文',
        })
        return { content: '已追加中文正文', finishReason: 'stop' }
      })
      await service.startTask('追加正文')
      await settled()
      expect(service.snapshot().phase).toBe('completed')
      expect(options.execution.execute).toHaveBeenCalledOnce()
      expect(options.memory.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          receipts: [expect.objectContaining({ outcome: 'effect_verified' })],
        }),
      )
    },
  )
  it('keeps the action tool exclusive and rejects a post-action observation arriving after stop', async () => {
    const captured = deferred<ReturnType<typeof view>>()
    vi.mocked(options.observe)
      .mockResolvedValueOnce(view('before'))
      .mockReturnValueOnce(captured.promise)
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await expect(
        call(runtime, 'coloop_execute', {
          observation_id: 'before',
          action: { action: 'paste', target_id: 1, text: '追加中文正文' },
          observe_after: true,
        }),
      ).rejects.toThrow('TASK_STOPPED')
      return { content: '迟到的完成', finishReason: 'stop' }
    })
    await service.startTask('追加正文')
    await vi.waitFor(() => expect(options.observe).toHaveBeenCalledTimes(2))
    await expect(call(runtimes[0], 'coloop_observe')).rejects.toThrow('COLOOP_TOOL_BUSY')
    await service.stop()
    expect(service.active).toBe(true)
    captured.resolve(view('late'))
    await settled()
    expect(service.snapshot().phase).toBe('cancelled')
    expect(options.execution.execute).toHaveBeenCalledOnce()
    expect(options.input).not.toHaveBeenCalled()
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('requires a fresh observation after an explicit refresh fails', async () => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      vi.mocked(options.observe).mockRejectedValueOnce(new Error('OBSERVATION_RETRY'))
      await expect(call(runtime, 'coloop_observe')).rejects.toThrow('OBSERVATION_RETRY')
      await expect(
        call(runtime, 'coloop_execute', {
          observation_id: 'obs-1',
          action: { action: 'click', target_id: 1 },
        }),
      ).rejects.toThrow('FRESH_OBSERVATION_REQUIRED')
      return {}
    })
    await service.startTask('工作')
    await settled()
    expect(options.execution.execute).not.toHaveBeenCalled()
  })
  it('returns a not-sent receipt with a fresh observation without allowing task completion', async () => {
    vi.mocked(options.execution.execute).mockImplementation(async (value) => ({
      ok: false,
      receipt: { command_id: value.command_id, outcome: 'not_sent' },
    }))
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      const result = await call(runtime, 'coloop_execute', {
        observation_id: 'obs-1',
        action: { action: 'click', target_id: 1 },
        observe_after: true,
      })
      expect(result).toMatchObject({
        receipt: { outcome: 'not_sent' },
        observation: { observation_id: 'obs-2' },
      })
      await call(runtime, 'coloop_verify', {
        observation_id: 'obs-2',
        evidence_mode: 'visible_text',
        expected_text: '新页面结果',
      })
      return { content: '完成', finishReason: 'stop' }
    })
    await service.startTask('工作')
    await settled()
    expect(service.snapshot().phase).toBe('blocked')
    expect(options.observe).toHaveBeenCalledTimes(2)
    expect(options.execution.execute).toHaveBeenCalledOnce()
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'missing', 'wrong-command'])(
    'aborts and blocks new tasks on %s input receipts',
    async (outcome) => {
      vi.mocked(options.execution.execute).mockImplementation(async (value) => ({
        ok: true,
        receipt:
          outcome === 'missing'
            ? undefined
            : {
                command_id: outcome === 'wrong-command' ? 'other' : value.command_id,
                outcome: outcome === 'wrong-command' ? 'input_sent' : outcome,
              },
      }))
      scripts.push(async (runtime) => {
        await call(runtime, 'coloop_observe')
        await expect(
          call(runtime, 'coloop_execute', {
            observation_id: 'obs-1',
            action: { action: 'click', target_id: 1 },
            observe_after: true,
          }),
        ).rejects.toThrow('INPUT_OUTCOME_UNKNOWN')
        await expect(call(runtime, 'coloop_observe')).rejects.toThrow('TASK_STOPPED')
        return { content: '完成', finishReason: 'stop' }
      })
      await service.startTask('工作')
      await settled()
      expect(service.snapshot().phase).toBe('input_unknown')
      expect(options.observe).toHaveBeenCalledOnce()
      expect(runtimes[0].abort).toHaveBeenCalled()
      expect(options.memory.enqueue).not.toHaveBeenCalled()
      await expect(service.startTask('重试')).rejects.toThrow('INPUT_OUTCOME_UNKNOWN')
    },
  )
  it('does not retry a transport failure without a known receipt', async () => {
    vi.mocked(options.execution.execute).mockRejectedValue(
      new Error('private payload should not reach UI'),
    )
    scripts.push(completedRun)
    await service.startTask('工作')
    await settled()
    expect(options.execution.execute).toHaveBeenCalledOnce()
    expect(service.snapshot()).toMatchObject({
      phase: 'input_unknown',
      error: 'INPUT_OUTCOME_UNKNOWN',
    })
  })
  it.each([
    ['Ctrl+End', 'CTRL+END'],
    ['  ctrl+shift+end  ', 'CTRL+SHIFT+END'],
    [' enter ', 'ENTER'],
  ])('normalizes model hotkey %s before dispatch', async (keys, expected) => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_observe')
      await call(runtime, 'coloop_execute', {
        observation_id: 'obs-1',
        action: { action: 'hotkey', target_id: 1, keys },
      })
      return {}
    })
    await service.startTask('工作')
    await settled()
    expect(options.execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: { action: 'hotkey', target_id: 1, keys: expected } }),
    )
  })
  it('keeps active until SDK run settles even when stop ACK arrived', async () => {
    const finish = deferred()
    scripts.push(async () => finish.promise)
    await service.startTask('工作')
    await vi.waitFor(() => expect(runtimes[0]?.run).toHaveBeenCalled())
    await service.stop()
    expect(service.snapshot()).toMatchObject({ active: true, phase: 'stopping' })
    await expect(service.startTask('另一任务')).rejects.toThrow('TASK_BUSY')
    finish.resolve({ content: '迟到的完成', finishReason: 'stop' })
    await settled()
    expect(service.snapshot().phase).toBe('cancelled')
    expect(options.execution.stop).toHaveBeenCalledOnce()
    expect(options.memory.enqueue).not.toHaveBeenCalled()
  })
  it('requires neutral stop acknowledgement and preserves unknown after late run completion', async () => {
    const finish = deferred()
    scripts.push(async () => finish.promise)
    vi.mocked(options.execution.stop).mockResolvedValue({ ok: true, stopped: true, neutral: false })
    await service.startTask('工作')
    await vi.waitFor(() => expect(runtimes[0]?.run).toHaveBeenCalled())
    await service.stop()
    expect(service.snapshot().phase).toBe('input_unknown')
    finish.resolve({ content: '完成' })
    await settled()
    expect(service.snapshot().phase).toBe('input_unknown')
  })
  it('waits for typed user answer and rejects stale answers', async () => {
    scripts.push(async (runtime) => {
      const result = await call(runtime, 'coloop_ask_user', {
        question: '追加什么？',
        options: ['方案一', '方案二'],
      })
      expect(result).toEqual({ answer: '方案一' })
      return { content: '收到' }
    })
    await service.startTask('工作', 'question-task')
    await vi.waitFor(() => expect(service.snapshot().phase).toBe('waiting_user'))
    const id = String(service.snapshot().question?.question_id)
    expect(() => service.answer('old', id, '方案一')).toThrow('STALE_OR_INVALID_ANSWER')
    service.answer('question-task', id, '方案一')
    await settled()
    expect(service.snapshot().question).toBeUndefined()
  })
  it('stop unblocks a pending ask_user tool', async () => {
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_ask_user', { question: '确认内容？' })
      return {}
    })
    await service.startTask('工作')
    await vi.waitFor(() => expect(service.snapshot().phase).toBe('waiting_user'))
    await service.stop()
    await settled()
    expect(service.snapshot().phase).toBe('cancelled')
  })
  it('uses only a read-only official recommendation tool and accepts with fresh task observation', async () => {
    scripts.push(async (runtime) => {
      expect(runtime.options.tools.map((tool) => tool.name)).toEqual(['coloop_recommend'])
      await call(runtime, 'coloop_recommend', {
        type: 'suggestion',
        title: '补充正文',
        text: '目前只有标题',
        goal: '保留标题并追加正文',
      })
      return { content: '', finishReason: 'stop' }
    }, completedRun)
    await service.submitObservation(view('passive-1'))
    await vi.waitFor(() => expect(service.snapshot().suggestion).toBeDefined())
    expect(runtimes[0].requestLoopTermination).toHaveBeenCalledOnce()
    expect(options.execution.connect).not.toHaveBeenCalled()
    await service.acceptSuggestion(String(service.snapshot().suggestion?.suggestion_id))
    await settled()
    expect(options.observe).toHaveBeenCalledTimes(2)
    expect(service.snapshot().phase).toBe('completed')
  })
  it('requests recommendation termination only after the decision validates', async () => {
    scripts.push(async (runtime) => {
      expect(() => call(runtime, 'coloop_recommend', { type: 'suggestion' })).toThrow()
      expect(runtime.requestLoopTermination).not.toHaveBeenCalled()
      await call(runtime, 'coloop_recommend', {
        type: 'suggestion',
        title: '补充正文',
        text: '目前只有标题',
        goal: '保留标题并追加正文',
      })
      expect(runtime.requestLoopTermination).toHaveBeenCalledOnce()
      return { finishReason: 'stop' }
    })
    await service.submitObservation(view('passive-1'))
    await vi.waitFor(() => expect(service.snapshot().suggestion).toBeDefined())
  })
  it.each(['abort', 'error'])(
    'does not publish a decision from an unsuccessful recommendation run (%s)',
    async (finishReason) => {
      scripts.push(async (runtime) => {
        await call(runtime, 'coloop_recommend', {
          type: 'suggestion',
          title: '补充正文',
          text: '目前只有标题',
          goal: '追加正文',
        })
        return { finishReason }
      })
      await service.submitObservation(view('passive-1'))
      await vi.waitFor(() => expect(options.onObservationRetry).toHaveBeenCalledWith('passive-1'))
      expect(service.snapshot().suggestion).toBeUndefined()
    },
  )
  it.each([false, true])(
    'accepts a final-iteration recommendation only with deliberate termination (%s)',
    async (requested) => {
      scripts.push(async (runtime) => {
        runtime.isLoopTerminationRequested.mockReturnValue(requested)
        await call(runtime, 'coloop_recommend', {
          type: 'suggestion',
          title: '补充正文',
          text: '目前只有标题',
          goal: '追加正文',
        })
        return { finishReason: 'max_iterations' }
      })
      await service.submitObservation(view('passive-1'))
      await vi.waitFor(() => expect(runtimes[0]?.dispose).toHaveBeenCalled())
      expect(!!service.snapshot().suggestion).toBe(requested)
      expect(options.onObservationRetry).toHaveBeenCalledTimes(requested ? 0 : 1)
    },
  )
  it('discards late recommendation decisions when the page changes', async () => {
    const finish = deferred()
    scripts.push(async (runtime) => {
      await finish.promise
      await expect(
        call(runtime, 'coloop_recommend', {
          type: 'suggestion',
          title: '标题',
          text: '说明',
          goal: '动作',
        }),
      ).rejects.toThrow('OBSERVATION_EXPIRED')
      return { content: '' }
    })
    await service.submitObservation(view('passive-1'))
    await vi.waitFor(() => expect(runtimes[0]?.run).toHaveBeenCalled())
    service.cancelObservation()
    finish.resolve({})
    await vi.waitFor(() => expect(runtimes[0].dispose).toHaveBeenCalled())
    expect(service.snapshot().suggestion).toBeUndefined()
  })
  it('retries unavailable and deferred passive observations without connecting RK', async () => {
    vi.mocked(options.available).mockReturnValue(false)
    await service.submitObservation(view('unavailable'))
    expect(options.onObservationRetry).toHaveBeenCalledWith('unavailable')
    vi.mocked(options.available).mockReturnValue(true)
    scripts.push(async (runtime) => {
      await call(runtime, 'coloop_recommend', { type: 'defer' })
      return {}
    })
    await service.submitObservation(view('editing'))
    await vi.waitFor(() => expect(options.onObservationRetry).toHaveBeenCalledWith('editing'))
    expect(options.execution.connect).not.toHaveBeenCalled()
  })
  it('reports startup failure rather than unknown input if RK closes before begin', async () => {
    const connection = deferred<void>()
    vi.mocked(options.execution.connect).mockReturnValue(connection.promise)
    await service.startTask('工作')
    await vi.waitFor(() => expect(options.execution.connect).toHaveBeenCalledOnce())
    service.disconnected()
    expect(service.snapshot()).toMatchObject({ connected: false, phase: 'failed' })
    connection.reject(new Error('RK_CONNECTION_CLOSED'))
    await settled()
    expect(service.snapshot()).toMatchObject({ active: false, connected: false, phase: 'failed' })
    expect(options.execution.begin).not.toHaveBeenCalled()
    expect(options.execution.execute).not.toHaveBeenCalled()
    expect(options.execution.stop).not.toHaveBeenCalled()
    expect(factory.create).not.toHaveBeenCalled()
    vi.mocked(options.execution.connect).mockResolvedValue(undefined)
    await expect(service.startTask('再次尝试')).resolves.toBeTypeOf('string')
    await settled()
  })
  it('disconnect aborts the runtime and ignores its late successful result', async () => {
    const finish = deferred()
    scripts.push(async () => finish.promise)
    await service.startTask('工作')
    await vi.waitFor(() => expect(runtimes[0]?.run).toHaveBeenCalled())
    service.disconnected()
    expect(service.snapshot()).toMatchObject({ connected: false, phase: 'input_unknown' })
    finish.resolve({ content: '完成' })
    await settled()
    expect(service.snapshot().phase).toBe('input_unknown')
  })
  it('does not mark memory saved for another task', async () => {
    scripts.push(completedRun)
    await service.startTask('工作', 'current')
    await settled()
    service.memorySaved('previous', true)
    expect(service.snapshot().memorySaved).toBeUndefined()
    service.memorySaved('current', true)
    expect(service.snapshot().memorySaved).toBe(true)
  })
})
