import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `memory-window-${Date.now()}`)
await mkdir(output, { recursive: true })
const executablePath = process.env.COLOOP_EXECUTABLE || undefined
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : [root],
  cwd: root,
  env: { ...process.env, COLOOP_DATA_DIR: resolve(output, 'profile'), ELECTRON_RENDERER_URL: '' },
})
const checks = []
let failure
try {
  const main = await app.firstWindow()
  const errors = []
  main.on('pageerror', (error) => errors.push(error.message))
  await main.waitForSelector('.workspace-content')
  for (let iteration = 0; iteration < 3; iteration++) {
    await main.getByRole('button', { name: '记忆', exact: true }).click()
    await main.getByText('记忆管理中 · 截图与 OCR 已暂停', { exact: true }).waitFor()
    const state = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => !w.webContents.getURL().includes('surface='),
      )
      return {
        visible: window.isVisible(),
        crashed: window.webContents.isCrashed(),
        protected: window.isContentProtected(),
      }
    })
    assert.deepEqual(
      state,
      { visible: true, crashed: false, protected: false },
      'Memory directory must stay visible to desktop capture',
    )
    assert.equal(
      (await main.evaluate(() => window.coloop.snapshot())).value.credentials.protected,
      true,
    )
    assert.equal((await main.evaluate(() => window.coloop.captureScreen())).ok, false)
    await main.getByRole('button', { name: '工作台', exact: true }).first().click()
  }
  checks.push(
    'Repeated Memory navigation keeps the main window visible without enabling OS capture exclusion',
  )
  checks.push('Memory navigation still blocks Coloop observation')
  await main.getByRole('button', { name: '记忆', exact: true }).click()
  await main.getByText('记忆管理中 · 截图与 OCR 已暂停', { exact: true }).waitFor()
  const opened = await main.evaluate(() => window.coloop.openPrivateMemoryEditor())
  assert.equal(opened.ok, true, opened.error)
  const editor = app.windows().find((w) => w.url().includes('surface=credential-entry'))
  assert.ok(editor)
  await editor.getByLabel('密码', { exact: true }).waitFor()
  await editor.screenshot({
    path: resolve(output, 'private-entry-empty.png'),
    animations: 'disabled',
  })
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      entry: w.webContents.getURL().includes('surface=credential-entry'),
      protected: w.isContentProtected(),
      sandbox: w.webContents.getLastWebPreferences().sandbox,
      isolation: w.webContents.getLastWebPreferences().contextIsolation,
    })),
  )
  assert.equal(windows.find((w) => w.entry).protected, false)
  assert.equal(windows.find((w) => !w.entry).protected, false)
  assert.equal(windows.find((w) => w.entry).sandbox, true)
  assert.equal(windows.find((w) => w.entry).isolation, true)
  assert.equal(await editor.evaluate(() => typeof window.coloop), 'undefined')
  assert.equal(await main.evaluate(() => typeof window.coloop.createPrivateMemory), 'undefined')
  const legacyCreate = await main.evaluate(() =>
    window.coloop.createCredential({
      origin: 'https://example.invalid',
      username: 'synthetic',
      password: 'synthetic',
    }),
  )
  assert.equal(legacyCreate.ok, false)
  checks.push('Main and isolated credential entry windows remain visible to desktop capture')
  const secret = 'synthetic-private-window-regression'
  await editor.getByLabel('允许的网站', { exact: true }).fill('https://example.invalid')
  await editor.getByLabel('账号', { exact: true }).fill('synthetic-user')
  await editor.getByLabel('密码', { exact: true }).fill(secret)
  assert.equal(await main.getByLabel('密码', { exact: true }).count(), 0)
  assert.equal((await main.locator('body').innerText()).includes(secret), false)
  await editor.getByRole('button', { name: '保存私密记忆', exact: true }).click()
  await editor.getByRole('alert').waitFor()
  assert.equal(await editor.getByLabel('密码', { exact: true }).inputValue(), '')
  checks.push(
    'Private fields stay out of the main page; failed offline saves clear the submitted fields',
  )
  const closed = await main.evaluate(() => window.coloop.closePrivateMemoryEditor())
  assert.equal(closed.ok, true)
  await main.getByText('私密填写窗口已打开', { exact: true }).waitFor({ state: 'hidden' })
  await main.getByRole('button', { name: '工作台', exact: true }).first().click()
  assert.equal(
    (await main.evaluate(() => window.coloop.snapshot())).value.credentials.protected,
    false,
  )
  assert.deepEqual(errors, [])
  checks.push('Closing the private editor and leaving Memory releases observation protection')
  for (const [width, height] of [
    [1440, 940],
    [1060, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    )
    await main.getByRole('button', { name: '记忆', exact: true }).click()
    await main.getByRole('heading', { name: '记忆', exact: true }).waitFor()
    assert.equal(
      await main.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    )
    await main.screenshot({ path: resolve(output, `memory-${width}.png`), animations: 'disabled' })
  }
  checks.push('Memory renders without horizontal overflow at both supported desktop sizes')
} catch (error) {
  failure = error
} finally {
  await app.close()
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify({ checks, passed: !failure, error: failure?.stack }, null, 2),
  )
  console.log(JSON.stringify({ output, checks, error: failure?.message }))
}
if (failure) throw failure
