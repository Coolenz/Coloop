import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {actualSentActions,evaluateTask} from './action-taskset-assertions.mjs'
const tasks=JSON.parse(await readFile(new URL('./action-taskset.json',import.meta.url),'utf8')).tasks
const task=id=>tasks.find(row=>row.id===id)

test('coverage only counts correlated input_sent receipts',()=>{
 const events=[{type:'task.state',value:{receipts:[
   {action_group_id:'g',index:0,action:'click',outcome:'input_sent'},
   {action_group_id:'g',index:1,action:'paste',outcome:'unknown'},
   {action_group_id:'g',index:2,action:'move',outcome:'not_sent'}]}}]
 assert.deepEqual(actualSentActions(events,[{action_group_id:'g',action_index:0,action:{action:'click',target_id:3}}]),[
   {action:'click',target_id:3,action_group_id:'g',index:0}])
})
test('checkbox visible success cannot replace actual checked state',()=>{
 const state={task_id:'checkbox',checked:false,mouse_down_count:1,mouse_up_count:1,visible_result:'Feature enabled'}
 assert.equal(evaluateTask(task('checkbox'),state,state,[{action:'click'}]).passed,false)
 assert.equal(evaluateTask(task('checkbox'),state,{...state,checked:true},[{action:'click'}]).passed,true)
})
test('hover requires a NEW enter without clicking',()=>{
 const before={task_id:'hover',mouse_enter_count:1,mouse_down_count:0,mouse_up_count:0}
 assert.equal(evaluateTask(task('hover'),before,before,[{action:'move'}]).passed,false)
 assert.equal(evaluateTask(task('hover'),before,{...before,mouse_enter_count:2},[{action:'move'}]).passed,true)
 assert.equal(evaluateTask(task('hover'),before,{...before,mouse_enter_count:2,mouse_down_count:1},[{action:'move'}]).passed,false)
})
test('two fields require exact different full texts, not status labels',()=>{
 const before={task_id:'two_fields'},actions=[{action:'paste'},{action:'paste'}]
 assert.equal(evaluateTask(task('two_fields'),before,{...before,fields:{a:'订单甲-731',b:'订单甲-731'},visible_result:'Both notes updated'},actions).passed,false)
 assert.equal(evaluateTask(task('two_fields'),before,{...before,fields:{a:'订单甲-731',b:'项目乙-842'}},actions).passed,true)
})
test('undo-redo needs independent changed-text sequence plus real hotkeys',()=>{
 const before={task_id:'replace_undo_redo',sequence:5,fields:{revision:'Original revision'}}
 const final={...before,fields:{revision:'Revision Beta 中文'},events:[
   {seq:6,type:'text_changed',control:'revision',value:'Revision Beta 中文'},
   {seq:7,type:'undo_keydown'},
   {seq:8,type:'text_changed',control:'revision',value:'Original revision'},
   {seq:9,type:'redo_keydown'},
   {seq:10,type:'text_changed',control:'revision',value:'Revision Beta 中文'}]}
 const actions=[{action:'paste'},{action:'hotkey',keys:'CTRL+Z'},{action:'hotkey',keys:'CTRL+Y'}]
 assert.equal(evaluateTask(task('replace_undo_redo'),before,final,actions).passed,true)
 assert.equal(evaluateTask(task('replace_undo_redo'),before,{...final,events:final.events.filter(row=>row.seq!==8)},actions).passed,false)
})
