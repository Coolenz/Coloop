import { expect, it } from 'vitest'
import { reconcileReadOnly } from '../src/main/infrastructure/harness-recovery'

it('allows only known reads to be requested again after an interrupted dispatch', () => {
  const intent = (name: string, args: unknown = {}) =>
    reconcileReadOnly({ callId: 'old', name, arguments: args })
  expect(intent('coloop_read_structured')).toEqual({ kind: 'retry_read_only' })
  expect(intent('coloop_read_editor')).toEqual({ kind: 'retry_read_only' })
  expect(intent('coloop_ask_user')).toEqual({ kind: 'retry_read_only' })
  expect(intent('coloop_conversation_history', { offset: 10, limit: 100 })).toEqual({
    kind: 'retry_read_only',
  })
  expect(intent('coloop_memory_search', { query: '邮件偏好', limit: 3 })).toEqual({
    kind: 'retry_read_only',
  })
  expect(intent('coloop_workspace', { operation: 'read_text' })).toEqual({
    kind: 'retry_read_only',
  })
  expect(intent('coloop_web', { operation: 'extract' })).toEqual({ kind: 'retry_read_only' })
  for (const name of [
    'coloop_execute',
    'coloop_write_text',
    'coloop_remember_preference',
    'coloop_schedule',
    'coloop_read_secret',
  ])
    expect(intent(name)).toBeUndefined()
  expect(intent('coloop_workspace', { operation: 'write_text' })).toBeUndefined()
  expect(intent('coloop_web', { operation: 'act' })).toBeUndefined()
  expect(intent('coloop_web', { operation: 'navigate' })).toBeUndefined()
})
