import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';

const recurring={assigned_to:[2],points:5,scoring_mode:'whole_task',is_recurring:true,
  start_date:'2026-11-01',due_date:'2026-11-01',recurrence_rule:'FREQ=DAILY'};
const successor=(f,id)=>f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
const receipt=(f,id)=>f.d.prepare('SELECT * FROM task_completion_choices WHERE task_id=?').get(id);
const finish=(f,id,choice)=>f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:choice});

for(const choice of [false,true])test(`cohort completion choice=${choice} stays pending until atomic materialization and explicit reset permits one regeneration`,async t=>{
  const f=await scoringFixture(t),ids=[];
  for(let slot=0;slot<2;slot++){
    const created=await f.create({...recurring,title:`Receipt cohort ${slot}`,assignment_mode:'round_robin',
      rotation_user_ids:[2,3],rotation_group:'Receipt cohort',rotation_slot:slot});
    assert.equal(created.status,201,JSON.stringify(created));ids.push(created.data.id);
  }
  assert.equal((await finish(f,ids[0],choice)).status,200);
  assert.equal(successor(f,ids[0]),undefined);
  assert.equal(receipt(f,ids[0]).recurrence_handled,0,'waiting for a peer has not handled recurrence');
  assert.equal((await finish(f,ids[1],choice)).status,200);
  const successors=ids.map(id=>successor(f,id));
  assert.deepEqual(successors.map(row=>row.assigned_to),[3,2]);
  assert.deepEqual(ids.map(id=>receipt(f,id).recurrence_handled),[1,1]);
  const ledger=f.d.prepare('SELECT * FROM reward_ledger ORDER BY id').all();
  assert.equal((await f.call('PATCH',`/tasks/${ids[0]}/status`,{status:'open',reset_progress:true})).status,200);
  assert.ok(successors.every(row=>!f.row(row.id)),'explicit reset removes the complete untouched cohort');
  assert.deepEqual(ids.map(id=>receipt(f,id).recurrence_handled),[0,0]);
  assert.equal((await finish(f,ids[0],choice)).status,200);
  assert.deepEqual(ids.map(id=>successor(f,id).assigned_to),[3,2],'regeneration reuses the same rotation turn');
  assert.deepEqual(ids.map(id=>receipt(f,id).recurrence_handled),[1,1]);
  assert.deepEqual(f.d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),ledger);
  const before=f.snapshot(),changes=f.changes();
  assert.equal((await finish(f,ids[0],choice)).status,200);
  assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes,'completion replay writes nothing');
});

test('explicit reset preserves a touched successor and its handled receipt',async t=>{
  const f=await scoringFixture(t),root=(await f.create(recurring)).data;
  assert.equal((await finish(f,root.id,true)).status,200);
  const next=successor(f,root.id);
  assert.equal((await f.edit(next.id,{edit_scope:'occurrence',title:'Saved successor work'})).status,200);
  const saved=f.row(next.id);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'open',reset_progress:true})).status,200);
  assert.deepEqual(f.row(next.id),saved);assert.equal(receipt(f,root.id).recurrence_handled,1);
  assert.equal((await finish(f,root.id,true)).status,200);
  assert.deepEqual(f.row(next.id),saved);
});

test('explicit reset cannot recreate a successor already deleted separately',async t=>{
  const f=await scoringFixture(t),root=(await f.create(recurring)).data;
  assert.equal((await finish(f,root.id,false)).status,200);
  const next=successor(f,root.id);
  assert.equal((await f.call('DELETE',`/tasks/${next.id}`,f.revisions(next.id))).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root.id}/status`,{status:'open',reset_progress:true})).status,200);
  assert.equal(receipt(f,root.id).recurrence_handled,1);
  assert.equal((await finish(f,root.id,false)).status,200);assert.equal(successor(f,root.id),undefined);
});

for(const kind of ['synced','group_owner'])test(`explicit reset preserves nonrewindable ${kind} allocation and never consumes another turn`,async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Reset cursor workers',member_ids:[2,3]},{actorId:1});
  const policy=kind==='synced'?{assigned_to:[1],subtasks:[{title:'Synced child',assignment_rule:{kind:'group',group_id:group.id,mode:'synced'}}]}
    :{assigned_to:[],assignment_group:{group_id:group.id}};
  const created=await f.create({...recurring,...policy});assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id;assert.equal((await finish(f,root,true)).status,200);
  const next=successor(f,root),cursors=f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all();
  assert.equal((await f.call('PATCH',`/tasks/${root}/status`,{status:'open',reset_progress:true})).status,200);
  assert.ok(f.row(next.id),'a cursor advance without its previous state cannot be safely removed');
  assert.equal(receipt(f,root).recurrence_handled,1);
  assert.equal((await finish(f,root,true)).status,200);assert.equal(successor(f,root).id,next.id);
  assert.deepEqual(f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),cursors);
});
