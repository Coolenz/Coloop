// Packaged app smoke with isolated settings: no cloud, RK connection or HID.
import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', 'proactive-package-' + Date.now())
await mkdir(output, { recursive: true })
const env = { ...process.env, COLOOP_DATA_DIR: resolve(output, 'profile') }
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
const app = await electron.launch({
  executablePath:
    process.env.COLOOP_EXECUTABLE ||
    (process.env.COLOOP_PROACTIVE_BUILD
      ? resolve(root, 'release', process.env.COLOOP_PROACTIVE_BUILD, 'win-unpacked/Coloop.exe')
      : resolve(process.env.LOCALAPPDATA, 'Programs/Coloop/Coloop.exe')),
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
  assert.ok(main, 'packaged main window must load')
  await main.waitForLoadState('domcontentloaded')
  await main.waitForFunction(() => !!window.coloop)
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
  await main.getByRole('button', { name: '电脑操作', exact: true }).click()
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
  await island.locator('main').dispatchEvent('mouseover')
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
  await island.locator('main[data-mode="failed"]').waitFor()
  await island.locator('main').dispatchEvent('mouseover')
  await island.getByRole('button', { name: '取消', exact: true }).click()
  await island.locator('main[data-mode="idle"]').waitFor()
  const recovered = await main.evaluate(() => window.coloop.snapshot())
  assert.equal(recovered.value.proactive.phase, 'idle')
  assert.equal(recovered.value.proactive.taskId, undefined)
  assert.equal(recovered.value.proactive.error, undefined)
  await island.locator('main').dispatchEvent('mouseover')
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
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope: 'packaged isolated profile; no RK/cloud/HID',
        island: has,
        proactive: state.value.proactive,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app.close()
}
