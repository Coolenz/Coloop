import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { publishConnection } from '../infrastructure/coordinator-connection'
import { parseStrictJson } from '../domain/strict-json'
import { sanitizeHookText } from './agent-hooks'
import type { AutoAgentEvent, AutoAgentSession } from '../../shared/auto-agent-work'

export const autoWorkNativeEvents = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreModelRequest',
  'PostModelRequest',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/)
const nativeSchema = z
  .object({
    session_id: id,
    hook_event_name: z.enum(autoWorkNativeEvents),
    cwd: z.string().min(1).max(2048),
    turn_id: id.optional(),
    agent_id: id.optional(),
    tool_use_id: id.optional(),
    tool_name: z.string().max(256).optional(),
    prompt: z.string().max(16384).optional(),
    last_assistant_message: z.string().max(16384).nullable().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    model: z.string().max(160).optional(),
    status: z.string().max(80).optional(),
    error: z.string().max(2048).nullable().optional(),
    source: z.string().max(80).optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .strip()
const wireSchema = z
  .object({
    version: z.literal(1),
    invocationId: z.string().uuid(),
    emittedAt: z.number().int().nonnegative(),
    payload: nativeSchema,
  })
  .strict()
export type NativeAutoWorkPayload = z.infer<typeof nativeSchema>
export interface ChatGPTDesktopEvent extends AutoAgentEvent {
  workspace: string
  nativeName: NativeAutoWorkPayload['hook_event_name']
  payload: NativeAutoWorkPayload
  /** Only a matching prompt proves continuation delivery, never an HTTP response. */
  ownedActionId?: string
}
export interface ChatGPTDesktopSession extends AutoAgentSession {
  /** A CLI hook callback does not establish desktop UI compatibility. */
  desktopVerified: false
}
export interface NativeContinuation {
  actionId: string
  sessionId: string
  turnId: string
  taskVersion: number
  eventRevision: number
  reason: string
  expiresAt: string
}
export interface NativeContinuationReceipt extends NativeContinuation {
  status: 'submitted' | 'confirmed' | 'unknown'
}
export interface ChatGPTDesktopAdapterOptions {
  workspaceRoots: () => string[]
  onEvent: (event: ChatGPTDesktopEvent, session: ChatGPTDesktopSession) => void
  onChange?: () => void
  /** Must synchronously reserve the action in the task ledger before returning true. */
  claimContinuation?: (
    action: NativeContinuation,
    event: ChatGPTDesktopEvent,
  ) => boolean | Promise<boolean>
  onNativeContinuation?: (receipt: NativeContinuationReceipt) => void
  now?: () => number
}
type HookOutput = { decision: 'block'; reason: string } | Record<string, never>

/** Authenticated, scoped event ingress. It cannot execute shell commands or approve permissions. */
export class ChatGPTDesktopAdapter {
  private server?: Server
  private connection?: ReturnType<typeof publishConnection>
  private sessions = new Map<string, ChatGPTDesktopSession>()
  private recent = new Map<string, AutoAgentEvent[]>()
  private revocations = new Map<string, number>()
  private seen = new Map<string, { digest: string; at: number }>()
  private prepared = new Map<string, NativeContinuation>()
  private continuationAcks = new Map<string, (claimed: boolean) => void>()
  private pendingStops = new Map<string, { revision: number; deadline: number; wake: () => void }>()
  private submitted = new Map<
    string,
    NativeContinuation & { external?: boolean; sawModel?: boolean }
  >()
  private chains = new Map<string, Promise<unknown>>()
  private stopped = false
  private instanceId = randomUUID()
  private now: () => number

  constructor(private options: ChatGPTDesktopAdapterOptions) {
    this.now = options.now ?? Date.now
  }

  async start(input: { connectionDirectory: string }) {
    if (this.server) throw new Error('AUTO_WORK_ALREADY_STARTED')
    const token = randomUUID() + randomUUID()
    const expected = createHash('sha256').update(token).digest()
    const server = createServer((request, response) => {
      void this.http(request, response, expected).catch(() =>
        this.reply(response, 500, { error: 'HOOK_UNAVAILABLE' }),
      )
    })
    server.requestTimeout = 5000
    server.headersTimeout = 3000
    server.keepAliveTimeout = 500
    server.maxConnections = 16
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('AUTO_WORK_LISTEN_FAILED')
    const url = `http://127.0.0.1:${address.port}`
    try {
      this.connection = publishConnection(input.connectionDirectory, url, token)
    } catch (error) {
      server.close()
      throw error
    }
    this.server = server
    this.stopped = false
    return { url, connectionPath: this.connection.path }
  }

  prepareContinuation(action: NativeContinuation): boolean {
    const session = this.sessions.get(action.sessionId)
    if (
      this.stopped ||
      !this.options.claimContinuation ||
      !session ||
      (session.state !== 'running' && !this.hasPendingStop(action.sessionId)) ||
      session.turnId !== action.turnId ||
      session.revision !== action.eventRevision ||
      !action.reason.trim() ||
      Buffer.byteLength(action.reason) > 8192 ||
      !Number.isFinite(Date.parse(action.expiresAt)) ||
      Date.parse(action.expiresAt) <= this.now() ||
      this.submitted.has(action.sessionId) ||
      this.prepared.has(action.sessionId)
    )
      return false
    this.prepared.set(action.sessionId, structuredClone(action))
    this.pendingStops.get(action.sessionId)?.wake()
    return true
  }

  /** False means the Stop handler definitively did not claim this offer. No timer infers delivery. */
  async prepareAndWaitContinuation(action: NativeContinuation): Promise<boolean> {
    if (!this.hasPendingStop(action.sessionId)) return false
    if (this.continuationAcks.has(action.actionId)) throw new Error('CONTINUATION_ALREADY_WAITING')
    let settle = (_claimed: boolean) => {}
    const ack = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    this.continuationAcks.set(action.actionId, settle)
    try {
      if (!this.prepareContinuation(action)) return false
      return await ack
    } finally {
      this.continuationAcks.delete(action.actionId)
    }
  }

  private settleContinuation(action: NativeContinuation | undefined, claimed: boolean) {
    if (action) this.continuationAcks.get(action.actionId)?.(claimed)
  }

  hasPendingStop(sessionId: string): boolean {
    const pending = this.pendingStops.get(sessionId)
    return (
      !this.stopped &&
      !!pending &&
      pending.deadline > this.now() &&
      this.sessions.get(sessionId)?.revision === pending.revision
    )
  }

  invalidate(sessionId: string) {
    this.revocations.set(sessionId, (this.revocations.get(sessionId) ?? 0) + 1)
    this.settleContinuation(this.prepared.get(sessionId), false)
    this.prepared.delete(sessionId)
    const pending = this.pendingStops.get(sessionId)
    this.pendingStops.delete(sessionId)
    pending?.wake()
  }
  expectExternalMessage(action: NativeContinuation): boolean {
    const session = this.sessions.get(action.sessionId)
    if (
      this.stopped ||
      !session ||
      session.state === 'closed' ||
      session.revision !== action.eventRevision ||
      this.submitted.has(action.sessionId) ||
      Date.parse(action.expiresAt) <= this.now() ||
      !action.reason.includes(`[Coloop Auto Agent Work:${action.actionId}]`)
    )
      return false
    this.settleContinuation(this.prepared.get(action.sessionId), false)
    this.prepared.delete(action.sessionId)
    this.submitted.set(action.sessionId, { ...structuredClone(action), external: true })
    return true
  }
  /** Explicit draft recovery may renew only the same owned message. The caller
   * must prove the draft and absent send receipt before invoking Enter. */
  renewExternalMessage(
    action: NativeContinuation,
    original: { nativeSessionId: string; workspace: string },
  ): boolean {
    const session = this.sessions.get(action.sessionId)
    const workspace = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
    if (
      this.stopped ||
      !session ||
      session.state !== 'idle' ||
      session.sessionId !== original.nativeSessionId ||
      workspace(session.workspace) !== workspace(original.workspace) ||
      session.turnId !== action.turnId ||
      session.revision !== action.eventRevision ||
      !Number.isFinite(Date.parse(action.expiresAt)) ||
      Date.parse(action.expiresAt) <= this.now() ||
      !action.reason.startsWith(`[Coloop Auto Agent Work:${action.actionId}]\n`)
    )
      return false
    const previous = this.submitted.get(action.sessionId)
    if (
      previous &&
      (!previous.external ||
        previous.actionId !== action.actionId ||
        previous.reason !== action.reason ||
        previous.turnId !== action.turnId ||
        previous.taskVersion > action.taskVersion)
    )
      return false
    if (
      [...this.submitted.values()].some(
        (item) => item.actionId === action.actionId && item.sessionId !== action.sessionId,
      )
    )
      return false
    if (!previous) return this.expectExternalMessage(action)
    this.submitted.set(action.sessionId, { ...structuredClone(action), external: true })
    return true
  }
  forgetExternalMessage(actionId: string) {
    for (const [key, action] of this.submitted)
      if (action.external && action.actionId === actionId) this.submitted.delete(key)
  }
  stop() {
    this.stopped = true
    for (const action of this.prepared.values()) this.settleContinuation(action, false)
    this.prepared.clear()
    for (const pending of this.pendingStops.values()) pending.wake()
    this.pendingStops.clear()
    this.options.onChange?.()
  }
  resume() {
    this.stopped = false
  }
  snapshot() {
    return {
      connected: !!this.server,
      stopped: this.stopped,
      sessions: [...this.sessions.values()].map((x) => structuredClone(x)),
    }
  }
  events(sessionId: string): AutoAgentEvent[] {
    return structuredClone(this.recent.get(sessionId) ?? [])
  }

  receive(input: unknown): Promise<HookOutput> {
    // A user takeover must revoke a pending Stop before waiting behind its serialized callback.
    const incoming = wireSchema.safeParse(input)
    if (
      incoming.success &&
      ['UserPromptSubmit', 'Interrupt', 'SessionEnd'].includes(
        incoming.data.payload.hook_event_name,
      )
    ) {
      for (const session of this.sessions.values())
        if (
          session.sessionId === incoming.data.payload.session_id &&
          session.workspace.toLowerCase() === incoming.data.payload.cwd.toLowerCase()
        )
          this.invalidate(session.id)
    }
    const key = incoming.success ? incoming.data.payload.session_id : '__invalid__'
    const next = (this.chains.get(key) ?? Promise.resolve()).then(() => this.receiveOne(input))
    const settled = next.catch(() => {})
    this.chains.set(key, settled)
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
    return next
  }

  private async receiveOne(input: unknown): Promise<HookOutput> {
    const wire = wireSchema.parse(input)
    const now = this.now()
    if (Math.abs(now - wire.emittedAt) > 15_000) throw new Error('STALE_HOOK_EVENT')
    const digest = createHash('sha256').update(JSON.stringify(wire)).digest('hex')
    const previous = this.seen.get(wire.invocationId)
    if (previous) {
      if (previous.digest !== digest) throw new Error('HOOK_EVENT_CONFLICT')
      // Never repeat a Stop control response after a lost HTTP response.
      return {}
    }
    for (const [key, value] of this.seen) if (now - value.at > 60_000) this.seen.delete(key)
    if (this.seen.size >= 2048) throw new Error('HOOK_EVENT_CAPACITY')
    const payload = wire.payload
    const workspace = await this.trustedWorkspace(payload.cwd)
    const handle = `chatgpt-desktop:${this.instanceId}:${createHash('sha256').update(payload.session_id).digest('hex').slice(0, 32)}`
    let session = this.sessions.get(handle)
    if (session && session.workspace !== workspace) throw new Error('HOOK_WORKSPACE_CHANGED')
    if (!session) {
      if (this.sessions.size >= 64) throw new Error('HOOK_SESSION_CAPACITY')
      session = {
        id: handle,
        source: 'chatgpt-desktop',
        instanceId: this.instanceId,
        sessionId: payload.session_id,
        title: 'ChatGPT / Codex 原生会话（桌面未验收）',
        workspace,
        state: 'idle',
        revision: 0,
        lastSeenAt: new Date(now).toISOString(),
        desktopVerified: false,
        capabilities: {
          events: 'available',
          nativeContinue: 'unknown',
          reply: 'unknown',
          stop: 'unsupported',
          desktopWrite: 'unknown',
        },
      }
      this.sessions.set(session.id, session)
    }
    this.seen.set(wire.invocationId, { digest, at: now })
    const priorRevision = session.revision
    const priorTurn = session.turnId
    session.revision++
    session.lastSeenAt = new Date(now).toISOString()
    // Subagent hooks carry the parent session ID. They must not change the parent's turn or state.
    const child = !!payload.agent_id || payload.hook_event_name.startsWith('Subagent')
    if (!child && payload.turn_id) session.turnId = payload.turn_id
    const kind = payload.hook_event_name
    let ownedActionId: string | undefined
    const pending = this.submitted.get(session.id)
    if (
      !child &&
      pending &&
      !pending.external &&
      payload.turn_id === pending.turnId &&
      kind === 'PreModelRequest'
    )
      pending.sawModel = true
    if (
      !child &&
      pending &&
      !pending.external &&
      pending.sawModel &&
      payload.turn_id === pending.turnId &&
      kind === 'Stop' &&
      payload.stop_hook_active === true
    ) {
      // Real 0.166 CLI continues in the same turn without UserPromptSubmit. This confirms resumed
      // execution, not the business outcome; the subsequent Stop still requires task acceptance.
      ownedActionId = pending.actionId
      this.submitted.delete(session.id)
      session.capabilities.nativeContinue = 'verified'
      this.options.onNativeContinuation?.({ ...pending, status: 'confirmed' })
    }
    if (
      !child &&
      kind === 'UserPromptSubmit' &&
      pending &&
      Date.parse(pending.expiresAt) > now &&
      // The desktop composer appends one LF to an otherwise exact submitted
      // draft. Preserve every original character and the registered UUID;
      // never trim whitespace or normalize internal line breaks for ownership.
      (payload.prompt === pending.reason ||
        (pending.external === true && payload.prompt === pending.reason + '\n'))
    ) {
      ownedActionId = pending.actionId
      this.submitted.delete(session.id)
      if (!pending.external) session.capabilities.nativeContinue = 'verified'
      else session.capabilities.desktopWrite = 'verified'
      this.options.onNativeContinuation?.({ ...pending, status: 'confirmed' })
    }
    if (!child) {
      if (
        kind === 'UserPromptSubmit' ||
        kind === 'Interrupt' ||
        kind === 'SessionEnd' ||
        (priorTurn && payload.turn_id && priorTurn !== payload.turn_id)
      )
        this.invalidate(session.id)
      if (kind === 'Stop') {
        session.state = 'idle'
        if (session.capabilities.nativeContinue !== 'verified')
          session.capabilities.nativeContinue = 'available'
      } else if (kind === 'Interrupt') session.state = 'idle'
      else if (kind === 'SessionEnd') session.state = 'closed'
      else if (kind === 'PermissionRequest') session.state = 'awaiting_input'
      else if (['UserPromptSubmit', 'PreToolUse', 'PreModelRequest'].includes(kind))
        session.state = 'running'
    }
    const safePayload = { ...payload, cwd: workspace }
    for (const field of ['prompt', 'last_assistant_message', 'error'] as const) {
      if (typeof safePayload[field] === 'string')
        safePayload[field] = sanitizeHookText(safePayload[field]!)
    }
    for (const field of ['tool_input', 'tool_response'] as const) {
      if (safePayload[field] !== undefined)
        safePayload[field] = sanitizeHookText(JSON.stringify(safePayload[field])).slice(0, 16384)
    }
    const eventType: AutoAgentEvent['type'] = child
      ? 'progress'
      : kind === 'SessionStart'
        ? 'started'
        : kind === 'SessionEnd'
          ? 'closed'
          : kind === 'UserPromptSubmit'
            ? ownedActionId
              ? 'receipt'
              : 'user_input'
            : kind === 'Stop'
              ? 'stopped'
              : kind === 'Interrupt'
                ? 'interrupted'
                : kind === 'PermissionRequest'
                  ? 'question'
                  : kind === 'PostModelRequest' && payload.status === 'failed'
                    ? 'error'
                    : 'progress'
    const event: ChatGPTDesktopEvent = {
      id: wire.invocationId,
      sessionId: session.id,
      instanceId: this.instanceId,
      turnId: payload.turn_id,
      workspace,
      nativeName: kind,
      revision: session.revision,
      at: session.lastSeenAt,
      payload: safePayload,
      ownedActionId,
      type: eventType,
      questionKind: kind === 'PermissionRequest' ? 'approval' : undefined,
      agentId: payload.agent_id,
      actionId: ownedActionId,
      origin: ownedActionId ? 'coloop' : kind === 'UserPromptSubmit' ? 'user' : 'agent',
      text:
        safePayload.prompt ??
        safePayload.last_assistant_message ??
        safePayload.error ??
        (safePayload.tool_response !== undefined
            ? JSON.stringify(safePayload.tool_response, null, 2)
          : safePayload.tool_input !== undefined
              ? JSON.stringify(safePayload.tool_input, null, 2)
            : kind),
      evidence: [`native_hook:${kind}`, 'desktop_runtime_not_verified'],
    }
    let output: HookOutput = {}
    let wake = () => {}
    const pendingReady = new Promise<void>((resolve) => {
      wake = resolve
    })
    const isStop = !child && kind === 'Stop'
    if (isStop)
      this.pendingStops.set(session.id, {
        revision: session.revision,
        deadline: this.now() + 250,
        wake,
      })
    const {
      payload: _payload,
      nativeName: _nativeName,
      workspace: _workspace,
      ownedActionId: _owned,
      ...publicEvent
    } = event
    this.recent.set(session.id, [...(this.recent.get(session.id) ?? []), publicEvent].slice(-60))
    this.options.onEvent(event, structuredClone(session))
    this.options.onChange?.()
    if (isStop && !this.prepared.has(session.id) && this.hasPendingStop(session.id)) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        pendingReady,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250)
        }),
      ])
      if (timer) clearTimeout(timer)
    }
    const pendingStop = this.pendingStops.get(session.id)
    const action = this.prepared.get(session.id)
    const generation = this.revocations.get(session.id) ?? 0
    if (!child && kind === 'Stop') {
      this.pendingStops.delete(session.id)
      this.prepared.delete(session.id)
      if (
        !this.stopped &&
        pendingStop &&
        pendingStop.deadline >= this.now() &&
        action &&
        !this.submitted.has(session.id) &&
        action.turnId === payload.turn_id &&
        (action.eventRevision === priorRevision || action.eventRevision === session.revision) &&
        Date.parse(action.expiresAt) > this.now()
      ) {
        let claimed: boolean
        try {
          claimed =
            (await this.options.claimContinuation?.(structuredClone(action), event)) === true
        } catch {
          // A failing reservation callback may already have persisted ownership. Never replay it.
          this.settleContinuation(action, true)
          this.options.onNativeContinuation?.({ ...action, status: 'unknown' })
          return {}
        }
        if (!claimed) {
          this.settleContinuation(action, false)
          return {}
        }
        this.settleContinuation(action, true)
        if (
          this.stopped ||
          generation !== (this.revocations.get(session.id) ?? 0) ||
          !pendingStop ||
          this.now() > pendingStop.deadline + 100
        ) {
          this.options.onNativeContinuation?.({ ...action, status: 'unknown' })
          return {}
        }
        this.submitted.set(session.id, action)
        // Persisted reservation precedes output. If transport is lost, callers must reconcile, not replay.
        this.options.onNativeContinuation?.({ ...action, status: 'submitted' })
        output = { decision: 'block', reason: action.reason }
      } else {
        this.settleContinuation(action, false)
      }
    }
    return output
  }

  private async trustedWorkspace(value: string) {
    if (!isAbsolute(value)) throw new Error('UNTRUSTED_WORKSPACE')
    const candidate = await realpath(value)
    for (const root of this.options.workspaceRoots()) {
      try {
        const canonical = await realpath(root)
        const inside = relative(canonical, candidate)
        if (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))
          return candidate
      } catch {
        /* Unavailable roots cannot grant access. */
      }
    }
    throw new Error('UNTRUSTED_WORKSPACE')
  }

  private reply(response: ServerResponse, status: number, value: unknown) {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'close',
    })
    response.end(JSON.stringify(value))
  }
  private async http(request: IncomingMessage, response: ServerResponse, expected: Buffer) {
    if (
      request.headers.origin !== undefined ||
      Object.keys(request.headers).some((key) => key.startsWith('sec-fetch-'))
    ) {
      this.reply(response, 403, { error: 'BROWSER_ORIGIN_REJECTED' })
      return
    }
    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') && auth.length < 1024 ? auth.slice(7) : ''
    if (!token || !timingSafeEqual(expected, createHash('sha256').update(token).digest())) {
      this.reply(response, 401, { error: 'UNAUTHORIZED' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/auto-work/hooks') {
      this.reply(response, 404, { error: 'NOT_FOUND' })
      return
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') ||
      request.headers['content-encoding']
    ) {
      this.reply(response, 415, { error: 'JSON_REQUIRED' })
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(() => request.destroy(), 3000)
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > 65_536) {
          this.reply(response, 413, { error: 'REQUEST_TOO_LARGE' })
          request.resume()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      const output = await this.receive(parseStrictJson(text))
      this.reply(response, 200, { version: 1, output })
    } catch {
      this.reply(response, 400, { error: 'INVALID_HOOK_EVENT' })
    } finally {
      clearTimeout(timer)
    }
  }

  async dispose() {
    this.stop()
    this.connection?.remove()
    this.connection = undefined
    const server = this.server
    this.server = undefined
    if (server) {
      const done = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await done
    }
    await Promise.allSettled(this.chains.values())
    for (const action of this.submitted.values())
      this.options.onNativeContinuation?.({ ...action, status: 'unknown' })
    this.submitted.clear()
  }
}
