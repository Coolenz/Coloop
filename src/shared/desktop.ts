import { z } from 'zod'

export const desktopRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    windowTitle: z.string().trim().min(1).max(250),
    expectedText: z.string().trim().min(1).max(128),
    planner: z.enum(['rk', 'hybrid', 'auto', 'cloud-hid']),
    maxSteps: z.number().int().min(1).max(20).default(8),
    authorizeInput: z.literal(true),
    browserTask: z.enum(['home', 'video-triple']).optional(),
    resumeVideo: z
      .object({
        handle: z.number().int().positive(),
        videoId: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
      })
      .strict()
      .optional(),
  })
  .strict()

const observationId = z.string().regex(/^[a-f0-9]{12}$/)
export const desktopActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      target_id: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal('fill'),
      target_id: z.number().int().nonnegative(),
      text: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[\x20-\x7e]+$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('hotkey'),
      target_id: z.number().int().nonnegative(),
      keys: z
        .string()
        .regex(
          /^(?:(?:CTRL|ALT|SHIFT)\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|ESC|BACKSPACE|TAB|SPACE|RIGHT|LEFT|DOWN|UP|HOME|END)$/,
        ),
    })
    .strict(),
  z.object({ action: z.literal('wait') }).strict(),
  z.object({ action: z.literal('finish') }).strict(),
])
export const desktopPlanSchema = z
  .object({
    observation_id: observationId,
    actions: z.array(desktopActionSchema).min(1).max(8),
  })
  .strict()

export type DesktopRequest = z.infer<typeof desktopRequestSchema>
export type DesktopAction = z.infer<typeof desktopActionSchema>
export type DesktopPhase =
  | 'idle'
  | 'preparing'
  | 'observing'
  | 'planning'
  | 'validating'
  | 'executing'
  | 'verifying'
  | 'stopping'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unconfirmed'
export interface DesktopSnapshot {
  agentLocation?: 'host' | 'rk'
  browserTask?: DesktopRequest['browserTask']
  procedureSaved?: boolean
  procedureMemorySaved?: boolean
  procedureSummary?: string
  taskId?: string
  phase: DesktopPhase
  active: boolean
  windowTitle?: string
  planner?: DesktopRequest['planner']
  planningSource?: 'local' | 'cloud'
  steps: number
  maxSteps: number
  startedAt?: string
  finishedAt?: string
  error?: string
  metrics?: {
    fullObservations: number
    planningCalls: number
    uiaChecks: number
    actions: number
    observationBytes: number
    elapsedMs: number
  }
  events: { phase: DesktopPhase; at: string; step: number; action?: string; targetId?: number }[]
}
