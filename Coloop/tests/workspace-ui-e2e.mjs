import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', 'workspace-ui-' + Date.now())
await mkdir(output, { recursive: true })
const server = await createServer({
  root: join(root, 'src/renderer'),
  configFile: false,
  plugins: [react()],
  cacheDir: join(root, '.cache/vite-workspace-ui'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
})
await server.listen()
const port = server.httpServer.address().port
const profile = join(output, 'profile')
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'msedge',
  headless: true,
  viewport: { width: 1440, height: 960 },
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await browser.addInitScript(() => {
  const listeners = new Set(),
    islandListeners = new Set()
  const now = new Date().toISOString()
  const makeConversation = (title, text, answer) => {
    const id = crypto.randomUUID(),
      runId = crypto.randomUUID()
    return {
      id,
      title,
      archived: false,
      draft: '',
      scrollTop: 0,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: crypto.randomUUID(), text, at: now, runId, delivery: 'accepted' }],
      runs: [
        {
          id: runId,
          policy: { mode: 'cloud', cloudFallback: true },
          state: 'completed',
          createdAt: now,
          task: {
            id: runId,
            prompt: text,
            answer,
            model: 'DeepSeek Flash · 云端',
            createdAt: now,
            finishedAt: now,
            source: 'text',
            target: 'cloud',
            status: 'completed',
            stage: '已完成',
          },
        },
      ],
    }
  }
  const conversations = [
    makeConversation(
      '整理课程资料',
      '把这份课程资料整理成复习提纲，并标出需要理解的重点。',
      '已整理课程的五个章节。\n\n第一章 · 基本概念\n重点理解核心定义与适用条件。\n\n第二章 · 方法与应用\n先掌握步骤，再通过例题核对结果。\n\n你可以继续补充复习范围，我会在这个任务中继续整理。',
    ),
    makeConversation('分析项目代码', '检查当前项目的结构。', '已检查项目入口和主要模块。'),
  ]
  const snapshot = {
    version: '0.14.0',
    settings: {
      provider: {
        protocol: 'openai',
        name: 'DeepSeek',
        model: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com',
        hasKey: true,
      },
      board: { host: '127.0.0.1', port: 22, username: 'test', fingerprint: 'fixture' },
      ocrWorkspace: 'D:/RK',
      taskWorkspace: 'D:/Coloop',
      executionMode: 'cloud',
    },
    device: {
      status: 'connected',
      hostname: 'lubancat',
      qwenReady: true,
      modelPrivacyReady: true,
      model: 'qwen35-4b-rkllm',
    },
    tasks: conversations.flatMap((item) => item.runs.map((run) => run.task)),
    conversations: { conversations, queue: [], paused: false },
    ocrBusy: false,
    ocrProgress: 0,
    credentials: { protected: false },
    proactive: { phase: 'idle', active: false },
    autoAgentWork: { tasks: [], sessions: [], enabled: false, hooks: {} },
  }
  snapshot.autoAgentWork.tasks.push({
    id: 'external-fixture',
    goal: 'Review TypeScript UI',
    state: 'paused',
    version: 1,
    createdAt: now,
    updatedAt: now,
    session: {
      id: 'external-session',
      sessionId: 'external-session',
      source: 'chatgpt-desktop',
      title: '界面回归验收',
      workspace: 'D:/Coloop',
      capabilities: { stop: 'unsupported' },
    },
    acceptance: ['检查界面交互'],
    actions: [],
    decisions: [],
    events: [],
  })
  const ok = (value) => Promise.resolve({ ok: true, value })
  const emit = () => listeners.forEach((listener) => listener(structuredClone(snapshot)))
  window.__emit = (title) => {
    if (title) conversations[0].title = title
    emit()
  }
  window.__startupMode = new URLSearchParams(location.search).get('startup')
  const pendingSnapshots = []
  window.__failStartup = () => {
    for (const pending of pendingSnapshots.splice(0))
      pending.resolve({ ok: false, error: '模拟迟到的读取失败' })
  }
  window.__completeStartup = () => {
    for (const pending of pendingSnapshots.splice(0))
      pending.resolve({ ok: true, value: pending.snapshot })
  }
  window.__approval = () => {
    const run = conversations[0].runs[0]
    run.state = 'running'
    snapshot.proactive = {
      active: true,
      phase: 'waiting_user',
      taskId: run.id,
      question: {
        kind: 'approval',
        task_id: run.id,
        question_id: 'approval-fixture',
        question: '是否允许本次文件操作？',
        details: '{"operation":"write_text"}',
        options: ['允许本次', '拒绝本次'],
      },
    }
    emit()
  }
  const methods = {
    answerProactiveQuestion: (input) => {
      window.__approvalAnswer = input
      snapshot.proactive = { active: false, phase: 'completed' }
      conversations[0].runs[0].state = 'completed'
      emit()
      return ok()
    },
    snapshot: () => {
      if (['late-failure', 'late-success'].includes(window.__startupMode))
        return new Promise((resolve) =>
          pendingSnapshots.push({ resolve, snapshot: structuredClone(snapshot) }),
        )
      if (window.__startupMode === 'failure')
        return Promise.resolve({ ok: false, error: '模拟工作区读取失败' })
      return ok(structuredClone(snapshot))
    },
    onSnapshot: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onOpenTask: () => () => {},
    conversationDetail: (id) =>
      ok({ ...conversations.find((entry) => entry.id === id), history: {} }),
    createConversation: () => {
      const id = crypto.randomUUID()
      conversations.unshift({
        id,
        title: '新任务',
        archived: false,
        draft: '',
        scrollTop: 0,
        createdAt: now,
        updatedAt: now,
        messages: [],
        runs: [],
      })
      emit()
      return ok(id)
    },
    updateConversation: ({ id, ...patch }) => {
      Object.assign(
        conversations.find((entry) => entry.id === id),
        patch,
      )
      emit()
      return ok()
    },
    sendConversation: (input) => {
      const owner = conversations.find((entry) => entry.id === input.conversationId)
      const runId = crypto.randomUUID()
      owner.messages.push({
        id: input.messageId,
        text: input.text,
        at: new Date().toISOString(),
        runId,
        delivery: 'queued',
      })
      owner.runs.push({
        id: runId,
        policy: { mode: 'cloud', cloudFallback: true },
        state: 'queued',
        createdAt: now,
      })
      owner.title = input.text.slice(0, 30)
      owner.draft = ''
      snapshot.conversations.queue.push(runId)
      emit()
      return ok({ conversationId: owner.id, runId, delivery: 'queued' })
    },
    updatePreferences: (input) => {
      Object.assign(snapshot.settings, input)
      window.__lastPreferences = input
      emit()
      return ok(snapshot.settings)
    },
    startModelDebug: () => ok('fixture-debug'),
    getModelDebug: () =>
      ok({
        id: 'fixture-debug',
        target: 'local',
        model: 'fixture',
        state: 'completed',
        text: '连接正常',
        elapsedMs: 42,
        firstTextMs: 40,
        inputBytes: 25,
        outputBytes: 12,
      }),
    previewTaskRoute: () => ok({ route: 'cloud', source: 'model', elapsedMs: 120, raw: '1' }),
    modelDiagnostics: () =>
      ok([
        {
          id: '1',
          at: Date.now(),
          model: 'DeepSeek Flash',
          source: 'cloud',
          event: 'completed',
          elapsedMs: 1100,
        },
      ]),
    protectCredentials: () => ok(),
    onMemorySaved: () => () => {},
    browseMemories: () =>
      ok({
        mode: 'all',
        items: [
          {
            id: crypto.randomUUID(),
            category: 'ordinary',
            key: '浏览器使用偏好',
            text: '默认使用 Edge 浏览器。',
            kind: 'preference',
            source: '用户明确要求',
            verified: true,
            expiresAt: null,
            tags: ['偏好'],
            summary: '浏览器偏好',
          },
        ],
        total: 1,
        offset: 0,
        limit: 25,
        private_memory: { enabled: true, available: true, records: 0 },
      }),
    taskHistory: () =>
      ok({
        entries: [],
        usage: { requests: 3, tokenUnits: 2000, estimatedCostYuan: 0.01, unpricedRequests: 0 },
      }),
  }
  window.coloop = new Proxy(methods, { get: (target, key) => target[key] ?? (() => ok()) })
  let island = {
    revision: 1,
    mode: 'question',
    title: '整理课程资料',
    detail: '有问题等待你的选择',
    taskId: crypto.randomUUID(),
    questionId: crypto.randomUUID(),
    content: '你希望按章节整理，还是按考试重点整理？',
    choices: ['按章节整理', '按考试重点整理'],
    attention: true,
    expanded: false,
    model: 'DeepSeek Flash · 云端',
  }
  const updateIsland = (patch) => {
    island = { ...island, ...patch, revision: island.revision + 1 }
    islandListeners.forEach((listener) => listener(island))
    return ok()
  }
  window.coloopControl = new Proxy(
    {
      snapshot: () => ok(island),
      onSnapshot: (listener) => {
        islandListeners.add(listener)
        return () => islandListeners.delete(listener)
      },
      setRevealed: () => ok(),
      setExpanded: (expanded) => updateIsland({ expanded }),
      dock: () => updateIsland({ dockEdge: 'right', dockCollapsed: true }),
      drag: () => ok(),
    },
    { get: (target, key) => target[key] ?? (() => ok()) },
  )
})
try {
  await page.goto(`http://127.0.0.1:${port}`)
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('button')).toHaveCount(4)
  await expect(page.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  const navigation = await page.locator('.workspace-navigation').boundingBox()
  expect(navigation.width).toBe(96)
  await page.screenshot({ path: join(output, 'home.png') })
  for (const answer of ['允许本次', '拒绝本次']) {
    await page.evaluate(() => window.__approval())
    await expect(page.getByText('需要你批准操作', { exact: true })).toBeVisible()
    await page.getByText('查看本次操作', { exact: true }).click()
    await page.screenshot({ path: join(output, `approval-${answer}.png`) })
    await page.getByRole('button', { name: answer, exact: true }).click()
    await expect(page.getByText('需要你批准操作', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => window.__approvalAnswer.answer)).toBe(answer)
  }

  const composer = page.getByRole('textbox', { name: '任务消息', exact: true })
  await expect(page.getByText('Enter 发送 · Shift+Enter 换行', { exact: true })).toBeVisible()
  await composer.fill('第一行')
  const shortHeight = (await composer.boundingBox()).height
  await composer.press('Shift+Enter')
  await expect(composer).toHaveValue('第一行\n')
  await composer.fill(Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
  await expect.poll(async () => (await composer.boundingBox()).height).toBeGreaterThan(shortHeight)
  await composer.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
  await expect
    .poll(() => composer.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  const cappedHeight = (await composer.boundingBox()).height
  expect(cappedHeight).toBeLessThan(400)
  await composer.fill('恢复单行')
  await expect.poll(async () => (await composer.boundingBox()).height).toBe(shortHeight)
  const wrappingDraft = await composer.evaluate((element) => {
    const style = getComputedStyle(element)
    const context = document.createElement('canvas').getContext('2d')
    context.font = style.font
    const textWidth =
      element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const charactersPerLine = Math.floor(textWidth / context.measureText('字').width)
    return '字'.repeat(charactersPerLine * 4 + 2)
  })
  await composer.fill(wrappingDraft)
  const originalWrappedHeight = (await composer.boundingBox()).height
  expect(originalWrappedHeight).toBeLessThan(180)
  await page.setViewportSize({ width: 1060, height: 720 })
  await expect
    .poll(async () => (await composer.boundingBox()).height)
    .not.toBe(originalWrappedHeight)
  expect((await composer.boundingBox()).height).toBeLessThan(180)
  await expect(composer).toHaveValue(wrappingDraft)
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect.poll(async () => (await composer.boundingBox()).height).toBe(originalWrappedHeight)
  await expect(composer).toHaveValue(wrappingDraft)
  await composer.fill('请补充第三章的例题')
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /分析项目代码.*已完成/ }).click()
  await page.getByRole('button', { name: /整理课程资料.*已完成/ }).click()
  await expect(composer).toHaveValue('请补充第三章的例题')
  await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  expect(
    await page.evaluate(
      async () => (await window.coloop.snapshot()).value.conversations.queue.length,
    ),
  ).toBe(0)
  await page.evaluate(() => {
    window.__send = window.coloop.sendConversation
    window.coloop.sendConversation = async () => ({ ok: false, error: '模拟受理失败' })
  })
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('模拟受理失败')
  await expect(composer).toHaveValue('请补充第三章的例题')
  await page.evaluate(() => {
    window.coloop.sendConversation = window.__send
  })
  await page.getByRole('button', { name: '新任务', exact: true }).click()
  await composer.fill('整理下一份文档')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.conversation-banner')).toContainText('等待执行')
  await page.getByRole('button', { name: '配置', exact: true }).click()
  await page.screenshot({ path: join(output, 'configuration.png') })
  await page.getByRole('button', { name: /模型运行与调试/ }).click()
  await expect(page.getByLabel('不限额', { exact: false })).toBeChecked()
  expect(
    await page
      .locator('.routing-option')
      .first()
      .evaluate((element) => getComputedStyle(element).flexDirection),
  ).toBe('row')
  expect(
    await page
      .getByLabel('不限额', { exact: false })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(16)
  await expect(page.getByText('DSH 原生自动压缩与续跑')).toBeVisible()
  await expect(page.getByText(/上下文 1,048,576 tokens/)).toBeVisible()
  await page.getByLabel('自定义限额', { exact: false }).check()
  await page.getByLabel('本地执行', { exact: false }).check()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  expect(await page.evaluate(() => window.__lastPreferences.executionMode)).toBe('local')
  expect(await page.evaluate(() => window.__lastPreferences.modelLimitMode)).toBe('custom')
  await page.getByLabel('不限额', { exact: false }).check()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  expect(await page.evaluate(() => window.__lastPreferences.modelLimitMode)).toBe('unlimited')
  await page.screenshot({ path: join(output, 'model-overview.png') })
  await page.getByRole('button', { name: '测试回复', exact: true }).first().click()
  await page.getByRole('button', { name: '开始测试', exact: true }).click()
  await expect(page.locator('.debug-result')).toContainText('连接正常')
  await page.screenshot({ path: join(output, 'model-reply.png') })
  await page.getByRole('button', { name: '返回模型运行与调试', exact: true }).click()
  await page.getByRole('button', { name: '预览任务分配', exact: true }).click()
  await page.getByLabel('输入任务').fill('打开 QQ 邮箱')
  await page.getByRole('button', { name: '分析分配', exact: true }).click()
  await expect(page.locator('.debug-result')).toContainText('云端执行')
  await page.getByRole('button', { name: '返回配置', exact: true }).click()
  await page.getByRole('button', { name: /灵动岛与提醒/ }).click()
  await expect(page.getByLabel('有问题或选项等待处理时，突出提醒')).toBeChecked()
  await page.getByLabel('启用灵动岛', { exact: true }).uncheck()
  await page.getByLabel('紧凑提示中预览任务与问题内容', { exact: true }).uncheck()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  expect(await page.evaluate(() => window.__lastPreferences)).toMatchObject({
    islandEnabled: false,
    islandDetailedNotifications: false,
    islandAttention: true,
  })
  await page.screenshot({ path: join(output, 'island-settings.png') })
  await page.getByRole('button', { name: '记录', exact: true }).click()
  await expect(page.locator('table')).toContainText('整理课程资料')
  await page.screenshot({ path: join(output, 'records.png') })
  await page.getByRole('button', { name: '记忆', exact: true }).click()
  await expect(page.getByText('浏览器使用偏好', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'memory.png') })
  await page.setViewportSize({ width: 1060, height: 720 })
  await page.getByRole('button', { name: '首页', exact: true }).click()
  const menu = page.getByRole('button', { name: '打开任务列表', exact: true })
  const taskList = page.getByRole('complementary', { name: '任务聊天列表', exact: true })
  await expect(menu).toBeVisible()
  await expect(taskList).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await menu.click()
  await expect(taskList).toBeVisible()
  const drawerFocusables = taskList.locator('button:enabled, input:enabled')
  await drawerFocusables.last().focus()
  await page.keyboard.press('Tab')
  await expect(drawerFocusables.first()).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(drawerFocusables.last()).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(output, 'drawer-open.png') })
  await page.keyboard.press('Escape')
  await expect(taskList).toBeHidden()
  await expect(menu).toBeFocused()
  await menu.click()
  await page.getByRole('button', { name: '关闭任务列表', exact: true }).click()
  await expect(taskList).toBeHidden()
  await expect(menu).toBeFocused()
  await menu.click()
  await page.locator('.conversation-backdrop').click({ position: { x: 700, y: 350 } })
  await expect(taskList).toBeHidden()
  await expect(menu).toBeFocused()
  await menu.click()
  const search = taskList.getByRole('textbox', { name: '搜索任务', exact: true })
  await search.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  await expect(taskList).toBeVisible()
  await expect(search).toBeFocused()
  await search.fill('   ')
  await expect(taskList.locator('.conversation-item')).toHaveCount(4)
  await search.fill('  TYPESCRIPT  ')
  await expect(taskList.locator('.conversation-item')).toHaveCount(1)
  await expect(taskList.getByRole('button', { name: /Review TypeScript UI/ })).toBeVisible()
  await expect(taskList.getByText('没有匹配的任务', { exact: true })).toHaveCount(0)
  await search.fill('没有任何匹配-fixture')
  await expect(taskList.locator('.conversation-item')).toHaveCount(0)
  await expect(taskList.getByText('没有匹配的任务', { exact: true })).toBeVisible()
  await taskList.getByRole('button', { name: '清除搜索', exact: true }).click()
  await expect(search).toHaveValue('')
  await expect(taskList.locator('.conversation-item')).toHaveCount(4)
  await taskList.getByRole('button', { name: /Review TypeScript UI/ }).click()
  await expect(taskList).toBeHidden()
  await expect(
    page.getByRole('heading', { name: 'Review TypeScript UI', exact: true }),
  ).toBeVisible()
  await expect(menu).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(output, 'external-task.png') })
  await menu.click()
  await taskList.getByRole('button', { name: '新任务', exact: true }).click()
  await expect(taskList).toBeHidden()
  await expect(page.getByRole('heading', { name: '新任务', exact: true })).toBeVisible()
  await expect(composer).toBeFocused()
  await menu.click()
  await taskList.getByRole('button', { name: /整理课程资料.*已完成/ }).click()
  await expect(taskList).toBeHidden()
  await expect(page.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(output, 'home-narrow.png') })

  const recovery = await browser.newPage()
  recovery.on('pageerror', (error) => errors.push(error.message))
  await recovery.goto(`http://127.0.0.1:${port}/?startup=failure`)
  await expect(recovery.getByRole('alert')).toContainText('模拟工作区读取失败')
  await expect(recovery.getByRole('button', { name: '重新读取工作区', exact: true })).toBeVisible()
  await recovery.screenshot({ path: join(output, 'startup-failure.png') })
  await recovery.evaluate(() => {
    window.__startupMode = 'success'
  })
  await recovery.getByRole('button', { name: '重新读取工作区', exact: true }).click()
  await expect(recovery.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  await recovery.goto(`http://127.0.0.1:${port}/?startup=failure`)
  await expect(recovery.getByRole('alert')).toContainText('模拟工作区读取失败')
  await recovery.evaluate(() => window.__emit())
  await expect(recovery.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  await recovery.goto(`http://127.0.0.1:${port}/?startup=late-failure`)
  await expect(recovery.getByText('正在读取工作区…', { exact: true })).toBeVisible()
  await recovery.evaluate(() => window.__emit())
  await expect(recovery.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  await recovery.evaluate(async () => {
    window.__failStartup()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expect(recovery.getByRole('heading', { name: '整理课程资料', exact: true })).toBeVisible()
  await expect(recovery.getByRole('heading', { name: '工作区暂不可用', exact: true })).toHaveCount(
    0,
  )
  await recovery.goto(`http://127.0.0.1:${port}/?startup=late-success`)
  await expect(recovery.getByText('正在读取工作区…', { exact: true })).toBeVisible()
  await recovery.evaluate(() => window.__emit('推送的新任务标题'))
  await expect(
    recovery.getByRole('heading', { name: '推送的新任务标题', exact: true }),
  ).toBeVisible()
  await recovery.evaluate(async () => {
    window.__completeStartup()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await expect(
    recovery.getByRole('heading', { name: '推送的新任务标题', exact: true }),
  ).toBeVisible()
  await recovery.close()
  const island = await browser.newPage()
  island.on('pageerror', (error) => errors.push(error.message))
  await island.setViewportSize({ width: 480, height: 344 })
  await island.goto(`http://127.0.0.1:${port}/?surface=control`)
  await island.locator('main').hover()
  await expect(island.getByRole('button', { name: '按章节整理', exact: true })).toBeHidden()
  await island.getByRole('button', { name: '展开任务详情', exact: true }).click()
  await expect(island.getByRole('button', { name: '按章节整理', exact: true })).toBeVisible()
  await island.screenshot({ path: join(output, 'island-question.png') })
  expect(errors).toEqual([])
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope:
          'Vite development UI with synthetic API; no application build, user data or live model calls',
        errors,
        checks: [
          'Composer grows for multiline input and stays height-bounded',
          'Existing wrapped drafts resize at 1440, 1060 and 1440 without text changes',
          'Shift+Enter inserts a newline and composition does not send',
          'Narrow task drawer closes with Escape, backdrop or close button and restores focus',
          'Tab and Shift+Tab wrap focus within the open task drawer',
          'Escape during IME composition keeps the task drawer open',
          'Task views and the drawer avoid horizontal overflow at 1060 by 720',
          'Search trims input and matches external task goals without case sensitivity',
          'Empty search can be cleared',
          'External task selection closes the drawer and retains navigation',
          'Creating a task from an external task focuses the new composer',
          'Workspace startup failure supports retry and snapshot-push recovery',
          'Late startup failure preserves the successfully loaded workspace',
          'Late startup success preserves the newer pushed snapshot',
        ],
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await browser.close()
  await server.close()
  await rm(profile, { recursive: true, force: true })
}
