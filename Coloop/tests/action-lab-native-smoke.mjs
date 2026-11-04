// Zero paid calls and zero input injection: real OCR, HWND/element identity and action guards only.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `action-native-${Date.now()}`)
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
const exe = resolve(output, 'ActionTaskLab.exe')
await promisify(execFile)(
  process.env.WINDIR + '/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  [
    '/nologo',
    '/target:winexe',
    '/out:' + exe,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve(root, 'tests/ActionTaskLab.cs'),
  ],
  { windowsHide: true },
)
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const{app}=require('electron');const{spawn}=require('node:child_process');const fs=require('node:fs/promises');const{WindowsObservationCapture}=require('./capture.cjs');const{OcrEngine}=require('./ocr.cjs');
app.whenReady().then(()=>{global.ocr=new OcrEngine(()=> 'D:/RK',${JSON.stringify(resolve(root, 'resources/rapidocr-worker.py'))},()=>{});global.capture=new WindowsObservationCapture({recognize:(png,signal)=>global.ocr.recognize(png,signal)});});
app.on('before-quit',()=>{global.capture?.dispose();global.ocr?.dispose();global.lab?.kill()});
global.startLab=async(task,folder)=>{
 await fs.mkdir(folder,{recursive:true});global.lab=spawn(${JSON.stringify(exe)},[folder,task,'Coloop native '+task+' '+Date.now()],{windowsHide:false});
 let identity;for(let i=0;i<100;i++){try{identity=JSON.parse(await fs.readFile(folder+'/identity.json','utf8'));break}catch{}await new Promise(r=>setTimeout(r,50))}
 if(!identity)throw Error('LAB_IDENTITY_MISSING');await global.capture.metadata(undefined,identity.window_id);await new Promise(r=>setTimeout(r,200));
 const meta=await global.capture.metadata();if(meta.process_id!==identity.pid||meta.window_id!==identity.window_id)throw Error('LAB_NOT_FOREGROUND');
 const snapshot=await global.capture.capture();if(!snapshot)throw Error('NO_OBSERVATION');return {snapshot,state:JSON.parse(await fs.readFile(folder+'/state.json','utf8'))};
};`,
)
const app = await electron.launch({ args: [harness], cwd: root }),
  rows = []
try {
  const cases = [
    ['checkbox', 'Enable feature', 'click'],
    ['double_click', 'Double click target', 'double_click'],
    ['hover', 'Hover target', 'move'],
    ['scroll', null, 'scroll'],
    ['two_fields', null, 'click'],
    ['replace_undo_redo', null, 'paste'],
  ]
  for (const [task, name, kind] of cases) {
    const sample = await app.evaluate(
      async (_app, { task, folder }) => global.startLab(task, folder),
      { task, folder: resolve(output, task) },
    )
    const targets = sample.snapshot.targets.filter((target) =>
      name ? target.name === name : target.type === 'Edit' || target.type === 'Document',
    )
    const checks = []
    for (const target of targets) {
      const value = await app.evaluate(
        async (_app, { snapshot, target, kind }) => {
          const action = { action: kind, target_id: target.id }
          return {
            validated: await global.capture.validate(snapshot, action),
            guarded: await global.capture.guard(snapshot, action),
          }
        },
        { snapshot: sample.snapshot, target, kind },
      )
      checks.push({ target, ...value })
    }
    const record = { task, snapshot: sample.snapshot, initialState: sample.state, checks }
    rows.push(record)
    await writeFile(resolve(output, task, 'probe.json'), JSON.stringify(record, null, 2))
    assert.ok(targets.length >= (task === 'two_fields' ? 2 : 1), task + ' target missing')
    for (const row of checks) {
      assert.equal(row.validated.allowed, true, task + ' validate')
      assert.equal(row.guarded.allowed, true, task + ' guard')
    }
    await app.evaluate(() => {
      global.lab.kill()
      global.lab = undefined
    })
  }
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        passed: rows.length,
        scope: 'real native controls/OCR/identity/validate/guard; zero cloud/RK/HID',
        cases: rows.map((row) => ({
          task: row.task,
          targets: row.checks.map((check) => ({
            type: check.target.type,
            source: check.target.source,
            name: check.target.name,
          })),
          native_classes: row.initialState.native_classes,
        })),
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: rows.length, output }))
} finally {
  await app
    .evaluate(() => {
      global.lab?.kill()
      global.capture?.dispose()
      global.ocr?.dispose()
    })
    .catch(() => {})
  await app.close()
}
