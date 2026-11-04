/** Reject ambiguous wire objects, including escaped aliases of the same key. */
export function parseStrictJson(raw: string): unknown {
  const result = JSON.parse(raw, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('NONFINITE_JSON')
    return value
  })
  const stack: (Set<string> | null)[] = []
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '{' || raw[index] === '[') {
      stack.push(raw[index] === '{' ? new Set() : null)
    } else if (raw[index] === '}' || raw[index] === ']') {
      stack.pop()
    } else if (raw[index] === '"') {
      const start = index++
      for (; index < raw.length; index++) {
        if (raw[index] === '\\') index++
        else if (raw[index] === '"') break
      }
      let next = index + 1
      while (next < raw.length && /\s/.test(raw[next])) next++
      if (raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, index + 1)) as string
        const keys = stack.at(-1)
        if (!keys || keys.has(key)) throw new Error('DUPLICATE_JSON_KEY')
        keys.add(key)
      }
    }
  }
  return result
}
