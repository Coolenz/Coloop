// Packaged app smoke with isolated settings: no cloud, RK connection or HID.
import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', 'proactive-package-' + Date.now())
await mkdir(output, { recursive: true })
const env = { ...process.env, COLOOP_DATA_DIR: resolve(output, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: resolve(root, 'release', process.env.COLOOP_PROACTIVE_BUILD ?? 'proactive-cloud-direct-0.13.0-20261103', 'win-unpacked/Coloop.exe'),
  env,
})
try {
  await app.firstWindow()
  let main
  for (let n = 0; n < 100 && !main; n++) {
    main = app.windows().find(page => page.url().includes('index.html') && !page.url().includes('surface=control'))
    if (!main) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(main, 'packaged main window must load')
  await main.waitForLoadState('domcontentloaded')
  await main.waitForFunction(() => !!window.coloop)
  const state = await main.evaluate(async () => window.coloop.snapshot())
  assert.equal(state.ok, true)
  assert.equal(state.value.proactive.active, false)
  assert.equal(state.value.proactive.connected, false)
  const has = await app.evaluate(async ({ BrowserWindow }) => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    for (let n = 0; n < 50; n++) {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('surface=control'))
      if (win?.isVisible()) return { visible: true, focusable: win.isFocusable(), bounds: win.getBounds() }
      await wait(100)
    }
    return { visible: false }
  })
  assert.equal(has.visible, true)
  assert.equal(has.focusable, false)
  await main.screenshot({ path: resolve(output, 'main.png') })
  const island = app.windows().find(page => page.url().includes('surface=control'))
  assert.ok(island)
  await island.locator('main').dispatchEvent('mouseover')
  await island.getByRole('textbox', { name: '让 Coloop 做什么', exact: true }).waitFor()
  assert.equal(await island.getByRole('button', { name: '发送命令', exact: true }).isDisabled(), true)
  await island.screenshot({ path: resolve(output, 'island.png') })
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ ok: true, scope: 'packaged isolated profile; no RK/cloud/HID', island: has, proactive: state.value.proactive }, null, 2))
  console.log(JSON.stringify({ ok: true, output }))
} finally { await app.close() }
