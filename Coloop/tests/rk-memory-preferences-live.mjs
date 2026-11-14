// Explicit hardware acceptance through the normal CLI and application entry.
// Uses synthetic mail and a unique identity, never supplies a stored signature
// to the independent recall rounds. Not part of the default unit suite.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import electron from 'electron'

if (!process.argv.includes('--run-real-rk')) throw Error('EXPLICIT_REAL_RK_FLAG_REQUIRED')
const root = resolve(import.meta.dirname, '..')
const output = resolve(
  process.env.COLOOP_MEMORY_TEST_OUTPUT ?? join(root, '.qa', `rk-memory-preferences-${Date.now()}`),
)
const profile = join(output, 'profile')
const workspace = join(output, 'workspace')
const identity = 'ColoopQA' + randomUUID().replaceAll('-', '').slice(0, 8)
await mkdir(profile, { recursive: true })
await mkdir(workspace, { recursive: true })
const source = join(process.env.APPDATA, 'coloop')
const settings = JSON.parse(await readFile(join(source, 'state.json'), 'utf8')).settings
await writeFile(join(profile, 'state.json'), JSON.stringify({ settings, tasks: [] }))
// Only the existing encrypted board binding is reused. No task/memory databases.
await copyFile(join(source, 'auto-connection.json'), join(profile, 'auto-connection.json'))
// safeStorage's encrypted key is profile-bound. Reuse only its OS-protected
// key, not Chromium preferences, cookies, sessions or user databases.
const localState = JSON.parse(await readFile(join(source, 'Local State'), 'utf8'))
await writeFile(join(profile, 'Local State'), JSON.stringify({ os_crypt: localState.os_crypt }))
const report = {
  output,
  identity,
  scope: 'real RK / ordinary CLI / isolated app profile and synthetic files',
  rounds: [],
  passed: false,
}
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2))
async function cli(args, input) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, 'scripts/coloop-cli.mjs'),
        '--data-dir',
        profile,
        ...args,
        ...(input === undefined ? [] : ['--stdin']),
      ],
      { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk
    })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', () => {
      try {
        accept(JSON.parse(text))
      } catch {
        reject(Error('CLI_RESPONSE_INVALID'))
      }
    })
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
  if (!result.ok) throw Error(`${result.code ?? 'CLI_FAILED'}: ${result.error}`)
  return result.value
}
const env = { ...process.env, COLOOP_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
const executable = process.env.COLOOP_EXECUTABLE ?? electron
const app = spawn(executable, process.env.COLOOP_EXECUTABLE ? [] : [root], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
app.stdout.resume()
app.stderr.resume()
let activeId
try {
  let state
  for (let n = 0; n < 60; n++) {
    try {
      state = await cli(['status'])
      if (
        state.device?.status === 'connected' &&
        state.device.qwenReady &&
        state.device.modelPrivacyReady &&
        state.autoConnection?.phase === 'ready'
      )
        break
    } catch {}
    await delay(1000)
  }
  assert.equal(state?.device?.status, 'connected', 'Real RK must connect')
  assert.ok(
    state.device.qwenReady && state.device.modelPrivacyReady,
    'Private RK inference must be ready',
  )
  await save('connection.json', { device: state.device, autoConnection: state.autoConnection })
  await cli(['proactive', 'pause'], true)
  await cli(['sessions', 'resume'])
  report.capacity = state.device?.localModelCapacity ?? state.device?.capacity
  await save('report.json', report)
  const prompts = [
    `仅针对测试身份${identity}，请记住邮件偏好“中文先写结论，署名小林”。读取邮件1.txt，按偏好写回复草稿到草稿1.txt，回读确认。`,
    `这是独立的新任务。请使用测试身份${identity}已保存的邮件偏好，读取邮件2.txt，写回复草稿到草稿2.txt并回读确认。`,
    `仅将测试身份${identity}的署名偏好更新为林悦，保留其他邮件偏好。读取邮件3.txt，按更新后的偏好写回复草稿到草稿3.txt，回读确认。`,
    `这是独立的新任务。请使用测试身份${identity}已保存的邮件偏好，读取邮件4.txt，写回复草稿到草稿4.txt并回读确认。`,
  ]
  for (let n = 1; n <= 4; n++) {
    const incoming = `测试身份${identity}。包裹TEST-RECEIVE-${n}已完好收到，请回复确认。`
    await writeFile(join(workspace, `邮件${n}.txt`), incoming)
    const request = {
      prompt: prompts[n - 1],
      workspace,
      target: 'rk',
      source: 'text',
      intent: 'execute',
      policy: { mode: 'local', cloudFallback: false },
    }
    await save(`round-${n}-request.json`, request)
    const accepted = await cli(['task', 'run'], request)
    activeId = typeof accepted === 'string' ? accepted : accepted.id
    const round = { number: n, taskId: activeId, startedAt: new Date().toISOString() }
    report.rounds.push(round)
    await save('report.json', report)
    console.log(JSON.stringify(round))
    let previous = '',
      task
    const deadline = Date.now() + 25 * 60 * 1000
    while (Date.now() < deadline) {
      state = await cli(['status'])
      task = state.tasks.find((t) => t.id === activeId)
      const progress = JSON.stringify({
        round: n,
        status: task?.status,
        phase: state.proactive?.phase,
      })
      if (progress !== previous) {
        console.log(progress)
        previous = progress
      }
      await save('latest.json', { task, execution: state.proactive })
      if (task && task.status !== 'running') break
      if (state.proactive?.question) throw Error('UNEXPECTED_USER_QUESTION')
      await delay(10000)
    }
    const history = await cli(['history', 'task', '--string', activeId])
    await save(`round-${n}-history.json`, history)
    round.status = task?.status
    assert.equal(task?.status, 'completed', 'Task must finish through normal verification')
    activeId = undefined
    const draft = await readFile(join(workspace, `草稿${n}.txt`), 'utf8')
    round.memoryCalls = history.entries
      .filter((e) => e.kind === 'tool_call' && /memory|remember/.test(e.name ?? ''))
      .map((e) => e.name)
    round.draft = draft
    assert.notEqual(draft.trim(), incoming.trim(), 'A reply must not copy the incoming mail')
    assert.ok(draft.trimEnd().endsWith(n <= 2 ? '小林' : '林悦'), 'Expected persisted signature')
    if (n > 1)
      assert.ok(
        round.memoryCalls.includes('coloop_memory_search'),
        'Recall and correction tasks must retrieve scoped preferences',
      )
    if (n === 1 || n === 3)
      assert.ok(
        round.memoryCalls.includes('coloop_remember_preference'),
        'Explicit save/update must persist',
      )
    // Independently inspect persisted records; never pass them to subsequent tasks.
    await cli(['credentials', 'protect'], true)
    const matching = []
    try {
      for (let offset = 0; ; offset += 50) {
        const page = await cli(['memory', 'browse'], {
          query: '',
          category: 'ordinary',
          tag: 'user_preference',
          offset,
          limit: 50,
        })
        matching.push(...page.items.filter((item) => JSON.stringify(item).includes(identity)))
        if (!page.items.length || offset + page.items.length >= page.total) break
      }
    } finally {
      await cli(['credentials', 'protect'], false)
    }
    round.persisted = matching
    assert.ok(matching.length, 'A scoped preference must exist independently of task history')
    round.passed = true
    await save('report.json', report)
  }
  report.passed = true
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  if (activeId) {
    try {
      await save('interrupted-history.json', await cli(['history', 'task', '--string', activeId]))
    } catch {}
    try {
      await cli(['proactive', 'stop'])
    } catch {}
  }
  // A just-cancelled model/observation can briefly retain the device. Wait for
  // normal shutdown; leaving that instance alive would block the next test.
  for (let n = 0; n < 60; n++) {
    try {
      await cli(['app', 'quit'])
      report.quitRequested = true
      break
    } catch (error) {
      if (n === 59) report.shutdownError = error.message
      await delay(1000)
    }
  }
  report.finishedAt = new Date().toISOString()
  await save('report.json', report)
  console.log(JSON.stringify(report))
}
