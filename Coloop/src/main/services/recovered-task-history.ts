import type { AppStore } from '../infrastructure/store'

/** Called only when TaskService is not tracking the active desktop execution.
 * Observe the existing task; never create a task or dispatch another action. */
export function syncRecoveredTaskHistory(
  store: Pick<AppStore, 'tasks' | 'persist'>,
  state: { taskId?: string; active: boolean; phase: string; summary?: string; error?: string },
  stage: string,
) {
  const prior = store.tasks.find((task) => task.id === state.taskId)
  if (!prior || prior.execution !== 'desktop') return
  const terminal = ['completed', 'failed', 'blocked', 'cancelled', 'input_unknown'].includes(
    state.phase,
  )
  if (!state.active && (!terminal || prior.status !== 'running')) return
  const status = state.active
    ? 'running'
    : state.phase === 'completed'
      ? 'completed'
      : state.phase === 'cancelled'
        ? 'cancelled'
        : 'failed'
  if (prior.status === status && state.active) return
  const updated = {
    ...prior,
    status,
    stage,
    answer: state.active ? '' : (state.summary ?? ''),
    error:
      state.active || status === 'completed' || status === 'cancelled' ? undefined : state.error,
    finishedAt: state.active ? undefined : new Date().toISOString(),
  } as typeof prior
  const previous = store.tasks
  store.tasks = previous.map((task) => (task.id === prior.id ? updated : task))
  try {
    store.persist()
  } catch (error) {
    store.tasks = previous
    throw error
  }
}
