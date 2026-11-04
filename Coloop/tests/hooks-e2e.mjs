import { _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `hooks-${Date.now()}`)
const profile = resolve(output, 'profile')
await mkdir(output, { recursive: true })
const checks = []
const app = await electron.launch({
  executablePath: process.env.COLOOP_EXECUTABLE || undefined,
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  cwd: root,
  env: { ...process.env, COLOOP_DATA_DIR: profile, ELECTRON_RENDERER_URL: '' },
})
let connectionPath
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  await page.getByRole('button', { name: 'Agent 协调', exact: true }).click()
  let snapshot = (await page.evaluate(() => window.coloop.snapshot())).value
  connectionPath = snapshot.coordinator.connectionPath
  const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
  const source = {
    sourceId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: randomUUID(),
    taskId: randomUUID(),
  }
  let sequence = 0
  const envelope = (kind, payload) => ({
    version: 1,
    source: 'opencode',
    ...source,
    sequence: ++sequence,
    eventId: randomUUID(),
    kind,
    workspace: root,
    payload,
  })
  const post = async (path, body) => {
    const response = await fetch(connection.url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const marker = 'sk-COLOOPTESTONLYPRIVATEKEY0000'
  const message = envelope('message', {
    text: `password=${marker}`,
    role: 'user',
    messageId: 'message-1',
    partId: 'part-1',
  })
  await post('/v1/hooks', message)
  const duplicate = await post('/v1/hooks', message)
  assert.equal(duplicate.duplicate, true)
  snapshot = (await page.evaluate(() => window.coloop.snapshot())).value
  assert.equal(snapshot.hooks.receivedEvents, 1)
  assert.equal(snapshot.hooks.duplicateEvents, 1)
  assert.equal(JSON.stringify(snapshot.hooks).includes(marker), false)
  assert.equal(JSON.stringify(snapshot).includes(connection.token), false)
  assert.equal(snapshot.tasks.length, 0)
  checks.push({
    check: 'native Hook ingest, duplicate suppression, secret redaction, no task-history write',
    passed: true,
  })
  await post('/v1/hooks', envelope('closed', {}))

  const password = process.env.COLOOP_TEST_BOARD_PASSWORD
  if (password) {
    assert.equal((await page.evaluate(() => window.coloop.importRk())).ok, true)
    const connected = await page.evaluate((secret) => window.coloop.connect(secret), password)
    assert.equal(connected.ok, true)
    assert.equal(connected.value.qwenReady, true)
    assert.equal(connected.value.modelPrivacyReady, true)
    assert.equal(connected.value.hookRelayReady, true)
    checks.push({
      check: 'real pinned SSH and private reverse Hook relay, plugin and launcher installed',
      passed: true,
    })
    if (process.env.COLOOP_TEST_MANAGED_READ === '1' || process.env.COLOOP_TEST_MANAGED_BENCH) {
      assert.ok(connected.value.hookLauncher.endsWith('/coloop-managed.sh'))
      await app.evaluate(async () => {
        const http = process.getBuiltinModule('http')
        const { syncBuiltinESMExports } = process.getBuiltinModule('module')
        const original = http.request
        const captures = []
        globalThis[Symbol.for('coloop.synthetic.review.requests')] = captures
        http.request = function (options, ...args) {
          const pending = original.call(this, options, ...args)
          if (
            options.path === '/v1/chat/completions' &&
            options.headers?.['x-rk-privacy'] === 'metadata-only'
          ) {
            const end = pending.end
            pending.end = function (body, ...rest) {
              if (body && captures.length < 256) {
                const value = JSON.parse(body.toString())
                captures.push({
                  model: value.model,
                  messages: value.messages,
                  max_tokens: value.max_tokens,
                })
              }
              return end.call(this, body, ...rest)
            }
          }
          return pending
        }
        syncBuiltinESMExports()
      })
      const benchmark = process.env.COLOOP_TEST_MANAGED_BENCH
      const experiment = benchmark || resolve('D:/RK/logs', `coloop-managed-read-${Date.now()}`)
      let driverFailure
      try {
        await run(
          'D:\\RK\\.venv\\Scripts\\python.exe',
          [
            benchmark
              ? 'D:\\RK\\tools\\bench_coloop_managed.py'
              : 'D:\\RK\\tools\\smoke_coloop_managed.py',
            '--connection',
            connectionPath,
            benchmark ? '--run-dir' : '--output-dir',
            experiment,
            ...(benchmark && process.env.COLOOP_TEST_MANAGED_CASES
              ? ['--cases', process.env.COLOOP_TEST_MANAGED_CASES]
              : []),
          ],
          {
            timeout: benchmark ? 5_500_000 : 350_000,
            windowsHide: true,
            encoding: 'utf8',
            env: { ...process.env, RK_BOARD_PASSWORD: password },
          },
        )
      } catch (error) {
        driverFailure = error
      }
      const reviewRequests = await app.evaluate(
        () => globalThis[Symbol.for('coloop.synthetic.review.requests')],
      )
      await writeFile(
        resolve(experiment, 'review-model-requests.json'),
        JSON.stringify(reviewRequests, null, 2),
      )
      if (benchmark) {
        const result = JSON.parse(
          await readFile(resolve(experiment, 'native-functional-summary.json'), 'utf8'),
        )
        checks.push({
          check:
            'fixed native suite: real primary, RK and original pending; functional and strict safety scores remain separate',
          output: experiment,
          ...result,
        })
      } else {
        if (driverFailure) throw driverFailure
        const oracle = JSON.parse(await readFile(resolve(experiment, 'oracle.json'), 'utf8'))
        assert.ok(reviewRequests.length >= 1)
        assert.equal(JSON.stringify(reviewRequests).includes(oracle.nonce), false)
        const smoke = JSON.parse(await readFile(resolve(experiment, 'summary.json'), 'utf8'))
        assert.equal(smoke.passed, true)
        checks.push({
          check:
            'real managed snapshot read, RK signed once, original pending consumed, actual file nonce returned; reviewer never received file nonce',
          passed: true,
          output: experiment,
        })
      }
    }
    if (process.env.COLOOP_TEST_SOURCE_DIAGNOSTIC === '1') {
      const experiment = resolve('D:/RK/logs', `coloop-source-json-diagnostic-${Date.now()}`)
      await run(
        'D:\\RK\\.venv\\Scripts\\python.exe',
        [
          'D:\\RK\\tmp\\diagnose_coloop_source.py',
          '--connection',
          connectionPath,
          '--output-dir',
          experiment,
        ],
        {
          timeout: 300_000,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, RK_BOARD_PASSWORD: password },
        },
      )
      checks.push({
        check:
          'one explicitly nonprivate synthetic primary-model diagnostic; excluded from performance/privacy acceptance',
        output: experiment,
      })
    }
    if (process.env.COLOOP_HOOK_REVIEW_PROBE === '1') {
      const probeResults = []
      for (const index of [0, 1]) {
        const probe = {
          ...envelope('approval', {}),
          instanceId: 'compact-classification-probe-' + index,
          sessionId: 'probe-session-' + index,
          taskId: 'probe-task-' + index,
        }
        const labels = ['仅在本地离线分析，不上传任何数据', '取消本次操作并保持当前状态']
        if (index) labels.reverse()
        probe.payload.approval = {
          kind: 'question',
          id: 'probe-question-' + index,
          sessionId: probe.sessionId,
          originalDigest: 'a'.repeat(64),
          question: '本次合成任务选择哪种方式？',
          choices: labels.map((label, position) => ({ id: String(position), label })),
        }
        const result = await post('/v1/hooks/review', probe)
        probeResults.push({ index, decision: result.decision, metrics: result.metrics })
        await post('/v1/hooks', {
          ...probe,
          sequence: probe.sequence + 1,
          eventId: randomUUID(),
          kind: 'closed',
          payload: {},
        })
      }
      await writeFile(
        resolve(output, 'classification-probe.json'),
        JSON.stringify(probeResults, null, 2),
      )
      assert.ok(
        probeResults.every(
          (result) =>
            result.decision.decision === 'select' &&
            result.decision.choiceId === String(result.index),
        ),
      )
      checks.push({
        check:
          'synthetic compact RK classification for both positions; no source pending or native consumption claimed',
        passed: true,
      })
    }
    if (process.env.COLOOP_TEST_INTERNAL_HOOK === '1') {
      const experiment = resolve('D:/RK/logs', `coloop-internal-hook-${Date.now()}`)
      const result = await run(
        'D:\\RK\\.venv\\Scripts\\python.exe',
        [
          'D:\\RK\\tools\\smoke_coloop_internal_hook.py',
          '--connection',
          connectionPath,
          '--output-dir',
          experiment,
        ],
        {
          timeout: 300_000,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, RK_BOARD_PASSWORD: password },
        },
      )
      assert.equal(result.stdout.includes(connection.token), false)
      const smoke = JSON.parse(await readFile(resolve(experiment, 'summary.json'), 'utf8'))
      checks.push({
        check: 'real OpenCode mini in-process SDK Hook and NPU; no source TCP listener',
        passed: smoke.passed === true,
        output: experiment,
      })
      assert.equal(smoke.passed, true)
    }
    if (process.env.COLOOP_TEST_HOOK_BENCH === '1') {
      const experiment = resolve('D:/RK/logs', `coloop-hooks-benchmark-${Date.now()}`)
      const pilot = process.env.COLOOP_HOOK_PILOT === '1'
      const controlled = process.env.COLOOP_HOOK_CONTROLLED_SOURCE === '1'
      const result = await run(
        'D:\\RK\\.venv\\Scripts\\python.exe',
        [
          controlled
            ? 'D:\\RK\\tools\\bench_coloop_hook_transport.py'
            : 'D:\\RK\\tools\\bench_coloop_hooks.py',
          '--connection',
          connectionPath,
          '--output-dir',
          experiment,
          '--samples',
          process.env.COLOOP_HOOK_SAMPLES || '20',
          '--hook-samples',
          '100',
          '--timeout',
          '1200',
          ...(pilot ? ['--pilot'] : []),
        ],
        {
          timeout: 1_300_000,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, RK_BOARD_PASSWORD: password },
        },
      )
      assert.equal(result.stdout.includes(connection.token), false)
      const bench = JSON.parse(await readFile(resolve(experiment, 'summary.json'), 'utf8'))
      if (controlled) assert.equal(bench.source_model_scripted, true)
      checks.push({
        check: pilot
          ? 'real native Hook functionality pilot; not a formal percentile benchmark'
          : controlled
            ? 'controlled source + real OpenCode native pending + real RK approval performance; not primary-model task success rate'
            : 'real native Hook + RK + original pending consumed performance benchmark',
        passed: pilot ? bench.functionalityPassed === true : bench.passed === true,
        performancePassed: bench.passed === true,
        output: experiment,
      })
      assert.equal(pilot ? bench.functionalityPassed : bench.passed, true)
    }
  }
  for (const width of [1440, 1060]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 940),
      width,
    )
    await page.locator('[aria-label="原生 Hook"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(output, `hooks-${width}.png`), animations: 'disabled' })
    assert.equal(
      await page
        .locator('.coordination-page')
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
      false,
    )
  }
  checks.push({ check: 'Hook status and context management UI at 1440/1060 width', passed: true })
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify({ checks, realBoard: !!password }, null, 2),
  )
  console.log(JSON.stringify({ output, checks }, null, 2))
} finally {
  await app.close()
  if (connectionPath) {
    let remains = true
    try {
      await access(connectionPath)
    } catch {
      remains = false
    }
    assert.equal(remains, false)
  }
}
