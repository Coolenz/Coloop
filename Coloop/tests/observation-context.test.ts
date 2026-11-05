import { expect, it } from 'vitest'
import { projectObservationContext } from '../src/main/infrastructure/observation-context'

const observation = (count = 200) => ({
  observation_id: 'obs-current',
  window_id: '42',
  process_name: 'ActionTaskLab',
  editable_focus: false,
  ocr_text: '页面设置\n启用功能\n保存',
  ocr_items: [{ id: 0, text: '启用功能', rect: [0, 0, 50, 30], confidence: 0.99 }],
  targets: Array.from({ length: count }, (_, index) => ({
    id: 2000000 + index,
    name: `列表项目 ${String(index + 1).padStart(3, '0')} 设置`,
    text: `列表项目 ${String(index + 1).padStart(3, '0')} 设置`,
    type: 'Button',
    source: 'cua',
    pointer_only: true,
    checked: false,
    selected: false,
    rect: [0, index, 50, index + 1],
    center: [25, index + 0.5],
  })),
  cua: {
    status: 'ready',
    elements: count,
    truncated: count === 200,
    text: 'large duplicated labels',
    error: 'private details',
  },
})

it('fits 200 Cua targets into remaining UTF-8 bytes and accounts for every omitted item', () => {
  const source = observation()
  const before = structuredClone(source)
  const result = projectObservationContext(source, { budgetBytes: 3366 })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.bytes).toBe(Buffer.byteLength(result.json, 'utf8'))
  expect(result.bytes).toBeLessThanOrEqual(3366)
  expect(JSON.parse(result.json)).toEqual(result.value)
  expect(result.value.omitted_count).toBe(
    201 - result.value.targets.length - result.value.ocr_items.length,
  )
  expect(result.value.omitted_count).toBeGreaterThan(0)
  expect(result.value.truncated).toBe(true)
  expect(source).toEqual(before)
})

it('finds a previously omitted last target by query on the same full observation', () => {
  const source = observation()
  const first = projectObservationContext(source, { budgetBytes: 1500 })
  const found = projectObservationContext(source, { budgetBytes: 1500, query: '２００' })
  expect(first.ok && first.value.targets.some((target) => target.id === 2000199)).toBe(false)
  expect(found.ok).toBe(true)
  if (!found.ok) throw new Error(found.code)
  expect(found.value.observation_id).toBe(source.observation_id)
  expect(found.value.targets.map((target) => target.id)).toEqual([2000199])
  expect(found.value.matched_count).toBe(1)
  expect(found.value.omitted_matching_count).toBe(0)
  expect(found.value.omitted_count).toBe(200)
  expect(found.value).not.toHaveProperty('next_cursor')
})

it('retains focus and last-action targets even when a query excludes them', () => {
  const source = {
    ...observation(),
    editable_focus: true,
    editable_runtime_id: [42, 7],
    targets: [
      ...observation().targets,
      {
        id: 1000000,
        name: '正文',
        type: 'Edit',
        runtime_id: [42, 7],
        pointer_only: false,
        enabled: true,
        read_only: false,
      },
    ],
    reconciliation_required: true,
  }
  const result = projectObservationContext(source, {
    budgetBytes: 1300,
    query: 'missing',
    requiredTargetIds: [2000199],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.value.targets.map((target) => target.id)).toEqual([2000199, 1000000])
  expect(result.value.focused_target_id).toBe(1000000)
  expect(result.value.editor_input_hint).toContain('当前编辑器已聚焦')
  expect(result.value.editor_input_hint).toContain('coloop_patch_text')
  expect(result.value.targets[0]).toMatchObject({
    pointer_only: true,
    checked: false,
    selected: false,
  })
  expect(result.value.targets[1]).toMatchObject({
    pointer_only: false,
    enabled: true,
    read_only: false,
  })
  expect(result.value.completion_verification_required).toBe(true)
  expect(result.value.reconciliation_required).toBe(true)
  expect(result.value.matched_count).toBe(0)
})

it('keeps brief Cua status and strips raw bindings, values, diagnostics, and duplicate labels', () => {
  const source = observation(1)
  Object.assign(source.targets[0], {
    runtime_id: [42, 9],
    value: 'secret',
    element_token: 'local-token',
  })
  const result = projectObservationContext(source, { budgetBytes: 4000 })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.value.cua).toEqual({ status: 'ready', elements: 1, truncated: false })
  for (const key of ['text', 'runtime_id', 'rect', 'center', 'value', 'element_token'])
    expect(result.value.targets[0]).not.toHaveProperty(key)
  expect(result.value.ocr_items[0]).not.toHaveProperty('confidence')
  expect(result.value.targets[0].name).toBe(source.targets[0].name)
  expect(result.value.omitted_count).toBe(0)
  expect(result.value.truncated).toBe(false)
  const unavailable = projectObservationContext(
    { ...source, cua: { status: 'unavailable', error: 'host details' } },
    { budgetBytes: 4000 },
  )
  expect(unavailable.ok && unavailable.value.cua).toEqual({ status: 'unavailable' })
})

it('preserves escaped Chinese and emoji as valid JSON and explicitly marks text shortening', () => {
  const source = { ...observation(0), ocr_items: [], ocr_text: '中文😀"\\\n'.repeat(200) }
  const result = projectObservationContext(source, { budgetBytes: 650 })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.bytes).toBeLessThanOrEqual(650)
  expect(result.value.ocr_text_truncated).toBe(true)
  expect(result.value.truncated).toBe(true)
  expect(source.ocr_text.startsWith(result.value.ocr_text)).toBe(true)
  expect(Buffer.from(result.value.ocr_text).toString()).toBe(result.value.ocr_text)
  expect(JSON.parse(result.json)).toEqual(result.value)
})

it('fails explicitly when metadata or required target semantics cannot fit', () => {
  const source = observation(1)
  expect(projectObservationContext(source, { budgetBytes: 1 })).toMatchObject({
    ok: false,
    code: 'OBSERVATION_CONTEXT_BUDGET',
    budgetBytes: 1,
  })
  source.targets[0].name = '必须完整匹配的目标'.repeat(100)
  const result = projectObservationContext(source, {
    budgetBytes: 1000,
    requiredTargetIds: [2000000],
  })
  expect(result).toMatchObject({ ok: false, code: 'OBSERVATION_CONTEXT_BUDGET' })
  if (result.ok || result.code !== 'OBSERVATION_CONTEXT_BUDGET')
    throw new Error('Expected budget failure')
  expect(result.requiredBytes).toBeGreaterThan(1000)
  expect(result).not.toHaveProperty('json')
})

it('exposes query matches omitted by budget instead of reporting no matches', () => {
  const source = observation(1)
  source.targets[0].name = 'LongLabel'.repeat(500)
  const result = projectObservationContext(source, { budgetBytes: 600, query: 'longlabel' })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.value.targets).toEqual([])
  expect(result.value.matched_count).toBe(1)
  expect(result.value.omitted_matching_count).toBe(1)
})

it('rejects ambiguous IDs, invalid safety flags, and missing required targets', () => {
  const source = observation(1)
  expect(
    projectObservationContext(
      { ...source, ocr_items: [{ id: 2000000, text: 'duplicate' }] },
      { budgetBytes: 4000 },
    ),
  ).toMatchObject({ ok: false, code: 'OBSERVATION_CONTEXT_INVALID' })
  expect(
    projectObservationContext(
      { ...source, targets: [{ id: 1, pointer_only: 'true' }] },
      { budgetBytes: 4000 },
    ),
  ).toMatchObject({ ok: false, code: 'OBSERVATION_CONTEXT_INVALID' })
  expect(
    projectObservationContext(source, { budgetBytes: 4000, requiredTargetIds: [999] }),
  ).toEqual({ ok: false, code: 'OBSERVATION_CONTEXT_TARGET_MISSING', targetIds: [999] })
})

it('accumulates omissions and preserves query totals through a second budget projection', () => {
  const source = observation()
  const first = projectObservationContext(source, { budgetBytes: 3000, query: '设置' })
  if (!first.ok) throw new Error(first.code)
  expect(first.value.omitted_matching_count).toBeGreaterThan(0)
  const second = projectObservationContext({ ...first.value }, { budgetBytes: 1500 })
  if (!second.ok) throw new Error(second.code)
  expect(second.bytes).toBeLessThanOrEqual(1500)
  expect(second.value.query).toBe('设置')
  expect(second.value.matched_count).toBe(200)
  expect(second.value.omitted_matching_count).toBe(200 - second.value.targets.length)
  expect(second.value.omitted_count).toBe(201 - second.value.targets.length)
  expect(second.value.omitted_count).toBeGreaterThan(first.value.omitted_count)
  expect(second.value.truncated).toBe(true)
  expect(second.value.ocr_text_truncated).toBe(true)
})

it('does not turn a previously shortened text or source truncation into a complete view', () => {
  const source = { ...observation(0), ocr_items: [], ocr_text: '正文'.repeat(2000) }
  const first = projectObservationContext(source, { budgetBytes: 600 })
  if (!first.ok) throw new Error(first.code)
  const second = projectObservationContext({ ...first.value }, { budgetBytes: 3000 })
  if (!second.ok) throw new Error(second.code)
  expect(second.value.ocr_text).toBe(first.value.ocr_text)
  expect(second.value.ocr_text_truncated).toBe(true)
  expect(second.value.truncated).toBe(true)
  const externalTruncation = projectObservationContext(
    { ...observation(0), truncated: true },
    { budgetBytes: 3000 },
  )
  expect(externalTruncation.ok && externalTruncation.value.truncated).toBe(true)
})

it('requires the full host snapshot when changing query after a partial projection', () => {
  const first = projectObservationContext(observation(), { budgetBytes: 1500, query: '001' })
  if (!first.ok) throw new Error(first.code)
  expect(
    projectObservationContext({ ...first.value }, { budgetBytes: 1500, query: '200' }),
  ).toMatchObject({
    ok: false,
    code: 'OBSERVATION_CONTEXT_INVALID',
    reason: 'query changes require the full host observation',
  })
})
