// Renderer-only fixtures. No board, cloud or HID is connected in this visual check.
import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `island-ui-${Date.now()}`)
await mkdir(output, { recursive: true })
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{new BrowserWindow({width:480,height:344,frame:false,webPreferences:{contextIsolation:true}}).loadURL('about:blank')});app.on('window-all-closed',()=>app.quit());`,
)
const app = await electron.launch({ args: [harness], cwd: root })
try {
  const page = await app.firstWindow(),
    errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    let current = {
      mode: 'suggestion',
      revision: 1,
      suggestionId: 's1',
      title: '产品发布计划',
      content:
        '建议先明确目标用户，再安排发布时间、渠道、预算和验收标准。\n\n这个大纲可以作为正文起点。',
    }
    const listeners = []
    window.calls = []
    window.setFixture = (next) => {
      current = { ...next, revision: current.revision + 1 }
      listeners.forEach((fn) => fn(current))
    }
    const ok = async () => ({ ok: true })
    window.coloopControl = {
      snapshot: async () => ({ ok: true, value: current }),
      onSnapshot: (fn) => {
        listeners.push(fn)
        return () => {}
      },
      stop: ok,
      openMain: ok,
      closePreview: ok,
      acceptSuggestion: async (...args) => {
        window.calls.push(['execute', ...args])
        return { ok: true }
      },
      dismissSuggestion: ok,
      dismissResult: async (taskId, revision) => {
        window.calls.push(['dismiss-result', taskId, revision])
        window.setFixture({ mode: 'idle', detail: '已就绪 · 正在观察当前窗口' })
        return { ok: true }
      },
      answerQuestion: async (value) => {
        window.calls.push(['answer', value])
        return { ok: true }
      },
      beginAnswer: ok,
      setRevealed: ok,
      endAnswer: ok,
      setExpanded: async (expanded) => {
        window.setFixture({ ...current, expanded })
        return { ok: true }
      },
      pauseObservation: ok,
      beginTask: async () => {
        return { ok: true }
      },
      startTask: async (goal) => {
        window.calls.push(['task', goal])
        if (window.rejectTask) return { ok: false, error: '测试：连接不可用，请重试' }
        return { ok: true }
      },
    }
  })
  await page.goto(pathToFileURL(resolve(root, 'out/renderer/index.html')).href + '?surface=control')
  await page.locator('main').dispatchEvent('mouseover')
  await page.getByText('产品发布计划', { exact: true }).waitFor()
  await page.screenshot({ path: resolve(output, 'suggestion.png') })
  await page.getByRole('button', { name: 'Execute', exact: true }).click()
  assert.equal((await page.evaluate(() => window.calls))[0][0], 'execute')
  await page.evaluate(() =>
    window.setFixture({
      mode: 'question',
      taskId: 't1',
      questionId: 'q1',
      content: '这是软件产品还是硬件产品？',
      choices: ['软件', '硬件'],
    }),
  )
  await page.getByRole('button', { name: 'Write an answer' }).click()
  await page.getByLabel('Your answer', { exact: true }).fill('硬件产品，面向开发者')
  await page.screenshot({ path: resolve(output, 'question.png') })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  assert.equal((await page.evaluate(() => window.calls)).at(-1)[1].answer, '硬件产品，面向开发者')
  await page.evaluate(() => window.setFixture({ mode: 'idle', detail: 'Ready to help' }))
  await page.locator('main').dispatchEvent('mouseover')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 128))
  const command = page.getByRole('textbox', { name: '让 Coloop 做什么', exact: true })
  const send = page.getByRole('button', { name: '发送命令', exact: true })
  assert.equal(await command.isVisible(), true)
  assert.equal(await send.isDisabled(), true)
  await command.fill('读取标题并生成大纲')
  await page.screenshot({ path: resolve(output, 'new-task.png') })
  const geometry = await command.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    height: innerHeight,
  }))
  assert.ok(geometry.bottom < geometry.height - 10, 'compact input is fully visible')
  await command.press('Enter')
  await page.waitForFunction(() => window.calls.at(-1)?.[0] === 'task')
  assert.equal((await page.evaluate(() => window.calls)).at(-1)[1], '读取标题并生成大纲')
  await page.waitForFunction(() => document.querySelector('#island-goal').value === '')
  await command.fill('中文选词草稿')
  const before = (await page.evaluate(() => window.calls)).length
  await command.dispatchEvent('compositionstart')
  await command.press('Enter')
  assert.equal((await page.evaluate(() => window.calls)).length, before, 'IME Enter never submits')
  await command.dispatchEvent('compositionend')
  await page.evaluate(() => window.setFixture({ mode: 'idle', detail: '屏幕状态刷新' }))
  assert.equal(await command.inputValue(), '中文选词草稿', 'snapshot preserves draft')
  await page.evaluate(() => {
    window.rejectTask = true
  })
  await send.click()
  await page.getByText('测试：连接不可用，请重试', { exact: true }).waitFor()
  assert.equal(await command.inputValue(), '中文选词草稿', 'failure preserves draft')
  await page.evaluate(() => {
    window.rejectTask = false
    window.setFixture({ mode: 'controlling' })
  })
  assert.equal(await command.isDisabled(), true)
  assert.equal(await send.isDisabled(), true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 344))
  for (const mode of ['completed', 'blocked', 'failed']) {
    await page.evaluate((mode) => window.setFixture({ mode, content: '前一个任务已经结束' }), mode)
    await command.fill('下一项任务')
    await send.click()
    await page.waitForFunction(() => document.querySelector('#island-goal').value === '')
    assert.equal((await page.evaluate(() => window.calls)).at(-1)[1], '下一项任务')
    await page.evaluate(
      (mode) =>
        window.setFixture({
          mode,
          taskId: 'finished-task',
          detail: '任务执行未完成',
          content: '前一个任务已经结束',
        }),
      mode,
    )
    await page.screenshot({ path: resolve(output, `${mode}-dismiss.png`) })
    await page
      .getByRole('button', { name: mode === 'completed' ? '完成' : '取消', exact: true })
      .click()
    await page.locator('main[data-mode="idle"]').waitFor()
    assert.deepEqual((await page.evaluate(() => window.calls)).at(-1).slice(0, 2), [
      'dismiss-result',
      'finished-task',
    ])
    assert.equal(await page.getByText('任务执行未完成', { exact: true }).count(), 0)
    await page.screenshot({ path: resolve(output, `${mode}-idle.png`) })
  }
  assert.deepEqual(errors, [])
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      { scope: 'renderer-only, fixture IPC, no board/cloud/HID', passed: 12, errors },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: 12, output }))
} finally {
  await app.close()
}
