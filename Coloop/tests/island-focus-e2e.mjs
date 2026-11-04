// Actual Windows foreground/focus regression. No cloud calls or HID input.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `island-focus-${Date.now()}`)
await mkdir(output, { recursive: true })
await build({
  entryPoints: {
    indicator: resolve(root, 'src/main/infrastructure/control-indicator.ts'),
    capture: resolve(root, 'src/main/infrastructure/foreground-observation.ts'),
  },
  outdir: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
})
const title = `Coloop focus lab ${Date.now()}`
const lab = `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.Text='${title}';$f.Width=700;$f.Height=450;$e=New-Object System.Windows.Forms.TextBox;$e.Multiline=$true;$e.Dock='Fill';$e.Text='Focus verification laboratory';$f.Controls.Add($e);$f.Add_Shown({$f.Activate();$e.Focus()});[void]$f.ShowDialog()`
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const {app}=require('electron');const{spawn}=require('node:child_process');const{ControlIndicatorWindow}=require('./indicator.cjs');const{WindowsObservationCapture}=require('./capture.cjs');
app.whenReady().then(async()=>{
const capture=new WindowsObservationCapture({recognize:async()=>{throw Error('No OCR in focus regression')}});global.capture=capture;global.events=[];
const lab=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(Buffer.from(lab, 'utf16le').toString('base64'))}],{windowsHide:true});global.lab=lab;
const indicator=new ControlIndicatorWindow({preloadPath:${JSON.stringify(resolve(root, 'out/preload/control.cjs'))},rendererPath:${JSON.stringify(resolve(root, 'out/renderer/index.html'))},onStop:async()=>{},onOpenMain:()=>{},onRememberTarget:()=>capture.rememberTarget(),onRestoreTarget:()=>capture.restoreTarget(),onStartTask:async goal=>{global.events.push({type:'task',goal,foreground:await capture.metadata()});},onAnswerQuestion:async input=>{global.events.push({type:'answer',input,foreground:await capture.metadata()});}});global.indicator=indicator;
await new Promise(r=>setTimeout(r,1700));await capture.rememberTarget();global.external=(await capture.metadata()).window_id;await indicator.update({mode:'idle'});});
app.on('before-quit',()=>{global.indicator?.dispose();global.capture?.dispose();global.lab?.kill()});`,
)
const app = await electron.launch({ args: [harness], cwd: root })
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setPosition(100, 350))
  const command = page.getByRole('textbox', { name: '让 Coloop 做什么', exact: true })
  await page.locator('main').dispatchEvent('mouseover')
  await command.waitFor()
  const external = await app.evaluate(() => global.external)
  await command.click()
  for (let i = 0; i < 40; i++) {
    if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()))
      break
    await page.waitForTimeout(50)
  }
  await command.fill('焦点回归任务')
  await app.evaluate(async () => {
    await global.indicator.update({ mode: 'idle', detail: 'Screen refreshed' })
  })
  await page.locator('main').dispatchEvent('mouseover')
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocusable()),
    true,
    'background update preserves input focus',
  )
  await command.press('Enter')
  try {
    await page.waitForFunction(() => document.querySelector('#island-goal').value === '', null, {
      timeout: 10000,
    })
  } catch (error) {
    console.log(await page.locator('main').innerText())
    console.log(
      await app.evaluate(async () => ({
        events: global.events,
        external: global.external,
        foreground: await global.capture.metadata(),
      })),
    )
    throw error
  }
  let events = await app.evaluate(() => global.events)
  assert.equal(events.length, 1)
  assert.equal(events[0].foreground.window_id, external, JSON.stringify(events[0]))
  await app.evaluate(async () => {
    await global.indicator.update({
      mode: 'question',
      taskId: 't',
      questionId: 'q',
      content: '请补充产品类型',
    })
  })
  await page.locator('main').dispatchEvent('mouseover')
  await page.getByRole('button', { name: 'Write an answer' }).click()
  await page.getByLabel('Your answer', { exact: true }).fill('硬件产品')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  for (let i = 0; i < 100; i++) {
    if ((await app.evaluate(() => global.events)).length >= 2) break
    await page.waitForTimeout(50)
  }
  events = await app.evaluate(() => global.events)
  assert.equal(events.length, 2)
  assert.equal(events[1].foreground.window_id, external)
  assert.equal(events[1].input.answer, '硬件产品')
  await page.screenshot({ path: resolve(output, 'focus-restored.png') })
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        scope: 'actual Windows foreground, actual indicator IPC, no OCR/cloud/HID',
        passed: 2,
        events,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: 2, output }))
} finally {
  await app
    .evaluate(() => {
      global.lab?.kill()
      global.indicator?.dispose()
      global.capture?.dispose()
    })
    .catch(() => {})
  await app.close()
}
