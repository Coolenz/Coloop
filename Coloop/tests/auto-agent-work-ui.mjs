import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa/auto-agent-work-ui')
await mkdir(output, { recursive: true })
const executablePath = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
if (!executablePath) throw new Error('A local Chrome or Edge installation is required')
const server = await createServer({
  configFile: false,
  root: resolve(root, 'src/renderer'),
  plugins: [react()],
  cacheDir: resolve(root, '.cache/vite-auto-agent-work-ui'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
})
await server.listen()
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const errors = [],
  checks = []
page.on('pageerror', (error) => errors.push(error.message))
await page.addInitScript(() => {
  const session = {
    id: 'fixture-session',
    source: 'chatgpt-desktop',
    instanceId: 'instance-1',
    sessionId: 'native-1',
    title: '导出功能修复',
    workspace: 'D:/Coloop',
    turnId: 'turn-1',
    revision: 1,
    state: 'idle',
    lastSeenAt: new Date().toISOString(),
    capabilities: {
      events: 'verified',
      nativeContinue: 'available',
      reply: 'unknown',
      stop: 'available',
      desktopWrite: 'unsupported',
    },
  }
  const state = {
    settings: {
      provider: {
        protocol: 'openai',
        name: '日常模型',
        baseUrl: 'https://example.invalid/v1',
        model: 'normal-model',
        hasKey: true,
      },
      board: { host: '169.254.207.141', port: 22, username: 'cat', fingerprint: 'A'.repeat(43) },
      ocrWorkspace: 'D:/RK',
      taskWorkspace: 'D:/OldDefault',
    },
    device: { status: 'disconnected' },
    tasks: [],
    version: 'UI fixture',
    ocrBusy: false,
    ocrProgress: 0,
    autoAgentWork: {
      sessions: [session],
      tasks: [],
      hooks: { workspace: 'D:/OldDefault', installed: false, trust: 'unknown' },
      active: false,
    },
    modelUsage: { requests: 8, tokenUnits: 4200, estimatedCostYuan: 0.018, unpricedRequests: 2 },
  }
  const listeners = new Set()
  const calls = []
  const normalizeWorkspace = (workspace) =>
    workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const hookRoots = new Map([
    [
      'd:/coloop',
      {
        workspace: 'D:/Coloop',
        installed: true,
        trust: 'observed',
        configPath: 'D:/Coloop/.codex/hooks.json',
      },
    ],
    [
      'd:/otherproject',
      {
        workspace: 'D:/OtherProject',
        installed: false,
        trust: 'unknown',
        configPath: 'D:/OtherProject/.codex/hooks.json',
      },
    ],
    [
      'd:/installedother',
      {
        workspace: 'D:/InstalledOther',
        installed: true,
        trust: 'review_required',
        configPath: 'D:/InstalledOther/.codex/hooks.json',
      },
    ],
  ])
  const hookStatus = (workspace) =>
    structuredClone(
      hookRoots.get(normalizeWorkspace(workspace)) ?? {
        workspace,
        installed: false,
        trust: 'unknown',
        configPath: `${workspace}/.codex/hooks.json`,
      },
    )
  const ok = (value) => ({ ok: true, value })
  const emit = () => listeners.forEach((listener) => listener(structuredClone(state)))
  const task = () => state.autoAgentWork.tasks[0]
  globalThis.aawTest = {
    state,
    calls,
    emit,
    task,
    hookRoots,
    hookStatus,
    failSupplement: false,
    refreshDelay: 0,
  }
  window.coloop = {
    setAutoAgentEnabled: async (enabled) => {
      state.autoAgentWork.enabled = enabled
      emit()
      return ok({ enabled })
    },
    taskHistory: async (id) => ok({ entries: [
      { kind: 'tool_call', name: 'read_file', text: '读取 src/export.ts' },
      { kind: 'tool_result', name: 'read_file', text: '已读取导出函数，检查参数' },
      { kind: 'assistant', text: '正在运行相关测试' },
    ] }),
    snapshot: async () => ok(structuredClone(state)),
    listDisplays: async () => ok([]),
    onSnapshot: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshAutoAgentWork: async (input) => {
      calls.push({ type: 'refresh', input })
      if (globalThis.aawTest.refreshDelay)
        await new Promise((resolve) => setTimeout(resolve, globalThis.aawTest.refreshDelay))
      state.autoAgentWork.hooks = hookStatus(
        input?.workspace ?? state.autoAgentWork.hooks.workspace,
      )
      emit()
      return ok()
    },
    createAutoAgentWork: async (input) => {
      calls.push({ type: 'create', input })
      const id = '22cf2597-6c13-4d3c-805e-2761e27f3905'
      state.autoAgentWork.tasks.unshift({
        ...input,
        id,
        version: 1,
        session,
        supplements: [],
        state: 'watching',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastEvaluatedRevision: 1,
        events: [],
        decisions: [],
        actions: [],
        feedback: [],
        costTaskId: id,
        usage: { requests: 2, tokenUnits: 1300, estimatedCostYuan: 0.007, unpricedRequests: 1 },
      })
      emit()
      return ok(id)
    },
    updateAutoAgentWork: async (input) => {
      calls.push({ type: 'update', input })
      if (input.action === 'supplement' && globalThis.aawTest.failSupplement)
        return { ok: false, error: '合成连接故障，请重试。' }
      task().version++
      task().state =
        input.action === 'pause' || input.action === 'stop_agent'
          ? 'paused'
          : input.action === 'unbind'
            ? 'unbound'
            : 'watching'
      if (input.action === 'supplement') task().supplements.push(input.text)
      emit()
      return ok()
    },
    submitAutoAgentFeedback: async (input) => {
      calls.push({ type: 'feedback', input })
      task().feedback.push({
        ...input,
        id: 'feedback-1',
        createdAt: new Date().toISOString(),
        attribution: 'stored',
      })
      emit()
      return ok()
    },
    installAutoAgentHooks: async (input) => {
      calls.push({ type: 'install', input })
      state.autoAgentWork.hooks = {
        workspace: input.workspace,
        installed: true,
        trust: 'review_required',
        configPath: `${input.workspace}/.codex/hooks.json`,
      }
      hookRoots.set(normalizeWorkspace(input.workspace), structuredClone(state.autoAgentWork.hooks))
      emit()
      return ok(state.autoAgentWork.hooks)
    },
    uninstallAutoAgentHooks: async (input) => {
      calls.push({ type: 'uninstall', input })
      state.autoAgentWork.hooks = {
        workspace: input.workspace,
        installed: false,
        trust: 'unknown',
        configPath: `${input.workspace}/.codex/hooks.json`,
      }
      hookRoots.set(normalizeWorkspace(input.workspace), structuredClone(state.autoAgentWork.hooks))
      emit()
      return ok(state.autoAgentWork.hooks)
    },
    saveSettings: async (input) => {
      calls.push({ type: 'save-settings', input })
      state.settings = structuredClone(input)
      state.settings.provider.hasKey = !!input.provider.apiKey || true
      delete state.settings.provider.apiKey
      if (state.settings.decisionProvider) {
        state.settings.decisionProvider.hasKey = !!input.decisionProvider.apiKey
        delete state.settings.decisionProvider.apiKey
      }
      emit()
      return ok(structuredClone(state.settings))
    },
    testDecisionProvider: async () => {
      calls.push({ type: 'test-decision' })
      const provider = state.settings.decisionProvider ?? state.settings.provider
      provider.imageInput = 'supported'
      emit()
      return ok('合成决策连接测试通过')
    },
    testProvider: async () => ok('合成日常连接测试通过'),
  }
})
const hasNoOverflow = async () =>
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
try {
  await page.goto(server.resolvedUrls.local[0])
  assert.deepEqual(
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button')
      .allTextContents(),
    ['主页', '后台任务', '设备连接', '历史记录'],
  )
  await page.screenshot({ path: join(output, 'home-entry.png'), fullPage: true })
  const toggle = page.getByRole('switch', { name: '自动发现与推进任务' })
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  await page.getByRole('button', { name: '功能配置', exact: true }).click()
  await page.getByRole('heading', { name: '功能配置', exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() => aawTest.calls.filter((call) => call.type === 'create').length),
    0,
  )
  await hasNoOverflow()
  assert.match(
    await page.locator('#aaw-session option:checked').textContent(),
    /导出功能修复\.codex/,
  )
  await page.getByLabel('电脑上的 Agent 会话').selectOption('fixture-session')
  assert.equal(await page.getByRole('button', { name: '开始跟进', exact: true }).isDisabled(), true)
  await page.getByLabel('任务目标', { exact: true }).fill('修复导出功能，并完成实际安装版验收。')
  await page.getByLabel('完成条件', { exact: false }).fill('相关测试通过\n实际安装版验收通过')
  await page.screenshot({ path: join(output, 'create-wide.png'), fullPage: true })
  await page.getByRole('button', { name: '开始跟进', exact: true }).click()
  await page.getByRole('region', { name: '当前跟进任务' }).waitFor()
  await page.getByRole('heading', { name: 'Auto Agent Work', exact: true }).waitFor()
  await page.getByRole('button', { name: '主页', exact: true }).click()
  await page.getByRole('button', { name: '功能配置', exact: true }).click()
  await page.getByRole('form', { name: '开始跟进任务', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '开始跟进', exact: true }).isDisabled(), true)
  assert.equal(
    await page.evaluate(() => aawTest.calls.filter((call) => call.type === 'create').length),
    1,
  )
  await page.getByRole('button', { name: '查看后台任务', exact: true }).click()
  checks.push(
    'Home opens opt-in configuration; existing tasks do not hide the form; only explicit submit creates a task and opens background progress',
  )
  const create = await page.evaluate(
    () => aawTest.calls.find((call) => call.type === 'create').input,
  )
  assert.deepEqual(create.acceptance, ['相关测试通过', '实际安装版验收通过'])
  assert.equal(create.sessionId, 'fixture-session')
  checks.push('Create binds the selected session and preserves individual acceptance criteria')
  await page.waitForFunction(() =>
    aawTest.calls.some((call) => call.type === 'refresh' && call.input?.workspace === 'D:/Coloop'),
  )
  assert.equal(await page.getByLabel('Agent 工作区路径', { exact: true }).inputValue(), 'D:/Coloop')
  assert.match(await page.locator('.aaw-hook summary').innerText(), /已安装/)
  checks.push(
    'A bound task refreshes its own workspace and replaces an unrelated default Hook status',
  )
  await page.getByRole('button', { name: '暂停跟进', exact: true }).click()
  await page.getByRole('button', { name: '恢复跟进', exact: true }).click()
  const supplement = page.getByLabel('补充要求或回答', { exact: true })
  await supplement.fill('保持现有界面风格。')
  await page.evaluate(() => {
    aawTest.failSupplement = true
  })
  await page.getByRole('button', { name: '更新要求', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '合成连接故障' }).waitFor()
  assert.equal(await supplement.inputValue(), '保持现有界面风格。')
  await page.evaluate(() => {
    aawTest.failSupplement = false
  })
  await page.getByRole('button', { name: '更新要求', exact: true }).click()
  await page.waitForFunction(() => aawTest.task().supplements.length === 1)
  assert.equal(await supplement.inputValue(), '')
  checks.push('Pause/resume target the task; failed supplement retains draft until accepted')
  await page.evaluate(() => {
    const task = aawTest.task()
    task.state = 'needs_user'
    task.memory = {
      status: 'matched',
      version: task.version,
      references: [
        {
          id: 'preference-1',
          kind: 'explicit',
          text: '修改后通过验证就更新本机安装版；不长期保留构建副本。',
        },
      ],
    }
    task.decisions = [
      {
        id: '0f9f00a8-9f08-4bb1-9e5e-7b47e4895551',
        taskVersion: task.version,
        eventRevision: 2,
        action: 'ask_user',
        reason: '需要确认本次验收的结果。',
        message: '相关测试通过；实际安装版的核验仍待完成。',
        expectedChange: '获得安装版核验结果',
        evidence: [],
        trigger: 'stopped',
        model: 'strong-model',
        createdAt: new Date().toISOString(),
        memoryReferences: ['preference-1'],
        acceptance: {
          verdict: 'fail',
          requirements: [
            { requirement: '相关测试通过', satisfied: true, evidence: '回归测试退出码0' },
          ],
          gaps: ['实际安装版尚未核验'],
          imperfections: [],
        },
      },
    ]
    aawTest.emit()
  })
  await page.getByText('实际安装版尚未核验', { exact: true }).waitFor()
  await hasNoOverflow()
  await page.screenshot({ path: join(output, 'task-wide.png'), fullPage: true })
  await page.setViewportSize({ width: 940, height: 850 })
  await hasNoOverflow()
  await page.screenshot({ path: join(output, 'task-compact.png'), fullPage: true })
  checks.push(
    'Shows actual gaps, referenced preferences and separate task/global usage without overflow',
  )
  await page.evaluate(() => {
    aawTest.task().state = 'completed'
    aawTest.emit()
  })
  await page.getByRole('region', { name: '个人评价' }).waitFor()
  assert.equal(
    await page.evaluate(() => aawTest.calls.filter((call) => call.type === 'feedback').length),
    0,
  )
  await page.getByRole('button', { name: '需要改进', exact: true }).click()
  await page
    .getByLabel('原因或希望怎样调整', { exact: false })
    .fill('以后这类小修改直接完成，不重复询问。')
  await page.getByLabel('用于以后类似任务', { exact: true }).check()
  await page.getByRole('button', { name: '提交评价', exact: true }).click()
  const feedback = await page.evaluate(
    () => aawTest.calls.find((call) => call.type === 'feedback').input,
  )
  assert.equal(feedback.scope, 'future')
  assert.equal(feedback.rating, 'negative')
  checks.push(
    'Completion never submits feedback automatically; explicit negative/future feedback is preserved',
  )
  await page.getByText('Hook 接入', { exact: false }).first().click()
  const hookPanel = page.locator('.aaw-hook')
  const workspace = page.getByLabel('Agent 工作区路径', { exact: true })
  const uninstall = page.getByRole('button', { name: '卸载 Hook', exact: true })
  await page.evaluate(() => {
    const other = structuredClone(aawTest.task())
    other.id = 'other-workspace-task'
    other.goal = '另一个项目的已结束任务'
    other.session = {
      ...other.session,
      id: 'other-workspace-session',
      workspace: 'D:/InstalledOther',
    }
    aawTest.state.autoAgentWork.tasks.push(other)
    aawTest.emit()
  })
  await page.getByLabel('跟进任务', { exact: true }).selectOption('other-workspace-task')
  await page.waitForFunction(
    () => aawTest.state.autoAgentWork.hooks.workspace === 'D:/InstalledOther',
  )
  assert.equal(await workspace.inputValue(), 'D:/InstalledOther')
  await page
    .getByLabel('跟进任务', { exact: true })
    .selectOption('22cf2597-6c13-4d3c-805e-2761e27f3905')
  await page.waitForFunction(() => aawTest.state.autoAgentWork.hooks.workspace === 'D:/Coloop')
  assert.equal(await workspace.inputValue(), 'D:/Coloop')
  checks.push('Switching the selected task refreshes the workspace attached to that task')
  await workspace.fill('D:/OtherProject')
  assert.match(await hookPanel.locator('summary').innerText(), /尚未检查此工作区/)
  assert.equal(await uninstall.isDisabled(), true)
  assert.equal(await hookPanel.getByText('已收到源端事件。', { exact: true }).count(), 0)
  assert.equal(await hookPanel.locator('.aaw-path').count(), 0)
  await workspace.press('Tab')
  await page.waitForFunction(
    () => aawTest.state.autoAgentWork.hooks.workspace === 'D:/OtherProject',
  )
  assert.match(await hookPanel.locator('summary').innerText(), /尚未安装/)
  assert.equal(await uninstall.isDisabled(), true)
  await page.evaluate(() => {
    aawTest.state.autoAgentWork.hooks = aawTest.hookStatus('D:/Coloop')
    aawTest.emit()
  })
  assert.match(await hookPanel.locator('summary').innerText(), /尚未检查此工作区/)
  assert.equal(await uninstall.isDisabled(), true)
  assert.equal(await hookPanel.locator('.aaw-path').count(), 0)
  checks.push(
    'Changing workspace or receiving another root snapshot hides its status/path and disables uninstall',
  )
  await workspace.fill('D:/InstalledOther')
  await workspace.press('Tab')
  await page.waitForFunction(
    () => aawTest.state.autoAgentWork.hooks.workspace === 'D:/InstalledOther',
  )
  await uninstall.click()
  assert.equal(
    await page.evaluate(
      () => aawTest.calls.filter((call) => call.type === 'uninstall').at(-1).input.workspace,
    ),
    'D:/InstalledOther',
  )
  assert.equal(await page.evaluate(() => aawTest.hookRoots.get('d:/coloop').installed), true)
  await workspace.fill('d:\\COLOOP\\')
  await workspace.press('Tab')
  await page.waitForFunction(() => aawTest.state.autoAgentWork.hooks.workspace === 'D:/Coloop')
  assert.match(await hookPanel.locator('summary').innerText(), /已安装/)
  await uninstall.click()
  checks.push(
    'Uninstall targets only the checked root; case and slash normalization preserve workspace identity',
  )
  await workspace.fill('D:/Coloop')
  await page.evaluate(() => {
    aawTest.refreshDelay = 80
  })
  const installsBefore = await page.evaluate(
    () => aawTest.calls.filter((call) => call.type === 'install').length,
  )
  await page.getByRole('button', { name: '安装 Hook', exact: true }).click()
  await page.waitForFunction(
    (count) => aawTest.calls.filter((call) => call.type === 'install').length === count + 1,
    installsBefore,
    { timeout: 3000 },
  )
  await page.evaluate(() => {
    aawTest.refreshDelay = 0
  })
  await page
    .getByText('源应用需要审阅 Hook 配置；请在源应用中完成信任设置。', { exact: true })
    .waitFor()
  await page.getByRole('button', { name: '卸载 Hook', exact: true }).click()
  checks.push('Hook installation reports pending source trust without claiming readiness')
  await page.getByRole('button', { name: '设备连接', exact: true }).click()
  await page.getByRole('button', { name: '模型连接', exact: true }).click()
  await page.getByLabel('为 Auto Agent Work 单独指定模型', { exact: true }).check()
  await page.getByLabel('决策模型名称', { exact: true }).fill('strong-model')
  await page.getByLabel('决策模型 API Key', { exact: true }).fill('synthetic-key')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '测试决策模型', exact: true }).click()
  await page.getByText('图像探测通过', { exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: '决策模型图像输入' }).count(), 0)
  const saved = await page.evaluate(
    () => aawTest.calls.find((call) => call.type === 'save-settings').input,
  )
  assert.equal(saved.decisionProvider.model, 'strong-model')
  assert.equal(saved.provider.model, 'normal-model')
  await page
    .locator('.decision-model-section')
    .screenshot({ path: join(output, 'decision-model-compact.png') })
  await page.getByLabel('为 Auto Agent Work 单独指定模型', { exact: true }).uncheck()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '测试决策模型', exact: true }).click()
  assert.equal(
    await page.evaluate(
      () =>
        aawTest.calls.filter((call) => call.type === 'save-settings').at(-1).input.decisionProvider,
    ),
    undefined,
  )
  checks.push(
    'Separate decision model/key save independently; disabling it restores default-model routing',
  )
  checks.push(
    'Image capability is read-only and updated from a probe; default-model fallback can also be tested',
  )
  await page.getByRole('button', { name: '主页', exact: true }).click()
  await page.evaluate(() => {
    const task = aawTest.task()
    task.state = 'watching'
    task.events.push({ id: 'home-output', at: new Date().toISOString(), text: '已读取文件，正在执行测试，输出 42 passed', type: 'progress' })
    aawTest.emit()
  })
  await page.getByText('已读取文件，正在执行测试，输出 42 passed', { exact: true }).waitFor()
  await page.locator('.main-scroll').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'home-live-output.png'), fullPage: true })
  await page.setViewportSize({ width: 1060, height: 720 })
  await hasNoOverflow()
  await page.screenshot({ path: join(output, 'home-live-compact.png'), fullPage: true })
  await page.evaluate(() => {
    aawTest.state.tasks = [{ id: 'live-ordinary', prompt: '检查导出实现', stage: '正在测试', status: 'running', answer: '', createdAt: new Date().toISOString(), model: 'fixture', target: 'cloud', source: 'text' }]
    aawTest.emit()
  })
  await page.getByText('已读取导出函数，检查参数', { exact: true }).waitFor()
  await page.getByText('正在运行相关测试', { exact: true }).waitFor()
  await page.evaluate(() => { aawTest.state.tasks = []; aawTest.emit() })
  checks.push('Homepage switch and visible live process output at both desktop sizes, including ordinary tool calls/results')
  await page.evaluate(() => { aawTest.task().state = 'completed'; aawTest.emit() })
  for (const [group, tool, heading] of [
    ['主页', '屏幕工具', '屏幕理解'],
    ['主页', '电脑操作', '电脑操作'],
    ['后台任务', '工作流', '工作流'],
    ['后台任务', 'Agent 协调', 'Agent 协调'],
    ['设备连接', 'RK 设备', '设备管理'],
    ['历史记录', '执行任务', '历史记录'],
  ]) {
    await page
      .getByRole('navigation', { name: '主导航', exact: true })
      .getByRole('button', { name: group, exact: true })
      .click()
    await page.getByRole('button', { name: tool, exact: true }).click()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    await hasNoOverflow()
  }
  await page.getByRole('button', { name: 'Agent 跟进记录', exact: true }).click()
  await page.getByRole('button').filter({ hasText: '修复导出功能，并完成实际安装版验收。' }).click()
  await page.getByRole('region', { name: '个人评价' }).waitFor()
  checks.push(
    'Four primary sections retain tools; named Agent history opens the matching completed task',
  )
  assert.deepEqual(errors, [])
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope:
          'Actual React UI in local Chrome with explicit API fixtures. No external agent, model or RK execution.',
        checks,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ output, checks: checks.length }))
} catch (error) {
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: false,
        scope: 'Isolated React UI with API fixtures; no real desktop, model or RK execution.',
        checks,
        errors: [...errors, error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
  await server.close()
}
