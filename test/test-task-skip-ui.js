import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '/api.js';
import * as state from '../public/utils/task-state.js';
import {taskCompletionPoints,FILTER_STATUSES} from '../public/utils/task-fields.js';
globalThis.HTMLElement??=class {};
globalThis.customElements??={define(){},get(){}};
const {__test:ui}=await import('../public/pages/tasks.js');
const {__test:detail}=await import('../public/components/task-detail.js');
const task=()=>({id:1,title:'Synthetic routine',status:'skipped',points:5,revision:4,priority:'none',category:'misc',
  start_date:'2026-11-01',due_date:'2026-11-01',skipped_at:'2026-10-10T12:00:00Z',is_recurring:1,
  permissions:{complete:true},subtasks:[{id:2,title:'Earned step',status:'done',points:2},{id:3,title:'Excused step',status:'skipped',points:3}]});
// Catches presenting excusal as points, overdue work, or actionable progress.
test('skipped card preserves earned progress, labels its outcome and disables progress and dragging',()=>{
  const t=task();assert.equal(taskCompletionPoints(t),0);assert.ok(FILTER_STATUSES().some(row=>row.value==='skipped'));
  const html=ui.renderTaskCard(t,{expandedSubtasks:true,board:true});
  assert.match(html,/>Skipped<\/span>/);assert.match(html,/data-action="toggle-status"[^>]+disabled/);
  assert.match(html,/data-action="toggle-subtask" data-id="2"[^>]+disabled/);
  assert.doesNotMatch(html,/due-date--overdue|data-task-drag-handle|Helper needed/);
  assert.equal(ui.statusForBoardDrop(t,'active'),'skipped');
});
// Catches successful-completion wording and wrong history timestamp.
test('skipped history identifies human excusal and zero new points',()=>{
  const html=ui.renderHistoryEntry({id:-10,task_id:1,event_type:'skipped',title:'Synthetic routine',user_name:'Parent',skipped_at:'2026-10-10T12:00:00Z'});
  assert.match(html,/Skipped/);assert.match(html,/No new completion points/);assert.match(html,/Parent/);
  assert.match(html,/datetime="2026-10-10T12:00:00Z"/);
});

test('skipped helper panel describes excusal rather than expiry',()=>{
  const saved=globalThis.document;
  class Node {
    children=[]; ownText='';
    set textContent(value){this.ownText=String(value);this.children=[];}
    get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
    appendChild(child){this.children.push(child);return child;}
  }
  try {
    globalThis.document={createElement:()=>new Node()};
    const html=detail.supervisionNode({...task(),supervision:{state:'not_required',actions:[]}},{}).textContent;
    assert.match(html,/This occurrence was skipped/);assert.doesNotMatch(html,/occurrence expired/);
  }finally{globalThis.document=saved;}
});
// Catches writes on Cancel and new operation IDs after an unknown network result.
test('confirmation states date and whole scope; Cancel writes nothing and unknown failure retries exactly',async()=>{
  assert.equal(typeof state.skipTaskOccurrence,'function');
  const saved=api.post,calls=[];
  try {
    const t={...task(),status:'open',can_skip_occurrence:true,permissions:{skip_occurrence:true}};
    api.post=async(path,body)=>{calls.push({path,body:{...body}});throw new Error('Unknown network outcome');};
    assert.equal(await state.skipTaskOccurrence(t,{confirm:async(message,options)=>{assert.match(message,/2026-11-01/);assert.match(options.detail,/all current assignees/);return false;}}),null);
    assert.equal(calls.length,0);
    for(let n=0;n<2;n++)await assert.rejects(state.skipTaskOccurrence(t,{confirm:async()=>true}),/Unknown network/);
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].path,'/tasks/1/skip');
    assert.deepEqual(Object.keys(calls[0].body).sort(),['expected_revision','operation_id']);
  } finally {api.post=saved;}
});
