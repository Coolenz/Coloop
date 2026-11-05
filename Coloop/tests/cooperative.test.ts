import { describe, expect, it, vi } from 'vitest'
import { CooperativeAgent, localAgentPolicies } from '../src/main/services/cooperative'
import { CloudGateway, type CloudAnalysis } from '../src/main/infrastructure/cloud'
import { cloudProjectionQuestion } from '../src/main/domain/cloud-spans'

const config = {
  protocol: 'openai' as const,
  name: 'test',
  baseUrl: 'http://127.0.0.1:12345/v1',
  model: 'test',
}
const analysis: CloudAnalysis = {
  summary: '先比较约束再验证方案。',
  steps: ['确认结果'],
  uncertainties: [],
}
const finalWire = (entity_ids: string[], answer: string) => JSON.stringify({ entity_ids, answer })
function setup(overrides: Partial<Record<keyof typeof localAgentPolicies, string>> = {}) {
  const calls: string[] = []
  const privacyAgent = vi.fn(async (system: string, input: string) => {
    const policy = (Object.keys(localAgentPolicies) as (keyof typeof localAgentPolicies)[]).find(
      (key) => localAgentPolicies[key] === system,
    )!
    const stage = policy === 'finalWithoutEntities' || policy === 'finalRetry' ? 'final' : policy
    calls.push(stage)
    return (
      overrides[stage] ??
      {
        route: '{"route":"cloud"}',
        identify: '[]',
        sanitize:
          stage === 'sanitize' ? JSON.stringify([{ id: JSON.parse(input).spans[0].id }]) : '[]',
        verify: '{"safe":true}',
        final:
          policy === 'final' || policy === 'finalRetry'
            ? finalWire([], '综合本地信息，建议先做最小验证。')
            : '综合本地信息，建议先做最小验证。',
      }[stage]
    )
  })
  const analyze = vi.fn(
    async (
      _config: typeof config,
      _key: string,
      _projection: { question: string; facts: string[] },
      _signal: AbortSignal,
    ) => {
      calls.push('cloud')
      return analysis
    },
  )
  const getKey = vi.fn(() => 'test-key')
  const stages = vi.fn()
  const controller = new AbortController()
  return {
    agent: new CooperativeAgent({ privacyAgent }, { analyze }),
    privacyAgent,
    analyze,
    getKey,
    stages,
    controller,
    calls,
  }
}
function run(
  fixture: ReturnType<typeof setup>,
  prompt = '比较方案并给出多步分析',
  context = '',
  options: { route?: 'cloud'; answerMode?: 'direct' | 'local' } = {},
) {
  return fixture.agent.run(
    prompt,
    context,
    config,
    fixture.getKey,
    fixture.controller.signal,
    fixture.stages,
    options,
  )
}

describe('local first cooperative pipeline', () => {
  it('directly presents all cloud answer fields with three local calls for one source span', async () => {
    const f = setup()
    f.analyze.mockImplementation(async () => {
      f.calls.push('cloud')
      return { ...analysis, uncertainties: ['尚未提供实际测试结果'] }
    })
    await expect(run(f, undefined, '', { answerMode: 'direct' })).resolves.toEqual({
      answer:
        '先比较约束再验证方案。\n\n建议步骤：\n1. 确认结果\n\n不确定性：\n- 尚未提供实际测试结果',
      cloudUsed: true,
    })
    expect(f.calls).toEqual(['route', 'identify', 'verify', 'cloud'])
    expect(f.privacyAgent).toHaveBeenCalledTimes(3)
    expect(f.stages.mock.calls.flat().join(' ')).not.toContain(analysis.summary)
  })

  it('uses two local checks for a trusted cloud route and still selects multiple source spans', async () => {
    const single = setup()
    await run(single, undefined, '', { route: 'cloud', answerMode: 'direct' })
    expect(single.calls).toEqual(['identify', 'verify', 'cloud'])
    const multiple = setup()
    await run(multiple, '比较方案。另一个条件。', '', { answerMode: 'direct' })
    expect(multiple.calls).toEqual(['route', 'identify', 'sanitize', 'verify', 'cloud'])
    expect(multiple.analyze.mock.calls[0][2].facts).toEqual(['比较方案。'])
  })

  it.each(['{"safe":false}', '{"safe":true,"extra":true}', 'null'])(
    'still blocks one-span egress when verification is rejected: %s',
    async (verify) => {
      const f = setup({ verify })
      await expect(run(f, undefined, '', { answerMode: 'direct' })).rejects.toThrow(
        '本地隐私检查未通过',
      )
      expect(f.calls).toEqual(['route', 'identify', 'verify'])
      expect(f.analyze).not.toHaveBeenCalled()
      expect(f.getKey).not.toHaveBeenCalled()
    },
  )

  it('rejects an oversized sole source span without invoking the selector or cloud', async () => {
    const f = setup()
    await expect(run(f, '字'.repeat(1100), '', { answerMode: 'direct' })).rejects.toThrow(
      '本地隐私检查未通过',
    )
    expect(f.calls).toEqual(['route', 'identify'])
    expect(f.getKey).not.toHaveBeenCalled()
    expect(f.analyze).not.toHaveBeenCalled()
  })

  it('restores only exposed cloud references in direct text, including quotes and newlines', async () => {
    const f = setup()
    const entity = '客户"甲\n乙'
    f.analyze.mockImplementation(async (_config, _key, projection) => ({
      summary: projection.facts[0],
      steps: [],
      uncertainties: [],
    }))
    await expect(
      run(f, `分析<private>${entity}</private>`, '', { answerMode: 'direct' }),
    ).resolves.toEqual({
      answer: `分析${entity}`,
      cloudUsed: true,
    })
    expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('客户')
    expect(f.privacyAgent).toHaveBeenCalledTimes(3)
    expect(f.calls).not.toContain('final')
  })

  it('rejects direct cloud guesses of local entities excluded by source selection', async () => {
    const f = setup()
    f.analyze.mockImplementation(async (_config, _key, projection) => ({
      ...analysis,
      summary: projection.facts[0].replace(/_1\]/, '_2]'),
    }))
    await expect(
      run(f, '<private>出境实体甲</private>。<private>仅本地实体乙</private>。', '', {
        answerMode: 'direct',
      }),
    ).rejects.toThrow('云端分析未通过校验')
    expect(f.calls).not.toContain('final')
  })

  it.each([
    'ultraSensitive123/+',
    encodeURIComponent('ultraSensitive123/+'),
    Buffer.from('ultraSensitive123/+').toString('base64'),
    '[LOCAL_wrong_1]',
    '[E1]',
  ])('blocks unsafe direct output without a local regeneration: %s', async (summary) => {
    const f = setup()
    f.analyze.mockResolvedValue({ ...analysis, summary })
    await expect(
      run(f, '比较方案。password=ultraSensitive123/+', '', {
        answerMode: 'direct',
      }),
    ).rejects.toThrow('云端分析未通过校验')
    expect(f.calls).not.toContain('final')
  })

  it.each(['identify', 'verify', 'cloud', 'display'])(
    'never publishes direct output after cancellation during %s',
    async (cancelStage) => {
      const f = setup()
      const original = f.privacyAgent.getMockImplementation()!
      f.privacyAgent.mockImplementation(async (system, input) => {
        const answer = await original(system, input)
        if (system === localAgentPolicies[cancelStage as keyof typeof localAgentPolicies])
          f.controller.abort()
        return answer
      })
      f.analyze.mockImplementation(async () => {
        if (cancelStage === 'cloud') f.controller.abort()
        return analysis
      })
      f.stages.mockImplementation((stage) => {
        if (cancelStage === 'display' && stage === '正在呈现分析结果') f.controller.abort()
      })
      await expect(run(f, undefined, '', { answerMode: 'direct' })).rejects.toMatchObject({
        name: 'AbortError',
      })
      expect(f.calls).not.toContain('final')
    },
  )

  it('keeps local-only answering and default structured output independent of direct mode', async () => {
    const local = setup({ route: '{"route":"local"}', final: '5' })
    await expect(run(local, '2+3=?', '', { answerMode: 'direct' })).resolves.toEqual({
      answer: '5',
      cloudUsed: false,
    })
    expect(local.calls).toEqual(['route', 'final'])
    const plan = '{"observation_id":"o1","actions":[{"action":"finish"}]}'
    const desktop = setup({ final: plan })
    await expect(run(desktop)).resolves.toEqual({ answer: plan, cloudUsed: true })
    expect(desktop.calls.at(-1)).toBe('final')
  })

  it('a trusted cloud routing result still runs all privacy checks before using the network', async () => {
    const f = setup()
    const result = await f.agent.run(
      '比较两种方案',
      '',
      config,
      f.getKey,
      f.controller.signal,
      f.stages,
      { route: 'cloud' },
    )
    expect(result.cloudUsed).toBe(true)
    expect(f.calls).toEqual(['identify', 'verify', 'cloud', 'final'])
  })
  it('supports a fixed desktop routing policy without changing other local-first agents', async () => {
    const f = setup({ route: '{"route":"local"}', final: '5' })
    const policy = 'Fixed desktop routing policy'
    const original = f.privacyAgent.getMockImplementation()!
    f.privacyAgent.mockImplementation(async (system, input) =>
      original(system === policy ? localAgentPolicies.route : system, input),
    )
    const agent = new CooperativeAgent(
      { privacyAgent: f.privacyAgent },
      { analyze: f.analyze },
      { routePolicy: policy },
    )
    const result = await agent.run(
      'Fill the code',
      '',
      config,
      f.getKey,
      f.controller.signal,
      f.stages,
    )
    expect(result.cloudUsed).toBe(false)
    expect(f.privacyAgent.mock.calls[0][0]).toBe(policy)
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it('answers simple questions locally without even decrypting the cloud key', async () => {
    const f = setup({ route: '{"route":"local"}', final: '5' })
    expect(await run(f, '2+3=?')).toEqual({ answer: '5', cloudUsed: false })
    expect(f.calls).toEqual(['route', 'final'])
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.getKey).not.toHaveBeenCalled()
  })
  it('only publishes the final local answer after serial routing and two egress checks', async () => {
    const f = setup()
    expect(await run(f)).toEqual({
      answer: '综合本地信息，建议先做最小验证。',
      cloudUsed: true,
    })
    expect(f.calls).toEqual(['route', 'identify', 'verify', 'cloud', 'final'])
    expect(f.stages.mock.calls.flat().join(' ')).not.toContain(analysis.summary)
    expect(Object.isFrozen(f.analyze.mock.calls[0][2])).toBe(true)
    expect(f.analyze.mock.calls[0][2].question).toBe(cloudProjectionQuestion)
    expect(f.analyze.mock.calls[0][2].facts).toEqual(['比较方案并给出多步分析'])
  })
  it('sends exact selected A/B conditions while excluding identity, nonce, key and local formatting', async () => {
    const f = setup()
    const rawSecret = 'synthetic-token-7c12fa'
    const rawEntity = '客户随机标识A97F'
    const rawContext = '只存在本次原文中的长背景-canary-2910'
    const rawNonce = 'local-only-nonce-F71C'
    const conditionA = '方案A：先完成输入校验，再并行解析；内存上限256MB。'
    const conditionB = '方案B：串行解析；内存上限128MB；不得使用缓存。'
    f.privacyAgent.mockImplementation(async (system: string, input: string) => {
      if (system === localAgentPolicies.route) return '{"route":"cloud"}'
      if (system === localAgentPolicies.identify) return '[]'
      if (system === localAgentPolicies.sanitize) {
        const spans = JSON.parse(input).spans as { id: string; text: string }[]
        const selected = spans.filter(
          (span) => span.text.includes('方案A：') || span.text.includes('方案B：'),
        )
        expect(selected.map((span) => span.text)).toEqual([conditionA, conditionB])
        return JSON.stringify(selected.map((span) => ({ id: span.id })).reverse())
      }
      if (system === localAgentPolicies.verify) return '{"safe":true}'
      const data = JSON.parse(input)
      expect(Object.values(data.local_entities)).toContain(rawEntity)
      expect(data.local_request.prompt).not.toContain(rawEntity)
      expect(data.local_request.prompt).not.toContain(rawSecret)
      expect(data.local_request.context).toContain(rawContext)
      expect(Object.values(data.local_entities)).toContain(rawNonce)
      expect(Object.keys(data.local_entities)).toEqual(['E1', 'E2'])
      expect(data.local_request.prompt).toContain('[E1]')
      return finalWire([Object.keys(data.local_entities)[0]], '建议按步骤验证。')
    })
    const fetcher = vi.fn(async (_url, options) => {
      const wire = JSON.stringify(options)
      for (const forbidden of [
        rawSecret,
        rawEntity,
        rawNonce,
        rawContext,
        'private_values',
        'local_request',
        'local_entities',
        '首句',
      ])
        expect(wire).not.toContain(forbidden)
      const content = JSON.parse(JSON.parse(options!.body as string).messages[1].content)
      expect(content.facts).toEqual([conditionA, conditionB])
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }],
        }),
      )
    }) as unknown as typeof fetch
    const agent = new CooperativeAgent({ privacyAgent: f.privacyAgent }, new CloudGateway(fetcher))
    expect(
      await agent.run(
        `为<private>${rawEntity}</private>比较方案。首句保留原始代号。`,
        `${conditionA}\n${conditionB}\n<private>${rawNonce}</private>。\npassword=${rawSecret}\n${rawContext}`,
        config,
        f.getKey,
        f.controller.signal,
        f.stages,
      ),
    ).toEqual({ answer: `${rawEntity}：建议按步骤验证。`, cloudUsed: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['route', '{"route":"cloud","route":"local"}'],
    ['route', '{"route":"unknown"}'],
    ['route', '{"route":"blocked"}'],
    ['identify', 'null'],
    ['identify', '{"private_values":[]}'],
    ['identify', '["not in source"]'],
    ['identify', '[1]'],
    ['identify', '[""]'],
    ['identify', '["比较",]'],
    ['identify', JSON.stringify(Array(33).fill('比较'))],
    ['identify', JSON.stringify(['x'.repeat(2001)])],
    ['sanitize', 'not JSON'],
    ['sanitize', 'null'],
    ['sanitize', '[1]'],
    ['sanitize', '[{"id":"S999999"}]'],
    ['sanitize', '[{"id":1}]'],
    ['sanitize', '[]'],
    ['verify', '{"safe":false}'],
    ['verify', '{"safe":true,"safe":false}'],
  ] as const)('stops before cloud for invalid or unsafe %s', async (stage, value) => {
    const f = setup({ [stage]: value })
    await expect(run(f, '比较方案。另一个条件。')).rejects.toThrow('本地隐私检查未通过')
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.getKey).not.toHaveBeenCalled()
  })
  it('rejects duplicate current-registry span IDs without contacting the cloud', async () => {
    const f = setup()
    const original = f.privacyAgent.getMockImplementation()!
    f.privacyAgent.mockImplementation(async (system, input) => {
      const result = await original(system, input)
      if (system === localAgentPolicies.sanitize) {
        const id = JSON.parse(input).spans[0].id
        return JSON.stringify([{ id }, { id }])
      }
      return result
    })
    await expect(run(f, '比较方案。另一个条件。')).rejects.toThrow('本地隐私检查未通过')
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.getKey).not.toHaveBeenCalled()
  })
  it.each(['legacy-string-list', 'object-with-text'] as const)(
    'rejects out-of-contract selector output for a real registry ID: %s',
    async (shape) => {
      const f = setup()
      const original = f.privacyAgent.getMockImplementation()!
      f.privacyAgent.mockImplementation(async (system, input) => {
        const result = await original(system, input)
        if (system === localAgentPolicies.sanitize) {
          const span = JSON.parse(input).spans[0]
          return shape === 'legacy-string-list'
            ? JSON.stringify([span.id])
            : JSON.stringify([{ id: span.id, text: span.text }])
        }
        return result
      })
      await expect(run(f, '比较方案。另一个条件。')).rejects.toThrow('本地隐私检查未通过')
      expect(f.analyze).not.toHaveBeenCalled()
      expect(f.getKey).not.toHaveBeenCalled()
    },
  )
  it('masks grounded private values before selecting unchanged source spans', async () => {
    const f = setup()
    f.privacyAgent.mockImplementation(async (system, input) => {
      if (system === localAgentPolicies.route) return '{"route":"cloud"}'
      if (system === localAgentPolicies.identify) {
        expect(JSON.parse(input)).toEqual({
          prompt: '给客户阿尔法比较方案',
          context: '项目蓝海需多步验证',
        })
        return '["客户阿尔法","项目蓝海"]'
      }
      if (system === localAgentPolicies.sanitize) {
        expect(input).not.toContain('客户阿尔法')
        expect(input).not.toContain('项目蓝海')
        expect(input).toContain('[LOCAL_')
        return JSON.stringify(
          JSON.parse(input).spans.map((span: { id: string }) => ({ id: span.id })),
        )
      }
      if (system === localAgentPolicies.verify) {
        expect(input).not.toContain('客户阿尔法')
        expect(input).not.toContain('项目蓝海')
        return '{"safe":true}'
      }
      const entities = JSON.parse(input).local_entities
      expect(Object.values(entities)).toEqual(['客户阿尔法', '项目蓝海'])
      return finalWire(['E1', 'E2'], '需先做验证')
    })
    await expect(run(f, '给客户阿尔法比较方案', '项目蓝海需多步验证')).resolves.toEqual({
      answer: '客户阿尔法、项目蓝海：需先做验证',
      cloudUsed: true,
    })
    expect(f.analyze.mock.calls[0][2].question).toBe(cloudProjectionQuestion)
    const facts = f.analyze.mock.calls[0][2].facts
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatch(/^给\[LOCAL_[a-f0-9]{24}_\d+\]比较方案$/)
    expect(facts[1]).toMatch(/^\[LOCAL_[a-f0-9]{24}_\d+\]需多步验证$/)
  })
  it('checks the identified item length even when the value is present in the source', async () => {
    const value = '界'.repeat(2001)
    const f = setup({ identify: JSON.stringify([value]) })
    await expect(run(f, `分析${value}`)).rejects.toThrow('本地隐私检查未通过')
    expect(f.calls).toEqual(['route', 'identify'])
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it('does not forward unvalidated cloud output to RK', async () => {
    const f = setup()
    f.analyze.mockResolvedValue({ ...analysis, summary: '[LOCAL_wrong_1]' })
    await expect(run(f)).rejects.toThrow('云端分析未通过校验')
    expect(f.calls).not.toContain('final')
  })
  it('rejects cloud guesses of local mappings that were never sent out', async () => {
    const f = setup()
    f.privacyAgent.mockImplementation(async (system, input) => {
      if (system === localAgentPolicies.route) return '{"route":"cloud"}'
      if (system === localAgentPolicies.identify) return '[]'
      if (system === localAgentPolicies.sanitize) {
        return JSON.stringify([{ id: JSON.parse(input).spans[0].id }])
      }
      if (system === localAgentPolicies.verify) return '{"safe":true}'
      throw new Error('Final stage must not be reached')
    })
    f.analyze.mockImplementation(async (_config, _key, projection) => ({
      ...analysis,
      summary: projection.facts[0].replace(/_1\]/, '_2]'),
    }))
    await expect(
      run(f, '<private>出境实体甲</private>。<private>仅本地实体乙</private>。'),
    ).rejects.toThrow('云端分析未通过校验')
    expect(f.privacyAgent).toHaveBeenCalledTimes(4)
  })
  it.each(['[E1]', '[E77]', '［E2］'])(
    'rejects local-only aliases in cloud output: %s',
    async (summary) => {
      const f = setup()
      f.analyze.mockResolvedValue({ ...analysis, summary })
      await expect(run(f)).rejects.toThrow('云端分析未通过校验')
      expect(f.calls).not.toContain('final')
    },
  )
  it.each(['[E2]', '[E1', '[ E1 ]', '［E1］', '[E 1]'])(
    'rejects unknown or malformed short final references: %s',
    async (answer) => {
      const f = setup({ route: '{"route":"local"}', final: finalWire(['E1'], answer) })
      await expect(run(f, '<private>本地项目甲</private>，请给建议')).rejects.toThrow(
        'RK 本地答案生成失败',
      )
    },
  )
  it.each(['[E1]', '［E1］', '[E 1]'])(
    'rejects preexisting local aliases before any model call: %s',
    async (text) => {
      const f = setup()
      await expect(run(f, text)).rejects.toThrow('本地隐私检查未通过')
      expect(f.privacyAgent).not.toHaveBeenCalled()
      expect(f.analyze).not.toHaveBeenCalled()
    },
  )
  it('fails without falling back to the original prompt or exposing model errors', async () => {
    const f = setup()
    f.privacyAgent.mockRejectedValue(new Error('private-provider-body'))
    await expect(run(f, '比较方案。另一个条件。')).rejects.toThrow('本地隐私检查未通过')
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it.each(['route', 'identify', 'sanitize', 'verify', 'cloud', 'final'])(
    'cancellation during %s prevents all later calls and late answers',
    async (cancelStage) => {
      const f = setup()
      const original = f.privacyAgent.getMockImplementation()!
      f.privacyAgent.mockImplementation(async (system, input) => {
        const answer = await original(system, input)
        if (
          localAgentPolicies[cancelStage as keyof typeof localAgentPolicies] === system ||
          (cancelStage === 'final' && localAgentPolicies.finalWithoutEntities === system)
        )
          f.controller.abort()
        return answer
      })
      f.analyze.mockImplementation(async () => {
        f.calls.push('cloud')
        if (cancelStage === 'cloud') f.controller.abort()
        return analysis
      })
      await expect(run(f, '比较方案。另一个条件。')).rejects.toMatchObject({ name: 'AbortError' })
      expect(f.calls.at(-1)).toBe(cancelStage)
    },
  )
  it('handles quotes and newlines in local private values without parsing a restored JSON string', async () => {
    const f = setup()
    const entity = '客户"引号\n换行'
    f.privacyAgent.mockImplementation(async (system, input) => {
      if (system === localAgentPolicies.route) return '{"route":"cloud"}'
      if (system === localAgentPolicies.identify) return '[]'
      if (system === localAgentPolicies.sanitize) {
        return JSON.stringify([{ id: JSON.parse(input).spans[0].id }])
      }
      if (system === localAgentPolicies.verify) return '{"safe":true}'
      expect(Object.values(JSON.parse(input).local_entities)).toContain(entity)
      return finalWire(['E1'], '完成分析')
    })
    await expect(run(f, `分析<private>${entity}</private>`)).resolves.toEqual({
      answer: `${entity}：完成分析`,
      cloudUsed: true,
    })
  })
  it.each(['local', 'cloud'] as const)(
    'renders the declared authorized identity only locally after the %s route',
    async (route) => {
      const f = setup({ route: JSON.stringify({ route }), final: finalWire(['E1'], '建议验证') })
      await expect(run(f, '<private>CLIENT-A97F</private>，请给建议')).resolves.toEqual({
        answer: 'CLIENT-A97F：建议验证',
        cloudUsed: route === 'cloud',
      })
      expect(f.analyze).toHaveBeenCalledTimes(route === 'cloud' ? 1 : 0)
      if (route === 'cloud') {
        expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('CLIENT-A97F')
        expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('local_entities')
        expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('CLIENT-A97F：建议验证')
        expect(f.calls.at(-1)).toBe('final')
      }
    },
  )
  it('renders an existing declared entity identifier to the exact source identity', async () => {
    const valid = setup({ route: '{"route":"local"}' })
    valid.privacyAgent.mockImplementation(async (system, input) => {
      if (system === localAgentPolicies.route) return '{"route":"local"}'
      const first = Object.keys(JSON.parse(input).local_entities)[0]
      expect(first).toBe('E1')
      return finalWire([first], '建议验证')
    })
    await expect(run(valid, '<private>CLIENT-A97F</private>，请给建议')).resolves.toEqual({
      answer: 'CLIENT-A97F：建议验证',
      cloudUsed: false,
    })
  })
  it.each([
    'ultraSensitive123/+',
    encodeURIComponent('ultraSensitive123/+'),
    Buffer.from('ultraSensitive123/+').toString('base64'),
  ])('still rejects known credentials in the final answer: %s', async (answer) => {
    const f = setup({ route: '{"route":"local"}', final: answer })
    await expect(run(f, '请分析。password=ultraSensitive123/+')).rejects.toThrow(
      'RK 本地答案生成失败',
    )
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it.each([
    'CLIENT-A97F建议验证',
    '{"entity_ids":["E1"],"answer":"建议验证","extra":true}',
    '{"entity_ids":["E1"],"answer":"first","answer":"second"}',
    finalWire(['E2'], '建议验证'),
    finalWire(['E1', 'E1'], '建议验证'),
    'null',
    finalWire(['E1'], '[REMOVED_SECRET]'),
    finalWire(['E1'], '［REMOVED_SECRET］'),
    finalWire([], '   '),
    '{"entity_ids":["E1"]}',
  ])('rejects invalid entity presentation wire output: %s', async (answer) => {
    const f = setup({ route: '{"route":"local"}', final: answer })
    await expect(run(f, '<private>CLIENT-A97F</private>，请给建议')).rejects.toThrow(
      'RK 本地答案生成失败',
    )
  })
  it('allows an authorized source identity in the local body without sending the rendered answer out', async () => {
    const f = setup({ final: finalWire(['E1'], 'CLIENT-A97F建议验证') })
    await expect(run(f, '<private>CLIENT-A97F</private>，请给建议')).resolves.toEqual({
      answer: 'CLIENT-A97F：CLIENT-A97F建议验证',
      cloudUsed: true,
    })
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('CLIENT-A97F')
    expect(f.calls.at(-1)).toBe('final')
  })
  it('rejects known credentials inside otherwise valid entity presentation JSON', async () => {
    const f = setup({
      route: '{"route":"local"}',
      final: finalWire(['E1'], 'ultraSensitive123/+'),
    })
    await expect(
      run(f, '<private>CLIENT-A97F</private>，password=ultraSensitive123/+'),
    ).rejects.toThrow('RK 本地答案生成失败')
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it('regenerates an invalid final schema once using the same local input and a real second call', async () => {
    const f = setup()
    const original = f.privacyAgent.getMockImplementation()!
    const finalInputs: string[] = []
    f.privacyAgent.mockImplementation(async (system, input) => {
      const result = await original(system, input)
      if (system === localAgentPolicies.final) {
        finalInputs.push(input)
        return '{"entity_ids":"E1","answer":"REJECTED_WIRE_CANARY"}'
      }
      if (system === localAgentPolicies.finalRetry) {
        finalInputs.push(input)
        return finalWire(['E1'], '重新分析后建议验证')
      }
      return result
    })
    await expect(run(f, '<private>CLIENT-A97F</private>，请给建议')).resolves.toEqual({
      answer: 'CLIENT-A97F：重新分析后建议验证',
      cloudUsed: true,
    })
    expect(finalInputs).toHaveLength(2)
    expect(finalInputs[1]).toBe(finalInputs[0])
    expect(finalInputs[1]).not.toContain('REJECTED_WIRE_CANARY')
    expect(f.calls).toEqual(['route', 'identify', 'verify', 'cloud', 'final', 'final'])
    expect(
      f.privacyAgent.mock.calls.filter(([system]) => system === localAgentPolicies.finalRetry),
    ).toHaveLength(1)
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.analyze.mock.calls[0][2])).not.toContain('CLIENT-A97F')
  })
  it('fails after at most two final generations when both wire outputs remain invalid', async () => {
    const f = setup({ final: 'not JSON' })
    await expect(run(f, '<private>CLIENT-A97F</private>，请给建议')).rejects.toThrow(
      'RK 本地答案生成失败',
    )
    expect(f.calls).toEqual(['route', 'identify', 'verify', 'cloud', 'final', 'final'])
    expect(
      f.privacyAgent.mock.calls.filter(([system]) => system === localAgentPolicies.finalRetry),
    ).toHaveLength(1)
    expect(f.analyze).toHaveBeenCalledTimes(1)
  })
  it.each([
    finalWire(['E2'], '建议验证'),
    finalWire(['E1', 'E1'], '建议验证'),
    finalWire(['E1'], 'ultraSensitive123/+'),
  ])('does not regenerate semantic or credential failures: %s', async (final) => {
    const f = setup({ route: '{"route":"local"}', final })
    await expect(
      run(f, '<private>CLIENT-A97F</private>，password=ultraSensitive123/+'),
    ).rejects.toThrow('RK 本地答案生成失败')
    expect(f.calls).toEqual(['route', 'final'])
    expect(
      f.privacyAgent.mock.calls.some(([system]) => system === localAgentPolicies.finalRetry),
    ).toBe(false)
  })
  it('does not regenerate service or truncated-generation errors', async () => {
    const f = setup({ route: '{"route":"local"}' })
    const original = f.privacyAgent.getMockImplementation()!
    f.privacyAgent.mockImplementation(async (system, input) => {
      const result = await original(system, input)
      if (system === localAgentPolicies.final) throw new Error('端侧回答达到输出上限')
      return result
    })
    await expect(run(f, '<private>CLIENT-A97F</private>')).rejects.toThrow('RK 本地答案生成失败')
    expect(f.calls).toEqual(['route', 'final'])
    expect(
      f.privacyAgent.mock.calls.some(([system]) => system === localAgentPolicies.finalRetry),
    ).toBe(false)
  })
  it('does not retry plain answers without local entities', async () => {
    const f = setup({ route: '{"route":"local"}', final: '5' })
    await expect(run(f, '2+3=?')).resolves.toEqual({ answer: '5', cloudUsed: false })
    expect(f.calls).toEqual(['route', 'final'])
    expect(f.privacyAgent.mock.calls.at(-1)?.[0]).toBe(localAgentPolicies.finalWithoutEntities)
    expect(
      f.privacyAgent.mock.calls.some(([system]) => system === localAgentPolicies.finalRetry),
    ).toBe(false)
  })
  it('does not publish a regenerated answer after cancellation during the second local call', async () => {
    const f = setup()
    const original = f.privacyAgent.getMockImplementation()!
    f.privacyAgent.mockImplementation(async (system, input) => {
      const result = await original(system, input)
      if (system === localAgentPolicies.final) return '{invalid JSON'
      if (system === localAgentPolicies.finalRetry) {
        f.controller.abort()
        return finalWire(['E1'], '取消后的迟答')
      }
      return result
    })
    await expect(run(f, '<private>CLIENT-A97F</private>')).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(f.calls).toEqual(['route', 'identify', 'verify', 'cloud', 'final', 'final'])
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.stages.mock.calls.flat().join(' ')).not.toContain('取消后的迟答')
  })
})
