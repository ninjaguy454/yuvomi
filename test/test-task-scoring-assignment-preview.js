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

for(const scope of ['occurrence','future'])for(const mode of ['whole_task','subtasks'])for(const change of ['subject','template'])test(`${scope} ${mode}: changing ${change} previews the new saved performer`,async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Changed routine','Changed routine',?,?,?,?,'ignore',1)").run(change==='subject'?'subject_skill':'fixed',change==='subject'?'subject_skill':'fixed',change==='subject'?null:2,change==='subject'?1:0).lastInsertRowid);
  const replacement=change==='subject'?template:Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Replacement routine','Replacement routine','fixed','fixed',3,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,...(change==='subject'?{activity_subject_user_id:2}:{}),points:mode==='whole_task'?2:0,scoring_mode:mode,subtasks:[{title:'Inherited work',points:2}],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'});assert.equal(created.status,201);const id=created.data.id;
  const body={activity_template_id:replacement,...(change==='subject'?{activity_subject_user_id:3}:{}),assigned_to:[],edit_scope:scope,points:mode==='whole_task'?2:0,scoring_mode:mode},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.before,[{user_id:2,points:2}]);assert.deepEqual(p.data.after,[{user_id:3,points:2}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,body)).status,200);assert.equal(f.row(id).assigned_to,3);assert.equal((await f.finish(id)).status,200);
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) AND type='earn'").all(id,id),[{user_id:3,delta:2}]);
  if(scope==='future'){const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);assert.ok(next);await f.finish(next.id);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE (task_id=? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)) AND type='earn'").all(next.id,next.id),[{user_id:3,delta:2}]);}
});

for(const transition of ['delegated_to_independent','independent_to_delegated'])test(`changed beneficiary ${transition} previews fresh helper ownership`,async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'Synthetic 4','Synthetic 4','x','member','other')").run();f.d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(4,1)').run();
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic action skill',0,'normal',1)").run().lastInsertRowid);
  const profiles=transition==='delegated_to_independent'?[[1,'excluded'],[2,'excluded'],[3,'normal'],[4,'normal']]:[[1,'excluded'],[2,'normal'],[3,'excluded'],[4,'excluded']];
  for(const [user,proficiency] of profiles)f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Subject helper routine','Subject helper routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:0,scoring_mode:'subtasks',subtasks:[{title:'Skilled action',skill_ids:[skill],points:2}]});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,beneficiary=transition==='delegated_to_independent'?4:3,recipient=transition==='delegated_to_independent'?4:2;
  const body={activity_template_id:template,activity_subject_user_id:beneficiary,assigned_to:[]},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.after,[{user_id:recipient,points:2}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  const saved=await f.edit(id,body);assert.equal(saved.status,200,JSON.stringify(saved));
  const done=await f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},recipient);assert.equal(done.status,200,JSON.stringify(done));
  assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND type='earn'").all(id),[{user_id:recipient,delta:2}]);
});

test('a changed subject preserves past recipients while forecasting only unfinished action rewards',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Partly complete routine','Partly complete routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:0,scoring_mode:'subtasks',subtasks:[{title:'Completed before edit',points:2},{title:'Remaining action',points:3}]});assert.equal(created.status,201);
  const id=created.data.id;assert.equal((await f.finish(created.data.subtasks[0].id)).status,200);
  const frozen=f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),body={activity_subject_user_id:3,assigned_to:[]},snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(id,body);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.earned,[{user_id:2,points:2}]);assert.deepEqual(p.data.before,[{user_id:2,points:3}]);assert.deepEqual(p.data.after,[{user_id:3,points:3}]);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
  assert.equal((await f.edit(id,body)).status,200);assert.deepEqual(f.d.prepare('SELECT * FROM task_scoring_settlements ORDER BY id').all(),frozen);
  assert.equal((await f.finish(id)).status,200);assert.deepEqual(f.d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND type='earn' ORDER BY id").all(id),[{user_id:2,delta:2},{user_id:3,delta:3}]);
});

test('a changed random binding declines a concrete recipient forecast without consuming state',async t=>{
  const f=await scoringFixture(t),created=await f.create({assigned_to:[2],points:2,scoring_mode:'whole_task'});
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Random routine','Random routine','fixed','eligible_random',0,'ignore',1)").run().lastInsertRowid);
  const snapshot=f.snapshot(),changes=f.changes(),p=await f.preview(created.data.id,{activity_template_id:template,assigned_to:[]});
  assert.equal(p.status,409,JSON.stringify(p));assert.equal(p.reason,'scoring_projection_unavailable');assert.deepEqual(p.conditions,['random_assignment_unresolved']);assert.equal(f.snapshot(),snapshot);assert.equal(f.changes(),changes);
});

test('a changed beneficiary and completion must be saved as separate actions in preview and Save',async t=>{
  const f=await scoringFixture(t),template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,subject_required,presence_policy,created_by) VALUES('Separate progress routine','Separate progress routine','subject_skill','subject_skill',1,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,activity_subject_user_id:2,points:2,scoring_mode:'whole_task'});assert.equal(created.status,201);
  const body={activity_subject_user_id:3,assigned_to:[],status:'done'},snapshot=f.snapshot();
  const p=await f.preview(created.data.id,body);assert.equal(p.status,409,JSON.stringify(p));assert.equal(p.reason,'scoring_progress_separate');
  const saved=await f.edit(created.data.id,body);assert.equal(saved.status,409,JSON.stringify(saved));assert.equal(saved.reason,'scoring_progress_separate');assert.equal(f.snapshot(),snapshot);
});
