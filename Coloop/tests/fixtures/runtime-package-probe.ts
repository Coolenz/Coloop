import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { createHarnessRuntime } from '../../src/main/infrastructure/harness-runtime'
import { rkTarsModel, createRkTarsFetch } from '../../src/main/infrastructure/rk-tars-model'
import { StagehandRuntime } from '../../src/main/infrastructure/stagehand-runtime'
import type { StagehandCompletionRequest } from '../../src/main/infrastructure/stagehand-model'
import { DoclingService } from '../../src/main/infrastructure/docling'
import { WorkspaceSession } from '../../src/main/services/workspace-session'

const resources = resolve(process.argv[2])
const output = resolve(process.argv[3])
const app = join(resources, 'app')
const require = createRequire(import.meta.url)
const scope =
  'Packaged Node/Python/dependencies, isolated cwd/task storage/browser profile, scripted local pages and synthetic model endpoints; no paid model, user account, RK or HID.'
const report: Record<string, unknown> = {
  ok: false,
  scope,
  resources,
  cwd: process.cwd(),
  node: process.execPath,
  nodeVersion: process.version,
}
assert.equal(
  process.execPath.toLowerCase(),
  join(resources, 'runtime', 'node', 'node.exe').toLowerCase(),
)
assert.equal(process.cwd(), output)
const resolved: Record<string, string> = {}
for (const name of [
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-mcp-client',
  '@playwright/mcp',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  '@deepseek-ai/dsh-compaction-image-offload',
  '@browserbasehq/stagehand',
  'playwright-core',
  'zod',
  'yazl',
  'yauzl',
]) {
  const path =
    name === '@deepseek-ai/dsh'
      ? require.resolve(name + '/package.json')
      : fileURLToPath(import.meta.resolve(name))
  assert.ok(
    path.toLowerCase().startsWith((join(app, 'node_modules') + sep).toLowerCase()),
    `Dependency escaped package: ${name}: ${path}`,
  )
  resolved[name] = path
}
report.dependencies = resolved

function reply(response: ServerResponse, delta: unknown, reason = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [part, finish] of [
    [delta, null],
    [{}, reason],
  ])
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'package-smoke-response',
          object: 'chat.completion.chunk',
          model: 'package-model',
          created: 1,
          choices: [{ index: 0, delta: part, finish_reason: finish }],
          ...(finish
            ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }
            : {}),
        }) +
        '\n\n',
    )
  response.end('data: [DONE]\n\n')
}
let harnessRequests = 0,
  stagehandRequests = 0,
  posts = 0
const saved: string[] = []
const server = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    if (request.url === '/v1/chat/completions') {
      harnessRequests++
      const body = JSON.parse(raw)
      const names = body.tools.map((tool: any) => tool.function.name)
      assert.ok(names.includes('coloop_echo'))
      assert.ok(names.includes('mcp__playwright__browser_navigate'))
      assert.ok(names.includes('mcp__playwright__browser_verify_text_visible'))
      const hasResult = body.messages.some((message: any) => message.role === 'tool')
      reply(
        response,
        hasResult
          ? { content: 'Verified packaged result: 中文包内工具' }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'package-call-1',
                  type: 'function',
                  function: { name: 'coloop_echo', arguments: '{"value":"中文包内工具"}' },
                },
              ],
            },
        hasResult ? 'stop' : 'tool_calls',
      )
    } else if (request.url === '/stagehand-model') {
      stagehandRequests++
      const body = JSON.parse(raw) as StagehandCompletionRequest
      const prompt = body.messages.map((message) => message.content).join('\n')
      assert.ok(!prompt.includes('package-password-canary'))
      let answer: unknown
      if (body.schemaName === 'Extraction') {
        const amount = /金额\s*(\d+\.\d+)/.exec(prompt)?.[1]
        assert.ok(amount, 'Extraction must use the actual page amount')
        answer = { amount: Number(amount) }
      } else if (body.schemaName === 'Metadata')
        answer = { progress: '已读取实际金额', completed: true }
      else throw new Error('UNEXPECTED_STAGEHAND_MODEL_CALL')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    } else if (request.url === '/form' && request.method === 'POST') {
      posts++
      saved.push(raw)
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<p>包内浏览器已保存 中文客户 42.50</p>')
    } else if (request.url === '/form') {
      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<form method="post"><label>客户<input id="customer" name="customer"></label><input type="password" value="package-password-canary"><p>订单金额 42.50</p><button id="save">保存订单</button></form>',
        )
    } else response.writeHead(404).end()
  } catch (error) {
    response
      .writeHead(500, { 'content-type': 'text/plain' })
      .end(error instanceof Error ? error.message : String(error))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
let harness: ReturnType<typeof createHarnessRuntime> | undefined
let stagehand: StagehandRuntime | undefined
try {
  console.log('Package probe: official Harness tool loop')
  let tools = 0
  const events: string[] = []
  const taskWorkspace = join(output, 'authorized-files')
  await mkdir(taskWorkspace)
  const workingDirectories: string[] = []
  harness = createHarnessRuntime({
    id: 'packaged-runtime-smoke',
    playwrightExtension: { browser: 'edge' },
    workspace: output,
    taskWorkspace,
    home: join(output, 'harness-home'),
    runtimeResources: join(resources, 'harness'),
    nodePath: process.execPath,
    model: {
      provider: 'openai',
      id: 'package-model',
      apiKey: 'synthetic-fixture-only',
      baseURL: base + '/v1',
    },
    instructions: 'Call coloop_echo once and report its exact observed result.',
    maxIterations: 4,
    maxTokens: 1024,
    tools: [
      {
        name: 'coloop_echo',
        description: 'Read an explicit fixture value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute: (args) => {
          tools++
          assert.deepEqual(args, { value: '中文包内工具' })
          return args
        },
      },
    ],
    onEvent: (event) => {
      events.push(event.type)
      if (event.type === 'harness_session_event' && event.event.type === 'working-directory/change')
        workingDirectories.push(event.event.data.cwd)
    },
  })
  const result = await harness.run('Read the packaged fixture value.')
  assert.deepEqual(result, {
    content: 'Verified packaged result: 中文包内工具',
    finishReason: 'stop',
  })
  assert.equal(tools, 1)
  assert.equal(harnessRequests, 2)
  assert.ok(events.includes('tool_call'))
  assert.ok(workingDirectories.includes(taskWorkspace))
  await harness.dispose()
  report.harness = {
    passed: true,
    tools,
    modelRequests: harnessRequests,
    finishReason: result.finishReason,
    officialSdkDisposed: true,
    authorizedWorkingDirectory: taskWorkspace,
    officialPlaywrightToolsRegistered: true,
  }

  console.log('Package probe: packaged local compaction extension')
  let localRequests = 0,
    localTools = 0,
    summaries = 0
  harness = createHarnessRuntime({
    id: 'packaged-local-compaction',
    workspace: output,
    home: join(output, 'local-harness-home'),
    runtimeResources: join(resources, 'harness'),
    nodePath: process.execPath,
    model: rkTarsModel,
    maxIterations: 6,
    maxTokens: 1024,
    instructions: 'Read the fixture once. ' + 'Planner-only schema guidance. '.repeat(160),
    tools: [
      {
        name: 'coloop_echo',
        description: 'Read fixture once',
        parameters: { type: 'object' },
        execute: () => {
          localTools++
          return { text: 'Read once; no effects. '.repeat(90) }
        },
      },
    ],
    fetch: createRkTarsFetch(async (system, messages, _signal, cap) => {
      const summary = messages.at(-1)?.content.includes('[Coloop local checkpoint]')
      if (summary) {
        summaries++
        assert.equal(cap, 1024)
        assert.ok(!system.includes('Planner-only schema guidance'))
      }
      return ++localRequests === 1
        ? '<tool_call>{"name":"coloop_echo","parameters":{}}</tool_call>'
        : 'Fixture read once; no writes or inputs.' + (summary ? '\n<checkpoint-end>' : '')
    }),
  })
  const localResult = await harness.run('Read and report. ' + 'evidence '.repeat(800))
  assert.equal(localResult.finishReason, 'stop')
  assert.equal(localTools, 1)
  assert.ok(summaries > 0)
  await harness.dispose()
  report.localCompaction = { passed: true, localRequests, localTools, summaries, outputCap: 1024 }

  console.log('Package probe: official Stagehand local extension')
  const abort = new AbortController()
  stagehand = await StagehandRuntime.open({
    goal: `在 ${base}/form 填写中文客户`,
    signal: abort.signal,
    headless: true,
    complete: async (request, signal) => {
      const response = await fetch(base + '/stagehand-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      })
      assert.ok(response.ok)
      return response.text()
    },
  })
  const page = await stagehand.context.newPage()
  const browserUserAgent = await page.evaluate(() => navigator.userAgent)
  assert.ok(browserUserAgent.includes('Edg/'), 'Packaged Stagehand must launch Microsoft Edge')
  await page.goto(base + '/form')
  const snapshot = await stagehand.snapshot(page)
  assert.ok(snapshot.formattedTree.includes('保存订单'))
  assert.ok(!snapshot.formattedTree.includes('package-password-canary'))
  const extracted = await stagehand.extract(page, '提取订单金额', z.object({ amount: z.number() }))
  assert.deepEqual(extracted.data, { amount: 42.5 })
  assert.equal(stagehandRequests, 2)
  for (const action of [
    { selector: '#customer', method: 'fill' as const, arguments: ['中文客户'] },
    { selector: '#save', method: 'click' as const, arguments: [] },
  ]) {
    const handle = await page.locator(action.selector).elementHandle()
    assert.ok(handle)
    const sent = await stagehand.act(page, action, async () => {
      assert.equal(page.url(), base + '/form')
      assert.equal(await page.locator(action.selector).count(), 1)
      assert.ok(await handle.evaluate((node) => node.isConnected))
    })
    assert.equal(sent.outcome, 'action_sent')
    await handle.dispose()
  }
  assert.equal(posts, 1)
  assert.equal(new URLSearchParams(saved[0]).get('customer'), '中文客户')
  assert.ok((await page.locator('body').innerText()).includes('包内浏览器已保存 中文客户 42.50'))
  assert.equal(stagehandRequests, 2)
  await stagehand.close()
  report.stagehand = {
    browserUserAgent,
    passed: true,
    extracted: extracted.data,
    posts,
    modelRequests: stagehandRequests,
    actualReadback: true,
  }

  console.log('Package probe: embedded Python creates and Docling parses Chinese DOCX')
  const pythonRoot = join(resources, 'runtime', 'docling')
  const python = join(pythonRoot, '.venv', 'Scripts', 'python.exe')
  const document = join(output, '中文隔离验收.docx')
  const code = [
    'import sys,json,importlib.metadata',
    'from pathlib import Path',
    'from docx import Document',
    'root=Path(sys.argv[1]).resolve()',
    'assert Path(sys.prefix).is_relative_to(root)',
    'assert all(Path(p).is_relative_to(root) for p in sys.path)',
    'document=Document()',
    'document.add_heading("中文发布包验收", 0)',
    'document.add_paragraph("客户：林悦；订单金额 42.50；来源：包内 Python。")',
    'table=document.add_table(rows=2, cols=2)',
    'table.cell(0,0).text="项目";table.cell(0,1).text="金额"',
    'table.cell(1,0).text="中文验收";table.cell(1,1).text="42.50"',
    'document.save(sys.argv[2])',
    'print(json.dumps({"python":sys.version,"prefix":sys.prefix,"path":sys.path,"docling":importlib.metadata.version("docling")},ensure_ascii=False))',
  ].join('\n')
  const child = spawn(python, ['-I', '-X', 'utf8', '-c', code, pythonRoot, document], {
    cwd: output,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (part) => {
    stdout += part
  })
  child.stderr.on('data', (part) => {
    stderr += part
  })
  const [exit] = await once(child, 'close')
  assert.equal(exit, 0, stderr)
  const pythonEvidence = JSON.parse(stdout)
  const service = new DoclingService({
    pythonPath: python,
    workerPath: join(resources, 'docling-worker.py'),
    cacheDirectory: join(output, 'docling-cache'),
    modelDirectory: join(pythonRoot, 'models'),
  })
  const parsed = await service.read(document, {}, new AbortController().signal)
  const text = parsed.blocks.map((block) => block.text).join('\n')
  assert.ok(text.includes('林悦') && text.includes('中文验收') && text.includes('42.50'))
  assert.ok(parsed.blocks.some((block) => block.table))
  assert.equal(
    parsed.source_sha256,
    createHash('sha256')
      .update(await readFile(document))
      .digest('hex'),
  )
  const cached = await service.read(document, {}, new AbortController().signal)
  assert.equal(cached.cache_hit, true)
  assert.equal(cached.document_id, parsed.document_id)
  report.docling = {
    passed: true,
    python: pythonEvidence,
    parserVersion: parsed.parser_version,
    blocks: parsed.block_count,
    sourceSha256: parsed.source_sha256,
    cacheHit: cached.cache_hit,
  }
  console.log('Package probe: streamed ZIP with Chinese names, empty directory and readback')
  const workspace = await WorkspaceSession.open(output, 'unused.ps1', async () => '')
  const archiveSignal = new AbortController().signal
  await workspace.call(
    { operation: 'make_directory', arguments: { path: '归档/空目录' } },
    archiveSignal,
  )
  await workspace.call(
    { operation: 'write_text', arguments: { path: '归档/内容😀.txt', text: '包内 ZIP 中文校验' } },
    archiveSignal,
  )
  const zipped = await workspace.call(
    { operation: 'create_zip', arguments: { source: '归档', path: '结果.zip' } },
    archiveSignal,
  )
  assert.equal(zipped.verified, true)
  assert.equal(zipped.entries, 2)
  assert.equal((await workspace.verify(String(zipped.artifact_id), archiveSignal)).verified, true)
  report.zip = { passed: true, entries: 2, readbackVerified: true, subprocess: false }
  report.ok = true
} catch (error) {
  report.error =
    error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  throw error
} finally {
  await stagehand?.close()
  await harness?.dispose()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log('Package runtime probe passed')
