import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { localBrowser } from '@browserbasehq/stagehand'
import { stagehandExecutablePath } from '../src/main/infrastructure/browser-executable'
import { WebReader } from '../src/main/infrastructure/web-reader'
import { browserSettingsSchema } from '../src/main/services/browser-preferences'

it.runIf(process.platform === 'win32')(
  'attaches to existing Edge cookies and disconnects without closing user tabs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'coloop-edge-attach-'))
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/login')
        response.setHeader('Set-Cookie', 'existing=fixture; Max-Age=3600; Path=/; HttpOnly')
      response.end(`<p>Existing browser ${request.headers.cookie ?? 'login ready'}</p>`)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_ADDRESS')
    const url = `http://127.0.0.1:${address.port}`
    const owner = await localBrowser.launch({
      executablePath: stagehandExecutablePath(),
      headless: true,
      userDataDir: root,
      preserveUserDataDir: true,
      keepAlive: true,
      args: ['--edge-skip-compat-layer-relaunch'],
    })
    const observer = await chromium.connectOverCDP(owner.cdpUrl!)
    const reader = new WebReader(true)
    try {
      const original = await observer.contexts()[0].newPage()
      await original.goto(url + '/login')
      const endpoint = owner.cdpUrl!
      await owner.disconnect()
      const settings = browserSettingsSchema.parse({
        browser: 'edge',
        connection: 'existing',
        cdpUrl: endpoint,
      })
      const session = await reader.session(
        `用 Edge 打开 ${url}/check`,
        new AbortController().signal,
        async () => {
          throw new Error('MODEL_NOT_EXPECTED')
        },
        'attach-test',
        settings,
      )
      expect(session.browserInfo).toMatchObject({
        connection: 'existing',
        actual: { browser: 'edge' },
      })
      const view = await session.call({ operation: 'navigate', url: url + '/check' })
      expect(view.text).toContain('existing=fixture')
      expect(original.isClosed()).toBe(false)
      await original.reload()
      expect(await original.locator('body').innerText()).toContain('existing=fixture')
      await session.dispose()
      expect(observer.isConnected()).toBe(true)
      expect(original.isClosed()).toBe(false)
      const handed = await reader.session(
        `用 Edge 打开 ${url}/check`,
        new AbortController().signal,
        async () => '',
        'handoff-test',
        settings,
      )
      const final = await handed.call({ operation: 'navigate', url: url + '/check' })
      await handed.call({
        operation: 'verify',
        observation_id: final.observation_id,
        expected_text: 'existing=fixture',
        keep_open: true,
      })
      await handed.dispose(true)
      await reader.dispose()
      expect(
        observer
          .contexts()[0]
          .pages()
          .some((page) => page.url() === url + '/check'),
      ).toBe(true)
      expect(original.isClosed()).toBe(false)
    } finally {
      await reader.dispose()
      const cdp = await observer.newBrowserCDPSession()
      await cdp.send('Browser.close').catch(() => {})
      await observer.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    }
  },
  60000,
)
