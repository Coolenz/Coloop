import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { ProgressMonitor, ReceiptProgressReader, evidenceMarker } from './daily-life-progress.mjs'
const minute = 60000
const proof = (evidence) => ({ verified: true, evidence })

test('a long-running task with fresh evidence has no total duration cutoff', () => {
  const monitor = new ProgressMonitor(0)
  for (let i = 1; i <= 36; i++) {
    const state = monitor.update(i * 10 * minute, [evidenceMarker(proof({ collectedItems: i }))])
    assert.equal(state.state, 'running')
    assert.equal(state.idle_ms, 0)
  }
})
test('repeated observations and alternating previously seen facts are not progress', () => {
  const monitor = new ProgressMonitor(0)
  const a = evidenceMarker(proof({ display: 0 })),
    b = evidenceMarker(proof({ display: 311 }))
  monitor.update(0, [a, b])
  for (let i = 1; i <= 14; i++)
    assert.equal(monitor.update(i * minute, [i % 2 ? a : b]).state, 'running')
  assert.equal(monitor.update(15 * minute, [a]).state, 'stalled')
  assert.equal(
    monitor.update(16 * minute, [evidenceMarker(proof({ display: 62 }))]).state,
    'running',
  )
})
test('timestamps and execution identity do not turn identical facts into progress', () => {
  assert.equal(
    evidenceMarker(
      proof({
        total: 3,
        collectedAt: '2026-11-04T00:00:00Z',
        path: '/task/11111111-1111-1111-1111-111111111111/proof.json',
      }),
    ),
    evidenceMarker(
      proof({
        total: 3,
        collectedAt: '2026-11-04T01:00:00Z',
        path: '/task/22222222-2222-2222-2222-222222222222/proof.json',
      }),
    ),
  )
  assert.equal(evidenceMarker(proof({ captured_at: '2026-11-04T01:00:00Z' })), null)
})
test('failed requests and empty proofs never refresh the progress clock', () => {
  const monitor = new ProgressMonitor(0, minute)
  assert.equal(evidenceMarker({ verified: false, evidence: { error: 'offline' } }), null)
  assert.equal(evidenceMarker({ verified: true, evidence: '' }), null)
  assert.equal(monitor.update(2 * minute, [null]).state, 'stalled')
})
test('waiting for a user has no 45-second cutoff and is excluded from idle time', () => {
  const monitor = new ProgressMonitor(0, minute)
  assert.equal(monitor.update(1000, [], true).state, 'waiting_user')
  assert.equal(monitor.update(60 * minute, [], true).state, 'waiting_user')
  assert.equal(monitor.update(61 * minute, [], false).state, 'running')
  assert.equal(monitor.update(61 * minute + 1000).idle_ms, 1000)
})
test('receipt polling tolerates partial files and deduplicates a repeated execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'coloop-progress-'))
  t.after(async () => {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('coloop-progress-'))
    await rm(root, { recursive: true })
  })
  const reader = new ReceiptProgressReader(root)
  const monitor = new ProgressMonitor(0, minute)
  await mkdir(join(root, 'step1'))
  await writeFile(join(root, 'step1', 'result.json'), '{')
  assert.deepEqual(await reader.read(), [])
  await writeFile(
    join(root, 'step1', 'result.json'),
    JSON.stringify(proof({ actual: '中文记录', capturedAt: '2026-11-04T00:00:00Z' })),
  )
  assert.equal(monitor.update(0, await reader.read()).new_evidence, 1)
  await mkdir(join(root, 'step2'))
  await writeFile(
    join(root, 'step2', 'result.json'),
    JSON.stringify(proof({ actual: '中文记录', capturedAt: '2026-11-04T01:00:00Z' })),
  )
  assert.equal(monitor.update(2 * minute, await reader.read()).state, 'stalled')
  assert.equal(monitor.update(2 * minute, await reader.read()).new_evidence, 0)
  assert.deepEqual(await new ReceiptProgressReader(join(root, 'missing')).read(), [])
})
