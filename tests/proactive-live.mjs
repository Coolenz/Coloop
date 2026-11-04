// Explicit live paid-cloud / RK / native USB acceptance. Never loaded by Vitest.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import electron from 'electron'
if (!process.argv.includes('--hid-lab')) throw Error('EXPLICIT_HID_LAB_REQUIRED')
if (!process.env.RK_BOARD_PASSWORD) throw Error('RK_BOARD_PASSWORD_REQUIRED')
const output = process.env.COLOOP_PROACTIVE_OUTPUT
if (!output) throw Error('UNIQUE_OUTPUT_DIRECTORY_REQUIRED')
await mkdir(output, { recursive: false })
const bundle = 'D:/Coloop/.qa/proactive-live-lib-' + Date.now() + '.mjs'
await build({stdin:{contents:[
  "export {BoardGateway,importRkBoard} from './src/main/infrastructure/board.ts'",
  "export {CloudGateway} from './src/main/infrastructure/cloud.ts'",
  "export {WindowsObservationCapture,ForegroundObservationService} from './src/main/infrastructure/foreground-observation.ts'",
  "export {OcrEngine} from './src/main/infrastructure/ocr.ts'",
  "export {ClipboardLeaseService} from './src/main/infrastructure/clipboard-lease.ts'",
  "export {ControlIndicatorWindow} from './src/main/infrastructure/control-indicator.ts'",
  "export {ProactiveAgentService} from './src/main/services/proactive-agent.ts'",
].join('\n'),resolveDir:'D:/Coloop',loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external'})
const env = {...process.env,COLOOP_PROACTIVE_LIB:bundle}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(electron,['D:/Coloop/tests/proactive-live-worker.mjs'],{env,stdio:['ignore','pipe','pipe']})
let text=''
child.stdout.on('data', chunk=>{text+=chunk;process.stdout.write(chunk)})
child.stderr.on('data', ()=>{})
const code=await new Promise(resolve=>child.on('exit',resolve))
await writeFile(output+'/driver.stdout.txt',text)
process.exit(code ?? 1)
