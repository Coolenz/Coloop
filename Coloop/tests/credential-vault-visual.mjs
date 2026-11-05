import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `credential-visual-${Date.now()}`)
await mkdir(output, { recursive: true })
const executablePath = process.env.COLOOP_EXECUTABLE || undefined
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : [root],
  cwd: root,
  env: {
    ...process.env,
    COLOOP_DATA_DIR: resolve(output, 'profile'),
    ELECTRON_RENDERER_URL: '',
  },
})
const checks = []
try {
  const page = await app.firstWindow()
  await page.waitForSelector('.workspace-content')
  await page.getByRole('button', { name: '私密凭据', exact: true }).click()
  await page.getByText('截图与 OCR 已暂停', { exact: true }).waitFor()
  for (const [width, height] of [
    [1440, 940],
    [1060, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        const main = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().includes('surface='),
        )
        main.setSize(width, height)
      },
      { width, height },
    )
    await page.waitForTimeout(80)
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.credentials-content, .sidebar')].map((e) => ({
        class: e.className,
        overflow: e.scrollWidth > e.clientWidth + 1,
      })),
    )
    assert.equal(
      overflow.some((item) => item.overflow),
      false,
    )
    assert.equal(
      await page.getByRole('button', { name: '保存到 RK', exact: true }).isDisabled(),
      true,
    )
    await page.screenshot({
      animations: 'disabled',
      path: resolve(output, `credentials-${width}x${height}.png`),
    })
    checks.push({ width, height, noHorizontalOverflow: true, disconnectedSaveDisabled: true })
  }
  await page.getByRole('button', { name: '运行历史', exact: true }).click()
  assert.equal(
    (await page.evaluate(() => window.coloop.snapshot())).value.credentials.protected,
    false,
  )
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, checks }, null, 2))
} finally {
  await app.close()
}
console.log(JSON.stringify({ output, passed: true }))
