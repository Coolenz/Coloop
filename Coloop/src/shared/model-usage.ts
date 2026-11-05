import { z } from 'zod'

export const modelLimitsSchema = z.object({
  usageBudgetEnabled: z.boolean().default(false),
  costLimitEnabled: z.boolean().default(false),
  maxRequestsPerTask: z.number().int().min(1).max(256).default(64),
  maxRequestsPerDay: z.number().int().min(1).max(10000).default(128),
  maxTokenUnitsPerTask: z.number().int().min(1000).max(10000000).default(250000),
  maxTokenUnitsPerDay: z.number().int().min(1000).max(100000000).default(1000000),
  maxInputBytes: z.number().int().min(1000).max(1000000).default(96000),
  maxOutputTokens: z.number().int().min(512).max(8192).default(8192),
  minRequestIntervalMs: z.number().int().min(0).max(60000).default(1000),
  maxNoProgressRequests: z.number().int().min(2).max(32).default(6),
  maxCostYuanPerTask: z.number().min(0.01).max(10000).default(2),
  maxCostYuanPerDay: z.number().min(0.01).max(100000).default(10),
  // Optional lifetime ceiling for a persistent profile (does not reset at midnight).
  maxCostYuanTotal: z.number().min(0.01).max(100000).optional(),
  inputYuanPerMillion: z.number().min(0).max(1000000).optional(),
  outputYuanPerMillion: z.number().min(0).max(1000000).optional(),
})
export type ModelLimits = z.infer<typeof modelLimitsSchema>

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
