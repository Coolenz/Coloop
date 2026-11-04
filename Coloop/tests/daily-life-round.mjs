// Real packaged Coloop + RK + configured model. Driver only dispatches and reads.
// Business execution is exclusively performed by the production task/Agent loop.
import { chromium } from 'playwright-core'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { ProgressMonitor, ReceiptProgressReader } from './daily-life-progress.mjs'
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
  assessment_policy:
    'No total task deadline. Track continuity and delivery separately; stalls are diagnostic and do not cancel tasks.',
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
      progress_events: [],
      continuity_status: 'running',
      delivery_status: 'pending',
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
    const monitor = new ProgressMonitor(
      performance.now(),
      test.stall_timeout_ms ?? manifest.stall_timeout_ms,
    )
    const reader = new ReceiptProgressReader(join(evidenceRoot, record.task_id))
    let lastPhase = '',
      lastProgressState = '',
      hadStall = false
    while (true) {
      let current
      try {
        current = await state(record.task_id)
        if (!current.task) throw new Error('Task snapshot temporarily missing')
      } catch (error) {
        log({ event: 'observation_retry', id: test.id, reason: error.message })
        await pause(2000)
        continue
      }
      if (current.task?.status !== 'running') {
        record.task = current.task
        record.status =
          current.task?.status === 'completed'
            ? 'COMPLETED_REVIEW'
            : (current.task?.status || 'TASK_MISSING').toUpperCase()
        record.continuity_status =
          current.task.status === 'failed'
            ? 'interrupted'
            : current.task.status === 'cancelled'
              ? 'stopped'
              : hadStall
                ? 'stall_observed'
                : 'continuous'
        record.delivery_status = 'review_required'
        break
      }
      const phase = `${current.task.stage} / ${current.phase || ''}`
      if (phase !== lastPhase) {
        record.phases.push({ at: new Date().toISOString(), phase })
        log({ event: 'phase', id: test.id, phase })
        lastPhase = phase
        await save()
      }
      const waiting = current.activeTaskId === record.task_id && current.phase === 'waiting_user'
      if (waiting) {
        record.question = current.question
      }
      const markers = await reader.read()
      if (current.task.answer?.trim()) markers.push(`answer:${current.task.answer}`)
      const progress = monitor.update(performance.now(), markers, waiting)
      if (progress.state === 'stalled') hadStall = true
      if (progress.new_evidence || progress.state !== lastProgressState) {
        record.progress_events.push({ at: new Date().toISOString(), ...progress })
        record.continuity_status = progress.state
        log({ event: 'progress', id: test.id, ...progress })
        lastProgressState = progress.state
        await save()
      }
      // Elapsed total time, phase cycling and waiting for a user answer never
      // cancel the task. A stall is diagnostic; preserve the task for recovery.
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
