import { describe, expect, it } from 'vitest'
import { violoopIntentSchema, violoopMessageSchema } from '../src/shared/violoop'
import { parseStrictJson } from '../src/main/domain/strict-json'

describe('model intent normalization', () => {
  it('accepts the real RK response and discards its hallucinated explanation', () => {
    expect(
      violoopIntentSchema.parse({
        kind: 'browser_relay',
        message: '正在执行三连',
        url: 'https://other.invalid',
      }),
    ).toEqual({ kind: 'browser_relay' })
  })
  it('accepts explanations on reply and clarification while retaining their required text', () => {
    for (const kind of ['reply', 'clarify'])
      expect(violoopIntentSchema.parse({ kind, message: '说明', reason: '额外解释' })).toEqual({
        kind,
        message: '说明',
      })
  })
  it('still requires unambiguous valid intent fields', () => {
    for (const value of [
      { kind: 'shell' },
      { kind: 'desktop', windowId: -1, expectedText: 'done' },
      { kind: 'desktop', windowId: 0, expectedText: 1 },
      { kind: 'reply' },
    ])
      expect(violoopIntentSchema.safeParse(value).success).toBe(false)
    expect(() => parseStrictJson('{"kind":"reply","kind":"browser_relay"}')).toThrow(
      'DUPLICATE_JSON_KEY',
    )
  })
  it('does not relax the user authorization envelope', () => {
    expect(
      violoopMessageSchema.safeParse({
        commandId: '00000000-0000-4000-8000-000000000000',
        text: '打开bilibili',
        authorizeInput: false,
      }).success,
    ).toBe(false)
  })
})
