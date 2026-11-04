// Actual isolated Windows editor, passive capture, RapidOCR and UIA; no cloud/RK/HID.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `foreground-native-${Date.now()}`)
await mkdir(output, { recursive: true })
await build({
  entryPoints: {
    capture: resolve(root, 'src/main/infrastructure/foreground-observation.ts'),
    ocr: resolve(root, 'src/main/infrastructure/ocr.ts'),
  },
  outdir: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
})
const exe = resolve(output, 'lab.exe')
await promisify(execFile)(
  process.env.WINDIR + '/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  [
    '/nologo',
    '/target:winexe',
    '/out:' + exe,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    resolve(root, 'tests/ProactiveTextLab.cs'),
  ],
  { windowsHide: true },
)
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const{app}=require('electron');const{spawn}=require('node:child_process');const fs=require('node:fs/promises');const{WindowsObservationCapture,ForegroundObservationService}=require('./capture.cjs');const{OcrEngine}=require('./ocr.cjs');app.whenReady().then(async()=>{
 const lab=spawn(${JSON.stringify(exe)},[${JSON.stringify(output)},'Coloop native observation probe'],{windowsHide:false});global.lab=lab;
 const ocr=new OcrEngine(()=> 'D:/RK',${JSON.stringify(resolve(root, 'resources/rapidocr-worker.py'))},()=>{});global.ocr=ocr;
 const capture=new WindowsObservationCapture({recognize:(png,signal)=>ocr.recognize(png,signal)});global.capture=capture;global.records=[];
 let meta;for(let i=0;i<40;i++){meta=await capture.metadata();if(meta.process_id===lab.pid)break;await new Promise(r=>setTimeout(r,100));}
 await new Promise(r=>setTimeout(r,500));meta=await capture.metadata();global.meta={...meta,editable_text:undefined};if(meta.process_id!==lab.pid)throw Error('LAB_NOT_FOREGROUND');
 const passive=new ForegroundObservationService({capture:s=>capture.captureFrame(s),recognize:(f,s)=>capture.recognize(f,s),isOcrBusy:()=>ocr.busy,canObserve:()=>true,onObservation:async snapshot=>{
  global.records.push({snapshot,at:Date.now()});global.passive.pause('received');
 },onError:error=>{global.error=error.message}});global.passive=passive;global.started=Date.now();passive.start();
});app.on('before-quit',()=>{global.passive?.dispose();global.capture?.dispose();global.ocr?.dispose();global.lab?.kill()});`,
)
const app = await electron.launch({ args: [harness], cwd: root })
try {
  let state
  for (let i = 0; i < 120; i++) {
    state = await app.evaluate(() => ({
      meta: global.meta,
      records: global.records || [],
      started: global.started,
      error: global.error,
    }))
    if (state.records.length) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(
    state.records.length,
    1,
    'Passive service did not emit: ' +
      JSON.stringify({ editable: state.meta?.editable_focus, error: state.error }),
  )
  const record = state.records[0],
    snapshot = record.snapshot
  const validation = await app.evaluate(async (_app, snapshot) => {
    const edit = snapshot.targets[0]
    if (!edit) return { missing_edit: true }
    const action = { action: 'click', target_id: edit.id }
    return {
      validated: await global.capture.validate(snapshot, action),
      guarded: await global.capture.guard(snapshot, action),
    }
  }, snapshot)
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        scope:
          'production passive service; real Windows lab editor blinking caret, desktop capture, RapidOCR, UIA identity; no cloud/RK/HID',
        elapsedMs: record.at - state.started,
        meta: state.meta,
        snapshot,
        validation,
        error: state.error,
      },
      null,
      2,
    ),
  )
  assert.equal(snapshot.editable_focus, true)
  assert.equal(snapshot.ocr_text.includes('产品发布计划'), true)
  assert.equal(validation.validated?.allowed, true)
  assert.equal(validation.guarded?.allowed, true)
  console.log(JSON.stringify({ passed: 1, elapsedMs: record.at - state.started, output }))
} finally {
  await app
    .evaluate(() => {
      global.passive?.dispose()
      global.capture?.dispose()
      global.ocr?.dispose()
      global.lab?.kill()
    })
    .catch(() => {})
  await app.close()
}
