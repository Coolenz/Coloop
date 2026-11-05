import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const run = promisify(execFile)
const directories: string[] = []
const script = resolve('scripts/audit-model-usage.mjs')
const task = 'private-task-name'
const day = '2026-11-05'
const limits = {
  usageBudgetEnabled: true,
  maxRequestsPerTask: 6,
  maxRequestsPerDay: 12,
  maxTokenUnitsPerTask: 150000,
  maxTokenUnitsPerDay: 300000,
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'coloop-usage-audit-'))
  directories.push(directory)
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({
      settings: { modelLimits: limits },
      encryptedKey: 'must-never-print-key',
      tasks: [{ prompt: 'must-never-print-user-text' }],
    }),
  )
  return directory
}
async function audit(directory: string) {
  try {
    const result = await run(process.execPath, [script, directory])
    return { code: 0, raw: result.stdout, report: JSON.parse(result.stdout) }
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string }
    expect(result.stderr).toBe('')
    return { code: result.code, raw: result.stdout, report: JSON.parse(result.stdout) }
  }
}
async function ledger(directory: string, requests: number, tokenUnits: number) {
  const value = { requests, tokenUnits }
  await writeFile(
    join(directory, 'model-usage-state.json'),
    JSON.stringify({ version: 1, days: { [day]: value }, tasks: { [task]: { ...value, day } } }),
  )
}
const request = (id: string, units = 1000) => ({
  type: 'request',
  id,
  taskId: task,
  day,
  reservedTokenUnits: units,
  provider: 'https://private-provider.invalid',
  model: 'private-model',
})
const response = (id: string, units = 75) => ({
  type: 'response',
  id,
  taskId: task,
  chargedTokenUnits: units,
  usageSource: 'provider',
  providerRequestId: 'private-server-request-id',
  provider: 'https://private-provider.invalid',
  prompt: 'untrusted-log-extra-never-print',
})
async function log(directory: string, events: unknown[], suffix = '') {
  await writeFile(
    join(directory, 'model-usage.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n' + suffix,
  )
}

it('accepts durable provider cooldown metadata without inventing another request', async () => {
  const directory = await fixture()
  await ledger(directory, 1, 75)
  await log(directory, [
    request('one'),
    response('one'),
    { type: 'cooldown', status: 429, at: 1000, until: 31000 },
  ])
  const result = await audit(directory)
  expect(result.code).toBe(0)
  expect(result.report.status).toBe('within_limits')
})

it('reconciles settled and reserved requests without exposing secrets or writing the profile', async () => {
  const directory = await fixture()
  await ledger(directory, 3, 2275)
  await log(directory, [
    request('one'),
    response('one'),
    request('two', 1200),
    {
      ...response('two', 1200),
      providerRequestId: undefined,
      usageSource: 'conservative_reservation',
      aborted: true,
    },
    request('pending'),
  ])
  const names = await readdir(directory)
  const before = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))
  const { code, raw, report } = await audit(directory)
  expect(code).toBe(0)
  expect(report.status).toBe('within_limits')
  expect(report.consistency).toEqual({ status: 'checked', mismatchedDays: 0, mismatchedTasks: 0 })
  expect(report.log.summary).toMatchObject({
    uniqueRequests: 3,
    uniqueResponses: 2,
    unsettledRequests: 1,
    unsettledReservedTokenUnits: 1000,
    conservativeResponses: 1,
    conservativeResponseTokenUnits: 1200,
    providerUsageResponses: 1,
    abortedResponses: 1,
  })
  expect(report.ledger.tasks[0]).toMatchObject({ requests: 3, tokenUnits: 2275 })
  for (const secret of [
    task,
    'private-provider',
    'private-model',
    'private-server-request-id',
    'must-never-print-key',
    'must-never-print-user-text',
    'untrusted-log-extra-never-print',
    directory,
  ])
    expect(raw).not.toContain(secret)
  expect(await readdir(directory)).toEqual(names)
  expect(await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).toEqual(
    before,
  )
})

it('reports missing ledger and log as unknown rather than claiming zero cloud calls', async () => {
  const { code, report } = await audit(await fixture())
  expect(code).toBe(2)
  expect(report.status).toBe('inconclusive')
  expect(report.ledger).toEqual({ status: 'missing', days: null, tasks: null })
  expect(report.log).toEqual({ status: 'missing', summary: null })
  expect(report.consistency.status).toBe('unknown')
})

it('recognizes explicitly empty complete evidence but flags disabled default budgets', async () => {
  const directory = await fixture()
  await writeFile(join(directory, 'state.json'), '{"settings":{}}')
  await writeFile(join(directory, 'model-usage-state.json'), '{"version":1,"days":{},"tasks":{}}')
  await writeFile(join(directory, 'model-usage.jsonl'), '')
  const { code, report } = await audit(directory)
  expect(code).toBe(1)
  expect(report.configuration.origin).toBe('defaults')
  expect(report.configuration.effectiveLimits.usageBudgetEnabled).toBe(false)
  expect(report.violations).toEqual(['CUMULATIVE_BUDGET_DISABLED'])
  expect(report.log.summary.uniqueRequests).toBe(0)
})

it('flags request and token caps exceeded even when the accounting agrees', async () => {
  const directory = await fixture()
  await ledger(directory, 13, 325000)
  await log(
    directory,
    Array.from({ length: 13 }, (_, i) => request('r-' + i, 25000)),
  )
  const { code, report } = await audit(directory)
  expect(code).toBe(1)
  expect(report.consistency.mismatchedDays).toBe(0)
  expect(report.violations).toEqual(['REQUEST_CAP_EXCEEDED', 'TOKEN_UNIT_CAP_EXCEEDED'])
  expect(report.ledger.days[0].requestsCap).toMatchObject({
    maximum: 12,
    enforced: true,
    exceeded: true,
    remaining: 0,
  })
})

it('keeps partial or truncated JSONL evidence inconclusive', async () => {
  const directory = await fixture()
  await ledger(directory, 1, 1000)
  await log(directory, [request('one')], '{"type":"response","secret":"never-echo-truncated')
  const { code, raw, report } = await audit(directory)
  expect(code).toBe(2)
  expect(report.log.status).toBe('partial')
  expect(report.log.summary).toMatchObject({ uniqueRequests: 1, invalidLines: 1 })
  expect(report.consistency.status).toBe('unknown')
  expect(raw).not.toContain('never-echo-truncated')
})

it('detects accounting mismatch, duplicate request IDs, and provider ID reuse without exposing IDs', async () => {
  const directory = await fixture()
  await ledger(directory, 1, 75)
  await log(directory, [
    request('one'),
    request('one'),
    response('one'),
    request('two'),
    response('two'),
  ])
  const { code, raw, report } = await audit(directory)
  expect(code).toBe(2)
  expect(report.consistency).toMatchObject({ mismatchedDays: 1, mismatchedTasks: 1 })
  expect(report.log.summary.duplicateRequestIds).toBe(1)
  expect(report.log.summary.providerRequestIdReuse).toEqual([
    { groupHash: expect.stringMatching(/^[a-f0-9]{64}$/), responseCount: 2 },
  ])
  expect(raw).not.toContain('private-server-request-id')
  expect(report.warnings).toContain('LEDGER_LOG_MISMATCH')
})

it('does not apply defaults to invalid settings or accept corrupt counters', async () => {
  const directory = await fixture()
  await writeFile(
    join(directory, 'state.json'),
    '{"settings":{"modelLimits":{"usageBudgetEnabled":"true"}}}',
  )
  await writeFile(
    join(directory, 'model-usage-state.json'),
    JSON.stringify({ version: 1, days: { [day]: { requests: -1, tokenUnits: 0 } }, tasks: {} }),
  )
  const { code, report } = await audit(directory)
  expect(code).toBe(2)
  expect(report.configuration).toEqual({ status: 'invalid', effectiveLimits: null })
  expect(report.ledger.status).toBe('invalid')
})
