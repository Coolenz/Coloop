import { createRequire } from 'node:module'
import OpenAI from 'openai'
import { legacyLocalCapacity } from '../../shared/local-model'
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
  toolCallEngine?: 'native' | 'prompt_engineering'
  requestTimeoutMs?: number
  contextWindow?: number
  maxOutputTokens?: number
  maximumOutputTokens?: number
}

export interface TarsRuntimeTool {
  name: string
  description: string
  parameters: JSONSchema7
  execute(args: unknown): Promise<unknown> | unknown
}

export interface TarsRuntimeOptions {
  playwrightExtension?: import('./playwright-extension').PlaywrightExtensionOptions
  /** Harness-only explicit continuation; legacy TARS starts a fresh loop. */
  resume?: boolean
  /** Trusted execution location used by Harness persisted-context isolation. */
  historyBoundary?: 'local' | 'remote'
  runtimeResources?: string
  nodePath?: string
  id: string
  workspace: string
  /** Harness model context uses this host-authorized file root; storage stays
   * under workspace. Legacy TARS continues using its existing file tools. */
  taskWorkspace?: string
  model: TarsRuntimeModel
  instructions: string
  tools: TarsRuntimeTool[]
  onEvent?: (event: TarsRuntimeEvent) => void
  fetch?: typeof globalThis.fetch
  maxIterations?: number
  maxTokens?: number
  toolDecision?(name: string, args: unknown): { kind: 'allow' | 'ask' | 'deny'; reason?: string }
  requestApproval?(request: {
    toolName: string
    callId: string
    arguments?: unknown
    signal: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
  visibleTool?(name: string): boolean
  completion?(): { finished: boolean; message?: string }
  requestContext?(): string | undefined
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
  const reasoning = new Map<string, string[]>()
  const messageKey = (message: { content?: unknown; tool_calls?: { id?: string }[] }) =>
    JSON.stringify([message.content ?? '', message.tool_calls?.map((call) => call.id) ?? []])
  const agent = new ColoopTarsRuntime({
    id: options.id,
    name: 'Coloop Agent TARS',
    workspace: options.workspace,
    model: options.model,
    toolCallEngine: options.model.toolCallEngine ?? 'native',
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
    maxIterations: options.maxIterations ?? 64,
    maxTokens:
      options.maxTokens ??
      options.model.maxOutputTokens ??
      (options.model.toolCallEngine === 'prompt_engineering'
        ? legacyLocalCapacity.defaultOutputTokens
        : 8192),
    logLevel: tars.LogLevel.SILENT,
  })

  // The tools-only facade supplies its full instructions. Replace the default
  // browser, shell and file-writing prompt through the official request hook.
  let continuation = ''
  agent.onPrepareRequest = ({ tools }: PrepareRequestContext): PrepareRequestResult => ({
    systemPrompt: [instructions, continuation, options.requestContext?.()]
      .filter(Boolean)
      .join('\n\n'),
    tools: options.visibleTool ? tools.filter((tool) => options.visibleTool!(tool.name)) : tools,
  })
  if (options.completion)
    agent.onBeforeLoopTermination = async (_id, event) => {
      if (event.finishReason !== 'stop') return { finished: true }
      const result = options.completion!()
      continuation = result.finished ? '' : (result.message ?? '继续完成原任务并核验实际结果。')
      return result
    }

  // The SDK's historical native messages omit provider reasoning fields. Preserve
  // the actual streamed value through its public response hook, including final
  // answers that the completion guard asks the official loop to continue after.
  const streamingResponse = agent.onLLMStreamingResponse.bind(agent)
  agent.onLLMStreamingResponse = (id, payload) => {
    let content = ''
    let thinking = ''
    let hasThinking = false
    const calls = new Map<number, string>()
    for (const chunk of payload.chunks) {
      const delta = chunk.choices[0]?.delta as
        | {
            content?: string
            reasoning_content?: string
            tool_calls?: {
              index: number
              id?: string
              function?: { name?: string; arguments?: string }
            }[]
          }
        | undefined
      content += delta?.content ?? ''
      thinking += delta?.reasoning_content ?? ''
      hasThinking ||= typeof delta?.reasoning_content === 'string'
      for (const part of delta?.tool_calls ?? []) {
        if (part.id) calls.set(part.index, part.id)
      }
    }
    if (hasThinking) {
      const key = messageKey({
        content,
        tool_calls: [...calls].sort(([a], [b]) => a - b).map(([, id]) => ({ id })),
      })
      const values = reasoning.get(key) ?? []
      values.push(thinking)
      reasoning.set(key, values)
    }
    streamingResponse(id, payload)
  }

  // The upstream provider adapter drops the request signal. Its official custom
  // client extension preserves cancellation and Electron's session.fetch transport.
  const client = new OpenAI({
    apiKey: options.model.apiKey,
    baseURL: options.model.baseURL,
    defaultHeaders: options.model.headers,
    fetch: async (input, init) => {
      const fetcher = options.fetch ?? globalThis.fetch
      if (!reasoning.size || typeof init?.body !== 'string') return fetcher(input, init)
      const request = JSON.parse(init.body)
      const used = new Map<string, number>()
      let changed = false
      for (const message of request.messages ?? []) {
        if (message.role !== 'assistant') continue
        const key = messageKey(message)
        const index = used.get(key) ?? 0
        used.set(key, index + 1)
        const value = reasoning.get(key)?.[index]
        if (value !== undefined && message.reasoning_content === undefined) {
          message.reasoning_content = value
          changed = true
        }
      }
      if (!changed) return fetcher(input, init)
      const headers = new Headers(init.headers)
      headers.delete('content-length')
      return fetcher(input, { ...init, headers, body: JSON.stringify(request) })
    },
    maxRetries: 0,
    timeout: options.model.requestTimeoutMs ?? 120_000,
  })
  agent.setCustomLLMClient(client as unknown as TarsOpenAI)
  if (options.onEvent) agent.getEventStream().subscribe(options.onEvent)
  return agent
}

export type TarsRuntimeEvent =
  | AgentEventStream.Event
  | { type: 'agent_error'; error: string }
  | { type: 'tool_call'; name: string; toolCallId: string; arguments: unknown }
  | { type: 'tool_result'; name: string; toolCallId: string; content: unknown; error?: string }
  | {
      type: 'coloop_recovered_tool_state'
      name: string
      arguments: unknown
      result: unknown
    }
