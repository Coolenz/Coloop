// Production Electron renderer/preload with isolated IPC fixtures. No cloud/RK/HID.
import { _electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `upper-host-${Date.now()}`)
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  COLOOP_DATA_DIR: resolve(output, 'profile'),
  ELECTRON_RENDERER_URL: '',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  executablePath: process.env.COLOOP_EXECUTABLE || undefined,
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  cwd: root,
  env,
})
const checks = []
try {
  await app.firstWindow()
  let page
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = app
      .windows()
      .find(
        (candidate) =>
          candidate.url().includes('index.html') && !candidate.url().includes('surface=control'),
      )
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(page, 'main application window is required')
  await page.waitForSelector('.workspace-content')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rejected = await page.evaluate(async () => ({
    suggestion: await window.coloop.acceptProactiveSuggestion('expired'),
    answer: await window.coloop.answerProactiveQuestion({
      taskId: 'expired',
      questionId: 'expired',
      answer: 'late',
    }),
    start: await window.coloop.dispatchTask({
      prompt: '隔离验收',
      target: 'cloud',
      source: 'text',
      intent: 'execute',
    }),
  }))
  assert.equal(rejected.suggestion.ok, false)
  assert.equal(rejected.answer.ok, false)
  assert.equal(rejected.start.ok, false)
  checks.push('real main IPC rejects stale suggestion, stale answer and disconnected execution')
  await page.evaluate(() => window.coloop.pauseProactiveObservation(true))
  const paused = await page.evaluate(() => window.coloop.snapshot())
  assert.equal(paused.value.proactive.observationPaused, true)
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const unsubscribe = window.coloop.onSnapshot((state) => {
          if (state.proactive.observationPaused === false) {
            unsubscribe()
            resolve()
          }
        })
        window.coloop.pauseProactiveObservation(false).catch(reject)
      }),
  )
  checks.push('real observation pause is published in main snapshot')

  await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const win = BrowserWindow.getAllWindows().find(
      (item) => !item.webContents.getURL().includes('surface=control'),
    )
    const original = await win.webContents.executeJavaScript('window.coloop.snapshot()')
    const state = structuredClone(original.value)
    state.device = {
      ...state.device,
      status: 'connected',
      qwenReady: false,
      modelPrivacyReady: false,
    }
    state.settings.provider = { ...state.settings.provider, protocol: 'openai', hasKey: true }
    state.proactive = { connected: true, active: false, phase: 'idle', observationPaused: false }
    const send = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) =>
      send(channel, ...(channel === 'app:snapshot' ? [state] : args))
    globalThis.upperHostFixture = { state, calls: [] }
    for (const channel of [
      'task:dispatch',
      'proactive:accept',
      'proactive:dismiss',
      'proactive:answer',
      'proactive:stop',
      'proactive:pause',
    ]) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, value) => {
        globalThis.upperHostFixture.calls.push({ channel, value })
        if (channel === 'proactive:pause') state.proactive.observationPaused = value
        win.webContents.send('app:snapshot', state)
        return { ok: true, value: channel === 'task:dispatch' ? { id: 'qa-task' } : undefined }
      })
    }
    win.webContents.send('app:snapshot', state)
  })
  const project = (value) =>
    app.evaluate(({ BrowserWindow }, patch) => {
      Object.assign(globalThis.upperHostFixture.state.proactive, patch)
      BrowserWindow.getAllWindows()
        .find((item) => !item.webContents.getURL().includes('surface=control'))
        .webContents.send('app:snapshot', globalThis.upperHostFixture.state)
    }, value)
  const calls = () => app.evaluate(() => globalThis.upperHostFixture.calls)
  await page.getByRole('button', { name: '电脑操作', exact: true }).first().click()
  await page.getByRole('heading', { name: '电脑操作', exact: true }).waitFor()
  await page
    .getByRole('textbox', { name: '让电脑完成什么', exact: true })
    .fill('保留原标题，在末尾追加一行“上位机适配验收”。')
  await page.getByLabel('允许本次任务在目标应用发送键鼠输入', { exact: true }).check()
  assert.equal(
    await page.getByRole('button', { name: '开始电脑操作', exact: true }).isEnabled(),
    true,
  )
  await page.screenshot({ path: resolve(output, 'desktop.png') })
  await page.getByRole('button', { name: '开始电脑操作', exact: true }).click()
  assert(
    (await calls()).some(
      (call) => call.channel === 'task:dispatch' && call.value.intent === 'execute',
    ),
  )
  checks.push('computer form dispatches explicit TARS task with local model offline')

  await project({
    phase: 'suggestion',
    suggestion: {
      suggestion_id: 's1',
      observation_id: 'o1',
      title: '补充文档大纲',
      text: '已有标题，可以补充三个要点。',
    },
  })
  await page.getByRole('button', { name: '执行这条建议', exact: true }).click()
  await page.getByRole('button', { name: '忽略建议', exact: true }).click()
  assert((await calls()).some((call) => call.channel === 'proactive:accept' && call.value === 's1'))
  assert(
    (await calls()).some((call) => call.channel === 'proactive:dismiss' && call.value === 's1'),
  )
  checks.push('main window accepts and dismisses bound suggestion')

  await project({
    active: true,
    phase: 'waiting_user',
    taskId: 't1',
    suggestion: undefined,
    question: {
      question_id: 'q1',
      question: '请确认大纲的主题',
      options: ['硬件产品', '软件产品'],
    },
  })
  await page.getByRole('button', { name: '硬件产品', exact: true }).click()
  await page.getByRole('button', { name: '回答并继续', exact: true }).click()
  assert(
    (await calls()).some(
      (call) =>
        call.channel === 'proactive:answer' &&
        call.value.taskId === 't1' &&
        call.value.questionId === 'q1' &&
        call.value.answer === '硬件产品',
    ),
  )
  await project({ question: { question_id: 'q2', question: '第二个问题' } })
  assert.equal(await page.getByLabel('第二个问题', { exact: true }).inputValue(), '')
  await page.getByRole('button', { name: '停止电脑操作', exact: true }).click()
  assert((await calls()).some((call) => call.channel === 'proactive:stop'))
  checks.push(
    'answer keeps task/question identity, new question resets draft, stop reaches preload',
  )

  await project({
    active: false,
    phase: 'completed',
    question: undefined,
    summary: '已经过实际结果核验。',
    memorySaved: undefined,
  })
  await page.getByText('任务已完成，RK 正在后台整理记忆', { exact: true }).waitFor()
  await project({ memorySaved: true })
  await page.getByText('任务记忆已保存，可在「记忆」中查看', { exact: true }).waitFor()
  await project({ memorySaved: false })
  await page.getByText('任务已完成，记忆保存未完成', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('heading', { name: '已通过实际结果核验', exact: true }).count(),
    1,
  )
  checks.push('async memory states preserve verified foreground completion')

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => !item.webContents.getURL().includes('surface=control'))
      .setSize(1060, 720),
  )
  await page.screenshot({ path: resolve(output, 'desktop-minimum.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.getByRole('button', { name: '工作台', exact: true }).first().click()
  await page.getByRole('heading', { name: '已通过实际结果核验', exact: true }).waitFor()
  await project({ active: true, phase: 'observing' })
  assert.match(await page.locator('.statusbar').textContent(), /正在读取当前窗口/)
  await page.getByLabel('任务内容').fill('新任务')
  assert.equal(await page.getByLabel('运行任务', { exact: true }).isDisabled(), true)
  await page.screenshot({ path: resolve(output, 'workspace-active.png') })
  checks.push('workspace mirrors computer state, blocks concurrent input and fits minimum window')
  assert.deepEqual(errors, [])
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope:
          'production renderer/preload, real negative IPC checks then explicit simulated IPC states, no cloud/RK/HID',
        checks,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output, checks }, null, 2))
} finally {
  await app.close()
}
