// Read-only diagnosis of the actual WindowsObservationCapture / CUA / FlaUI editor binding.
// Keep the isolated ChatGPT test chat in front, with its composer focused before running.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, lstat, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { workspaceCacheEnvironment } from '../scripts/with-workspace-cache.mjs'

if (process.argv.length !== 2) throw Error('NO_ARGUMENTS_EXPECTED')
const root = resolve(import.meta.dirname, '..')
const env = workspaceCacheEnvironment(root)
delete env.ELECTRON_RUN_AS_NODE
const cacheRoot = join(root, '.cache', 'auto-agent-editor-probe')
await mkdir(cacheRoot, { recursive: true })
const profile = await mkdtemp(join(cacheRoot, 'run-'))
const reports = join(root, '.qa', 'auto-agent-editor-probe')
await mkdir(reports, { recursive: true })
const reportPath = join(reports, randomUUID() + '.json')
const entry = join(profile, 'probe.cjs')
const resources = join(process.env.LOCALAPPDATA, 'Programs', 'Coloop', 'resources')
const patternProbePath = join(profile, 'patterns.ps1')
const patternProbe = String.raw`
param([int]$ExpectedPid,[string]$ExpectedRuntime)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
function Shape-Text($text) {
 if($null -eq $text){return @{supported=$false;length=$null}}
 $normalized=($text -replace '\s','')
 return @{supported=$true;length=$text.Length;empty=($text.Length -eq 0);whitespaceOnly=($text.Trim().Length -eq 0);matchesKnownPlaceholder=(@('和Codex一起工作','与Codex一起工作','WorkwithCodex','Askanything','MessageChatGPT','询问任何问题') -contains $normalized)}
}
function Read-Patterns($element) {
 $name=$element.Current.Name;$value=$null;$document=$null;$valueReadOnly=$null;$textReadOnly=$null;$selectionCount=$null;$selectionLengths=@();$ranges=@();$errors=@()
 try{$valuePattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$value=$valuePattern.Current.Value;$valueReadOnly=$valuePattern.Current.IsReadOnly}catch{$errors+='value_unsupported'}
 try{
  $textPattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  $range=$textPattern.DocumentRange;$document=$range.GetText(200001)
  $textReadOnly=[string]$range.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
  try{$selection=$textPattern.GetSelection();$selectionCount=$selection.Length;foreach($item in $selection){$selectionLengths+=@{length=$item.GetText(200001).Length;collapsed=($item.CompareEndpoints([System.Windows.Automation.TextPatternRangeEndpoint]::Start,$item,[System.Windows.Automation.TextPatternRangeEndpoint]::End) -eq 0)}}}catch{$errors+='selection_unavailable'}
  try{foreach($child in @($range.GetChildren()|Select-Object -First 12)){$ranges+=@{type=$child.Current.ControlType.ProgrammaticName;name=(Shape-Text $child.Current.Name);nameEqualsDocument=($child.Current.Name -ceq $document);content=$child.Current.IsContentElement;control=$child.Current.IsControlElement;offscreen=$child.Current.IsOffscreen}}}catch{$errors+='range_children_unavailable'}
 }catch{$errors+='text_unsupported'}
 return @{runtimeId=@($element.GetRuntimeId());type=$element.Current.ControlType.ProgrammaticName;className=$element.Current.ClassName;focused=$element.Current.HasKeyboardFocus;keyboardFocusable=$element.Current.IsKeyboardFocusable;content=$element.Current.IsContentElement;control=$element.Current.IsControlElement;offscreen=$element.Current.IsOffscreen;name=(Shape-Text $name);value=(Shape-Text $value);document=(Shape-Text $document);nameEqualsValue=($null -ne $value -and $name -ceq $value);nameEqualsDocument=($null -ne $document -and $name -ceq $document);valueEqualsDocument=($null -ne $value -and $null -ne $document -and $value -ceq $document);valueReadOnly=$valueReadOnly;textReadOnly=$textReadOnly;selectionCount=$selectionCount;selectionRanges=$selectionLengths;documentChildren=$ranges;errors=$errors}
}
$focused=[System.Windows.Automation.AutomationElement]::FocusedElement
if($null -eq $focused -or $focused.Current.ProcessId -ne $ExpectedPid -or (($focused.GetRuntimeId()) -join ',') -cne $ExpectedRuntime){throw 'PATTERN_PROBE_FOCUS_CHANGED'}
if($focused.Current.IsPassword){throw 'PATTERN_PROBE_PASSWORD_REJECTED'}
$result=@{focused=(Read-Patterns $focused);children=@()}
$walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
$child=$walker.GetFirstChild($focused);$count=0
while($null -ne $child -and $count -lt 16){
 if(!$child.Current.IsPassword){$result.children+=,(Read-Patterns $child)}
 $child=$walker.GetNextSibling($child);$count++
}
$script:TreeCount=0;$script:TreeTruncated=$false
function Read-Structure($element,$depth) {
 $script:TreeCount++
 if($element.Current.IsPassword){return @{password=$true}}
 $node=Read-Patterns $element
 $node.children=@()
 $nested=$walker.GetFirstChild($element)
 while($null -ne $nested) {
  if($depth -ge 4 -or $script:TreeCount -ge 32){$script:TreeTruncated=$true;break}
  $node.children+=,(Read-Structure $nested ($depth+1))
  $nested=$walker.GetNextSibling($nested)
 }
 return $node
}
$result.rawTree=Read-Structure $focused 0
$result.rawTreeComplete=!$script:TreeTruncated
$after=[System.Windows.Automation.AutomationElement]::FocusedElement
if($null -eq $after -or $after.Current.ProcessId -ne $ExpectedPid -or (($after.GetRuntimeId()) -join ',') -cne $ExpectedRuntime){throw 'PATTERN_PROBE_FOCUS_CHANGED'}
$result | ConvertTo-Json -Depth 9 -Compress
`
const source = `
import {app} from 'electron';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WindowsObservationCapture} from './src/main/infrastructure/foreground-observation';
import {OcrEngine} from './src/main/infrastructure/ocr';
import {CuaDriverClient} from './src/main/infrastructure/cua-driver';
import {CuaDesktop} from './src/main/infrastructure/cua-desktop';
import {AutoWorkUiaObservation} from './src/main/infrastructure/auto-work-uia';
const profile=${JSON.stringify(profile)},resources=${JSON.stringify(resources)};
const report:any={scope:'read_only_real_native_capture_ocr_cua_flaui_no_input',at:new Date().toISOString(),stages:[]};
app.setPath('userData',join(profile,'electron'));
app.setPath('sessionData',join(profile,'electron-session'));
app.on('window-all-closed',()=>{});
const shape=(m:any)=>({window_id:m.window_id,process_id:m.process_id,process_name:m.process_name,window_rect:m.window_rect,editable_focus:m.editable_focus,editable_runtime_id:m.editable_runtime_id,editable_rect:m.editable_rect,editable_source:m.editable_source,editable_placeholder:m.editable_placeholder,textType:typeof m.editable_text,textLength:typeof m.editable_text==='string'?m.editable_text.length:null,whitespaceOnly:typeof m.editable_text==='string'?m.editable_text.trim().length===0:null,matchesKnownPlaceholder:['和Codex一起工作','与Codex一起工作','WorkwithCodex','Askanything','MessageChatGPT','询问任何问题'].includes((m.editable_text??'').replace(/\\s/g,'')),selection_start:m.selection_start,selection_end:m.selection_end,focus_diagnostic:m.focus_diagnostic});
let capture:any,ocr:any,driver:any,uia:any,last:any;
app.whenReady().then(async()=>{
 try{
  ocr=new OcrEngine(()=>process.env.COLOOP_RK_WORKSPACE??'D:/RK',join(resources,'rapidocr-worker.py'),()=>{});
  capture=new WindowsObservationCapture({recognize:(png,signal)=>ocr.recognize(png,signal)});
  const metadata=capture.metadata.bind(capture);
  capture.metadata=async(...args:any[])=>{if(args[1])throw Error('PROBE_REFUSES_WINDOW_ACTIVATION');last=await metadata(...args);return last;};
  await capture.withAgentWindow(async()=>{
   const start=await capture.metadata(undefined,undefined,true);
   report.stages.push({stage:'start',...shape(start)});
   if(start.editable_focus&&start.editable_runtime_id?.length){
    try{const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${JSON.stringify(patternProbePath)},'-ExpectedPid',String(start.process_id),'-ExpectedRuntime',start.editable_runtime_id.join()],{windowsHide:true,timeout:12000,maxBuffer:200000});report.patternDetails=JSON.parse(result.stdout);}catch(e){report.patternDetails={error:e.killed?'PATTERN_PROBE_TIMEOUT':'PATTERN_PROBE_FAILED',diagnostic:String(e.stderr??'').slice(0,600)};}
   }
   const assertWindow=()=>{if(last.window_id!==start.window_id||last.process_id!==start.process_id)throw Error('PROBE_TARGET_WINDOW_CHANGED');};
   const frame=await capture.captureFrame();if(!frame)throw Error('PROBE_FRAME_UNAVAILABLE');assertWindow();
   report.stages.push({stage:'frame',...shape(frame)});
   let view=await capture.recognize(frame);assertWindow();
   const targetShape=(v:any)=>{const t=v.targets.find((t:any)=>t.runtime_id?.length&&t.runtime_id.join()===v.editable_runtime_id?.join());return t?{id:t.id,type:t.type,source:t.source,runtime_id:t.runtime_id,rect:t.rect}:null;};
   report.stages.push({stage:'recognized',...shape(view),target:targetShape(view),editorCount:view.targets.filter((t:any)=>['Edit','Document'].includes(t.type)).length});
   const read=async(stage:string)=>{
    const target=targetShape(view);if(!target){report.stages.push({stage,error:'NO_BOUND_FOCUSED_EDITOR'});return;}
    let result:any;try{const draft=await capture.readEditor(view,target.id);result={ok:true,textLength:draft.text.length,selection_start:draft.selection_start,selection_end:draft.selection_end};}catch(e){result={ok:false,error:e.message};}
    let draftResult:any;try{const draft=await capture.readDraft(view,target.id);const expected=process.env.COLOOP_EDITOR_PROBE_EXPECTED_TEXT;draftResult={ok:true,textLength:draft.text.length,empty:draft.text.length===0,whitespaceOnly:draft.text.trim().length===0,matchesExpected:expected===undefined?null:draft.text.replace(/\\r\\n/g,'\\n')===expected.replace(/\\r\\n/g,'\\n')};}catch(e){draftResult={ok:false,error:e.message};}
    const checks={window:last.window_id===view.window_id,process:last.process_id===view.process_id,windowRect:last.window_rect.join()===view.window_rect.join(),focused:last.editable_focus===true,targetRuntime:target.runtime_id.join()===last.editable_runtime_id?.join(),snapshotRuntime:view.editable_runtime_id?.join()===last.editable_runtime_id?.join(),textReadable:typeof last.editable_text==='string',selectionValid:Number.isInteger(last.selection_start)&&Number.isInteger(last.selection_end)&&last.selection_start>=0&&last.selection_end>=last.selection_start&&last.selection_end<=(last.editable_text?.length??-1)};
    report.stages.push({stage,target,snapshot:shape(view),live:shape(last),checks,result,draftResult});assertWindow();
   };
   await read('read_after_recognize');
   const executable=join(resources,'runtime','cua-driver','cua-driver.exe');
   if(existsSync(executable)){
    driver=new CuaDriverClient({executable,stateDirectory:join(profile,'cua')});
    const reader={call:(name:string,...args:any[])=>{if(name!=='get_window_state')throw Error('PROBE_READ_ONLY_CUA');return driver.call(name,...args);}};
    const cua=new CuaDesktop({client:reader,metadata:()=>capture.metadata(),assertAllowed:()=>{},guard:async()=>{throw Error('PROBE_REFUSES_INPUT');}});
    view=await cua.enrich(view);assertWindow();report.cua={status:view.cua?.status,error:view.cua?.error};
    await read('read_after_cua');
   }else report.cua={status:'runtime_missing'};
   uia=new AutoWorkUiaObservation(join(resources,'auto-work-uia'));
   try{await uia.observe({pid:start.process_id,hwnd:start.window_id,onSnapshot:(s:any)=>{report.flaui={complete:s.complete,draftCount:s.drafts.length,messageCount:s.messages.length,focusedDrafts:s.drafts.filter((d:any)=>d.focused).map((d:any)=>({type:d.type,valueLength:d.value.length,empty:d.value.trim().length===0,bounds:d.bounds}))};}});}catch(e){report.flaui={error:e.message};}
   await read('read_after_flaui');
  });
 }catch(e){report.error=e.message;}finally{
  capture?.dispose();ocr?.dispose();driver?.dispose();uia?.stop();
  await writeFile(${JSON.stringify(reportPath)},JSON.stringify(report,null,2));
  app.exit(report.error?1:0);
 }
}).catch(async(e)=>{await writeFile(${JSON.stringify(reportPath)},JSON.stringify({...report,error:e.message}));app.exit(1);});
`
let child
try {
  await writeFile(patternProbePath, '\uFEFF' + patternProbe, 'utf8')
  await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'editor-probe.ts', loader: 'ts' }, outfile: entry, bundle: true, packages: 'external', external: ['electron'], platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' })
  const exitCode = await new Promise((done, reject) => {
    child = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [entry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    // Upstream output can include captured labels; only the deliberately restricted report is printed.
    child.stderr.resume()
    const timeout = setTimeout(() => { child.kill(); reject(Error('READ_ONLY_PROBE_TIMEOUT')) }, 60000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code) => { clearTimeout(timeout); done(code) })
  })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  console.log(JSON.stringify({ reportPath, exitCode, ...report }, null, 2))
  process.exitCode = exitCode === 0 ? 0 : 1
} finally {
  const canonicalCache = await realpath(cacheRoot)
  const canonicalProfile = await realpath(profile)
  const inside = relative(canonicalCache, canonicalProfile)
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || (await lstat(profile)).isSymbolicLink()) throw Error('PROBE_CLEANUP_PATH_INVALID')
  await rm(canonicalProfile, { recursive: true, force: true })
}
