import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', 'island-hover-' + Date.now())
await mkdir(output, { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/main/infrastructure/control-indicator.ts')],
  outfile: resolve(output, 'indicator.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
await writeFile(
  resolve(output, 'harness.cjs'),
  `const {app}=require('electron');const{ControlIndicatorWindow}=require('./indicator.cjs');app.whenReady().then(async()=>{global.indicator=new ControlIndicatorWindow({preloadPath:${JSON.stringify(resolve(root, 'out/preload/control.cjs'))},rendererPath:${JSON.stringify(resolve(root, 'out/renderer/index.html'))},onStop:async()=>{},onOpenMain:()=>{},onRememberTarget:async()=>{},onRestoreTarget:async()=>{},onStartTask:async()=>{}});await indicator.update({mode:'idle'});});app.on('before-quit',()=>global.indicator?.dispose());`,
)
const app = await electron.launch({ args: [resolve(output, 'harness.cjs')], cwd: root })
try {
  const page = await app.firstWindow(),
    main = page.locator('main'),
    command = page.getByRole('textbox', { name: '让 Coloop 做什么', exact: true })
  const bounds = () => app.evaluate(() => global.indicator.getBounds())
  await main.waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setPosition(100, 350))
  assert.ok(Math.abs((await bounds()).width - 280) <= 1)
  assert.equal(await command.isVisible(), false)
  await page.screenshot({ path: resolve(output, 'collapsed.png') })
  await main.dispatchEvent('mouseover')
  await command.waitFor()
  await page.waitForTimeout(260)
  assert.ok(Math.abs((await bounds()).width - 480) <= 1)
  assert.equal((await bounds()).height, 128)
  const beforeDrag = await bounds()
  const handle = await page.getByLabel('拖动灵动岛', { exact: true }).boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2 + 40, {
    steps: 8,
  })
  await page.mouse.up()
  await page.waitForTimeout(260)
  const afterDrag = await bounds()
  assert.ok(
    afterDrag.x !== beforeDrag.x || afterDrag.y !== beforeDrag.y,
    'pointer drag moves real window',
  )
  await page.screenshot({ path: resolve(output, 'expanded.png') })
  await main.dispatchEvent('mouseout')
  await page.waitForTimeout(650)
  assert.ok(Math.abs((await bounds()).width - 280) <= 1)
  await main.dispatchEvent('mouseover')
  await command.click()
  await command.fill('保留输入草稿')
  await main.dispatchEvent('mouseout')
  await page.waitForTimeout(650)
  assert.ok(Math.abs((await bounds()).width - 480) <= 1, 'focused input stays expanded')
  await page.getByRole('button', { name: '收起灵动岛' }).click()
  await page.waitForTimeout(260)
  assert.ok(Math.abs((await bounds()).width - 280) <= 1)
  await main.dispatchEvent('mouseover')
  assert.equal(await command.inputValue(), '保留输入草稿')
  await page.getByRole('button', { name: '收起灵动岛' }).click()
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    BrowserWindow.getAllWindows()[0].setPosition(area.x + 150, area.y + 200)
  })
  await page.waitForTimeout(260)
  const moved = await bounds()
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'idle', detail: 'Background update' })
  })
  assert.deepEqual(await bounds(), moved, 'status refresh preserves dragged position')
  await main.dispatchEvent('mouseover')
  await page.waitForTimeout(260)
  const opened = await bounds()
  assert.equal(opened.y, moved.y)
  assert.ok(
    Math.abs(opened.x + opened.width / 2 - (moved.x + moved.width / 2)) <= 1,
    'hover expands around dragged anchor',
  )
  await main.dispatchEvent('mouseout')
  await page.waitForTimeout(650)
  // Reverse an in-flight resize while a routine snapshot arrives.
  const sampling = app.evaluate(async () => {
    const samples = []
    const frame = () => new Promise((resolve) => setTimeout(resolve, 20))
    for (let i = 0; i < 24; i++) {
      await frame()
      samples.push(global.indicator.getBounds().width)
    }
    return samples
  })
  await page.evaluate(() => window.coloopControl.setRevealed(true, false))
  await page.waitForTimeout(60)
  await page.evaluate(() => window.coloopControl.setRevealed(false, false))
  await page.waitForTimeout(25)
  await page.evaluate(() => window.coloopControl.setRevealed(true, false))
  await app.evaluate(() => global.indicator.update({ mode: 'idle', detail: 'Motion refresh' }))
  const trajectory = await sampling
  assert.ok(
    trajectory.some((width) => width > 281 && width < 479),
    'real intermediate sizes',
  )
  assert.ok(Math.abs(trajectory.at(-1) - 480) <= 1, 'reversal reaches expanded target')
  await main.dispatchEvent('mouseover')
  await main.dispatchEvent('mouseout')
  await page.waitForTimeout(650)
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'controlling', startedAt: new Date().toISOString() })
  })
  assert.ok(Math.abs((await bounds()).width - 320) <= 1)
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible(), true)
  await page.screenshot({ path: resolve(output, 'active-collapsed.png') })
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'idle' })
  })
  await main.dispatchEvent('mouseover')
  await page.waitForTimeout(260)
  await page.getByRole('button', { name: '关闭灵动岛', exact: true }).click()
  await expect.poll(() => app.evaluate(() => global.indicator.visible)).toBe(false)
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'idle', detail: 'refresh' })
  })
  assert.equal(
    await app.evaluate(() => global.indicator.visible),
    false,
    'refresh respects dismissal',
  )
  await app.evaluate(async () => {
    await global.indicator.preview()
  })
  assert.equal(await app.evaluate(() => global.indicator.visible), true, 'tray can reopen')
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        scope:
          'real Electron hover bounds, focus pin, manual collapse, moved-anchor preservation; no cloud/RK/HID',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app.evaluate(() => global.indicator?.dispose()).catch(() => {})
  await app.close()
}
