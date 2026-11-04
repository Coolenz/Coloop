import { z } from 'zod'

export const autoConnectionSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    hasCredential: z.boolean(),
    phase: z.enum([
      'ready',
      'connecting',
      'starting_model',
      'waiting',
      'needs_setup',
      'paused',
      'disabled',
    ]),
    attempts: z.number().int().nonnegative(),
    retryAt: z.string().datetime().optional(),
    message: z.string().max(500),
  })
  .strict()
export type AutoConnectionSnapshot = z.infer<typeof autoConnectionSnapshotSchema>
export const remoteConnectionSchema = z
  .object({
    rk: z.enum(['ready', 'connecting', 'offline', 'needs_setup', 'paused']),
    message: z.string().max(500),
    autoConnect: z.boolean(),
    phase: autoConnectionSnapshotSchema.shape.phase.optional(),
  })
  .strict()
export type RemoteConnection = z.infer<typeof remoteConnectionSchema>
