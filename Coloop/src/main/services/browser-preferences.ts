import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { localBrowserEndpointSchema } from '../infrastructure/browser-connection'

export const browserSettingsSchema = z
  .object({
    browser: z.enum(['edge', 'chrome']).default('edge'),
    connection: z.enum(['existing', 'managed']).optional(),
    cdpUrl: localBrowserEndpointSchema.optional(),
    profileDirectory: z
      .string()
      .regex(/^(?!\.{1,2}$)[A-Za-z0-9 _.-]{1,100}$/)
      .optional(),
    viewport: z
      .object({
        width: z.number().int().min(640).max(3840),
        height: z.number().int().min(480).max(2160),
      })
      .strict()
      .default({ width: 1440, height: 1000 }),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .default('zh-CN'),
  })
  .strict()
export type BrowserSettings = z.infer<typeof browserSettingsSchema>
export const browserConfigSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z
    .object({
      operation: z.literal('configure'),
      settings: browserSettingsSchema,
      remember: z.boolean().default(false),
      source_quote: z.string().trim().min(1).max(2000),
    })
    .strict(),
])
type Row = Record<string, unknown>
export interface BrowserMemory {
  catalog(value: Row): Promise<unknown>
  get(value: Row): Promise<unknown>
  remember(value: Row): Promise<unknown>
}
const key = 'preference:coloop:browser'
const envelope = z.object({
  ok: z.literal(true),
  result: z.object({
    memories: z.array(z.object({ id: z.string() }).passthrough()).max(5),
    deferred: z.boolean().optional(),
    missing: z.array(z.string()).optional(),
  }),
})
// Only parse direct browser-use instructions, never bare names in URLs or prose.
export function requestedBrowser(text: string): BrowserSettings['browser'] | undefined {
  let selected: BrowserSettings['browser'] | undefined
  for (const clause of text.replace(/https?:\/\/\S+/g, '').split(/[。！？!?\n；;]/)) {
    const positive = clause.replace(
      /(?:(?:不要|不|别|禁止)(?:使用|用)?|do not use|don't use)\s*(?:edge|chrome|谷歌|微软(?:浏览器)?)/gi,
      '',
    )
    const matches = positive.matchAll(
      /(?:使用|用|通过|在|use\s+|using\s+|in\s+)\s*(?:微软\s*)?(edge|chrome|谷歌)(?![a-z])|\b(edge|chrome)\s*浏览器(?:打开|访问|操作)/gi,
    )
    for (const match of matches) selected = /edge/i.test(match[1] ?? match[2]) ? 'edge' : 'chrome'
  }
  return selected
}
function futureBrowser(text: string) {
  for (const clause of text.split(/[，,。！？!?\n；;]/).reverse()) {
    if (/以后|今后|默认|记住|偏好|from now|default|remember|prefer/i.test(clause)) {
      const browser = requestedBrowser(clause)
      if (browser) return browser
    }
  }
}
export function taskBrowser(text: string) {
  const current = text
    .split(/[，,。！？!?\n；;]/)
    .filter((clause) => !/以后|今后|默认|记住|偏好|from now|default|remember|prefer/i.test(clause))
    .join('。')
  return requestedBrowser(current) ?? futureBrowser(text)
}
function settingsFromRecord(record: Row): BrowserSettings | undefined {
  if (
    record.kind !== 'preference' ||
    record.protected ||
    record.category === 'private' ||
    typeof record.key !== 'string' ||
    !record.key.startsWith('preference:coloop:') ||
    typeof record.value !== 'string'
  )
    return
  try {
    const value = JSON.parse(record.value)
    if (!value || !['edge', 'chrome'].includes(value.browser)) return
    return browserSettingsSchema.parse(value)
  } catch {
    if (!/浏览器|browser|edge|chrome/i.test(record.value)) return
    const browser = requestedBrowser(record.value)
    if (browser) return browserSettingsSchema.parse({ browser })
  }
}

/** Applies only bounded launch settings from memory. Memory text never becomes commands. */
export class BrowserPreferences {
  constructor(private memory: BrowserMemory) {}
  private async records() {
    const directory = envelope.parse(
      await this.memory.catalog({
        query: '浏览器 browser Edge Chrome',
        tags: ['user_preference'],
        limit: 5,
      }),
    ).result
    if (directory.deferred) throw new Error('BROWSER_MEMORY_DEFERRED')
    const ids = directory.memories.map((item) => item.id)
    if (!ids.length) return []
    const result = envelope.parse(await this.memory.get({ ids })).result
    if (result.deferred) throw new Error('BROWSER_MEMORY_DEFERRED')
    const returned = [...result.memories.map((item) => item.id), ...(result.missing ?? [])]
    if (
      new Set(returned).size !== returned.length ||
      returned.length !== ids.length ||
      returned.some((id) => !ids.includes(id))
    )
      throw new Error('BROWSER_MEMORY_INVALID')
    return result.memories
  }
  async resolve(goal: string, taskId: string = randomUUID(), persist = true) {
    const explicit = taskBrowser(goal)
    let settings = browserSettingsSchema.parse({})
    let source = 'default'
    let memoryError: string | undefined
    try {
      const records = await this.records()
      const preferred = records.find(
        (item) => item.key === key || String(item.key).endsWith(':browser'),
      )
      const candidates = records.map(settingsFromRecord).filter((item) => item !== undefined)
      const saved = preferred ? settingsFromRecord(preferred) : candidates[0]
      if (saved) {
        settings = saved
        source = 'memory'
      }
    } catch (error) {
      memoryError = error instanceof Error ? error.message : 'BROWSER_MEMORY_UNAVAILABLE'
    }
    if (explicit) {
      settings = { ...settings, browser: explicit }
      source = 'task'
    }
    let remembered = false
    const future = futureBrowser(goal)
    if (future && persist) {
      await this.save({ ...settings, browser: future }, taskId)
      remembered = true
      memoryError = undefined
    }
    return { settings, source, remembered, memoryError }
  }
  private async save(settings: BrowserSettings, taskId: string) {
    await this.memory.remember({ key, value: JSON.stringify(settings), source_task_id: taskId })
    const records = await this.records()
    if (
      !records.some(
        (item) =>
          String(item.key).endsWith(':browser') &&
          JSON.stringify(settingsFromRecord(item)) === JSON.stringify(settings),
      )
    ) {
      throw new Error('BROWSER_PREFERENCE_READBACK_FAILED')
    }
  }
  async configure(input: unknown, goal: string, taskId: string) {
    const request = browserConfigSchema.parse(input)
    if (request.operation === 'inspect') return this.resolve(goal, taskId, false)
    if (!goal.includes(request.source_quote)) throw new Error('BROWSER_CONFIG_REQUIRES_USER_QUOTE')
    const explicit = taskBrowser(goal)
    if (explicit && request.settings.browser !== explicit)
      throw new Error('BROWSER_TASK_SELECTION_CONFLICT')
    if (requestedBrowser(request.source_quote) !== request.settings.browser)
      throw new Error('BROWSER_CONFIG_REQUIRES_BROWSER_INSTRUCTION')
    if (request.remember) {
      if (futureBrowser(request.source_quote) !== request.settings.browser)
        throw new Error('BROWSER_PREFERENCE_REQUIRES_FUTURE_INSTRUCTION')
      await this.save(request.settings, taskId)
    }
    return { settings: request.settings, source: 'task', remembered: request.remember }
  }
}
