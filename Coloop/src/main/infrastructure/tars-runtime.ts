import { createRequire } from 'node:module'
import OpenAI from 'openai'
import type {
  AgentTARS,
  AgentEventStream,
  JSONSchema7,
  OpenAI as TarsOpenAI,
  PrepareRequestContext,
  PrepareRequestResult,
  Tool as TarsTool,
} from '@agent-tars/core'

// The published 0.3.1 core is CommonJS and does not expose reliable ESM named exports.
const require = createRequire(import.meta.url)
const tars = require('@agent-tars/core') as typeof import('@agent-tars/core')

export interface TarsRuntimeModel {
  provider: 'openai' | 'openai-compatible' | 'deepseek'
  id: string
  apiKey: string
  baseURL: string
  headers?: Record<string, string>
}

export interface TarsRuntimeTool {
  name: string
  description: string
  parameters: JSONSchema7
  execute(args: unknown): Promise<unknown> | unknown
}

export interface TarsRuntimeOptions {
  id: string
  workspace: string
  model: TarsRuntimeModel
  instructions: string
  tools: TarsRuntimeTool[]
  onEvent?: (event: AgentEventStream.Event) => void
  fetch?: typeof globalThis.fetch
  maxIterations?: number
}

class ColoopTarsRuntime extends tars.AgentTARS {
  override registerTool(tool: TarsTool): void {
    // Enforce the boundary in the execution registry, not just the model's tool list.
    // Upstream catches onBeforeToolCall errors and would continue execution.
    if (tool.name.startsWith('coloop_')) super.registerTool(tool)
  }

  override async onBeforeToolCall(
    id: string,
    toolCall: { toolCallId: string; name: string },
    args: unknown,
  ): Promise<unknown> {
    // Upstream prepares browser_* tools before looking them up in the registry.
    // Bypass that preparation for denied names, which the registry then rejects.
    if (!toolCall.name.startsWith('coloop_')) return args
    return super.onBeforeToolCall(id, toolCall, args)
  }
}

/** Configure the official AgentTARS runtime; its run method and loop are unmodified. */
export function createTarsRuntime(options: TarsRuntimeOptions): AgentTARS {
  for (const tool of options.tools) {
    if (!/^coloop_[a-z0-9_]+$/.test(tool.name)) throw new Error('TARS_TOOL_NAME_INVALID')
    if (tool.parameters.type !== 'object') throw new Error('TARS_TOOL_SCHEMA_INVALID')
  }

  const instructions = options.instructions
  const agent = new ColoopTarsRuntime({
    id: options.id,
    name: 'Coloop Agent TARS',
    workspace: options.workspace,
    model: options.model,
    instructions,
    tools: options.tools.map(
      (tool) =>
        new tars.Tool({
          id: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          function: tool.execute,
        }),
    ),
    tool: { include: ['coloop_'] },
    // Use the supported MCP server filter so no built-in process is started.
    mcpImpl: 'stdio',
    mcpServer: { exclude: ['browser', 'filesystem', 'commands'] },
    browser: { control: 'dom', headless: true },
    maxIterations: options.maxIterations ?? 32,
    maxTokens: 8192,
    logLevel: tars.LogLevel.SILENT,
  })

  // The tools-only facade supplies its full instructions. Replace the default
  // browser, shell and file-writing prompt through the official request hook.
  agent.onPrepareRequest = ({ tools }: PrepareRequestContext): PrepareRequestResult => ({
    systemPrompt: instructions,
    tools,
  })

  // The upstream provider adapter drops the request signal. Its official custom
  // client extension preserves cancellation and Electron's session.fetch transport.
  const client = new OpenAI({
    apiKey: options.model.apiKey,
    baseURL: options.model.baseURL,
    defaultHeaders: options.model.headers,
    fetch: options.fetch ?? globalThis.fetch,
    maxRetries: 0,
    timeout: 120_000,
  })
  agent.setCustomLLMClient(client as unknown as TarsOpenAI)
  if (options.onEvent) agent.getEventStream().subscribe(options.onEvent)
  return agent
}

export type TarsRuntimeEvent = AgentEventStream.Event
