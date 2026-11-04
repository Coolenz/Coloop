export interface CloudSourceSpan {
  id: string
  text: string
}

export const cloudProjectionQuestion =
  '请只依据以下已脱敏的原文片段分析用户目标与必要条件，给出简短结论、建议步骤和不确定性；保留占位符，不补造事实，不索取或恢复本地原文。'

// IDs distinguish registries in this process. They are selectors, never permissions.
let nextSpanId = 1
const terminal = /[。！？]/u
const closing = /[”’」』）】]/u

function fail(code: string): never {
  throw new Error(`CLOUD_SPANS_${code}`)
}

function sourceSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0
  const append = (end: number) => {
    const sentence = text.slice(start, end).trim()
    if (sentence && !/^\[REMOVED_SECRET\][。！？]*$/u.test(sentence)) sentences.push(sentence)
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r' || text[index] === '\n') {
      append(index)
      if (text[index] === '\r' && text[index + 1] === '\n') index++
      start = index + 1
    } else if (terminal.test(text[index])) {
      let end = index + 1
      while (end < text.length && terminal.test(text[end])) end++
      while (end < text.length && closing.test(text[end])) end++
      append(end)
      start = end
      index = end - 1
    }
  }
  append(text.length)
  return sentences
}

/** Segment an already-masked source without rewriting, truncation or semantic permission. */
export function cloudSourceSpans(source: { prompt: string; context: string }): CloudSourceSpan[] {
  if (!source || typeof source.prompt !== 'string' || typeof source.context !== 'string')
    fail('INVALID_SOURCE')
  const texts = [...sourceSentences(source.prompt), ...sourceSentences(source.context)]
  if (!texts.length) fail('EMPTY_SOURCE')
  if (texts.length > 48) fail('SOURCE_LIMIT')
  if (!Number.isSafeInteger(nextSpanId + texts.length - 1)) fail('ID_LIMIT')
  const spans = texts.map((text) => Object.freeze({ id: `S${nextSpanId++}`, text }))
  return Object.freeze(spans) as unknown as CloudSourceSpan[]
}

/** Accept only [{id: string}] and select exact source strings. Egress checks remain mandatory. */
export function selectCloudProjection(
  spans: CloudSourceSpan[],
  selected: unknown,
): { question: string; facts: string[] } {
  if (!Array.isArray(spans) || !spans.length || spans.length > 48) fail('INVALID_REGISTRY')
  const registry = new Set<string>()
  for (const span of spans) {
    if (
      !span ||
      typeof span.id !== 'string' ||
      !/^S[1-9]\d*$/.test(span.id) ||
      typeof span.text !== 'string' ||
      !span.text.trim() ||
      registry.has(span.id)
    )
      fail('INVALID_REGISTRY')
    registry.add(span.id)
  }
  if (!Array.isArray(selected) || !selected.length || selected.length > 6) fail('INVALID_SELECTION')
  const chosen = new Set<string>()
  for (const choice of selected) {
    if (
      !choice ||
      typeof choice !== 'object' ||
      Array.isArray(choice) ||
      Object.keys(choice).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(choice, 'id') ||
      typeof choice.id !== 'string'
    )
      fail('INVALID_SELECTION')
    const id = choice.id
    if (!registry.has(id)) fail('UNKNOWN_ID')
    if (chosen.has(id)) fail('DUPLICATE_ID')
    chosen.add(id)
  }
  const projection = {
    question: cloudProjectionQuestion,
    facts: spans.filter((span) => chosen.has(span.id)).map((span) => span.text),
  }
  if (Buffer.byteLength(JSON.stringify(projection), 'utf8') > 3000) fail('PROJECTION_LIMIT')
  return projection
}
