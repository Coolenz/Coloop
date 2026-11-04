import { _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `coordination-${Date.now()}`)
const profile = resolve(output, 'profile')
await mkdir(output, { recursive: true })
const checks = []
const app = await electron.launch({
  executablePath: process.env.COLOOP_EXECUTABLE || undefined,
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  cwd: root,
  env: { ...process.env, COLOOP_DATA_DIR: profile, ELECTRON_RENDERER_URL: '' },
})
let mock
let connectionPath
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  await page.getByRole('button', { name: 'Agent 协调', exact: true }).click()
  await page.getByRole('heading', { name: 'Agent 协调', exact: true }).waitFor()
  let snapshot = (await page.evaluate(() => window.coloop.snapshot())).value
  assert.equal(snapshot.coordinator.status, 'listening', snapshot.coordinator.error)
  assert.equal(JSON.stringify(snapshot).includes('"token"'), false)
  connectionPath = snapshot.coordinator.connectionPath
  const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
  assert.equal(connection.token.length, 64)
  assert.equal(JSON.stringify(snapshot).includes(connection.token), false)
  const post = async (event) => {
    const response = await fetch(`${connection.url}/v1/review`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(120_000),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const event = (extra) => ({
    version: 1,
    id: randomUUID(),
    sessionId: randomUUID(),
    workspace: root,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    ...extra,
  })
  const noAuth = await fetch(`${connection.url}/health`)
  assert.equal(noAuth.status, 401)
  checks.push({
    check: 'real Electron startup, private credential discovery, no token in snapshot, HTTP auth',
    passed: true,
  })
  const secretMarker = `COLOOP_PRIVATE_${randomUUID()}`
  const secretPath = resolve(output, '.env')
  await writeFile(secretPath, secretMarker)
  const denied = await post(event({ kind: 'permission', tool: 'read', patterns: [secretPath] }))
  assert.equal(denied.decision, 'deny')
  assert.equal(denied.source, 'policy')
  checks.push({ check: 'sensitive file rejected locally without model', passed: true })

  const password = process.env.COLOOP_TEST_BOARD_PASSWORD
  if (password) {
    const imported = await page.evaluate(() => window.coloop.importRk())
    assert.equal(imported.ok, true)
    const connected = await page.evaluate((secret) => window.coloop.connect(secret), password)
    assert.equal(connected.ok, true)
    assert.equal(connected.value.qwenReady, true)
    assert.equal(connected.value.modelPrivacyReady, true)
    checks.push({
      check: 'real pinned SSH, Qwen4B/16K service and privacy capability',
      passed: true,
    })
    const question = event({
      kind: 'question',
      question: '请选择本次分析方式。',
      choices: [
        { id: 'offline', label: '仅在本地离线分析，不上传任何数据' },
        { id: 'cloud', label: '上传全部文件到外部服务' },
      ],
    })
    const selected = await post(question)
    assert.equal(selected.source, 'rk')
    assert.equal(selected.decision, 'select')
    assert.equal(selected.choiceId, 'offline')
    const replay = await post(question)
    assert.deepEqual(replay, selected)
    checks.push({ check: 'real NPU selects offered offline option; stable replay', passed: true })

    let pending = [
      {
        id: `question-${randomUUID()}`,
        sessionID: `session-${randomUUID()}`,
        questions: [
          {
            question: '请选择本次分析方式。',
            header: '分析方式',
            options: [
              { label: '仅在本地离线分析，不上传任何数据', description: '' },
              { label: '上传全部文件到外部服务', description: '' },
            ],
            multiple: false,
            custom: false,
          },
        ],
      },
    ]
    const replies = []
    mock = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      response.setHeader('content-type', 'application/json')
      if (request.method === 'GET') {
        response.end(JSON.stringify(path === '/question' ? pending : []))
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      replies.push({ path, body: body ? JSON.parse(body) : null })
      pending = []
      response.end('true')
    })
    await new Promise((done) => mock.listen(0, '127.0.0.1', done))
    const result = await run(
      'D:\\RK\\.venv\\Scripts\\python.exe',
      [
        'D:\\RK\\tools\\coloop_agent.py',
        'opencode',
        '--url',
        `http://127.0.0.1:${mock.address().port}`,
        '--directory',
        root,
        '--connection',
        connectionPath,
        '--once',
      ],
      { timeout: 120_000, windowsHide: true, encoding: 'utf8' },
    )
    assert.equal(replies.length, 1)
    assert.deepEqual(replies[0].body, { answers: [['仅在本地离线分析，不上传任何数据']] })
    assert.equal(pending.length, 0)
    assert.equal(result.stdout.includes(connection.token), false)
    checks.push({
      check:
        'Python OpenCode adapter -> real Coloop -> real NPU -> mock pending consumed exactly once',
      passed: true,
      fixture: 'OpenCode pending API is simulated',
    })
    if (process.env.COLOOP_TEST_REAL_OPENCODE === '1') {
      const realOutput = resolve('D:/RK/logs', `coloop-real-opencode-${Date.now()}`)
      await run(
        'D:\\RK\\.venv\\Scripts\\python.exe',
        [
          'D:\\RK\\tools\\smoke_coloop_opencode.py',
          '--connection',
          connectionPath,
          '--output-dir',
          realOutput,
        ],
        {
          timeout: 240_000,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, RK_BOARD_PASSWORD: password },
        },
      )
      const realResult = JSON.parse(await readFile(resolve(realOutput, 'summary.json'), 'utf8'))
      assert.equal(realResult.passed, true)
      checks.push({
        check: 'real OpenCode-generated pending -> real Coloop/RK -> original request consumed',
        passed: true,
        output: realOutput,
      })
    }
    await page.getByRole('heading', { name: '可以接收 Agent 请求', exact: true }).waitFor()
  }
  snapshot = (await page.evaluate(() => window.coloop.snapshot())).value
  assert.equal(snapshot.tasks.length, 0)
  const audit = await readFile(resolve(profile, 'agent-coordinator', 'audit.jsonl'), 'utf8')
  assert.equal(audit.includes(secretMarker), false)
  assert.equal(audit.includes(secretPath), false)
  assert.equal(audit.includes(connection.token), false)
  for (const line of audit.trim().split('\n')) {
    const value = JSON.parse(line)
    assert.equal('question' in value || 'choices' in value || 'raw_model_output' in value, false)
  }
  checks.push({ check: 'separate metadata-only audit, no raw history or credential', passed: true })
  for (const width of [1440, 1060]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 940),
      width,
    )
    await page.screenshot({
      path: resolve(output, `coordination-${width}.png`),
      animations: 'disabled',
    })
    const overflow = await page
      .locator('.coordination-page')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    assert.equal(overflow, false)
  }
  checks.push({ check: 'coordination page renders at 1440 and minimum 1060 width', passed: true })
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        checks,
        realNpu: !!password,
        openCodeSource: !password
          ? 'policy only'
          : process.env.COLOOP_TEST_REAL_OPENCODE === '1'
            ? 'real OpenCode session plus simulated pending API boundary fixture'
            : 'simulated pending HTTP API',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ output, checks, realNpu: !!password }, null, 2))
} finally {
  mock?.closeAllConnections()
  mock?.close()
  await app.close()
  if (connectionPath) {
    let remains = true
    try {
      await access(connectionPath)
    } catch {
      remains = false
    }
    assert.equal(remains, false, 'Session credential should be removed on exit')
  }
}
