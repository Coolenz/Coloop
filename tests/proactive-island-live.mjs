// Explicit live paid-cloud / RK / native USB acceptance. Never loaded by Vitest.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { _electron } from '@playwright/test'
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
const live = await _electron.launch({args:['D:/Coloop/tests/proactive-live-worker.mjs'],cwd:'D:/Coloop',env:{...env,COLOOP_LIVE_ISLAND:'1'},timeout:30000})
const child=live.process()
let text=''
child.stdout.on('data',chunk=>{text+=chunk})
child.stderr.on('data',()=>{})
const exited=new Promise(resolve=>child.on('exit',resolve))
try{
 const page=await live.waitForEvent('window',{timeout:150000})
 await page.waitForLoadState('domcontentloaded')
 await page.locator('main').dispatchEvent('mouseover')
 const execute=page.getByRole('button',{name:'Execute',exact:true})
 await execute.waitFor({state:'visible',timeout:15000})
 await page.screenshot({path:output+'/island-recommendation.png'})
 await execute.click()
 await writeFile(output+'/island-click.json',JSON.stringify({clicked:true,source:'real production renderer + preload + ControlIndicatorWindow IPC to real agent',at:Date.now()}))
 const code=await exited
 await writeFile(output+'/driver.stdout.txt',text)
 if(code!==0)throw Error('LIVE_FAILED:'+code)
}catch(error){await writeFile(output+'/island-failure.json',JSON.stringify({error:error.message}));await live.close().catch(()=>{});throw error}
