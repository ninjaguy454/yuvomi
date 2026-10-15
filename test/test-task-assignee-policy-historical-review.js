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

for(const legacy of [false,true])for(const echo of [false,true])test(`historical ${echo?'visibility echo':'sparse title'} preserves ${legacy?'missing legacy':'captured uncapped'} future policy`,async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  if(legacy)for(const row of f.d.prepare('SELECT id,definition_json FROM task_recurrence_definitions').all()){
    const definition=JSON.parse(row.definition_json);delete definition.assignee_policy;for(const child of definition.subtasks)delete child.assignee_policy;
    f.d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(definition),row.id);
  }
  f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  for(const people of [[1],[2]])assert.equal((await f.edit(id,{assigned_to:people,direct_assignee_ids:people})).status,200);
  assert.equal((await f.finish(id)).status,200);
  const beforeDefinition=latest(f),old=history(f,id),before=f.snapshot(),body={edit_scope:'future',title:'Unrelated future title',...(echo?{assigned_to:[2,3]}:{})};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),before);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  const after=latest(f);assert.equal(Object.hasOwn(after,'assignee_policy'),!legacy);assert.deepEqual(after.assignee_policy,beforeDefinition.assignee_policy);
  assert.deepEqual(after.subtasks.map(child=>child.assignee_policy),beforeDefinition.subtasks.map(child=>child.assignee_policy));assert.equal(history(f,id),old);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id),policy=readTaskAssigneePolicy(f.d,next.id);
  if(legacy)assert.equal(policy,null);else assert.equal(policy.max_assignees,null);
});

const boundTemplate=f=>Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_policy,assignment_strategy,fixed_user_id,subject_required,allow_assignment_override) VALUES('Captured bound routine','Captured bound routine','school','fixed','fixed',2,0,1)").run().lastInsertRowid);
for(const legacy of [false,true])test(`historical bound title preserves ${legacy?'missing legacy':'captured uncapped'} root and binding policy`,async t=>{
  const f=await scoringFixture(t),template=boundTemplate(f),made=await f.create({...recurrence,category:'school',activity_template_id:template,assigned_to:[2],points:2}),id=made.data.id;
  assert.equal(made.status,201,JSON.stringify(made));
  if(legacy)for(const row of f.d.prepare('SELECT id,definition_json FROM task_recurrence_definitions').all()){
    const definition=JSON.parse(row.definition_json);delete definition.assignee_policy;delete definition.binding.snapshot.assignee_policy;
    f.d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(definition),row.id);
  }
  const canonical=latest(f);f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  for(const people of [[3],[2]])assert.equal((await f.edit(id,{assigned_to:people})).status,200);
  assert.equal((await f.finish(id)).status,200);const old=history(f,id),snapshot=f.snapshot(),body={edit_scope:'future',title:'Unrelated bound future title'};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),snapshot);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(latest(f).assignee_policy,canonical.assignee_policy);assert.deepEqual(latest(f).binding.snapshot.assignee_policy,canonical.binding.snapshot.assignee_policy);assert.equal(history(f,id),old);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id),policy=readTaskAssigneePolicy(f.d,next.id);
  if(legacy)assert.equal(policy,null);else assert.equal(policy.max_assignees,null);
});

test('this-and-future binding change captures new direct performers despite an unchanged visibility union',async t=>{
  const f=await scoringFixture(t),template=boundTemplate(f);f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const made=await f.create({...recurrence,category:'school',activity_template_id:template,assigned_to:[2],subtasks:[{title:'Child',assigned_user_ids:[3]}]}),id=made.data.id;
  assert.equal(made.status,201,JSON.stringify(made));
  const pair=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_policy,assignment_strategy,participant_count,subject_required,allow_assignment_override) VALUES('New pair','New pair','school','rotating_multi','eligible_round_robin',2,0,1)").run().lastInsertRowid);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Pair eligibility',0,'normal',1)").run().lastInsertRowid);
  for(const user of [1,2,3])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,user===1?'excluded':'normal');
  f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES(?,?,0)').run(pair,skill);
  f.d.prepare("UPDATE task_categories SET max_assignees=2 WHERE key='school'").run();const snapshot=f.snapshot(),body={edit_scope:'future',activity_template_id:pair,assigned_to:[]};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),snapshot);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  const definition=latest(f),policy=readTaskAssigneePolicy(f.d,id);assert.deepEqual(definition.assignee_policy,policy);assert.deepEqual(policy.direct_assignee_ids,[2,3]);assert.equal(policy.max_assignees,2);assert.equal(definition.binding.snapshot.assignee_policy.max_assignees,2);
  assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.deepEqual(readTaskAssigneePolicy(f.d,next.id),policy);
});

test('this-and-future ordered rotation edit captures the new direct performer despite unchanged visibility',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',assigned_to:[2],assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'policy-review-group',rotation_slot:0,subtasks:[{title:'Two',assigned_user_ids:[2]},{title:'Three',assigned_user_ids:[3]}]}),id=made.data.id;
  assert.equal(made.status,201,JSON.stringify(made));f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();const snapshot=f.snapshot(),body={edit_scope:'future',rotation_user_ids:[3,2]};
  const preview=await f.preview(id,body);assert.equal(preview.status,200,JSON.stringify(preview));assert.equal(f.snapshot(),snapshot);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(latest(f).assignee_policy,readTaskAssigneePolicy(f.d,id));assert.deepEqual(latest(f).assignee_policy.direct_assignee_ids,[3]);assert.equal(latest(f).assignee_policy.max_assignees,1);
  assert.equal((await f.finish(id)).status,200);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.equal(readTaskAssigneePolicy(f.d,next.id).max_assignees,1);assert.equal(readTaskAssigneePolicy(f.d,next.id).direct_assignee_ids.length,1);
});

const randomTemplate=f=>Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_policy,assignment_strategy,subject_required,allow_assignment_override) VALUES('Future random routine','Future random routine','school','eligible_random','eligible_round_robin',0,1)").run().lastInsertRowid);
for(const override of [false,true])test(`historical random binding Save ${override?'retains a concrete scalar override':'defers the performer without requiring a forecast'}`,async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',activity_template_id:boundTemplate(f),assigned_to:[2],points:2}),id=made.data.id;
  assert.equal(made.status,201,JSON.stringify(made));assert.equal((await f.finish(id)).status,200);
  const template=randomTemplate(f);f.d.prepare("UPDATE task_categories SET max_assignees=1 WHERE key='school'").run();
  const body={edit_scope:'future',activity_template_id:template,assigned_to:override?[3]:[]},old=history(f,id),snapshot=f.snapshot();
  if(!override){const preview=await f.preview(id,body);assert.equal(preview.status,409,JSON.stringify(preview));assert.ok(preview.conditions.includes('random_assignment_unresolved'));assert.equal(f.snapshot(),snapshot);}
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(history(f,id),old);
  const definition=latest(f);assert.equal(definition.assignee_policy.max_assignees,1);assert.equal(definition.binding.snapshot.assignee_policy.max_assignees,1);assert.deepEqual(definition.assignee_policy.direct_assignee_ids,override?[3]:[]);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id),policy=readTaskAssigneePolicy(f.d,next.id);
  assert.equal(policy.max_assignees,1);assert.equal(policy.direct_assignee_ids.length,1);assert.ok([1,2,3].includes(policy.direct_assignee_ids[0]));if(override)assert.deepEqual(policy.direct_assignee_ids,[3]);
  const replaySnapshot=f.snapshot(),replay=await f.edit(id,body);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(f.snapshot(),replaySnapshot);assert.equal(history(f,id),old);
});

test('historical deferred random binding still requires assignment authority atomically',async t=>{
  const f=await scoringFixture(t),made=await f.create({...recurrence,category:'school',activity_template_id:boundTemplate(f),assigned_to:[2]}),id=made.data.id;
  assert.equal((await f.finish(id)).status,200);const template=randomTemplate(f);f.grant('edit_own','allow');f.grant('change_assignment','none');f.grant('reassign','none');
  const snapshot=f.snapshot(),body={edit_scope:'future',activity_template_id:template,assigned_to:[]},denied=await f.edit(id,body,2);assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),snapshot);
});
