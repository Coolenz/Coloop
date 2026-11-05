// Explicit live paid-cloud, RK USB and production small-window acceptance.
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { _electron } from '@playwright/test'
if (!process.argv.includes('--hid-lab') || !process.env.RK_BOARD_PASSWORD)
  throw Error('EXPLICIT_HID_LAB_AND_PASSWORD_REQUIRED')
const output = process.env.COLOOP_TARS_OUTPUT
if (!output) throw Error('UNIQUE_OUTPUT_REQUIRED')
await mkdir(output, { recursive: false })
const bundle = 'D:/Coloop/.qa/tars-live-' + Date.now() + '.mjs'
await build({
  stdin: {
    contents: [
      "export {BoardGateway,importRkBoard} from './src/main/infrastructure/board.ts'",
      "export {WindowsObservationCapture,ForegroundObservationService} from './src/main/infrastructure/foreground-observation.ts'",
      "export {OcrEngine} from './src/main/infrastructure/ocr.ts'",
      "export {ClipboardLeaseService} from './src/main/infrastructure/clipboard-lease.ts'",
      "export {ControlIndicatorWindow} from './src/main/infrastructure/control-indicator.ts'",
      "export {RkTarsBridge} from './src/main/infrastructure/rk-tars-bridge.ts'",
      "export {TarsAgentService} from './src/main/services/tars-agent.ts'",
    ].join('\n'),
    resolveDir: 'D:/Coloop',
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const env = { ...process.env, COLOOP_TARS_LIB: bundle }
delete env.ELECTRON_RUN_AS_NODE
const live = await _electron.launch({
  args: ['D:/Coloop/tests/tars-live-worker.mjs'],
  cwd: 'D:/Coloop',
  env,
  timeout: 30000,
})
let stdout = ''
live.process().stdout.on('data', (data) => {
  stdout += data
})
live.process().stderr.on('data', () => {})
const exited = new Promise((resolve) => live.process().on('exit', resolve))
try {
  const page = await live.waitForEvent('window', { timeout: 150000 })
  await page.waitForLoadState('domcontentloaded')
  await page.locator('main').dispatchEvent('mouseover')
  const execute = page.getByRole('button', { name: 'Execute', exact: true })
  await execute.waitFor({ state: 'visible', timeout: 15000 })
  await page.screenshot({ path: output + '/island-recommendation.png' })
  await execute.click()
  await writeFile(
    output + '/island-click.json',
    JSON.stringify({
      clicked: true,
      source: 'production renderer/preload/IPC -> TarsAgentService -> official AgentTARS.run',
      at: Date.now(),
    }),
  )
  await Promise.race([
    page
      .getByText('Task completed', { exact: true })
      .waitFor({ state: 'attached', timeout: 300000 }),
    exited.then((code) => {
      throw Error('EXITED_BEFORE_RESULT_DISPLAY:' + code)
    }),
  ])
  await page.locator('main').dispatchEvent('mouseover')
  await page.screenshot({ path: output + '/island-completed.png' })
  await writeFile(
    output + '/island-result-readback.json',
    JSON.stringify({
      displayed: true,
      detail: await page.locator('.control-detail').textContent(),
    }),
  )
  const code = await exited
  await writeFile(output + '/driver.stdout.txt', stdout)
  if (code !== 0) throw Error('TARS_LIVE_FAILED:' + code)
} catch (error) {
  await writeFile(output + '/driver-failure.json', JSON.stringify({ error: error.message }))
  await live.close().catch(() => {})
  throw error
}
