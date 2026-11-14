import { _electron as electron, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join, sep } from 'node:path'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'
const root = resolve(import.meta.dirname, '..')
const output = join(root, '.qa', `main-window-package-${Date.now()}`)
await mkdir(output, { recursive: true })
const checks = []
for (const mode of ['cold-1', 'cold-2', 'cold-3', 'background', 'early-open']) {
  const profile = join(output, mode)
  const env = { ...workspaceCacheEnvironment(root), COLOOP_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const background = ['background', 'early-open'].includes(mode)
  const launchArgs = process.env.COLOOP_EXECUTABLE ? [] : [root]
  let app
  try {
    app = await electron.launch({
      executablePath: process.env.COLOOP_EXECUTABLE,
      args: [...launchArgs, ...(background ? ['--background'] : [])],
      env,
    })
    const reopen = () =>
      promisify(execFile)(
        process.env.COLOOP_EXECUTABLE || join(root, 'node_modules/electron/dist/electron.exe'),
        launchArgs,
        {
          env,
          windowsHide: true,
          timeout: 30000,
        },
      )
    if (mode === 'early-open') await reopen()
    await expect
      .poll(() =>
        app.windows().some((p) => p.url().includes('index.html') && !p.url().includes('surface=')),
      )
      .toBe(true)
    const page = app
      .windows()
      .find((p) => p.url().includes('index.html') && !p.url().includes('surface='))
    await page.getByRole('navigation', { name: '主导航' }).waitFor()
    const visible = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => !w.webContents.getURL().includes('surface='))
          ?.isVisible(),
      )
    if (mode === 'background') {
      expect(await visible()).toBe(false)
      await reopen()
    }
    await expect.poll(visible).toBe(true)
    await page.screenshot({ path: join(output, mode + '.png') })
    expect(await page.locator('.workspace-app').count()).toBe(1)
    checks.push({ mode, firstOpenVisible: true })
  } finally {
    await app?.close()
    if (!profile.startsWith(output + sep)) throw new Error('Profile escaped test output')
    await rm(profile, { recursive: true, force: true })
  }
}
await writeFile(
  join(output, 'report.json'),
  JSON.stringify(
    {
      ok: true,
      checks,
      scope:
        'Real application with isolated fresh profiles, first-open workspace checks; no RK or model calls',
      limitation:
        'Repeated cold starts and early reopen tested; original intermittent Windows white screen was not independently reproduced.',
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ ok: true, output }))
