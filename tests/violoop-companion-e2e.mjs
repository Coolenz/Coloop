import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', `violoop-companion-${Date.now()}`)
await mkdir(output, { recursive: true })
const checks = []
let app, failure
try {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: { ...process.env, COLOOP_DATA_DIR: join(output, 'profile'), ELECTRON_RENDERER_URL: '' },
  })
  const page = await app.firstWindow()
  const call = async (method, value) =>
    page.evaluate(async ({ method, value }) => window.coloop[method](value), { method, value })
  let snapshot = await call('snapshot')
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.value.violoop.available, false)
  assert.match(snapshot.value.violoop.unavailableReason, /RK/)
  assert.deepEqual(snapshot.value.violoop.tasks, [])
  checks.push(
    'Packaged main process constructs the real Violoop service with an accurate RK-unavailable state',
  )
  assert.equal((await call('protectCredentials', true)).ok, true)
  snapshot = await call('snapshot')
  assert.equal(snapshot.value.violoop.available, false)
  assert.match(snapshot.value.violoop.unavailableReason, /私密/)
  assert.equal((await call('protectCredentials', false)).ok, true)
  checks.push('Credential protection also gates the new phone task admission service')
  const blocked = await call('startDesktopTask', {
    goal: 'Synthetic QA task',
    windowTitle: 'Not a user app',
    expectedText: 'done',
    planner: 'auto',
    authorizeInput: true,
  })
  assert.equal(blocked.ok, false)
  assert.equal((await call('snapshot')).value.desktop.active, false)
  checks.push('Auto desktop mode cannot execute while the actual RK channel is disconnected')
  const windows = await call('listDesktopWindows')
  assert.equal(windows.ok, true)
  assert.ok(Array.isArray(windows.value))
  checks.push('Packaged Windows observer enumerates actual window titles without sending input')
} catch (error) {
  failure = error
} finally {
  await app?.close().catch(() => {})
  await writeFile(
    join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: !failure,
        checks,
        error: failure?.message,
        scope: 'Real packaged Electron main/observer. Disconnected RK, no model or HID invoked.',
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ passed: !failure, checks: checks.length, output, error: failure?.message }),
  )
}
if (failure) throw failure
