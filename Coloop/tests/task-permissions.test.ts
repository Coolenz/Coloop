import { describe, expect, it } from 'vitest'
import { requiresTaskApproval } from '../src/main/domain/task-permissions'

describe('task tool permissions', () => {
  it('retains legacy execution and explicit full access', () => {
    expect(requiresTaskApproval(undefined, 'coloop_execute', {})).toBe(false)
    expect(requiresTaskApproval('full', 'coloop_execute', {})).toBe(false)
  })
  it('asks for external tools while keeping internal questions available', () => {
    expect(requiresTaskApproval('ask', 'coloop_observe', {})).toBe(true)
    expect(requiresTaskApproval('ask', 'coloop_ask_user', {})).toBe(false)
  })
  it('automates known reads and asks for writes, arbitrary code and unknown tools', () => {
    expect(requiresTaskApproval('auto', 'coloop_workspace', { operation: 'read_text' })).toBe(false)
    expect(requiresTaskApproval('auto', 'coloop_workspace', { operation: 'write_text' })).toBe(true)
    expect(requiresTaskApproval('auto', 'mcp__playwright__browser_snapshot', {})).toBe(false)
    expect(requiresTaskApproval('auto', 'mcp__playwright__browser_evaluate', {})).toBe(true)
    expect(requiresTaskApproval('auto', 'coloop_execute', {})).toBe(true)
    expect(requiresTaskApproval('auto', 'unknown', {})).toBe(true)
  })
})
