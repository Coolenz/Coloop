import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { StagehandRuntime } from '../src/main/infrastructure/stagehand-runtime'
import {
  createStagehandModel,
  type StagehandCompletionRequest,
} from '../src/main/infrastructure/stagehand-model'
import { WebSession } from '../src/main/infrastructure/web-session'
import { WebReader } from '../src/main/infrastructure/web-reader'
import { WorkspaceSession } from '../src/main/services/workspace-session'

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
const ownedRuntimes = (reader: WebReader) =>
  (reader as unknown as { stagehandSessions: Set<StagehandRuntime> }).stagehandSessions

it('uses the host callback only, preserves schemas and blocks images or action-time inference', async () => {
  const controller = new AbortController()
  let permitted = false
  const received: StagehandCompletionRequest[] = []
  const model = createStagehandModel(
    async (request) => {
      received.push(request)
      return '{"value":"actual"}'
    },
    controller.signal,
    () => permitted,
  )
  const request = {
    systemPrompt: 'Read actual data',
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: 'actual' } }],
    responseFormat: {
      type: 'json_schema' as const,
      name: 'Read',
      schema: { type: 'object', properties: { value: { type: 'string' } } },
    },
  }
  await expect(model.generate(request)).rejects.toThrow('STAGEHAND_MODEL_CALL_OUTSIDE_READ')
  permitted = true
  expect(await model.generate(request)).toMatchObject({
    outputFormat: 'json_schema',
    structuredContent: { value: 'actual' },
  })
  expect(received[0]).toMatchObject({
    schemaName: 'Read',
    schema: request.responseFormat.schema,
    messages: [{ role: 'user', content: 'actual' }],
  })
  await expect(
    model.generate({
      ...request,
      messages: [{ role: 'user', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }],
    }),
  ).rejects.toThrow('STAGEHAND_IMAGE_MODEL_INPUT_DISABLED')
  controller.abort()
  await expect(model.generate(request)).rejects.toMatchObject({ name: 'AbortError' })
  expect(received).toHaveLength(1)
})

it.runIf(process.platform === 'win32')(
  'runs official Stagehand against local Chrome and a host-owned synthetic model endpoint',
  async () => {
    const writes: string[] = []
    const web = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.method === 'POST') {
        let text = ''
        for await (const part of request) text += part
        writes.push(text)
        response.end('<p>已保存 测试订单 42.50</p>')
      } else
        response.end(
          '<form method="post"><label>客户<input id="customer" name="customer" value="旧客户"></label><label>密码<input type="password" value="secret-model-canary"></label><label>地区<select id="region" name="region"><option value="north">华北</option><option value="south">华南</option></select></label><label>已确认<input id="confirmed" type="checkbox" name="confirmed"></label><p>测试订单 金额42.50</p><button id="save">保存订单</button></form>',
        )
    })
    const requests: StagehandCompletionRequest[] = []
    const model = createServer(async (request, response) => {
      let text = ''
      for await (const part of request) text += part
      const body = JSON.parse(text) as StagehandCompletionRequest
      requests.push(body)
      const prompt = body.messages.map((m) => m.content).join('\n')
      let answer: unknown
      if (body.schemaName === 'Observation') {
        const id = /\[(\d+-\d+)\][^\n]*button[^\n]*保存订单/.exec(prompt)?.[1]
        if (!id) {
          response.writeHead(500).end('Actual button missing from model request')
          return
        }
        answer = {
          elements: [{ elementId: id, description: '保存订单', method: 'click', arguments: [] }],
        }
      } else if (body.schemaName === 'Extraction') {
        const amount = /金额\s*(\d+\.\d+)/.exec(prompt)?.[1]
        answer = { amount: Number(amount) }
      } else if (body.schemaName === 'Metadata')
        answer = { progress: '已提取实际页面金额', completed: true }
      else {
        response.writeHead(500).end('Unexpected inference')
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(answer))
    })
    const url = await listen(web)
    const endpoint = await listen(model)
    const controller = new AbortController()
    let runtime: StagehandRuntime | undefined
    try {
      runtime = await StagehandRuntime.open({
        goal: `在 ${url}/ 登记一次订单`,
        signal: controller.signal,
        headless: true,
        complete: async (request, signal) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
            signal,
          })
          if (!response.ok) throw new Error('SYNTHETIC_MODEL_REJECTED')
          return response.text()
        },
      })
      const page = await runtime.context.newPage()
      await page.goto(url)
      const snapshot = await runtime.snapshot(page)
      expect(snapshot.formattedTree).toContain('保存订单')
      expect(snapshot.formattedTree).not.toContain('secret-model-canary')
      expect(requests).toHaveLength(0)
      const observed = await runtime.observe(page, '找到保存订单按钮')
      expect(observed.data).toHaveLength(1)
      expect(await page.locator(observed.data[0].selector).innerText()).toBe('保存订单')
      expect(
        (await runtime.extract(page, '提取订单金额', z.object({ amount: z.number() }))).data,
      ).toEqual({ amount: 42.5 })
      expect(requests.map((r) => r.schemaName)).toEqual(['Observation', 'Extraction', 'Metadata'])
      expect(JSON.stringify(requests)).not.toContain('secret-model-canary')
      let guards = 0
      const guard = async () => {
        guards++
      }
      for (const action of [
        { selector: '#customer', method: 'fill' as const, arguments: ['林悦'] },
        { selector: '#region', method: 'selectOption' as const, arguments: ['south'] },
        { selector: '#confirmed', method: 'setChecked' as const, arguments: ['true'] },
      ])
        expect(await runtime.act(page, action, guard), action.method).toMatchObject({
          outcome: 'action_sent',
          engine: 'stagehand',
        })
      expect(await page.locator('#customer').inputValue()).toBe('林悦')
      expect(await page.locator('#region').inputValue()).toBe('south')
      expect(await page.locator('#confirmed').isChecked()).toBe(true)
      await expect(
        runtime.act(page, { selector: '#save', method: 'click', arguments: [] }, async () => {
          throw new Error('WEB_PAGE_CHANGED_REOBSERVE')
        }),
      ).rejects.toThrow('WEB_PAGE_CHANGED_REOBSERVE')
      expect(writes).toHaveLength(0)
      expect(
        await runtime.act(page, { selector: '#save', method: 'click', arguments: [] }, guard),
      ).toMatchObject({ outcome: 'action_sent' })
      await page.waitForURL(url + '/')
      expect(await page.locator('body').innerText()).toContain('已保存')
      expect(writes).toHaveLength(1)
      expect(writes[0]).toContain('region=south')
      expect(guards).toBe(4)
      expect(requests).toHaveLength(3)
      const session = new WebSession(
        runtime.context,
        `在 ${url}/ 登记一次订单`,
        controller.signal,
        runtime,
      )
      let view = await session.call({ operation: 'navigate', url })
      const discovered = await session.call({
        operation: 'discover',
        observation_id: view.observation_id,
        instruction: '找到保存订单按钮',
      })
      const matches = discovered.targets as { target_id: number; description: string }[]
      expect(matches).toHaveLength(1)
      const extraction = await session.call({
        operation: 'extract',
        observation_id: view.observation_id,
        instruction: '提取订单金额',
        fields: [{ name: 'amount', description: '订单金额', type: 'number' }],
      })
      expect(extraction).toMatchObject({
        data: { amount: 42.5 },
        extracted_not_verified: true,
        engine: 'stagehand',
      })
      const priorId = view.observation_id
      const customerId = (view.targets as { id: number; label: string }[]).find(
        (target) => target.label === '客户',
      )!.id
      const changed = await session.call({
        operation: 'act',
        observation_id: view.observation_id,
        target_id: customerId,
        action: 'fill',
        value: '第二次独立任务',
      })
      expect(changed.outcome).toBe('action_sent')
      view = changed.observation as Record<string, unknown>
      await expect(
        session.call({
          operation: 'act',
          observation_id: priorId,
          target_id: customerId,
          action: 'fill',
          value: '禁止旧观察',
        }),
      ).rejects.toThrow('WEB_OBSERVATION_STALE')
      const saveId = (view.targets as { id: number; label: string }[]).find(
        (target) => target.label === '保存订单',
      )!.id
      const saved = await session.call({
        operation: 'act',
        observation_id: view.observation_id,
        target_id: saveId,
        action: 'click',
      })
      expect(saved.outcome).toBe('action_sent')
      const finalView = saved.observation as Record<string, unknown>
      expect(
        await session.call({
          operation: 'verify',
          observation_id: finalView.observation_id,
          expected_text: '已保存 测试订单 42.50',
        }),
      ).toMatchObject({ verified: true })
      expect(writes).toHaveLength(2)
      expect(requests).toHaveLength(6)
      controller.abort()
      await expect(runtime.snapshot(page)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await runtime?.close()
      await close(model)
      await close(web)
    }
  },
  90000,
)

it.runIf(process.platform === 'win32')(
  'keeps a delayed real POST unknown and never retries the dispatched action',
  async () => {
    let posts = 0
    const web = createServer(async (request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.method === 'POST') {
        for await (const _part of request) {
          /* Consume actual body. */
        }
        posts++
        setTimeout(() => response.end('<p>延迟订单仅保存一次</p>'), 11500)
      } else response.end('<form method="post"><button id="once">保存一次</button></form>')
    })
    const url = await listen(web)
    let calls = 0
    const runtime = await StagehandRuntime.open({
      goal: `在 ${url}/ 保存一次`,
      signal: new AbortController().signal,
      complete: async () => {
        calls++
        throw new Error('UNEXPECTED_MODEL_CALL')
      },
    })
    try {
      const session = new WebSession(
        runtime.context,
        `在 ${url}/ 保存一次`,
        new AbortController().signal,
        runtime,
      )
      const view = await session.call({ operation: 'navigate', url })
      const result = await session.call({
        operation: 'act',
        observation_id: view.observation_id,
        target_id: 0,
        action: 'click',
      })
      expect(result).toMatchObject({ outcome: 'unknown', reconciliation_required: true })
      await new Promise((resolve) => setTimeout(resolve, 1800))
      const actual = await session.call({ operation: 'observe' })
      expect(
        await session.call({
          operation: 'verify',
          observation_id: actual.observation_id,
          expected_text: '延迟订单仅保存一次',
        }),
      ).toMatchObject({ verified: true })
      expect(posts).toBe(1)
      expect(calls).toBe(0)
    } finally {
      await runtime.close()
      await close(web)
    }
  },
  45000,
)

it.runIf(process.platform === 'win32')(
  'preserves workspace attachment uploads and actual downloads through WebReader Stagehand sessions',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'coloop-stagehand-files-'))
    let uploaded = Buffer.alloc(0)
    let posts = 0
    const web = createServer(async (request, response) => {
      if (request.url === '/receipt') {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="receipt.txt"',
        })
        response.end('真实附件回执 TEST-SH')
      } else if (request.method === 'POST') {
        posts++
        const bytes: Buffer[] = []
        for await (const chunk of request) bytes.push(chunk)
        uploaded = Buffer.concat(bytes)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<p>附件已保存 TEST-SH</p><a href="/receipt">下载回执</a>')
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          '<form method="post" enctype="multipart/form-data"><label>附件<input type="file" name="file"></label><button>保存附件</button></form>',
        )
      }
    })
    const url = await listen(web)
    const reader = new WebReader(true)
    const session = await reader.session(
      `在 ${url}/ 上传附件并下载回执`,
      new AbortController().signal,
      async () => {
        throw new Error('MODEL_NOT_EXPECTED')
      },
    )
    const files = await WorkspaceSession.open(root, 'unused.ps1', async () => '')
    try {
      await writeFile(join(root, 'source.txt'), '正式附件 中文 TEST-SH')
      let view = await session.call({ operation: 'navigate', url })
      const upload = await session.call(
        {
          operation: 'act',
          observation_id: view.observation_id,
          target_id: 0,
          action: 'upload',
          path: 'source.txt',
        },
        files,
      )
      view = upload.observation as Record<string, unknown>
      const save = await session.call(
        { operation: 'act', observation_id: view.observation_id, target_id: 1, action: 'click' },
        files,
      )
      expect(save.outcome, JSON.stringify(save)).toBe('action_sent')
      view = save.observation as Record<string, unknown>
      expect(uploaded.toString('utf8')).toContain('正式附件 中文 TEST-SH')
      const download = await session.call(
        {
          operation: 'download',
          observation_id: view.observation_id,
          target_id: 0,
          path: 'receipt.txt',
        },
        files,
      )
      expect(download).toMatchObject({ downloaded: true, committed: true })
      expect(await readFile(join(root, 'receipt.txt'), 'utf8')).toBe('真实附件回执 TEST-SH')
      expect(
        await files.verify(String(download.artifact_id), new AbortController().signal),
      ).toMatchObject({ verified: true })
      expect(posts).toBe(1)
      const finalView = download.observation as Record<string, unknown>
      expect(
        await session.call({
          operation: 'verify',
          observation_id: finalView.observation_id,
          expected_text: '附件已保存 TEST-SH',
          keep_open: true,
        }),
      ).toMatchObject({ verified: true, keep_open_requested: true })
      const runtime = [...ownedRuntimes(reader)][0]
      expect(runtime).toBeDefined()
      await session.dispose(true)
      expect(ownedRuntimes(reader).size).toBe(1)
      expect(await runtime.context.pages().at(-1)!.locator('body').innerText()).toContain(
        '附件已保存',
      )
    } finally {
      await session.dispose()
      await reader.dispose()
      expect(ownedRuntimes(reader).size).toBe(0)
      await close(web)
      await rm(root, { recursive: true, force: true })
    }
  },
  45000,
)

it.runIf(process.platform === 'win32')(
  'releases cancelled Stagehand sessions from the WebReader registry',
  async () => {
    const reader = new WebReader(true)
    const abort = new AbortController()
    try {
      const session = await reader.session('读取 https://example.com/', abort.signal, async () => {
        throw new Error('MODEL_NOT_EXPECTED')
      })
      expect(ownedRuntimes(reader).size).toBe(1)
      abort.abort()
      await session.dispose()
      expect(ownedRuntimes(reader).size).toBe(0)
    } finally {
      await reader.dispose()
    }
  },
  30000,
)
