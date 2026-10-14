import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

for(const scope of ['occurrence','future'])for(const mode of ['whole_task','subtasks'])test(`${scope} ${mode}: managed placeholder assignment previews the recipient actually saved and paid`,async t=>{
  const f=await scoringFixture(t);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Assigned routine','Assigned routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:mode==='whole_task'?2:0,scoring_mode:mode,due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Routine step',points:2}]});
  assert.equal(created.status,201,JSON.stringify(created));const id=created.data.id;
  const body={title:'Edited assigned routine',edit_scope:scope,activity_template_id:template,assignment_mode:'fixed',assigned_to:[],points:mode==='whole_task'?2:0,scoring_mode:mode};
  const before=f.snapshot(),changes=f.changes(),preview=await f.preview(id,body);
  assert.equal(preview.status,200,JSON.stringify(preview));
  assert.deepEqual(preview.data.before,[{user_id:2,points:2}]);assert.deepEqual(preview.data.after,[{user_id:2,points:2}]);
  assert.equal(f.snapshot(),before);assert.equal(f.changes(),changes,'preview writes nothing');
  assert.equal((await f.edit(id,body)).status,200);
  assert.equal(f.row(id).assigned_to,2);assert.equal(f.row(id).title,'Edited assigned routine');
  assert.equal((await f.finish(id)).status,200);
  const currentEarn=f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(id,id);
  assert.deepEqual(currentEarn,[{user_id:2,delta:2}]);
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.ok(next);
  assert.equal((await f.finish(next.id)).status,200);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(next.id,next.id),[{user_id:2,delta:2}]);
  await f.finish(id);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='earn' AND (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?))").all(id,id),currentEarn,'completion retry cannot double-pay');
});

test('unchanged round robin placeholder uses its effective current recipient; explicit manual clearing remains empty',async t=>{
  const f=await scoringFixture(t),rotated=await f.create({points:2,scoring_mode:'whole_task',assigned_to:[],assignment_mode:'round_robin',rotation_user_ids:[2,3],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'});
  assert.equal(rotated.status,201);const p=await f.preview(rotated.data.id,{points:2,assigned_to:[],assignment_mode:'round_robin',rotation_user_ids:[2,3]});
  assert.equal(p.status,200);assert.deepEqual(p.data.after,[{user_id:2,points:2}]);
  const manual=await f.create({points:2,scoring_mode:'whole_task',assigned_to:[2]});
  const clear=await f.preview(manual.data.id,{assigned_to:[]});assert.deepEqual(clear.data.before,[{user_id:2,points:2}]);assert.deepEqual(clear.data.after,[]);
  assert.equal((await f.edit(manual.data.id,{assigned_to:[]})).status,200);await f.finish(manual.data.id);
  assert.deepEqual(f.d.prepare('SELECT user_id,delta FROM reward_ledger WHERE task_id=?').all(manual.data.id),[]);
});

test('future-only bound preview retains eligible recipients without changing current work or history',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Future assigned routine','Future assigned routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,points:2,scoring_mode:'whole_task',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'}),id=created.data.id;
  const snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,{edit_scope:'future_only',future_patch:{fields:{points:3}}});
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.after,[{user_id:2,points:3}]);assert.ok(p.data.forecast_context);
  assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,{edit_scope:'future_only',future_patch:{fields:{points:3}}})).status,200);assert.equal(f.row(id).points,2);
  await f.finish(id);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);await f.finish(next.id);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(next.id),[{user_id:2,delta:3}]);
});
