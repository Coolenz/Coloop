import { createHarnessRuntime, type HarnessRuntimeOptions } from './harness-runtime'
import { reconcileReadOnly } from './harness-recovery'

/** The task service owns physical effects; runtimes own only model/tool turns. */
export interface AgentRuntime {
  initialize(): Promise<void>
  run(input: { input: string; sessionId: string }): Promise<unknown>
  abort(): unknown
  dispose(): Promise<void>
}

export type AgentEngine = 'harness' | 'tars'

/** Accept legacy engine identifiers at the API boundary while all application
 * capabilities run through the same DSH session, tools and recovery hooks. */
export function createAgentRuntime(_engine: AgentEngine, options: HarnessRuntimeOptions) {
  return createHarnessRuntime({
    ...options,
    reconcileUnknown: options.reconcileUnknown ?? reconcileReadOnly,
  })
}
