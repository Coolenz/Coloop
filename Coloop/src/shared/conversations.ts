import { z } from 'zod'
import type { Task, TaskHistoryDetail } from './contracts'

export const permissionModeSchema = z.enum(['ask', 'auto', 'full'])
export type PermissionMode = z.infer<typeof permissionModeSchema>

export const executionPolicySchema = z
  .object({
    mode: z.enum(['cloud', 'local', 'local-auto']),
    permissionMode: permissionModeSchema.optional(),
    cloudFallback: z.boolean(),
  })
  .strict()
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>
export const conversationCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    permissionMode: permissionModeSchema.optional(),
  })
  .strict()
export const conversationSendSchema = z
  .object({
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    text: z.string().trim().min(1).max(24000),
    context: z.string().max(50000).optional(),
    workspace: z.string().min(1).max(2048).optional(),
  })
  .strict()
export const conversationUpdateSchema = z
  .object({
    id: z.string().uuid(),
    permissionMode: permissionModeSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    draft: z.string().max(24000).optional(),
    scrollTop: z.number().finite().nonnegative().optional(),
    expandedDetails: z.array(z.string().max(200)).max(2000).optional(),
    visibleMessages: z.number().int().min(50).max(100000).optional(),
    followingLatest: z.boolean().optional(),
  })
  .strict()
export interface ConversationMessage {
  id: string
  text: string
  context?: string
  at: string
  runId?: string
  delivery: 'queued' | 'accepted' | 'failed'
  error?: string
}
export interface ConversationRun {
  id: string
  policy: ExecutionPolicy
  workspace?: string
  state: 'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  task?: Task
  error?: string
}
export interface Conversation {
  permissionMode?: PermissionMode
  id: string
  title: string
  archived: boolean
  createdAt: string
  updatedAt: string
  draft: string
  scrollTop: number
  expandedDetails?: string[]
  visibleMessages?: number
  followingLatest?: boolean
  messages: ConversationMessage[]
  runs: ConversationRun[]
}
export interface ConversationSnapshot {
  conversations: Conversation[]
  queue: string[]
  paused: boolean
  blockedReason?: string
  error?: string
}
export interface ConversationDetail extends Conversation {
  history: Record<string, TaskHistoryDetail>
}
export const queueCancelSchema = z.object({ runId: z.string().uuid() }).strict()
export const conversationResumeSchema = z
  .object({ conversationId: z.string().uuid(), runId: z.string().uuid() })
  .strict()

export const conversationStoreSchema = z.object({
  version: z.literal(1),
  paused: z.boolean(),
  queue: z.array(z.string().min(1)),
  conversations: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(120),
      archived: z.boolean(),
      permissionMode: permissionModeSchema.optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
      draft: z.string(),
      scrollTop: z.number().nonnegative(),
      expandedDetails: z.array(z.string()).optional(),
      visibleMessages: z.number().int().min(50).optional(),
      followingLatest: z.boolean().optional(),
      messages: z.array(
        z.object({
          id: z.string().uuid(),
          text: z.string(),
          context: z.string().optional(),
          at: z.string(),
          runId: z.string().optional(),
          delivery: z.enum(['queued', 'accepted', 'failed']),
          error: z.string().optional(),
        }),
      ),
      runs: z.array(
        z.object({
          id: z.string().min(1),
          policy: executionPolicySchema,
          workspace: z.string().optional(),
          state: z.enum(['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled']),
          createdAt: z.string(),
          error: z.string().optional(),
          task: z
            .custom<Task>((value) => {
              const task = value as Partial<Task> | null
              return (
                !!task &&
                typeof task.id === 'string' &&
                typeof task.prompt === 'string' &&
                typeof task.answer === 'string' &&
                typeof task.createdAt === 'string' &&
                ['running', 'completed', 'failed', 'cancelled'].includes(task.status ?? '')
              )
            })
            .optional(),
        }),
      ),
    }),
  ),
})
