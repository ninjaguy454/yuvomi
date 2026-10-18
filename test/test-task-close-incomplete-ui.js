import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '/api.js';
import * as state from '../public/utils/task-state.js';
import {taskCompletionPoints,FILTER_STATUSES} from '../public/utils/task-fields.js';
import {bountyHelperView} from '../public/utils/task-helper-views.js';
globalThis.HTMLElement??=class {};
globalThis.customElements??={define(){},get(){}};
const {__test:ui}=await import('../public/pages/tasks.js');
const task=()=>({id:1,title:'Synthetic activity',status:'closed_incomplete',closed_incomplete_at:'2026-11-01T12:00:00Z',points:5,revision:4,priority:'none',category:'misc',permissions:{complete:true,close_incomplete:true},subtasks:[{id:2,title:'Earned',status:'done',points:2},{id:3,title:'Unchecked',status:'open',points:3}]});

test('closed card/filter has explicit outcome and preserves unchecked checklist with no progress controls',()=>{
  const row=task();assert.equal(taskCompletionPoints(row),0);assert.ok(FILTER_STATUSES().some(item=>item.value==='closed_incomplete'));
  const html=ui.renderTaskCard(row,{expandedSubtasks:true,board:true});
  assert.match(html,/Closed without completing remaining subtasks/);assert.match(html,/data-action="toggle-status"[^>]+disabled/);
  assert.match(html,/data-action="toggle-subtask" data-id="3"[^>]+disabled/);assert.doesNotMatch(html,/data-task-drag-handle/);
  assert.equal(ui.statusForBoardDrop(row,'active'),'closed_incomplete');
});

test('closure history names zero new points and uses the actual close timestamp',()=>{
  const html=ui.renderHistoryEntry({id:-1,task_id:1,event_type:'closed_incomplete',title:'Synthetic activity',user_name:'Parent',closed_incomplete_at:'2026-11-01T12:00:00Z'});
  assert.match(html,/Closed without completing remaining subtasks/);assert.match(html,/No new completion points/);assert.match(html,/datetime="2026-11-01T12:00:00Z"/);
});

test('close confirmation preserves Cancel and repeats the same request after unknown outcome',async()=>{
  assert.equal(typeof state.closeIncompleteTask,'function');const saved=api.post,calls=[];
  try {
    const row={...task(),status:'in_progress',can_close_incomplete:true};
    api.post=async(path,body)=>{calls.push({path,body:{...body}});throw Error('Unknown outcome');};
    assert.equal(await state.closeIncompleteTask(row,{confirm:async(message,options)=>{assert.match(message,/Close without completing remaining subtasks/);assert.match(options.detail,/unchecked/);assert.match(options.detail,/earned points/);return false;}}),null);assert.equal(calls.length,0);
    for(let n=0;n<2;n++)await assert.rejects(state.closeIncompleteTask(row,{confirm:async()=>true}),/Unknown outcome/);
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].path,'/tasks/1/close-incomplete');assert.deepEqual(Object.keys(calls[0].body).sort(),['expected_revision','operation_id']);
  } finally {api.post=saved;}
});

test('explicit reopen preserves progress and earnings, retaining the same request after uncertain delivery',async()=>{
  assert.equal(typeof state.reopenIncompleteTask,'function');const saved=api.post,calls=[];
  try {
    const row={...task(),can_reopen_incomplete:true};api.post=async(path,body)=>{calls.push({path,body:{...body}});throw Error('Unknown reopen outcome');};
    assert.equal(await state.reopenIncompleteTask(row,{confirm:async(_message,options)=>{assert.match(options.detail,/Saved subtask progress/);assert.match(options.detail,/earned points/);assert.match(options.detail,/future occurrences stay unchanged/);return false;}}),null);assert.equal(calls.length,0);
    for(let n=0;n<2;n++)await assert.rejects(state.reopenIncompleteTask(row,{confirm:async()=>true}),/Unknown reopen outcome/);
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].path,'/tasks/1/reopen-incomplete');assert.deepEqual(Object.keys(calls[0].body).sort(),['expected_revision','operation_id']);
  } finally {api.post=saved;}
});

test('display-only helper views inherit closure but expose no whole-activity Close or Reopen action',()=>{
  for(const status of ['in_progress','closed_incomplete']) {
    const root={...task(),status,is_accepted_bounty:true,assigned_to:2,direct_assignee_ids:[2,3],assigned_users:[{id:2},{id:3}],can_close_incomplete:status==='in_progress',can_reopen_incomplete:status==='closed_incomplete',subtasks:[{id:3,status:'open',assigned_to:3,assigned_users:[{id:3}],explicit_assignee_ids:[3]}]};
    const helper=bountyHelperView(root,3);assert.ok(helper);assert.equal(helper.status,status);
    assert.equal(helper.permissions.close_incomplete,false);assert.equal(helper.can_close_incomplete,false);assert.equal(helper.can_reopen_incomplete,false);
  }
});
