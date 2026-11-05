import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
// Actual RK Ctrl+A in an owned fixture. Scripted component regression, no model calls.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.qa/native-editor-selectall-' + Date.now())
await mkdir(output, { recursive: true })
const fixtureExe = resolve(output, 'ActionTaskLab.exe')
await promisify(execFile)(
  resolve(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/codepage:65001',
    '/target:winexe',
    '/out:' + fixtureExe,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    resolve(root, 'tests/ActionTaskLab.cs'),
  ],
  { windowsHide: true },
)
const source = `
import {app} from 'electron';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {WindowsObservationCapture} from '../../src/main/infrastructure/foreground-observation';
import {BoardGateway,importRkBoard} from '../../src/main/infrastructure/board';
import {RkTarsBridge} from '../../src/main/infrastructure/rk-tars-bridge';
(async()=>{
const output=${JSON.stringify(output)};
const root=${JSON.stringify(root)};
app.setPath('userData',output+'/profile');
app.on('window-all-closed',()=>{});
await app.whenReady();
const capture=new WindowsObservationCapture({recognize:async()=>({text:'',items:[]})});
const board=new BoardGateway(()=>{});
const report:any={scope:'scripted component; actual RK hotkey/native capture; empty OCR stub; no model calls'};
let fixture:any,bridge:any,task:any;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
try{
 const password=(await readFile('D:/RK/AGENTS.md','utf8')).match(/SSH \\/ sudo 密码：\x60([^\x60]+)\x60/)![1];
 await board.connect(importRkBoard(),password);
 fixture=spawn(${JSON.stringify(fixtureExe)},[output,'partial_editor','Coloop isolated RK selection regression'],{stdio:'ignore'});
 let identity:any;for(let i=0;i<100;i++){try{identity=JSON.parse(await readFile(output+'/identity.json','utf8'));break}catch{}await delay(100)}
 if(identity.pid!==fixture.pid)throw Error('FIXTURE_IDENTITY');
 await capture.focusTaskWindow(identity.window_id,identity.pid);
 const before=await capture.capture();if(!before||before.window_id!==identity.window_id||before.process_id!==identity.pid)throw Error('FIXTURE_FOREGROUND');
 report.before=before;
 const target=before.targets.find((t:any)=>t.runtime_id.join()===before.editable_runtime_id.join());
 report.readBefore=await capture.readEditor(before,target.id);
 bridge=new RkTarsBridge({executorScript:root+'/resources/rk-execution-adapter.py',memoryScript:root+'/resources/rk-memory-worker.py',supportScript:root+'/resources/rk-proactive-agent.py',namespace:'qa:editor-selectall',openRuntime:s=>board.openDesktopRuntime(s),prepareInput:async()=>{},clipboard:async()=>{throw Error('NO_CLIPBOARD')},releaseClipboard:async()=>{},input:async(op,view,value)=>{
   const live=await capture.metadata();if(live.window_id!==identity.window_id||live.process_id!==identity.pid)throw Error('FIXTURE_FOREGROUND');
   const action=value.action??value;
   const checked=op==='input.guard'?await capture.guard(view,action):await capture.validate(view,action);
   if(!checked.allowed)throw Error('INPUT_TARGET_CHANGED');return checked;
 }});
 await bridge.connect();task={task_id:randomUUID(),generation:randomUUID()};await bridge.begin(task);
 report.receipt=await bridge.execute({...task,command_id:randomUUID(),observation:before,action:{action:'hotkey',target_id:target.id,keys:'CTRL+A'}});
 const after=await capture.capture();report.after=after;report.live=await capture.metadata();
 try{report.readAfter=await capture.readEditor(after,target.id)}catch(e){report.readError=String(e)}
}catch(e){report.error=String(e)}finally{
 if(bridge){if(task)await bridge.stop(task).catch(()=>{});await bridge.dispose()}
 capture.dispose();board.disconnect();fixture?.kill();await writeFile(output+'/report.json',JSON.stringify(report,null,2));app.exit(0);
}
})().catch(e=>{console.error(e);process.exit(1)});
`
await writeFile(resolve(output, 'entry.ts'), source)
await build({
  entryPoints: [resolve(output, 'entry.ts')],
  outfile: output + '/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'ssh2'],
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = await electron.launch({ args: [output + '/main.cjs'], env })
await new Promise((r) => child.on('close', r))
const report = JSON.parse(await readFile(output + '/report.json', 'utf8'))
assert.equal(report.error, undefined)
assert.equal(report.readError, undefined)
assert.equal(report.before.targets[0].name, 'Native text editor')
assert.equal(report.after.targets[0].name, 'Native text editor')
assert.deepEqual(report.readAfter, report.readBefore)
assert.equal(report.receipt.receipt.release_confirmed, true)
assert.ok(['input_sent', 'effect_verified'].includes(report.receipt.receipt.outcome))
report.passed = true
await writeFile(output + '/report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify({ output, passed: true, scope: report.scope }))
