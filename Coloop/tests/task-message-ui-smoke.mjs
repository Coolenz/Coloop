import { _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `task-message-ui-${Date.now()}`)
await mkdir(output, { recursive: true })
const temporaryRoot = resolve(root, '.cache/tmp/task-message-ui')
await mkdir(temporaryRoot, { recursive: true })
const profile = await mkdtemp(join(temporaryRoot, 'run-'))
const env = { ...workspaceCacheEnvironment(root), COLOOP_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: process.env.COLOOP_EXECUTABLE,
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  env,
})
try {
  await app.firstWindow()
  let main
  for (let n = 0; n < 100 && !main; n++) {
    main = app
      .windows()
      .find((page) => page.url().includes('index.html') && !page.url().includes('surface=control'))
    if (!main) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(main)
  await main.waitForFunction(() => !!window.coloop)
  const snapshot = await main.evaluate(async () => (await window.coloop.snapshot()).value)
  snapshot.proactive = { connected: true, active: true, phase: 'planning', taskId: 'queue-fixture' }
  // Fixture IPC isolates renderer submission from cloud, RK and user data.
  await app.evaluate(({ ipcMain }, snapshot) => {
    global.messageCalls = []
    global.rejectMessage = false
    ipcMain.removeHandler('app:get')
    ipcMain.handle('app:get', () => ({ ok: true, value: snapshot }))
    ipcMain.removeHandler('task:dispatch')
    ipcMain.handle('task:dispatch', (_event, request) => {
      global.messageCalls.push(request)
      return global.rejectMessage
        ? { ok: false, error: '测试发送失败' }
        : { ok: true, value: { id: 'queue-fixture' } }
    })
  }, snapshot)
  await main.reload()
  const input = main.getByRole('textbox', { name: '任务内容', exact: true })
  await input.fill('运行中补充第一条')
  await main.getByRole('button', { name: '发送消息', exact: true }).click()
  await main.getByText('已加入当前任务消息队列', { exact: true }).waitFor()
  assert.equal(await input.inputValue(), '')
  await input.fill('运行中补充第二条')
  await input.press('Control+Enter')
  await main.waitForFunction(() => document.querySelector('#task-prompt').value === '')
  assert.deepEqual(await app.evaluate(() => global.messageCalls.map((call) => call.prompt)), [
    '运行中补充第一条',
    '运行中补充第二条',
  ])
  await app.evaluate(() => {
    global.rejectMessage = true
  })
  await input.fill('失败保留草稿')
  await main.getByRole('button', { name: '发送消息', exact: true }).click()
  await main.getByText('测试发送失败', { exact: true }).waitFor()
  assert.equal(await input.inputValue(), '失败保留草稿')
  await main.screenshot({ path: join(output, 'running-composer.png') })
  await app.evaluate(() => {
    global.rejectMessage = false
  })
  await main.getByRole('button', { name: '电脑操作', exact: true }).click()
  await main.getByRole('textbox', { name: '补充当前任务', exact: true }).fill('电脑操作页补充')
  await main.getByRole('button', { name: '发送消息', exact: true }).click()
  await main.getByText('已加入当前任务消息队列', { exact: true }).waitFor()
  assert.equal((await app.evaluate(() => global.messageCalls)).at(-1).prompt, '电脑操作页补充')
  await main.screenshot({ path: join(output, 'running-desktop.png') })
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope: 'installed renderer with fixture IPC; no cloud or HID',
        checks: [
          'running button submission',
          'running keyboard submission',
          'FIFO dispatch',
          'failure preserves draft',
        ],
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app.close()
  assert.ok(profile.startsWith(temporaryRoot + '\\'))
  await rm(profile, { recursive: true, force: true })
}
