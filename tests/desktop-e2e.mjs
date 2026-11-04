import { _electron as electron } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID, randomInt, createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const directory = join(root, '.qa', `desktop-${Date.now()}`)
await mkdir(directory, { recursive: true })
const report = { directory, hardware: !!process.env.COLOOP_TEST_BOARD_PASSWORD, checks: [] }
report.sources = Object.fromEntries(
  await Promise.all(
    [
      'resources/desktop-runtime.py',
      'resources/desktop-observer.py',
      'out/main/index.js',
      'src/main/services/desktop-tasks.ts',
      'src/shared/desktop.ts',
      'src/renderer/src/DesktopPage.tsx',
    ].map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(join(root, name)))
        .digest('hex'),
    ]),
  ),
)
let app, page, lab
const errors = []
const check = (name) => {
  report.checks.push({ name, passed: true })
  console.log(name)
}
async function until(read, accept, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timeout: ${label}; last=${JSON.stringify(value)}`)
}
async function invoke(method, value) {
  const result = await page.evaluate(async ({ method, value }) => window.coloop[method](value), {
    method,
    value,
  })
  assert.equal(result.ok, true, result.error)
  return result.value
}
async function snapshot() {
  return invoke('snapshot')
}
async function focusLab() {
  await exec(
    'D:/RK/deployment/screen-ocr/.venv/Scripts/python.exe',
    [
      '-c',
      `from pywinauto import Application; Application(backend='uia').connect(process=${lab.pid}).top_window().set_focus()`,
    ],
    { windowsHide: true },
  )
}

try {
  app = await electron.launch({
    executablePath: process.env.COLOOP_EXECUTABLE || undefined,
    args: process.env.COLOOP_EXECUTABLE ? [] : [root],
    cwd: root,
    env: {
      ...process.env,
      COLOOP_DATA_DIR: join(directory, 'profile'),
      ELECTRON_RENDERER_URL: '',
      COLOOP_TEST_NO_HOOKS: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '电脑操作', exact: true }).click()
  await page.getByRole('heading', { name: '电脑操作', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '开始操作', exact: true }).isDisabled(), true)
  await page.screenshot({ path: join(directory, 'desktop-empty.png'), animations: 'disabled' })
  const mainWindow = await app.browserWindow(page)
  await mainWindow.evaluate((window) => window.setSize(1060, 720))
  await page.screenshot({ path: join(directory, 'desktop-compact.png'), animations: 'disabled' })
  assert.equal(
    await page.locator('.desktop-page').evaluate((el) => el.scrollWidth <= el.clientWidth),
    true,
  )
  check('new desktop page, disconnected state, minimum window without horizontal overflow')
  await page.getByRole('button', { name: '刷新窗口', exact: true }).click()
  await until(
    () => page.locator('#desktop-windows option').count(),
    (count) => count > 0,
    'window enumeration',
  )
  check('real Windows title enumeration over private subprocess')
  if (report.hardware) {
    await invoke('importRk')
    const device = await invoke('connect', process.env.COLOOP_TEST_BOARD_PASSWORD)
    if (!device.qwenReady) await invoke('startRkService')
    assert.equal((await snapshot()).device.modelPrivacyReady, true)
    check('real pinned USB SSH and authenticated local model ready')
    const labDir = join(directory, 'lab')
    await mkdir(labDir)
    const title = `Coloop HID Lab ${randomUUID().slice(0, 8)}`
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    const config = join(directory, 'lab-config.json')
    await writeFile(config, JSON.stringify({ folder: labDir, title, code }))
    const executable = join(directory, 'DesktopLab.exe')
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
      async () => {
        try {
          return JSON.parse(await readFile(join(labDir, 'fixture-state.json'), 'utf8'))
        } catch {
          return null
        }
      },
      (value) => value?.pid === lab.pid,
      'lab ready',
    )
    const request = {
      goal: 'Read Code from this window. Type its digits exactly into the initially focused Input, then click Apply. Do not close the window.',
      windowTitle: title,
      expectedText: 'Applied:',
      planner: 'rk',
      maxSteps: 8,
      authorizeInput: true,
    }
    const denied = await page.evaluate(
      (request) => window.coloop.startDesktopTask({ ...request, authorizeInput: false }),
      request,
    )
    assert.equal(denied.ok, false)
    check('input cannot start without explicit task authorization')
    await mainWindow.evaluate((window) => window.setSize(1440, 940))
    await page.locator('#desktop-window').fill(request.windowTitle)
    await page.locator('#desktop-goal').fill(request.goal)
    await page.locator('#desktop-result').fill(request.expectedText)
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '开始操作', exact: true }).click()
    await focusLab()
    const running = await until(
      snapshot,
      (value) => value.desktop.phase === 'planning' || !value.desktop.active,
      'real planning',
      60_000,
    )
    assert.equal(running.desktop.active, true, JSON.stringify(running.desktop))
    const concurrent = await page.evaluate(() =>
      window.coloop.runTask({ prompt: 'hello', target: 'rk', context: '', source: 'text' }),
    )
    assert.equal(concurrent.ok, false)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.isVisible() && w.webContents.getURL().includes('surface=control'),
        ),
      ),
      true,
    )
    await page.getByRole('heading', { name: '正在规划下一步', exact: true }).waitFor()
    await page.locator('.desktop-progress').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(directory, 'desktop-running.png'), animations: 'disabled' })
    // Capturing the app is test setup only; restore the authorized fixture's
    // foreground before any business input, without typing or clicking controls.
    await focusLab()
    check('real RK planning, visible independent control notice, competing task blocked')
    const completed = await until(
      snapshot,
      (value) => !value.desktop.active,
      'real task complete',
      300_000,
    )
    report.task = completed.desktop
    assert.equal(completed.desktop.phase, 'completed', JSON.stringify(completed.desktop))
    const result = JSON.parse(await readFile(join(labDir, 'lab-result.json'), 'utf8'))
    assert.equal(result.value, code)
    assert.equal(result.code_matches, true)
    assert.equal(result.clicks, 1)
    assert.equal(completed.desktop.steps, 1, 'same-page task must finish in one batch')
    assert.equal(
      completed.desktop.metrics.planningCalls,
      1,
      'one planning request, no intermediate inference',
    )
    assert.equal(completed.desktop.metrics.fullObservations, 2, 'one initial OCR and one final OCR')
    assert.equal(
      completed.desktop.metrics.actions,
      2,
      'fill and confirm in a single execution block',
    )
    report.businessResult = {
      codeMatches: true,
      clicks: result.clicks,
      steps: completed.desktop.steps,
      metrics: completed.desktop.metrics,
    }
    await page.getByRole('heading', { name: '已在屏幕确认预期结果', exact: true }).waitFor()
    await page.locator('.desktop-progress').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(directory, 'desktop-completed.png'),
      animations: 'disabled',
    })
    check(
      'real local model reads random screen code; real RK HID inputs and clicks; independent business result exact',
    )
    await page.locator('#desktop-goal').fill('Wait for a screen update. Do not type or click.')
    await page.locator('#desktop-result').fill(`NotPresent-${randomUUID()}`)
    await page.getByRole('button', { name: '开始操作', exact: true }).click()
    await focusLab()
    await until(
      snapshot,
      (value) => value.desktop.phase === 'planning' || !value.desktop.active,
      'second planning',
      60_000,
    )
    const overlay = app.windows().find((window) => window.url().includes('surface=control'))
    assert.ok(overlay)
    await overlay.getByRole('button', { name: 'Stop', exact: true }).click()
    const stopped = (await until(snapshot, (value) => !value.desktop.active, 'stop receipt'))
      .desktop
    assert.equal(stopped.phase, 'cancelled', JSON.stringify(stopped))
    assert.equal(stopped.active, false)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(JSON.parse(await readFile(join(labDir, 'lab-result.json'), 'utf8')).clicks, 1)
    await page.getByRole('heading', { name: '已停止操作', exact: true }).waitFor()
    await page.locator('.desktop-progress').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(directory, 'desktop-stopped.png'), animations: 'disabled' })
    check('stop during real pending planning acknowledged by RK; no further business input')
    const runtimeDirectory = join(directory, 'profile/desktop-runtime')
    const files = await readdir(runtimeDirectory, { recursive: true })
    assert.equal(
      files.some((name) => /\.(png|jsonl)$/i.test(name)),
      false,
    )
    check('desktop observer persisted no screenshots or raw observation logs')
    // The system Stop latches new admissions; only an explicit resume admits a new task.
    await invoke('resumeSessionControl')
    await page.locator('#desktop-window').fill(`Missing window ${randomUUID()}`)
    await page.getByRole('button', { name: '开始操作', exact: true }).click()
    const failed = await until(
      snapshot,
      (value) => !value.desktop.active,
      'missing-window refusal',
      60_000,
    )
    assert.equal(failed.desktop.phase, 'failed')
    assert.equal(failed.desktop.steps, 0)
    assert.match(failed.desktop.error, /刷新窗口列表/)
    await page.getByRole('heading', { name: '任务未完成，已停止操作', exact: true }).waitFor()
    await page.locator('.desktop-progress').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(directory, 'desktop-failed.png'), animations: 'disabled' })
    check('missing target refused before any business input')
    await page.getByRole('button', { name: /^使用指南/ }).click()
    await page.getByText('「电脑操作」已接入 RK HID', { exact: false }).waitFor()
    await page.screenshot({ path: join(directory, 'desktop-help.png'), animations: 'disabled' })
  }
  assert.deepEqual(errors, [])
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error)
  if (lab) {
    await exec(
      'D:/RK/deployment/screen-ocr/.venv/Scripts/python.exe',
      [
        '-c',
        `import json; from pywinauto import Application; w=Application(backend='uia').connect(process=${lab.pid}).top_window(); w.capture_as_image().save(${JSON.stringify(join(directory, 'lab-failure.png'))}); print(json.dumps([{'name':c.element_info.name,'type':c.element_info.control_type,'value':c.get_value() if c.element_info.control_type=='Edit' else ''} for c in w.descendants()],ensure_ascii=True))`,
      ],
      { windowsHide: true },
    )
      .then((value) => {
        report.labDiagnostics = value.stdout
      })
      .catch(() => {})
  }
  if (page)
    await page
      .screenshot({ path: join(directory, 'failure.png'), animations: 'disabled' })
      .catch(() => {})
  console.error(String(error))
  process.exitCode = 1
} finally {
  if (page) await page.evaluate(() => window.coloop.stopDesktopTask()).catch(() => {})
  if (lab) lab.kill()
  if (app) await app.close().catch(() => {})
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length }))
}
