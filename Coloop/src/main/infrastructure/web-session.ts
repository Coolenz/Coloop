import { createHash, randomUUID } from 'node:crypto'
import type { BrowserContext, ElementHandle, Page, Dialog } from 'playwright-core'
import { z } from 'zod'
import { validateWebReadUrl } from './web-reader'
import type { WorkspaceSession } from '../services/workspace-session'
import type { StagehandRuntime } from './stagehand-runtime'

const pageRange = {
  start_character: z.number().int().nonnegative().default(0),
  start_control: z.number().int().nonnegative().default(0),
}
export const webSessionSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('discover'),
      observation_id: z.string().uuid(),
      instruction: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('extract'),
      observation_id: z.string().uuid(),
      instruction: z.string().trim().min(1).max(2000),
      fields: z
        .array(
          z
            .object({
              name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
              description: z.string().trim().min(1).max(300),
              type: z.enum(['string', 'number', 'boolean']),
            })
            .strict(),
        )
        .min(1)
        .max(16)
        .refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length),
    })
    .strict(),
  z.object({ operation: z.literal('navigate'), url: z.string().url().max(4000) }).strict(),
  z
    .object({
      operation: z.literal('observe'),
      ...pageRange,
      wait_ms: z.number().int().min(0).max(10000).default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal('act'),
      observation_id: z.string().uuid(),
      target_id: z.number().int().nonnegative(),
      action: z.enum(['click', 'fill', 'select', 'check', 'upload']),
      value: z.string().max(32000).optional(),
      path: z.string().min(1).max(2048).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('download'),
      observation_id: z.string().uuid(),
      target_id: z.number().int().nonnegative(),
      path: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      operation: z.literal('verify'),
      observation_id: z.string().uuid(),
      expected_text: z.string().trim().min(1).max(4000),
      keep_open: z.boolean().default(false),
    })
    .strict(),
])

type Target = {
  id: number
  tag: string
  type: string
  label: string
  value: string
  href?: string
  checked: boolean | undefined
  options: { label: string; value: string }[] | undefined
}
type Observed = {
  id: string
  url: string
  text: string
  targets: Target[]
  handles: ElementHandle<Node>[]
  signature: string
}

/** One task owns one isolated browser context and the handles from its latest observation. */
export class WebSession {
  private page?: Page
  private observed?: Observed
  private initialText?: string
  private navigationUrl?: string
  private effects = 0
  private disposed = false
  private retainOnSuccess = false
  private closing?: Promise<void>
  private permittedOrigins: Set<string>
  private stop: () => void
  private closePopup = (popup: Page) => {
    void popup.close().catch(() => {})
  }
  private dismissDialog = (dialog: Dialog) => {
    void dialog.dismiss().catch(() => {})
  }
  constructor(
    private context: BrowserContext,
    private goal: string,
    private signal: AbortSignal,
    private stagehand?: StagehandRuntime,
    readonly browserInfo?: Record<string, unknown>,
    private onHandoff?: () => void,
  ) {
    this.permittedOrigins = new Set(
      (goal.match(/https?:\/\/[^\s<>"']+/g) ?? []).flatMap((value) => {
        try {
          return [new URL(value).origin]
        } catch {
          return []
        }
      }),
    )
    this.stop = () => {
      void this.dispose().catch(() => {})
    }
    signal.addEventListener('abort', this.stop, { once: true })
  }
  private check() {
    this.signal.throwIfAborted()
    if (this.disposed) throw new Error('WEB_SESSION_CLOSED')
  }
  private url(value: string) {
    const url = new URL(value)
    // Explicit task origins also authorize their normal same-origin application routes.
    return validateWebReadUrl(
      url.href,
      this.permittedOrigins.has(url.origin) ? `${this.goal}\n${url.href}` : this.goal,
    )
  }
  private async ensurePage() {
    this.check()
    if (this.page) return this.page
    this.page = await this.context.newPage()
    await this.stagehand?.registerPage(this.page)
    await this.page.route('**/*', async (route) => {
      const request = route.request()
      try {
        this.url(request.url())
        if (
          !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          !this.permittedOrigins.has(new URL(request.url()).origin)
        )
          throw new Error('WEB_WRITE_ORIGIN_NOT_AUTHORIZED')
        await route.continue()
      } catch {
        await route.abort().catch(() => {})
      }
    })
    this.page.on('popup', this.closePopup)
    this.page.on('dialog', this.dismissDialog)
    return this.page
  }
  private async capture(): Promise<Observed> {
    const page = await this.ensurePage()
    const url = this.url(page.url())
    const text = await page.locator('body').innerText({ timeout: 10000 })
    const handles = await page
      .locator(
        'a[href],button,input,textarea,select,[role="button"],[role="checkbox"],[contenteditable="true"]',
      )
      .elementHandles()
    const targets: Target[] = []
    const kept: Observed['handles'] = []
    let complete = false
    try {
      for (const handle of handles) {
        if (!(await handle.isVisible()) || !(await handle.isEnabled())) continue
        if (targets.length >= 1500) throw new Error('WEB_PAGE_EXCEEDS_1500_CONTROLS')
        const value = await handle.evaluate((node) => {
          const element = node as HTMLElement
          const input = element as HTMLInputElement
          const labels = Array.from(input.labels ?? [])
            .map((label) => label.innerText)
            .join(' ')
          let href: string | undefined
          if (element instanceof HTMLAnchorElement) {
            try {
              const anchor = new URL(element.href)
              if (
                ['https:', 'http:'].includes(anchor.protocol) &&
                !anchor.username &&
                !anchor.password
              )
                href = anchor.href
            } catch {
              // A malformed link can still be observed as a numbered control.
            }
          }
          return {
            href,
            tag: element.tagName.toLowerCase(),
            type: (element.getAttribute('type') ?? '').toLowerCase(),
            label: (
              element.getAttribute('aria-label') ||
              labels ||
              element.innerText ||
              element.getAttribute('placeholder') ||
              element.getAttribute('name') ||
              ''
            )
              .trim()
              .slice(0, 240),
            value: input.type === 'password' ? '' : String(input.value ?? '').slice(0, 500),
            checked: ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined,
            options:
              element instanceof HTMLSelectElement
                ? Array.from(element.options)
                    .slice(0, 50)
                    .map((option) => ({
                      label: option.label.slice(0, 100),
                      value: option.value.slice(0, 100),
                    }))
                : undefined,
          }
        })
        if (['password', 'hidden'].includes(value.type)) continue
        targets.push({ id: targets.length, ...value })
        kept.push(handle)
      }
      this.check()
      if (page.url() !== url) throw new Error('WEB_PAGE_CHANGED_DURING_READ')
      const signature = createHash('sha256')
        .update(JSON.stringify({ url, text, targets }))
        .digest('hex')
      const observed = { id: randomUUID(), url, text, targets, handles: kept, signature }
      this.initialText ??= text
      complete = true
      return observed
    } finally {
      for (const handle of handles)
        if (!complete || !kept.includes(handle)) await handle.dispose().catch(() => {})
    }
  }
  private async forget() {
    const old = this.observed
    this.observed = undefined
    await Promise.all(old?.handles.map((handle) => handle.dispose().catch(() => {})) ?? [])
  }
  private async observe(start = 0, control = 0) {
    await this.forget()
    const current = await this.capture()
    this.observed = current
    const text = Array.from(current.text)
    if (start > text.length || control > current.targets.length)
      throw new Error('WEB_OFFSET_OUT_OF_RANGE')
    const end = Math.min(text.length, start + 5000)
    return {
      observation_id: current.id,
      source_url: current.url,
      title: await this.page!.title(),
      retrieved_at: new Date().toISOString(),
      text: text.slice(start, end).join(''),
      range: [start, end],
      character_count: text.length,
      next_character: end < text.length ? end : undefined,
      targets: current.targets.slice(control, control + 40),
      control_count: current.targets.length,
      next_control: control + 40 < current.targets.length ? control + 40 : undefined,
      sha256: current.signature,
      channel: 'host_browser',
    }
  }
  private async target(observationId: string, targetId?: number) {
    const current = this.observed
    if (!current || current.id !== observationId) throw new Error('WEB_OBSERVATION_STALE')
    const fresh = await this.capture()
    try {
      if (fresh.signature !== current.signature) throw new Error('WEB_PAGE_CHANGED_REOBSERVE')
    } finally {
      await Promise.all(fresh.handles.map((handle) => handle.dispose().catch(() => {})))
    }
    if (targetId === undefined) return { current }
    const target = current.targets[targetId]
    const handle = current.handles[targetId]
    if (!target || !handle) throw new Error('WEB_TARGET_NOT_FOUND')
    return { current, target, handle }
  }
  private async selector(handle: ElementHandle<Node>) {
    return handle.evaluate((node) => {
      if (!(node instanceof Element) || !node.isConnected) throw new Error('WEB_TARGET_DETACHED')
      const parts: string[] = []
      for (let element: Element | null = node; element; element = element.parentElement) {
        const siblings: Element[] = element.parentElement
          ? Array.from(element.parentElement.children).filter(
              (sibling) => sibling.tagName === element!.tagName,
            )
          : [element]
        parts.unshift(`${element.localName}:nth-of-type(${siblings.indexOf(element) + 1})`)
      }
      return parts.join(' > ')
    })
  }
  async call(input: unknown, files?: WorkspaceSession): Promise<Record<string, unknown>> {
    this.check()
    const request = webSessionSchema.parse(input)
    if (request.operation !== 'verify') this.retainOnSuccess = false
    if (request.operation === 'observe') {
      if (request.wait_ms) await this.page?.waitForTimeout(request.wait_ms)
      this.check()
      return this.observe(request.start_character, request.start_control)
    }
    if (request.operation === 'navigate') {
      this.navigationUrl = undefined
      await this.forget()
      const page = await this.ensurePage()
      const response = await page.goto(this.url(request.url), {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      if (!response || response.status() >= 400)
        throw new Error(`WEB_SOURCE_HTTP_${response?.status() ?? 'UNAVAILABLE'}`)
      this.navigationUrl = this.url(page.url())
      return this.observe()
    }
    if (request.operation === 'discover' || request.operation === 'extract') {
      if (!this.stagehand) throw new Error('STAGEHAND_NOT_CONFIGURED')
      const { current } = await this.target(request.observation_id)
      let result: Record<string, unknown>
      if (request.operation === 'extract') {
        const shape: Record<string, z.ZodType> = Object.create(null)
        for (const field of request.fields)
          shape[field.name] = (
            field.type === 'number'
              ? z.number().finite()
              : field.type === 'boolean'
                ? z.boolean()
                : z.string().max(8000)
          ).describe(field.description)
        const { data } = await this.stagehand.extract(
          this.page!,
          request.instruction,
          z.object(shape).strict(),
        )
        result = { data }
      } else {
        const { data: actions } = await this.stagehand.observe(this.page!, request.instruction)
        const matches: { target_id: number; description: string }[] = []
        for (const action of actions) {
          const candidate = this.page!.locator(action.selector)
          if ((await candidate.count()) !== 1) continue
          const element = await candidate.elementHandle()
          if (!element) continue
          try {
            for (let id = 0; id < current.handles.length; id++)
              if (await current.handles[id].evaluate((node, other) => node === other, element)) {
                matches.push({ target_id: id, description: action.description ?? '' })
                break
              }
          } finally {
            await element.dispose()
          }
        }
        result = { targets: matches }
      }
      await this.target(request.observation_id)
      return {
        ...result,
        observation_id: current.id,
        source_url: current.url,
        sha256: current.signature,
        channel: 'host_browser',
        engine: 'stagehand',
        extracted_not_verified: true,
      }
    }
    const { current, target, handle } = await this.target(
      request.observation_id,
      request.operation === 'verify' ? undefined : request.target_id,
    )
    if (request.operation === 'verify') {
      const navigationOnly =
        request.keep_open && !this.effects && current.url === this.navigationUrl
      const expectedPresent =
        current.text.includes(request.expected_text) ||
        (navigationOnly && (await this.page!.title()).includes(request.expected_text))
      if (
        (!navigationOnly && (!this.effects || current.text === this.initialText)) ||
        !expectedPresent
      )
        throw new Error('WEB_RESULT_NOT_VERIFIED')
      this.retainOnSuccess = request.keep_open
      return {
        keep_open_requested: request.keep_open,
        verified: true,
        verification_scope: navigationOnly ? 'navigation' : 'page_change',
        observation_id: current.id,
        source_url: current.url,
        expected_text: request.expected_text,
        sha256: current.signature,
        source: 'independent_browser_readback',
        channel: 'host_browser',
      }
    }
    if (!this.permittedOrigins.has(new URL(current.url).origin))
      throw new Error('WEB_WRITE_REQUIRES_EXPLICIT_TASK_ORIGIN')
    if (request.operation === 'download') {
      if (!files) throw new Error('WEB_FILE_OPERATION_REQUIRES_WORKSPACE')
      const downloaded = this.page!.waitForEvent('download', { timeout: 30000 })
      try {
        await handle!.click({ timeout: 10000 })
        const download = await downloaded
        const stream = await download.createReadStream()
        const result = await files.receiveFile(request.path, stream, this.signal)
        this.effects++
        return {
          ...result,
          suggested_name: download.suggestedFilename(),
          observation: await this.observe().catch(() => undefined),
        }
      } catch (error) {
        await downloaded.catch(() => {})
        this.check()
        await this.forget()
        return {
          outcome: 'unknown',
          channel: 'host_browser',
          reconciliation_required: true,
          next_action: 'Check actual files and page before any further download.',
        }
      }
    }
    const value = request.value ?? ''
    if (request.action !== 'click' && request.action !== 'upload' && request.value === undefined)
      throw new Error('WEB_ACTION_VALUE_REQUIRED')
    if (request.action === 'fill' && !['input', 'textarea'].includes(target!.tag))
      throw new Error('WEB_TARGET_NOT_TEXT_INPUT')
    if (request.action === 'select' && target!.tag !== 'select')
      throw new Error('WEB_TARGET_NOT_SELECT')
    if (request.action === 'check' && !['checkbox', 'radio'].includes(target!.type))
      throw new Error('WEB_TARGET_NOT_CHECKBOX')
    if (request.action === 'check' && !['true', 'false'].includes(value))
      throw new Error('WEB_CHECK_VALUE_INVALID')
    const attachment =
      request.action === 'upload'
        ? await files?.attachment(request.path ?? '', this.signal)
        : undefined
    if (request.action === 'upload' && (!attachment || target!.type !== 'file'))
      throw new Error('WEB_UPLOAD_REQUIRES_FILE_INPUT_AND_WORKSPACE')
    this.check()
    this.effects++
    try {
      if (this.stagehand && request.action !== 'upload') {
        const selector = await this.selector(handle!)
        const sent = await this.stagehand.act(
          this.page!,
          {
            selector,
            method:
              request.action === 'select'
                ? 'selectOption'
                : request.action === 'check'
                  ? 'setChecked'
                  : request.action,
            arguments: request.action === 'click' ? [] : [value],
          },
          async () => {
            await this.target(request.observation_id, request.target_id)
            const candidate = this.page!.locator(selector)
            if ((await candidate.count()) !== 1) throw new Error('WEB_TARGET_CHANGED')
            const element = await candidate.elementHandle()
            if (!element) throw new Error('WEB_TARGET_CHANGED')
            try {
              if (!(await handle!.evaluate((node, other) => node === other, element)))
                throw new Error('WEB_TARGET_CHANGED')
            } finally {
              await element.dispose()
            }
          },
        )
        if (sent.outcome === 'unknown') {
          await this.forget()
          return sent
        }
      } else {
        if (request.action === 'click') await handle!.click({ timeout: 10000 })
        if (request.action === 'fill') await handle!.fill(value, { timeout: 10000 })
        if (request.action === 'select') await handle!.selectOption(value, { timeout: 10000 })
        if (request.action === 'check')
          await handle!.setChecked(value === 'true', { timeout: 10000 })
      }
      if (request.action === 'upload') await handle!.setInputFiles(attachment!, { timeout: 10000 })
      this.check()
      return {
        outcome: 'action_sent',
        action: request.action,
        channel: 'host_browser',
        ...(attachment ? { attachment: { name: attachment.name, sha256: attachment.sha256 } } : {}),
        observation: await this.observe(),
      }
    } catch (error) {
      this.check()
      await this.forget()
      return {
        outcome: 'unknown',
        channel: 'host_browser',
        reconciliation_required: true,
        next_action: 'Observe actual page before any further action. Never blindly repeat.',
      }
    }
  }
  dispose(completed = false) {
    if (this.closing) return this.closing
    this.disposed = true
    this.signal.removeEventListener('abort', this.stop)
    this.closing = (async () => {
      await this.forget()
      if (completed && this.retainOnSuccess) {
        this.page?.off('popup', this.closePopup)
        this.page?.off('dialog', this.dismissDialog)
        await this.page?.unrouteAll({ behavior: 'wait' })
        if (this.stagehand?.attached) await this.stagehand.close(true)
        else {
          await this.context.unrouteAll({ behavior: 'wait' })
          this.stagehand?.handoff()
        }
        this.onHandoff?.()
      } else {
        if (this.stagehand) {
          if (this.stagehand.attached) await this.page?.close().catch(() => {})
          await this.stagehand.close()
        } else await this.context.close().catch(() => {})
      }
    })()
    return this.closing
  }
}
