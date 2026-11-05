import { createTarsRuntime, type TarsRuntimeOptions } from './tars-runtime'
import { createHarnessRuntime } from './harness-runtime'
import { reconcileReadOnly } from './harness-recovery'

/** The task service owns physical effects; runtimes own only model/tool turns. */
export interface AgentRuntime {
  initialize(): Promise<void>
  run(input: { input: string; sessionId: string }): Promise<unknown>
  abort(): unknown
  dispose(): Promise<void>
}

export type AgentEngine = 'harness' | 'tars'

export function createAgentRuntime(engine: AgentEngine, options: TarsRuntimeOptions): AgentRuntime {
  return engine === 'harness'
    ? createHarnessRuntime({ ...options, reconcileUnknown: reconcileReadOnly })
    : createTarsRuntime(options)
}
