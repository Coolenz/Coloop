// Requires no pre-existing Notepad process. Opens and closes one blank, unsaved test window.
import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = resolve(import.meta.dirname, '..'),
  output = resolve(root, '.qa', `notepad-compat-${Date.now()}`)
const count = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '@(Get-Process Notepad -ErrorAction SilentlyContinue).Count',
  ],
  { encoding: 'utf8', windowsHide: true },
).trim()
if (count !== '0') throw Error('Existing Notepad is open; refusing to touch user documents')
await mkdir(output, { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/main/infrastructure/foreground-observation.ts')],
  outfile: resolve(output, 'capture.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
const harness = resolve(output, 'harness.cjs')
await writeFile(
  harness,
  `const{app}=require('electron');const{spawn}=require('node:child_process');const{WindowsObservationCapture}=require('./capture.cjs');app.whenReady().then(async()=>{global.capture=new WindowsObservationCapture({recognize:async()=>{throw Error('No OCR in this compatibility check')}});spawn('notepad.exe',[],{windowsHide:false});});app.on('before-quit',()=>global.capture?.dispose());`,
)
const app = await electron.launch({ args: [harness], cwd: root })
let processId
try {
  let meta
  for (let attempt = 0; attempt < 40; attempt++) {
    meta = await app.evaluate(async () => global.capture?.metadata())
    if (meta?.process_name === 'Notepad' && meta?.editable_focus && meta.editable_rect) {
      processId = meta.process_id
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(meta?.editable_focus, true, 'Notepad did not expose a confirmed editable focus')
  const result = await app.evaluate(async (_app, meta) => {
    const rect = meta.editable_rect,
      center = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]
    const at = await global.capture.metadata(center)
    const snapshot = {
      ...meta,
      observation_id: 'notepad-compat',
      ocr_items: [],
      targets: [{ id: 1, center, runtime_id: meta.editable_runtime_id }],
    }
    return {
      type: at.point_target?.type,
      runtime_id_present: !!at.editable_runtime_id?.length,
      point_target: at.point_target,
      window_id: at.window_id,
      point_owner: at.point_owner,
      process_id: at.process_id,
      window_rect: at.window_rect,
      center,
      validated: await global.capture.validate(snapshot, { action: 'click', target_id: 1 }),
      guarded: await global.capture.guard(snapshot, { action: 'click', target_id: 1 }),
    }
  }, meta)
  await writeFile(resolve(output, 'diagnostic.json'), JSON.stringify(result, null, 2))
  assert.equal(result.validated.allowed, true)
  assert.equal(result.guarded.allowed, true)
  assert.equal(result.runtime_id_present, true)
  await writeFile(
    resolve(output, 'verification.json'),
    JSON.stringify(
      {
        passed: 1,
        scope:
          'actual Windows 11 Notepad blank unsaved document; native focus and UIA point identity; no text insertion, no OCR/cloud/HID',
        ...result,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: 1, type: result.type, output }))
} finally {
  if (processId)
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${processId} -ErrorAction SilentlyContinue;if($p -and $p.ProcessName -eq 'Notepad'){[void]$p.CloseMainWindow()}`,
      ],
      { windowsHide: false },
    )
  await app.close()
}
