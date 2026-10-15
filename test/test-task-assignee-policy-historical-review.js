import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {readTaskAssigneePolicy} from '../server/services/task-assignee-policy.js';

const recurrence={is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date:'2026-11-01',scoring_mode:'whole_task'};
const latest=f=>JSON.parse(f.d.prepare('SELECT definition_json FROM task_recurrence_definitions ORDER BY id DESC LIMIT 1').get().definition_json);
const visible=(f,id)=>f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row=>row.user_id);
const history=(f,id)=>JSON.stringify({tasks:f.d.prepare('SELECT * FROM tasks WHERE id=? OR parent_task_id=? ORDER BY id').all(id,id),assignments:f.d.prepare('SELECT * FROM task_assignments WHERE task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY task_id,user_id').all(id,id),policy:readTaskAssigneePolicy(f.d,id),awards:Object.fromEntries(['task_completions','reward_ledger','reward_task_awards','task_scoring_settlements','task_scoring_settlement_releases'].map(table=>[table,f.d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))});

test('historical full-body future promotion preserves direct intent and frozen history',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'household',assigned_to:[2],points:2,subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  assert.equal((await f.finish(id)).status,200);
  const old=history(f,id),before=f.snapshot(),body={edit_scope:'future',assigned_to:[2,3],direct_assignee_ids:[2,3]};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),before);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(latest(f).assignee_policy.direct_assignee_ids,[2,3]);assert.equal(history(f,id),old);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
  assert.deepEqual(readTaskAssigneePolicy(f.d,next.id).direct_assignee_ids,[2,3]);
  const child=f.d.prepare("SELECT id FROM tasks WHERE parent_task_id=? AND title='Child'").get(next.id);
  assert.equal((await f.edit(child.id,{assigned_to:[]})).status,200);assert.deepEqual(visible(f,next.id),[2,3]);assert.equal(history(f,id),old);
});

test('this-and-future unchanged direct selection never promotes the child visibility union',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'household',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  const body={edit_scope:'future',title:'Unchanged direct future',assigned_to:[2],direct_assignee_ids:[2]};
  assert.equal((await f.preview(id,body)).status,200);const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(latest(f).assignee_policy.direct_assignee_ids,[2]);assert.deepEqual(readTaskAssigneePolicy(f.d,id).direct_assignee_ids,[2]);assert.deepEqual(visible(f,id),[2,3]);
});

test('historical full-body title save retains the existing future captured cap',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  for(const people of [[1],[2]])assert.equal((await f.edit(id,{assigned_to:people,direct_assignee_ids:people})).status,200);
  assert.equal(readTaskAssigneePolicy(f.d,id).max_assignees,1);assert.equal(latest(f).assignee_policy.max_assignees,null);
  assert.equal((await f.finish(id)).status,200);const old=history(f,id);
  const body={edit_scope:'future',title:'Future title only',assigned_to:[2],direct_assignee_ids:[2]},before=f.snapshot();
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),before);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(latest(f).assignee_policy,{version:1,category_key:'school',max_assignees:null,direct_assignee_ids:[2]});assert.equal(history(f,id),old);
});

test('historical full-body promotion still requires assignment capabilities',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'household',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  assert.equal((await f.finish(id)).status,200);f.grant('edit_own','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const before=f.snapshot(),body={edit_scope:'future',assigned_to:[2,3],direct_assignee_ids:[2,3]};
  for(const run of [()=>f.preview(id,body,2),()=>f.edit(id,body,2)]){const denied=await run();assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),before);}
});

test('historical full-body promotion still enforces the current category cap',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  assert.equal((await f.finish(id)).status,200);f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const before=f.snapshot(),body={edit_scope:'future',assigned_to:[2,3],direct_assignee_ids:[2,3]};
  for(const run of [()=>f.preview(id,body),()=>f.edit(id,body)]){const denied=await run();assert.equal(denied.status,400,JSON.stringify(denied));assert.equal(denied.reason,'category_assignee_limit');assert.equal(f.snapshot(),before);}
});
