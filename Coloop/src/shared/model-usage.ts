import { z } from 'zod'

export const modelPricingSchema = z.object({
  inputYuanPerMillion: z.number().min(0).max(1000000).optional(),
  outputYuanPerMillion: z.number().min(0).max(1000000).optional(),
})
export type ModelPricing = z.infer<typeof modelPricingSchema>

// Zod strips the retired maxNoProgressRequests field from existing profiles.
// DSH owns continuation; progress diagnostics do not impose a request cutoff.
export const modelLimitsSchema = z.object({
  mode: z.enum(['unlimited', 'custom']).optional(),
  inputLimitEnabled: z.boolean().optional(),
  usageBudgetEnabled: z.boolean().default(false),
  costLimitEnabled: z.boolean().default(false),
  maxRequestsPerTask: z.number().int().min(1).max(256).default(64),
  maxRequestsPerDay: z.number().int().min(1).max(10000).default(128),
  maxTokenUnitsPerTask: z.number().int().min(1000).max(10000000).default(250000),
  maxTokenUnitsPerDay: z.number().int().min(1000).max(100000000).default(1000000),
  maxInputBytes: z.number().int().min(1000).max(1000000).default(96000),
  maxOutputTokens: z.number().int().min(512).max(1048576).default(8192),
  minRequestIntervalMs: z.number().int().min(0).max(60000).default(1000),
  maxCostYuanPerTask: z.number().min(0.01).max(10000).default(2),
  maxCostYuanPerDay: z.number().min(0.01).max(100000).default(10),
  // Optional lifetime ceiling for a persistent profile (does not reset at midnight).
  maxCostYuanTotal: z.number().min(0.01).max(100000).optional(),
  inputYuanPerMillion: z.number().min(0).max(1000000).optional(),
  outputYuanPerMillion: z.number().min(0).max(1000000).optional(),
})
export type ModelLimits = z.infer<typeof modelLimitsSchema>

export function modelLimitMode(limits: Partial<ModelLimits>) {
  return (
    limits.mode ??
    (limits.usageBudgetEnabled || limits.costLimitEnabled || limits.inputLimitEnabled
      ? 'custom'
      : 'unlimited')
  )
}

export function effectiveModelLimits(input?: Partial<ModelLimits>) {
  const limits = modelLimitsSchema.parse(input ?? {})
  const mode = modelLimitMode(limits)
  return {
    ...limits,
    mode,
    usageBudgetEnabled: mode === 'custom' && limits.usageBudgetEnabled,
    costLimitEnabled: mode === 'custom' && limits.costLimitEnabled,
    inputLimitEnabled: mode === 'custom' && (limits.inputLimitEnabled ?? true),
    minRequestIntervalMs: mode === 'custom' ? limits.minRequestIntervalMs : 0,
  }
}

export interface ModelUsageSnapshot {
  day: string
  requests: number
  tokenUnits: number
  estimatedCostYuan: number
  unpricedRequests: number
  pricingConfigured: boolean
  limits: ModelLimits
  error?: string
}
