import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { TarsAgentService, type TarsAgentOptions } from '../src/main/services/tars-agent'
import { createTarsRuntime, type TarsRuntimeOptions } from '../src/main/infrastructure/tars-runtime'
import { createHarnessRuntime, harnessRkRequest } from '../src/main/infrastructure/harness-runtime'
import { rkTarsModel, createRkTarsFetch } from '../src/main/infrastructure/rk-tars-model'
import { projectObservationContext } from '../src/main/infrastructure/observation-context'

it.each(['none', 'connection', 'truncated'] as const)(
  'compacts growing local history through the same RK adapter, retaining the audit (failure=%s)',
  async (failure) => {
    const resume = failure !== 'none'
    const directory = await mkdtemp(join(tmpdir(), 'coloop-local-compaction-'))
    const id = 'local-compaction'
    const evidence = 'evidence '.repeat(800)
    const receipt = 'Read once; no effects. '.repeat(90)
    const input = 'Read the evidence and report. ' + evidence
    const events: any[] = []
    let calls = 0
    const summaryCaps: number[] = []
    let failSummary = resume
    const config: Parameters<typeof createHarnessRuntime>[0] = {
      id,
      workspace: directory,
      home: directory,
      runtimeResources: resolve('resources/harness'),
      model: rkTarsModel,
      instructions:
        'Read coloop_echo once, then summarize. Never repeat the tool. ' +
        'Planner-only schema guidance. '.repeat(160),
      maxIterations: 6,
      maxTokens: 1024,
      tools: [
        {
          name: 'coloop_echo',
          description: 'Read evidence once',
          parameters: { type: 'object' },
          execute: () => ({ text: receipt }),
        },
      ],
      fetch: createRkTarsFetch(async (system, messages, _signal, maxTokens) => {
        const summary = messages.at(-1)?.content.includes('[Coloop local checkpoint]')
        if (summary) {
          summaryCaps.push(maxTokens)
          expect(system).not.toContain('Planner-only schema guidance')
          expect(system).not.toContain('Read evidence once')
          expect(messages.some((message) => message.content.includes(evidence))).toBe(true)
        }
        if (failSummary && calls > 0) {
          if (failure === 'truncated') return 'Incomplete checkpoint with no ending marker'
          throw new Error('simulated interrupted model connection')
        }
        return ++calls === 1
          ? '<tool_call>{"name":"coloop_echo","parameters":{}}</tool_call>'
          : 'Evidence was read once. No writes or inputs were performed.' +
              (summary ? '\n<checkpoint-end>' : '')
      }),
      onEvent: (event) => events.push(event),
    }
    let runtime = createHarnessRuntime(config)
    try {
      if (resume) {
        // The official engine may continue on the untouched original surface
        // after a failed automatic summary. It must never persist partial text.
        expect((await runtime.run(input)).finishReason).toBe(
          failure === 'truncated' ? 'stop' : 'error',
        )
        expect(events.some((event) => event.event?.type === 'compaction/summary')).toBe(false)
        if (failure === 'truncated')
          expect(JSON.stringify(events)).toContain('COLOOP_COMPACTION_INCOMPLETE')
        await runtime.dispose()
        failSummary = false
        runtime = createHarnessRuntime({ ...config, resume: true })
      }
      const result = await runtime.run(resume ? 'Continue from the recorded evidence.' : input)
      expect(
        result.finishReason,
        JSON.stringify(
          events.filter(
            (event) => event.type === 'agent_error' || event.event?.type === 'compaction/end',
          ),
        ),
      ).toBe('stop')
      expect(calls).toBeGreaterThanOrEqual(3)
      expect(summaryCaps.length).toBeGreaterThan(0)
      expect(summaryCaps).toEqual(summaryCaps.map(() => 512))
      expect(
        events.some(
          (event) =>
            event.type === 'harness_session_event' && event.event.type === 'compaction/end',
        ),
      ).toBe(true)
      const audit = await readFile(
        join(directory, createHash('sha256').update(id).digest('hex'), 'host-events.jsonl'),
        'utf8',
      )
      expect(audit).toContain(receipt)
      expect(audit.match(/"type":"tool_intent"/g)).toHaveLength(1)
      const sessions = join(directory, createHash('sha256').update(id).digest('hex'), 'sessions')
      const log = (await readdir(sessions, { recursive: true })).find((name) =>
        name.endsWith('session.v4.jsonl'),
      )
      expect(log).toBeDefined()
      const persisted = await readFile(join(sessions, log!), 'utf8')
      expect(persisted).toContain(evidence)
      expect(persisted).toContain('"type":"compaction/summary"')
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)

it('drops obsolete visual payloads only from file-only model context while preserving receipts and file evidence', async () => {
  const observation = {
    observation_id: 'old-screen',
    window_id: 'window',
    ocr_items: [],
    ocr_text: '旧屏幕'.repeat(6000),
  }
  const receipt = { command_id: 'once', outcome: 'effect_verified' }
  const source = {
    model: rkTarsModel.id,
    messages: [
      { role: 'user', content: '恢复授权目录中的文件任务' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'action', function: { name: 'coloop_execute', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'action', content: JSON.stringify({ receipt, observation }) },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'file',
            function: { name: 'coloop_copy_file', arguments: '{"source":"a","path":"b"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'file',
        content: '{"committed":true,"artifact_id":"existing-copy","sha256":"file-proof"}',
      },
    ],
    tools: [
      { type: 'function', function: { name: 'coloop_copy_file', parameters: { type: 'object' } } },
    ],
  }
  const original = JSON.stringify(source)
  const request = harnessRkRequest(source)
  const projected = JSON.parse(
    request.messages
      .find((m: { content: string }) => m.content.startsWith('Tool: coloop_execute'))
      .content.split('Result:\n')[1],
  )
  expect(projected.receipt).toEqual(receipt)
  expect(projected.observation).toMatchObject({ observation_id: 'old-screen', superseded: true })
  expect(projected.observation.ocr_text).toBeUndefined()
  expect(JSON.stringify(request)).toContain('file-proof')
  expect(JSON.stringify(source)).toBe(original)
  const infer = vi.fn(async () => '继续核对文件')
  const response = await createRkTarsFetch(infer)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify(request),
  })
  expect(response.ok).toBe(true)
  expect(infer).toHaveBeenCalledTimes(1)
  const native = harnessRkRequest({
    ...source,
    tools: [
      ...source.tools,
      { type: 'function', function: { name: 'coloop_execute', parameters: { type: 'object' } } },
    ],
  })
  expect(JSON.stringify(native)).toContain(observation.ocr_text)
})

it('fits the current full grouped service catalog into the RK byte budget through real Harness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-harness-local-budget-'))
  let captured: TarsRuntimeOptions | undefined
  const options: TarsAgentOptions = {
    workspace: directory,
    model: () => rkTarsModel,
    preferLocal: () => true,
    localModel: () => ({ model: rkTarsModel, fetch: globalThis.fetch }),
    recommendLocal: async () => '{"type":"ignore"}',
    available: () => true,
    assertStart() {},
    prepareInput: async () => {},
    onChange() {},
    observe: async () => ({
      observation_id: 'fixture',
      window_id: 'window',
      process_id: 5,
      ocr_text: '',
      targets: [],
    }),
    input: async () => ({ verified: true }),
    execution: {
      connect: async () => {},
      begin: async () => ({ ok: true }),
      execute: async () => ({ ok: true }),
      stop: async () => ({ ok: true, stopped: true, neutral: true }),
      dispose: async () => {},
    },
    memory: {
      enqueue: async () => ({ ok: true }),
      catalog: async () => ({ ok: true, result: [] }),
      get: async () => ({ ok: true, result: [] }),
      dispose: async () => {},
    },
    consult: vi.fn(async () => ({})),
    schedule: vi.fn(),
    readWeb: vi.fn(),
    openWeb: vi.fn(),
    readEditor: vi.fn(),
    openWorkspace: vi.fn(
      async () =>
        ({ root: directory }) as Awaited<
          ReturnType<NonNullable<TarsAgentOptions['openWorkspace']>>
        >,
    ),
    createRuntime: (config) => {
      captured = config
      return {
        initialize: async () => {},
        run: async () => ({ content: 'catalog capture only', finishReason: 'stop' }),
        abort() {},
        dispose: async () => {},
      }
    },
  }
  const service = new TarsAgentService(options)
  let runtime: ReturnType<typeof createHarnessRuntime> | undefined
  try {
    await service.startTask('复制本地文件', undefined, 'auto', directory)
    await vi.waitFor(() => expect(service.active).toBe(false))
    expect(captured).toBeDefined()
    const measured: number[] = []
    runtime = createHarnessRuntime({
      ...captured!,
      id: 'harness-rk-budget',
      home: join(directory, 'harness'),
      runtimeResources: resolve('resources/harness'),
      model: rkTarsModel,
      requestContext: undefined,
      completion: undefined,
      maxIterations: 3,
      fetch: createRkTarsFetch(async (system, messages) => {
        measured.push(
          Buffer.byteLength(system + messages.map((message) => message.content).join('\n')) + 1152,
        )
        return '只测提示预算，未执行电脑操作。'
      }),
    })
    const result = await runtime.run('复制input.txt为copy.txt')
    expect(result.finishReason).toBe('stop')
    expect(measured).toHaveLength(1)
    expect(measured[0]).toBeLessThan(8000)
    expect(captured!.tools.some((tool) => tool.name === 'coloop_patch_text')).toBe(true)
    expect(captured!.tools.some((tool) => tool.name === 'coloop_web')).toBe(true)
  } finally {
    await runtime?.dispose()
    await service.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

// Real official tool loops, synthetic native results, and an in-process model
// callback: these tests never connect to RK, cloud providers or the desktop.
it.each(['tars', 'harness'] as const)(
  'fits every dense native turn through the real %s SDK and retrieves a clipped tail target',
  async (engine) => {
    const directory = await mkdtemp(join(tmpdir(), `coloop-${engine}-dense-budget-`))
    const dense = (observationId: string) => ({
      observation_id: observationId,
      window_id: 'isolated-fixture',
      process_name: 'ActionTaskLab',
      editable_focus: false,
      ocr_text: '只在宿主保留的完整中文观察。\n'.repeat(2000),
      ocr_items: [],
      targets: Array.from({ length: 200 }, (_, index) => ({
        id: index + 1,
        name:
          (index === 199 ? '最后保存按钮：' : `控件${index + 1}：`) +
          '不可切断的名称描述'.repeat(16),
        type: 'Button',
        enabled: true,
        pointer_only: true,
        runtime_id: [42, index],
        center: [40, index * 10],
      })),
    })
    const hostObservation = dense('dense-1')
    const original = JSON.stringify(hostObservation)
    const observedQueries: unknown[] = []
    const measurements: number[] = []
    const lastMessages: string[] = []
    let turn = 0
    const hostProjection = (
      source: Record<string, unknown>,
      query?: string,
      requiredTargetIds?: number[],
    ) => {
      const projection = projectObservationContext(source, {
        budgetBytes: 6000,
        query,
        requiredTargetIds,
      })
      if (!projection.ok) throw new Error(projection.code)
      return projection.value
    }
    const input = vi.fn(() => ({
      receipt: { command_id: 'fixture-command', outcome: 'input_sent', release_confirmed: true },
      observation: hostProjection(dense('dense-2'), undefined, [200]),
    }))
    const complete = vi.fn(async (system: string, messages: { content: string }[]) => {
      turn++
      lastMessages.push(messages.at(-1)!.content.slice(0, 220))
      const bytes =
        Buffer.byteLength(system + messages.map((message) => message.content).join('\n')) + 1152
      measurements.push(bytes)
      expect(bytes).toBeLessThanOrEqual(16384)
      if (turn === 1) return '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>'
      const content = messages.at(-1)!.content
      const result = JSON.parse(content.split('Result:\n')[1])
      const observation = result.observation ?? result
      if (turn === 2) {
        expect(observation.truncated).toBe(true)
        expect(observation.omitted_count).toBeGreaterThan(0)
        expect(observation.targets.some((target: { id: number }) => target.id === 200)).toBe(false)
        return '<tool_call>{"name":"coloop_observe","parameters":{"observation_id":"dense-1","query":"最后保存"}}</tool_call>'
      }
      if (turn === 3) {
        expect(observation.query).toBe('最后保存')
        expect(observation.matched_count).toBe(1)
        expect(observation.targets).toHaveLength(1)
        expect(observation.targets[0].id).toBe(200)
        expect(observation.omitted_count).toBe(199)
        return '<tool_call>{"name":"coloop_execute","parameters":{"observation_id":"dense-1","action":{"action":"click","target_id":200},"observe_after":true}}</tool_call>'
      }
      expect(turn).toBe(4)
      expect(result.receipt.command_id).toBe('fixture-command')
      expect(observation.observation_id).toBe('dense-2')
      expect(observation.targets).toContainEqual(
        expect.objectContaining({ id: 200, name: expect.stringContaining('最后保存按钮') }),
      )
      expect(messages.slice(0, -1).some((message) => message.content.includes('superseded'))).toBe(
        true,
      )
      return 'dense-fixture-complete'
    })
    const options: TarsRuntimeOptions = {
      id: engine + '-dense-budget',
      workspace: directory,
      model: rkTarsModel,
      instructions: '按工具观察、检索目标后单步执行。只依据宿主回执报告。'.repeat(60),
      maxIterations: 6,
      fetch: createRkTarsFetch(complete),
      tools: [
        {
          name: 'coloop_observe',
          description: 'Read the native fixture; query searches the same cached observation.',
          parameters: {
            type: 'object',
            properties: { observation_id: { type: 'string' }, query: { type: 'string' } },
            additionalProperties: false,
          },
          execute: (raw) => {
            const args = raw as { observation_id?: string; query?: string }
            observedQueries.push(args)
            if (!args.query) return hostProjection(hostObservation)
            expect(args.observation_id).toBe(hostObservation.observation_id)
            return {
              ...hostProjection(hostObservation, args.query),
              model_context_query: args.query,
            }
          },
        },
        {
          name: 'coloop_execute',
          description: 'Record a synthetic receipt and a dense post-action observation.',
          parameters: {
            type: 'object',
            properties: {
              observation_id: { type: 'string' },
              action: {
                type: 'object',
                properties: { action: { const: 'click' }, target_id: { type: 'integer' } },
                required: ['action', 'target_id'],
                additionalProperties: false,
              },
              observe_after: { type: 'boolean' },
            },
            required: ['observation_id', 'action', 'observe_after'],
            additionalProperties: false,
          },
          execute: input,
        },
      ],
    }
    const runtime =
      engine === 'tars'
        ? createTarsRuntime(options)
        : createHarnessRuntime({
            ...options,
            home: join(directory, 'harness'),
            runtimeResources: resolve('resources/harness'),
          })
    try {
      const result = await runtime.run('定位最后保存按钮并读取执行回执')
      expect(
        result.finishReason,
        JSON.stringify({
          result,
          measurements,
          lastMessages,
          turns: complete.mock.calls.length,
          toolCalls: input.mock.calls.length,
        }),
      ).toBe('stop')
      expect(result.content).toBe('dense-fixture-complete')
      expect(complete).toHaveBeenCalledTimes(4)
      expect(measurements).toHaveLength(4)
      expect(Math.max(...measurements)).toBeGreaterThan(8000)
      expect(input).toHaveBeenCalledOnce()
      expect(observedQueries).toEqual([{}, { observation_id: 'dense-1', query: '最后保存' }])
      expect(JSON.stringify(hostObservation)).toBe(original)
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
  120_000,
)

it('does not retry a required-target budget rejection through the real Harness SDK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-harness-budget-rejection-'))
  let turn = 0
  const complete = vi.fn(async () =>
    ++turn === 1
      ? '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>'
      : '<tool_call>{"name":"coloop_execute","parameters":{"observation_id":"before-action","action":{"action":"click","target_id":999}}}</tool_call>',
  )
  const fetcher = vi.fn(createRkTarsFetch(complete))
  const execute = vi.fn(() => ({
    receipt: { outcome: 'input_sent', release_confirmed: true },
    observation: {
      observation_id: 'after-action',
      window_id: 'fixture',
      ocr_items: [],
      targets: [{ id: 999, name: '不能截断的必需目标标签'.repeat(700) }],
      ocr_text: '',
    },
  }))
  const runtime = createHarnessRuntime({
    id: 'required-target-rejection',
    workspace: directory,
    home: join(directory, 'harness'),
    runtimeResources: resolve('resources/harness'),
    model: rkTarsModel,
    instructions: 'Execute the synthetic test action once.',
    maxIterations: 5,
    tools: [
      {
        name: 'coloop_observe',
        description: 'Read the synthetic target identity.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => ({
          observation_id: 'before-action',
          window_id: 'fixture',
          ocr_items: [],
          targets: [{ id: 999, name: '目标' }],
          ocr_text: '',
        }),
      },
      {
        name: 'coloop_execute',
        description: 'Synthetic fixture only; performs no native input.',
        parameters: {
          type: 'object',
          properties: {
            observation_id: { type: 'string' },
            action: {
              type: 'object',
              properties: { action: { type: 'string' }, target_id: { type: 'integer' } },
              required: ['action', 'target_id'],
            },
          },
          required: ['observation_id', 'action'],
        },
        execute,
      },
    ],
    fetch: fetcher,
  })
  try {
    const result = await runtime.run('拒绝丢失的必需目标')
    expect(result.finishReason).toBe('error')
    expect(complete).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledTimes(3)
    const rejection = await fetcher.mock.results[2].value
    expect(rejection.status).toBe(400)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
