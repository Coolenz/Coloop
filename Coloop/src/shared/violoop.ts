import { z } from 'zod'

const date = z.string().datetime({ offset: true })
export const violoopMessageSchema = z
  .object({
    commandId: z.string().uuid(),
    text: z.string().trim().min(1).max(2000),
    authorizeInput: z.literal(true),
    replyTo: z.string().uuid().optional(),
    windowTitle: z.string().trim().min(1).max(250).optional(),
    expectedText: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
export type VioloopMessage = z.infer<typeof violoopMessageSchema>
export const violoopTaskSchema = z
  .object({
    id: z.string().uuid(),
    text: z.string().max(2000),
    state: z.enum([
      'received',
      'understanding',
      'awaiting_input',
      'running',
      'completed',
      'answered',
      'cancelled',
      'failed',
      'unconfirmed',
      'interrupted',
    ]),
    message: z.string().max(1000),
    createdAt: date,
    updatedAt: date,
    desktopTaskId: z.string().uuid().optional(),
    windowTitle: z.string().max(250).optional(),
    phase: z.string().max(32).optional(),
    planningSource: z.enum(['local', 'cloud']).optional(),
    steps: z.number().int().min(0).max(20).optional(),
  })
  .strict()
export type VioloopTask = z.infer<typeof violoopTaskSchema>
export const violoopSnapshotSchema = z
  .object({
    available: z.boolean(),
    unavailableReason: z.string().max(500).optional(),
    active: z.boolean(),
    tasks: z.array(violoopTaskSchema).max(20),
  })
  .strict()
export type VioloopSnapshot = z.infer<typeof violoopSnapshotSchema>

// Model output is normalized to known intent fields; explanatory extras never reach execution.
export const violoopIntentSchema = z.union([
  z.object({ kind: z.literal('browser_relay') }).strip(),
  z.object({ kind: z.literal('reply'), message: z.string().trim().min(1).max(1000) }).strip(),
  z
    .object({
      kind: z.literal('desktop'),
      windowId: z.number().int().min(0).max(299),
      expectedText: z.string().trim().min(1).max(128),
    })
    .strip(),
  z
    .object({
      kind: z.literal('desktop'),
      windowTitle: z.string().min(1).max(250),
      expectedText: z.string().trim().min(1).max(128),
    })
    .strip(),
  z.object({ kind: z.literal('clarify'), message: z.string().trim().min(1).max(1000) }).strip(),
])
