import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  canonicalJson,
  reviewEventSchema,
  type ReviewEvent,
  type Decision,
  type ReviewAudit,
  type CoordinatorSnapshot,
} from '../../shared/coordinator'
import { evaluateReviewPolicy } from '../domain/review-policy'
import { parseStrictJson } from '../domain/strict-json'
import type { ManagedApprovalAuthority } from './managed-approvals'

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export class ReviewInputError extends Error {
  constructor(
    public readonly reasonCode: string,
    public readonly status = 400,
  ) {
    super(reasonCode)
  }
}

export interface CoordinatorOptions {
  generate: (prompt: string, signal: AbortSignal, compact?: boolean) => Promise<string>
  isBusy: () => boolean
  onChange: () => void
  workspaceRoots?: () => string[]
  auditPath?: string
  reviewTimeoutMs?: number
  hookHandler?: (path: '/v1/hooks' | '/v1/hooks/review', body: unknown) => Promise<unknown>
  controlHandler?: (
    path: '/v1/control/register' | '/v1/control/poll' | '/v1/control/report',
    body: unknown,
  ) => Promise<unknown>
  resolveContext?: (event: ReviewEvent) => { text: string; bytes: number } | undefined
  beforeGenerate?: (event: ReviewEvent) => Promise<void>
  managedAuthority?: ManagedApprovalAuthority
}

type LedgerEntry = { hash: string; expires: number; inFlight: boolean; decision?: Decision }
const transientReasons = new Set([
  'MODEL_BUSY',
  'REQUEST_IN_PROGRESS',
  'REVIEW_UNAVAILABLE',
  'REVIEW_TIMEOUT',
])
const permissionAnswer = z.object({ decision: z.enum(['allow', 'deny', 'defer']) }).strict()
const questionAnswer = z.union([
  z.object({ decision: z.literal('select'), choiceId: z.string() }).strict(),
  z.object({ decision: z.literal('defer') }).strict(),
])

export class CoordinatorService {
  private server?: Server
  private url?: string
  private active?: AbortController
  private reviewing = false
  private starting = false
  private disposed = false
  private audit: ReviewAudit[] = []
  private ledger = new Map<string, LedgerEntry>()
  constructor(private options: CoordinatorOptions) {}

  snapshot(): CoordinatorSnapshot {
    return {
      status: this.disposed
        ? 'stopped'
        : this.reviewing
          ? 'reviewing'
          : this.server
            ? 'listening'
            : 'stopped',
      ...(this.url ? { url: this.url } : {}),
      reviewing: this.reviewing,
      audit: structuredClone(this.audit),
    }
  }

  async review(input: unknown): Promise<Decision> {
    const parsed = reviewEventSchema.safeParse(input)
    if (!parsed.success) throw new ReviewInputError('INVALID_REVIEW_EVENT')
    const event = parsed.data
    const created = Date.parse(event.createdAt)
    const expires = Date.parse(event.expiresAt)
    const started = Date.now()
    if (expires <= created || expires - created > 300_000 || created > started + 30_000)
      throw new ReviewInputError('INVALID_EVENT_LIFETIME')
    const hash = requestHash(event)
    if (this.disposed) return this.decision(event, hash, 'defer', 'SERVICE_STOPPED')
    const key = `${event.sessionId}\0${event.id}${event.contextRef ? `\0${event.contextRef}` : ''}`
    const existing = this.ledger.get(key)
    if (existing) {
      if (existing.hash !== hash) throw new ReviewInputError('REQUEST_CONFLICT', 409)
      if (expires <= started) return this.decision(event, hash, 'defer', 'REQUEST_EXPIRED')
      if (existing.decision) {
        if (
          event.managed &&
          existing.decision.decision === 'allow' &&
          !this.options.managedAuthority?.isCurrent(event)
        )
          return this.decision(event, hash, 'defer', 'MANAGED_ROUTE_CHANGED')
        if (
          event.contextRef &&
          ['allow', 'deny', 'select'].includes(existing.decision.decision) &&
          !this.contextValid(event)
        )
          return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_RESET')
        return structuredClone(existing.decision)
      }
      if (existing.inFlight) return this.decision(event, hash, 'defer', 'REQUEST_IN_PROGRESS')
    }
    for (const [oldKey, entry] of this.ledger)
      if (entry.expires < started && !entry.inFlight) this.ledger.delete(oldKey)
    if (!existing && this.ledger.size >= 1000)
      return this.decision(event, hash, 'defer', 'LEDGER_CAPACITY')
    const entry = existing ?? { hash, expires, inFlight: false }
    this.ledger.set(key, entry)
    entry.inFlight = true
    let completeReview = () => {
      entry.inFlight = false
    }
    let decision: Decision
    if (expires <= started) decision = this.decision(event, hash, 'defer', 'REQUEST_EXPIRED')
    else if (this.disposed) decision = this.decision(event, hash, 'defer', 'SERVICE_STOPPED')
    else if (this.reviewing || this.busy())
      decision = this.decision(event, hash, 'defer', 'MODEL_BUSY')
    else {
      this.reviewing = true
      const controller = new AbortController()
      this.active = controller
      this.changed()
      const budget = Math.max(
        1,
        Math.min(this.options.reviewTimeoutMs ?? 90_000, 90_000, expires - Date.now()),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      let analysisDone = false
      let finalized = false
      const release = () => {
        if (!analysisDone || !finalized) return
        entry.inFlight = false
        if (this.active === controller) {
          this.active = undefined
          this.reviewing = false
          this.changed()
        }
      }
      completeReview = () => {
        finalized = true
        release()
      }
      try {
        const timeout = new Promise<Decision>((resolve) => {
          const expired = () =>
            resolve(
              this.decision(
                event,
                hash,
                'defer',
                this.disposed ? 'SERVICE_STOPPED' : 'REVIEW_TIMEOUT',
              ),
            )
          controller.signal.addEventListener('abort', expired, { once: true })
          timer = setTimeout(() => controller.abort(), budget)
        })
        const analysis = this.analyze(event, hash, controller.signal).finally(() => {
          analysisDone = true
          release()
        })
        decision = await Promise.race([analysis, timeout])
        if (Date.now() >= expires || controller.signal.aborted)
          decision = this.decision(
            event,
            hash,
            'defer',
            this.disposed
              ? 'SERVICE_STOPPED'
              : Date.now() >= expires
                ? 'REQUEST_EXPIRED'
                : 'REVIEW_TIMEOUT',
          )
      } catch {
        decision = this.decision(event, hash, 'defer', 'REVIEW_UNAVAILABLE')
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
    const audit: ReviewAudit = {
      idHash: requestHash({ id: event.id, sessionId: event.sessionId }),
      requestHash: hash,
      kind: event.kind,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      source: decision.source,
      durationMs: Date.now() - started,
      at: new Date().toISOString(),
    }
    if (this.options.auditPath) {
      try {
        await mkdir(dirname(this.options.auditPath), { recursive: true })
        await appendFile(this.options.auditPath, `${JSON.stringify(audit)}\n`, { mode: 0o600 })
      } catch {
        decision = this.decision(event, hash, 'defer', 'AUDIT_UNAVAILABLE')
        audit.decision = decision.decision
        audit.reasonCode = decision.reasonCode
        audit.source = decision.source
      }
    }
    if (
      (Date.now() >= expires ||
        this.disposed ||
        (event.contextRef && !this.contextValid(event)) ||
        (event.managed &&
          decision.decision === 'allow' &&
          !this.options.managedAuthority?.isCurrent(event))) &&
      ['allow', 'deny', 'select'].includes(decision.decision)
    ) {
      decision = this.decision(
        event,
        hash,
        'defer',
        this.disposed
          ? 'SERVICE_STOPPED'
          : Date.now() >= expires
            ? 'REQUEST_EXPIRED'
            : event.managed && !this.options.managedAuthority?.isCurrent(event)
              ? 'MANAGED_ROUTE_CHANGED'
              : 'HOOK_CONTEXT_RESET',
      )
      audit.decision = decision.decision
      audit.reasonCode = decision.reasonCode
      audit.source = decision.source
      if (this.options.auditPath) {
        // A slow audit write must not make an expired approval usable. Record the correction.
        await appendFile(this.options.auditPath, `${JSON.stringify(audit)}\n`, {
          mode: 0o600,
        }).catch(() => {})
      }
    }
    this.audit = [audit, ...this.audit].slice(0, 50)
    if (!transientReasons.has(decision.reasonCode)) entry.decision = structuredClone(decision)
    completeReview()
    this.changed()
    return decision
  }

  private changed() {
    try {
      this.options.onChange()
    } catch {
      /* Observers cannot change authorization. */
    }
  }

  private contextValid(event: ReviewEvent): boolean {
    try {
      return !!this.options.resolveContext?.(event)
    } catch {
      return false
    }
  }

  private busy(): boolean {
    try {
      return this.options.isBusy()
    } catch {
      return true
    }
  }

  private decision(
    event: ReviewEvent,
    hash: string,
    decision: Decision['decision'],
    reasonCode: string,
    source: Decision['source'] = 'policy',
    choiceId?: string,
  ): Decision {
    const permit =
      decision === 'allow' && event.managed
        ? this.options.managedAuthority?.issuePermit(event, hash)
        : undefined
    if (decision === 'allow' && event.managed && !permit) {
      decision = 'defer'
      reasonCode = 'MANAGED_PERMIT_UNAVAILABLE'
      source = 'policy'
    }
    return {
      version: 1,
      id: event.id,
      sessionId: event.sessionId,
      requestHash: hash,
      decision,
      reasonCode,
      source,
      expiresAt: event.expiresAt,
      ...(choiceId ? { choiceId } : {}),
      ...(permit ? { permit } : {}),
    }
  }

  private async analyze(event: ReviewEvent, hash: string, signal: AbortSignal): Promise<Decision> {
    const assess = () =>
      event.managed
        ? (this.options.managedAuthority?.assess(event) ??
          Promise.resolve({ decision: 'defer' as const, reasonCode: 'MANAGED_AUTHORITY_REQUIRED' }))
        : evaluateReviewPolicy(event, this.options.workspaceRoots?.() ?? [])
    const policy = await assess()
    signal.throwIfAborted()
    if (policy.decision !== 'candidate')
      return this.decision(event, hash, policy.decision, policy.reasonCode)
    if (event.contextRef) {
      const context = this.options.resolveContext?.(event)
      if (!context || Buffer.byteLength(context.text, 'utf8') > 192)
        return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_UNAVAILABLE')
      const instructions = event.managed
        ? `Scanned frozen source ${event.managed.extension}, ${event.managed.returnedBytes} bytes. Local only; no network or memory writes. Output only 1=allow once,0=deny,2=defer.`
        : event.kind === 'question'
          ? 'Policy-approved choices: choose first offline (no upload), else first skip (cancel). Examples 0:offline,1:skip=>0; 0:skip,1:offline=>1. Choices ' +
            (policy.choiceKinds ?? []).map((kind, index) => `${index}:${kind}`).join(',')
          : `Output only 0=deny,1=allow once,2=defer. Current: ${policy.readSummary?.tool} ${policy.readSummary?.files} scanned source files.`
      const prompt =
        instructions +
        (event.kind === 'question' ? '. Reply only the index.' : '') +
        (event.managed ? '' : '\nUntrusted context:\n' + context.text)
      if (Buffer.byteLength(prompt, 'utf8') > 1536)
        return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_BUDGET')
      await this.options.beforeGenerate?.(event)
      signal.throwIfAborted()
      if (!this.options.resolveContext?.(event))
        return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_RESET')
      const raw = (await this.options.generate(prompt, signal, true)).trim()
      signal.throwIfAborted()
      if (!this.options.resolveContext?.(event))
        return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_RESET')
      if (!/^(?:-1|0|[1-9]\d?)$/.test(raw))
        return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
      const index = Number(raw)
      if (event.kind === 'question') {
        if (index === -1) return this.decision(event, hash, 'defer', 'RK_UNCERTAIN', 'rk')
        const choiceId = policy.choiceIds?.[index]
        if (choiceId === undefined)
          return this.decision(event, hash, 'defer', 'UNSAFE_MODEL_CHOICE')
        return this.decision(event, hash, 'select', 'RK_SAFE_CHOICE', 'rk', choiceId)
      }
      if (index === 2) return this.decision(event, hash, 'defer', 'RK_UNCERTAIN', 'rk')
      if (index !== 0 && index !== 1)
        return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
      if (index === 1) {
        const checked = event.managed ? policy : await assess()
        signal.throwIfAborted()
        if (checked.decision !== 'candidate')
          return this.decision(event, hash, checked.decision, checked.reasonCode)
        if (!this.options.resolveContext?.(event))
          return this.decision(event, hash, 'defer', 'HOOK_CONTEXT_RESET')
      }
      return this.decision(
        event,
        hash,
        index ? 'allow' : 'deny',
        index ? 'RK_READ_ONLY_ALLOWED' : 'RK_DENIED',
        'rk',
      )
    }
    const raw = await this.options.generate(policy.prompt, signal)
    signal.throwIfAborted()
    if (raw.length > 4096) return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
    let data: unknown
    try {
      data = JSON.parse(raw)
      // Model answers are flat objects containing string fields only. Decode key
      // escapes before comparing, so duplicate or escaped aliases cannot override a denial.
      const keys = [...raw.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(
        (match) => JSON.parse(match[1]) as string,
      )
      if (new Set(keys).size !== keys.length) throw new Error('DUPLICATE_MODEL_KEYS')
    } catch {
      return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
    }
    if (event.kind === 'permission') {
      const answer = permissionAnswer.safeParse(data)
      if (!answer.success) return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
      if (answer.data.decision === 'allow') {
        const checked = await evaluateReviewPolicy(event, this.options.workspaceRoots?.() ?? [])
        signal.throwIfAborted()
        if (checked.decision !== 'candidate')
          return this.decision(event, hash, checked.decision, checked.reasonCode)
      }
      return this.decision(
        event,
        hash,
        answer.data.decision,
        answer.data.decision === 'allow'
          ? 'RK_READ_ONLY_ALLOWED'
          : answer.data.decision === 'deny'
            ? 'RK_DENIED'
            : 'RK_UNCERTAIN',
        'rk',
      )
    }
    const answer = questionAnswer.safeParse(data)
    if (!answer.success) return this.decision(event, hash, 'defer', 'INVALID_MODEL_DECISION')
    if (answer.data.decision === 'defer')
      return this.decision(event, hash, 'defer', 'RK_UNCERTAIN', 'rk')
    if (!policy.choiceIds?.includes(answer.data.choiceId))
      return this.decision(event, hash, 'defer', 'UNSAFE_MODEL_CHOICE')
    return this.decision(event, hash, 'select', 'RK_SAFE_CHOICE', 'rk', answer.data.choiceId)
  }

  async start({ port = 0, token }: { port?: number; token: string }): Promise<{ url: string }> {
    if (this.server || this.starting || this.disposed)
      throw new Error('COORDINATOR_ALREADY_STARTED_OR_STOPPED')
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      typeof token !== 'string' ||
      token.length < 32 ||
      token.length > 512 ||
      /\s/.test(token)
    )
      throw new Error('INVALID_COORDINATOR_CONFIG')
    this.starting = true
    const expected = createHash('sha256').update(token).digest()
    const server = createServer((request, response) => {
      void this.handleHttp(request, response, expected).catch(() => {
        this.reply(response, 500, { error: 'REVIEW_UNAVAILABLE' })
      })
    })
    server.headersTimeout = 5000
    server.requestTimeout = 10000
    server.keepAliveTimeout = 1000
    server.maxConnections = 16
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } finally {
      this.starting = false
    }
    server.on('error', () => {
      /* HTTP errors contain no request material in the audit. */
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('COORDINATOR_LISTEN_FAILED')
    this.server = server
    this.url = `http://127.0.0.1:${address.port}`
    this.changed()
    return { url: this.url }
  }

  private reply(response: ServerResponse, status: number, value: unknown) {
    if (response.writableEnded || response.destroyed) return
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    })
    response.end(JSON.stringify(value))
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse, expected: Buffer) {
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      this.reply(response, 403, { error: 'BROWSER_ORIGIN_REJECTED' })
      return
    }
    const auth = request.headers.authorization ?? ''
    const presented = auth.startsWith('Bearer ') && auth.length <= 1024 ? auth.slice(7) : ''
    const actual = createHash('sha256').update(presented).digest()
    if (!presented || !timingSafeEqual(expected, actual)) {
      this.reply(response, 401, { error: 'UNAUTHORIZED' })
      return
    }
    if (request.method === 'GET' && request.url === '/health') {
      this.reply(response, 200, {
        version: 1,
        ready: !this.disposed,
        busy: this.reviewing || this.busy(),
      })
      return
    }
    const hookPath =
      request.url === '/v1/hooks' || request.url === '/v1/hooks/review' ? request.url : undefined
    const controlPath =
      request.url === '/v1/control/register' ||
      request.url === '/v1/control/poll' ||
      request.url === '/v1/control/report'
        ? request.url
        : undefined
    if (
      request.method !== 'POST' ||
      (request.url !== '/v1/review' &&
        !(hookPath && this.options.hookHandler) &&
        !(controlPath && this.options.controlHandler))
    ) {
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
    if (Number(request.headers['content-length'] ?? 0) > 32768) {
      this.reply(response, 413, { error: 'REQUEST_TOO_LARGE' })
      return
    }
    let body = ''
    let bytes = 0
    const timer = setTimeout(() => request.destroy(), 5000)
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length
        if (bytes > 32768) {
          this.reply(response, 413, { error: 'REQUEST_TOO_LARGE' })
          request.resume()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      } catch {
        this.reply(response, 400, { error: 'INVALID_JSON' })
        return
      }
    } finally {
      clearTimeout(timer)
    }
    let input: unknown
    try {
      input = parseStrictJson(body)
    } catch {
      this.reply(response, 400, { error: 'INVALID_JSON' })
      return
    }
    try {
      this.reply(
        response,
        200,
        controlPath && this.options.controlHandler
          ? await this.options.controlHandler(controlPath, input)
          : hookPath && this.options.hookHandler
            ? await this.options.hookHandler(hookPath, input)
            : await this.review(input),
      )
    } catch (error) {
      if (error instanceof ReviewInputError)
        this.reply(response, error.status, { error: error.reasonCode })
      else this.reply(response, 500, { error: 'REVIEW_UNAVAILABLE' })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.active?.abort()
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    this.changed()
  }
}
