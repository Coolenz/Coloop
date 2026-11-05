import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { WebReader, validateWebReadUrl } from '../src/main/infrastructure/web-reader'

it('permits HTTPS sources and only task-explicit local paths', () => {
  expect(validateWebReadUrl('https://example.com/page', '')).toBe('https://example.com/page')
  expect(() => validateWebReadUrl('http://example.com', '')).toThrow('WEB_URL_REQUIRES_HTTPS')
  expect(() => validateWebReadUrl('https://user:secret@example.com', '')).toThrow(
    'WEB_URL_CREDENTIALS_FORBIDDEN',
  )
  expect(() =>
    validateWebReadUrl('http://127.0.0.1/private', '打开 http://127.0.0.1/public'),
  ).toThrow('LOCAL_WEB_URL_REQUIRES_EXPLICIT_TASK_URL')
  expect(() => validateWebReadUrl('https://localhost./private', '')).toThrow(
    'LOCAL_WEB_URL_REQUIRES_EXPLICIT_TASK_URL',
  )
  expect(validateWebReadUrl('http://127.0.0.1/public', '打开 http://127.0.0.1/public')).toBe(
    'http://127.0.0.1/public',
  )
  expect(() => validateWebReadUrl('file:///C:/secret', '')).toThrow('WEB_URL_REQUIRES_HTTPS')
})

it.runIf(process.platform === 'win32')(
  'reads an actual rendered Edge page with provenance and pagination',
  async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<html><head><title>测试场馆</title></head><body><h1>开放时间</h1><p>周二至周日 09:00–17:00。</p><a href="/notice">临时公告</a></body></html>',
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    const url = `http://127.0.0.1:${address.port}/museum`
    const goal = `研究 ${url} http://127.0.0.1:${address.port}/notice`
    const reader = new WebReader(true)
    try {
      const page = await reader.read({ url, max_characters: 8 }, goal, new AbortController().signal)
      expect(page).toMatchObject({
        source_url: url,
        title: '测试场馆',
        truncated: true,
        next_character: 8,
        channel: 'host_browser',
      })
      expect(page.links).toContainEqual({
        text: '临时公告',
        url: `http://127.0.0.1:${address.port}/notice`,
      })
    } finally {
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
  30000,
)

it.runIf(process.platform === 'win32')(
  'waits for actual asynchronous page data when explicitly requested',
  async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<p>Loading</p><script>setTimeout(()=>document.body.append("真实异步榜单 BATCH-829"),500)</script>',
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    const url = `http://127.0.0.1:${address.port}/`
    const reader = new WebReader(true)
    try {
      const result = await reader.read({ url, wait_ms: 700 }, url, new AbortController().signal)
      expect(result.text).toContain('真实异步榜单 BATCH-829')
    } finally {
      await reader.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
)
