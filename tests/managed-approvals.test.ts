import { createHash, createHmac, verify } from 'node:crypto'
import { posix } from 'node:path'
import * as fsPromises from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { ManagedApprovalAuthority } from '../src/main/services/managed-approvals'
import { CoordinatorService, requestHash } from '../src/main/services/coordinator'
import { AgentHookService } from '../src/main/services/agent-hooks'
import type { HookEnvelope } from '../src/shared/hooks'
import { canonicalJson, type ReviewEvent } from '../src/shared/coordinator'
import {
  managedEvidenceSchema,
  managedPermitSchema,
  type ManagedEvidence,
} from '../src/shared/managed'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const verifySource = vi.fn(async () => true)
  const origin = {
    sourceId: 'source-1',
    instanceId: 'instance-1',
    sessionId: 'session-1',
    taskId: 'message-1',
    workspace: process.cwd(),
  }
  const authority = new ManagedApprovalAuthority({ origin: () => origin, verifySource })
  const connection = authority.enroll({
    sourceId: origin.sourceId,
    workspace: origin.workspace,
    root: '/managed/project',
    configPath: '/managed/.runtime/coloop-managed/config.json',
    config: Buffer.from('{"enabled_providers":["rkllm"]}'),
    sourceHashes: { 'plugins/coloop-managed.mjs': sha('trusted tool') },
  })
  const evidence = (changes: Partial<ManagedEvidence> = {}): ManagedEvidence => {
    const content = 'def answer(): return 42\n'
    const fields = {
      version: 1 as const,
      enrollmentId: connection.enrollmentId,
      operation: 'read' as const,
      snapshotId: 'snapshot-1',
      sessionId: origin.sessionId,
      messageId: origin.taskId,
      taskId: origin.taskId,
      instanceId: origin.instanceId,
      pid: 1234,
      relativePath: 'src/example.py',
      sha256: sha(content),
      bytes: Buffer.byteLength(content),
      returnedBytes: Buffer.byteLength(content),
      returnedSha256: sha(content),
      truncated: false,
      extension: '.py',
      routeDigest: connection.routeDigest,
      ...changes,
    }
    const { proof: _proof, ...signed } = fields as ManagedEvidence
    return {
      ...signed,
      proof: createHmac('sha256', Buffer.from(connection.proofKey, 'hex'))
        .update(canonicalJson(signed))
        .digest('hex'),
    }
  }
  const event = (value = evidence()): ReviewEvent => ({
    version: 1,
    id: 'permission-1',
    sessionId: origin.sessionId,
    contextRef: 'c'.repeat(64),
    kind: 'permission',
    workspace: origin.workspace,
    tool: 'coloop_read',
    patterns: [posix.join('/managed/project', value.relativePath)],
    managed: value,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 180000).toISOString(),
  })
  return { authority, connection, origin, verifySource, evidence, event }
}

describe('managed snapshot approval authority', () => {
  it('issues an independently verifiable snapshot-bound permit only after source verification', async () => {
    const f = fixture(),
      event = f.event(),
      hash = requestHash(event)
    expect(f.authority.issuePermit(event, hash)).toBeUndefined()
    expect(await f.authority.assess(event)).toMatchObject({ decision: 'candidate' })
    expect(f.verifySource).toHaveBeenCalledOnce()
    const permit = f.authority.issuePermit(event, hash)!
    expect(managedPermitSchema.safeParse(permit).success).toBe(true)
    const { signature, ...fields } = permit
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(fields)),
        f.connection.approvalPublicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true)
    for (const changed of [
      { ...fields, sha256: '0'.repeat(64) },
      { ...fields, returnedBytes: fields.returnedBytes + 1 },
      { ...fields, sessionId: 'other' },
      { ...fields, requestHash: '0'.repeat(64) },
      { ...fields, truncated: true },
    ]) {
      expect(
        verify(
          null,
          Buffer.from(canonicalJson(changed)),
          f.connection.approvalPublicKey,
          Buffer.from(signature, 'base64'),
        ),
      ).toBe(false)
    }
    f.authority.revokeAll()
    expect(f.authority.issuePermit(event, hash)).toBeUndefined()
  })
  it.each([
    '../outside.py',
    '/absolute.py',
    '.env',
    'src/../key.py',
    'src\\bad.py',
    'AGENTS.md',
    'src/api_key.py',
  ])(
    'rejects sensitive or unbounded managed path %s even with an authentic proof',
    async (path) => {
      const f = fixture()
      expect((await f.authority.assess(f.event(f.evidence({ relativePath: path })))).decision).toBe(
        'deny',
      )
      expect(f.verifySource).not.toHaveBeenCalled()
    },
  )
  it('rejects modified proof, cross-source/session, generic endpoint and changed route', async () => {
    const f = fixture()
    const original = f.event()
    for (const event of [
      { ...original, managed: { ...original.managed!, sha256: '0'.repeat(64) } },
      { ...original, contextRef: undefined },
      { ...original, sessionId: 'other' },
      { ...original, tool: 'read' },
      { ...original, command: 'cat src/example.py' },
      { ...original, patterns: ['/other/project/src/example.py'] },
    ])
      expect((await f.authority.assess(event)).decision).toBe('defer')
    f.origin.sourceId = 'another-source'
    expect((await f.authority.assess(original)).decision).toBe('defer')
    f.origin.sourceId = 'source-1'
    f.verifySource.mockResolvedValue(false)
    expect(await f.authority.assess(original)).toMatchObject({
      decision: 'defer',
      reasonCode: 'MANAGED_ROUTE_CHANGED',
    })
    expect(f.authority.issuePermit(original, requestHash(original))).toBeUndefined()
  })
  it('rejects inconsistent truncation/byte budgets, and accepts explicitly bounded truncation', async () => {
    const f = fixture()
    expect((await f.authority.assess(f.event(f.evidence({ returnedBytes: 4096 })))).decision).toBe(
      'deny',
    )
    expect((await f.authority.assess(f.event(f.evidence({ truncated: true })))).decision).toBe(
      'deny',
    )
    const valid = f.event(f.evidence({ bytes: 6000, returnedBytes: 4096, truncated: true }))
    expect((await f.authority.assess(valid)).decision).toBe('candidate')
    expect(managedEvidenceSchema.safeParse(f.evidence({ bytes: 65537 })).success).toBe(false)
  })
  it('does not mint a permit when enrollment is revoked during SSH verification', async () => {
    const f = fixture()
    f.verifySource.mockImplementation(async () => {
      f.authority.revokeAll()
      return true
    })
    expect(await f.authority.assess(f.event())).toMatchObject({
      decision: 'defer',
      reasonCode: 'MANAGED_ROUTE_CHANGED',
    })
  })
  it('asks the real generation interface for allow, excludes untrusted history and attaches only its signed permit', async () => {
    const f = fixture(),
      event = f.event()
    const generate = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('Local only')
      expect(prompt).not.toContain('HISTORY_CANARY')
      expect(prompt).not.toContain(event.managed!.sha256)
      return '1'
    })
    const coordinator = new CoordinatorService({
      managedAuthority: f.authority,
      generate,
      isBusy: () => false,
      onChange: () => {},
      resolveContext: () => ({ text: 'HISTORY_CANARY', bytes: 14 }),
    })
    const result = await coordinator.review(event)
    expect(result).toMatchObject({
      decision: 'allow',
      source: 'rk',
      permit: { snapshotId: event.managed!.snapshotId },
    })
    expect(generate).toHaveBeenCalledOnce()
    await coordinator.dispose()
  })
  it('does not replay an allowed permit after source enrollment is revoked', async () => {
    const f = fixture(),
      event = f.event()
    const generate = vi.fn(async () => '1')
    const coordinator = new CoordinatorService({
      managedAuthority: f.authority,
      generate,
      isBusy: () => false,
      onChange: () => {},
      resolveContext: () => ({ text: '', bytes: 0 }),
    })
    expect((await coordinator.review(event)).decision).toBe('allow')
    f.authority.revokeAll()
    expect(await coordinator.review(event)).toMatchObject({
      decision: 'defer',
      reasonCode: 'MANAGED_ROUTE_CHANGED',
    })
    expect((await coordinator.review(event)).permit).toBeUndefined()
    expect(generate).toHaveBeenCalledOnce()
    await coordinator.dispose()
  })
  it('rechecks enrollment after the asynchronous audit write', async () => {
    const f = fixture()
    const append = vi.mocked(fsPromises.appendFile).mockImplementation(async () => {
      f.authority.revokeAll()
    })
    const coordinator = new CoordinatorService({
      managedAuthority: f.authority,
      generate: async () => '1',
      isBusy: () => false,
      onChange: () => {},
      auditPath: 'synthetic-audit.jsonl',
      resolveContext: () => ({ text: '', bytes: 0 }),
    })
    try {
      const result = await coordinator.review(f.event())
      expect(append).toHaveBeenCalled()
      expect(result).toMatchObject({ decision: 'defer', reasonCode: 'MANAGED_ROUTE_CHANGED' })
      expect(result.permit).toBeUndefined()
      expect(coordinator.snapshot().audit[0].decision).toBe('defer')
    } finally {
      append.mockReset()
      await coordinator.dispose()
    }
  })
  it.each(['cached', 'inflight'])(
    'revokes the Hook %s managed allow while its context remains valid',
    async (mode) => {
      const f = fixture()
      let hooks: AgentHookService
      const coordinator = new CoordinatorService({
        managedAuthority: f.authority,
        generate: async () => '1',
        isBusy: () => false,
        onChange: () => {},
        resolveContext: (event) => hooks.resolveContext(event),
      })
      hooks = new AgentHookService({
        review: async (event) => {
          const result = await coordinator.review(event)
          if (mode === 'inflight') f.authority.revokeAll()
          return result
        },
        managedCurrent: (event) => f.authority.isCurrent(event),
        workspaceRoots: () => [f.origin.workspace],
        onChange: () => {},
      })
      const evidence = f.evidence()
      const event: HookEnvelope = {
        version: 1,
        source: 'opencode',
        ...f.origin,
        sequence: 1,
        eventId: 'hook-managed-1',
        kind: 'approval',
        payload: {
          approval: {
            kind: 'permission',
            id: 'permission-1',
            sessionId: f.origin.sessionId,
            originalDigest: sha('synthetic-pending'),
            tool: 'coloop_read',
            patterns: [posix.join('/managed/project', evidence.relativePath)],
            managed: evidence,
          },
        },
      }
      try {
        const first = await hooks.reviewHook(event)
        if (mode === 'cached') {
          expect(first.decision.decision).toBe('allow')
          f.authority.revokeAll()
        }
        expect(hooks.resolveContext(first.reviewEvent)).toBeDefined()
        const result = mode === 'cached' ? await hooks.reviewHook(event) : first
        expect(result.decision).toMatchObject({
          decision: 'defer',
          reasonCode: 'MANAGED_ROUTE_CHANGED',
        })
        expect(result.decision.permit).toBeUndefined()
      } finally {
        await hooks.dispose()
        await coordinator.dispose()
      }
    },
  )
  it.each(['0', '2', '1 extra', '99'])(
    'never includes a permit for model response %s',
    async (raw) => {
      const f = fixture()
      const coordinator = new CoordinatorService({
        managedAuthority: f.authority,
        generate: async () => raw,
        isBusy: () => false,
        onChange: () => {},
        resolveContext: () => ({ text: '', bytes: 0 }),
      })
      expect((await coordinator.review(f.event())).permit).toBeUndefined()
      await coordinator.dispose()
    },
  )
})
