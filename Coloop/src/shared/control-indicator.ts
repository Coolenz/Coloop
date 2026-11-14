import { z } from 'zod'
import type { Result, Task } from './contracts'

/** Contains only the currently displayed task context; credentials never belong here. */
export const controlIndicatorSnapshotSchema = z
  .object({
    mode: z.enum([
      'hidden',
      'preview',
      'idle',
      'suggestion',
      'question',
      'controlling',
      'stopping',
      'unconfirmed',
      'completed',
      'blocked',
      'failed',
    ]),
    title: z.string().trim().min(1).max(100).optional(),
    detail: z.string().trim().max(180).optional(),
    content: z.string().max(12000).optional(),
    phase: z.string().max(100).optional(),
    suggestionId: z.string().min(1).max(128).optional(),
    taskId: z.string().min(1).max(128).optional(),
    questionKind: z.enum(['approval', 'business']).optional(),
    questionId: z.string().min(1).max(128).optional(),
    choices: z.array(z.string().min(1).max(300)).max(8).optional(),
    expanded: z.boolean().optional(),
    observationPaused: z.boolean().optional(),
    sessionCount: z.number().int().min(0).max(1000).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    error: z.string().trim().max(180).optional(),
    attention: z.boolean().optional(),
    previewDetails: z.boolean().optional(),
    model: z.string().max(160).optional(),
  })
  .strict()

export type ControlIndicatorSnapshot = z.infer<typeof controlIndicatorSnapshotSchema>
/** Use the same persisted task and conversation title as the home workspace. */
export function withTaskIndicatorContext(
  state: ControlIndicatorSnapshot,
  task: Task | undefined,
  conversationTitle?: string,
): ControlIndicatorSnapshot {
  if (!task) return state
  const sameTask = state.taskId === task.id
  const enteringTask =
    task.status === 'running' &&
    !['controlling', 'stopping', 'unconfirmed'].includes(state.mode) &&
    !(sameTask && state.mode === 'question')
  return {
    ...state,
    mode: enteringTask ? 'controlling' : state.mode,
    taskId: task.id,
    questionId: sameTask ? state.questionId : undefined,
    questionKind: sameTask ? state.questionKind : undefined,
    choices: sameTask ? state.choices : undefined,
    suggestionId: sameTask ? state.suggestionId : undefined,
    phase: sameTask ? state.phase : undefined,
    error: sameTask ? state.error : undefined,
    title: (conversationTitle || task.prompt.slice(0, 48) || 'Coloop').slice(0, 100),
    startedAt: task.createdAt,
    detail:
      enteringTask || (!sameTask && task.status === 'running')
        ? task.stage.slice(0, 180)
        : state.detail,
    content: sameTask
      ? (state.content ?? task.answer.slice(0, 12000))
      : task.answer.slice(0, 12000),
    model: state.model || task.model.slice(0, 160),
  }
}

export type IndicatorEdge = 'top' | 'left' | 'right'
export const indicatorPlacementSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('dock'), edge: z.enum(['top', 'left', 'right']) }).strict(),
  z.object({ operation: z.literal('undock') }).strict(),
])
export type ControlIndicatorView = ControlIndicatorSnapshot & {
  revision: number
  dockEdge?: IndicatorEdge
  dockCollapsed?: boolean
  snapEdge?: IndicatorEdge
}
export const islandActionSchema = z
  .object({ id: z.string().min(1).max(128), revision: z.number().int().nonnegative() })
  .strict()
export const islandAnswerSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    questionId: z.string().min(1).max(128),
    answer: z.string().trim().min(1).max(4000),
  })
  .strict()
export type IslandAnswer = z.infer<typeof islandAnswerSchema>
export function isActiveControlMode(mode: ControlIndicatorSnapshot['mode']) {
  return ['controlling', 'stopping', 'unconfirmed', 'question'].includes(mode)
}

export interface ControlIndicatorApi {
  snapshot(renderedRevision?: number): Promise<Result<ControlIndicatorView>>
  stop(): Promise<Result<void>>
  openMain(): Promise<Result<void>>
  dock(): Promise<Result<void>>
  close(): Promise<Result<void>>
  closePreview(): Promise<Result<void>>
  acceptSuggestion(id: string, revision: number): Promise<Result<void>>
  dismissSuggestion(id: string, revision: number): Promise<Result<void>>
  dismissResult(taskId: string, revision: number): Promise<Result<void>>
  answerQuestion(input: IslandAnswer): Promise<Result<void>>
  beginAnswer(): Promise<Result<void>>
  beginTask(): Promise<Result<void>>
  startTask(goal: string): Promise<Result<void>>
  endAnswer(): Promise<Result<void>>
  setExpanded(expanded: boolean): Promise<Result<void>>
  setRevealed(revealed: boolean, reducedMotion?: boolean): Promise<Result<void>>
  drag(phase: 'start' | 'move' | 'end', point: { x: number; y: number }): Promise<Result<void>>
  pauseObservation(paused: boolean): Promise<Result<void>>
  onSnapshot(callback: (snapshot: ControlIndicatorView) => void): () => void
}
declare global {
  interface Window {
    coloopControl?: ControlIndicatorApi
  }
}
