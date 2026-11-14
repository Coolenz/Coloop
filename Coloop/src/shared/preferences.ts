import { z } from 'zod'
export const preferencesSchema = z
  .object({
    modelLimitMode: z.enum(['unlimited', 'custom']).optional(),
    executionMode: z.enum(['cloud', 'local', 'local-auto']).optional(),
    allowCloudFallback: z.boolean().optional(),
    islandEnabled: z.boolean().optional(),
    islandDetailedNotifications: z.boolean().optional(),
    islandAttention: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    startHidden: z.boolean().optional(),
    launchOnLogin: z.boolean().optional(),
  })
  .strict()
export type PreferencesPatch = z.infer<typeof preferencesSchema>
