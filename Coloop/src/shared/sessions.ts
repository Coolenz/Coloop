import { z } from 'zod'

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)
export const sessionActionSchema = z.enum(['send_message', 'abort_turn'])
export const sessionStateSchema = z.enum(['idle', 'running', 'awaiting_input', 'error', 'closed'])
export const sessionRegisterSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('opencode'),
    sourceId: identifier,
    instanceId: identifier,
    sessionId: identifier,
    workspace: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[^\x00-\x1f]+$/),
    title: z
      .string()
      .max(160)
      .regex(/^[^\x00-\x1f]*$/)
      .optional(),
    host: z.enum(['windows', 'rk', 'other']),
    capabilities: z.array(sessionActionSchema).max(2),
    state: sessionStateSchema,
  })
  .strict()
  .refine((value) => new Set(value.capabilities).size === value.capabilities.length, {
    message: 'DUPLICATE_CAPABILITY',
  })
export const sessionPollSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('opencode'),
    sourceId: identifier,
    instanceId: identifier,
  })
  .strict()
export const sessionReportSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('opencode'),
    sourceId: identifier,
    instanceId: identifier,
    sessionId: identifier,
    commandId: z.string().uuid(),
    status: z.enum(['accepted', 'confirmed', 'failed', 'unknown']),
    errorCode: code.optional(),
    messageId: identifier.optional(),
  })
  .strict()
export const sessionCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    sessionHandle: z.string().uuid(),
    action: sessionActionSchema,
    text: z.string().min(1).max(8192).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.action === 'send_message' &&
        (!value.text?.trim() || new TextEncoder().encode(value.text).length > 8192)) ||
      (value.action === 'abort_turn' && value.text !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'INVALID_COMMAND_TEXT' })
  })

export type SessionAction = z.infer<typeof sessionActionSchema>
export type SessionState = z.infer<typeof sessionStateSchema>
export type SessionRegistration = z.infer<typeof sessionRegisterSchema>
export type SessionCommandInput = z.infer<typeof sessionCommandSchema>
export type SessionReport = z.infer<typeof sessionReportSchema>
export interface SessionSnapshot {
  handle: string
  source: 'opencode'
  sourceId: string
  host: SessionRegistration['host']
  title: string
  workspace: string
  state: SessionState
  connected: boolean
  capabilities: SessionAction[]
  controlActive: boolean
  controlStartedAt?: string
  stopping: boolean
  lastSeenAt: string
}
export type CommandStatus =
  | 'queued'
  | 'dispatched'
  | 'accepted'
  | 'confirmed'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired'
export interface CommandSnapshot {
  commandId: string
  sessionHandle: string
  action: SessionAction
  status: CommandStatus
  messageId?: string
  errorCode?: string
  createdAt: string
  expiresAt: string
  updatedAt: string
  /** Delivery can remain uncertain after a separately verified stop has ended control. */
  controlResolved?: boolean
}
export interface SessionControlSnapshot {
  stopped: boolean
  controlActive: boolean
  unconfirmedCount: number
  sessions: SessionSnapshot[]
  commands: CommandSnapshot[]
  journalError?: string
}
export interface SessionWireCommand {
  commandId: string
  sessionId: string
  instanceId: string
  action: SessionAction
  text?: string
  messageId?: string
  expiresAt: string
}
