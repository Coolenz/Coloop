export interface ProactiveState {
  connected: boolean
  active: boolean
  phase: string
  taskId?: string
  suggestion?: Record<string, unknown>
  question?: Record<string, unknown>
  summary?: string
  error?: string
  memorySaved?: boolean
}
