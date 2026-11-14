import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTarsRuntime } from '../src/main/infrastructure/tars-runtime'
import { createRkTarsFetch, rkTarsModel } from '../src/main/infrastructure/rk-tars-model'

const localRequest = (messages: { role: string; content: string }[]) => ({
  method: 'POST',
  body: JSON.stringify({ model: rkTarsModel.id, stream: true, messages }),
})
const denseObservation = () => ({
  observation_id: 'dense-observation',
  window_id: 'fixture-window',
  editable_focus: false,
  ocr_text: '完整本地屏幕文字\n'.repeat(3000),
  ocr_items: [],
  targets: Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    name: index === 199 ? '尾部保存按钮' : `第${index + 1}个控件：` + '完整标签与说明'.repeat(15),
    type: 'Button',
    enabled: true,
    pointer_only: true,
    runtime_id: [42, index],
    center: [20, index * 10],
  })),
})

it.each([
  [{ name: 'coloop_observe' }, { name: 'coloop_observe', parameters: {} }],
  [{ name: 'coloop_execute' }, { name: 'coloop_execute' }],
  [
    { name: 'coloop_observe', parameters: null },
    { name: 'coloop_observe', parameters: null },
  ],
])('normalizes only omitted zero-argument observation envelopes (%j)', async (raw, expected) => {
  const response = await createRkTarsFetch(
    async () => '<tool_call>' + JSON.stringify(raw) + '</tool_call>',
  )(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: rkTarsModel.id,
      stream: true,
      messages: [{ role: 'user', content: '观察当前窗口' }],
    }),
  })
  const chunk = JSON.parse((await response.text()).split('\n')[0].slice(6))
  expect(chunk.choices[0].delta.content).toBe(
    '<tool_call>' + JSON.stringify(expected) + '</tool_call>',
  )
})

it.each([
  ['parameters', 'coloop_probe', 'coloop_probe'],
  ['arguments', 'coloop_probe', 'coloop_probe'],
  ['parameters', 'coloop_recommend', 'tool_recommend'],
  ['arguments', 'coloop_recommend', 'tool_recommend'],
])(
  'runs the RK %s envelope through advertised %s for returned %s',
  async (field, advertisedName, returnedName) => {
    const directory = await mkdtemp(join(tmpdir(), 'coloop-rk-model-'))
    const execute = vi.fn(() => ({ token: 'native-sdk-result-8293' }))
    const complete = vi.fn(
      async (system: string, messages: { role: 'user' | 'assistant'; content: string }[]) => {
        expect(system).toContain('<tool_instruction>')
        expect(system).toContain(advertisedName)
        return messages.some((m) => m.content.includes('native-sdk-result-8293'))
          ? '已读回 native-sdk-result-8293'
          : '<tool_call>' + JSON.stringify({ name: returnedName, [field]: {} }) + '</tool_call>'
      },
    )
    const runtime = createTarsRuntime({
      id: 'rk-probe',
      workspace: directory,
      model: rkTarsModel,
      instructions: `Call ${advertisedName} once and report the actual token.`,
      tools: [
        {
          name: advertisedName,
          description: 'Read the token.',
          parameters: { type: 'object', properties: {} },
          execute,
        },
      ],
      fetch: createRkTarsFetch(complete),
      maxIterations: 5,
    })
    try {
      const result = await runtime.run('读取测试标记')
      expect(result.finishReason).toBe('stop')
      expect(result.content).toContain('native-sdk-result-8293')
      expect(execute).toHaveBeenCalledOnce()
      expect(complete).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it('rejects foreign endpoints before any RK model call', async () => {
  const complete = vi.fn()
  const fetch = createRkTarsFetch(complete)
  await expect(
    fetch('https://example.com/v1/chat/completions', { method: 'POST' }),
  ).rejects.toThrow('RK_MODEL_ENDPOINT_NOT_ALLOWED')
  expect(complete).not.toHaveBeenCalled()
})

it.each([
  [{ max_tokens: 256 }, 256],
  [{ max_completion_tokens: 512 }, 512],
  [{ max_tokens: 512, max_completion_tokens: 256 }, 256],
  [{ max_tokens: 1024 }, 1024],
  [{}, 1024],
])('honors the actual per-request output cap for local summaries: %j', async (fields, expected) => {
  const complete = vi.fn(
    async (_system: string, _messages: unknown, _signal: AbortSignal, _maxTokens: number) =>
      '短摘要',
  )
  const response = await createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: rkTarsModel.id,
      stream: true,
      messages: [{ role: 'user', content: '汇总已完成项，保留失败与未完成项。' }],
      ...fields,
    }),
  })
  expect(response.ok).toBe(true)
  expect(complete.mock.calls[0][3]).toBe(expected)
})

it('rejects an invalid output cap before starting local inference', async () => {
  const complete = vi.fn(async () => 'unreachable')
  await expect(
    createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: rkTarsModel.id,
        stream: true,
        max_tokens: 0,
        messages: [{ role: 'user', content: 'invalid cap' }],
      }),
    }),
  ).rejects.toThrow()
  expect(complete).not.toHaveBeenCalled()
})

it.each([
  [
    { name: 'coloop_enable_tools', group: 'native' },
    { name: 'coloop_enable_tools', parameters: { group: 'native' } },
  ],
  [
    { name: 'coloop_ask_user', question: '选择目标', options: ['A', 'B'] },
    { name: 'coloop_ask_user', parameters: { question: '选择目标', options: ['A', 'B'] } },
  ],
  [{ name: 'coloop_execute', action: { action: 'click', target_id: 1 } }, undefined],
  [{ name: 'coloop_enable_tools', group: 'unknown' }, undefined],
  [{ name: 'coloop_enable_tools', group: 'native', parameters: {} }, undefined],
  [{ name: 'coloop_ask_user', question: '选择目标', action: 'click' }, undefined],
])('normalizes only validated flat non-input envelopes: %j', async (call, expected) => {
  const raw = '<tool_call>' + JSON.stringify(call) + '</tool_call>'
  const response = await createRkTarsFetch(async () => raw)(
    rkTarsModel.baseURL + '/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: rkTarsModel.id,
        stream: true,
        messages: [{ role: 'user', content: '测试' }],
      }),
    },
  )
  const frame = JSON.parse((await response.text()).split('\n')[0].slice(6))
  expect(frame.choices[0].delta.content).toBe(
    expected ? '<tool_call>' + JSON.stringify(expected) + '</tool_call>' : raw,
  )
})

it.each([
  ['固定规则', 'tool_recommend'],
  ['coloop_recommend是唯一只读工具', 'tool_execute'],
])('does not normalize undeclared or writable aliases (%s, %s)', async (system, name) => {
  const raw =
    '<tool_call>' + JSON.stringify({ name, parameters: { action: 'click' } }) + '</tool_call>'
  const response = await createRkTarsFetch(async () => raw)(
    rkTarsModel.baseURL + '/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({
        model: rkTarsModel.id,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: '测试' },
        ],
      }),
    },
  )
  const first = (await response.text()).split('\n')[0].slice('data: '.length)
  expect(JSON.parse(first).choices[0].delta.content).toBe(raw)
})

it.each(['coloop_verify', 'coloop_verify_artifact', 'coloop_web'])(
  'directs the local model to finish after a successful final %s result',
  async (tool) => {
    const complete = vi.fn(async () => '实际结果已核验')
    await createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: rkTarsModel.id,
        stream: true,
        messages: [
          { role: 'system', content: '固定规则' },
          { role: 'user', content: '原任务' },
          {
            role: 'assistant',
            content: '<tool_call>' + JSON.stringify({ name: tool }) + '</tool_call>',
          },
          {
            role: 'user',
            content:
              'Tool: ' +
              tool +
              '\nResult:\n' +
              JSON.stringify({ verified: true, completion_verification_required: false }),
          },
        ],
      }),
    })
    expect((complete.mock.calls as unknown as [string][])[0][0]).toContain(
      '直接用中文简短报告实际结果',
    )
  },
)

it('compacts the actual official SDK observation message shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-rk-observation-'))
  let step = 0
  const complete = vi.fn(async (_system: string, messages: { role: string; content: string }[]) => {
    step++
    if (step === 1) return '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>'
    return '已观察'
  })
  const runtime = createTarsRuntime({
    id: 'rk-observation-probe',
    workspace: directory,
    model: rkTarsModel,
    instructions: '观察一次并回答。',
    maxIterations: 3,
    tools: [
      {
        name: 'coloop_observe',
        description: '观察',
        parameters: { type: 'object', properties: {} },
        execute: () => ({
          observation_id: 'obs',
          window_id: 'window',
          ocr_text: '真实结果',
          ocr_items: [],
          editable_focus: true,
          editable_runtime_id: [42, 9],
          targets: [{ id: 2, runtime_id: [42, 9], name: '编辑区' }],
        }),
      },
    ],
    fetch: createRkTarsFetch(complete),
  })
  try {
    const result = await runtime.run('观察')
    expect(complete.mock.calls[1][1].at(-1)?.content).toContain('focused_target_id')
    expect(complete.mock.calls[1][1].at(-1)?.content).toContain('当前编辑器已聚焦')
    expect(complete.mock.calls[1][1].at(-1)?.content).toContain('coloop_patch_text')
    expect(complete.mock.calls[1][1].at(-1)?.content).not.toContain('runtime_id')
    expect(result.finishReason).toBe('stop')
    expect(result.content).toBe('已观察')
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('reduces obsolete visual metadata while preserving goals, inputs, receipts and the latest targets', async () => {
  const complete = vi.fn(async () => '继续')
  const observation = (id: string, text: string) => ({
    observation_id: id,
    window_id: 'window',
    process_id: 7,
    editable_runtime_id: [42, 9],
    editable_focus: true,
    ocr_text: text,
    ocr_items: [{ id: 1, text, rect: [1, 2, 3, 4], center: [2, 3], confidence: 1 }],
    targets: [{ id: 2, name: '编辑区', runtime_id: [42, 9], center: [2, 3], rect: [1, 2, 3, 4] }],
  })
  const toolResult = (name: string, value: unknown) => ({
    role: 'user',
    content: `Tool: ${name}\\nResult:\\n${JSON.stringify(value)}`,
  })
  const messages = [
    { role: 'system', content: '固定规则' },
    { role: 'user', content: '保留全部原始目标' },
    { role: 'assistant', content: '<tool_call>观察</tool_call>' },
    toolResult('coloop_observe', observation('old', '旧状态')),
    { role: 'assistant', content: '<tool_call>粘贴真实中文</tool_call>' },
    toolResult('coloop_execute', {
      receipt: { command_id: 'command', outcome: 'effect_verified', release_confirmed: true },
      observation: observation('new', '实际中文结果'),
    }),
  ]
  await createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: rkTarsModel.id, stream: true, messages }),
  })
  const sent = (
    complete.mock.calls as unknown as [string, { role: string; content: string }[]][]
  )[0][1]
  expect(sent[0].content).toBe('保留全部原始目标')
  expect(sent[2].content).toContain('superseded')
  expect(sent[2].content).not.toContain('旧状态')
  expect(sent[3].content).toContain('真实中文')
  expect(sent[4].content).toContain('effect_verified')
  expect(sent[4].content).toContain('实际中文结果')
  expect(sent[4].content).toContain('focused_target_id')
  expect(sent[4].content).not.toContain('runtime_id')
  expect(messages[3].content).toContain('旧状态')
})

it('removes superseded verification hints while retaining actual edit IDs and receipts', async () => {
  const complete = vi.fn(async () => '继续')
  const observation = {
    observation_id: 'old',
    window_id: 'window',
    ocr_text: '原文',
    ocr_items: [],
    targets: [],
  }
  const messages = [
    { role: 'user', content: '保存后核验实际结果' },
    { role: 'assistant', content: '<tool_call>编辑</tool_call>' },
    {
      role: 'user',
      content:
        'Tool: coloop_execute\nResult:\n' +
        JSON.stringify({
          editor_edit_id: 'issued-id',
          receipt: { outcome: 'effect_verified' },
          verification_hint: { expected_edit_id: 'issued-id' },
          observation,
        }),
    },
    { role: 'assistant', content: '<tool_call>保存</tool_call>' },
    {
      role: 'user',
      content:
        'Tool: coloop_execute\nResult:\n' +
        JSON.stringify({
          verification_hint: { evidence_mode: 'visible_text' },
          observation: { ...observation, observation_id: 'new', ocr_text: '已保存' },
        }),
    },
  ]
  await createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: rkTarsModel.id, stream: true, messages }),
  })
  const sent = (complete.mock.calls as unknown as [string, typeof messages][])[0][1]
  const oldResult = JSON.parse(sent[2].content.split('Result:\n')[1])
  expect(oldResult).not.toHaveProperty('verification_hint')
  expect(oldResult.editor_edit_id).toBe('issued-id')
  expect(oldResult.receipt.outcome).toBe('effect_verified')
  expect(JSON.parse(sent[4].content.split('Result:\n')[1]).verification_hint).toEqual({
    evidence_mode: 'visible_text',
  })
  expect(messages[2].content).toContain('verification_hint')
})

it('cancels a pending RK request and never returns a late model reply', async () => {
  let finish!: (answer: string) => void
  const complete = vi.fn(
    (
      _system: string,
      _messages: { role: 'user' | 'assistant'; content: string }[],
      _signal: AbortSignal,
    ) =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const controller = new AbortController()
  const pending = createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({
      model: rkTarsModel.id,
      stream: true,
      messages: [{ role: 'user', content: 'test' }],
    }),
  })
  const rejected = expect(pending).rejects.toThrow()
  controller.abort()
  finish('late reply')
  await rejected
  expect(complete.mock.calls[0][2]).toBe(controller.signal)
})

it('compacts only JSON formatting in file history while preserving every business value and user goal', async () => {
  const complete = vi.fn(async () => '完成')
  const source = {
    path: '订单.txt',
    text: '私人便笺\n保留  两个空格',
    sha256: 'actual-source-digest',
    contract: { properties: { operation: { const: 'copy_file' } } },
  }
  const call = {
    name: 'coloop_workspace',
    parameters: { operation: 'help', arguments: { subject: 'copy_file' } },
  }
  const messages = [
    { role: 'user', content: '保留原始目标  两个空格' },
    {
      role: 'assistant',
      content: '<tool_call>\n' + JSON.stringify(call, null, 2) + '\n</tool_call>',
    },
    {
      role: 'user',
      content: 'Tool: coloop_workspace\nResult:\n' + JSON.stringify(source, null, 2),
    },
  ]
  await createRkTarsFetch(complete)(rkTarsModel.baseURL + '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: rkTarsModel.id, stream: true, messages }),
  })
  const sent = (complete.mock.calls as unknown as [string, typeof messages][])[0][1]
  expect(sent[0]).toEqual(messages[0])
  expect(sent[1].content).toBe('<tool_call>' + JSON.stringify(call) + '</tool_call>')
  expect(JSON.parse(sent[2].content.split('Result:\n')[1])).toEqual(source)
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(messages)),
  )
  expect(messages[2].content).toContain('  "path"')
})

it('refreshes the official SDK tool catalog after enabling a group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-local-disclosure-'))
  let enabled = false
  const probe = vi.fn(() => ({ token: 'actual-probe-629' }))
  const complete = vi.fn(async (system: string, messages: { role: string; content: string }[]) => {
    if (messages.some((message) => message.content.includes('actual-probe-629')))
      return '实际令牌 actual-probe-629'
    if (enabled) {
      expect(system).toContain('## coloop_probe')
      return '<tool_call>{"name":"coloop_probe","parameters":{}}</tool_call>'
    }
    expect(system).not.toContain('## coloop_probe')
    return '<tool_call>{"name":"coloop_enable_tools","parameters":{}}</tool_call>'
  })
  const runtime = createTarsRuntime({
    id: 'disclosure-probe',
    workspace: directory,
    model: rkTarsModel,
    instructions: '启用工具后读取令牌并回报。',
    maxIterations: 5,
    visibleTool: (name) => name === 'coloop_enable_tools' || enabled,
    tools: [
      {
        name: 'coloop_enable_tools',
        description: '启用读取工具',
        parameters: { type: 'object', properties: {} },
        execute: () => {
          enabled = true
          return { enabled: true }
        },
      },
      {
        name: 'coloop_probe',
        description: '读取实际令牌',
        parameters: { type: 'object', properties: {} },
        execute: probe,
      },
    ],
    fetch: createRkTarsFetch(complete),
  })
  try {
    const result = await runtime.run('读取令牌')
    expect(result.content).toContain('actual-probe-629')
    expect(probe).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledTimes(3)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['coloop_execute', 'coloop_patch_text'])(
  'budgets dense latest observations against full history and retains the last %s target',
  async (tool) => {
    const complete = vi.fn(async () => '已读取')
    const latest = denseObservation()
    const action =
      tool === 'coloop_execute'
        ? {
            observation_id: 'old',
            action: { action: 'click', target_id: 200 },
            observe_after: true,
          }
        : { observation_id: 'old', target_id: 200, old_text: '原始正文', new_text: '实际替换正文' }
    const goal = '必须保留的原任务，含中文与引号"。'.repeat(60)
    const messages = [
      { role: 'system', content: '不可删除的系统规则。'.repeat(160) },
      { role: 'user', content: goal },
      {
        role: 'assistant',
        content: '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>',
      },
      {
        role: 'user',
        content:
          'Tool: coloop_observe\nResult:\n' + JSON.stringify({ ...latest, observation_id: 'old' }),
      },
      {
        role: 'assistant',
        content:
          '将执行这一项明确动作。\n<tool_call>' +
          JSON.stringify({ name: tool, parameters: action }) +
          '</tool_call>',
      },
      {
        role: 'user',
        content:
          'Tool: ' +
          tool +
          '\nResult:\n' +
          JSON.stringify({
            receipt: {
              command_id: 'real-command-id',
              outcome: 'input_sent',
              release_confirmed: true,
            },
            verification_hint: { expected_text: '需完整保留的核验正文' },
            observation: latest,
          }),
      },
    ]
    const original = JSON.stringify(messages)
    const response = await createRkTarsFetch(complete)(
      rkTarsModel.baseURL + '/chat/completions',
      localRequest(messages),
    )
    expect(response.status).toBe(200)
    const [system, sent, , maxTokens] = (
      complete.mock.calls as unknown as [string, { content: string }[], AbortSignal, number][]
    )[0]
    expect(
      Buffer.byteLength(system + sent.map((message) => message.content).join('\n')) + 1152,
    ).toBeLessThanOrEqual(16384)
    expect(maxTokens).toBe(1024)
    expect(sent[0].content).toBe(goal)
    expect(sent[2].content).toContain('superseded')
    expect(sent[2].content).not.toContain('完整本地屏幕文字')
    const result = JSON.parse(sent.at(-1)!.content.split('Result:\n')[1])
    expect(result.receipt).toEqual({
      command_id: 'real-command-id',
      outcome: 'input_sent',
      release_confirmed: true,
    })
    expect(result.verification_hint.expected_text).toBe('需完整保留的核验正文')
    expect(result.observation.truncated).toBe(true)
    expect(result.observation.omitted_count).toBeGreaterThan(0)
    expect(result.observation.targets).toContainEqual(
      expect.objectContaining({ id: 200, name: '尾部保存按钮', pointer_only: true, enabled: true }),
    )
    expect(JSON.stringify(messages)).toBe(original)
  },
)

it('uses the observation query to expose a tail target omitted by the general view', async () => {
  const complete = vi.fn(async () => '已定位')
  const observation = denseObservation()
  const messages = [
    { role: 'system', content: '本地规则'.repeat(900) },
    { role: 'user', content: '定位尾部保存按钮' },
    {
      role: 'assistant',
      content:
        '<tool_call>{"name":"coloop_observe","parameters":{"observation_id":"dense-observation","query":"尾部保存"}}</tool_call>',
    },
    {
      role: 'user',
      content:
        'Tool: coloop_observe\nResult:\n' +
        JSON.stringify({ ...observation, model_context_query: '尾部保存' }),
    },
  ]
  const response = await createRkTarsFetch(complete)(
    rkTarsModel.baseURL + '/chat/completions',
    localRequest(messages),
  )
  expect(response.status).toBe(200)
  const [, sent] = (complete.mock.calls as unknown as [string, { content: string }[]][])[0]
  const result = JSON.parse(sent.at(-1)!.content.split('Result:\n')[1])
  expect(result.query).toBe('尾部保存')
  expect(result.matched_count).toBe(1)
  expect(result.targets).toHaveLength(1)
  expect(result.targets[0].id).toBe(200)
})

it.each([
  [
    'metadata cannot fit',
    { ...denseObservation(), observation_id: '不能截断的身份'.repeat(1000) },
    'OBSERVATION_CONTEXT_BUDGET',
  ],
  [
    'required target cannot fit',
    { ...denseObservation(), targets: [{ id: 200, name: '不能截断的目标标签'.repeat(1000) }] },
    'OBSERVATION_CONTEXT_BUDGET',
  ],
])('rejects %s with a nonretryable local 400 before RK', async (_label, observation, error) => {
  const complete = vi.fn(async () => '不得执行')
  const messages = [
    { role: 'user', content: '保留目标身份' },
    {
      role: 'assistant',
      content: '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>',
    },
    {
      role: 'user',
      content:
        'Tool: coloop_observe\nResult:\n' +
        JSON.stringify({ ...denseObservation(), observation_id: 'before-input' }),
    },
    {
      role: 'assistant',
      content:
        '<tool_call>{"name":"coloop_execute","parameters":{"observation_id":"before-input","action":{"action":"click","target_id":200}}}</tool_call>',
    },
    {
      role: 'user',
      content:
        'Tool: coloop_execute\nResult:\n' +
        JSON.stringify({ receipt: { outcome: 'input_sent' }, observation }),
    },
  ]
  const response = await createRkTarsFetch(complete)(
    rkTarsModel.baseURL + '/chat/completions',
    localRequest(messages),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: error, message: error } })
  expect(complete).not.toHaveBeenCalled()
})

it.each(['disappeared', 'different-window'])(
  'permits fresh read-only planning when the prior action target is %s',
  async (state) => {
    const complete = vi.fn(async () => '读取新界面')
    const before = denseObservation()
    const after =
      state === 'disappeared'
        ? { ...before, observation_id: 'new', targets: [] }
        : {
            ...before,
            observation_id: 'new',
            window_id: 'another-window',
            targets: [{ id: 200, name: '另一窗口不能错误强制保留的同号标签'.repeat(1000) }],
          }
    const response = await createRkTarsFetch(complete)(
      rkTarsModel.baseURL + '/chat/completions',
      localRequest([
        { role: 'user', content: '关闭窗口后观察新界面' },
        {
          role: 'assistant',
          content: '<tool_call>{"name":"coloop_observe","parameters":{}}</tool_call>',
        },
        { role: 'user', content: 'Tool: coloop_observe\nResult:\n' + JSON.stringify(before) },
        {
          role: 'assistant',
          content:
            '<tool_call>{"name":"coloop_execute","parameters":{"observation_id":"dense-observation","action":{"action":"click","target_id":200}}}</tool_call>',
        },
        {
          role: 'user',
          content:
            'Tool: coloop_execute\nResult:\n' +
            JSON.stringify({ receipt: { outcome: 'input_sent' }, observation: after }),
        },
      ]),
    )
    expect(response.status).toBe(200)
    expect(complete).toHaveBeenCalledOnce()
  },
)

it('counts the final successful-verification system addition before admitting any RK request', async () => {
  const complete = vi.fn(async () => '不得执行')
  const history = [
    { role: 'user', content: '原目标' },
    {
      role: 'assistant',
      content: '<tool_call>{"name":"coloop_verify","parameters":{}}</tool_call>',
    },
    {
      role: 'user',
      content:
        'Tool: coloop_verify\nResult:\n{"verified":true,"completion_verification_required":false}',
    },
  ]
  const system = 'a'.repeat(
    16384 - 1152 - Buffer.byteLength(history.map((message) => message.content).join('\n')),
  )
  const response = await createRkTarsFetch(complete)(
    rkTarsModel.baseURL + '/chat/completions',
    localRequest([{ role: 'system', content: system }, ...history]),
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { message: 'RK_CONTEXT_BUDGET_EXCEEDED' } })
  expect(complete).not.toHaveBeenCalled()
})

it('matches the board UTF-8 boundary exactly without charging JSON role envelopes', async () => {
  const complete = vi.fn(async () => '完成')
  const fetch = createRkTarsFetch(complete)
  const user = '中文目标"\n'
  const system = 'x'.repeat(16384 - 1152 - Buffer.byteLength(user))
  const accepted = await fetch(
    rkTarsModel.baseURL + '/chat/completions',
    localRequest([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]),
  )
  expect(accepted.status).toBe(200)
  const rejected = await fetch(
    rkTarsModel.baseURL + '/chat/completions',
    localRequest([
      { role: 'system', content: system + 'x' },
      { role: 'user', content: user },
    ]),
  )
  expect(rejected.status).toBe(400)
  expect(complete).toHaveBeenCalledOnce()
})
