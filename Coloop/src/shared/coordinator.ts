import { z } from 'zod'
import { managedEvidenceSchema, managedPermitSchema } from './managed'

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const timestamp = z.string().datetime({ offset: true })
export const reviewEventSchema = z
  .object({
    version: z.literal(1),
    id: identifier,
    sessionId: identifier,
    contextRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    kind: z.enum(['permission', 'question']),
    workspace: z.string().min(1).max(1024),
    tool: z.string().min(1).max(80).optional(),
    patterns: z.array(z.string().min(1).max(1024)).min(1).max(20).optional(),
    command: z.string().max(8000).optional(),
    managed: managedEvidenceSchema.optional(),
    question: z.string().min(1).max(4000).optional(),
    choices: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[A-Za-z0-9_-]+$/),
            label: z.string().min(1).max(200),
            description: z.string().max(800).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      .optional(),
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()

export const decisionSchema = z
  .object({
    version: z.literal(1),
    id: identifier,
    sessionId: identifier,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['allow', 'deny', 'select', 'defer']),
    choiceId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    source: z.enum(['policy', 'rk']),
    expiresAt: timestamp,
    permit: managedPermitSchema.optional(),
  })
  .strict()
  .refine((value) => (value.decision === 'select') === (value.choiceId !== undefined), {
    message: 'SELECT_REQUIRES_CHOICE_ID',
  })
  .refine((value) => value.permit === undefined || value.decision === 'allow', {
    message: 'PERMIT_REQUIRES_ALLOW',
  })

export type ReviewEvent = z.infer<typeof reviewEventSchema>
export type Decision = z.infer<typeof decisionSchema>
export interface ReviewAudit {
  idHash: string
  requestHash: string
  kind: ReviewEvent['kind']
  decision: Decision['decision']
  reasonCode: string
  source: Decision['source']
  durationMs: number
  at: string
}
export interface CoordinatorSnapshot {
  status: 'stopped' | 'listening' | 'reviewing'
  url?: string
  reviewing: boolean
  audit: ReviewAudit[]
}

/** Sorted JSON keys, compact UTF-8 encoding; compatible with Python ensure_ascii=False. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  throw new Error('INVALID_CANONICAL_VALUE')
}
