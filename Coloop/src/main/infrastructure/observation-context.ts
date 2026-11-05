type Row = Record<string, unknown>
type Item = { id: number } & Record<string, string | number | boolean>

export interface ObservationContextOptions {
  /** UTF-8 bytes available for this JSON value, after all other prompt costs. */
  budgetBytes: number
  /** Case-insensitive literal match; defaults to an existing projection's query. */
  query?: string
  /** Current-observation IDs needed for the last action or its verification. */
  requiredTargetIds?: readonly number[]
}

export interface ObservationContextProjection extends Row {
  observation_id: string
  window_id: string | number
  process_name?: string
  editable_focus: boolean
  focused_target_id?: number
  editor_input_hint?: string
  completion_verification_required: true
  reconciliation_required?: boolean
  cua?: { status: 'ready' | 'unavailable'; elements?: number; truncated?: boolean }
  targets: Item[]
  ocr_items: Item[]
  ocr_text: string
  ocr_text_truncated: boolean
  omitted_count: number
  truncated: boolean
  query?: string
  matched_count?: number
  omitted_matching_count?: number
}

export type ObservationContextResult =
  | { ok: true; value: ObservationContextProjection; json: string; bytes: number }
  | {
      ok: false
      code: 'OBSERVATION_CONTEXT_BUDGET'
      budgetBytes: number
      requiredBytes: number
    }
  | { ok: false; code: 'OBSERVATION_CONTEXT_INVALID'; reason: string }
  | { ok: false; code: 'OBSERVATION_CONTEXT_TARGET_MISSING'; targetIds: number[] }

const textFields = ['name', 'text', 'type', 'source'] as const
const stateFields = [
  'checked',
  'selected',
  'pointer_only',
  'enabled',
  'read_only',
  'is_password',
  'protected',
] as const
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const normalize = (value: string) => value.normalize('NFKC').toLowerCase()
const runtimeId = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(Number.isSafeInteger)

/**
 * A model-only projection; never replace the host observation or input bindings.
 * The caller budgets system + history + result envelope + output reserve first.
 * Required targets (including focus) are atomic: labels/states are never sliced.
 * Failure must stop/rebudget locally, not retry the same oversized model request.
 *
 * To discover omitted items, a future read-only tool can accept observation_id +
 * query, validate that ID against the host's current observation, then call this
 * function again on the FULL cached observation. It needs no new screenshot;
 * the service still invalidates completion proof for every observe/query call.
 * No cursor/tool capability is claimed by this API.
 */
export function projectObservationContext(
  source: Readonly<Row>,
  options: ObservationContextOptions,
): ObservationContextResult {
  const invalid = (reason: string): ObservationContextResult => ({
    ok: false,
    code: 'OBSERVATION_CONTEXT_INVALID',
    reason,
  })
  if (!Number.isSafeInteger(options.budgetBytes) || options.budgetBytes < 0)
    return invalid('budgetBytes must be a nonnegative safe integer')
  if (options.query !== undefined && typeof options.query !== 'string')
    return invalid('query must be a string')
  if (
    typeof source.observation_id !== 'string' ||
    !source.observation_id ||
    !(
      (typeof source.window_id === 'string' && source.window_id.length > 0) ||
      (typeof source.window_id === 'number' && Number.isFinite(source.window_id))
    )
  )
    return invalid('observation_id and window_id are required')
  if (source.editable_focus !== undefined && typeof source.editable_focus !== 'boolean')
    return invalid('editable_focus must be boolean')

  for (const key of ['omitted_count', 'matched_count', 'omitted_matching_count'] as const)
    if (source[key] !== undefined && !id(source[key])) return invalid(`${key} must be a count`)
  for (const key of ['ocr_text_truncated', 'truncated'] as const)
    if (source[key] !== undefined && typeof source[key] !== 'boolean')
      return invalid(`${key} must be boolean`)
  if (source.query !== undefined && typeof source.query !== 'string')
    return invalid('existing query must be a string')
  const inheritedQuery =
    typeof source.query === 'string' ? source.query.trim() || undefined : undefined
  const query = options.query === undefined ? inheritedQuery : options.query.trim() || undefined
  const normalizedQuery = query && normalize(query)
  const inheritedOmitted = id(source.omitted_count) ? source.omitted_count : 0
  const inheritedTextTruncated = source.ocr_text_truncated === true
  if (
    (inheritedOmitted > 0 || inheritedTextTruncated) &&
    normalizedQuery !== (inheritedQuery && normalize(inheritedQuery))
  )
    return invalid('query changes require the full host observation')
  const candidates: {
    item: Item
    original: Row
    group: 'targets' | 'ocr_items'
    matches: boolean
  }[] = []
  const ids = new Set<number>()
  for (const group of ['targets', 'ocr_items'] as const) {
    if (source[group] !== undefined && !Array.isArray(source[group]))
      return invalid(`${group} must be an array`)
    for (const raw of (source[group] as unknown[] | undefined) ?? []) {
      const original = row(raw)
      if (!original || !id(original.id) || ids.has(original.id))
        return invalid('observation target IDs must be unique nonnegative safe integers')
      ids.add(original.id)
      const item: Item = { id: original.id }
      for (const key of textFields) {
        if (original[key] !== undefined && typeof original[key] !== 'string')
          return invalid(`${key} must be a string`)
        if (typeof original[key] === 'string') item[key] = original[key]
      }
      for (const key of stateFields) {
        if (original[key] !== undefined && typeof original[key] !== 'boolean')
          return invalid(`${key} must be boolean`)
        if (typeof original[key] === 'boolean') item[key] = original[key]
      }
      if (item.text === item.name) delete item.text
      const matches =
        !normalizedQuery ||
        ['name', 'text', 'type'].some(
          (key) =>
            typeof original[key] === 'string' && normalize(original[key]).includes(normalizedQuery),
        )
      candidates.push({ item, original, group, matches })
    }
  }
  const requiredIds = new Set(options.requiredTargetIds ?? [])
  if ([...requiredIds].some((value) => !id(value))) return invalid('requiredTargetIds must be IDs')
  let focusedTargetId: number | undefined
  if (source.editable_focus === true) {
    focusedTargetId = candidates.find(
      (candidate) =>
        candidate.group === 'targets' &&
        runtimeId(source.editable_runtime_id) &&
        runtimeId(candidate.original.runtime_id) &&
        JSON.stringify(candidate.original.runtime_id) ===
          JSON.stringify(source.editable_runtime_id),
    )?.item.id
    if (focusedTargetId === undefined && id(source.focused_target_id))
      focusedTargetId = source.focused_target_id
    if (focusedTargetId !== undefined) requiredIds.add(focusedTargetId)
  }
  const missing = [...requiredIds].filter((value) => !ids.has(value))
  if (missing.length)
    return { ok: false, code: 'OBSERVATION_CONTEXT_TARGET_MISSING', targetIds: missing }

  const rawCua = row(source.cua)
  const cua: ObservationContextProjection['cua'] =
    rawCua?.status === 'ready' || rawCua?.status === 'unavailable'
      ? {
          status: rawCua.status,
          ...(id(rawCua.elements) ? { elements: rawCua.elements } : {}),
          ...(typeof rawCua.truncated === 'boolean' ? { truncated: rawCua.truncated } : {}),
        }
      : undefined
  const originalText = typeof source.ocr_text === 'string' ? source.ocr_text : ''
  const displayText = normalizedQuery
    ? originalText
        .split(/\r?\n/)
        .filter((line) => normalize(line).includes(normalizedQuery))
        .join('\n')
    : originalText
  const selected = candidates.filter((candidate) => requiredIds.has(candidate.item.id))
  const visibleMatches = candidates.filter((candidate) => candidate.matches).length
  const inheritedMatchingOmitted =
    query && id(source.omitted_matching_count)
      ? source.omitted_matching_count
      : query && id(source.matched_count)
        ? source.matched_count - visibleMatches
        : 0
  if (
    inheritedMatchingOmitted < 0 ||
    inheritedMatchingOmitted > inheritedOmitted ||
    (query &&
      id(source.matched_count) &&
      source.matched_count !== visibleMatches + inheritedMatchingOmitted)
  )
    return invalid('existing query counts are inconsistent')
  const value: ObservationContextProjection = {
    observation_id: source.observation_id,
    window_id: source.window_id,
    ...(typeof source.process_name === 'string' ? { process_name: source.process_name } : {}),
    editable_focus: source.editable_focus === true,
    ...(focusedTargetId !== undefined ? { focused_target_id: focusedTargetId } : {}),
    ...(focusedTargetId !== undefined
      ? {
          editor_input_hint:
            '当前编辑器已聚焦，无需重复click。修改已有正文的下一步是coloop_read_editor，传本observation_id和focused_target_id；读取后才开放coloop_patch_text，原样使用revision，保留其他正文。只有空白正文才直接coloop_execute paste，observe_after:true。',
        }
      : {}),
    completion_verification_required: true,
    ...(source.reconciliation_required === true ? { reconciliation_required: true } : {}),
    ...(cua ? { cua } : {}),
    targets: [],
    ocr_items: [],
    ocr_text: '',
    ocr_text_truncated: inheritedTextTruncated || originalText.length > 0,
    omitted_count: 0,
    truncated: false,
    ...(query ? { query, matched_count: visibleMatches + inheritedMatchingOmitted } : {}),
  }
  const encode = () => {
    value.targets = selected
      .filter((candidate) => candidate.group === 'targets')
      .map((candidate) => candidate.item)
    value.ocr_items = selected
      .filter((candidate) => candidate.group === 'ocr_items')
      .map((candidate) => candidate.item)
    value.omitted_count = inheritedOmitted + candidates.length - selected.length
    if (query)
      value.omitted_matching_count =
        value.matched_count! - selected.filter((candidate) => candidate.matches).length
    value.truncated =
      source.truncated === true ||
      value.omitted_count > 0 ||
      value.ocr_text_truncated ||
      cua?.truncated === true
    const json = JSON.stringify(value)
    return { json, bytes: Buffer.byteLength(json, 'utf8') }
  }
  const minimum = encode()
  if (minimum.bytes > options.budgetBytes)
    return {
      ok: false,
      code: 'OBSERVATION_CONTEXT_BUDGET',
      budgetBytes: options.budgetBytes,
      requiredBytes: minimum.bytes,
    }
  for (const candidate of candidates) {
    if (requiredIds.has(candidate.item.id) || !candidate.matches) continue
    selected.push(candidate)
    if (encode().bytes > options.budgetBytes) selected.pop()
  }

  // Target semantics are atomic. Only free OCR text may be shortened, and that
  // is explicitly marked. Count the serialized JSON, including escape overhead.
  value.ocr_text = displayText
  value.ocr_text_truncated = inheritedTextTruncated || displayText !== originalText
  if (encode().bytes > options.budgetBytes) {
    const points = Array.from(displayText)
    let low = 0,
      high = points.length - 1
    value.ocr_text_truncated = inheritedTextTruncated || originalText.length > 0
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      value.ocr_text = points.slice(0, middle).join('')
      if (encode().bytes <= options.budgetBytes) low = middle
      else high = middle - 1
    }
    value.ocr_text = points.slice(0, Math.max(0, low)).join('')
  }
  const encoded = encode()
  return { ok: true, value, ...encoded }
}
