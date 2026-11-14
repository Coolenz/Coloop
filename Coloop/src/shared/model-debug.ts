import { z } from 'zod'
export const modelDebugRequestSchema = z
  .object({
    target: z.enum(['local', 'cloud']),
    prompt: z.string().trim().min(1).max(24000),
    system: z.string().max(8000).optional(),
    maxTokens: z.number().int().min(1).max(1048576).optional(),
    timeoutMs: z.number().int().min(1000).max(300000).default(120000),
  })
  .strict()
export type ModelDebugRequest = z.infer<typeof modelDebugRequestSchema>
export interface ModelDebugRun {
  id: string
  target: 'local' | 'cloud'
  model: string
  state: 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled'
  text: string
  createdAt: number
  startedAt?: number
  elapsedMs?: number
  firstTextMs?: number
  inputBytes: number
  outputBytes?: number
  error?: string
  requestedOutputTokens?: number
  budgetSource?: string
  finishReason?: string
  promptTokens?: number
  completionTokens?: number
}
export interface RoutePreview {
  route: 'rk' | 'cloud'
  source: 'model' | 'timeout' | 'invalid' | 'oversize' | 'unavailable'
  elapsedMs: number
  raw?: string
}
export interface ModelDiagnostic {
  id: string
  at: number
  taskId?: string
  model?: string
  source: string
  event: string
  elapsedMs?: number
  startedAt?: number
  firstTextMs?: number
  inputBytes?: number
  outputBytes?: number
  status?: number
  tokenUnits?: number
  usageSource?: string
  promptTokens?: number
  completionTokens?: number
  contextBudgetBytes?: number
  maxOutputTokens?: number
  budgetSource?: string
  finishReason?: string
  from?: string
  to?: string
  reason?: string
  phase?: string
  durationKind?: string
  estimatedCostYuan?: number
  error?: string
}
export const diagnosticQuerySchema = z
  .object({
    taskId: z.string().optional(),
    model: z.string().optional(),
    since: z.number().nonnegative().optional(),
    path: z.string().min(1).max(4096).optional(),
  })
  .strict()
