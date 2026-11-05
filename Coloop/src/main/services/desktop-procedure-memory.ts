import { z } from 'zod'
import { parseStrictJson } from '../domain/strict-json'
import { browserTaskOf, isBrowserPilot } from './browser-task'

export const procedureMemoryKey = 'procedure:coloop:bilibili-triple:mouse-v1'
export const procedureContract = {
  version: 1,
  capability: 'bilibili_video_triple_mouse_v1',
  backend: 'rk_usb_hid',
  steps: [
    'click_chrome_icon',
    'click_home_tab',
    'choose_home_video',
    'like',
    'coin_one',
    'favorite_default',
    'verify_three',
    'cloud_review',
  ],
  guards: [
    'mouse_only',
    'fresh_uia_ocr',
    'same_hwnd_pid',
    'one_coin',
    'skip_active',
    'no_unknown_replay',
  ],
} as const
const recipeSchema = z
  .object({
    version: z.literal(1),
    capability: z.literal(procedureContract.capability),
    backend: z.literal('rk_usb_hid'),
    steps: z.array(z.string()).length(procedureContract.steps.length),
    guards: z.array(z.string()).length(procedureContract.guards.length),
    sourceEpisode: z.string().min(1).max(300),
    cloudSummaryVerified: z.literal(false),
    cloudReview: z
      .object({
        summary: z.string().min(1).max(160),
        lessons: z.array(z.string().min(1).max(60)).max(2),
      })
      .strict()
      .optional(),
    measurement: z
      .object({
        scope: z.enum(['command_to_end', 'rk_runtime_to_business_verified']),
        elapsedMs: z.number().finite().positive(),
      })
      .strict(),
  })
  .strict()

export interface RecalledProcedure {
  id: string
  kind: 'procedure'
  source: 'agent'
  verified: false
  value: z.infer<typeof recipeSchema>
}
interface Options {
  call: (input: { op: 'get' | 'set'; value?: string }) => Promise<unknown>
}

/** Memory is data: only a code-owned exact recipe can select an existing capability. */
export class DesktopProcedureMemory {
  constructor(private options: Options) {}
  async recall(goal: string, signal: AbortSignal): Promise<RecalledProcedure | null> {
    signal.throwIfAborted()
    if (!isBrowserPilot(goal) || browserTaskOf(goal) !== 'video-triple') return null
    const raw = await this.options.call({ op: 'get' })
    signal.throwIfAborted()
    const envelope = z.object({ memory: z.unknown().nullable() }).parse(raw)
    if (!envelope.memory) return null
    const row = z
      .object({
        id: z.string().min(1),
        key: z.literal(procedureMemoryKey),
        kind: z.literal('procedure'),
        source: z.literal('agent'),
        verified: z.union([z.literal(false), z.literal(0)]),
        value: z.string().max(1000),
      })
      .passthrough()
      .parse(envelope.memory)
    const value = recipeSchema.parse(parseStrictJson(row.value))
    if (
      JSON.stringify(value.steps) !== JSON.stringify(procedureContract.steps) ||
      JSON.stringify(value.guards) !== JSON.stringify(procedureContract.guards)
    )
      throw new Error('PROCEDURE_CONTRACT_CHANGED')
    return { id: row.id, kind: 'procedure', source: 'agent', verified: false, value }
  }
  async remember(
    sourceEpisode: string,
    elapsedMs: number,
    scope: 'command_to_end' | 'rk_runtime_to_business_verified',
    signal: AbortSignal,
    review?: { summary: string; lessons: string[] },
  ) {
    signal.throwIfAborted()
    const value = recipeSchema.parse({
      ...procedureContract,
      sourceEpisode,
      cloudSummaryVerified: false,
      ...(review
        ? {
            cloudReview: {
              summary: Array.from(review.summary).slice(0, 160).join(''),
              lessons: review.lessons.slice(0, 2).map((s) => Array.from(s).slice(0, 60).join('')),
            },
          }
        : {}),
      measurement: { scope, elapsedMs },
    })
    const encoded = JSON.stringify(value)
    if (encoded.length > 1000) throw new Error('PROCEDURE_VALUE_LIMIT')
    const result = await this.options.call({ op: 'set', value: encoded })
    signal.throwIfAborted()
    return result
  }
}
