// Packaged app smoke with isolated settings: no cloud, RK connection or HID.
import { _electron as electron, expect } from '@playwright/test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', 'proactive-package-' + Date.now())
await mkdir(output, { recursive: true })
const temporaryRoot = resolve(root, '.cache', 'tmp', 'proactive-package-smoke')
await mkdir(temporaryRoot, { recursive: true })
const profile = await mkdtemp(join(temporaryRoot, 'run-'))
const env = { ...workspaceCacheEnvironment(root), COLOOP_DATA_DIR: profile }
const hookProject = join(profile, 'hook-project')
const report = {
  ok: false,
  scope: 'packaged isolated profile; no RK/cloud/HID',
  autoAgentWork: { scope: 'protocol_smoke', desktopVerified: false, checks: [] },
  cleanup: { profileRemoved: false },
}
const recoveryId = randomUUID()
const checkpointDirectory = resolve(env.COLOOP_DATA_DIR, 'execution-checkpoints')
await mkdir(checkpointDirectory, { recursive: true })
await writeFile(
  resolve(checkpointDirectory, recoveryId + '.json'),
  JSON.stringify({
    taskId: recoveryId,
    goal: '合成恢复记录：核对产物后继续',
    preference: 'rk',
    approvedFields: [],
    supplements: [],
    commands: [],
    artifacts: [],
    phase: 'cancelled',
    runtime: 'harness',
    updatedAt: Date.now(),
  }),
)
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({
    ...(process.env.COLOOP_TEST_SOURCE === '1' ? { args: [root] } : {}),
    executablePath:
      process.env.COLOOP_EXECUTABLE ||
      (process.env.COLOOP_PROACTIVE_BUILD
        ? resolve(root, 'release', process.env.COLOOP_PROACTIVE_BUILD, 'win-unpacked/Coloop.exe')
        : resolve(process.env.LOCALAPPDATA, 'Programs/Coloop/Coloop.exe')),
    env,
  })
  await app.firstWindow()
  let main
  for (let n = 0; n < 100 && !main; n++) {
    main = app
      .windows()
      .find((page) => page.url().includes('index.html') && !page.url().includes('surface=control'))
    if (!main) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(main, 'packaged main window must load')
  await main.waitForLoadState('domcontentloaded')
  await main.waitForFunction(() => !!window.coloop)
  await main.getByRole('navigation', { name: '主导航' }).waitFor()
  assert.equal(
    await main.getByRole('navigation', { name: '主导航' }).getByRole('button').count(),
    4,
  )
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => !w.webContents.getURL().includes('surface=control'))
          ?.isVisible(),
      ),
    )
    .toBe(true)
  report.windowStartup = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (item) => !item.webContents.getURL().includes('surface=control'),
    )
    return {
      visible: window?.isVisible(),
      backgroundThrottling: window?.webContents.backgroundThrottling,
    }
  })
  assert.equal(report.windowStartup.visible, true)
  assert.equal(report.windowStartup.backgroundThrottling, false)
  await main.screenshot({ path: resolve(output, 'startup-before-interaction.png') })
  const permissionTrigger = main.getByRole('button', { name: /^权限设置，/ })
  await permissionTrigger.click()
  await expect(main.getByRole('group', { name: '任务权限设置' })).toBeVisible()
  await main.screenshot({ path: resolve(output, 'task-permissions.png') })
  await main.getByRole('button', { name: '请求批准 访问文件、网络或操作电脑前逐次询问' }).click()
  await expect(permissionTrigger).toContainText('请求批准')
  await permissionTrigger.click()
  await main.keyboard.press('Escape')
  await expect(main.getByRole('group', { name: '任务权限设置' })).toBeHidden()
  await expect(permissionTrigger).toBeFocused()
  await permissionTrigger.click()
  await main
    .getByRole('button', { name: '帮我批准 自动允许只读工具，写入和执行操作请求批准' })
    .click()
  report.taskPermissions = { choices: 3, selection: true, escape: true }

  await main.waitForFunction(
    async () => (await window.coloop.snapshot()).value.proactive.recoverable?.length === 1,
  )
  const state = await main.evaluate(async () => window.coloop.snapshot())
  assert.equal(state.ok, true)
  assert.equal(state.value.proactive.active, false)
  assert.equal(state.value.proactive.connected, false)
  assert.equal(state.value.proactive.runtime, 'harness')
  assert.equal(state.value.proactive.recoverable[0].taskId, recoveryId)
  assert.equal(await main.evaluate(() => typeof window.coloop.resumeProactiveTask), 'function')
  assert.ok(state.value.autoAgentWork, 'packaged Auto Agent Work service must be initialized')
  const scheduled = await main.evaluate(() =>
    window.coloop.scheduleTask({
      runAt: new Date(Date.now() + 60000).toISOString(),
      timezone: 'Asia/Shanghai',
      request: {
        prompt: '隔离验收定时任务',
        target: 'cloud',
        source: 'text',
        intent: 'execute',
        context: '',
      },
    }),
  )
  assert.equal(scheduled.ok, true)
  const scheduleState = await main.evaluate(() => window.coloop.snapshot())
  const nativeSchedule = scheduleState.value.schedules.entries.find(
    (entry) => entry.id === scheduled.value.id,
  )
  assert.match(nativeSchedule.nativeId, /^schedule-/)
  const cancelledSchedule = await main.evaluate(
    (id) => window.coloop.cancelScheduledTask(id),
    scheduled.value.id,
  )
  assert.equal(cancelledSchedule.ok, true)
  report.nativeSchedule = { registered: true, nativeId: nativeSchedule.nativeId, cancelled: true }
  assert.equal(
    state.value.settings.provider.hasKey,
    false,
    'smoke profile must not contain cloud credentials',
  )
  assert.equal(state.value.settings.decisionProvider?.hasKey ?? false, false)
  const configured = await main.evaluate(async () => {
    const current = (await window.coloop.snapshot()).value.settings
    return window.coloop.saveSettings({
      ...current,
      provider: {
        ...current.provider,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
      },
      modelLimits: {
        ...current.modelLimits,
        mode: 'custom',
        usageBudgetEnabled: true,
        maxRequestsPerTask: 3,
      },
    })
  })
  assert.equal(configured.ok, true)
  const unlimited = await main.evaluate(() =>
    window.coloop.updatePreferences({ modelLimitMode: 'unlimited' }),
  )
  assert.equal(unlimited.ok, true)
  assert.equal(unlimited.value.modelLimits.mode, 'unlimited')
  assert.equal(unlimited.value.modelLimits.maxRequestsPerTask, 3)
  const effective = await main.evaluate(
    async () => (await window.coloop.snapshot()).value.modelUsage.limits,
  )
  assert.equal(effective.usageBudgetEnabled, false)
  assert.equal(effective.inputLimitEnabled, false)
  report.modelLimits = {
    mode: effective.mode,
    inputLimitEnabled: effective.inputLimitEnabled,
    usageBudgetEnabled: effective.usageBudgetEnabled,
  }
  const autoMethods = [
    'createAutoAgentWork',
    'updateAutoAgentWork',
    'submitAutoAgentFeedback',
    'installAutoAgentHooks',
    'uninstallAutoAgentHooks',
    'refreshAutoAgentWork',
    'testDecisionProvider',
  ]
  assert.deepEqual(
    await main.evaluate((names) => names.map((name) => typeof window.coloop[name]), autoMethods),
    autoMethods.map(() => 'function'),
  )
  const has = await app.evaluate(async ({ BrowserWindow }) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let n = 0; n < 50; n++) {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('surface=control'),
      )
      if (win?.isVisible())
        return { visible: true, focusable: win.isFocusable(), bounds: win.getBounds() }
      await wait(100)
    }
    return { visible: false }
  })
  assert.equal(has.visible, true)
  assert.equal(has.focusable, false)
  await main.getByRole('button', { name: '配置', exact: true }).click()
  await main.getByRole('button', { name: /模型运行与调试/ }).click()
  await main.getByText('DSH 原生自动压缩与续跑').waitFor()
  assert.equal(await main.getByLabel('不限额', { exact: false }).isChecked(), true)
  await main.screenshot({ path: resolve(output, 'dsh-model-limits.png') })
  await main.getByRole('button', { name: '测试模型回复', exact: true }).click()
  await main.locator('summary').filter({ hasText: '高级参数' }).click()
  const outputBudget = main.getByLabel('输出预算（留空使用默认）')
  assert.equal(await outputBudget.inputValue(), '')
  await main.screenshot({ path: resolve(output, 'model-output-budget.png') })
  await main.getByRole('button', { name: '返回模型运行与调试', exact: true }).click()
  await main.getByRole('button', { name: '返回配置', exact: true }).click()
  await main.getByRole('button', { name: /云端模型/ }).click()
  const localOutput = main.getByLabel('本地模型默认输出（tokens，留空遵循模型）')
  await localOutput.fill('768')
  await main.getByRole('button', { name: '保存配置', exact: true }).click()
  await main.waitForFunction(
    async () => (await window.coloop.snapshot()).value.settings.localModel?.outputTokens === 768,
  )
  await localOutput.scrollIntoViewIfNeeded()
  await main.screenshot({ path: resolve(output, 'local-model-settings.png') })
  await localOutput.fill('')
  await main.getByRole('button', { name: '保存配置', exact: true }).click()
  await main.waitForFunction(
    async () =>
      (await window.coloop.snapshot()).value.settings.localModel?.outputTokens === undefined,
  )
  await main.getByRole('button', { name: '返回配置', exact: true }).click()
  await main.getByRole('button', { name: /电脑操作调试/ }).click()
  const recovery = main.getByRole('region', { name: '可恢复任务' })
  await recovery.getByText('合成恢复记录：核对产物后继续', { exact: true }).waitFor()
  assert.equal(
    await recovery.getByRole('button', { name: '恢复任务', exact: true }).isDisabled(),
    true,
  )
  await main.screenshot({ path: resolve(output, 'main.png') })
  await recovery.screenshot({ path: resolve(output, 'recovery.png') })
  const island = app.windows().find((page) => page.url().includes('surface=control'))
  assert.ok(island)
  const islandGeometry = () =>
    island.evaluate(() => {
      const shell = document.querySelector('main')
      const rect = shell.getBoundingClientRect()
      const style = getComputedStyle(shell)
      return {
        shell: rect.toJSON(),
        title: document.querySelector('.control-copy').getBoundingClientRect().toJSON(),
        radius: style.borderRadius,
        shadow: style.boxShadow,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backdropFilter: style.backdropFilter,
        top: rect.top,
        bottom: innerHeight - rect.bottom,
      }
    })
  const compactGeometry = await islandGeometry()
  assert.ok(
    compactGeometry.shadow.split(/,(?![^()]*\))/).every((shadow) => shadow.includes('inset')),
  )
  assert.equal(compactGeometry.backgroundColor, 'rgba(0, 0, 0, 0)')
  assert.ok(compactGeometry.backdropFilter.includes('blur(28px)'))
  assert.ok(compactGeometry.backgroundImage.includes('linear-gradient'))
  assert.ok(Math.abs(compactGeometry.top - compactGeometry.bottom) <= 1)
  await island.locator('main').hover()
  await island.waitForTimeout(300)
  assert.deepEqual(await islandGeometry(), compactGeometry, 'hover preserves island geometry')
  assert.equal(await island.getByText('收边', { exact: true }).count(), 0)
  report.islandGeometry = { hoverStable: true, symmetricInsets: true, outerShadow: false }
  await island.screenshot({ path: resolve(output, 'island-compact.png') })
  await island.getByRole('button', { name: '展开任务详情', exact: true }).click()
  await island.getByRole('textbox', { name: '让 Coloop 做什么', exact: true }).waitFor()
  assert.equal(
    await island.getByRole('button', { name: '发送命令', exact: true }).isDisabled(),
    true,
  )
  await island.screenshot({ path: resolve(output, 'island.png') })
  // Exercise the production service, preload and indicator IPC using an offline
  // startup failure. No runtime or input session can begin in this profile.
  const failedStart = await main.evaluate(() => window.coloop.startProactiveTask('离线恢复回归'))
  assert.equal(failedStart.ok, false)
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.webContents.getURL().includes('surface=control'))
        ?.isMinimized(),
    ),
    true,
    'task admission minimizes the main window and retains its taskbar button',
  )
  await island.locator('main[data-mode="failed"]').waitFor()
  await island.locator('main').hover()
  await island.getByRole('button', { name: '展开任务详情', exact: true }).click()
  await island.getByRole('button', { name: '取消', exact: true }).click()
  await island.locator('main[data-mode="idle"]').waitFor()
  const recovered = await main.evaluate(() => window.coloop.snapshot())
  assert.equal(recovered.value.proactive.phase, 'idle')
  assert.equal(recovered.value.proactive.taskId, undefined)
  assert.equal(recovered.value.proactive.error, undefined)
  await island.locator('main').hover()
  await island.getByRole('button', { name: '展开任务详情', exact: true }).click()
  await island.locator('main').hover()
  await island.screenshot({ path: resolve(output, 'before-island-close.png') })
  await island.getByRole('button', { name: '关闭灵动岛', exact: true }).click()
  await island.waitForTimeout(500)
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('surface=control'))
        ?.isVisible(),
    ),
    false,
  )
  // The production residency watchdog must respect a deliberate close.
  await island.waitForTimeout(2200)
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('surface=control'))
        ?.isVisible(),
    ),
    false,
  )
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('surface=control'))
      ?.show(),
  )
  await main.getByRole('button', { name: '返回配置', exact: true }).click()
  await main.getByRole('button', { name: /外部 Agent 与自动推进/ }).click()
  await main.getByRole('form', { name: '开始跟进任务', exact: true }).waitFor()
  await main.getByRole('heading', { name: 'Auto Agent Work', exact: true }).waitFor()
  report.autoAgentWork.checks.push(
    'Production snapshot, preload methods and Auto Agent Work page load',
  )

  // Synthetic source events exercise the packaged transport and authenticated production
  // server. They do not establish compatibility with a real ChatGPT desktop session.
  const packaged = await app.evaluate(() => ({
    resources: process.resourcesPath,
    executable: process.execPath,
  }))
  const packageDirectory = await realpath(dirname(packaged.executable))
  const sourceMode = process.env.COLOOP_TEST_SOURCE === '1'
  const resources = await realpath(sourceMode ? join(root, 'resources') : packaged.resources)
  if (!sourceMode)
    assert.equal(resources.toLowerCase(), join(packageDirectory, 'resources').toLowerCase())
  const packagedNode = await realpath(
    sourceMode
      ? join(root, '.cache/node-runtime/node.exe')
      : join(resources, 'runtime', 'node', 'node.exe'),
  )
  const packagedHook = await realpath(join(resources, 'auto-agent-work-hook.mjs'))
  for (const path of [packagedNode, packagedHook])
    assert.ok(path.toLowerCase().startsWith((sourceMode ? root : resources).toLowerCase() + sep))
  const existingGroup = {
    matcher: 'smoke-existing',
    hooks: [{ type: 'command', command: 'echo preexisting-smoke-hook', timeout: 1 }],
  }
  const initialHooks = {
    smokeMetadata: { preserve: true },
    hooks: { Stop: [existingGroup], PostToolUse: [existingGroup] },
  }
  const hookConfigPath = join(hookProject, '.codex', 'hooks.json')
  await mkdir(dirname(hookConfigPath), { recursive: true })
  await writeFile(hookConfigPath, JSON.stringify(initialHooks))
  const installed = await main.evaluate(
    (workspace) => window.coloop.installAutoAgentHooks({ workspace }),
    hookProject,
  )
  assert.equal(installed.ok, true, installed.error)
  assert.equal(installed.value.installed, true)
  assert.equal(installed.value.trust, 'review_required')
  const installedHooks = JSON.parse(await readFile(hookConfigPath, 'utf8'))
  assert.deepEqual(installedHooks.hooks.Stop[0], existingGroup)
  assert.deepEqual(installedHooks.hooks.PostToolUse[0], existingGroup)
  assert.deepEqual(installedHooks.smokeMetadata, initialHooks.smokeMetadata)
  const ownedHook = installedHooks.hooks.SessionStart.find((group) =>
    group.hooks.some((hook) => hook.statusMessage === 'Coloop Auto Work'),
  )?.hooks[0]
  assert.ok(ownedHook, 'installed source configuration must contain the owned transport')
  for (const path of [packagedNode, packagedHook, installed.value.connectionPath])
    assert.ok(ownedHook.command.includes(path))
  const connectionPath = await realpath(installed.value.connectionPath)
  assert.ok(
    connectionPath.startsWith((await realpath(profile)) + sep),
    'transport credentials must stay in the isolated profile',
  )
  const connection = JSON.parse(await readFile(connectionPath, 'utf8'))
  const refused = await fetch(new URL('/v1/auto-work/hooks', connection.url), {
    method: 'POST',
    headers: {
      authorization: 'Bearer invalid-protocol-smoke-token',
      'content-type': 'application/json',
    },
    body: '{}',
  })
  assert.ok(
    [401, 403].includes(refused.status),
    'the real ingress must reject an unauthenticated request at its authentication or origin boundary',
  )
  await refused.text()
  const nativeSessionId = 'protocol-smoke-' + randomUUID()
  const turnId = 'protocol-turn-' + randomUUID()
  const runHook = async (hook_event_name, extra = {}) => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(packagedNode, [packagedHook, '--connection', connectionPath], {
        cwd: hookProject,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      })
      let stdout = '',
        stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (text) => {
        stdout += text
      })
      child.stderr.on('data', (text) => {
        stderr += text
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(
        JSON.stringify({
          session_id: nativeSessionId,
          turn_id: turnId,
          cwd: hookProject,
          hook_event_name,
          ...extra,
        }),
      )
    })
    assert.equal(result.code, 0, 'packaged hook process must exit successfully')
    assert.equal(result.stderr, '', 'packaged transport must not emit errors')
    assert.deepEqual(JSON.parse(result.stdout), {}, 'offline smoke must never issue a continuation')
  }
  await runHook('SessionStart')
  await main.waitForFunction(
    async (nativeId) =>
      (await window.coloop.snapshot()).value.autoAgentWork.sessions.some(
        (session) => session.sessionId === nativeId,
      ),
    nativeSessionId,
  )
  await runHook('PreModelRequest')
  const session = await main.evaluate(
    async (nativeId) =>
      (await window.coloop.snapshot()).value.autoAgentWork.sessions.find(
        (session) => session.sessionId === nativeId,
      ),
    nativeSessionId,
  )
  assert.equal(session.state, 'running')
  assert.equal(session.desktopVerified, false)
  const created = await main.evaluate(
    (sessionId) =>
      window.coloop.createAutoAgentWork({
        sessionId,
        goal: '协议验收：验证任务状态接收，不执行电脑操作',
        acceptance: ['缺少模型配置时显示需要处理，不得误报完成'],
      }),
    session.id,
  )
  assert.equal(created.ok, true, created.error)
  const taskId = created.value
  const readTask = () =>
    main.evaluate(
      async (id) =>
        (await window.coloop.snapshot()).value.autoAgentWork.tasks.find((task) => task.id === id),
      taskId,
    )
  assert.equal((await readTask()).state, 'watching')
  for (const [action, expected] of [
    ['pause', 'paused'],
    ['resume', 'watching'],
  ]) {
    const result = await main.evaluate((input) => window.coloop.updateAutoAgentWork(input), {
      taskId,
      action,
    })
    assert.equal(result.ok, true, result.error)
    assert.equal((await readTask()).state, expected)
  }
  await runHook('Stop', {
    last_assistant_message:
      '这是协议验收使用的合成结束事件，仅证明打包 Hook 到应用服务的传输；没有执行外部 Agent 任务。',
  })
  await main.waitForFunction(
    async (id) =>
      (await window.coloop.snapshot()).value.autoAgentWork.tasks.find((task) => task.id === id)
        ?.state === 'needs_user',
    taskId,
    { timeout: 20000 },
  )
  const blocked = await readTask()
  assert.match(blocked.error, /API Key/)
  assert.ok(blocked.events.some((event) => event.type === 'started'))
  assert.ok(blocked.events.some((event) => event.type === 'stopped'))
  assert.equal(blocked.actions.length, 0)
  assert.equal(blocked.decisions.length, 0)
  assert.notEqual(blocked.state, 'completed')
  const observed = await main.evaluate(() => window.coloop.snapshot())
  assert.equal(observed.value.autoAgentWork.hooks.trust, 'observed')
  assert.equal(observed.value.modelUsage?.requests ?? 0, 0)
  assert.equal(observed.value.proactive.connected, false)
  await main.screenshot({ path: resolve(output, 'auto-agent-work-protocol.png') })
  report.autoAgentWork.checks.push(
    'Packaged Node and hook stdin reach the authenticated app server; invalid authentication is rejected',
    'IPC binds the discovered synthetic session, pauses and explicitly resumes it',
    'Real missing-model failure stays needs_user with zero decisions, writes and cloud requests',
  )
  const unbound = await main.evaluate((input) => window.coloop.updateAutoAgentWork(input), {
    taskId,
    action: 'unbind',
  })
  assert.equal(unbound.ok, true, unbound.error)
  assert.equal((await readTask()).state, 'unbound')
  const settingsSaved = await main.evaluate(async (workspace) => {
    const current = (await window.coloop.snapshot()).value.settings
    return window.coloop.saveSettings({ ...current, taskWorkspace: workspace })
  }, hookProject)
  assert.equal(settingsSaved.ok, true, settingsSaved.error)
  const enabled = await main.evaluate(() => window.coloop.setAutoAgentEnabled(true))
  assert.equal(enabled.ok, true, enabled.error)
  assert.equal(enabled.value.enabled, true)
  await runHook('UserPromptSubmit', { prompt: '自动发现测试：读取文件并运行测试' })
  await main.waitForFunction(async () =>
    (await window.coloop.snapshot()).value.autoAgentWork.tasks.some(
      (task) => task.goal === '自动发现测试：读取文件并运行测试' && task.state === 'watching',
    ),
  )
  await runHook('PostToolUse', {
    tool_name: 'read_file',
    tool_response: { text: '具体工具输出可见', count: 42 },
  })
  await main.getByRole('button', { name: '首页', exact: true }).click()
  if (await main.getByRole('button', { name: '打开任务列表', exact: true }).isVisible())
    await main.getByRole('button', { name: '打开任务列表', exact: true }).click()
  await main.getByRole('button', { name: /自动发现测试：读取文件并运行测试/ }).click()
  await main
    .getByText(/具体工具输出可见/)
    .first()
    .waitFor()
  const disabled = await main.evaluate(() => window.coloop.setAutoAgentEnabled(false))
  assert.equal(disabled.ok, true, disabled.error)
  assert.equal(disabled.value.enabled, false)
  const autoTask = await main.evaluate(async () =>
    (await window.coloop.snapshot()).value.autoAgentWork.tasks.find(
      (task) => task.goal === '自动发现测试：读取文件并运行测试',
    ),
  )
  assert.equal(autoTask.state, 'paused')
  assert.ok(autoTask.events.some((event) => event.text?.includes('具体工具输出可见')))
  report.autoAgentWork.checks.push(
    'Homepage switch installs hooks, automatically binds a new prompt, renders structured tool output and pauses on disable',
  )
  const removed = await main.evaluate(
    (workspace) => window.coloop.uninstallAutoAgentHooks({ workspace }),
    hookProject,
  )
  assert.equal(removed.ok, true, removed.error)
  assert.equal(removed.value.installed, false)
  assert.deepEqual(JSON.parse(await readFile(hookConfigPath, 'utf8')), initialHooks)
  await assert.rejects(lstat(join(hookProject, '.codex', 'coloop-auto-work-hooks.json')), {
    code: 'ENOENT',
  })
  report.autoAgentWork.checks.push(
    'Unbind ends supervision; uninstall removes only owned entries and preserves preexisting hooks',
  )
  report.island = has
  report.proactive = state.value.proactive
  report.ok = true
} catch (error) {
  report.error = error instanceof Error ? error.message : 'PACKAGE_SMOKE_FAILED'
  throw error
} finally {
  try {
    await app?.close()
    const resolvedProfile = await realpath(profile)
    const resolvedRoot = await realpath(temporaryRoot)
    assert.ok(
      resolvedProfile.startsWith(resolvedRoot + sep) && !(await lstat(profile)).isSymbolicLink(),
      'cleanup must stay within this generated smoke profile',
    )
    await rm(resolvedProfile, { recursive: true, force: true })
    await assert.rejects(lstat(profile), { code: 'ENOENT' })
    report.cleanup = { profileRemoved: true, hookProjectRemoved: true, credentialsRemoved: true }
  } catch (error) {
    report.ok = false
    report.cleanup.error = error instanceof Error ? error.message : 'PROFILE_CLEANUP_FAILED'
    throw error
  } finally {
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  }
}
console.log(JSON.stringify({ ok: report.ok, output, scope: report.autoAgentWork.scope }))
