import type { BrowserContext } from 'playwright-core'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { WebReader } from '../src/main/infrastructure/web-reader'
import { WorkspaceSession } from '../src/main/services/workspace-session'

it.runIf(process.platform === 'win32')(
  'uses fresh real Edge controls, uploads exact bytes, downloads and verifies actual results',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'coloop-web-session-'))
    const writes: string[] = []
    let upload = Buffer.alloc(0)
    const server = createServer(async (request, response) => {
      if (request.method === 'POST') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        upload = Buffer.concat(chunks)
        writes.push(request.url!)
        response.writeHead(303, { location: '/saved' }).end()
      } else if (request.url === '/saved') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<p>登记完成 TEST-001</p><a href="/attachment">下载附件</a>')
      } else if (request.url === '/attachment') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="receipt.txt"',
        })
        response.end('receipt TEST-001')
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          '<form method="post" action="/save" enctype="multipart/form-data"><label>客户<input name="customer" value="旧值"></label><label>密码<input type="password" value="private-canary"></label><label>附件<input type="file" name="file"></label><button>保存登记</button></form>',
        )
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No server address')
    const url = `http://127.0.0.1:${address.port}/`
    const abort = new AbortController()
    const reader = new WebReader(true)
    const session = await reader.session(`在 ${url} 登记测试客户并下载回执`, abort.signal)
    const files = await WorkspaceSession.open(root, 'unused.ps1', async () => '')
    type View = { observation_id: string; targets: { id: number; label: string; href?: string }[] }
    const find = (view: View, label: string) =>
      view.targets.find((target) => target.label === label)!.id
    try {
      await writeFile(join(root, 'source.txt'), '附件正文 中文 TEST-001')
      let view = (await session.call({ operation: 'navigate', url })) as unknown as View
      expect(JSON.stringify(view)).not.toContain('private-canary')
      expect(view.targets.some((target) => target.label === '密码')).toBe(false)
      await expect(
        session.call({
          operation: 'verify',
          observation_id: view.observation_id,
          expected_text: '保存登记',
        }),
      ).rejects.toThrow('WEB_RESULT_NOT_VERIFIED')
      const old = view
      const filled = await session.call({
        operation: 'act',
        observation_id: view.observation_id,
        target_id: find(view, '客户'),
        action: 'fill',
        value: '林悦',
      })
      view = filled.observation as unknown as View
      await expect(
        session.call({
          operation: 'act',
          observation_id: old.observation_id,
          target_id: 0,
          action: 'fill',
          value: '错误重放',
        }),
      ).rejects.toThrow('WEB_OBSERVATION_STALE')
      const attached = await session.call(
        {
          operation: 'act',
          observation_id: view.observation_id,
          target_id: find(view, '附件'),
          action: 'upload',
          path: 'source.txt',
        },
        files,
      )
      view = attached.observation as unknown as View
      const saved = await session.call({
        operation: 'act',
        observation_id: view.observation_id,
        target_id: find(view, '保存登记'),
        action: 'click',
      })
      expect(saved.outcome).toBe('action_sent')
      view = saved.observation as unknown as View
      expect(writes).toEqual(['/save'])
      expect(view.targets.find((t) => t.label === '下载附件')?.href).toBe(url + 'attachment')
      expect(upload.toString('utf8')).toContain('附件正文 中文 TEST-001')
      expect(upload.toString('utf8')).toContain('林悦')
      expect(
        await session.call({
          operation: 'verify',
          observation_id: view.observation_id,
          expected_text: '登记完成 TEST-001',
        }),
      ).toMatchObject({ verified: true, source: 'independent_browser_readback' })
      const downloaded = await session.call(
        {
          operation: 'download',
          observation_id: view.observation_id,
          target_id: find(view, '下载附件'),
          path: 'download/receipt.txt',
        },
        files,
      )
      expect(downloaded).toMatchObject({
        committed: true,
        downloaded: true,
        channel: 'host_browser',
      })
      expect(await readFile(join(root, 'download/receipt.txt'), 'utf8')).toBe('receipt TEST-001')
      expect(await files.verify(String(downloaded.artifact_id), abort.signal)).toMatchObject({
        verified: true,
      })
      abort.abort()
      await expect(session.call({ operation: 'observe' })).rejects.toMatchObject({
        name: 'AbortError',
      })
    } finally {
      await session.dispose()
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'reconciles a delayed click through actual state without repeating the POST',
  async () => {
    let count = 0
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.method === 'POST') {
        count++
        setTimeout(() => response.end('<p>延迟登记已完成</p>'), 11000)
      } else response.end('<form method="post"><button>登记一次</button></form>')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No server address')
    const url = `http://127.0.0.1:${address.port}/`
    const reader = new WebReader(true)
    const session = await reader.session(`在 ${url} 登记一次`, new AbortController().signal)
    try {
      const view = await session.call({ operation: 'navigate', url })
      expect(
        await session.call({
          operation: 'act',
          observation_id: view.observation_id,
          target_id: 0,
          action: 'click',
        }),
      ).toMatchObject({ outcome: 'unknown', reconciliation_required: true })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const actual = await session.call({ operation: 'observe' })
      expect(
        await session.call({
          operation: 'verify',
          observation_id: actual.observation_id,
          expected_text: '延迟登记已完成',
        }),
      ).toMatchObject({ verified: true })
      expect(count).toBe(1)
    } finally {
      await session.dispose()
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  25000,
)

it.runIf(process.platform === 'win32')(
  'hands off a verified final page on success and closes an aborted page',
  async () => {
    const server = createServer(async (request, response) => {
      if (request.method === 'POST') {
        for await (const _chunk of request) {
          /* Consume the actual form submission. */
        }
        response.writeHead(303, { location: '/cart' }).end()
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          request.url === '/cart'
            ? '<p>购物车 SKU-TEST × 1</p>'
            : '<form method="post"><button>加入购物车</button></form>',
        )
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    const url = `http://127.0.0.1:${address.port}/`
    const reader = new WebReader(true)
    try {
      for (const completed of [true, false]) {
        const abort = new AbortController()
        const session = await reader.session(url, abort.signal)
        type View = { observation_id: string; targets: { id: number; label: string }[] }
        const view = (await session.call({ operation: 'navigate', url })) as unknown as View
        const action = await session.call({
          operation: 'act',
          observation_id: view.observation_id,
          target_id: view.targets.find((t) => t.label === '加入购物车')!.id,
          action: 'click',
        })
        const after = action.observation as View
        await session.call({
          operation: 'verify',
          observation_id: after.observation_id,
          expected_text: '购物车 SKU-TEST × 1',
          keep_open: true,
        })
        const context = (session as unknown as { context: BrowserContext }).context
        const page = context.pages()[0]
        if (completed) await session.dispose(true)
        else {
          abort.abort()
          await session.dispose()
        }
        expect(page.isClosed()).toBe(!completed)
        if (completed) expect(await page.locator('body').innerText()).toContain('SKU-TEST')
        await expect(session.call({ operation: 'observe' })).rejects.toThrow()
      }
    } finally {
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'paginates a real page with more than three hundred controls',
  async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        request.url?.startsWith('/item/')
          ? '<p>项目已打开 309</p>'
          : Array.from(
              { length: 310 },
              (_, index) => `<p><a href="/item/${index}">项目 ${index}</a></p>`,
            ).join(''),
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    const url = `http://127.0.0.1:${address.port}/`
    const reader = new WebReader(true)
    try {
      const session = await reader.session(url, new AbortController().signal)
      const first = await session.call({ operation: 'navigate', url })
      expect(first.control_count).toBe(310)
      const page = (await session.call({ operation: 'observe', start_control: 300 })) as {
        observation_id: string
        targets: { id: number; label: string; href: string }[]
      }
      const target = page.targets.find((item) => item.label === '项目 309')!
      expect(target.href).toBe(url + 'item/309')
      const action = await session.call({
        operation: 'act',
        observation_id: page.observation_id,
        target_id: target.id,
        action: 'click',
      })
      expect(action.outcome).toBe('action_sent')
      expect(action.observation).toHaveProperty('source_url', url + 'item/309')
    } finally {
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  30000,
)
