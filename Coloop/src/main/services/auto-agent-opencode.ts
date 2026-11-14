import { hookEnvelopeSchema } from '../../shared/hooks'
import type { SessionControlService } from './session-control'
import type { AutoAgentEvent, AutoAgentSession } from '../../shared/auto-agent-work'

/** Compatibility projection; the existing OpenCode wire protocol stays v1. */
export class AutoAgentOpenCode {
  private observed = new Map<string, AutoAgentSession>()
  constructor(
    private control: SessionControlService,
    private onEvent: (event: AutoAgentEvent, session: AutoAgentSession) => void,
  ) {}
  sessions(): AutoAgentSession[] {
    return this.control
      .snapshot()
      .sessions.filter((row) => row.connected)
      .map((row) => {
        const prior = this.observed.get(row.handle)
        return {
          id: row.handle,
          source: 'opencode',
          instanceId: prior?.instanceId ?? row.handle,
          sessionId: prior?.sessionId ?? row.handle,
          title: row.title,
          workspace: row.workspace,
          turnId: prior?.turnId,
          revision: prior?.revision ?? 0,
          state: row.state,
          lastSeenAt: row.lastSeenAt,
          capabilities: {
            events: 'available',
            nativeContinue: row.capabilities.includes('send_message') ? 'available' : 'unsupported',
            reply: row.capabilities.includes('send_message') ? 'available' : 'unsupported',
            stop: row.capabilities.includes('abort_turn') ? 'available' : 'unsupported',
            desktopWrite: 'unsupported',
          },
        }
      })
  }
  observe(input: unknown) {
    const parsed = hookEnvelopeSchema.safeParse(input)
    if (!parsed.success) return
    const event = parsed.data
    const matches = this.control
      .snapshot()
      .sessions.filter(
        (row) =>
          row.sourceId === event.sourceId &&
          row.workspace.toLowerCase() === event.workspace.toLowerCase(),
      )
    // The legacy public API intentionally redacts wire identities. Ambiguous
    // registrations never authorize automatic supervision of another session.
    if (matches.length !== 1) return
    const session = this.sessions().find((row) => row.id === matches[0].handle)!
    const prior = this.observed.get(session.id)
    if (prior && (prior.sessionId !== event.sessionId || prior.revision >= event.sequence)) return
    session.sessionId = event.sessionId
    session.turnId = event.taskId
    session.revision = event.sequence
    // Stable existing service handle already identifies its source instance.
    session.instanceId = session.id
    this.observed.set(session.id, session)
    const command = this.control
      .snapshot()
      .commands.find(
        (row) =>
          row.sessionHandle === session.id &&
          row.messageId &&
          row.messageId === event.payload.messageId,
      )
    const type: AutoAgentEvent['type'] =
      event.kind === 'closed'
        ? 'closed'
        : event.payload.role === 'user'
          ? command
            ? 'receipt'
            : 'user_input'
          : event.kind === 'approval'
            ? 'question'
            : event.payload.state === 'idle'
              ? 'stopped'
              : event.payload.state === 'error'
                ? 'error'
                : event.payload.state === 'running'
                  ? 'started'
                  : 'progress'
    this.onEvent(
      {
        id: event.eventId,
        sessionId: session.id,
        instanceId: session.instanceId,
        turnId: event.taskId,
        revision: event.sequence,
        type,
        questionKind: event.kind === 'approval' ? 'approval' : undefined,
        at: new Date().toISOString(),
        text: event.payload.text ?? event.payload.state ?? event.kind,
        origin: command ? 'coloop' : event.payload.role === 'user' ? 'user' : 'agent',
        actionId: command?.commandId,
      },
      session,
    )
  }
}
