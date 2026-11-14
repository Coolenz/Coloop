import { randomUUID } from 'node:crypto'
import { providerSchema } from '../../shared/contracts'
import type { DecisionModelRoute } from './model-role'
import type { ModelUsageLedger } from './model-usage'

type Row = Record<string, any>
interface Options {
  fetch?: typeof fetch
  usage?: ModelUsageLedger
  taskId: string
}

function image(value: unknown) {
  const match =
    typeof value === 'string' &&
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) throw new Error('DECISION_IMAGE_INVALID')
  return { mimeType: match[1], data: match[2] }
}
function parts(content: unknown): Row[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return part
    if (part?.type === 'image_url') return { type: 'image', ...image(part.image_url?.url) }
    throw new Error('DECISION_CONTENT_UNSUPPORTED')
  })
}
function toolArguments(value: unknown): Row {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('DECISION_TOOL_ARGUMENTS_INVALID')
  return parsed
}
async function responseText(response: Response, signal?: AbortSignal | null) {
  if (!response.body) throw new Error('DECISION_RESPONSE_EMPTY')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0,
    text = ''
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new Error('DECISION_RESPONSE_TOO_LARGE')
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function sse(body: Row, source: Row): Response {
  const id = source.id ?? source.responseId ?? `decision-${randomUUID()}`
  const message = body.choices[0].message
  const delta = {
    role: 'assistant',
    content: message.content || '',
    ...(message.tool_calls?.length
      ? { tool_calls: message.tool_calls.map((call: Row, index: number) => ({ index, ...call })) }
      : {}),
  }
  const base = {
    id,
    model: body.model,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
  }
  return new Response(
    'data: ' +
      JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: body.choices[0].finish_reason }],
        usage: body.usage,
      }) +
      '\n\n' +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

/** Protocol adapter only. The official Harness owns reasoning, tool dispatch,
 * continuation and cancellation. This function never retries or chooses a
 * different provider. Metering wraps the actual provider request. */
export function createDecisionModelFetch(
  route: DecisionModelRoute,
  options: Options,
): typeof fetch {
  const selected = structuredClone(route)
  const provider = providerSchema.parse(selected.provider)
  const base = provider.baseUrl.replace(/\/+$/, '')
  const endpoint = new URL(base)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  const transport = options.usage
    ? options.usage.wrap(options.fetch ?? globalThis.fetch, {
        taskId: options.taskId,
        source: 'auto_work_decision',
        role: selected.role,
        pricing: selected.pricing,
      })
    : (options.fetch ?? globalThis.fetch)
  // Gemini signatures belong to the exact model turn, not user preferences.
  const signatures = new Map<string, string>()
  const nativeIds = new Set<string>()
  return async (input, init) => {
    if (!selected.apiKey && !local) throw new Error('DECISION_MODEL_KEY_REQUIRED')
    const inputUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (inputUrl !== base + '/chat/completions' || typeof init?.body !== 'string')
      throw new Error('DECISION_MODEL_ROUTE_INVALID')
    init.signal?.throwIfAborted()
    const body = JSON.parse(init.body) as Row
    if (body.model !== provider.model || !Array.isArray(body.messages))
      throw new Error('DECISION_MODEL_ROUTE_INVALID')
    const hasImage = body.messages.some((message: Row) =>
      parts(message.content).some((part) => part.type === 'image'),
    )
    if (hasImage && provider.imageInput !== 'supported')
      throw new Error('DECISION_IMAGE_CAPABILITY_REQUIRED')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    let url = base + '/chat/completions'
    let payload: Row = body
    const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 8192
    if (provider.protocol === 'openai') {
      headers.authorization = `Bearer ${selected.apiKey}`
    } else if (provider.protocol === 'anthropic') {
      url = base + '/messages'
      headers['x-api-key'] = selected.apiKey
      headers['anthropic-version'] = '2023-06-01'
      const messages: Row[] = []
      const systems: string[] = []
      for (const message of body.messages) {
        if (['system', 'developer'].includes(message.role)) {
          systems.push(
            parts(message.content)
              .map((part) => part.text ?? '')
              .join('\n'),
          )
          continue
        }
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const content: Row[] =
          message.role === 'tool'
            ? [
                {
                  type: 'tool_result',
                  tool_use_id: message.tool_call_id,
                  content:
                    typeof message.content === 'string'
                      ? message.content
                      : JSON.stringify(message.content),
                },
              ]
            : parts(message.content).map((part) =>
                part.type === 'image'
                  ? {
                      type: 'image',
                      source: { type: 'base64', media_type: part.mimeType, data: part.data },
                    }
                  : { type: 'text', text: part.text },
              )
        for (const call of message.tool_calls ?? [])
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: toolArguments(call.function.arguments),
          })
        if (!content.length) continue
        if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content)
        else messages.push({ role, content })
      }
      payload = {
        model: provider.model,
        system: systems.join('\n\n'),
        messages,
        max_tokens: maxTokens,
        stream: false,
        ...(body.tools?.length && body.tool_choice !== 'none'
          ? {
              tools: body.tools.map((tool: Row) => ({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
              })),
              tool_choice: {
                type:
                  body.tool_choice === 'required'
                    ? 'any'
                    : body.tool_choice?.function?.name
                      ? 'tool'
                      : 'auto',
                ...(body.tool_choice?.function?.name
                  ? { name: body.tool_choice.function.name }
                  : {}),
                ...(body.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}),
              },
            }
          : {}),
      }
    } else {
      url = base + '/models/' + encodeURIComponent(provider.model) + ':generateContent'
      headers['x-goog-api-key'] = selected.apiKey
      const systems: string[] = []
      const contents: Row[] = []
      const names = new Map<string, string>()
      for (const message of body.messages)
        for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name)
      for (const message of body.messages) {
        if (['system', 'developer'].includes(message.role)) {
          systems.push(
            parts(message.content)
              .map((part) => part.text ?? '')
              .join('\n'),
          )
          continue
        }
        const role = message.role === 'assistant' ? 'model' : 'user'
        const converted: Row[] =
          message.role === 'tool'
            ? [
                {
                  functionResponse: {
                    name:
                      names.get(message.tool_call_id) ??
                      (() => {
                        throw new Error('DECISION_TOOL_CALL_UNKNOWN')
                      })(),
                    response: { result: message.content },
                    ...(nativeIds.has(message.tool_call_id) ? { id: message.tool_call_id } : {}),
                  },
                },
              ]
            : parts(message.content).map((part) =>
                part.type === 'image'
                  ? { inlineData: { mimeType: part.mimeType, data: part.data } }
                  : { text: part.text },
              )
        for (const call of message.tool_calls ?? [])
          converted.push({
            functionCall: {
              name: call.function.name,
              args: toolArguments(call.function.arguments),
              ...(nativeIds.has(call.id) ? { id: call.id } : {}),
            },
            ...(signatures.has(call.id) ? { thoughtSignature: signatures.get(call.id) } : {}),
          })
        if (!converted.length) continue
        if (contents.at(-1)?.role === role) contents.at(-1)!.parts.push(...converted)
        else contents.push({ role, parts: converted })
      }
      payload = {
        systemInstruction: { parts: [{ text: systems.join('\n\n') }] },
        contents,
        generationConfig: { maxOutputTokens: maxTokens },
        ...(body.tools?.length && body.tool_choice !== 'none'
          ? {
              tools: [
                {
                  functionDeclarations: body.tools.map((tool: Row) => ({
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                  })),
                },
              ],
              toolConfig: {
                functionCallingConfig: {
                  mode:
                    body.tool_choice === 'required' || body.tool_choice?.function?.name
                      ? 'ANY'
                      : 'AUTO',
                  ...(body.tool_choice?.function?.name
                    ? { allowedFunctionNames: [body.tool_choice.function.name] }
                    : {}),
                },
              },
            }
          : {}),
      }
    }
    const response = await transport(url, {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
    })
    if (provider.protocol === 'openai' || !response.ok) return response
    // A bounded non-streamed provider exchange is normalized to the SDK's
    // OpenAI stream without running a second model or losing tool-call IDs.
    const text = await responseText(response, init.signal)
    init.signal?.throwIfAborted()
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('DECISION_RESPONSE_TOO_LARGE')
    const result = JSON.parse(text) as Row
    const calls: Row[] = []
    let answer = '',
      finish = 'stop'
    let usage: Row | undefined
    if (provider.protocol === 'anthropic') {
      if (result.type !== 'message' || !Array.isArray(result.content))
        throw new Error('DECISION_RESPONSE_INVALID')
      for (const part of result.content) {
        if (part.type === 'text') answer += part.text
        else if (part.type === 'tool_use')
          calls.push({
            id: part.id,
            type: 'function',
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          })
        else if (!['thinking', 'redacted_thinking'].includes(part.type))
          throw new Error('DECISION_RESPONSE_INVALID')
      }
      finish = result.stop_reason === 'max_tokens' ? 'length' : calls.length ? 'tool_calls' : 'stop'
      if (!['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'].includes(result.stop_reason))
        throw new Error('DECISION_RESPONSE_INCOMPLETE')
      if (result.usage)
        usage = {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
        }
    } else {
      const candidate = result.candidates?.[0]
      if (
        result.promptFeedback?.blockReason ||
        !candidate ||
        !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)
      )
        throw new Error('DECISION_RESPONSE_INCOMPLETE')
      for (const part of candidate.content?.parts ?? []) {
        if (typeof part.text === 'string' && !part.thought) answer += part.text
        if (part.functionCall) {
          const id = part.functionCall.id ?? `call_${randomUUID().replace(/-/g, '')}`
          if (part.functionCall.id) nativeIds.add(id)
          if (part.thoughtSignature) signatures.set(id, part.thoughtSignature)
          calls.push({
            id,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          })
        }
      }
      finish =
        candidate.finishReason === 'MAX_TOKENS' ? 'length' : calls.length ? 'tool_calls' : 'stop'
      if (result.usageMetadata)
        usage = {
          prompt_tokens: result.usageMetadata.promptTokenCount,
          completion_tokens: result.usageMetadata.candidatesTokenCount,
          total_tokens: result.usageMetadata.totalTokenCount,
        }
    }
    if (!answer && !calls.length) throw new Error('DECISION_RESPONSE_EMPTY')
    return sse(
      {
        model: provider.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: answer,
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      },
      result,
    )
  }
}
