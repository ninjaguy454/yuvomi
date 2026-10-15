import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {readTaskAssigneePolicy} from '../server/services/task-assignee-policy.js';
import {createDevice} from '../server/services/devices.js';
import {deviceTaskUpdate} from '../server/services/device-task-definitions.js';
import {assertTaskMutation} from '../server/services/task-access.js';

const direct=(f,id)=>readTaskAssigneePolicy(f.d,id)?.direct_assignee_ids;
const visible=(f,id)=>f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(r=>r.user_id);
const parent=f=>f.create({category:'household',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]});

test('sparse category preview and save retain direct provenance and child visibility',async t=>{
  const f=await scoringFixture(t),r=await parent(f),id=r.data.id;
  f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const before=f.snapshot();
  assert.equal((await f.preview(id,{category:'school'})).status,200);
  assert.equal(f.snapshot(),before);
  for(const category of ['school','misc']){
    const saved=await f.edit(id,{category});assert.equal(saved.status,200,JSON.stringify(saved));
    assert.deepEqual(direct(f,id),[2]);assert.deepEqual(visible(f,id),[2,3]);
  }
  assert.equal((await f.edit(r.data.subtasks[0].id,{assigned_to:[]})).status,200);
  assert.deepEqual(visible(f,id),[2]);
});

test('direct promotion cannot bypass denied assignment permissions through an unchanged visibility union',async t=>{
  const f=await scoringFixture(t),r=await parent(f),id=r.data.id;
  f.grant('edit_own','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const before=f.snapshot(),body={assigned_to:[2,3],direct_assignee_ids:[2,3]};
  for(const run of [()=>f.preview(id,body,2),()=>f.edit(id,body,2)]){
    const denied=await run();assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),before);
  }
  assert.deepEqual(direct(f,id),[2]);
});

test('unchanged direct editor selection permits title edits without assignment capabilities',async t=>{
  const f=await scoringFixture(t),r=await parent(f),id=r.data.id;
  f.grant('edit_own','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const body={title:'Permitted title',assigned_to:[2],direct_assignee_ids:[2]};
  const preview=await f.preview(id,body,2);assert.equal(preview.status,200,JSON.stringify(preview));
  const saved=await f.edit(id,body,2);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(direct(f,id),[2]);assert.deepEqual(visible(f,id),[2,3]);
});

test('future explicit promotion persists direct intent even when visibility is unchanged',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'household',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}],is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'}),id=r.data.id;
  const body={edit_scope:'future_only',future_patch:{fields:{assigned_to:[2,3]}}},before=f.snapshot();
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),before);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  const definitions=f.d.prepare('SELECT definition_json FROM task_recurrence_definitions ORDER BY id').all().map(row=>JSON.parse(row.definition_json));
  assert.deepEqual(definitions.at(-1).assignee_policy.direct_assignee_ids,[2,3]);
  assert.deepEqual(direct(f,id),[2]);
  assert.equal((await f.finish(id)).status,200);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
  assert.deepEqual(direct(f,next.id),[2,3]);
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? AND title=?').get(next.id,'Child');
  assert.equal((await f.edit(child.id,{assigned_to:[]})).status,200);assert.deepEqual(visible(f,next.id),[2,3]);
});

test('future direct promotion requires assignment capabilities',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'household',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}],is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'});
  f.grant('edit_own','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const body={edit_scope:'future_only',future_patch:{fields:{assigned_to:[2,3]}}},before=f.snapshot();
  for(const run of [()=>f.preview(r.data.id,body,2),()=>f.edit(r.data.id,body,2)]){const denied=await run();assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),before);}
});

test('sparse rotation roster edit updates the current direct performer and preserves future definition',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'school',assigned_to:[2],assignment_mode:'round_robin',rotation_user_ids:[2,3],is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'}),id=r.data.id;
  f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const definitions=f.d.prepare('SELECT definition_json FROM task_recurrence_definitions').all(),before=f.snapshot(),body={rotation_user_ids:[3,1]};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),before);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(f.row(id).assigned_to,3);assert.deepEqual(direct(f,id),[3]);assert.equal(readTaskAssigneePolicy(f.d,id).max_assignees,1);
  assert.deepEqual(f.d.prepare('SELECT definition_json FROM task_recurrence_definitions').all(),definitions);
});

test('adding an unassigned child enrolls new work without enrolling unchanged legacy children',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'school',assigned_to:[2],subtasks:[{title:'Old'}]});
  const old=r.data.subtasks[0];f.d.prepare('DELETE FROM task_assignee_policies WHERE task_id=?').run(old.id);
  f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const saved=await f.edit(r.data.id,{subtasks:[{id:old.id,title:'Old'},{title:'Added'}]});assert.equal(saved.status,200,JSON.stringify(saved));
  const child=f.d.prepare("SELECT id FROM tasks WHERE parent_task_id=? AND title='Added'").get(r.data.id);
  assert.deepEqual(direct(f,child.id),[]);assert.equal(readTaskAssigneePolicy(f.d,child.id).max_assignees,1);assert.equal(readTaskAssigneePolicy(f.d,old.id),null);
});

test('device direct marker preserves unchanged editor saves and cannot promote child-only people without grants',async t=>{
  const f=await scoringFixture(t),r=await parent(f),id=r.data.id;
  const principal={kind:'device',...createDevice(f.d,{name:'Synthetic review display'},1)};
  principal.permissions.capabilities['tasks.edit_others']='allow';
  const grants=structuredClone(principal.permissions),before=f.snapshot(),promotion={assigned_to:[2,3],direct_assignee_ids:[2,3]};
  assert.throws(()=>assertTaskMutation(f.d,principal,f.row(id),promotion,{operation:'update'}),/Task setting/);
  assert.throws(()=>deviceTaskUpdate(f.d,principal,id,{...promotion,...f.revisions(id)}),error=>error.status===403);
  assert.equal(f.snapshot(),before);
  const saved=deviceTaskUpdate(f.d,principal,id,{title:'Display title',assigned_to:[2],direct_assignee_ids:[2],...f.revisions(id)});
  assert.equal(saved.title,'Display title');assert.deepEqual(saved.direct_assignee_ids,[2]);
  assert.deepEqual(direct(f,id),[2]);assert.deepEqual(visible(f,id),[2,3]);assert.deepEqual(principal.permissions,grants);
});

test('locked self claim preserves child visibility and uses the existing claim capability',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'household',assigned_to:[],locked:true,subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=r.data.id;
  f.grant('claim','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const saved=await f.edit(id,{assigned_to:[2],direct_assignee_ids:[2]},2);
  assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(direct(f,id),[2]);assert.deepEqual(visible(f,id),[2,3]);
});

test('sparse rotation mode change does not promote child visibility',async t=>{
  const f=await scoringFixture(t),r=await f.create({category:'school',assigned_to:[2],assignment_mode:'round_robin',rotation_user_ids:[2,3],is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task',subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=r.data.id;
  const saved=await f.edit(id,{assignment_mode:'fixed',rotation_user_ids:[]});assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(direct(f,id),[2]);assert.deepEqual(visible(f,id),[2,3]);
});
