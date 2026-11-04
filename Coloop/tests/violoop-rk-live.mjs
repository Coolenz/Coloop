// Explicit hardware acceptance: real Android, public encrypted gateway, RK model and USB HID.
// All business data belongs to a newly created isolated WinForms window.
import { _electron as electron } from '@playwright/test'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

if (!process.env.COLOOP_TEST_BOARD_PASSWORD) throw new Error('RK_TEST_CONNECTION_REQUIRED')
const root = resolve(import.meta.dirname, '..')
const output = resolve(
  process.env.COLOOP_RK_LIVE_OUTPUT ?? join(root, '.qa', `violoop-rk-live-${Date.now()}`),
)
await mkdir(output, { recursive: true })
process.env.COLOOP_ANDROID_QA_DIR = output
const ui = await import('../scripts/android-phone-qa.mjs')
const exec = promisify(execFile)
const python = 'D:/RK/deployment/screen-ocr/.venv/Scripts/python.exe'
const adb = join(root, '.cache/android-toolchain/sdk/platform-tools/adb.exe')
const serial = process.env.COLOOP_ANDROID_SERIAL ?? 'emulator-5554'
const checks = [],
  trace = []
const report = {
  output,
  scope:
    'Actual Android Emulator -> public HTTPS/AES-GCM -> production Violoop service -> real RK Qwen -> real USB HID -> independent WinForms result. No real email or user files.',
  checks,
  trace,
}
let app,
  page,
  lab,
  failure,
  lastTrace = '',
  phonePaired = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2))
const check = (text) => {
  checks.push(text)
  console.log(text)
}
function phone(args) {
  return execFileSync(adb, ['-s', serial, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
  })
}
async function call(method, value) {
  const result = await page.evaluate(async ({ method, value }) => window.coloop[method](value), {
    method,
    value,
  })
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function snapshot() {
  const value = await call('snapshot')
  const row = {
    at: new Date().toISOString(),
    task: value.violoop?.tasks?.[0],
    desktop: value.desktop,
  }
  const key = JSON.stringify({ task: row.task, desktop: row.desktop })
  if (key !== lastTrace) {
    trace.push(row)
    lastTrace = key
    await save('progress.json', trace)
  }
  return value
}
async function until(read, accept, label, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await sleep(250)
  }
  throw new Error(`Timed out: ${label}`)
}
async function focusLab() {
  await exec(
    python,
    [
      '-c',
      `from pywinauto import Application; Application(backend='uia').connect(process=${lab.pid}).top_window().set_focus()`,
    ],
    { windowsHide: true },
  )
}
async function captureLab(name) {
  await exec(
    python,
    [
      '-c',
      `from pywinauto import Application; Application(backend='uia').connect(process=${lab.pid}).top_window().capture_as_image().save(${JSON.stringify(join(output, name))})`,
    ],
    { windowsHide: true },
  )
}
async function send(text) {
  ui.inputAscii(text, true)
  phone(['shell', 'input', 'keyevent', '4'])
  await focusLab()
  await ui.tapText('发送消息')
}
async function launch() {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE || undefined,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      COLOOP_DATA_DIR: process.env.COLOOP_RK_LIVE_PROFILE ?? join(output, 'profile'),
      COLOOP_AUTOCONNECT_PASSWORD: '',
      ELECTRON_RENDERER_URL: '',
      COLOOP_TEST_NO_HOOKS: '1',
    },
  })
  page = await app.firstWindow()
}
try {
  const sourceNames = [
    'src/main/services/violoop.ts',
    'src/main/services/desktop-tasks.ts',
    'src/main/services/desktop-planner.ts',
    'src/main/services/cooperative.ts',
    'src/main/index.ts',
    'resources/desktop-runtime.py',
    'resources/desktop-observer.py',
    'tests/violoop-rk-live.mjs',
  ]
  report.sources = Object.fromEntries(
    await Promise.all(
      sourceNames.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]),
    ),
  )
  report.executable = process.env.COLOOP_EXECUTABLE ?? 'development build'
  await launch()
  await call('importRk')
  const connected = await call('connect', process.env.COLOOP_TEST_BOARD_PASSWORD)
  if (!connected.qwenReady) await call('startRkService')
  // A reused isolated QA profile retains its previous explicit Stop latch.
  await call('resumeSessionControl')
  const state = await snapshot()
  assert.equal(state.device.qwenReady, true)
  assert.equal(state.device.modelPrivacyReady, true)
  assert.equal(state.violoop.available, true, state.violoop.unavailableReason)
  report.device = {
    model: state.device.model,
    modelContext: state.device.modelContext,
    modelRuntime: state.device.modelRuntime,
    chip: state.device.chip,
    temperatureC: state.device.temperatureC,
    memoryAvailableMb: state.device.memoryAvailableMb,
    privacyReady: true,
  }
  check('Real pinned RK connection and privacy-protected model ready in the production companion')
  const encrypted = await readFile(
    join(process.env.COLOOP_RK_LIVE_PROFILE ?? join(output, 'profile'), 'auto-connection.json'),
    'utf8',
  )
  assert.equal(encrypted.includes(process.env.COLOOP_TEST_BOARD_PASSWORD), false)
  assert.ok(JSON.parse(encrypted).encryptedPassword)
  await app.close()
  await launch()
  const restored = await until(
    snapshot,
    (v) => v.violoop.available,
    'automatic connection after restart',
    120000,
  )
  assert.equal(restored.autoConnection.phase, 'ready')
  assert.equal(restored.autoConnection.hasCredential, true)
  check(
    'Packaged companion restarts and reconnects to the real pinned RK using only its Windows encrypted credential',
  )
  const interrupted = await app.evaluate(
    (_, c) => {
      const sockets = process
        ._getActiveHandles()
        .filter((s) => s.remoteAddress === c.host && s.remotePort === c.ssh_port)
      sockets.forEach((s) => s.destroy())
      return sockets.length
    },
    JSON.parse(await readFile('D:/RK/config/board.json', 'utf8')),
  )
  assert.ok(interrupted > 0)
  await until(snapshot, (v) => v.device.status !== 'connected', 'SSH loss is observed', 10000)
  await until(
    snapshot,
    (v) => v.violoop.available && v.device.status === 'connected',
    'automatic recovery from SSH loss',
    120000,
  )
  assert.equal((await snapshot()).violoop.tasks.length, 0)
  check(
    'An induced loss of this isolated companion SSH connection recovers automatically without admitting or replaying a task',
  )

  const title = `ColoopLive-${randomUUID().slice(0, 8)}`
  const code = String(randomInt(0, 100000000)).padStart(8, '0')
  const labDirectory = join(output, 'lab')
  await mkdir(labDirectory)
  const config = join(output, 'lab-config.json'),
    executable = join(output, 'DesktopLab.exe')
  await writeFile(config, JSON.stringify({ folder: labDirectory, title, code }))
  await exec(
    join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    [
      '/nologo',
      '/target:winexe',
      `/out:${executable}`,
      '/reference:System.Windows.Forms.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Web.Extensions.dll',
      resolve('D:/RK/rk-opencode/pc/AgentLab.cs'),
    ],
    { windowsHide: true },
  )
  lab = spawn(executable, [config], { stdio: 'ignore' })
  await until(
    async () =>
      readFile(join(labDirectory, 'fixture-state.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null),
    (v) => v?.pid === lab.pid,
    'isolated test window',
  )
  await captureLab('lab-initial.png')

  if (process.env.COLOOP_SERVER_CONFIG) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, process.env.COLOOP_SERVER_CONFIG)
    await call('importMobileServer')
  }
  const enabled = await call('enableMobile')
  assert.equal(enabled.tunnel.status, 'online')
  const invitation = await call('createMobilePairing')
  await writeFile(join(output, 'pairing.txt'), invitation.uri, { mode: 0o600 })
  report.transport = { endpoint: invitation.endpoint, encryption: 'AES-256-GCM', publicHttps: true }
  ui.setDisplay({ fontScale: 1, night: 'no' })
  phone(['shell', 'am', 'force-stop', 'ai.coloop.mobile'])
  ui.openPairing(join(output, 'pairing.txt'))
  await ui.tapText('连接电脑')
  await ui.waitForText('电脑与 RK 已就绪', 60000)
  phonePaired = true
  ui.screenshot('phone-ready.png')
  check('Actual Android client pairs over public HTTPS and opens the real Violoop task entry')
  await send('Hello Coloop')
  const greeting = await until(
    snapshot,
    (v) => v.violoop.tasks.find((t) => t.text === 'Hello Coloop' && t.state === 'answered'),
    'real RK chat reply',
    120000,
  )
  assert.equal(greeting.desktop.active, false)
  assert.equal(greeting.desktop.metrics?.actions ?? 0, 0)
  check('Actual Android greeting receives a real RK Coloop reply with zero HID actions')

  const goal = `In ${title} read the digits after Code from the window. Fill Input with those digits and click Apply once. Completion text: Applied:`
  assert.equal(
    goal.includes(code),
    false,
    'Random screen answer must not appear in the user prompt',
  )
  const began = performance.now()
  await send(goal)
  await until(snapshot, (v) => v.violoop.tasks.some((t) => t.text === goal), 'phone task admission')
  check('Phone message reaches real RK task interpretation without embedding the random answer')
  const complete = await until(
    snapshot,
    (v) => {
      const t = v.violoop.tasks.find((t) => t.text === goal)
      return t && !['received', 'understanding', 'running'].includes(t.state)
    },
    'real automatic task completion',
    360000,
  )
  const task = complete.violoop.tasks.find((t) => t.text === goal)
  report.task = task
  report.desktop = complete.desktop
  report.elapsedMs = Math.round(performance.now() - began)
  assert.equal(task.state, 'completed', JSON.stringify(task))
  assert.equal(complete.desktop.phase, 'completed')
  assert.equal(
    task.planningSource,
    'local',
    'This verified small task must stay on the actual RK local route',
  )
  const result = JSON.parse(await readFile(join(labDirectory, 'lab-result.json'), 'utf8'))
  report.businessResult = result
  assert.equal(result.value, code)
  assert.equal(result.code_matches, true)
  assert.equal(result.clicks, 1)
  assert.equal(complete.desktop.metrics.actions, 2)
  assert.equal(complete.desktop.metrics.planningCalls, 1)
  assert.equal(complete.desktop.metrics.fullObservations, 2)
  await captureLab('lab-completed.png')
  await ui.waitForText('结果已验证', 60000)
  ui.screenshot('phone-completed.png')
  check(
    'Real RK chooses local planning, reads the random code, types and clicks over USB; independent value and one click verified',
  )
  check(
    'Verified result returns to Android; same-page execution remains one action batch and two complete observations',
  )

  const second = goal + ' This is a new stop test.'
  await send(second)
  await until(
    snapshot,
    (v) => v.violoop.tasks[0]?.text === second && v.violoop.tasks[0].state === 'understanding',
    'second task understanding',
  )
  await ui.tapText('停止任务')
  const stopped = await until(
    snapshot,
    (v) => v.violoop.tasks[0]?.text === second && v.violoop.tasks[0].state === 'cancelled',
    'RK interpretation cancellation',
  )
  assert.equal(stopped.violoop.active, false)
  await sleep(2500)
  assert.equal(JSON.parse(await readFile(join(labDirectory, 'lab-result.json'), 'utf8')).clicks, 1)
  report.stop = stopped.violoop.tasks[0]
  ui.screenshot('phone-stop-confirmed.png')
  check('Phone Stop cancels a real pending RK interpretation and no second HID submission occurs')
  report.passed = true
} catch (error) {
  failure = error
  report.passed = false
  report.error = String(error)
  console.error(String(error))
  if (page)
    await snapshot()
      .then((v) => {
        report.failureTask = v.violoop
        report.failureDesktop = v.desktop
      })
      .catch(() => {})
  if (lab) await captureLab('lab-failure.png').catch(() => {})
  if (phonePaired) {
    try {
      ui.screenshot('phone-failure.png')
    } catch {}
  }
} finally {
  if (page) await call('stopSessionControl').catch(() => {})
  if (page) await call('disableMobile').catch(() => {})
  if (lab) lab.kill()
  await app?.close().catch(() => {})
  try {
    ui.restoreDisplaySettings()
  } catch {}
  await save('verification.json', report)
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, output }))
}
if (failure) process.exitCode = 1
