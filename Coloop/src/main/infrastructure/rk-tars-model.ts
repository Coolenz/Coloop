import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { TarsRuntimeModel } from './tars-runtime'
import { projectObservationContext } from './observation-context'
import {
  legacyLocalCapacity,
  localOutputBudget,
  localOutputReserve,
  localPromptBytes,
  type LocalModelCapacity,
  type LocalInferenceResult,
} from '../../shared/local-model'

const endpoint = 'https://rk.coloop.invalid/v1'
type Message = { role: 'user' | 'assistant'; content: string }
export const rkContextBudgetBytes = 16_384
const contextBytes = rkContextBudgetBytes
// Keep exactly BoardClient.infer's accounting: content bytes plus one newline
// between turns, no role/JSON wrapper charge and no separator after system.
const promptBytes = localPromptBytes

function supersededObservation(value: Record<string, unknown>) {
  return {
    observation_id: value.observation_id,
    window_id: value.window_id,
    superseded: true,
    instruction: '此观察已失效，只能使用最新观察的目标。',
  }
}

/** The host retains full observations for all guards and audit events. Only
 * obsolete visual context and native binding metadata are reduced for the NPU. */
function compactMessages(
  messages: Message[],
  system: string,
  outputTokens: number,
  contextBytes: number,
): Message[] {
  const outputReserveBytes = localOutputReserve(outputTokens)
  const parsed = messages.map((message, index) => {
    const match = /^Tool: (coloop_[a-z0-9_]+)(?:\\n|\n)Result:(?:\\n|\n)([\s\S]+)$/.exec(
      message.content,
    )
    if (!match || message.role !== 'user' || messages[index - 1]?.role !== 'assistant') return
    try {
      const value = JSON.parse(match[2])
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      return { prefix: `Tool: ${match[1]}\nResult:\n`, value }
    } catch {
      return
    }
  })
  const latest = parsed.reduce(
    (last, p, index) => (p && (p.value.ocr_items || p.value.observation?.ocr_items) ? index : last),
    -1,
  )
  let latestObservation: Record<string, unknown> | undefined
  let latestEnvelope: ((json: string) => string) | undefined
  const compacted = messages.map((message, index) => {
    const result = parsed[index]
    if (!result) {
      const call =
        message.role === 'assistant' &&
        /^<tool_call>\s*([\s\S]+?)\s*<\/tool_call>$/.exec(message.content.trim())
      if (!call) return message
      try {
        return {
          ...message,
          content: '<tool_call>' + JSON.stringify(JSON.parse(call[1])) + '</tool_call>',
        }
      } catch {
        return message
      }
    }
    if (index === latest) {
      if (result.value.ocr_items) {
        latestObservation = result.value
        latestEnvelope = (json) => result.prefix + json
      } else {
        const { observation, ...metadata } = result.value
        latestObservation = observation
        const prefix = JSON.stringify(metadata).slice(0, -1)
        latestEnvelope = (json) =>
          result.prefix + prefix + (prefix === '{' ? '' : ',') + '"observation":' + json + '}'
      }
      // The placeholder has zero bytes. Budget all real envelope/history bytes
      // before inserting the independently bounded observation JSON.
      return { ...message, content: latestEnvelope!('') }
    }
    const value = result.value.ocr_items
      ? supersededObservation(result.value)
      : result.value.observation?.ocr_items
        ? {
            ...result.value,
            verification_hint: undefined,
            observation: supersededObservation(result.value.observation),
          }
        : result.value
    return { ...message, content: result.prefix + JSON.stringify(value) }
  })
  const available = contextBytes - outputReserveBytes - promptBytes(system, compacted)
  if (available < 0) throw new Error('RK_CONTEXT_BUDGET_EXCEEDED')
  if (latestObservation && latestEnvelope) {
    let requiredTargetIds: number[] = []
    actionHistory: for (let index = latest - 1; index >= 0; index--) {
      if (messages[index].role !== 'assistant') continue
      const calls = [
        ...messages[index].content.matchAll(/<tool_call>\s*([\s\S]+?)\s*<\/tool_call>/g),
      ]
      for (const call of calls.reverse()) {
        try {
          const value = JSON.parse(call[1])
          if (!['coloop_execute', 'coloop_patch_text'].includes(value?.name)) continue
          const args = value.parameters ?? value.arguments
          const target = value.name === 'coloop_execute' ? args?.action?.target_id : args?.target_id
          const original = parsed
            .slice(0, index)
            .reverse()
            .find((result) => {
              const observation = result?.value.ocr_items ? result.value : result?.value.observation
              return observation?.observation_id === args?.observation_id
            })
          const previousView = original?.value.ocr_items
            ? original.value
            : original?.value.observation
          const stillPresent = [
            ...(Array.isArray(latestObservation.targets) ? latestObservation.targets : []),
            ...(Array.isArray(latestObservation.ocr_items) ? latestObservation.ocr_items : []),
          ].some(
            (item) =>
              item && typeof item === 'object' && (item as Record<string, unknown>).id === target,
          )
          // A completed action can navigate away or remove its target. Pin only
          // a still-live ID from the same observed window; stale IDs must not
          // prevent planning from the new window. Explicit projector-required
          // targets still fail closed when absent or too large.
          if (
            Number.isSafeInteger(target) &&
            target >= 0 &&
            stillPresent &&
            previousView &&
            String(previousView.window_id) === String(latestObservation.window_id)
          )
            requiredTargetIds = [target]
          break actionHistory
        } catch {
          /* Unparsed tool calls never invent target IDs. */
        }
      }
    }
    const query = parsed[latest]?.value.model_context_query ?? latestObservation.model_context_query
    const projection = projectObservationContext(latestObservation, {
      budgetBytes: available,
      ...(typeof query === 'string' ? { query } : {}),
      requiredTargetIds,
    })
    if (!projection.ok) throw new Error(projection.code)
    compacted[latest] = { ...compacted[latest], content: latestEnvelope(projection.json) }
  }
  if (promptBytes(system, compacted) + outputReserveBytes > contextBytes)
    throw new Error('RK_CONTEXT_BUDGET_EXCEEDED')
  return compacted
}
const requestSchema = z.object({
  model: z.string(),
  stream: z.literal(true),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1),
})

export const rkTarsModel: TarsRuntimeModel = {
  provider: 'openai',
  id: 'qwen35-4b-rkllm',
  apiKey: 'rk-managed-local-transport',
  baseURL: endpoint,
  toolCallEngine: 'prompt_engineering',
  requestTimeoutMs: 240_000,
}

// Small-model shorthand is accepted only for these non-input tools. A flat
// execute/paste/file-write call must still fail; never infer missing inputs.
const flatNonInputCall = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('coloop_enable_tools'),
      group: z.enum([
        'files',
        'workbook',
        'document',
        'pdf',
        'archive',
        'native',
        'web',
        'memory',
        'schedule',
      ]),
    })
    .strict(),
  z
    .object({
      name: z.literal('coloop_ask_user'),
      question: z.string().min(1),
      options: z.array(z.string()).max(6).optional(),
    })
    .strict(),
])

/** Repair the RK model's outer envelope alias. Nested business arguments stay
 * intact and the official SDK still parses and dispatches every tool call. */
function normalizeToolEnvelopes(answer: string, recommendation: boolean) {
  return answer.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (original, content: string) => {
    try {
      const value = JSON.parse(content)
      const flat = flatNonInputCall.safeParse(value)
      if (flat.success) {
        const { name, ...parameters } = flat.data
        return '<tool_call>' + JSON.stringify({ name, parameters }) + '</tool_call>'
      }
      // Observe has an empty parameter schema. Some RK replies omit the empty
      // envelope; only this read-only, zero-argument call can use that shorthand.
      if (
        value &&
        !Array.isArray(value) &&
        value.name === 'coloop_observe' &&
        Object.keys(value).length === 1
      )
        return '<tool_call>' + JSON.stringify({ name: value.name, parameters: {} }) + '</tool_call>'
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        typeof value.name !== 'string' ||
        (!/^coloop_[a-z0-9_]+$/.test(value.name) &&
          !(recommendation && value.name === 'tool_recommend'))
      )
        return original
      const parameters = value.parameters ?? value.arguments
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))
        return original
      const name = value.name === 'tool_recommend' ? 'coloop_recommend' : value.name
      if (name === value.name && value.parameters) return original
      return '<tool_call>' + JSON.stringify({ name, parameters }) + '</tool_call>'
    } catch {
      return original
    }
  })
}

/** Translate OpenAI SSE to the managed RK text API. The official SDK parses
 * prompt-engineered tool calls and owns the reasoning loop. No network fallback. */
export function createRkTarsFetch(
  complete: (
    system: string,
    messages: Message[],
    signal: AbortSignal,
    maxTokens: number,
  ) => Promise<string | LocalInferenceResult>,
  capacity: LocalModelCapacity = legacyLocalCapacity,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== endpoint + '/chat/completions' || init?.method?.toUpperCase() !== 'POST')
      throw new Error('RK_MODEL_ENDPOINT_NOT_ALLOWED')
    const signal = init.signal ?? new AbortController().signal
    signal.throwIfAborted()
    if (typeof init.body !== 'string') throw new Error('RK_MODEL_REQUEST_INVALID')
    const request = requestSchema.parse(JSON.parse(init.body))
    const explicit =
      request.max_tokens === undefined
        ? request.max_completion_tokens
        : Math.min(request.max_tokens, request.max_completion_tokens ?? request.max_tokens)
    const outputTokens = localOutputBudget(capacity, explicit).tokens
    if (request.model !== rkTarsModel.id) throw new Error('RK_MODEL_NOT_AVAILABLE')
    let system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    const history = request.messages.filter((m) => m.role !== 'system') as Message[]
    const last = history[history.length - 1]
    const verified =
      /^Tool: (?:coloop_verify|coloop_verify_artifact|coloop_web)(?:\\n|\n)Result:(?:\\n|\n)([\s\S]+)$/.exec(
        last?.content ?? '',
      )
    if (last?.role === 'user' && history[history.length - 2]?.role === 'assistant' && verified) {
      try {
        const result = JSON.parse(verified[1])
        if (result.verified === true && result.completion_verification_required === false)
          system +=
            '\n\n最新宿主核验结果为 verified:true 且无需再次核验。本轮应直接用中文简短报告实际结果，不再调用 coloop_verify、coloop_observe 或任何其他工具。'
      } catch {
        /* Non-JSON results remain ordinary tool history. */
      }
    }
    let messages: Message[]
    try {
      messages = compactMessages(history, system, outputTokens, capacity.contextWindow)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (!/^(?:RK_CONTEXT_BUDGET_EXCEEDED|OBSERVATION_CONTEXT_[A-Z_]+)$/.test(code)) throw error
      // A deterministic local rejection must not become a retryable bridge 500.
      // Do not use 413/context_length_exceeded: Harness interprets those as a
      // request to spend another model call summarizing the same context.
      // A local contract failure is a final 400; no RK/provider call has started.
      return new Response(
        JSON.stringify({ error: { message: code, type: 'invalid_request_error', code } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )
    }
    const result = await complete(system, messages, signal, outputTokens)
    const answer = normalizeToolEnvelopes(
      typeof result === 'string' ? result : result.text,
      system.includes('coloop_recommend'),
    )
    signal.throwIfAborted()
    const id = 'chatcmpl-rk-' + randomUUID()
    const chunks = [{ content: answer }, {}]
      .map(
        (delta, index) =>
          'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: index
                  ? typeof result === 'string'
                    ? 'stop'
                    : result.finishReason
                  : null,
              },
            ],
            ...(typeof result === 'string'
              ? {}
              : {
                  usage: {
                    prompt_tokens: result.promptTokens,
                    completion_tokens: result.completionTokens,
                  },
                }),
          }) +
          '\n\n',
      )
      .join('')
    return new Response(chunks + 'data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}
