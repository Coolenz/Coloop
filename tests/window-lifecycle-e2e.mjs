import { _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `window-lifecycle-${Date.now()}`)
const profile = resolve(output, 'profile')
await mkdir(output, { recursive: true })
const executablePath = process.env.COLOOP_EXECUTABLE || undefined
const args = executablePath ? [] : [root]
const env = { ...process.env, COLOOP_DATA_DIR: profile, ELECTRON_RENDERER_URL: '' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath, args, cwd: root, env })
const checks = []
let failure
async function reopen() {
  const executable = await app.evaluate(() => process.execPath)
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Second instance did not exit'))
    }, 15000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      code === 0 ? accept() : reject(new Error(`Second instance exit: ${code}`))
    })
  })
  await assertVisible()
}
async function assertVisible() {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const state = await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().includes('surface='),
      )
      return main && { visible: main.isVisible(), minimized: main.isMinimized() }
    })
    if (state?.visible && !state.minimized) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Main window remains hidden or minimized after reopening')
}
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), id)
  assert.equal(
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), id),
    false,
  )
  await reopen()
  await page.waitForSelector('.workspace-content')
  checks.push('Closing to tray then launching again restores the existing window')
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), id)
  await reopen()
  checks.push('Launching again restores a minimized window')
  const gone = app.evaluate(
    ({ BrowserWindow }, id) =>
      new Promise((resolve) => {
        const wc = BrowserWindow.fromId(id).webContents
        wc.once('render-process-gone', (_event, details) => resolve(details.reason))
        wc.forcefullyCrashRenderer()
      }),
    id,
  )
  await gone
  const reloaded = app.evaluate(
    ({ BrowserWindow }, id) =>
      new Promise((resolve) => {
        BrowserWindow.fromId(id).webContents.once('did-finish-load', () => resolve(true))
      }),
    id,
  )
  await reopen()
  await reloaded
  // Playwright keeps its original Page marked as crashed after a native reload.
  // Verify the replacement renderer through Electron's WebContents instead.
  const recovered = await app.evaluate(async ({ BrowserWindow }, id) => {
    const contents = BrowserWindow.fromId(id).webContents
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await contents.executeJavaScript('!!document.querySelector(".workspace-content")'))
        return contents.executeJavaScript('window.coloop.snapshot()')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Replacement renderer did not mount the workspace')
  }, id)
  assert.equal(recovered.ok, true)
  const diagnostic = JSON.parse(await readFile(resolve(profile, 'window-diagnostic.json'), 'utf8'))
  assert.equal(diagnostic.event, 'render-process-gone')
  assert.equal(typeof diagnostic.reason, 'string')
  checks.push('Reopening after renderer loss reloads the page and records the exit reason')
} catch (error) {
  failure = error
} finally {
  await app.close()
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify({ checks, error: failure?.stack, passed: !failure }, null, 2),
  )
  console.log(JSON.stringify({ output, checks, error: failure?.message }))
}
if (failure) throw failure
