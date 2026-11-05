import { z } from 'zod'
import type { Result } from './contracts'

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
    questionId: z.string().min(1).max(128).optional(),
    choices: z.array(z.string().min(1).max(300)).max(8).optional(),
    expanded: z.boolean().optional(),
    observationPaused: z.boolean().optional(),
    sessionCount: z.number().int().min(0).max(1000).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    error: z.string().trim().max(180).optional(),
  })
  .strict()

export type ControlIndicatorSnapshot = z.infer<typeof controlIndicatorSnapshotSchema>
export type ControlIndicatorView = ControlIndicatorSnapshot & { revision: number }
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
