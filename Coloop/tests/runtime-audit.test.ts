import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runtimeAuditRecord } from '../src/main/domain/runtime-audit'
import { TarsAgentService, type TarsAgentOptions } from '../src/main/services/tars-agent'

const session = '12345678-1234-4123-8123-123456789abc'
const tools = new Set(['coloop_memory_get', 'coloop_execute'])
const canary = 'PRIVATE_CANARY_alice@example.com_password=secret123'

describe('runtime diagnostic privacy boundary', () => {
  it('keeps only host-approved metadata and leaves the original runtime event intact', () => {
    const event = {
      type: 'tool_result',
      name: 'coloop_memory_get',
      toolCallId: canary,
      content: [{ type: 'text', text: canary }],
      arguments: { query: canary },
      error: canary,
      path: canary,
      at: canary,
      extra: { memory: canary, credentials: canary },
    }
    const before = structuredClone(event)
    expect(runtimeAuditRecord(session, event, tools, 100)).toEqual({
      schema: 'coloop-runtime-audit-v1',
      sessionId: session,
      recordedAt: 100,
      event: { type: 'tool_result', name: 'coloop_memory_get', hasError: true },
    })
    expect(event).toEqual(before)
  })

  it('never treats arbitrary event types, names, ids or error-shaped strings as metadata', () => {
    for (const event of [
      { type: canary, name: canary, error: canary, finishReason: canary },
      { type: 'agent_error', error: 'MEMORY_REQUIRES_LOCAL_ROUTE: ' + canary },
      {
        type: 'harness_session_event',
        event: { type: canary, data: { name: canary, error: canary } },
      },
      { type: { toString: () => 'tool_call', secret: canary } },
    ]) {
      const serialized = JSON.stringify(runtimeAuditRecord(canary, event, tools, 100))
      expect(serialized).not.toContain(canary)
      expect(serialized).not.toContain('secret123')
      expect(serialized).not.toContain('sessionId')
    }
  })

  it('projects nested Harness outcomes without copying their messages or error bodies', () => {
    expect(
      runtimeAuditRecord(
        session,
        {
          type: 'harness_session_event',
          event: {
            type: 'turn/end',
            data: {
              reason: {
                kind: 'error',
                error: { message: 'MEMORY_REQUIRES_LOCAL_ROUTE', stack: canary },
              },
              content: canary,
            },
          },
        },
        tools,
        100,
      )?.event,
    ).toEqual({
      type: 'harness_session_event',
      harnessType: 'turn/end',
      finishReason: 'error',
      hasError: true,
      errorCode: 'MEMORY_REQUIRES_LOCAL_ROUTE',
    })
    expect(
      runtimeAuditRecord(session, { type: 'assistant_streaming_message', content: canary }, tools),
    ).toBeUndefined()
  })

  it('retains bounded operational counters but drops arbitrary diagnostics and timestamps', () => {
    expect(
      runtimeAuditRecord(
        session,
        {
          type: 'coloop_local_protocol_retry',
          attempt: 1,
          error: 'HARNESS_RK_TOOL_ENVELOPE_INVALID',
          response: canary,
          prompt: canary,
        },
        tools,
        100,
      )?.event,
    ).toEqual({
      type: 'coloop_local_protocol_retry',
      attempt: 1,
      hasError: true,
      errorCode: 'HARNESS_RK_TOOL_ENVELOPE_INVALID',
    })
    expect(
      runtimeAuditRecord(
        session,
        {
          type: 'coloop_consult_retry',
          status: 503,
          attempt: 2,
          at: canary,
          error: canary,
        },
        tools,
        100,
      )?.event,
    ).toEqual({ type: 'coloop_consult_retry', hasError: true, status: 503, attempt: 2 })
    expect(
      runtimeAuditRecord(
        session,
        {
          type: 'coloop_progress_diagnostic',
          units: 2001,
          stalled: true,
          diagnostic: canary,
        },
        tools,
        100,
      )?.event,
    ).toEqual({ type: 'coloop_progress_diagnostic', stalled: true })
  })

  it('writes metadata to the actual diagnostic sink without persisting a memory response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'coloop-audit-'))
    const unused = (): never => {
      throw new Error('UNEXPECTED_OPERATION')
    }
    const options: TarsAgentOptions = {
      workspace: directory,
      model: unused,
      available: () => false,
      assertStart: unused,
      observe: unused,
      input: unused,
      prepareInput: unused,
      onChange: () => {},
      execution: {
        connect: unused,
        begin: unused,
        execute: unused,
        stop: unused,
        dispose: () => {},
      },
      memory: { enqueue: unused, catalog: unused, get: unused, dispose: () => {} },
    }
    const service = new TarsAgentService(options)
    try {
      const sink = service as unknown as {
        record(id: string, value: unknown): void
        journal: Promise<void>
      }
      const event = { type: 'tool_result', name: 'coloop_memory_get', content: canary }
      sink.record(session, event)
      await sink.journal
      const content = await readFile(join(directory, 'tars-events', 'events.jsonl'), 'utf8')
      expect(content).not.toContain(canary)
      expect(JSON.parse(content).event).toEqual({ type: 'tool_result', name: 'coloop_memory_get' })
      expect(event.content).toBe(canary)
    } finally {
      await service.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
