import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { canonicalJson, type Decision, type ReviewEvent } from '../../shared/coordinator'
import {
  hookEnvelopeSchema,
  type HookEnvelope,
  type HookReceipt,
  type HookReviewResponse,
  type HookSnapshot,
} from '../../shared/hooks'
import { requestHash, ReviewInputError } from './coordinator'

const MAX_SCOPES = 32
const MAX_EVENTS = 16
const MAX_SCOPE_BYTES = 8192
const MAX_TOTAL_BYTES = 262144
const MAX_CONTEXT_BYTES = 192
const MAX_PROJECTED_EVENTS = 4
const MAX_PROJECTED_BODY_BYTES = 64
const CONTEXT_TTL = 300_000
const APPROVAL_TTL = 180_000
const transient = new Set([
  'MODEL_BUSY',
  'REQUEST_IN_PROGRESS',
  'REVIEW_UNAVAILABLE',
  'REVIEW_TIMEOUT',
])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')

/** Telemetry is untrusted evidence, never a source of authority or durable memory. */
export function sanitizeHookText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,
      '[REDACTED_KEY]',
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})/gi, '[REDACTED_TOKEN]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED_AUTH]@')
    .replace(
      /(?<!\w)((?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|token|authorization|client[_-]?secret|secret|密码|口令)\s*["']?\s*[=:：]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:(?:Basic|Bearer)\s+)?[^\s,;，；}{]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]')
    .replace(/(?<!\d)\d{17}[\dX](?!\d)/gi, '[REDACTED_ID]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

type ContextLine = {
  text: string
  summary: string
  kind: HookEnvelope['kind']
  bodyOffset?: number
  bodyOmitted?: boolean
  part?: string
}
type Seen = { hash: string; receivedAt: string; generation: number; receipt: HookReceipt }
type Scope = {
  key: string
  sourceId: string
  instanceId: string
  sessionId: string
  taskId: string
  workspace: string
  sequence: number
  updated: number
  generation: number
  lines: ContextLine[]
  seen: Map<string, Seen>
  state: string
  lastKind: HookEnvelope['kind']
  lastReceivedAt: string
  active: boolean
  leaseReady: Promise<void>
  leaseAt: number
}
type ContextSnapshot = {
  text: string
  bytes: number
  events: number
  scope: string
  generation: number
  expires: number
  eventHash: string
}
type Approval = {
  sourceEventId: string
  originalDigest: string
  reviewEvent: ReviewEvent
  contextRef: string
  scope: string
  generation: number
  storedBytes: number
  response?: HookReviewResponse
  pending?: Promise<HookReviewResponse>
}
type Accepted = { event: HookEnvelope; scope: Scope; seen: Seen; duplicate: boolean }

export interface AgentHookOptions {
  review: (event: ReviewEvent) => Promise<Decision>
  workspaceRoots: () => string[]
  onChange: () => void
  onActivity?: (leaseId: string, active: boolean) => Promise<void>
  managedCurrent?: (event: ReviewEvent) => boolean
}

export class AgentHookService {
  private scopes = new Map<string, Scope>()
  private tombstones = new Map<
    string,
    { sequence: number; generation: number; workspace: string; closed: boolean }
  >()
  private approvals = new Map<string, Approval>()
  private retiredApprovals = new Map<string, string>()
  private contexts = new Map<string, ContextSnapshot>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  private counts = {
    receivedEvents: 0,
    duplicateEvents: 0,
    rejectedEvents: 0,
    droppedEvents: 0,
    activityErrors: 0,
  }
  private metrics: HookSnapshot['metrics'] = []
  private timer: ReturnType<typeof setInterval>
  constructor(private options: AgentHookOptions) {
    this.timer = setInterval(() => this.sweep(), 30_000)
    this.timer.unref()
  }

  private notify() {
    try {
      this.options.onChange()
    } catch {
      /* Observers cannot authorize. */
    }
  }
  private error(reason: string, status = 409): never {
    this.counts.rejectedEvents++
    throw new ReviewInputError(reason, status)
  }
  private queued<T>(action: () => Promise<T>): Promise<T> {
    const result = this.chain.then(action)
    this.chain = result.catch(() => {})
    return result
  }
  private scopeBytes(scope: Scope) {
    return scope.lines.reduce((total, line) => total + bytes(line.text) + 1, 0)
  }
  private totalBytes() {
    return (
      [...this.scopes.values()].reduce((total, scope) => total + this.scopeBytes(scope), 0) +
      [...this.contexts.values()].reduce((total, context) => total + context.bytes, 0) +
      [...this.approvals.values()].reduce((total, approval) => total + approval.storedBytes, 0)
    )
  }
  private lease(scope: Scope, active: boolean) {
    if (scope.active === active && (!active || Date.now() - scope.leaseAt < 30_000))
      return scope.leaseReady
    scope.active = active
    scope.leaseAt = Date.now()
    const work = scope.leaseReady
      .catch(() => {})
      .then(() => this.options.onActivity?.(`hook-${scope.key}`, active))
      .then(() => {})
    scope.leaseReady = work
    void work.catch(() => {
      if (active) scope.active = false
      this.counts.activityErrors++
      this.notify()
    })
    return work
  }
  private invalidate(scope: Scope) {
    scope.generation++
    scope.lines = []
    for (const [key, context] of this.contexts)
      if (context.scope === scope.key) this.contexts.delete(key)
  }
  private retireCompleted(scope: Scope, event: HookEnvelope) {
    if (
      event.kind !== 'status' ||
      event.payload.state !== 'approval.completed' ||
      !event.payload.relatedEventId ||
      !event.payload.originalDigest
    )
      return
    for (const [key, approval] of this.approvals) {
      if (
        approval.scope !== scope.key ||
        approval.generation !== scope.generation ||
        approval.sourceEventId !== event.payload.relatedEventId ||
        approval.originalDigest !== event.payload.originalDigest
      )
        continue
      this.contexts.delete(approval.contextRef)
      this.approvals.delete(key)
      this.retiredApprovals.set(key, approval.originalDigest)
    }
  }
  private evict(scope: Scope, permanentlyClosed = false) {
    this.invalidate(scope)
    this.scopes.delete(scope.key)
    this.tombstones.set(scope.key, {
      sequence: scope.sequence,
      generation: scope.generation,
      workspace: scope.workspace,
      closed: permanentlyClosed,
    })
    void this.lease(scope, false).catch(() => {})
  }
  private sweep() {
    const now = Date.now()
    for (const scope of this.scopes.values())
      if (now - scope.updated >= CONTEXT_TTL) this.evict(scope)
    for (const [key, approval] of this.approvals) {
      if (Date.parse(approval.reviewEvent.expiresAt) <= now && !approval.pending) {
        this.contexts.delete(approval.contextRef)
        this.approvals.delete(key)
        this.retiredApprovals.set(key, approval.originalDigest)
      }
    }
  }
  private compact(scope: Scope) {
    const selected: string[] = []
    let used = 0
    const observations = scope.lines.filter((line) => line.kind !== 'approval')
    for (const line of [...(observations.length ? observations : scope.lines)].reverse()) {
      if (selected.length >= MAX_PROJECTED_EVENTS) break
      // The metadata was constructed at ingestion from schema fields. Do not infer
      // facts from arbitrary message/tool JSON, and never cut a path or negation.
      const body = line.bodyOffset === undefined ? undefined : line.text.slice(line.bodyOffset)
      const omitted = body !== undefined || line.bodyOmitted
      const metadata = line.summary + (omitted ? ' [body omitted]' : '')
      let projected =
        body !== undefined && bytes(body) <= MAX_PROJECTED_BODY_BYTES
          ? `${line.summary}: ${body}`
          : metadata
      if (used + bytes(projected) + (selected.length ? 1 : 0) > MAX_CONTEXT_BYTES)
        projected = metadata
      const size = bytes(projected) + (selected.length ? 1 : 0)
      if (used + size <= MAX_CONTEXT_BYTES) {
        selected.unshift(projected)
        used += size
      }
    }
    return { text: selected.join('\n'), bytes: used, events: selected.length }
  }
  private append(scope: Scope, event: HookEnvelope) {
    const payload = event.payload
    const summary = `${event.kind}${payload.tool ? ` ${payload.tool}` : ''}${payload.state ? ` ${payload.state}` : ''}`
    let text = summary
    let bodyOffset: number | undefined
    let bodyOmitted = false
    if (payload.text) {
      bodyOffset = summary.length + 2
      text += `: ${sanitizeHookText(payload.text)}`
    }
    if (bytes(text) + 1 > MAX_SCOPE_BYTES) {
      text = `${summary} [OMITTED_OVER_BUDGET]`
      bodyOffset = undefined
      bodyOmitted = true
      this.counts.droppedEvents++
    }
    const part =
      event.kind === 'message' && payload.messageId && payload.partId
        ? `${payload.role ?? 'unknown'}\0${payload.messageId}\0${payload.partId}`
        : undefined
    if (part) scope.lines = scope.lines.filter((line) => line.part !== part)
    scope.lines.push({
      text,
      summary,
      kind: event.kind,
      bodyOffset,
      bodyOmitted,
      ...(part ? { part } : {}),
    })
    while (scope.lines.length > MAX_EVENTS || this.scopeBytes(scope) > MAX_SCOPE_BYTES) {
      scope.lines.shift()
      this.counts.droppedEvents++
    }
    while (this.totalBytes() > MAX_TOTAL_BYTES) {
      const oldest = [...this.scopes.values()]
        .filter((value) => value.lines.length)
        .sort((a, b) => a.updated - b.updated)[0]
      if (!oldest) break
      oldest.lines.shift()
      this.counts.droppedEvents++
    }
  }

  private async accept(input: unknown): Promise<Accepted> {
    if (this.stopped) this.error('HOOK_SERVICE_STOPPED', 503)
    const parsed = hookEnvelopeSchema.safeParse(input)
    if (!parsed.success) this.error('INVALID_HOOK_EVENT', 400)
    const event = parsed.data
    if (bytes(canonicalJson(event)) > 32768) this.error('HOOK_EVENT_TOO_LARGE', 413)
    this.sweep()
    if (!isAbsolute(event.workspace) || /[\x00-\x1f]/.test(event.workspace))
      this.error('INVALID_WORKSPACE', 400)
    let workspace: string
    let trusted = false
    try {
      workspace = await realpath(event.workspace)
      if (!(await stat(workspace)).isDirectory()) this.error('INVALID_WORKSPACE', 400)
      for (const root of this.options.workspaceRoots()) {
        if (!isAbsolute(root)) continue
        try {
          const inside = relative(await realpath(root), workspace)
          if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
            trusted = true
        } catch {
          /* An unavailable root cannot authorize. */
        }
      }
    } catch {
      this.error('HOOK_WORKSPACE_UNAVAILABLE', 400)
    }
    if (!trusted) this.error('UNTRUSTED_WORKSPACE', 403)
    if (this.stopped) this.error('HOOK_SERVICE_STOPPED', 503)
    const key = requestHash({
      source: event.source,
      sourceId: event.sourceId,
      instanceId: event.instanceId,
      sessionId: event.sessionId,
      taskId: event.taskId,
    })
    const tombstone = this.tombstones.get(key)
    if (tombstone?.closed) this.error('HOOK_SCOPE_CLOSED')
    let scope = this.scopes.get(key)
    if (!scope) {
      if (!tombstone && this.tombstones.size >= 1024) this.error('HOOK_SCOPE_CAPACITY', 429)
      if (tombstone && event.sequence <= tombstone.sequence) this.error('HOOK_SEQUENCE_STALE')
      if (tombstone && tombstone.workspace !== workspace) this.error('HOOK_WORKSPACE_CHANGED')
      if (this.scopes.size >= MAX_SCOPES) {
        const oldest = [...this.scopes.values()].sort((a, b) => a.updated - b.updated)[0]
        this.evict(oldest)
      }
      scope = {
        key,
        sourceId: event.sourceId,
        instanceId: event.instanceId,
        sessionId: event.sessionId,
        taskId: event.taskId,
        workspace,
        sequence: tombstone?.sequence ?? 0,
        updated: Date.now(),
        generation: tombstone?.generation ?? 0,
        lines: [],
        seen: new Map(),
        state: 'idle',
        lastKind: event.kind,
        lastReceivedAt: '',
        active: false,
        leaseReady: Promise.resolve(),
        leaseAt: 0,
      }
      this.scopes.set(key, scope)
      this.tombstones.delete(key)
    }
    if (scope.workspace !== workspace) this.error('HOOK_WORKSPACE_CHANGED')
    const hash = requestHash(event)
    const previous = scope.seen.get(event.eventId)
    if (previous) {
      if (previous.hash !== hash) this.error('HOOK_EVENT_CONFLICT')
      this.counts.duplicateEvents++
      return { event, scope, seen: previous, duplicate: true }
    }
    if (event.sequence <= scope.sequence) this.error('HOOK_SEQUENCE_STALE')
    const receivedAt = new Date().toISOString()
    scope.sequence = event.sequence
    scope.updated = Date.now()
    scope.lastReceivedAt = receivedAt
    scope.lastKind = event.kind
    if (event.kind === 'compacted' || event.kind === 'closed') {
      this.invalidate(scope)
      scope.state = event.kind
    } else {
      if (event.kind === 'status' && payloadIdle(event.payload.state)) scope.state = 'idle'
      else if (
        event.kind !== 'status' ||
        event.payload.state === 'busy' ||
        event.payload.state === 'running'
      )
        scope.state = 'busy'
      this.append(scope, event)
    }
    this.retireCompleted(scope, event)
    const receipt: HookReceipt = {
      version: 1,
      sourceId: event.sourceId,
      instanceId: event.instanceId,
      eventId: event.eventId,
      sequence: event.sequence,
      receivedAt,
      duplicate: false,
      contextBytes: this.scopeBytes(scope),
      contextEvents: scope.lines.length,
    }
    const seen: Seen = { hash, receivedAt, generation: scope.generation, receipt }
    scope.seen.set(event.eventId, seen)
    while (scope.seen.size > 64) scope.seen.delete(scope.seen.keys().next().value!)
    this.counts.receivedEvents++
    if (event.payload.metrics) {
      this.metrics = [
        {
          scopeId: key,
          receivedAt,
          state: event.payload.state ?? event.kind,
          ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          ...(event.payload.source ? { source: event.payload.source } : {}),
          ...(event.payload.reasonCode ? { reasonCode: event.payload.reasonCode } : {}),
          ...event.payload.metrics,
        },
        ...this.metrics,
      ].slice(0, 50)
    }
    if (event.kind === 'closed') this.evict(scope, true)
    else if (event.kind !== 'approval')
      void this.lease(scope, scope.state !== 'idle').catch(() => {})
    this.notify()
    return { event, scope, seen, duplicate: false }
  }

  async ingest(input: unknown): Promise<HookReceipt> {
    const value = await this.queued(() => this.accept(input))
    return { ...value.seen.receipt, duplicate: value.duplicate }
  }

  async reviewHook(input: unknown): Promise<HookReviewResponse> {
    const started = performance.now()
    const accepted = await this.queued(() => this.accept(input))
    const { event, scope, seen } = accepted
    const original = event.payload.approval
    if (event.kind !== 'approval' || !original) this.error('HOOK_APPROVAL_REQUIRED', 400)
    const key = `${scope.key}\0${original.kind}\0${original.id}`
    const retired = this.retiredApprovals.get(key)
    if (retired) {
      if (retired !== original.originalDigest) this.error('HOOK_APPROVAL_CHANGED')
      this.error('HOOK_APPROVAL_EXPIRED', 410)
    }
    let approval = this.approvals.get(key)
    if (approval && approval.originalDigest !== original.originalDigest)
      this.error('HOOK_APPROVAL_CHANGED')
    if (!approval) {
      if (this.approvals.size + this.retiredApprovals.size >= 1000)
        this.error('HOOK_APPROVAL_CAPACITY', 429)
      const context = this.compact(scope)
      const createdAt = seen.receivedAt
      const contextRef = requestHash({
        scope: scope.key,
        generation: seen.generation,
        event: seen.hash,
        createdAt,
        context: context.text,
      })
      const { originalDigest: _digest, ...fields } = original
      const reviewEvent: ReviewEvent = {
        version: 1,
        ...fields,
        workspace: scope.workspace,
        contextRef,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + APPROVAL_TTL).toISOString(),
      }
      const storedBytes = bytes(canonicalJson(reviewEvent)) + bytes(event.eventId)
      if (this.totalBytes() + context.bytes + storedBytes > MAX_TOTAL_BYTES)
        this.error('HOOK_CONTEXT_CAPACITY', 429)
      approval = {
        sourceEventId: event.eventId,
        originalDigest: original.originalDigest,
        reviewEvent,
        contextRef,
        scope: scope.key,
        generation: seen.generation,
        storedBytes,
      }
      this.approvals.set(key, approval)
      this.contexts.set(contextRef, {
        ...context,
        scope: scope.key,
        generation: seen.generation,
        expires: Date.parse(reviewEvent.expiresAt),
        eventHash: requestHash(reviewEvent),
      })
    }
    const binding = (response: HookReviewResponse): HookReviewResponse => {
      let reasonCode: string | undefined
      if (!this.valid(approval)) reasonCode = 'HOOK_CONTEXT_RESET'
      else if (approval.reviewEvent.managed && response.decision.decision === 'allow') {
        try {
          if (this.options.managedCurrent?.(approval.reviewEvent) !== true)
            reasonCode = 'MANAGED_ROUTE_CHANGED'
        } catch {
          reasonCode = 'MANAGED_ROUTE_CHANGED'
        }
      }
      return {
        ...structuredClone(response),
        eventId: event.eventId,
        sequence: event.sequence,
        ...(reasonCode ? { decision: this.deferred(approval, reasonCode) } : {}),
      }
    }
    if (!this.valid(approval)) {
      return {
        version: 1,
        sourceId: event.sourceId,
        instanceId: event.instanceId,
        eventId: event.eventId,
        sequence: event.sequence,
        originalDigest: approval.originalDigest,
        reviewEvent: structuredClone(approval.reviewEvent),
        decision: this.deferred(approval, 'HOOK_CONTEXT_RESET'),
        metrics: {
          receiveMs: performance.now() - started,
          decisionMs: 0,
          totalMs: performance.now() - started,
          contextBytes: 0,
          contextEvents: 0,
        },
      }
    }
    if (approval.pending) return binding(await approval.pending)
    if (approval.response && !transient.has(approval.response.decision.reasonCode))
      return binding(approval.response)
    const current = approval
    const receiveMs = performance.now() - started
    current.pending = (async () => {
      const decisionStart = performance.now()
      let decision: Decision
      try {
        if (!this.valid(current)) decision = this.deferred(current, 'HOOK_CONTEXT_RESET')
        else decision = await this.options.review(current.reviewEvent)
      } catch {
        decision = this.deferred(current, 'REVIEW_UNAVAILABLE')
      }
      if (!this.valid(current)) decision = this.deferred(current, 'HOOK_CONTEXT_RESET')
      const context = this.contexts.get(current.contextRef)
      const response: HookReviewResponse = {
        version: 1,
        sourceId: event.sourceId,
        instanceId: event.instanceId,
        eventId: event.eventId,
        sequence: event.sequence,
        originalDigest: current.originalDigest,
        reviewEvent: structuredClone(current.reviewEvent),
        decision,
        metrics: {
          receiveMs,
          decisionMs: performance.now() - decisionStart,
          totalMs: performance.now() - started,
          contextBytes: current.reviewEvent.managed ? 0 : (context?.bytes ?? 0),
          contextEvents: current.reviewEvent.managed ? 0 : (context?.events ?? 0),
        },
      }
      current.response = response
      return response
    })()
    try {
      return binding(await current.pending)
    } finally {
      current.pending = undefined
    }
  }

  private valid(approval: Approval) {
    const scope = this.scopes.get(approval.scope)
    return (
      !this.stopped &&
      !!scope &&
      scope.generation === approval.generation &&
      Date.now() < Date.parse(approval.reviewEvent.expiresAt) &&
      this.contexts.has(approval.contextRef)
    )
  }
  private deferred(approval: Approval, reasonCode: string): Decision {
    return {
      version: 1,
      id: approval.reviewEvent.id,
      sessionId: approval.reviewEvent.sessionId,
      requestHash: requestHash(approval.reviewEvent),
      decision: 'defer',
      reasonCode,
      source: 'policy',
      expiresAt: approval.reviewEvent.expiresAt,
    }
  }
  resolveContext(event: ReviewEvent): { text: string; bytes: number; events: number } | undefined {
    this.sweep()
    if (this.stopped || !event.contextRef) return undefined
    const context = this.contexts.get(event.contextRef)
    if (
      !context ||
      context.eventHash !== requestHash(event) ||
      Date.now() >= context.expires ||
      this.scopes.get(context.scope)?.generation !== context.generation
    )
      return undefined
    return { text: context.text, bytes: context.bytes, events: context.events }
  }
  resolveOrigin(event: ReviewEvent) {
    if (!this.resolveContext(event) || !event.contextRef) return undefined
    const context = this.contexts.get(event.contextRef)!
    const scope = this.scopes.get(context.scope)
    return (
      scope && {
        sourceId: scope.sourceId,
        instanceId: scope.instanceId,
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        workspace: scope.workspace,
      }
    )
  }
  async prepareReview(event: ReviewEvent): Promise<void> {
    if (!event.contextRef || !this.resolveContext(event)) this.error('HOOK_CONTEXT_RESET')
    const context = this.contexts.get(event.contextRef)!
    const scope = this.scopes.get(context.scope)
    if (!scope || scope.generation !== context.generation) this.error('HOOK_CONTEXT_RESET')
    await this.lease(scope, true)
    if (!this.resolveContext(event)) this.error('HOOK_CONTEXT_RESET')
  }
  snapshot(preferContent = false): HookSnapshot {
    this.sweep()
    return {
      status: this.stopped ? 'stopped' : 'ready',
      sessionCount: this.scopes.size,
      contextBytes: this.totalBytes(),
      ...this.counts,
      sessions: [...this.scopes.values()]
        .sort((a, b) => b.updated - a.updated)
        .map((scope) => {
          const latest = [...scope.lines].reverse()
          const content = preferContent
            ? (latest.find(
                (line) =>
                  line.kind === 'message' &&
                  line.part?.startsWith('assistant\0') &&
                  line.bodyOffset !== undefined,
              ) ??
              latest.find(
                (line) =>
                  (line.kind === 'message' || line.kind === 'tool.after') &&
                  line.bodyOffset !== undefined,
              ))
            : undefined
          const excerpt = preferContent
            ? content?.bodyOffset !== undefined
              ? content.text.slice(content.bodyOffset)
              : undefined
            : scope.lines.at(-1)?.text
          return {
            scopeId: scope.key,
            sourceId: scope.sourceId,
            instanceIdHash: sha(scope.instanceId),
            sessionIdHash: sha(scope.sessionId),
            taskIdHash: sha(scope.taskId),
            state: scope.state,
            lastKind: scope.lastKind,
            lastReceivedAt: scope.lastReceivedAt,
            contextBytes: this.scopeBytes(scope),
            contextEvents: scope.lines.length,
            ...(excerpt ? { excerpt: Array.from(excerpt).slice(0, 200).join('') } : {}),
          }
        }),
      metrics: structuredClone(this.metrics),
    }
  }
  async dispose() {
    this.stopped = true
    clearInterval(this.timer)
    await this.chain
    const scopes = [...this.scopes.values()]
    for (const scope of scopes) this.evict(scope)
    await Promise.all(scopes.map((scope) => scope.leaseReady.catch(() => {})))
    this.contexts.clear()
    this.approvals.clear()
    this.retiredApprovals.clear()
    this.metrics = []
    this.notify()
  }
}

function payloadIdle(state?: string) {
  return state === 'idle' || state === 'closed' || state === 'error'
}
