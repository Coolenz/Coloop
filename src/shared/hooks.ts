import { z } from 'zod'
import { reviewEventSchema, type ReviewEvent, type Decision } from './coordinator'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const elapsed = z.number().finite().min(0).max(600_000)
export const hookEnvelopeSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('opencode'),
    sourceId: id,
    instanceId: id,
    sessionId: id,
    taskId: id,
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    eventId: id,
    kind: z.enum([
      'message',
      'tool.before',
      'tool.after',
      'status',
      'compacted',
      'closed',
      'approval',
    ]),
    workspace: z.string().min(1).max(1024),
    emittedAt: z.string().max(80).optional(),
    payload: z
      .object({
        text: z.string().max(24_000).optional(),
        tool: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .optional(),
        state: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .optional(),
        role: z.enum(['user', 'assistant']).optional(),
        messageId: id.optional(),
        partId: id.optional(),
        relatedEventId: id.optional(),
        approval: reviewEventSchema
          .omit({
            version: true,
            workspace: true,
            createdAt: true,
            expiresAt: true,
            contextRef: true,
          })
          .extend({ originalDigest: sha })
          .strict()
          .optional(),
        metrics: z
          .object({ hookToConsumedMs: elapsed, reviewMs: elapsed, sourceConsumeMs: elapsed })
          .strict()
          .optional(),
        decision: z.enum(['allow', 'deny', 'select', 'defer']).optional(),
        source: z.enum(['policy', 'rk']).optional(),
        originalDigest: sha.optional(),
        reasonCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === 'approval') !== (value.payload.approval !== undefined))
      context.addIssue({ code: 'custom', message: 'APPROVAL_KIND_MISMATCH' })
    if (value.payload.approval && value.payload.approval.sessionId !== value.sessionId)
      context.addIssue({ code: 'custom', message: 'APPROVAL_SESSION_MISMATCH' })
  })

export type HookEnvelope = z.infer<typeof hookEnvelopeSchema>
export interface HookReceipt {
  version: 1
  sourceId: string
  instanceId: string
  eventId: string
  sequence: number
  receivedAt: string
  duplicate: boolean
  contextBytes: number
  contextEvents: number
}
export interface HookReviewResponse {
  version: 1
  sourceId: string
  instanceId: string
  eventId: string
  sequence: number
  originalDigest: string
  reviewEvent: ReviewEvent
  decision: Decision
  metrics: {
    receiveMs: number
    decisionMs: number
    totalMs: number
    contextBytes: number
    contextEvents: number
  }
}
export interface HookSnapshot {
  status: 'ready' | 'stopped'
  sessionCount: number
  contextBytes: number
  receivedEvents: number
  duplicateEvents: number
  rejectedEvents: number
  droppedEvents: number
  activityErrors: number
  sessions: {
    scopeId: string
    sourceId: string
    instanceIdHash: string
    sessionIdHash: string
    taskIdHash: string
    state: string
    lastKind: HookEnvelope['kind']
    lastReceivedAt: string
    contextBytes: number
    contextEvents: number
    excerpt?: string
  }[]
  metrics: {
    scopeId: string
    receivedAt: string
    state: string
    decision?: Decision['decision']
    source?: Decision['source']
    reasonCode?: string
    hookToConsumedMs: number
    reviewMs: number
    sourceConsumeMs: number
  }[]
}
