// Explicit paid-cloud/RK/USB taskset. Never runs as part of Vitest.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import electron from 'electron'
if (!process.argv.includes('--hid-lab')) throw Error('EXPLICIT_HID_LAB_REQUIRED')
if (!process.env.RK_BOARD_PASSWORD) throw Error('RK_BOARD_PASSWORD_REQUIRED')
const output = process.env.COLOOP_ACTION_OUTPUT
if (!output) throw Error('UNIQUE_OUTPUT_DIRECTORY_REQUIRED')
await mkdir(output, { recursive: false })
const bundle = 'D:/Coloop/.qa/action-taskset-lib-' + Date.now() + '.mjs'
await build({
  stdin: {
    contents: [
      "export {BoardGateway,importRkBoard} from './src/main/infrastructure/board.ts'",
      "export {CloudGateway} from './src/main/infrastructure/cloud.ts'",
      "export {WindowsObservationCapture} from './src/main/infrastructure/foreground-observation.ts'",
      "export {OcrEngine} from './src/main/infrastructure/ocr.ts'",
      "export {ClipboardLeaseService} from './src/main/infrastructure/clipboard-lease.ts'",
      "export {ProactiveAgentService} from './src/main/services/proactive-agent.ts'",
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
const env = { ...process.env, COLOOP_ACTION_LIB: bundle }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['D:/Coloop/tests/action-taskset-live-worker.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let outputText = ''
child.stdout.on('data', (data) => {
  outputText += data
  process.stdout.write(data)
})
child.stderr.on('data', () => {})
const code = await new Promise((resolve) => child.on('exit', resolve))
await writeFile(output + '/driver.stdout.txt', outputText)
process.exit(code ?? 1)
