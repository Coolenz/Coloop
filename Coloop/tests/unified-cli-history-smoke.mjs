import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'

const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', `unified-cli-history-${Date.now()}`)
await mkdir(output, { recursive: true })
const temporary = join(root, '.cache', 'tmp', 'unified-cli-history')
await mkdir(temporary, { recursive: true })
const profile = await mkdtemp(join(temporary, 'run-'))
const env = { ...workspaceCacheEnvironment(root), COLOOP_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
const id = randomUUID()
await writeFile(
  join(profile, 'state.json'),
  JSON.stringify({
    schemaVersion: 1,
    settings: {
      provider: {
        protocol: 'openai',
        name: 'fixture',
        baseUrl: 'https://example.invalid/v1',
        model: 'fixture',
      },
      board: { host: '127.0.0.1', port: 22, username: 'test', fingerprint: 'A'.repeat(43) },
      ocrWorkspace: root,
    },
    encryptedKey: '',
    encryptedDecisionKey: '',
    tasks: [
      {
        id,
        prompt: '统一验收历史任务',
        target: 'cloud',
        source: 'text',
        status: 'completed',
        createdAt: new Date().toISOString(),
        answer: '合成任务完成',
        stage: '完成',
        model: 'fixture',
      },
    ],
  }),
)
const session = join(
  profile,
  '.coloop-harness',
  createHash('sha256').update(id).digest('hex'),
  'sessions',
  'fixture',
  id,
)
await mkdir(session, { recursive: true })
await writeFile(
  join(session, 'session.v4.jsonl'),
  [
    { type: 'session', id },
    { type: 'user/message', data: { content: '请读取测试页面' } },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '已准备读取测试页面' }] } },
    },
    {
      type: 'tool/call',
      data: { name: 'coloop_web', callId: 'fixture-call', arguments: { operation: 'observe' } },
    },
    {
      type: 'tool/result',
      data: {
        message: {
          toolCallId: 'fixture-call',
          content: [{ type: 'text', text: 'fixture-tool-result' }],
        },
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n') + '\n',
)
let app
const report = {
  ok: false,
  scope:
    'isolated package CLI and renderer with synthetic task history; no external model or personal account',
}
try {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    env,
    timeout: 15000,
  })
  app.process().stderr.on('data', (part) => { report.stderr = ((report.stderr ?? '') + part.toString()).slice(-8000) })
  console.log('Unified smoke: Electron launched')
  await app.firstWindow()
  let main
  for (let attempt = 0; attempt < 100 && !main; attempt++) {
    main = app.windows().find((page) => page.url().includes('index.html') && !page.url().includes('surface=control'))
    if (!main) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(main)
  main.setDefaultTimeout(10000)
  await main.waitForFunction(() => !!window.coloop)
  let connection
  for (let attempt = 0; attempt < 100 && !connection; attempt++) {
    try { connection = JSON.parse(await readFile(join(profile, 'local-control', 'connection.json'), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.ok(connection, 'Local command service must become ready')
  console.log('Unified smoke: local control ready')
  const cli = process.env.COLOOP_EXECUTABLE
    ? join(resolve(process.env.COLOOP_EXECUTABLE, '..'), 'resources', 'cli', 'coloop-cli.mjs')
    : join(root, 'scripts', 'coloop-cli.mjs')
  const run = async (...args) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [cli, '--data-dir', profile, ...args], {
          cwd: root,
          env,
          windowsHide: true,
          timeout: 30000,
        })
      ).stdout,
    )
  const commands = await run('commands')
  assert.equal(commands.ok, true)
  for (const name of ['history:task', 'task:dispatch', 'browser:config', 'browser:connection'])
    assert.ok(
      commands.value.some((command) => command.name === name),
      name,
    )
  report.commandCount = commands.value.length
  const history = await run('history', 'task', '--string', id)
  console.log('Unified smoke: CLI history received')
  assert.equal(history.ok, true)
  assert.equal(history.value.entries.length, 4)
  assert.ok(
    history.value.entries.some(
      (entry) => entry.name === 'coloop_web' && entry.kind === 'tool_call',
    ),
  )
  const unauthenticated = await fetch(`${connection.url}/v1/commands`)
  assert.equal(unauthenticated.status, 403)
  await main
    .getByRole('button', { name: /历史记录/ })
    .first()
    .click()
  await main.getByRole('button', { name: /统一验收历史任务/ }).click()
  await main.getByRole('heading', { name: '任务详情', exact: true }).waitFor()
  await main.getByText('已准备读取测试页面', { exact: true }).waitFor()
  await main.locator('summary').filter({ hasText: '工具返回' }).click()
  await main.getByText('fixture-tool-result', { exact: true }).waitFor()
  await main.screenshot({ path: join(output, 'history-detail.png') })
  report.ok = true
  report.checks = [
    'CLI command discovery',
    'CLI history readback',
    'unauthenticated request rejected',
    'history row opens details',
    'assistant message and tool result displayed',
  ]
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  await app?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ ok: true, output }))
