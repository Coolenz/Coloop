import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { join } from 'node:path'
import { discoverBrowserEndpoint } from './browser-connection'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { WebSession } from './web-session'
import { StagehandRuntime } from './stagehand-runtime'
import type { StagehandCompletion } from './stagehand-model'
import {
  browserSettingsSchema,
  taskBrowser,
  type BrowserPreferences,
  type BrowserSettings,
} from '../services/browser-preferences'

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
  private browsers = new Map<string, Browser>()
  private openings = new Map<string, Promise<Browser>>()
  private profileOpenings = new Set<string>()
  private persistentContexts = new Map<BrowserContext, { path: string; handedOff: boolean }>()
  constructor(
    private readonly headless = false,
    private readonly preferences?: BrowserPreferences,
    private readonly profileRoot?: string,
    private readonly preferExisting = false,
  ) {}
  private async connect(browserName: 'edge' | 'chrome' = 'edge') {
    const existing = this.browsers.get(browserName)
    if (existing?.isConnected()) return existing
    const pending = this.openings.get(browserName)
    if (pending) return pending
    const opening = chromium
      .launch({ channel: browserName === 'edge' ? 'msedge' : 'chrome', headless: this.headless })
      .then((browser) => {
        this.browsers.set(browserName, browser)
        return browser
      })
      .finally(() => {
        this.openings.delete(browserName)
      })
    this.openings.set(browserName, opening)
    return opening
  }
  async read(input: unknown, goal: string, signal: AbortSignal) {
    const request = webReadSchema.parse(input)
    const url = validateWebReadUrl(request.url, goal)
    signal.throwIfAborted()
    const selection = await this.preferences?.resolve(goal)
    const settings = selection?.settings ?? browserSettingsSchema.parse({})
    signal.throwIfAborted()
    const browser = await this.connect(settings.browser)
    signal.throwIfAborted()
    const context = await browser.newContext({
      acceptDownloads: false,
      viewport: settings.viewport,
      locale: settings.locale,
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
        browser: selection ?? { settings, source: 'default' },
      }
    } finally {
      signal.removeEventListener('abort', stop)
      await context.close().catch(() => {})
    }
  }
  async session(
    goal: string,
    signal: AbortSignal,
    complete?: StagehandCompletion,
    taskId?: string,
    configured?: BrowserSettings,
  ) {
    signal.throwIfAborted()
    const recalled = (await this.preferences?.resolve(goal, taskId)) ?? {
      settings: browserSettingsSchema.parse({}),
      source: 'default',
      remembered: false,
    }
    const explicit = taskBrowser(goal)
    const selection = {
      ...recalled,
      settings: {
        ...(configured ?? recalled.settings),
        browser: explicit ?? configured?.browser ?? recalled.settings.browser,
      },
      source: explicit || configured ? 'task' : recalled.source,
    }
    signal.throwIfAborted()
    const existing =
      selection.settings.connection === 'existing' ||
      (!selection.settings.connection && this.preferExisting)
    const cdpUrl = existing
      ? (selection.settings.cdpUrl ?? (await discoverBrowserEndpoint(selection.settings.browser)))
      : undefined
    const userDataDir =
      (!existing && this.profileRoot && join(this.profileRoot, selection.settings.browser)) ||
      undefined
    if (userDataDir && this.profileOpenings.has(userDataDir))
      throw new Error('BROWSER_PROFILE_IN_USE')
    if (userDataDir) this.profileOpenings.add(userDataDir)
    try {
      if (userDataDir) {
        for (const runtime of this.stagehandSessions) {
          if (runtime.userDataDir !== userDataDir) continue
          if (!runtime.handedOff && runtime.connected) throw new Error('BROWSER_PROFILE_IN_USE')
          await runtime.close()
        }
        for (const [context, state] of this.persistentContexts) {
          if (state.path !== userDataDir) continue
          if (!state.handedOff) throw new Error('BROWSER_PROFILE_IN_USE')
          await context.close()
        }
      }
      signal.throwIfAborted()
      if (complete || cdpUrl) {
        if (
          cdpUrl &&
          [...this.stagehandSessions].some((runtime) => runtime.attached && runtime.connected)
        )
          throw new Error('BROWSER_SESSION_IN_USE')
        const runtime = await StagehandRuntime.open({
          goal,
          signal,
          complete:
            complete ??
            (async () => {
              throw new Error('STAGEHAND_MODEL_NOT_CONFIGURED')
            }),
          headless: this.headless,
          browserSettings: selection.settings,
          userDataDir,
          cdpUrl,
          onClosed: (closed) => this.stagehandSessions.delete(closed),
        })
        this.stagehandSessions.add(runtime)
        if (signal.aborted) {
          await runtime.close()
          this.stagehandSessions.delete(runtime)
          signal.throwIfAborted()
        }
        return new WebSession(runtime.context, goal, signal, runtime, {
          ...selection,
          actual: runtime.identity,
          verified: true,
          persistent: !!userDataDir,
          connection: existing ? 'existing' : 'managed',
        })
      }
      const contextOptions = {
        acceptDownloads: true,
        viewport: selection.settings.viewport,
        locale: selection.settings.locale,
      }
      const context = userDataDir
        ? await chromium.launchPersistentContext(userDataDir, {
            ...contextOptions,
            channel: selection.settings.browser === 'edge' ? 'msedge' : 'chrome',
            headless: this.headless,
          })
        : await (await this.connect(selection.settings.browser)).newContext(contextOptions)
      if (userDataDir) {
        this.persistentContexts.set(context, { path: userDataDir, handedOff: false })
        context.once('close', () => this.persistentContexts.delete(context))
      }
      if (signal.aborted) {
        await context.close()
        signal.throwIfAborted()
      }
      try {
        const identityPage = await context.newPage()
        const userAgent = await identityPage.evaluate(() => navigator.userAgent)
        if ((selection.settings.browser === 'edge') !== userAgent.includes('Edg/'))
          throw new Error('BROWSER_SELECTION_MISMATCH')
        await identityPage.close()
        return new WebSession(
          context,
          goal,
          signal,
          undefined,
          {
            ...selection,
            actual: { browser: selection.settings.browser, userAgent },
            verified: true,
            persistent: !!userDataDir,
          },
          () => {
            const state = this.persistentContexts.get(context)
            if (state) state.handedOff = true
          },
        )
      } catch (error) {
        await context.close()
        throw error
      }
    } finally {
      if (userDataDir) this.profileOpenings.delete(userDataDir)
    }
  }
  async dispose() {
    await Promise.allSettled([...this.stagehandSessions].map((runtime) => runtime.close()))
    this.stagehandSessions.clear()
    await Promise.allSettled([...this.persistentContexts.keys()].map((context) => context.close()))
    this.persistentContexts.clear()
    await Promise.allSettled(this.openings.values())
    await Promise.allSettled([...this.browsers.values()].map((browser) => browser.close()))
    this.browsers.clear()
  }
}
