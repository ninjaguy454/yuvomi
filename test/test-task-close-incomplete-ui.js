import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '/api.js';
import {taskStatusConfirmation,changeTaskStatus} from '../public/utils/task-state.js';
import {FILTER_STATUSES} from '../public/utils/task-fields.js';

globalThis.HTMLElement??=class {};
globalThis.customElements??={define(){},get(){}};
globalThis.window??=new EventTarget();
const {__test:ui}=await import('../public/pages/tasks.js');
const task=()=>({id:1,title:'Synthetic activity',status:'in_progress',revision:4,priority:'none',category:'misc',permissions:{complete:true},subtasks:[{id:2,title:'Earned',status:'done',points:2},{id:3,title:'Unchecked',status:'open',points:3}]});

test('completion prompt offers one remaining-subtask checkbox within ordinary completion',()=>{
  const prompt=taskStatusConfirmation(task(),'done');
  assert.equal(prompt.message,'Complete this Task?');assert.equal(prompt.flag,'complete_remaining');
  assert.equal(prompt.checkbox.label,'Complete remaining subtasks');assert.equal(prompt.checkbox.checked,true);
  assert.equal(FILTER_STATUSES().some(row=>row.value==='closed_incomplete'),false);
});

test('an unfinished delegated helper action still exposes the original activity completion choice',async()=>{
  const root=task();root.waiting_on_helper=true;
  root.subtasks[1].is_delegated_action=true;
  root.subtasks[1].supervision_action={execution_mode:'delegated',state:'assigned',supervisor_user_id:3,can_complete:false};
  root.subtasks[1].permissions={complete:false};
  const prompt=taskStatusConfirmation(root,'done');assert.ok(prompt?.checkbox);
  const saved=api.patch;let request;
  try {
    api.patch=async(_path,body)=>{request=body;return {data:{...root,status:'done'}};};
    assert.equal((await changeTaskStatus(root,'done',{confirm:async(_message,options)=>{options.checkbox.onChange(false);return true;}})).data.status,'done');
    assert.equal(request.complete_remaining,false);
  } finally {api.patch=saved;}
});

for(const choice of [false,true])test(`completion checkbox sends explicit ${choice} on the normal status endpoint`,async()=>{
  const saved=api.patch,calls=[];
  try {
    api.patch=async(path,body)=>{calls.push({path,body});return {data:{...task(),status:'done'}};};
    const result=await changeTaskStatus(task(),'done',{confirm:async(_message,options)=>{options.checkbox.onChange(choice);return true;}});
    assert.equal(result.data.status,'done');assert.equal(calls.length,1);
    assert.equal(calls[0].path,'/tasks/1/status');assert.equal(calls[0].body.complete_remaining,choice);
  } finally {api.patch=saved;}
});

test('Cancel writes no progress and does not paint pending completion',async()=>{
  const saved=api.patch;let calls=0,pending=0;
  try {
    api.patch=async()=>{calls++;};
    assert.equal(await changeTaskStatus(task(),'done',{confirm:async()=>false,beforeRequest:()=>{pending++;}}),null);
    assert.equal(calls,0);assert.equal(pending,0);
  } finally {api.patch=saved;}
});

test('completed card uses the ordinary done section and legacy evidence remains truthful history',()=>{
  const row={...task(),status:'done',completion_kept_subtasks:1};
  const html=ui.renderTaskCard(row,{expandedSubtasks:true,board:true});
  assert.doesNotMatch(html,/Closed without completing remaining subtasks/);
  const history=ui.renderHistoryEntry({id:-1,task_id:1,event_type:'closed_incomplete',title:'Synthetic activity',user_name:'Parent',closed_incomplete_at:'2026-11-01T12:00:00Z'});
  assert.match(history,/No new completion points/);assert.match(history,/datetime="2026-11-01T12:00:00Z"/);
  assert.equal(ui.kanbanSectionOf(row),'done');
});

test('saved legacy status filters normalize to Done without duplicate or invisible status values',()=>{
  assert.deepEqual(ui.normalizeFilterSet({status:'closed_incomplete'}).status,['done']);
  assert.deepEqual(ui.normalizeFilterSet({status:['done','closed_incomplete','open']}).status,['done','open']);
  assert.deepEqual(ui.normalizeFilterSet({status:['closed_incomplete','expired'],priority:'high'}),{status:['done','expired'],priority:['high'],assigned_to:[],tags:[]});
});
