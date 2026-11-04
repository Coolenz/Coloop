import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { canonicalJson } from '../../shared/coordinator'
import { hookEnvelopeSchema, type HookEnvelope, type HookSnapshot } from '../../shared/hooks'
import {
  sessionCommandSchema,
  sessionPollSchema,
  sessionRegisterSchema,
  sessionReportSchema,
  type CommandSnapshot,
  type CommandStatus,
  type SessionCommandInput,
  type SessionControlSnapshot,
  type SessionRegistration,
  type SessionSnapshot,
  type SessionState,
  type SessionWireCommand,
} from '../../shared/sessions'

export const SESSION_OFFLINE_MS = 90_000
export const SESSION_COMMAND_TTL_MS = 60_000
const MAX_SESSIONS = 64
const MAX_COMMANDS = 10_000
const MAX_PENDING = 256
const MAX_RETIRED = 4096
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const commandSnapshotSchema = z
  .object({
    commandId: z.string().uuid(),
    sessionHandle: z.string().uuid(),
    action: z.enum(['send_message', 'abort_turn']),
    status: z.enum([
      'queued',
      'dispatched',
      'accepted',
      'confirmed',
      'failed',
      'unknown',
      'cancelled',
      'expired',
    ]),
    messageId: z.string().min(1).max(128).optional(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    controlResolved: z.boolean().optional(),
  })
  .strict()
const journalSchema = z
  .object({
    version: z.literal(1),
    stopped: z.boolean(),
    commands: z
      .array(
        z
          .object({
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            snapshot: commandSnapshotSchema,
          })
          .strict(),
      )
      .max(MAX_COMMANDS + MAX_SESSIONS),
  })
  .strict()
interface Command {
  fingerprint: string
  snapshot: CommandSnapshot
  text?: string
  session?: Session
  sawRunning: boolean
  messageObserved: boolean
  dispatchedAt?: number
}
interface Session {
  registration: SessionRegistration
  handle: string
  route: string
  lastSeen: number
  offline: boolean
  retired: boolean
  state: SessionState
  controlActive: boolean
  controlStartedAt?: string
  stopping: boolean
  activeSend?: string
  activeAbort?: string
  sequences: Map<string, number>
}
export interface SessionControlOptions {
  workspaceRoots: () => string[]
  onChange: () => void
  journalPath?: string
  now?: () => number
}
export class SessionControlError extends Error {
  constructor(
    public readonly reasonCode: string,
    public readonly status = 400,
  ) {
    super(reasonCode)
  }
}

/** A bounded outbox. Native identifiers and prompt bodies never enter its public snapshot/journal. */
export class SessionControlService {
  private sessions = new Map<string, Session>()
  private routes = new Map<string, Session>()
  private retired = new Set<string>()
  private commands = new Map<string, Command>()
  private chain: Promise<void> = Promise.resolve()
  private stopped = false
  private closing = false
  private disposed = false
  private journalError?: string
  private timer: ReturnType<typeof setInterval>
  constructor(private options: SessionControlOptions) {
    this.restore()
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000)
    this.timer.unref?.()
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private date(value = this.now()) {
    return new Date(value).toISOString()
  }
  private fail(code: string, status = 409): never {
    throw new SessionControlError(code, status)
  }
  private run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closing || this.disposed)
      return Promise.reject(new SessionControlError('CONTROL_SERVICE_STOPPED', 503))
    const work = this.chain.then(() => {
      if (this.disposed) this.fail('CONTROL_SERVICE_STOPPED', 503)
      return operation()
    })
    this.chain = work.then(
      () => {},
      () => {},
    )
    return work
  }
  private notify() {
    this.options.onChange()
  }
  private identity(value: { source: string; sourceId: string; sessionId: string }) {
    return `${value.source}\0${value.sourceId}\0${value.sessionId}`
  }
  private instance(value: {
    source: string
    sourceId: string
    sessionId: string
    instanceId: string
  }) {
    return `${this.identity(value)}\0${value.instanceId}`
  }
  private connected(session: Session) {
    return (
      !session.offline &&
      !session.retired &&
      this.now() - session.lastSeen < SESSION_OFFLINE_MS &&
      session.state !== 'closed'
    )
  }
  private restore() {
    const file = this.options.journalPath
    if (!file || !existsSync(file)) return
    try {
      if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > MAX_JOURNAL_BYTES)
        throw new Error('INVALID_JOURNAL')
      const data = journalSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      this.stopped = data.stopped
      for (const row of data.commands) {
        if (this.commands.has(row.snapshot.commandId)) throw new Error('DUPLICATE_COMMAND')
        const snapshot: CommandSnapshot = { ...row.snapshot }
        if (
          !snapshot.controlResolved &&
          ['queued', 'dispatched', 'accepted', 'confirmed'].includes(snapshot.status)
        ) {
          snapshot.status = 'unknown'
          snapshot.errorCode = 'CONTROL_RESTARTED'
          snapshot.updatedAt = this.date()
        }
        this.commands.set(snapshot.commandId, {
          fingerprint: row.fingerprint,
          snapshot,
          sawRunning: false,
          messageObserved: false,
        })
      }
      // Persist the interrupted status before accepting any new control writes.
      this.save()
    } catch {
      // Keep a damaged ledger intact: starting a fresh one would lose replay protection.
      this.stopped = true
      this.journalError = 'CONTROL_JOURNAL_UNAVAILABLE'
    }
  }
  private save() {
    const file = this.options.journalPath
    if (!file) return
    if (this.journalError) this.fail(this.journalError, 503)
    const temporary = `${file}.${randomUUID()}.pending`
    let fd: number | undefined
    try {
      const directory = dirname(file)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (
        lstatSync(directory).isSymbolicLink() ||
        (existsSync(file) && lstatSync(file).isSymbolicLink())
      )
        throw new Error('INVALID_JOURNAL')
      const raw = JSON.stringify({
        version: 1,
        stopped: this.stopped,
        commands: [...this.commands.values()].map(({ fingerprint, snapshot }) => ({
          fingerprint,
          snapshot,
        })),
      })
      if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) throw new Error('JOURNAL_LIMIT')
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, raw, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, file)
    } catch {
      this.journalError = 'CONTROL_JOURNAL_UNAVAILABLE'
      this.stopped = true
      this.fail(this.journalError, 503)
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(temporary)
      } catch {
        /* A successful rename leaves no temporary file. */
      }
    }
  }
  private saveBestEffort() {
    try {
      this.save()
    } catch {
      // Emergency abort remains available even if persistence fails.
    }
  }
  private transition(command: Command, status: CommandStatus, errorCode?: string) {
    command.snapshot.status = status
    command.snapshot.updatedAt = this.date()
    command.snapshot.errorCode = errorCode
    if (status !== 'queued') command.text = undefined
  }
  private clearControl(session: Session) {
    session.controlActive = false
    session.stopping = false
    session.controlStartedAt = undefined
    session.activeSend = undefined
    session.activeAbort = undefined
    for (const command of this.commands.values())
      if (command.session === session) command.snapshot.controlResolved = true
  }
  private invalidate(session: Session, reason: string) {
    let changed = false
    session.offline = true
    for (const command of this.commands.values()) {
      if (command.session !== session) continue
      if (command.snapshot.status === 'queued') {
        this.transition(command, 'cancelled', reason)
        changed = true
      } else if (['dispatched', 'accepted'].includes(command.snapshot.status)) {
        this.transition(command, 'unknown', reason)
        changed = true
      }
    }
    return changed
  }
  private sweep() {
    let changed = false
    for (const session of this.sessions.values()) {
      if (!session.offline && this.now() - session.lastSeen >= SESSION_OFFLINE_MS) {
        this.invalidate(session, 'SOURCE_OFFLINE')
        changed = true
      }
    }
    for (const command of this.commands.values()) {
      if (Date.parse(command.snapshot.expiresAt) > this.now()) continue
      if (command.snapshot.status === 'queued') {
        this.transition(command, 'expired', 'COMMAND_EXPIRED')
        changed = true
      } else if (['dispatched', 'accepted'].includes(command.snapshot.status)) {
        this.transition(command, 'unknown', 'COMMAND_EXPIRED')
        changed = true
      }
    }
    if (changed) this.saveBestEffort()
    return changed
  }
  private async trustedWorkspace(workspace: string) {
    if (!isAbsolute(workspace)) this.fail('INVALID_WORKSPACE', 400)
    let canonical: string
    try {
      canonical = await realpath(workspace)
      if (!(await stat(canonical)).isDirectory()) this.fail('INVALID_WORKSPACE', 400)
    } catch {
      this.fail('WORKSPACE_UNAVAILABLE', 400)
    }
    for (const root of this.options.workspaceRoots()) {
      if (!isAbsolute(root)) continue
      try {
        const inside = relative(await realpath(root), canonical)
        if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
          return canonical
      } catch {
        /* An unavailable root cannot grant control. */
      }
    }
    this.fail('UNTRUSTED_WORKSPACE', 403)
  }
  private publicSession(session: Session): SessionSnapshot {
    const { registration } = session
    return {
      handle: session.handle,
      source: registration.source,
      sourceId: registration.sourceId,
      host: registration.host,
      title: registration.title ?? 'OpenCode',
      workspace: registration.workspace,
      state: session.state,
      connected: this.connected(session),
      capabilities: [...registration.capabilities],
      controlActive: session.controlActive,
      ...(session.controlStartedAt ? { controlStartedAt: session.controlStartedAt } : {}),
      stopping: session.stopping,
      lastSeenAt: this.date(session.lastSeen),
    }
  }
  async register(input: unknown): Promise<{ version: 1; sessionHandle: string }> {
    return this.run(async () => {
      const parsed = sessionRegisterSchema.safeParse(input)
      if (!parsed.success) this.fail('INVALID_SESSION_REGISTRATION', 400)
      this.sweep()
      const registration = { ...parsed.data }
      registration.workspace = await this.trustedWorkspace(registration.workspace)
      const instanceKey = this.instance(registration)
      if (this.retired.has(instanceKey)) this.fail('STALE_INSTANCE')
      const route = this.identity(registration)
      let session = this.routes.get(route)
      if (session && session.registration.instanceId !== registration.instanceId) {
        if (this.retired.size >= MAX_RETIRED) this.fail('INSTANCE_CAPACITY', 429)
        this.retired.add(this.instance(session.registration))
        this.invalidate(session, 'INSTANCE_REPLACED')
        session.retired = true
        session = undefined
      }
      if (session) {
        if (
          session.registration.workspace !== registration.workspace ||
          session.registration.host !== registration.host
        )
          this.fail('SESSION_REGISTRATION_CHANGED')
        if (session.state === 'closed') this.fail('SESSION_CLOSED')
        session.registration = registration
        session.lastSeen = this.now()
        session.offline = false
        // Heartbeat snapshots can be older than native turn events.
        // A non-idle snapshot is nevertheless sufficient to revoke an unsent
        // request: sending it later could interrupt a new local user task.
        const queuedSend = session.activeSend ? this.commands.get(session.activeSend) : undefined
        if (queuedSend?.snapshot.status === 'queued' && registration.state !== 'idle') {
          session.state = registration.state
          this.transition(queuedSend, 'cancelled', 'SOURCE_BECAME_BUSY')
          this.clearControl(session)
        } else if (!session.controlActive) session.state = registration.state
      } else {
        if (this.sessions.size >= MAX_SESSIONS) this.fail('SESSION_CAPACITY', 429)
        session = {
          registration,
          handle: randomUUID(),
          route,
          lastSeen: this.now(),
          offline: false,
          retired: false,
          state: registration.state,
          controlActive: false,
          stopping: false,
          sequences: new Map(),
        }
        this.sessions.set(session.handle, session)
        this.routes.set(route, session)
      }
      this.saveBestEffort()
      this.notify()
      return { version: 1, sessionHandle: session.handle }
    })
  }
  private makeCommand(input: SessionCommandInput, session: Session) {
    const fingerprint = createHash('sha256').update(canonicalJson(input)).digest('hex')
    const snapshot: CommandSnapshot = {
      commandId: input.commandId,
      sessionHandle: session.handle,
      action: input.action,
      status: 'queued',
      ...(input.action === 'send_message'
        ? { messageId: `msg_${randomUUID().replaceAll('-', '')}` }
        : {}),
      createdAt: this.date(),
      expiresAt: this.date(this.now() + SESSION_COMMAND_TTL_MS),
      updatedAt: this.date(),
      controlResolved: false,
    }
    const command: Command = {
      fingerprint,
      snapshot,
      session,
      text: input.text,
      sawRunning: false,
      messageObserved: false,
    }
    this.commands.set(input.commandId, command)
    return command
  }
  private capacity() {
    if (this.commands.size >= MAX_COMMANDS) this.fail('COMMAND_LEDGER_FULL', 429)
    const pending = [...this.commands.values()].filter((command) =>
      ['queued', 'dispatched', 'accepted'].includes(command.snapshot.status),
    ).length
    if (pending >= MAX_PENDING) this.fail('COMMAND_QUEUE_FULL', 429)
  }
  async submit(input: unknown): Promise<CommandSnapshot> {
    return this.run(() => {
      const parsed = sessionCommandSchema.safeParse(input)
      if (!parsed.success) this.fail('INVALID_SESSION_COMMAND', 400)
      const request = parsed.data
      this.sweep()
      const previous = this.commands.get(request.commandId)
      if (previous) {
        const fingerprint = createHash('sha256').update(canonicalJson(request)).digest('hex')
        if (previous.fingerprint !== fingerprint) this.fail('COMMAND_CONFLICT')
        return structuredClone(previous.snapshot)
      }
      const session = this.sessions.get(request.sessionHandle)
      if (!session) this.fail('SESSION_NOT_FOUND', 404)
      if (!this.connected(session)) this.fail('SOURCE_OFFLINE')
      if (!session.registration.capabilities.includes(request.action))
        this.fail('UNSUPPORTED_CAPABILITY')
      if (request.action === 'send_message') {
        if (this.stopped) this.fail('CONTROL_STOPPED')
        if (this.journalError) this.fail(this.journalError, 503)
        if (session.registration.host !== 'windows') this.fail('WINDOWS_SESSION_REQUIRED', 403)
        if (session.controlActive || session.state !== 'idle') this.fail('SESSION_BUSY')
      } else if (!session.controlActive) this.fail('SESSION_NOT_CONTROLLED')
      this.capacity()
      if (request.action === 'abort_turn') this.cancelQueuedSends(session)
      const command = this.makeCommand(request, session)
      if (request.action === 'send_message') {
        session.controlActive = true
        session.controlStartedAt = this.date()
        session.activeSend = request.commandId
      } else {
        session.stopping = true
        session.activeAbort = request.commandId
      }
      if (request.action === 'abort_turn') this.saveBestEffort()
      else this.save()
      this.notify()
      return structuredClone(command.snapshot)
    })
  }
  async poll(input: unknown): Promise<{ version: 1; commands: SessionWireCommand[] }> {
    return this.run(() => {
      const parsed = sessionPollSchema.safeParse(input)
      if (!parsed.success) this.fail('INVALID_CONTROL_POLL', 400)
      this.sweep()
      const owner = parsed.data
      const sessions = [...this.sessions.values()].filter(
        (session) =>
          session.registration.source === owner.source &&
          session.registration.sourceId === owner.sourceId &&
          session.registration.instanceId === owner.instanceId &&
          !session.retired,
      )
      if (!sessions.length) this.fail('STALE_INSTANCE')
      // Poll is also a source heartbeat, but it cannot revive an expired source.
      for (const session of sessions) if (this.connected(session)) session.lastSeen = this.now()
      const result: SessionWireCommand[] = []
      let changed = false
      const busy = new Set(
        [...this.commands.values()]
          .filter((command) => ['dispatched', 'accepted'].includes(command.snapshot.status))
          .map((command) => command.snapshot.sessionHandle),
      )
      // Abort supersedes an ambiguous/ongoing send without resending that send.
      const queued = [...this.commands.values()]
        .filter((command) => command.snapshot.status === 'queued')
        .sort(
          (a, b) =>
            Number(b.snapshot.action === 'abort_turn') - Number(a.snapshot.action === 'abort_turn'),
        )
      for (const command of queued) {
        const session = command.session
        if (!session || !sessions.includes(session)) continue
        if (command.snapshot.action === 'send_message' && session.state !== 'idle') {
          this.transition(command, 'cancelled', 'SOURCE_BECAME_BUSY')
          this.clearControl(session)
          changed = true
          continue
        }
        if (!this.connected(session)) continue
        if (!session.registration.capabilities.includes(command.snapshot.action)) {
          this.transition(command, 'failed', 'UNSUPPORTED_CAPABILITY')
          if (command.snapshot.action === 'send_message' && !session.stopping)
            this.clearControl(session)
          changed = true
          continue
        }
        if (command.snapshot.action === 'send_message' && (this.stopped || this.journalError))
          continue
        if (busy.has(session.handle)) {
          if (command.snapshot.action !== 'abort_turn') continue
          for (const previous of this.commands.values())
            if (
              previous.session === session &&
              previous.snapshot.action === 'send_message' &&
              ['dispatched', 'accepted'].includes(previous.snapshot.status)
            )
              this.transition(previous, 'unknown', 'STOP_REQUESTED')
          if (
            [...this.commands.values()].some(
              (previous) =>
                previous.session === session &&
                previous.snapshot.action === 'abort_turn' &&
                ['dispatched', 'accepted'].includes(previous.snapshot.status),
            )
          )
            continue
        }
        const wire: SessionWireCommand = {
          commandId: command.snapshot.commandId,
          sessionId: session.registration.sessionId,
          instanceId: session.registration.instanceId,
          action: command.snapshot.action,
          ...(command.text !== undefined ? { text: command.text } : {}),
          ...(command.snapshot.messageId ? { messageId: command.snapshot.messageId } : {}),
          expiresAt: command.snapshot.expiresAt,
        }
        this.transition(command, 'dispatched')
        command.dispatchedAt = this.now()
        result.push(wire)
        busy.add(session.handle)
        if (result.length === 8) break
      }
      if (result.length || changed) {
        // A send is committed before delivery. A lost HTTP response is not retried.
        if (result.some((command) => command.action === 'send_message')) this.save()
        else this.saveBestEffort()
        this.notify()
      }
      return { version: 1, commands: result }
    })
  }
  /** Re-check immediately before the host releases a collected command to its source. */
  canDeliver(commandId: string): boolean {
    const command = this.commands.get(commandId)
    const session = command?.session
    if (
      this.disposed ||
      !command ||
      !session ||
      command.snapshot.status !== 'dispatched' ||
      !this.connected(session) ||
      this.routes.get(session.route) !== session
    )
      return false
    return (
      command.snapshot.action === 'abort_turn' ||
      (!this.stopped && !this.journalError && session.controlActive && !session.stopping)
    )
  }
  async report(input: unknown): Promise<{ version: 1; status: CommandStatus }> {
    return this.run(() => {
      const parsed = sessionReportSchema.safeParse(input)
      if (!parsed.success) this.fail('INVALID_CONTROL_REPORT', 400)
      this.sweep()
      const report = parsed.data
      const command = this.commands.get(report.commandId)
      const session = command?.session
      if (
        !command ||
        !session ||
        session.retired ||
        this.instance(report) !== this.instance(session.registration)
      )
        this.fail('COMMAND_TARGET_MISMATCH')
      if (report.messageId && report.messageId !== command.snapshot.messageId)
        this.fail('MESSAGE_ID_MISMATCH')
      if (command.snapshot.status === 'queued') this.fail('COMMAND_NOT_DISPATCHED')
      if (['cancelled', 'expired'].includes(command.snapshot.status)) this.fail('COMMAND_TERMINAL')
      if (['confirmed', 'failed'].includes(command.snapshot.status)) {
        if (command.snapshot.status !== report.status) this.fail('COMMAND_REPORT_CONFLICT')
        return { version: 1, status: command.snapshot.status }
      }
      if (report.status === 'accepted' && command.snapshot.status === 'unknown')
        return { version: 1, status: 'unknown' }
      const wasUncertain = ['accepted', 'unknown'].includes(command.snapshot.status)
      const failedAfterExecution =
        report.status === 'failed' &&
        (wasUncertain || command.sawRunning || command.messageObserved)
      this.transition(command, failedAfterExecution ? 'unknown' : report.status, report.errorCode)
      session.lastSeen = this.now()
      // Offline requires fresh registration; a late callback cannot reconnect a source.
      if (report.status === 'confirmed' && command.snapshot.action === 'abort_turn') {
        session.state = 'idle'
        this.clearControl(session)
      }
      if (report.status === 'failed' && command.snapshot.action === 'send_message') {
        if (!wasUncertain && !command.sawRunning && !command.messageObserved && !session.stopping)
          this.clearControl(session)
      }
      this.saveBestEffort()
      this.notify()
      return { version: 1, status: command.snapshot.status }
    })
  }
  async observeHook(input: HookEnvelope | unknown): Promise<void> {
    return this.run(async () => {
      const parsed = hookEnvelopeSchema.safeParse(input)
      if (!parsed.success) this.fail('INVALID_CONTROL_HOOK', 400)
      const event = parsed.data
      const session = this.routes.get(this.identity(event))
      if (
        !session ||
        session.retired ||
        this.instance(event) !== this.instance(session.registration)
      )
        return
      try {
        if ((await realpath(event.workspace)) !== session.registration.workspace) return
      } catch {
        return
      }
      const previous = session.sequences.get(event.taskId) ?? 0
      if (event.sequence <= previous) return
      if (!session.sequences.has(event.taskId) && session.sequences.size >= 64) {
        // Do not discard replay boundaries to make room for more tasks.
        this.invalidate(session, 'HOOK_TASK_CAPACITY')
        this.saveBestEffort()
        this.notify()
        return
      }
      session.sequences.set(event.taskId, event.sequence)
      session.lastSeen = this.now()
      const send = session.activeSend ? this.commands.get(session.activeSend) : undefined
      const previousStatus = send?.snapshot.status
      const previouslyActive = session.controlActive
      const ownedTurn = !!send && event.taskId === send.snapshot.messageId
      const sourceState = event.payload.state
      const running =
        (event.kind === 'status' && ['busy', 'running', 'retry'].includes(sourceState ?? '')) ||
        event.kind === 'tool.before'
      const idle = event.kind === 'status' && sourceState === 'idle'
      const awaiting =
        event.kind === 'approval' ||
        (event.kind === 'status' &&
          ['awaiting_input', 'approval.pending'].includes(sourceState ?? ''))
      const sourceError = event.kind === 'status' && sourceState === 'error'
      const externalUser = event.kind === 'message' && event.payload.role === 'user' && !ownedTurn
      if (
        send?.snapshot.status === 'queued' &&
        (running || awaiting || sourceError || externalUser)
      ) {
        this.transition(send, 'cancelled', 'SOURCE_BECAME_BUSY')
        this.clearControl(session)
        session.state = sourceError ? 'error' : awaiting ? 'awaiting_input' : 'running'
      }
      // A closed Hook scope can just mean that the same session received a new
      // user task. Only registrations describe whole-session closure.
      if (running && (!session.controlActive || ownedTurn)) session.state = 'running'
      else if (idle) session.state = 'idle'
      else if (awaiting) session.state = 'awaiting_input'
      else if (sourceError) session.state = 'error'
      if (send?.dispatchedAt !== undefined && session.controlActive) {
        if (
          event.kind === 'message' &&
          event.payload.role === 'user' &&
          event.payload.messageId === send.snapshot.messageId
        ) {
          send.messageObserved = true
          if (['dispatched', 'accepted', 'unknown'].includes(send.snapshot.status))
            this.transition(send, 'confirmed')
        }
        // The source task is the native user message ID. Delayed events from an
        // earlier task cannot complete the newly controlled turn.
        if (running && ownedTurn) send.sawRunning = true
        if (
          (idle && send.sawRunning && ownedTurn && !session.stopping) ||
          (event.kind === 'closed' && ownedTurn && !session.stopping)
        )
          this.clearControl(session)
      }
      if (send?.snapshot.status !== previousStatus || session.controlActive !== previouslyActive)
        this.saveBestEffort()
      this.notify()
    })
  }
  private cancelQueuedSends(session: Session) {
    for (const command of this.commands.values())
      if (
        command.session === session &&
        command.snapshot.action === 'send_message' &&
        command.snapshot.status === 'queued'
      )
        this.transition(command, 'cancelled', 'STOP_REQUESTED')
  }
  async stopAll(): Promise<void> {
    return this.run(() => {
      this.sweep()
      this.stopped = true
      for (const session of this.sessions.values()) {
        if (!session.controlActive) continue
        session.stopping = true
        this.cancelQueuedSends(session)
        const active = session.activeAbort ? this.commands.get(session.activeAbort) : undefined
        if (
          active &&
          ['queued', 'dispatched', 'accepted', 'unknown'].includes(active.snapshot.status)
        )
          continue
        // Reserve emergency abort even if normal admissions have reached their budget.
        if (this.commands.size >= MAX_COMMANDS + MAX_SESSIONS) continue
        const command = this.makeCommand(
          { commandId: randomUUID(), sessionHandle: session.handle, action: 'abort_turn' },
          session,
        )
        session.activeAbort = command.snapshot.commandId
      }
      this.saveBestEffort()
      this.notify()
    })
  }
  async resume(): Promise<void> {
    return this.run(() => {
      if (this.journalError) this.fail(this.journalError, 503)
      this.stopped = false
      this.save()
      this.notify()
    })
  }
  async disconnectAll(reason = 'SOURCE_OFFLINE'): Promise<void> {
    return this.run(() => {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(reason) ? reason : 'SOURCE_OFFLINE'
      for (const session of this.sessions.values()) this.invalidate(session, code)
      this.saveBestEffort()
      this.notify()
    })
  }
  async tick(): Promise<void> {
    return this.run(() => {
      if (this.sweep()) this.notify()
    })
  }
  snapshot(): SessionControlSnapshot {
    this.sweep()
    const sessions = [...this.sessions.values()].map((session) => this.publicSession(session))
    const commands = [...this.commands.values()]
      .map((command) => structuredClone(command.snapshot))
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const unknown = commands.filter(
      (command) => command.status === 'unknown' && !command.controlResolved,
    )
    return {
      stopped: this.stopped,
      controlActive: sessions.some((session) => session.controlActive) || unknown.length > 0,
      unconfirmedCount: unknown.length,
      sessions,
      commands: commands.slice(0, 200),
      ...(this.journalError ? { journalError: this.journalError } : {}),
    }
  }
  /** Match already-sanitized, bounded Hook excerpts without exporting native routes. */
  projectProgress(
    hooks: HookSnapshot | undefined,
  ): { sessionHandle: string; text: string; at: string }[] {
    if (!hooks) return []
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const result: { sessionHandle: string; text: string; at: string }[] = []
    for (const session of this.sessions.values()) {
      if (session.retired) continue
      const registration = session.registration
      const observed = hooks.sessions
        .filter(
          (item) =>
            item.sourceId === registration.sourceId &&
            item.instanceIdHash === digest(registration.instanceId) &&
            item.sessionIdHash === digest(registration.sessionId) &&
            !!item.excerpt,
        )
        .sort((a, b) => b.lastReceivedAt.localeCompare(a.lastReceivedAt))[0]
      if (observed?.excerpt)
        result.push({
          sessionHandle: session.handle,
          text: observed.excerpt.slice(0, 200),
          at: observed.lastReceivedAt,
        })
    }
    return result.slice(0, 64)
  }
  async dispose(): Promise<void> {
    if (this.closing || this.disposed) return
    this.closing = true
    clearInterval(this.timer)
    await this.chain
    this.disposed = true
    for (const session of this.sessions.values())
      this.invalidate(session, 'CONTROL_SERVICE_STOPPED')
    this.saveBestEffort()
  }
}
