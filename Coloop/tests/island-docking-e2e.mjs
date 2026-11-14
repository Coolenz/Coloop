import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', 'island-docking-' + Date.now())
await mkdir(output, { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/main/infrastructure/control-indicator.ts')],
  outfile: join(output, 'indicator.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
await writeFile(
  join(output, 'harness.cjs'),
  `
const {app}=require('electron');
app.setPath('userData', ${JSON.stringify(join(output, 'profile'))});
const {ControlIndicatorWindow}=require('./indicator.cjs');
app.whenReady().then(async()=>{
 global.indicator=new ControlIndicatorWindow({preloadPath:${JSON.stringify(resolve(root, 'out/preload/control.cjs'))},rendererPath:${JSON.stringify(resolve(root, 'out/renderer/index.html'))},onStop:async()=>{},onOpenMain:()=>{},onRememberTarget:async()=>{},onRestoreTarget:async()=>{},onStartTask:async()=>{}});
 await indicator.update({mode:'idle'});
});app.on('before-quit',()=>global.indicator?.dispose());`,
)
const app = await electron.launch({ args: [join(output, 'harness.cjs')], cwd: root })
try {
  const page = await app.firstWindow()
  const main = page.locator('main')
  await main.waitFor()
  await page.emulateMedia({
    reducedMotion: process.env.COLOOP_TEST_REDUCED_MOTION === '1' ? 'reduce' : 'no-preference',
  })
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  const bounds = () => app.evaluate(() => global.indicator.getBounds())
  const placement = (value) => app.evaluate((_, input) => global.indicator.placement(input), value)
  const leave = async () => {
    await main.dispatchEvent('mouseout', { relatedTarget: null })
    await page.waitForTimeout(450)
  }
  await placement({ operation: 'undock' })
  await leave()
  const before = await bounds()
  const handle = page.getByLabel('拖动灵动岛', { exact: true })
  await handle.dispatchEvent('mouseover')
  await page.waitForTimeout(280)
  assert.deepEqual(await bounds(), before, 'hovering the grip never resizes the window')
  // Pointer capture is exercised by a real mouse press. Host coordinates then
  // drive a deterministic drag to each work-area edge under Windows DPI scaling.
  await handle.click()
  await page.waitForTimeout(280)
  assert.equal((await bounds()).width, before.width, 'clicking the grip preserves size')
  for (const edge of ['top', 'left', 'right']) {
    await placement({ operation: 'undock' })
    await leave()
    const initial = await bounds()
    const x = initial.x + 20,
      y = initial.y + 20
    const target =
      edge === 'top'
        ? { x, y: area.y + 20 }
        : edge === 'left'
          ? { x: area.x + 20, y }
          : { x: area.x + area.width - initial.width + 20, y }
    await page.evaluate(
      async ({ x, y, target }) => {
        await window.coloopControl.drag('start', { x, y })
        await window.coloopControl.drag('move', target)
      },
      { x, y, target },
    )
    assert.ok(
      Math.abs((await bounds()).width - initial.width) <= 1,
      'drag preserves width within Windows DIP rounding',
    )
    assert.ok(
      Math.abs((await bounds()).height - initial.height) <= 1,
      'drag preserves height within Windows DIP rounding',
    )
    await page.evaluate((target) => window.coloopControl.drag('end', target), target)
    await expect.poll(async () => (await placement({ operation: 'inspect' })).edge).toBe(edge)
    await leave()
    await expect(main).toHaveAttribute('data-dock-collapsed', 'true')
    const collapsed = await bounds()
    assert.ok(Math.abs((edge === 'top' ? collapsed.height : collapsed.width) - 32) <= 1)
    await page.screenshot({ path: join(output, edge + '-collapsed.png') })
    await page.getByLabel('展开 Coloop 浮窗').hover()
    await expect(main).toHaveAttribute('data-dock-collapsed', 'false')
    await expect.poll(async () => Math.abs((await bounds()).width - 480)).toBeLessThanOrEqual(1)
    const expanded = await bounds()
    assert.ok(
      Math.abs(
        (edge === 'top' ? expanded.y : edge === 'left' ? expanded.x : expanded.x + expanded.width) -
          (edge === 'top' ? area.y : edge === 'left' ? area.x : area.x + area.width),
      ) <= 1,
    )
    await page.screenshot({ path: join(output, edge + '-expanded.png') })
    await leave()
    await app.evaluate(async () => global.indicator.update({ mode: 'idle', detail: '状态更新' }))
    assert.equal(
      (await placement({ operation: 'inspect' })).collapsed,
      true,
      'refresh retains docking',
    )
  }
  await page.getByLabel('展开 Coloop 浮窗').hover()
  const input = page.getByRole('textbox', { name: '让 Coloop 做什么', exact: true })
  await input.fill('保留草稿')
  await leave()
  assert.equal(
    (await placement({ operation: 'inspect' })).collapsed,
    false,
    'editing pins the dock open',
  )
  await placement({ operation: 'undock' })
  assert.equal((await placement({ operation: 'inspect' })).edge, null)
  assert.equal(await input.inputValue(), '保留草稿')
  await writeFile(
    join(output, 'verification.json'),
    JSON.stringify(
      {
        ok: true,
        checks: [
          'grip hover/click size',
          'drag size',
          'top/left/right snap',
          'hover reveal',
          'leave collapse',
          'status refresh',
          'focused draft',
          'undock',
        ],
        scope: 'real Electron window with isolated profile',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app.evaluate(() => global.indicator?.dispose()).catch(() => {})
  await app.close()
  for (const name of ['profile', 'indicator.cjs', 'harness.cjs'])
    await rm(join(output, name), { recursive: true, force: true })
}
