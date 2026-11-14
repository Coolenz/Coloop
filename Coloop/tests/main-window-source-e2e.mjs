import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', `main-window-source-${Date.now()}`)
await mkdir(output, { recursive: true })
await build({
  entryPoints: [join(root, 'src/main/infrastructure/main-window.ts')],
  outfile: join(output, 'window.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
await writeFile(
  join(output, 'preload.cjs'),
  `const {contextBridge, ipcRenderer} = require('electron'); contextBridge.exposeInMainWorld('markReady', () => ipcRenderer.send('app:renderer-ready'));`,
)
await writeFile(
  join(output, 'fixture.cjs'),
  `
const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(join(output, 'profile'))} + (process.env.COLOOP_TEST_NATIVE_HIDDEN ? '-hidden' : ''));
const { createMainWindow, showMainWindow, hideMainWindow } = require('./window.cjs');
global.openWindow = async (showOnReady, deferContent = false) => {
  global.main = createMainWindow({preload: ${JSON.stringify(join(output, 'preload.cjs'))}, icon: ${JSON.stringify(join(root, 'resources/icon.png'))}, showOnReady});
  global.showCalls = 0;
  const nativeShow = main.show.bind(main);
  main.show = () => { global.showCalls++; nativeShow(); };
  if (process.env.COLOOP_TEST_NATIVE_HIDDEN) main.webContents.ipc.once('app:renderer-ready', () => {
    require('fs').writeFileSync(${JSON.stringify(join(output, 'hidden-launcher.json'))}, JSON.stringify({visible:main.isVisible(),showCalls:global.showCalls}));
    app.quit();
  });
  global.nativeReady = false;
  main.once('ready-to-show', () => { global.nativeReady = true });
  global.repaintCount = 0;
  const invalidate = main.webContents.invalidate.bind(main.webContents);
  main.webContents.invalidate = () => { global.repaintCount++; invalidate(); };
  const html = '<html><body style="margin:0;background:#eef2f6;color:#253749;font:24px sans-serif;padding:48px"><script>window.framesSeen=0;function frame(){window.framesSeen++;requestAnimationFrame(frame)}requestAnimationFrame(frame); window.renderFixture=()=>{document.body.insertAdjacentHTML("afterbegin", "<h1>Coloop 启动验证</h1><p>窗口已完成首帧绘制</p>");requestAnimationFrame(()=>requestAnimationFrame(()=>window.markReady()))};' + (deferContent ? '' : 'window.renderFixture();') + '</script></body></html>';
  await main.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
};
global.reveal = () => showMainWindow(global.main);
global.hide = () => hideMainWindow(global.main);
app.on('window-all-closed', () => {});
app.whenReady().then(() => global.openWindow(true, !process.env.COLOOP_TEST_NATIVE_HIDDEN));
`,
)
let app
try {
  app = await electron.launch({ args: [join(output, 'fixture.cjs')], cwd: root })
  let page = await app.firstWindow()
  await page.waitForFunction(() => typeof window.renderFixture === 'function')
  await expect.poll(() => app.evaluate(() => global.nativeReady)).toBe(true)
  expect(await app.evaluate(() => global.main.isVisible())).toBe(false)
  await app.evaluate(() => global.reveal())
  expect(await app.evaluate(() => global.main.isVisible())).toBe(false)
  await page.evaluate(() => window.renderFixture())
  await expect(page.getByText('窗口已完成首帧绘制')).toBeVisible()
  await expect.poll(() => app.evaluate(() => global.main.isVisible())).toBe(true)
  expect(await app.evaluate(() => global.main.webContents.backgroundThrottling)).toBe(false)
  await page.waitForFunction(() => window.framesSeen > 2)
  await page.screenshot({ path: join(output, 'cold-start.png') })
  await app.evaluate(() => global.main.minimize())
  await expect.poll(() => app.evaluate(() => global.main.isMinimized())).toBe(true)
  const previousPaints = await app.evaluate(() => global.repaintCount)
  await app.evaluate(() => global.reveal())
  await expect
    .poll(() => app.evaluate(() => global.main.isVisible() && !global.main.isMinimized()))
    .toBe(true)
  expect(await app.evaluate(() => global.repaintCount)).toBeGreaterThan(previousPaints)
  await page.screenshot({ path: join(output, 'restored.png') })
  await app.evaluate(async () => {
    global.main.destroy()
    await global.openWindow(false, true)
    global.reveal()
    global.hide()
  })
  page = app.windows().find((window) => !window.isClosed())
  await page.evaluate(() => window.renderFixture())
  await page.waitForFunction(() => window.framesSeen > 2)
  expect(await app.evaluate(() => global.main.isVisible())).toBe(false)
  await app.evaluate(() => global.reveal())
  await expect.poll(() => app.evaluate(() => global.main.isVisible())).toBe(true)
  await expect(page.getByText('窗口已完成首帧绘制')).toBeVisible()
  await page.screenshot({ path: join(output, 'background-reveal.png') })
  await promisify(execFile)(
    join(root, 'node_modules/electron/dist/electron.exe'),
    [join(output, 'fixture.cjs')],
    { env: { ...process.env, COLOOP_TEST_NATIVE_HIDDEN: '1' }, windowsHide: true, timeout: 30000 },
  )
  const hiddenLauncher = JSON.parse(await readFile(join(output, 'hidden-launcher.json'), 'utf8'))
  expect(hiddenLauncher.visible).toBe(true)
  expect(hiddenLauncher.showCalls).toBe(2)
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope:
          'isolated source harness using production window factory; no full application build or user task execution',
        checks: [
          'SW_HIDE launcher first-show suppression recovered without another user action',
          'empty native first frame stays hidden',
          'early show request is retained until UI paint acknowledgment',
          'cold start without taskbar click',
          'unthrottled initial renderer',
          'minimized window restore and repaint',
          'background startup stays hidden until explicitly shown',
        ],
        limitation:
          'Covers a deterministic empty first frame and early reveal race; the user-reported intermittent Windows compositor condition is not independently reproduced.',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app?.close()
  for (const name of ['profile', 'profile-hidden', 'window.cjs', 'fixture.cjs', 'preload.cjs'])
    await rm(join(output, name), { recursive: true, force: true })
}
