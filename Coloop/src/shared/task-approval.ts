import { z } from 'zod'
import type { ProactiveState } from './proactive'

export const taskApprovalSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    questionId: z.string().uuid(),
    title: z.string().max(120),
    question: z.string().max(4000),
    details: z.string().max(3000).optional(),
    toolName: z.string().min(1).max(200),
    callId: z.string().min(1).max(200),
  })
  .strict()
export const taskApprovalAnswerSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    questionId: z.string().uuid(),
    decision: z.enum(['allowed-once', 'rejected']),
  })
  .strict()
export type TaskApproval = z.infer<typeof taskApprovalSchema>
export type TaskApprovalAnswer = z.infer<typeof taskApprovalAnswerSchema>

export function pendingTaskApproval(
  state: ProactiveState | undefined,
  title = 'Coloop',
): TaskApproval | undefined {
  if (!state?.active || state.question?.kind !== 'approval') return undefined
  const value = taskApprovalSchema.safeParse({
    taskId: state.taskId,
    questionId: state.question.question_id,
    title: title.slice(0, 120),
    question: state.question.question,
    details: state.question.details,
    toolName: state.question.toolName,
    callId: state.question.callId,
  })
  return value.success ? value.data : undefined
}
