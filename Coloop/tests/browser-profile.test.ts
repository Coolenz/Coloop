import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { WebReader } from '../src/main/infrastructure/web-reader'
import type { StagehandRuntime } from '../src/main/infrastructure/stagehand-runtime'

it.runIf(process.platform === 'win32')(
  'persists native Edge cookies and storage across handoff, tasks and reader restart',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'coloop-edge-profile-'))
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/login') {
        response.setHeader(
          'Set-Cookie',
          'session=fixture; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
        )
        response.end(
          '<title>登录QQ邮箱</title><p>登录测试成功</p><script>localStorage.setItem("login", "fixture")</script>',
        )
      } else
        response.end(
          `<p>Cookie ${request.headers.cookie ?? 'missing'}</p><p id="storage"></p><script>document.getElementById("storage").textContent="Storage "+localStorage.getItem("login")</script>`,
        )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS')
    const base = `http://127.0.0.1:${address.port}`
    const signal = new AbortController().signal
    const complete = async () => {
      throw new Error('MODEL_NOT_EXPECTED')
    }
    let reader = new WebReader(true, undefined, root)
    try {
      const first = await reader.session(`用 Edge 打开 ${base}/login`, signal, complete)
      expect(first.browserInfo).toMatchObject({ persistent: true, actual: { browser: 'edge' } })
      const view = await first.call({ operation: 'navigate', url: base + '/login' })
      expect(
        await first.call({
          operation: 'verify',
          observation_id: view.observation_id,
          expected_text: '登录QQ邮箱',
          keep_open: true,
        }),
      ).toMatchObject({ verified: true, verification_scope: 'navigation' })
      await expect(reader.session(`用 Edge 打开 ${base}/check`, signal, complete)).rejects.toThrow(
        'BROWSER_PROFILE_IN_USE',
      )
      expect(
        await first.call({
          operation: 'verify',
          observation_id: view.observation_id,
          expected_text: '登录测试成功',
          keep_open: true,
        }),
      ).toMatchObject({ verified: true, verification_scope: 'navigation' })
      const runtime = [
        ...(reader as unknown as { stagehandSessions: Set<StagehandRuntime> }).stagehandSessions,
      ][0]
      const handedPage = runtime.context.pages().find((page) => page.url() === base + '/login')!
      await first.dispose(true)
      expect(handedPage.isClosed()).toBe(false)
      expect(runtime.handedOff).toBe(true)
      const second = await reader.session(`用 Edge 打开 ${base}/check`, signal, complete)
      const secondView = await second.call({ operation: 'navigate', url: base + '/check' })
      expect(secondView.text).toContain('session=fixture')
      expect(secondView.text).toContain('Storage fixture')
      await second.dispose()
      await reader.dispose()
      expect((await stat(join(root, 'edge'))).isDirectory()).toBe(true)
      reader = new WebReader(true, undefined, root)
      const restarted = await reader.session(`用 Edge 打开 ${base}/check`, signal, complete)
      const restored = await restarted.call({ operation: 'navigate', url: base + '/check' })
      expect(restored.text).toContain('session=fixture')
      expect(restored.text).toContain('Storage fixture')
      await restarted.dispose()
    } finally {
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)
