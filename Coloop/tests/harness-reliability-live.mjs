// Actual packaged product + model + native fixture. Fixture state is audit-only.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const target = process.env.COLOOP_LIVE_TARGET ?? 'rk'
const backend = process.env.COLOOP_LIVE_MOUSE ?? 'rk'
const taskCase = process.env.COLOOP_LIVE_CASE ?? 'checkbox'
const buildName = process.env.COLOOP_LIVE_BUILD ?? 'installed'
const executable =
  process.env.COLOOP_EXECUTABLE ??
  (process.env.COLOOP_LIVE_BUILD
    ? join(root, 'release', buildName, 'win-unpacked/Coloop.exe')
    : join(process.env.LOCALAPPDATA, 'Programs/Coloop/Coloop.exe'))
assert.ok(['rk', 'cloud'].includes(target))
assert.ok(['rk', 'cua'].includes(backend))
assert.ok(
  ['checkbox', 'replace_undo_redo', 'blank_editor', 'partial_editor', 'scroll'].includes(taskCase),
)
if (target === 'cloud') assert.equal(process.env.COLOOP_ALLOW_LIVE_CLOUD, '1')
const output = join(root, '.qa', `harness-live-${target}-${backend}-${taskCase}-${Date.now()}`)
// Every later case in this batch shares the initial profile and persistent usage ledger.
const profile =
  process.env.COLOOP_LIVE_PROFILE ??
  join(root, '.qa', 'harness-live-rk-rk-checkbox-1793870978312', 'profile')
const workspace = join(output, 'workspace'),
  fixture = join(output, 'fixture')
await Promise.all([profile, workspace, fixture].map((p) => mkdir(p, { recursive: true })))
const original = JSON.parse(
  await readFile(join(process.env.APPDATA, 'coloop', 'state.json'), 'utf8'),
)
const previousProfile = await readFile(join(profile, 'state.json'), 'utf8')
  .then(JSON.parse)
  .catch(() => undefined)
const settings = {
  ...original.settings,
  agentEngine: 'harness',
  taskWorkspace: workspace,
  modelLimits: {
    ...original.settings.modelLimits,
    usageBudgetEnabled: true,
    costLimitEnabled: true,
    inputYuanPerMillion: 2,
    outputYuanPerMillion: 8,
    maxCostYuanPerTask: 1,
    maxCostYuanPerDay: 3,
    maxCostYuanTotal: 3,
    maxRequestsPerTask: 6,
    maxRequestsPerDay: 24,
    maxTokenUnitsPerTask: 150000,
    maxTokenUnitsPerDay: 300000,
    maxOutputTokens: 2048,
    minRequestIntervalMs: 5000,
  },
}
await writeFile(
  join(profile, 'state.json'),
  JSON.stringify({
    settings,
    tasks: previousProfile?.tasks ?? [],
    encryptedKey: '',
  }),
)
const password =
  process.env.COLOOP_RK_PASSWORD ??
  (await readFile('D:/RK/AGENTS.md', 'utf8')).match(/SSH \/ sudo 密码：`([^`]+)`/)[1]
const exe = join(output, 'ActionTaskLab.exe')
const preflightModule = join(output, 'foreground-preflight.cjs')
await build({
  entryPoints: [join(root, 'src/main/infrastructure/foreground-observation.ts')],
  outfile: preflightModule,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
await promisify(execFile)(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/target:winexe',
    '/out:' + exe,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    join(root, 'tests/ActionTaskLab.cs'),
  ],
  { windowsHide: true },
)
const env = {
  ...process.env,
  COLOOP_DATA_DIR: profile,
  COLOOP_AGENT_RUNTIME: 'harness',
  COLOOP_MOUSE_BACKEND: backend,
  COLOOP_CUA: backend === 'rk' ? 'off' : 'on',
}
delete env.ELECTRON_RUN_AS_NODE
let application, page, lab, taskId, balanceKey
const report = {
  passed: false,
  target,
  backend,
  taskCase,
  output,
  scope:
    'packaged production API; actual model and native fixture; no synthesized actions/observations',
}
const started = performance.now()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, seconds = 30) => {
  const deadline = performance.now() + seconds * 1000
  while (performance.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(200)
  }
  throw new Error('LIVE_VALIDATION_TIMEOUT')
}
try {
  let cloudKey
  if (target === 'cloud') {
    assert.equal(
      settings.provider.baseUrl.replace(/\/$/, ''),
      'https://api.deepseek.com',
      'PRICE_POLICY_ENDPOINT_MISMATCH',
    )
    assert.equal(settings.provider.model, 'deepseek-flash', 'PRICE_POLICY_MODEL_MISMATCH')
    // Chromium's safeStorage key is profile-scoped. Decode with the original
    // profile and re-encrypt through the target app API; plaintext stays in
    // this process/IPC only and is never written to files or test output.
    const readerPath = join(output, 'secret-reader.cjs')
    await writeFile(
      readerPath,
      `const {app}=require('electron');app.setPath('userData',process.env.COLOOP_SECRET_SOURCE_DIR);app.on('window-all-closed',()=>{});app.whenReady().then(()=>{});`,
    )
    const readerEnv = {
      ...process.env,
      COLOOP_SECRET_SOURCE_DIR: join(process.env.APPDATA, 'coloop'),
    }
    delete readerEnv.ELECTRON_RUN_AS_NODE
    const reader = await electron.launch({ args: [readerPath], env: readerEnv })
    try {
      cloudKey = await reader.evaluate(
        ({ safeStorage }, encrypted) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
        original.encryptedKey,
      )
      assert.ok(cloudKey.length > 0, 'CLOUD_KEY_UNAVAILABLE')
      balanceKey = cloudKey
      const balance = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + cloudKey },
        signal: AbortSignal.timeout(15000),
      })
      assert.ok(balance.ok, 'BALANCE_CHECK_FAILED')
      const value = await balance.json()
      const cny = value.balance_infos?.find((row) => row.currency === 'CNY')
      assert.ok(
        value.is_available && cny && Number(cny.total_balance) >= 1,
        'BALANCE_RESERVE_REQUIRED',
      )
      report.startBalanceYuan = Number(cny.total_balance)
    } finally {
      await reader.close()
    }
  }
  application = await electron.launch({
    executablePath: executable,
    env,
  })
  await application.firstWindow()
  page = await until(() =>
    application
      .windows()
      .find(
        (p) => p.url().includes('/renderer/index.html') && !p.url().includes('surface=control'),
      ),
  )
  await page.waitForFunction(() => !!window.coloop)
  assert.equal((await page.evaluate(() => window.coloop.pauseProactiveObservation(true))).ok, true)
  if (cloudKey) {
    const saved = await page.evaluate((value) => window.coloop.saveSettings(value), {
      ...settings,
      provider: { ...settings.provider, apiKey: cloudKey },
    })
    cloudKey = undefined
    assert.equal(saved.ok, true, 'CLOUD_KEY_STORAGE_FAILED')
    assert.equal(saved.value.provider.hasKey, true)
  }
  // Reusing the budget profile also preserves auto-connection credentials.
  // Let that existing connection settle before starting a manual connection.
  const boot = await until(async () => {
    const reply = await page.evaluate(() => window.coloop.snapshot())
    if (!reply.ok) return undefined
    const state = reply.value
    if (state.device.status === 'connected')
      return state.device.qwenReady === true ? state : undefined
    return state.device.status !== 'connecting' && !state.autoConnection?.hasCredential
      ? state
      : undefined
  }, 90)
  const connection =
    boot.device.status === 'connected'
      ? { ok: true, value: boot.device }
      : await page.evaluate((value) => window.coloop.connect(value), password)
  assert.equal(connection.ok, true, connection.error)
  assert.equal(connection.value.qwenReady, true)
  report.device = connection.value
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.webContents.getURL().includes('surface=control')) window.hide()
  })
  lab = spawn(exe, [fixture, taskCase, 'Coloop Harness Validation ' + taskCase], {
    stdio: 'ignore',
    windowsHide: false,
  })
  const identity = await until(async () => {
    try {
      return JSON.parse(await readFile(join(fixture, 'identity.json'), 'utf8'))
    } catch {}
  })
  assert.equal(identity.pid, lab.pid)
  report.fixture = identity
  await delay(600)
  report.fixtureForeground = await application.evaluate(
    async (_app, { modulePath, identity }) => {
      const { WindowsObservationCapture } = process
        .getBuiltinModule('module')
        .createRequire(modulePath)(modulePath)
      const capture = new WindowsObservationCapture({
        recognize: async () => {
          throw new Error('PREFLIGHT_OCR_UNUSED')
        },
      })
      try {
        await capture.focusTaskWindow(identity.window_id, identity.pid)
        const current = await capture.metadata()
        return { window_id: current.window_id, process_id: current.process_id }
      } finally {
        capture.dispose()
      }
    },
    { modulePath: preflightModule, identity },
  )
  assert.equal(report.fixtureForeground.window_id, identity.window_id)
  assert.equal(report.fixtureForeground.process_id, identity.pid)
  const goals = {
    checkbox:
      '请只操作当前前台测试窗口，把 Enable feature 复选框设为勾选状态，再观察核验其确实已勾选。不要修改其他窗口，不需要保存记忆。',
    replace_undo_redo:
      '当前前台测试窗口的 Revision editor 已全选原文。请将选中的原文替换为“RK Harness 中文输入验证 20261105”，然后回读核验完整文字。不要修改其他窗口，不需要保存记忆。',
    blank_editor:
      '请在当前前台测试窗口的空白 Revision editor 中输入“RK Harness 中文输入验证 20261105”，然后回读核验完整文字。不要修改其他窗口，不需要保存记忆。',
    partial_editor:
      '请将当前前台测试窗口 Revision editor 中的“状态：待处理”改为“状态：已完成”，项目和备注行必须完整保留，最后回读核验整个正文。不要修改其他窗口，不需要保存记忆。',
    scroll:
      '请在当前前台测试窗口的 Scroll list 文本区实际向下滚动一屏，然后重新观察确认可见内容已向下移动。不要修改内容或其他窗口，不需要保存记忆。',
  }
  const dispatched = await page.evaluate((request) => window.coloop.dispatchTask(request), {
    prompt: `目标窗口标题为“Coloop Harness Validation ${taskCase}”，是本地 Windows 测试工具。${goals[taskCase]}`,
    target,
    context: '',
    source: 'text',
    intent: 'execute',
    workspace,
  })
  assert.equal(dispatched.ok, true, dispatched.error)
  taskId = dispatched.value.id
  report.taskId = taskId
  console.log(JSON.stringify({ output, taskId, phase: 'dispatched' }))
  let previous
  const final = await until(async () => {
    const reply = await page.evaluate(() => window.coloop.snapshot())
    assert.equal(reply.ok, true)
    const state = reply.value
    const task = state.tasks.find((item) => item.id === taskId)
    const phase = state.proactive?.phase
    if (phase !== previous) {
      console.log(JSON.stringify({ taskId, phase, status: task?.status }))
      previous = phase
    }
    await writeFile(
      join(output, 'progress.json'),
      JSON.stringify({ task, proactive: state.proactive, modelUsage: state.modelUsage }, null, 2),
    )
    if (state.proactive?.question) throw new Error('UNEXPECTED_USER_QUESTION')
    return task && task.status !== 'running' && !state.proactive.active ? state : undefined
  }, 600)
  const task = final.tasks.find((item) => item.id === taskId)
  const actual = JSON.parse(await readFile(join(fixture, 'state.json'), 'utf8'))
  report.task = task
  report.proactive = final.proactive
  report.actual = actual
  report.modelUsage = final.modelUsage
  assert.equal(final.proactive.runtime, 'harness')
  assert.equal(task.status, 'completed', task.error)
  if (taskCase === 'checkbox') {
    assert.equal(actual.checked, true)
    assert.equal(actual.click_count, 1)
  }
  if (taskCase === 'replace_undo_redo' || taskCase === 'blank_editor')
    assert.equal(actual.fields.revision, 'RK Harness 中文输入验证 20261105')
  if (taskCase === 'partial_editor')
    assert.equal(actual.fields.revision, '项目：Coloop\n状态：已完成\n备注：保留这一行 😀')
  if (taskCase === 'scroll') assert.ok(actual.events.some((item) => item.type === 'native_scroll'))
  report.passed = true
} catch (error) {
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  if (page) await page.evaluate(() => window.coloop.stopProactiveTask()).catch(() => {})
  if (balanceKey) {
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + balanceKey },
        signal: AbortSignal.timeout(15000),
      })
      if (response.ok) {
        const value = await response.json()
        const cny = value.balance_infos?.find((row) => row.currency === 'CNY')
        if (cny) report.endBalanceYuan = Number(cny.total_balance)
      }
    } catch {
      report.balanceCheck = 'unavailable'
    }
    balanceKey = undefined
  }
  report.build = buildName
  report.mainBundleSha256 = createHash('sha256')
    .update(await readFile(join(executable, '../resources/app/out/main/index.js')))
    .digest('hex')
  report.seconds = (performance.now() - started) / 1000
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await application?.close().catch(() => {})
  lab?.kill()
  console.log(
    JSON.stringify({ passed: report.passed, output, error: report.error, seconds: report.seconds }),
  )
}
