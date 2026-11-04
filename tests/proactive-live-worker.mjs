import {app,safeStorage,session,clipboard} from 'electron'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {pathToFileURL} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
const output=process.env.COLOOP_PROACTIVE_OUTPUT, root='D:/Coloop'
app.setPath('userData',process.env.APPDATA+'/coloop')
app.on('window-all-closed',()=>{})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function main(){
 let indicator,board,agent,capture,ocr,leases,lab,passive,key='',exitCode=1
 const events=[],cloudCalls=[],observations=[],states=[],inputs=[],clips=[]
 const clipboardBaselines=new Map()
 const qaTag='qa:'+randomUUID().replaceAll('-','')
 const saves=new Map()
 const save=async(name,value)=>{const text=JSON.stringify(value,null,2);if(key&&text.includes(key))throw Error('KEY_IN_ARTIFACT');const pending=(saves.get(name)??Promise.resolve()).catch(()=>{}).then(()=>writeFile(output+'/'+name,text));saves.set(name,pending);await pending}
 const until=async(fn,seconds=240)=>{const end=Date.now()+seconds*1000;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100)}throw Error('LIVE_WAIT_TIMEOUT')}
 try{
 const lib=await import(pathToFileURL(process.env.COLOOP_PROACTIVE_LIB).href)
 const profile=JSON.parse(await readFile(process.env.APPDATA+'/coloop/state.json','utf8'))
 key=safeStorage.decryptString(Buffer.from(profile.encryptedKey,'base64'))
 const network=session.fromPartition('proactive-live-'+randomUUID())
 const cloud=new lib.CloudGateway(async(url,init)=>{
   if(cloudCalls.length>=14)throw Error('PAID_CLOUD_CALL_LIMIT')
   const started=performance.now(),row={request:JSON.parse(init.body),started:Date.now()};cloudCalls.push(row)
   const response=await network.fetch(url,init);row.status=response.status;row.elapsedMs=performance.now()-started
   if(response.ok)row.response=await response.clone().json();await save('cloud.json',cloudCalls);return response
 })
 const title='Coloop Chinese USB Lab '+qaTag.slice(-8),exe=output+'/ProactiveTextLab.exe'
 await mkdir(output+'/lab')
 await promisify(execFile)(process.env.WINDIR+'/Microsoft.NET/Framework64/v4.0.30319/csc.exe',[
   '/nologo','/target:winexe','/out:'+exe.replaceAll('/','\\'),'/reference:System.Windows.Forms.dll',
   '/reference:System.Drawing.dll',(root+'/tests/ProactiveTextLab.cs').replaceAll('/','\\')],{windowsHide:true})
 // This visible form is the explicitly requested isolated test target.
 lab=spawn(exe,[output+'/lab',title],{stdio:'ignore'})
 const identity=await until(async()=>{try{const row=(await readFile(output+'/lab/identity.txt','utf8')).trim().split(/\r?\n/);return row.length===2&&row.every(x=>/^\d+$/.test(x))?row:null}catch{return null}},15)
 const labWindow=identity[1]
 ocr=new lib.OcrEngine(()=> 'D:/RK',root+'/resources/rapidocr-worker.py',()=>{})
 capture=new lib.WindowsObservationCapture({excludedBounds:()=>{const bounds=indicator?.getBounds();return bounds?[bounds]:[]},recognize:(png,signal)=>ocr.recognize(png,signal)})
 await capture.metadata(undefined,labWindow)
 await delay(150)
 const observe=async()=>{
   const meta=await capture.metadata();if(meta.process_id!==lab.pid||meta.window_id!==labWindow)throw Error('LAB_NOT_FOREGROUND')
   const frame=await capture.captureFrame();if(!frame)throw Error('NO_LAB_FRAME')
   await writeFile(output+'/lab/frame-'+observations.length+'.png',frame.png)
   const view=await capture.recognize(frame);observations.push(view);await save('observations.json',observations);return view
 }
 leases=new lib.ClipboardLeaseService(root+'/resources/clipboard-lease.ps1')
 board=new lib.BoardGateway(()=>{})
 await save('device.json',await board.connect(lib.importRkBoard('D:/RK/config/board.json'),process.env.RK_BOARD_PASSWORD))
 // QA adapts only the memory namespace, using real production Mem0 behind it.
 const original=await readFile(root+'/resources/rk-proactive-agent.py','utf8')
 const memory=`\nclass QAMemory:\n    def __init__(self,root,emit):\n        from memory_client import MemoryClient\n        self.client,self.emit,self.ids=MemoryClient(root),emit,set()\n    def call(self,args):\n        body=dict(args)\n        op=body['op']\n        if op=='catalog': body['tags']=['${qaTag}']\n        elif op=='get_many':\n            if not set(body['ids']) <= self.ids: raise ValueError('qa_memory_id_scope')\n        elif op=='set':\n            body['tags']=['${qaTag}']+list(body.get('tags',[]))[:7]\n            body['ttl']=300\n        else: raise ValueError('qa_memory_operation')\n        result=self.client.call(body)\n        if op=='set' and result.get('id'): self.ids.add(result['id'])\n        self.emit({'type':'qa.memory','value':{'op':op,'result':result}})\n        return result\n\n`
 const source=original.replace('\ndef main():',memory+'\ndef main():').replace('agent = Agent(root, emit)',`agent = Agent(root, emit, memory=QAMemory(root,emit), memory_namespace='${qaTag}')`)
 const sourcePath=output+'/rk-proactive-qa.py';await writeFile(sourcePath,source)
 await save('manifest.json',{scope:'production passive observation + real desktopCapturer/RapidOCR; cloud OCR understanding and recommendations; RK local Qwen memory review only; cloud structured actions directly validated by RK and sent through native USB; actual UIA/Win32 readback; real Mem0 in QA namespace. Isolated lab document.',route:'cloud_actions_rk_usb',sourceSha256:createHash('sha256').update(original).digest('hex'),driverSha256:createHash('sha256').update(await readFile(root+'/tests/proactive-live-worker.mjs')).digest('hex'),qaTag,labPid:lab.pid,labWindow})
 agent=new lib.ProactiveAgentService({script:sourcePath,openRuntime:async(source)=>{
   const channel=await board.openDesktopRuntime(source);let pending='';channel.on('data',data=>{pending+=data.toString();for(;;){const at=pending.indexOf('\n');if(at<0)break;const line=pending.slice(0,at);pending=pending.slice(at+1);try{const event=JSON.parse(line);events.push(event);void save('events-live.json',events).catch(()=>{});if(event.type==='agent.error')console.log(JSON.stringify({agentError:event.value}))}catch{}}});return channel
 },available:()=>true,assertStart:()=>{},observe,cloud:(system,content,signal)=>cloud.relayText(profile.settings.provider,key,system+'\nThis isolated USB acceptance host only provides action_plan input, observe and memory tools. Script execution is unavailable in this host. Use action_plan for all document edits.',content,signal,{maxTokens:4096,maxResponseBytes:24000}),
 input:async(op,view,value)=>{
   const result=op==='clipboard.verify'?await capture.verifyText(view,value.action.text):op==='completion.verify'?(value.evidence_mode==='control_state'?await capture.verifyControlState(view,value.expected_state):value.evidence_mode==='visible_text'?await capture.verifyVisibleText(view,String(value.expected_text??'')):await capture.verifyCurrentText(view,String(value.expected_text??''))):op==='input.guard'?await capture.guard(view,value.action):await capture.validate(view,value.action)
   inputs.push({op,action:value.action,result});await save('input.json',inputs);return result
 },clipboard:async(op,value)=>{
   const hashClipboard=async()=>createHash('sha256').update(await clipboard.readText()).digest('hex')
   if(op==='clipboard.prepare')clipboardBaselines.set(value.task_id,await hashClipboard())
   const result=await leases.call(op,value)
   const row={op,result}
   if(op==='clipboard.finish'&&result.status==='restored'){
     row.restoredHashMatches=await hashClipboard()===clipboardBaselines.get(value.task_id)
   }
   clips.push(row);await save('clipboard.json',clips);return result
 },releaseClipboard:id=>leases.releaseTask(id),
 prepareInput:async()=>{},onObservationRetry:id=>passive?.retryObservation(id),onChange:()=>{if(agent){states.push({...agent.snapshot(),at:Date.now(),at_ms:performance.now()});void save('states-live.json',states).catch(()=>{});if(indicator&&agent.active)void indicator.update({mode:'controlling',phase:agent.snapshot().phase}).catch(()=>{})}}})
 if(process.env.COLOOP_LAB_ACTIVATION_DELAY)await delay(Number(process.env.COLOOP_LAB_ACTIVATION_DELAY))
 const initial=await observe()
 if(!initial.ocr_text.includes('产品发布计划'))throw Error('OCR_TITLE_NOT_READ')
 passive=new lib.ForegroundObservationService({capture:async(signal)=>{
   const meta=await capture.metadata();if(meta.process_id!==lab.pid||meta.window_id!==labWindow)throw Error('LAB_NOT_FOREGROUND')
   return capture.captureFrame(signal)
 },recognize:async(frame,signal)=>{const view=await capture.recognize(frame,signal);observations.push(view);await save('observations.json',observations);return view},
 isOcrBusy:()=>ocr.busy,canObserve:()=>!agent.active,isInteracting:()=>indicator?.isInteracting??false,onInvalidated:()=>agent.cancelObservation(),onObservation:view=>agent.submitObservation(view),onError:error=>{events.push({type:'qa.passive_error',value:{error:error.message}})}})
 passive.start()
 const passiveStarted=performance.now()
 const suggestion=await until(()=>{const state=agent.snapshot();if(state.error)throw Error('AGENT:'+state.error);return state.suggestion},90)
 const recommendationMs=Math.round(performance.now()-passiveStarted)
 await save('suggestion.json',{...suggestion,recommendationMs})
 if(process.env.COLOOP_LIVE_ISLAND==='1'){
   indicator=new lib.ControlIndicatorWindow({preloadPath:root+'/out/preload/control.cjs',rendererPath:root+'/out/renderer/index.html',onStop:()=>agent.stop(),onOpenMain:()=>{},onAcceptSuggestion:id=>agent.acceptSuggestion(id)})
   await indicator.update({mode:'suggestion',title:suggestion.title.slice(0,100),content:suggestion.text,suggestionId:suggestion.suggestion_id,expanded:true})
   await save('island-ready.json',{suggestionId:suggestion.suggestion_id})
   await until(()=>agent.active,90)
 }else await agent.acceptSuggestion(suggestion.suggestion_id)
 passive.dispose()
 let answered=new Set()
 await until(()=>{const state=agent.snapshot();if(state.question&&!answered.has(state.question.question_id)){answered.add(state.question.question_id);agent.answer(state.taskId,state.question.question_id,'硬件产品。保留原标题，在当前文档末尾追加三条简短中文大纲即可，不需要保存文件。')}return !state.active&&state.taskId?state:null},300)
 await save('first-result.json',agent.snapshot())
 if(agent.snapshot().phase!=='completed')throw Error('FIRST_TASK_NOT_COMPLETED:'+agent.snapshot().phase)
 const firstText=await readFile(output+'/lab/actual-text.txt','utf8')
 if(firstText==='产品发布计划'||!firstText.startsWith('产品发布计划'))throw Error('NATIVE_DOCUMENT_NOT_APPENDED')
 const clipboardRestored=clips.some(row=>row.op==='clipboard.finish')&&clips.filter(row=>row.op==='clipboard.finish').every(row=>row.result.status==='restored'&&row.restoredHashMatches===true)
 if(!clipboardRestored)throw Error('CLIPBOARD_NOT_RESTORED')
 await until(()=>agent.snapshot().memorySaved!==undefined,360)
 if(agent.snapshot().memorySaved!==true)throw Error('MEMORY_NOT_SAVED')
 const beforeSecond=events.length
 await agent.startTask('先按tag '+qaTag+' 检索并读取上一个任务的流程记忆正文，然后在当前文档末尾仅追加一行“记忆已调用”。保留已有内容，不需要保存文件。')
 await until(()=>{const state=agent.snapshot();return !state.active&&state.phase!=='queued'?state:null},300)
 await save('second-result.json',agent.snapshot())
 if(agent.snapshot().phase!=='completed')throw Error('SECOND_TASK_NOT_COMPLETED')
 if(!events.slice(beforeSecond).some(e=>e.type==='qa.memory'&&e.value.op==='get_many'))throw Error('SECOND_TASK_DID_NOT_READ_MEMORY')
 const final=await readFile(output+'/lab/actual-text.txt','utf8')
 if(!final.includes('记忆已调用'))throw Error('MEMORY_TASK_TEXT_MISSING')
 await until(()=>events.filter(e=>e.type==='memory.saved').length>=2,360)
 const localModelCalls=events.filter(event=>event.type==='model.timing').map(event=>event.value)
 if(!localModelCalls.some(call=>call.stage==='memory_review'&&call.success))throw Error('REAL_QWEN_MEMORY_REVIEW_NOT_OBSERVED')
 if(localModelCalls.some(call=>call.stage!=='memory_review'))throw Error('LOCAL_UNDERSTANDING_MODEL_MUST_NOT_RUN')
 const cloudActions=cloudCalls.flatMap(row=>{try{const response=JSON.parse(row.response.choices[0].message.content);return response.type==='action_plan'&&Array.isArray(response.actions)?[response]:[]}catch{return []}})
 if(cloudActions.length<2)throw Error('DIRECT_CLOUD_ACTION_GROUPS_NOT_OBSERVED')
 const clipboardRestoredFinally=clips.filter(row=>row.op==='clipboard.finish').length>=2&&clips.filter(row=>row.op==='clipboard.finish').every(row=>row.result.status==='restored'&&row.restoredHashMatches===true)
 if(!clipboardRestoredFinally)throw Error('SECOND_CLIPBOARD_NOT_RESTORED')
 const taskIds=[...new Set(states.map(state=>state.taskId).filter(Boolean))]
 const timings=taskIds.map(taskId=>{const rows=states.filter(state=>state.taskId===taskId),start=rows.find(row=>row.phase==='queued'),end=rows.find(row=>row.phase==='completed');return {taskId,elapsed_ms:Math.round(end.at_ms-start.at_ms)}})
 await save('result.json',{ok:true,route:'cloud_actions_rk_usb',clipboardRestored,clipboardRestoredFinally,cloudCalls:cloudCalls.length,cloudActionGroups:cloudActions.length,localModelCalls,recommendationMs,timings,firstText,final,qaTag});exitCode=0
 }catch(error){await save('failure.json',{error:error.message,stack:error.stack,phase:agent?.snapshot(),cloudCalls:cloudCalls.length});console.log(JSON.stringify({ok:false,error:error.message}))}
 finally{
 await save('events.json',events);await save('states.json',states)
 indicator?.dispose();passive?.dispose();await agent?.dispose().catch(()=>{});await leases?.dispose().catch(()=>{});capture?.dispose();ocr?.dispose();board?.disconnect();lab?.kill()
 console.log(JSON.stringify({exitCode,output,cloudCalls:cloudCalls.length}));app.exit(exitCode)
 }
}
app.whenReady().then(main).catch(error=>{console.log(JSON.stringify({error:error.message}));app.exit(1)})
