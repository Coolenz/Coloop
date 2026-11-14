import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { build } from 'esbuild'
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', 'island-source-' + Date.now())
await mkdir(output, { recursive: true })
const server = await createServer({
  root: join(root, 'src/renderer'),
  configFile: false,
  plugins: [react()],
  cacheDir: join(root, '.cache/vite-island-source'),
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
})
await server.listen()
const address = `http://127.0.0.1:${server.httpServer.address().port}`
await Promise.all([
  build({
    entryPoints: [join(root, 'src/main/infrastructure/control-indicator.ts')],
    outfile: join(output, 'indicator.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    entryPoints: [join(root, 'src/preload/control.ts')],
    outfile: join(output, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
])
await writeFile(
  join(output, 'fixture.cjs'),
  `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(join(output, 'profile'))});
const { ControlIndicatorWindow } = require('./indicator.cjs');
global.ControlIndicatorWindow = ControlIndicatorWindow;
global.options = { preloadPath: ${JSON.stringify(join(output, 'preload.cjs'))}, rendererPath: ${JSON.stringify(join(root, 'src/renderer/index.html'))}, developmentUrl: ${JSON.stringify(address)}, placementFile: ${JSON.stringify(join(output, 'placement.json'))}, onStop: async()=>{}, onOpenMain: id=>{global.opened=id}, onRememberTarget:async()=>{}, onRestoreTarget:async()=>{}, onStartTask:async()=>{}, onAnswerQuestion:async value=>{global.answer=value}, onPauseObservation:async()=>{}, onDismissResult:async()=>{await global.indicator.update({mode:'idle',title:'Coloop'})} };
app.whenReady().then(async()=>{ global.indicator=new ControlIndicatorWindow(global.options); await global.indicator.update({mode:'idle',title:'Coloop',detail:'准备开始'}); });
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>global.indicator?.dispose());`,
)
let app
try {
  app = await electron.launch({ args: [join(output, 'fixture.cjs')], cwd: root })
  const page = await app.firstWindow()
  const main = page.locator('main')
  await main.waitFor()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const bounds = () => app.evaluate(() => global.indicator.getBounds())
  const leave = async () => {
    await main.dispatchEvent('mouseout', { relatedTarget: null })
    await page.waitForTimeout(450)
  }
  await app.evaluate(() => global.indicator.placement({ operation: 'undock' }))
  await leave()
  const before = await bounds()
  await expect(page.getByText('收边', { exact: true })).toHaveCount(0)
  await page.getByLabel('拖动灵动岛', { exact: true }).hover()
  await page.waitForTimeout(300)
  expect(Math.abs((await bounds()).width - before.width)).toBeLessThanOrEqual(1)
  const geometry = () =>
    page.evaluate(() => {
      const shell = document.querySelector('main')
      const header = document.querySelector('.island-header')
      const rect = shell.getBoundingClientRect()
      const style = getComputedStyle(shell)
      return {
        shell: rect.toJSON(),
        header: header.getBoundingClientRect().toJSON(),
        title: document.querySelector('.control-copy').getBoundingClientRect().toJSON(),
        radius: style.borderRadius,
        shadow: style.boxShadow,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        backdropFilter: style.backdropFilter,
        top: rect.top,
        bottom: innerHeight - rect.bottom,
      }
    })
  const resting = await geometry()
  expect(resting.shadow.split(/,(?![^()]*\))/).every((shadow) => shadow.includes('inset'))).toBe(
    true,
  )
  expect(resting.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(resting.backdropFilter).toContain('blur(28px)')
  expect(resting.backgroundImage).toContain('linear-gradient')
  expect(Math.abs(resting.top - resting.bottom)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: join(output, 'compact.png') })
  await page.locator('.control-copy').hover()
  await page.waitForTimeout(300)
  expect(await geometry()).toEqual(resting)
  await page.screenshot({ path: join(output, 'compact-hover.png') })
  const grip = await page.getByLabel('拖动灵动岛', { exact: true }).boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + 60, grip.y + 50, { steps: 4 })
  expect(Math.abs((await bounds()).width - before.width)).toBeLessThanOrEqual(1)
  expect(Math.abs((await bounds()).height - before.height)).toBeLessThanOrEqual(1)
  await page.mouse.up()
  expect((await bounds()).x === before.x && (await bounds()).y === before.y).toBe(false)
  // Native Windows input covers hit testing that Playwright's injected events bypass.
  const nativePointer = async (selector, dx = 0, dy = 0) => {
    const box = await page.locator(selector).boundingBox()
    const origin = await bounds()
    const point = await app.evaluate(({ screen }, p) => screen.dipToScreenPoint(p), {
      x: Math.round(origin.x + box.x + box.width / 2),
      y: Math.round(origin.y + box.y + box.height / 2),
    })
    await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class IslandMouse { [DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr c); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e); }';
[IslandMouse]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
[IslandMouse]::SetCursorPos(${point.x}, ${point.y}) | Out-Null
Start-Sleep -Milliseconds 120
[IslandMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 100
[IslandMouse]::SetCursorPos(${point.x + dx}, ${point.y + dy}) | Out-Null
Start-Sleep -Milliseconds 150
[IslandMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
`,
      ],
      { windowsHide: true },
    )
  }
  await leave()
  const nativeBefore = await bounds()
  await nativePointer('.control-copy', 120, 80)
  await expect(main).toHaveAttribute('data-expanded', 'false')
  expect((await bounds()).x === nativeBefore.x && (await bounds()).y === nativeBefore.y).toBe(false)
  await nativePointer('.control-copy')
  await expect(main).toHaveAttribute('data-expanded', 'true')
  await expect.poll(async () => Math.abs((await bounds()).width - 480)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(output, 'native-click-details.png') })
  await leave()
  await app.evaluate(() => global.indicator.placement({ operation: 'dock', edge: 'left' }))
  await leave()
  const tabBefore = await bounds()
  await nativePointer('.island-edge-tab', 180, 90)
  expect((await bounds()).x).toBeGreaterThan(tabBefore.x + 50)
  await expect(main).toHaveAttribute('data-expanded', 'false')
  const area = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
  for (const edge of ['top', 'left', 'right']) {
    await app.evaluate(() => global.indicator.placement({ operation: 'undock' }))
    await leave()
    const initial = await bounds()
    const start = { x: initial.x + 25, y: initial.y + 25 }
    const target = {
      x:
        edge === 'top'
          ? start.x
          : edge === 'left'
            ? area.x + 65
            : area.x + area.width - initial.width - 15,
      y: edge === 'top' ? area.y + 65 : area.y + 180,
    }
    await page.evaluate(
      async ({ start, target }) => {
        await window.coloopControl.drag('start', start)
        await window.coloopControl.drag('move', target)
      },
      { start, target },
    )
    await expect(main).toHaveAttribute('data-snap', edge)
    await expect(page.getByRole('status')).toContainText('松开即可收至')
    expect(Math.abs((await bounds()).width - initial.width)).toBeLessThanOrEqual(1)
    expect(Math.abs((await bounds()).height - initial.height)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: join(output, edge + '-snap.png') })
    await page.evaluate((target) => window.coloopControl.drag('end', target), target)
    await leave()
    await expect(main).toHaveAttribute('data-dock', edge)
    await expect(main).toHaveAttribute('data-dock-collapsed', 'true')
  }
  for (const edge of ['top', 'left', 'right']) {
    await app.evaluate((_, edge) => global.indicator.placement({ operation: 'dock', edge }), edge)
    await leave()
    await expect(main).toHaveAttribute('data-dock-collapsed', 'true')
    await page.getByLabel('展开 Coloop 浮窗').click()
    await expect(main).toHaveAttribute('data-dock-collapsed', 'false')
    await expect(main).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByRole('textbox', { name: '让 Coloop 做什么', exact: true })).toBeVisible()
    await expect.poll(async () => Math.abs((await bounds()).width - 480)).toBeLessThanOrEqual(1)
    await leave()
    await expect(main).toHaveAttribute('data-dock-collapsed', 'true')
    await page.getByLabel('展开 Coloop 浮窗').click()
    await page.getByRole('button', { name: '收起详情', exact: true }).click()
  }
  await app.evaluate(async () =>
    global.indicator.update({ mode: 'failed', taskId: 'failed-task', title: '任务未完成' }),
  )
  await leave()
  await page.getByLabel('展开 Coloop 浮窗').click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(main).toHaveAttribute('data-mode', 'idle')
  await leave()
  await page.getByLabel('展开 Coloop 浮窗').click()
  await page.waitForTimeout(600)
  await expect(page.getByRole('button', { name: '关闭灵动岛', exact: true })).toBeVisible()
  await app.evaluate(async () =>
    global.indicator.update({
      mode: 'question',
      taskId: 'fixture-task',
      questionId: 'fixture-question',
      title: '整理课程资料',
      detail: '需要你选择整理方式',
      content: '希望按章节整理，还是按考试重点整理？',
      choices: ['按章节整理', '按考试重点整理'],
      attention: true,
      model: 'DeepSeek Flash · 云端',
    }),
  )
  await main.dispatchEvent('mouseover')
  await expect(main).toHaveAttribute('data-attention', 'true')
  await page.getByRole('button', { name: '展开任务详情', exact: true }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(output, 'question.png') })
  await page.getByRole('button', { name: '回到聊天 →', exact: true }).click()
  expect(await app.evaluate(() => global.opened)).toBe('fixture-task')
  await page.getByRole('button', { name: '按章节整理', exact: true }).click()
  expect(await app.evaluate(() => global.answer.answer)).toBe('按章节整理')
  await app.evaluate(async () =>
    global.indicator.update({
      mode: 'question',
      taskId: 'fixture-task',
      questionId: 'next-question',
      title: '下一项问题',
      content: '请补充要求',
      choices: [],
      attention: false,
    }),
  )
  for (const answer of ['允许本次', '拒绝本次']) {
    await app.evaluate(async () => global.indicator.update({ mode: 'question', taskId: 'approval-task', questionId: 'approval-question', questionKind: 'approval', title: '审批任务', detail: '等待你批准操作', content: '是否允许本次文件操作？', choices: ['允许本次', '拒绝本次'], attention: true }))
    await main.dispatchEvent('mouseover')
    const expandApproval = page.getByRole('button', { name: '展开任务详情', exact: true })
    if (await expandApproval.count()) await expandApproval.click()
    await page.getByRole('button', { name: answer, exact: true }).waitFor()
    await expect(page.getByRole('button', { name: '填写回答', exact: true })).toHaveCount(0)
    await expect.poll(async () => (await bounds()).height).toBeGreaterThan(200)
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(output, `approval-${answer}.png`) })
    await page.getByRole('button', { name: answer, exact: true }).click()
    expect(await app.evaluate(() => global.answer.answer)).toBe(answer)
  }
  await app.evaluate(async () => global.indicator.update({ mode: 'question', taskId: 'fixture-task', questionId: 'next-question', questionKind: 'business', content: '请补充要求', choices: [], attention: false }))
  const expandBusiness = page.getByRole('button', { name: '展开任务详情', exact: true })
  if (await expandBusiness.count()) await expandBusiness.click()
  await expect(main).toHaveAttribute('data-attention', 'false')
  await page.getByRole('button', { name: '填写回答', exact: true }).click()
  await page.getByLabel('你的回答').fill('草稿继续保留')
  await leave()
  await expect(main).toHaveAttribute('data-dock-collapsed', 'false')
  await expect(page.getByLabel('你的回答')).toHaveValue('草稿继续保留')
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'idle' })
    global.indicator.placement({ operation: 'dock', edge: 'left' })
  })
  await leave()
  await app.evaluate(async () => {
    global.indicator.dispose()
    global.indicator = new global.ControlIndicatorWindow(global.options)
    await global.indicator.update({ mode: 'idle' })
  })
  expect(await app.evaluate(() => global.indicator.placement({ operation: 'inspect' }).edge)).toBe(
    'left',
  )
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        scope:
          'source-only Electron harness with Vite development renderer; isolated profile; no application build or model calls',
        displays: await app.evaluate(({ screen }) =>
          screen
            .getAllDisplays()
            .map(({ id, workArea, scaleFactor }) => ({ id, workArea, scaleFactor })),
        ),
        checks: [
          'three edges',
          'compact hover',
          'explicit details',
          'grip size',
          'question attention',
          'answer',
          'open chat binding',
          'placement reload',
        ],
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ ok: true, output }))
} finally {
  await app?.evaluate(() => global.indicator?.dispose()).catch(() => {})
  await app?.close()
  await server.close()
  for (const name of ['profile', 'indicator.cjs', 'preload.cjs', 'fixture.cjs', 'placement.json'])
    await rm(join(output, name), { recursive: true, force: true })
}
