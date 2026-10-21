import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTaskListDelta,mergeTaskStartVisibility} from '../public/utils/task-list-delta.js';

test('authorized delta removes, upserts, and reorders the current list',()=>{
  const rows=[{id:1,status:'open',priority:'low',due_date:'2026-11-02',created_at:'2026-10-01',revision:2},
    {id:2,status:'open',priority:'medium',due_date:'2026-11-01',created_at:'2026-10-02',revision:1}];
  const next=mergeTaskListDelta(rows,{removed:[2],data:[{...rows[0],priority:'urgent',revision:3},
    {id:3,status:'open',priority:'high',due_date:'2026-11-03',created_at:'2026-10-03',revision:1}]});
  assert.deepEqual(next.map(row=>row.id),[1,3]);
});

test('an older response cannot replace a newer locally acknowledged Task',()=>{
  const row={id:7,title:'Saved title',status:'open',priority:'low',revision:8};
  assert.deepEqual(mergeTaskListDelta([row],{removed:[],data:[{...row,title:'Old title',revision:7}]}),[row]);
});

test('a changed future Task may move the next wake earlier without dropping the old wake',()=>{
  assert.deepEqual(mergeTaskStartVisibility({server_now:100,next_start_at:900},
    {server_now:200,next_start_at:700}),{server_now:200,next_start_at:700});
  assert.deepEqual(mergeTaskStartVisibility({server_now:100,next_start_at:900},
    {server_now:200,next_start_at:null}),{server_now:200,next_start_at:900});
});
