import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {taskSeriesState,seriesDefinitionForGeneration}=await import('../server/services/task-series.js');

test('a template Activity can keep instance skills without changing reusable defaults',async t=>{
  const f=await scoringFixture(t),d=f.d;
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Synthetic template','Work','misc','fixed','fixed',2,0,'ignore',1,0)").run().lastInsertRowid);
  const first=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Template skill',0,'normal',1)").run().lastInsertRowid);
  const second=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Instance skill',0,'normal',1)").run().lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(template,first);
  const created=await f.create({activity_template_id:template,skill_ids:[second],due_date:'2026-11-01'});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id;
  assert.deepEqual(d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id=?').all(id).map(row=>row.skill_id),[second]);
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json).required_skill_ids,[second]);
  assert.deepEqual(d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id=?').all(template).map(row=>row.skill_id),[first]);
  const changed=await f.edit(id,{skill_ids:[first]});
  assert.equal(changed.status,200,JSON.stringify(changed));
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json).required_skill_ids,[first]);
  const before=f.snapshot(),invalid=await f.edit(id,{skill_ids:[999999]});
  assert.equal(invalid.status,400,JSON.stringify(invalid));assert.equal(f.snapshot(),before);
});

test('a standalone template Activity retains its policy snapshot through an instance skill edit',async t=>{
  const f=await scoringFixture(t),d=f.d;
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Synthetic template','Work','misc','fixed','fixed',2,0,'ignore',1,0)").run().lastInsertRowid);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Added skill',0,'normal',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,due_date:'2026-11-01'});assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id;
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json).required_skill_ids,[]);
  const edited=await f.edit(id,{skill_ids:[skill]});assert.equal(edited.status,200,JSON.stringify(edited));
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(id).definition_snapshot_json).required_skill_ids,[skill]);
  assert.deepEqual(d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id=?').all(template),[]);
});

test('instance skill edits cannot make the current assignee ineligible or bypass skill authority',async t=>{
  const f=await scoringFixture(t),d=f.d;
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Skill safety','Work','misc','fixed','fixed',2,0,'ignore',1,0)").run().lastInsertRowid);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Restricted',0,'normal',1)").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(2,?,'excluded','manual',1)").run(skill);
  const created=await f.create({activity_template_id:template,due_date:'2026-11-01'});assert.equal(created.status,201,JSON.stringify(created));
  const before=f.snapshot(),blocked=await f.edit(created.data.id,{skill_ids:[skill]});
  assert.equal(blocked.status,400,JSON.stringify(blocked));assert.equal(f.snapshot(),before);
  f.grant('change_required_skills','none');
  const afterGrant=f.snapshot();
  const denied=await f.edit(created.data.id,{skill_ids:[skill]},2);
  assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),afterGrant);
});

test('recurring instance skill edits update the future definition but not template defaults',async t=>{
  const f=await scoringFixture(t),d=f.d;
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Recurring skills','Work','misc','fixed','fixed',2,0,'ignore',1,0)").run().lastInsertRowid);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Recurring instance',0,'normal',1)").run().lastInsertRowid);
  const created=await f.create({activity_template_id:template,start_date:'2026-11-01',due_date:'2026-11-01',is_recurring:true,recurrence_rule:'FREQ=DAILY'});
  assert.equal(created.status,201,JSON.stringify(created));const id=created.data.id;
  const edited=await f.edit(id,{skill_ids:[skill],edit_scope:'future'});assert.equal(edited.status,200,JSON.stringify(edited));
  const series=taskSeriesState(d,id),next=seriesDefinitionForGeneration(d,series.series_id,series.occurrence.generation+1).data;
  assert.deepEqual(next.skill_ids,[skill]);assert.deepEqual(next.binding.snapshot.required_skill_ids,[skill]);
  assert.deepEqual(d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id=?').all(template),[]);
});

test('switching template and assignee validates the proposed person against new skills',async t=>{
  const f=await scoringFixture(t),d=f.d;
  const template=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('Old template','Work','misc','fixed','fixed',2,0,'ignore',1,0)").run().lastInsertRowid);
  const replacement=Number(d.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by,points) VALUES('New template','Work','misc','fixed','fixed',3,0,'ignore',1,0)").run().lastInsertRowid);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('New requirement',0,'normal',1)").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(2,?,'excluded','manual',1)").run(skill);
  const created=await f.create({activity_template_id:template,due_date:'2026-11-01'});assert.equal(created.status,201,JSON.stringify(created));
  const edited=await f.edit(created.data.id,{activity_template_id:replacement,assigned_to:[3],skill_ids:[skill]});
  assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(edited.data.assigned_to,3);
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(created.data.id).definition_snapshot_json).required_skill_ids,[skill]);
});
