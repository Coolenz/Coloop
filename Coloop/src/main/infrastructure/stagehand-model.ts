import type { ClientLLM } from '@browserbasehq/stagehand'
import { z } from 'zod'
import { parseStrictJson } from '../domain/strict-json'

export interface StagehandCompletionRequest {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  schema?: Record<string, unknown>
  schemaName?: string
  temperature?: number
}

/** The owning task supplies the already authorized and metered model route.
 * This adapter has no provider credentials, endpoint or network fallback. */
export type StagehandCompletion = (
  request: StagehandCompletionRequest,
  signal: AbortSignal,
) => Promise<string>

export function createStagehandModel(
  complete: StagehandCompletion,
  signal: AbortSignal,
  inferenceAllowed: () => boolean,
): ClientLLM {
  return {
    generate: async (request) => {
      signal.throwIfAborted()
      if (!inferenceAllowed()) throw new Error('STAGEHAND_MODEL_CALL_OUTSIDE_READ')
      const messages = request.messages.map((message) => {
        const blocks = Array.isArray(message.content) ? message.content : [message.content]
        if (blocks.some((block) => block.type !== 'text'))
          throw new Error('STAGEHAND_IMAGE_MODEL_INPUT_DISABLED')
        return {
          role: message.role,
          content: blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
        }
      })
      const format = request.responseFormat
      const input: StagehandCompletionRequest = {
        system: request.systemPrompt ?? '',
        messages,
        ...(format?.type === 'json_schema'
          ? { schema: format.schema as Record<string, unknown>, schemaName: format.name }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 512_000)
        throw new Error('STAGEHAND_MODEL_INPUT_TOO_LARGE')
      const text = await complete(input, signal)
      signal.throwIfAborted()
      if (!text.trim() || Buffer.byteLength(text, 'utf8') > 128_000)
        throw new Error('STAGEHAND_MODEL_OUTPUT_INVALID')
      const content = { type: 'text' as const, text }
      return format?.type === 'json_schema'
        ? {
            role: 'assistant' as const,
            content,
            outputFormat: 'json_schema' as const,
            structuredContent: z.record(z.string(), z.json()).parse(parseStrictJson(text)),
          }
        : { role: 'assistant' as const, content, outputFormat: 'text' as const }
    },
  }
}
