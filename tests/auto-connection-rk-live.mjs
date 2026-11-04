// Real RK SSH recovery; no model inference or HID request is submitted by this test.
import { _electron as electron } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const output = resolve('.qa', `auto-connection-rk-${Date.now()}`)
await mkdir(output, { recursive: true })
const executable = resolve('release/coloop-connected-0.13.0/win-unpacked/Coloop.exe')
const profile = join(output, 'profile')
const identity = JSON.parse(await readFile('D:/RK/config/board.json', 'utf8'))
const report = {
  scope:
    'Real pinned RK SSH, Windows protected credential, restart and induced connection loss; no task, inference or HID is submitted',
  checks: [],
}
let app, page
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const call = async (m, v) => {
  const r = await page.evaluate(async ({ m, v }) => window.coloop[m](v), { m, v })
  if (!r.ok) throw Error(r.error)
  return r.value
}
const state = () => call('snapshot')
const until = async (f, label) => {
  const end = Date.now() + 60000
  while (Date.now() < end) {
    const s = await state()
    if (f(s)) return s
    await sleep(100)
  }
  throw Error(label)
}
async function launch() {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLOOP_TEST_BOARD_PASSWORD: '',
      RK_BOARD_PASSWORD: '',
      COLOOP_DATA_DIR: profile,
      COLOOP_AUTOCONNECT_PASSWORD: '',
      ELECTRON_RENDERER_URL: '',
    },
  })
  page = await app.firstWindow()
}
try {
  await launch()
  await call('importRk')
  try {
    await call('connect', process.env.COLOOP_TEST_BOARD_PASSWORD)
  } catch {}
  let s = await until(
    (s) => s.device.status === 'connected' && s.autoConnection.hasCredential,
    'Initial SSH and credential',
  )
  const raw = await readFile(join(profile, 'auto-connection.json'), 'utf8')
  assert.equal(raw.includes(process.env.COLOOP_TEST_BOARD_PASSWORD), false)
  report.checks.push(
    'Real RK identity verified and credential protected by Windows, with no password in saved JSON',
  )
  await app.close()
  await launch()
  s = await until((s) => s.device.status === 'connected', 'Automatic restart SSH')
  report.checks.push('Restart reconnects without supplying a password to the new process')
  const closed = await app.evaluate((_, c) => {
    const sockets = process
      ._getActiveHandles()
      .filter((s) => s.remoteAddress === c.host && s.remotePort === c.ssh_port)
    sockets.forEach((s) => s.destroy())
    return sockets.length
  }, identity)
  assert.ok(closed > 0)
  await until((s) => s.device.status !== 'connected', 'Connection loss observation')
  s = await until((s) => s.device.status === 'connected', 'Recovery')
  assert.equal(s.violoop.tasks.length, 0)
  report.checks.push(
    'Induced loss of isolated SSH sockets is observed and recovers automatically with no task replay',
  )
  report.modelReady = !!s.device.qwenReady
  report.passed = true
} catch (e) {
  report.passed = false
  report.error = e.message
  process.exitCode = 1
} finally {
  await app?.close()
  await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, ...report }))
}
