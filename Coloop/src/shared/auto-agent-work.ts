import { z } from 'zod'

export type AutoAgentSource = 'chatgpt-desktop' | 'opencode'
export type AutoAgentCapability = 'unknown' | 'unsupported' | 'available' | 'verified'
export interface AutoAgentSession {
  id: string
  source: AutoAgentSource
  instanceId: string
  sessionId: string
  title: string
  workspace: string
  turnId?: string
  revision: number
  state: 'idle' | 'running' | 'awaiting_input' | 'error' | 'closed' | 'unknown'
  lastSeenAt: string
  capabilities: {
    events: AutoAgentCapability
    nativeContinue: AutoAgentCapability
    reply: AutoAgentCapability
    stop: AutoAgentCapability
    desktopWrite: AutoAgentCapability
  }
}
export interface AutoAgentEvent {
  id: string
  sessionId: string
  instanceId: string
  turnId?: string
  parentTurnId?: string
  agentId?: string
  revision: number
  type:
    | 'started'
    | 'progress'
    | 'question'
    | 'stopped'
    | 'interrupted'
    | 'closed'
    | 'user_input'
    | 'error'
    | 'receipt'
  at: string
  text?: string
  actionId?: string
  questionKind?: 'business' | 'approval'
  origin: 'user' | 'agent' | 'coloop' | 'unknown'
  evidence?: string[]
  choiceMemory?: {
    attribution: 'pending' | 'stored' | 'failed' | 'ignored'
    workspace: string
  }
}
export const autoAgentCreateSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    goal: z.string().trim().min(1).max(24000),
    authorization: z
      .string()
      .trim()
      .max(8000)
      .default('在当前任务范围内推进、核验和回答业务选择；不扩大授权。'),
    acceptance: z.array(z.string().trim().min(1).max(2000)).min(1).max(40),
  })
  .strict()
export const autoAgentFeedbackSchema = z
  .object({
    taskId: z.string().uuid(),
    rating: z.enum(['positive', 'negative']),
    reason: z.string().trim().max(4000).default(''),
    scope: z.enum(['task', 'future']).default('task'),
    decisionId: z.string().uuid().optional(),
  })
  .strict()
export type AutoAgentCreate = z.input<typeof autoAgentCreateSchema>
export type AutoAgentFeedbackInput = z.input<typeof autoAgentFeedbackSchema>
export interface AutoAgentFeedback extends z.output<typeof autoAgentFeedbackSchema> {
  id: string
  createdAt: string
  supersedes?: string
  attribution: 'pending' | 'stored' | 'failed'
}
export interface AutoAgentMemory {
  status: 'matched' | 'empty' | 'unavailable'
  references: { id: string; text: string; kind: 'explicit' | 'case' | 'inferred' | 'feedback' }[]
  error?: string
  version: number
}
export const autoAgentDecisionSchema = z
  .object({
    action: z.enum(['wait', 'reply', 'continue', 'verify', 'ask_user', 'complete']),
    reason: z.string().min(1).max(4000),
    message: z.string().max(12000).optional(),
    expectedChange: z.string().max(4000).optional(),
    evidence: z.array(z.string().max(4000)).max(40).default([]),
    acceptance: z
      .object({
        verdict: z.enum(['pass', 'fail']),
        requirements: z
          .array(
            z.object({
              requirement: z.string().max(2000),
              satisfied: z.boolean(),
              evidence: z.string().max(4000),
            }),
          )
          .max(40),
        gaps: z.array(z.string().max(2000)).max(40),
        imperfections: z.array(z.string().max(2000)).max(40),
      })
      .optional(),
  })
  .strict()
export type AutoAgentDecisionOutput = z.infer<typeof autoAgentDecisionSchema>
export interface AutoAgentDecision extends AutoAgentDecisionOutput {
  id: string
  taskVersion: number
  eventRevision: number
  trigger: string
  model: string
  createdAt: string
  memoryReferences: string[]
}
export interface AutoAgentAction {
  id: string
  decisionId: string
  taskVersion: number
  eventRevision: number
  channel: 'native' | 'desktop' | 'opencode'
  status: 'prepared' | 'dispatching' | 'accepted' | 'confirmed' | 'unknown' | 'failed' | 'cancelled'
  message: string
  expectedChange: string
  createdAt: string
  updatedAt: string
  receipt?: string
  error?: string
  requirementsHash?: string
  recovery?: {
    taskVersion: number
    eventRevision: number
    phase: 'send_claimed'
    proof: AutoAgentDraftRecoveryProof
  }
}
export interface AutoAgentDraftRecoveryProof {
  draftSha256: string
  draftLength: number
  pasteReceipt: string
  sendAbsent: true
}
export interface AutoAgentTask {
  id: string
  version: number
  session: AutoAgentSession
  goal: string
  authorization: string
  acceptance: string[]
  supplements: string[]
  state:
    'watching' | 'deciding' | 'waiting_receipt' | 'paused' | 'needs_user' | 'completed' | 'unbound'
  pauseReason?: string
  createdAt: string
  updatedAt: string
  lastEvaluatedRevision: number
  events: AutoAgentEvent[]
  decisions: AutoAgentDecision[]
  actions: AutoAgentAction[]
  feedback: AutoAgentFeedback[]
  memory?: AutoAgentMemory
  error?: string
  costTaskId: string
  usage?: {
    requests: number
    tokenUnits: number
    estimatedCostYuan: number
    unpricedRequests: number
  }
}
export interface AutoAgentHookStatus {
  workspace?: string
  installed: boolean
  trust: 'unknown' | 'review_required' | 'observed'
  configPath?: string
  connectionPath?: string
  error?: string
}
export interface AutoAgentWorkSnapshot {
  enabled?: boolean
  sessions: AutoAgentSession[]
  tasks: AutoAgentTask[]
  hooks: AutoAgentHookStatus
  active: boolean
  journalError?: string
}
export interface AutoAgentHooksInput {
  workspace: string
}
