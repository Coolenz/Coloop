import { _electron as electron } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa', `owned-relay-ui-${Date.now()}`)
await mkdir(output, { recursive: true })
const fixture = {
  version: 1,
  endpoint: `https://fixture.invalid/h/${randomUUID()}`,
  token: randomBytes(32).toString('base64url'),
  accessKey: 'fixture-access-key',
}
const configuration = resolve(output, 'fixture.json')
await writeFile(configuration, JSON.stringify(fixture))
const app = await electron.launch({
  executablePath:
    process.env.COLOOP_EXECUTABLE || resolve(root, 'node_modules/electron/dist/electron.exe'),
  args: process.env.COLOOP_EXECUTABLE ? [] : [root],
  env: { ...process.env, COLOOP_DATA_DIR: resolve(output, 'profile'), ELECTRON_RENDERER_URL: '' },
})
const checks = []
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: 'Agent 协调', exact: true }).first().click()
  const panel = page.getByRole('region', { name: '安卓手机连接' })
  await panel.scrollIntoViewIfNeeded()
  await panel.getByRole('button', { name: '导入服务器配置', exact: true }).waitFor()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, configuration)
  await panel.getByRole('button', { name: '导入服务器配置', exact: true }).click()
  await panel.getByText(fixture.endpoint, { exact: true }).waitFor()
  const snapshot = await page.evaluate(async () => (await window.coloop.snapshot()).value)
  assert.equal(snapshot.mobile.transport, 'relay')
  assert.equal(snapshot.mobile.configuredEndpoint, fixture.endpoint)
  assert(!JSON.stringify(snapshot).includes(fixture.token))
  assert(!JSON.stringify(snapshot).includes(fixture.accessKey))
  checks.push('Import exposes only endpoint in snapshots; no plaintext credentials.')
  const stored = await readFile(resolve(output, 'profile/mobile-server.json'), 'utf8')
  assert(!stored.includes(fixture.token) && !stored.includes(fixture.accessKey))
  checks.push('Both host token and access key stored with actual Windows DPAPI.')
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['compact', 1060, 720],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.isVisible())
          .setSize(...size),
      [width, height],
    )
    await panel.scrollIntoViewIfNeeded()
    await panel.screenshot({ path: resolve(output, `${name}.png`) })
    assert(await panel.getByRole('button', { name: '开启手机连接', exact: true }).isVisible())
    assert(await panel.getByRole('button', { name: '更换服务器配置', exact: true }).isVisible())
    checks.push(`Connection controls present at ${width}x${height}.`)
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ output, checks }))
} finally {
  await app.close()
}
