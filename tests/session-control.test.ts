import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_COMMAND_TTL_MS,
  SESSION_OFFLINE_MS,
  SessionControlService,
} from '../src/main/services/session-control'
import type { HookEnvelope, HookSnapshot } from '../src/shared/hooks'
import type { SessionCommandInput, SessionRegistration } from '../src/shared/sessions'

let root: string
let clock: number
const services: SessionControlService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'coloop-control-'))
  clock = Date.now()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  await rm(root, { recursive: true, force: true })
})
function create(options: { roots?: string[]; journalPath?: string } = {}) {
  const onChange = vi.fn()
  const service = new SessionControlService({
    workspaceRoots: () => options.roots ?? [root],
    onChange,
    journalPath: options.journalPath ?? join(root, 'private', 'control.json'),
    now: () => clock,
  })
  services.push(service)
  return { service, onChange }
}
function registration(fields: Partial<SessionRegistration> = {}): SessionRegistration {
  return {
    version: 1,
    source: 'opencode',
    sourceId: 'source-1',
    instanceId: 'process-1',
    sessionId: 'session-private-1',
    workspace: root,
    title: 'Synthetic native session',
    host: 'windows',
    capabilities: ['send_message', 'abort_turn'],
    state: 'idle',
    ...fields,
  }
}
function owner(fields: Record<string, unknown> = {}) {
  return {
    version: 1,
    source: 'opencode',
    sourceId: 'source-1',
    instanceId: 'process-1',
    ...fields,
  }
}
function send(handle: string, fields: Partial<SessionCommandInput> = {}): SessionCommandInput {
  return {
    commandId: randomUUID(),
    sessionHandle: handle,
    action: 'send_message',
    text: 'Inspect the synthetic workspace and explain the next step.',
    ...fields,
  }
}
function report(commandId: string, status: string, fields: Record<string, unknown> = {}) {
  return {
    ...owner(),
    sessionId: 'session-private-1',
    commandId,
    status,
    ...fields,
  }
}
function hook(
  sequence: number,
  taskId: string,
  state: string,
  fields: Partial<HookEnvelope> = {},
): HookEnvelope {
  return {
    taskId,
    sequence,
    eventId: `event-${taskId}-${sequence}`,
    kind: 'status',
    payload: { state },
    ...fields,
    version: 1,
    source: 'opencode',
    sourceId: fields.sourceId ?? 'source-1',
    instanceId: fields.instanceId ?? 'process-1',
    sessionId: fields.sessionId ?? 'session-private-1',
    workspace: fields.workspace ?? root,
  }
}
async function registered(
  service: SessionControlService,
  fields: Partial<SessionRegistration> = {},
) {
  return (await service.register(registration(fields))).sessionHandle
}
async function dispatched(service: SessionControlService) {
  const handle = await registered(service)
  const request = send(handle)
  const command = await service.submit(request)
  const wire = (await service.poll(owner())).commands[0]
  return { handle, request, command, wire }
}

describe('native session registration and command routing', () => {
  it('projects bounded sanitized progress only for the registered native instance', async () => {
    const { service } = create()
    const handle = await registered(service)
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const item: HookSnapshot['sessions'][number] = {
      scopeId: 'scope',
      sourceId: 'source-1',
      instanceIdHash: hash('process-1'),
      sessionIdHash: hash('session-private-1'),
      taskIdHash: hash('task-1'),
      state: 'idle',
      lastKind: 'message',
      lastReceivedAt: new Date(clock).toISOString(),
      contextBytes: 500,
      contextEvents: 1,
      excerpt: 'safe progress '.repeat(30),
    }
    const hooks: HookSnapshot = {
      status: 'ready',
      sessionCount: 2,
      contextBytes: 1000,
      receivedEvents: 2,
      duplicateEvents: 0,
      rejectedEvents: 0,
      droppedEvents: 0,
      activityErrors: 0,
      sessions: [
        { ...item, instanceIdHash: hash('other-process'), excerpt: 'must not cross sessions' },
        item,
      ],
      metrics: [],
    }
    expect(service.projectProgress(hooks)).toEqual([
      { sessionHandle: handle, text: item.excerpt!.slice(0, 200), at: item.lastReceivedAt },
    ])
    expect(JSON.stringify(service.projectProgress(hooks))).not.toContain('session-private-1')
    await registered(service, { instanceId: 'replacement-process' })
    expect(service.projectProgress(hooks)).toEqual([])
  })
  it('requires an existing trusted directory, rejects siblings and junction escapes', async () => {
    const trusted = join(root, 'trusted')
    const outside = join(root, 'outside')
    await mkdir(trusted)
    await mkdir(outside)
    await symlink(outside, join(trusted, 'escape'), 'junction')
    const { service } = create({ roots: [trusted] })
    await expect(service.register(registration({ workspace: outside }))).rejects.toMatchObject({
      reasonCode: 'UNTRUSTED_WORKSPACE',
    })
    await expect(
      service.register(registration({ workspace: join(trusted, 'escape') })),
    ).rejects.toMatchObject({ reasonCode: 'UNTRUSTED_WORKSPACE' })
    await expect(
      service.register(registration({ workspace: join(root, 'missing') })),
    ).rejects.toMatchObject({ reasonCode: 'WORKSPACE_UNAVAILABLE' })
    await expect(service.register(registration({ workspace: 'relative' }))).rejects.toMatchObject({
      reasonCode: 'INVALID_WORKSPACE',
    })
    expect(service.snapshot().sessions).toHaveLength(0)
  })
  it('exposes an opaque session handle and no native identifiers or prompt text', async () => {
    const { service } = create()
    const handle = await registered(service)
    const request = send(handle, { text: 'private-prompt-canary' })
    await service.submit(request)
    const snapshot = service.snapshot()
    expect(snapshot.sessions[0]).toMatchObject({ handle, state: 'idle', controlActive: true })
    expect(JSON.stringify(snapshot)).not.toContain('session-private-1')
    expect(JSON.stringify(snapshot)).not.toContain('process-1')
    expect(JSON.stringify(snapshot)).not.toContain('private-prompt-canary')
    const journal = await readFile(join(root, 'private', 'control.json'), 'utf8')
    expect(journal).not.toContain('session-private-1')
    expect(journal).not.toContain('private-prompt-canary')
  })
  it('supports multiple sessions and routes only to the matching instance', async () => {
    const { service } = create()
    const first = await registered(service)
    const second = await registered(service, { sessionId: 'session-2', instanceId: 'process-2' })
    const a = await service.submit(send(first))
    const b = await service.submit(send(second))
    expect((await service.poll(owner())).commands.map((item) => item.commandId)).toEqual([
      a.commandId,
    ])
    expect(
      (await service.poll(owner({ instanceId: 'process-2' }))).commands.map(
        (item) => item.commandId,
      ),
    ).toEqual([b.commandId])
  })
  it('retires a replaced instance and keeps its unresolved control visible', async () => {
    const { service } = create()
    const { handle, request } = await dispatched(service)
    const replacement = await registered(service, { instanceId: 'process-2' })
    expect(replacement).not.toBe(handle)
    await expect(service.poll(owner())).rejects.toMatchObject({ reasonCode: 'STALE_INSTANCE' })
    await expect(service.register(registration())).rejects.toMatchObject({
      reasonCode: 'STALE_INSTANCE',
    })
    await expect(service.report(report(request.commandId, 'confirmed'))).rejects.toMatchObject({
      reasonCode: 'COMMAND_TARGET_MISMATCH',
    })
    expect(service.snapshot().sessions.find((item) => item.handle === handle)).toMatchObject({
      connected: false,
      controlActive: true,
    })
    expect(service.snapshot().commands[0].status).toBe('unknown')
  })
  it('does not permit RK/other sources or unsupported capabilities to start control', async () => {
    const { service } = create()
    const rk = await registered(service, { host: 'rk' })
    await expect(service.submit(send(rk))).rejects.toMatchObject({
      reasonCode: 'WINDOWS_SESSION_REQUIRED',
    })
    const other = await registered(service, { host: 'other', sessionId: 'other' })
    await expect(service.submit(send(other))).rejects.toMatchObject({
      reasonCode: 'WINDOWS_SESSION_REQUIRED',
    })
    const limited = await registered(service, { sessionId: 'limited', capabilities: [] })
    await expect(service.submit(send(limited))).rejects.toMatchObject({
      reasonCode: 'UNSUPPORTED_CAPABILITY',
    })
    await expect(
      service.submit(send(rk, { action: 'abort_turn', text: undefined })),
    ).rejects.toMatchObject({ reasonCode: 'SESSION_NOT_CONTROLLED' })
  })
  it('validates exact schemas, UTF-8 budgets and action-specific arguments', async () => {
    const { service } = create()
    const handle = await registered(service)
    await expect(service.submit(send(handle, { text: '中'.repeat(2800) }))).rejects.toMatchObject({
      reasonCode: 'INVALID_SESSION_COMMAND',
    })
    await expect(service.submit(send(handle, { action: 'abort_turn' }))).rejects.toMatchObject({
      reasonCode: 'INVALID_SESSION_COMMAND',
    })
    await expect(service.submit({ ...send(handle), surprise: true })).rejects.toMatchObject({
      reasonCode: 'INVALID_SESSION_COMMAND',
    })
    await expect(
      service.register(registration({ capabilities: ['send_message', 'send_message'] })),
    ).rejects.toMatchObject({ reasonCode: 'INVALID_SESSION_REGISTRATION' })
  })
})

describe('outbox delivery, replay protection and expiry', () => {
  it('re-checks collected delivery after a stop, suspend or instance replacement', async () => {
    for (const change of ['stop', 'suspend', 'replace']) {
      const { service } = create({ journalPath: join(root, `${change}.json`) })
      const { request } = await dispatched(service)
      expect(service.canDeliver(request.commandId)).toBe(true)
      if (change === 'stop') await service.stopAll()
      if (change === 'suspend') await service.disconnectAll('HOST_SUSPENDED')
      if (change === 'replace') await registered(service, { instanceId: 'new-instance' })
      expect(service.canDeliver(request.commandId)).toBe(false)
    }
  })
  it('deduplicates concurrent submissions and never redelivers an ambiguous write', async () => {
    const { service } = create()
    const handle = await registered(service)
    const request = send(handle)
    const results = await Promise.all([service.submit(request), service.submit(request)])
    expect(results[0]).toEqual(results[1])
    expect((await service.poll(owner())).commands).toHaveLength(1)
    expect((await service.poll(owner())).commands).toHaveLength(0)
    await service.report(report(request.commandId, 'unknown', { errorCode: 'TRANSPORT_UNCERTAIN' }))
    expect((await service.poll(owner())).commands).toHaveLength(0)
    expect((await service.submit(request)).status).toBe('unknown')
    await expect(service.submit({ ...request, text: 'changed' })).rejects.toMatchObject({
      reasonCode: 'COMMAND_CONFLICT',
    })
    await expect(service.submit(send(handle))).rejects.toMatchObject({ reasonCode: 'SESSION_BUSY' })
  })
  it('bounds a poll to eight distinct sessions', async () => {
    const { service } = create()
    for (let index = 0; index < 10; index++) {
      const handle = await registered(service, { sessionId: `session-${index}` })
      await service.submit(send(handle))
    }
    const first = (await service.poll(owner())).commands
    expect(first).toHaveLength(8)
    expect(new Set(first.map((item) => item.sessionId)).size).toBe(8)
    expect((await service.poll(owner())).commands).toHaveLength(2)
  })
  it('expires queued commands without delivery and leaves dispatched results unknown', async () => {
    const { service } = create()
    const handle = await registered(service)
    const queued = await service.submit(send(handle))
    clock += SESSION_COMMAND_TTL_MS
    await service.tick()
    expect((await service.poll(owner())).commands).toHaveLength(0)
    expect(
      service.snapshot().commands.find((item) => item.commandId === queued.commandId)?.status,
    ).toBe('expired')
    const second = await registered(service, { sessionId: 'second' })
    const sent = await service.submit(send(second))
    await service.poll(owner())
    clock += SESSION_COMMAND_TTL_MS
    await service.tick()
    expect(
      service.snapshot().commands.find((item) => item.commandId === sent.commandId)?.status,
    ).toBe('unknown')
    expect(service.snapshot().controlActive).toBe(true)
  })
  it('rejects offline targets and requires registration before reconnecting', async () => {
    const { service } = create()
    const { handle, request } = await dispatched(service)
    clock += SESSION_OFFLINE_MS
    await service.tick()
    await expect(service.submit(send(handle))).rejects.toMatchObject({
      reasonCode: 'SOURCE_OFFLINE',
    })
    expect(service.snapshot().sessions[0]).toMatchObject({ connected: false, controlActive: true })
    expect((await service.poll(owner())).commands).toEqual([])
    expect(service.snapshot().sessions[0].connected).toBe(false)
    await registered(service)
    expect(service.snapshot().sessions[0].connected).toBe(true)
    expect((await service.poll(owner())).commands).toEqual([])
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)?.status,
    ).toBe('unknown')
  })
  it('keeps polls alive independently from delayed registration heartbeats', async () => {
    const { service } = create()
    await registered(service)
    for (let index = 0; index < 4; index++) {
      clock += SESSION_OFFLINE_MS - 1
      await service.poll(owner())
    }
    expect(service.snapshot().sessions[0].connected).toBe(true)
  })
  it('binds reports to source, instance, session, command and native message ID', async () => {
    const { service } = create()
    const { request } = await dispatched(service)
    for (const changed of [
      { sourceId: 'wrong' },
      { instanceId: 'wrong' },
      { sessionId: 'wrong' },
      { commandId: randomUUID() },
    ])
      await expect(
        service.report(report(request.commandId, 'accepted', changed)),
      ).rejects.toMatchObject({
        reasonCode: 'COMMAND_TARGET_MISMATCH',
      })
    await expect(
      service.report(report(request.commandId, 'accepted', { messageId: 'wrong-message' })),
    ).rejects.toMatchObject({ reasonCode: 'MESSAGE_ID_MISMATCH' })
    await service.report(report(request.commandId, 'confirmed'))
    await expect(service.report(report(request.commandId, 'failed'))).rejects.toMatchObject({
      reasonCode: 'COMMAND_REPORT_CONFLICT',
    })
  })
})

describe('control visibility and verified turn lifecycle', () => {
  it('revokes an unsent command when a native busy event arrives for another user task', async () => {
    const { service } = create()
    const handle = await registered(service)
    const command = await service.submit(send(handle))
    await service.observeHook(hook(1, 'new-local-user-task', 'busy'))
    expect((await service.poll(owner())).commands).toEqual([])
    expect(
      service.snapshot().commands.find((item) => item.commandId === command.commandId),
    ).toMatchObject({
      status: 'cancelled',
      errorCode: 'SOURCE_BECAME_BUSY',
      controlResolved: true,
    })
    expect(service.snapshot().sessions[0]).toMatchObject({
      state: 'running',
      controlActive: false,
      connected: true,
    })
  })
  it('revokes an unsent command immediately when a different native user message appears', async () => {
    const { service } = create()
    const handle = await registered(service)
    await service.submit(send(handle))
    await service.observeHook(
      hook(1, 'new-local-user-message', '', {
        kind: 'message',
        payload: {
          role: 'user',
          messageId: 'new-local-user-message',
          text: 'Run my new local task.',
        },
      }),
    )
    expect((await service.poll(owner())).commands).toEqual([])
    expect(service.snapshot().sessions[0]).toMatchObject({ state: 'running', controlActive: false })
    expect(service.snapshot().commands[0].status).toBe('cancelled')
  })
  it('treats a non-idle registration as grounds to cancel a queued send before delivery', async () => {
    const { service } = create()
    const handle = await registered(service)
    await service.submit(send(handle))
    await registered(service, { state: 'running' })
    expect((await service.poll(owner())).commands).toEqual([])
    expect(service.snapshot().commands[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'SOURCE_BECAME_BUSY',
    })
    expect(service.snapshot().sessions[0]).toMatchObject({ state: 'running', controlActive: false })
  })
  it('preserves an already dispatched command when its own native turn becomes busy', async () => {
    const { service } = create()
    const { request, wire } = await dispatched(service)
    await service.observeHook(hook(1, wire.messageId!, 'busy'))
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)?.status,
    ).toBe('dispatched')
    expect(service.snapshot().sessions[0]).toMatchObject({ state: 'running', controlActive: true })
    expect((await service.poll(owner())).commands).toEqual([])
    await service.observeHook(hook(2, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(false)
  })
  it('does not end control on HTTP acceptance, stale registration idle or unobserved idle', async () => {
    const { service } = create()
    const { request, wire } = await dispatched(service)
    await service.report(report(request.commandId, 'accepted'))
    await registered(service, { state: 'idle' })
    await service.observeHook(hook(1, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
    await service.report(report(request.commandId, 'confirmed', { messageId: wire.messageId }))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
  })
  it('ends an owned turn only after its busy then idle events, irrespective of task routing keys', async () => {
    const { service } = create()
    const { request, wire } = await dispatched(service)
    await service.observeHook(hook(1, 'previous-task', 'busy'))
    await service.observeHook(hook(2, 'previous-task', 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
    await service.observeHook(hook(1, wire.messageId!, 'busy'))
    await service.observeHook(hook(1, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
    await service.observeHook(hook(2, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(false)
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)
        ?.controlResolved,
    ).toBe(true)
  })
  it('confirms source message observation without pretending the task has completed', async () => {
    const { service } = create()
    const { request, wire } = await dispatched(service)
    await service.observeHook(
      hook(1, wire.messageId!, 'busy', {
        kind: 'message',
        payload: { role: 'user', messageId: wire.messageId, text: 'synthetic user message' },
      }),
    )
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)?.status,
    ).toBe('confirmed')
    expect(service.snapshot().controlActive).toBe(true)
  })
  it('ignores unregistered sessions, mismatched workspaces and old instances', async () => {
    const { service } = create()
    const { wire } = await dispatched(service)
    const otherWorkspace = join(root, 'other-workspace')
    await mkdir(otherWorkspace)
    await service.observeHook(hook(1, wire.messageId!, 'busy', { sessionId: 'unregistered' }))
    await service.observeHook(hook(2, wire.messageId!, 'busy', { workspace: otherWorkspace }))
    await service.observeHook(hook(3, wire.messageId!, 'busy', { instanceId: 'wrong' }))
    await service.observeHook(hook(4, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
  })
  it('does not erase uncertain execution merely because a later verification failed', async () => {
    const { service } = create()
    const { request } = await dispatched(service)
    await service.report(report(request.commandId, 'accepted'))
    await service.report(report(request.commandId, 'failed', { errorCode: 'VERIFICATION_FAILED' }))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
    expect(service.snapshot().commands[0].status).toBe('unknown')
  })
  it('does not close a new controlled turn when the previous task scope retires', async () => {
    const { service } = create()
    const { wire } = await dispatched(service)
    await service.observeHook(
      hook(5, 'previous-task', 'closed', { kind: 'closed', payload: { state: 'closed' } }),
    )
    expect(service.snapshot().sessions[0]).toMatchObject({ controlActive: true, connected: true })
    await service.observeHook(hook(1, wire.messageId!, 'busy'))
    await service.observeHook(hook(2, wire.messageId!, 'idle'))
    expect(service.snapshot().sessions[0].controlActive).toBe(false)
    await registered(service)
    expect(service.snapshot().sessions[0].connected).toBe(true)
  })
})

describe('emergency stop, explicit resume and durable safety', () => {
  it('latches stop first, cancels queued messages and delivers an abort without inference', async () => {
    const { service } = create()
    const handle = await registered(service)
    const queued = await service.submit(send(handle))
    await service.stopAll()
    expect(service.snapshot()).toMatchObject({ stopped: true, controlActive: true })
    expect(service.snapshot().sessions[0].stopping).toBe(true)
    expect(
      service.snapshot().commands.find((item) => item.commandId === queued.commandId)?.status,
    ).toBe('cancelled')
    const aborts = (await service.poll(owner())).commands
    expect(aborts).toHaveLength(1)
    expect(aborts[0].action).toBe('abort_turn')
    expect(aborts[0].text).toBeUndefined()
    await service.report(report(aborts[0].commandId, 'accepted'))
    expect(service.snapshot().sessions[0].controlActive).toBe(true)
    await service.report(report(aborts[0].commandId, 'confirmed'))
    expect(service.snapshot().controlActive).toBe(false)
    expect(service.snapshot().stopped).toBe(true)
  })
  it('preempts an in-flight send while preserving uncertainty until a verified abort', async () => {
    const { service } = create()
    const { request, wire } = await dispatched(service)
    await service.stopAll()
    const abort = (await service.poll(owner())).commands[0]
    expect(abort.action).toBe('abort_turn')
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)?.status,
    ).toBe('unknown')
    await service.observeHook(hook(1, wire.messageId!, 'busy'))
    await service.observeHook(hook(2, wire.messageId!, 'idle'))
    expect(service.snapshot().controlActive).toBe(true)
    await service.report(report(abort.commandId, 'confirmed'))
    expect(service.snapshot().controlActive).toBe(false)
    expect(service.snapshot().unconfirmedCount).toBe(0)
    expect(
      service.snapshot().commands.find((item) => item.commandId === request.commandId)?.status,
    ).toBe('unknown')
  })
  it('does not automatically resume on reconnect and explicit resume never requeues old sends', async () => {
    const { service } = create()
    const handle = await registered(service)
    await service.submit(send(handle))
    await service.stopAll()
    const abort = (await service.poll(owner())).commands[0]
    await service.report(report(abort.commandId, 'confirmed'))
    await registered(service)
    await expect(service.submit(send(handle))).rejects.toMatchObject({
      reasonCode: 'CONTROL_STOPPED',
    })
    await service.resume()
    expect((await service.poll(owner())).commands).toHaveLength(0)
    expect((await service.submit(send(handle))).status).toBe('queued')
  })
  it('keeps disconnected control unconfirmed and does not claim a stop occurred', async () => {
    const { service } = create()
    await dispatched(service)
    await service.disconnectAll('SYSTEM_SUSPENDED')
    await service.stopAll()
    expect(service.snapshot().sessions[0]).toMatchObject({
      connected: false,
      controlActive: true,
      stopping: true,
    })
    expect((await service.poll(owner())).commands).toEqual([])
  })
  it('restores replay protection and unknown outcomes without restoring native routes', async () => {
    const { service } = create()
    const { request } = await dispatched(service)
    await service.dispose()
    const restored = create().service
    expect(restored.snapshot().sessions).toEqual([])
    expect(restored.snapshot()).toMatchObject({ controlActive: true, unconfirmedCount: 1 })
    expect((await restored.submit(request)).status).toBe('unknown')
    await expect(restored.poll(owner())).rejects.toMatchObject({ reasonCode: 'STALE_INSTANCE' })
    await expect(restored.submit({ ...request, text: 'different' })).rejects.toMatchObject({
      reasonCode: 'COMMAND_CONFLICT',
    })
  })
  it('treats a delivered but unfinished task as unknown after restart', async () => {
    const { service } = create()
    const { request } = await dispatched(service)
    await service.report(report(request.commandId, 'confirmed'))
    await service.dispose()
    const restored = create().service
    expect(restored.snapshot()).toMatchObject({ controlActive: true, unconfirmedCount: 1 })
    expect(restored.snapshot().commands[0].status).toBe('unknown')
  })
  it('persists the stop lock across restart and does not resurrect resolved unknown history', async () => {
    const { service } = create()
    await dispatched(service)
    await service.stopAll()
    const abort = (await service.poll(owner())).commands[0]
    await service.report(report(abort.commandId, 'confirmed'))
    await service.dispose()
    const restored = create().service
    expect(restored.snapshot()).toMatchObject({
      stopped: true,
      controlActive: false,
      unconfirmedCount: 0,
    })
    expect(restored.snapshot().sessions).toHaveLength(0)
    const handle = await registered(restored)
    await expect(restored.submit(send(handle))).rejects.toMatchObject({
      reasonCode: 'CONTROL_STOPPED',
    })
  })
  it('keeps a damaged journal intact and refuses new control admissions', async () => {
    const path = join(root, 'damaged.json')
    await writeFile(path, '{broken-but-preserve-me')
    const { service } = create({ journalPath: path })
    expect(service.snapshot()).toMatchObject({
      stopped: true,
      journalError: 'CONTROL_JOURNAL_UNAVAILABLE',
    })
    const handle = await registered(service)
    await expect(service.submit(send(handle))).rejects.toMatchObject({
      reasonCode: 'CONTROL_STOPPED',
    })
    await expect(service.resume()).rejects.toMatchObject({
      reasonCode: 'CONTROL_JOURNAL_UNAVAILABLE',
    })
    expect(await readFile(path, 'utf8')).toBe('{broken-but-preserve-me')
  })
})
