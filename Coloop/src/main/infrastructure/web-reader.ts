import { chromium, type Browser } from 'playwright-core'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WebSession } from './web-session'
import { StagehandRuntime } from './stagehand-runtime'
import type { StagehandCompletion } from './stagehand-model'

export const webReadSchema = z
  .object({
    url: z.string().url().max(4000),
    start_character: z.number().int().nonnegative().default(0),
    wait_ms: z.number().int().min(0).max(10000).default(0),
    max_characters: z.number().int().min(1).max(8000).default(3000),
  })
  .strict()

function protectedHost(host: string) {
  host = host.replace(/\.$/, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.') ||
    host.startsWith('[') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
}
export function validateWebReadUrl(value: string, goal: string) {
  if (value.length > 4000) throw new Error('WEB_URL_TOO_LONG')
  const url = new URL(value)
  if (url.username || url.password) throw new Error('WEB_URL_CREDENTIALS_FORBIDDEN')
  const local = protectedHost(url.hostname)
  if (!['https:', 'http:'].includes(url.protocol) || (!local && url.protocol !== 'https:'))
    throw new Error('WEB_URL_REQUIRES_HTTPS')
  if (local) {
    const authorized = (goal.match(/https?:\/\/[^\s<>"']+/g) ?? []).some((value) => {
      try {
        const explicit = new URL(value)
        return explicit.origin === url.origin && explicit.pathname === url.pathname
      } catch {
        return false
      }
    })
    if (!authorized) throw new Error('LOCAL_WEB_URL_REQUIRES_EXPLICIT_TASK_URL')
  }
  return url.href
}

/** Owns an isolated Edge context for each read, separate from personal browser sessions. */
export class WebReader {
  private stagehandSessions = new Set<StagehandRuntime>()
  private browser?: Browser
  private opening?: Promise<Browser>
  constructor(private readonly headless = false) {}
  private async connect() {
    if (this.browser?.isConnected()) return this.browser
    this.opening ??= chromium
      .launch({ channel: 'msedge', headless: this.headless })
      .then((browser) => {
        this.browser = browser
        return browser
      })
      .finally(() => {
        this.opening = undefined
      })
    return this.opening
  }
  async read(input: unknown, goal: string, signal: AbortSignal) {
    const request = webReadSchema.parse(input)
    const url = validateWebReadUrl(request.url, goal)
    signal.throwIfAborted()
    const browser = await this.connect()
    signal.throwIfAborted()
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
    })
    const stop = () => {
      void context.close().catch(() => {})
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      const page = await context.newPage()
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      if (!response || response.status() >= 400)
        throw new Error(`WEB_SOURCE_HTTP_${response?.status() ?? 'UNAVAILABLE'}`)
      if (/application\/pdf/i.test(response.headers()['content-type'] ?? ''))
        throw new Error('WEB_SOURCE_IS_PDF')
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})
      if (request.wait_ms) await page.waitForTimeout(request.wait_ms)
      signal.throwIfAborted()
      const sourceUrl = validateWebReadUrl(page.url(), goal)
      const title = await page.title()
      const text = await page.locator('body').innerText({ timeout: 10000 })
      const characters = Array.from(text)
      if (request.start_character > characters.length)
        throw new Error('WEB_TEXT_OFFSET_OUT_OF_RANGE')
      const end = Math.min(characters.length, request.start_character + request.max_characters)
      const links: { text: string; url: string }[] = []
      const anchors = page.locator('a[href]')
      for (
        let index = 0;
        index < Math.min(await anchors.count(), 120) && links.length < 40;
        index++
      ) {
        const anchor = anchors.nth(index)
        if (!(await anchor.isVisible())) continue
        const label = (await anchor.innerText({ timeout: 1000 })).trim()
        const href = await anchor.getAttribute('href')
        if (!label || !href) continue
        try {
          links.push({
            text: label.slice(0, 200),
            url: validateWebReadUrl(new URL(href, sourceUrl).href, goal),
          })
        } catch {
          /* Keep navigable task-permitted links. */
        }
      }
      if (page.url() !== sourceUrl) throw new Error('WEB_PAGE_CHANGED_DURING_READ')
      signal.throwIfAborted()
      return {
        requested_url: url,
        source_url: sourceUrl,
        title,
        retrieved_at: new Date().toISOString(),
        text: characters.slice(request.start_character, end).join(''),
        character_count: characters.length,
        range: [request.start_character, end],
        truncated: end < characters.length,
        next_character: end < characters.length ? end : undefined,
        links,
        sha256: createHash('sha256').update(text).digest('hex'),
        channel: 'host_browser',
      }
    } finally {
      signal.removeEventListener('abort', stop)
      await context.close().catch(() => {})
    }
  }
  async session(goal: string, signal: AbortSignal, complete?: StagehandCompletion) {
    signal.throwIfAborted()
    if (complete) {
      const runtime = await StagehandRuntime.open({
        goal,
        signal,
        complete,
        headless: this.headless,
        onClosed: (closed) => this.stagehandSessions.delete(closed),
      })
      this.stagehandSessions.add(runtime)
      if (signal.aborted) {
        await runtime.close()
        this.stagehandSessions.delete(runtime)
        signal.throwIfAborted()
      }
      return new WebSession(runtime.context, goal, signal, runtime)
    }
    const browser = await this.connect()
    signal.throwIfAborted()
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
    })
    if (signal.aborted) {
      await context.close()
      signal.throwIfAborted()
    }
    return new WebSession(context, goal, signal)
  }
  async dispose() {
    await Promise.allSettled([...this.stagehandSessions].map((runtime) => runtime.close()))
    this.stagehandSessions.clear()
    const browser = this.browser ?? (await this.opening?.catch(() => undefined))
    await browser?.close().catch(() => {})
    this.browser = undefined
  }
}
