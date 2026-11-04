import { describe, expect, it, vi } from 'vitest'
import { parseStrictJson } from '../src/main/domain/strict-json'
import { CoordinatorService } from '../src/main/services/coordinator'

describe('strict incoming JSON', () => {
  it.each([
    '{"sequence":1,"sequence":2}',
    '{"a":1,"\\u0061":2}',
    '{"x":[{"a":1,"a":2}]}',
    '{"x":1e999}',
    '{"x":NaN}',
  ])('rejects duplicate keys or nonfinite values: %s', (raw) =>
    expect(() => parseStrictJson(raw)).toThrow(),
  )
  it('allows independent nested keys and key-looking quoted text', () => {
    const raw = '{"x":{"key":1},"y":{"key":2},"text":"\\\"key\\\":{[]}"}'
    expect(parseStrictJson(raw)).toEqual(JSON.parse(raw))
  })
  it.each(['/v1/hooks', '/v1/hooks/review', '/v1/review'])(
    'rejects ambiguous HTTP payload before policy or model at %s',
    async (path) => {
      const hookHandler = vi.fn(async () => ({})),
        generate = vi.fn(async () => '1')
      const service = new CoordinatorService({
        hookHandler,
        generate,
        isBusy: () => false,
        onChange: () => {},
      })
      try {
        const token = 'strict-json-test-token-with-more-than-thirty-two-characters'
        const { url } = await service.start({ token })
        const response = await fetch(url + path, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: '{"sequence":1,"\\u0073equence":2}',
        })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'INVALID_JSON' })
        expect(hookHandler).not.toHaveBeenCalled()
        expect(generate).not.toHaveBeenCalled()
      } finally {
        await service.dispose()
      }
    },
  )
})
