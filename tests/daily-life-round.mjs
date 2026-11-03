// Real packaged Coloop + RK + configured model. Driver only dispatches and reads.
// Business execution is exclusively performed by the production task/Agent loop.
import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
const output = resolve(process.env.COLOOP_DAILY_OUTPUT || '.qa/daily-life-round1')
const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
const evidenceRoot = join(
  process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'coloop',
  'task-scripts',
)
const browser = await chromium.connectOverCDP(
  process.env.COLOOP_DAILY_CDP || 'http://127.0.0.1:19223',
)
const pages = browser.contexts().flatMap((c) => c.pages())
const candidates = pages.filter((p) => /\/app\.asar\/out\/renderer\/index\.html$/.test(p.url()))
if (candidates.length !== 1) throw new Error('Expected one packaged Coloop main renderer')
const page = candidates[0]
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const report = {
  started_at: new Date().toISOString(),
  version: manifest.version,
  scope: 'Production dispatchTask IPC; real configured RK/model; no business action substitution.',
  prior_attempts: manifest.prior_attempts || [],
  cases: [],
  skipped: manifest.skipped,
}
const save = () => writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2))
const log = (value) => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }))
const state = (id) =>
  page.evaluate(async (id) => {
    const response = await window.coloop.snapshot()
    if (!response.ok) throw new Error(response.error)
    const s = response.value
    return {
      task: s.tasks.find((t) => t.id === id),
      phase: s.proactive?.phase,
      activeTaskId: s.proactive?.taskId,
      question: s.proactive?.question,
      qwenReady: s.device?.qwenReady,
      agentStatus: s.proactive?.status,
    }
  }, id)
try {
  const initial = await state('')
  if (!initial.qwenReady) {
    const reconnect = await page.evaluate(() => window.coloop.retryRkConnection())
    log({ event: 'reconnect', ok: reconnect.ok })
    for (let i = 0; i < 60 && !(await state('')).qwenReady; i++) await pause(1000)
    if (!(await state('')).qwenReady) throw new Error('RK not ready')
  }
  for (const test of manifest.tasks) {
    const record = {
      id: test.id,
      name: test.name,
      prompt: test.prompt,
      started_at: new Date().toISOString(),
      status: 'RUNNING',
      assistance: [],
      phases: [],
    }
    report.cases.push(record)
    await mkdir(join(output, test.id), { recursive: true })
    await save()
    const dispatched = await page.evaluate(
      (prompt) =>
        window.coloop.dispatchTask({ prompt, target: 'hybrid', source: 'text', context: '' }),
      test.prompt,
    )
    if (!dispatched.ok) {
      record.status = 'ADMISSION_FAILED'
      record.error = dispatched.error
      await save()
      throw new Error('Dispatch failed: ' + dispatched.error)
    }
    record.task_id = dispatched.value.id
    log({ event: 'started', id: test.id, task_id: record.task_id })
    const start = Date.now()
    let questionSince = 0,
      lastPhase = '',
      stopped = false
    while (true) {
      const current = await state(record.task_id)
      if (current.task?.status !== 'running') {
        record.task = current.task
        record.status =
          current.task?.status === 'completed'
            ? 'COMPLETED_REVIEW'
            : stopped
              ? record.status
              : (current.task?.status || 'TASK_MISSING').toUpperCase()
        break
      }
      const phase = `${current.task.stage} / ${current.phase || ''}`
      if (phase !== lastPhase) {
        record.phases.push({ at: new Date().toISOString(), phase })
        log({ event: 'phase', id: test.id, phase })
        lastPhase = phase
        await save()
      }
      if (current.activeTaskId === record.task_id && current.phase === 'waiting_user') {
        questionSince ||= Date.now()
        record.question = current.question
      } else questionSince = 0
      if (
        !stopped &&
        (Date.now() - start > test.max_ms || (questionSince && Date.now() - questionSince > 45000))
      ) {
        record.status = questionSince ? 'BLOCKED_QUESTION' : 'TIMEOUT'
        record.stop_reason = questionSince
          ? 'Unexpected user dependency; no synthetic answer supplied.'
          : 'Round observation deadline; not success.'
        const cancel = await page.evaluate((id) => window.coloop.cancelTask(id), record.task_id)
        log({ event: 'cancel', id: test.id, reason: record.status, ok: cancel.ok })
        stopped = true
      }
      if (stopped && Date.now() - start > test.max_ms + 60000)
        throw new Error('Task cancellation did not settle')
      await pause(2000)
    }
    record.finished_at = new Date().toISOString()
    record.duration_ms = Date.now() - start
    record.artifact_directory = join(evidenceRoot, record.task_id)
    record.files = await readdir(record.artifact_directory).catch(() => [])
    const entries = await readdir(record.artifact_directory, { withFileTypes: true }).catch(
      () => [],
    )
    record.script_receipts = []
    for (const entry of entries.filter((x) => x.isDirectory())) {
      const receipt = await readFile(
        join(record.artifact_directory, entry.name, 'result.json'),
        'utf8',
      )
        .then(JSON.parse)
        .catch(() => null)
      if (receipt)
        record.script_receipts.push({
          execution_id: entry.name,
          verified: receipt.verified,
          exit_code: receipt.exit_code,
          timed_out: receipt.timed_out,
          truncated: receipt.truncated,
          evidence: receipt.evidence,
          stderr: receipt.stderr,
          verification: receipt.verification,
        })
    }
    await writeFile(join(output, test.id, 'task.json'), JSON.stringify(record, null, 2))
    await page.screenshot({ path: join(output, test.id, 'coloop.png') }).catch((error) => {
      record.capture_error = error.message
    })
    log({ event: 'finished', id: test.id, status: record.status, duration_ms: record.duration_ms })
    await save()
    // Production terminal callback releases its slot asynchronously.
    for (let i = 0; i < 30; i++) {
      const current = await state(record.task_id)
      if (
        current.activeTaskId !== record.task_id ||
        !['executing', 'verifying', 'waiting_user', 'cloud_planning', 'reviewing'].includes(
          current.phase,
        )
      )
        break
      await pause(1000)
    }
  }
  report.finished_at = new Date().toISOString()
  await save()
} catch (error) {
  report.error = error.message
  await save()
  throw error
} finally {
  await browser.close() // Disconnect the driver; leave the user's app running.
}
