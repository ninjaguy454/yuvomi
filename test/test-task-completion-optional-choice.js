import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

const definition={assigned_to:[2],points:5,scoring_mode:'subtasks',subtasks:[{title:'Required action',points:2},{title:'Optional action',points:3,is_optional:true}]};
const complete=(f,id,choice,actor=1)=>f.call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:choice},actor);
const balance=f=>f.d.prepare('SELECT COALESCE(SUM(delta),0) n FROM reward_ledger').get().n;

for(const mode of ['subtasks','whole_task'])for(const choice of [false,true])test(`${mode}: explicit root choice ${choice} includes eligible optional work only when selected`,async t=>{
  const f=await scoringFixture(t),root=(await f.create({...definition,scoring_mode:mode})).data;
  const before=root.subtasks.map(row=>f.row(row.id));
  const result=await complete(f,root.id,choice);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.status,'done');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),choice?['done','done']:['open','open']);
  if(!choice)assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),before);
  assert.equal(balance(f),mode==='whole_task'?5:choice?5:0);
});

test('automatically completing the parent from its required child leaves optional progress unchanged',async t=>{
  const f=await scoringFixture(t),root=(await f.create(definition)).data,optional=f.row(root.subtasks[1].id);
  assert.equal((await f.finish(root.subtasks[0].id)).status,200);
  assert.equal(f.row(root.id).status,'done');assert.deepEqual(f.row(optional.id),optional);assert.equal(balance(f),2);
});

test('explicit true completes an activity containing only eligible optional work',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...definition,points:3,subtasks:[definition.subtasks[1]]})).data;
  const result=await complete(f,root.id,true);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.row(root.id).status,'done');assert.equal(f.row(root.subtasks[0].id).status,'done');assert.equal(balance(f),3);
});

test('explicit true preserves done expired and skipped optional history and awards only newly completed actions',async t=>{
  const f=await scoringFixture(t),root=(await f.create({...definition,points:5,subtasks:[
    {title:'Required',points:1},{title:'Earned optional',points:1,is_optional:true},{title:'Expired optional',points:1,is_optional:true},
    {title:'Skipped optional',points:1,is_optional:true},{title:'Active optional',points:1,is_optional:true},
  ]})).data;
  assert.equal((await f.finish(root.subtasks[1].id)).status,200);
  f.d.prepare("UPDATE tasks SET status='expired',expired_at='2026-10-31T12:00:00Z' WHERE id=?").run(root.subtasks[2].id);
  f.d.prepare("UPDATE tasks SET status='skipped',skipped_at='2026-10-31T12:00:00Z' WHERE id=?").run(root.subtasks[3].id);
  const historical=root.subtasks.slice(1,4).map(row=>f.row(row.id));
  assert.equal((await complete(f,root.id,true)).status,200);
  assert.deepEqual(root.subtasks.slice(1,4).map(row=>f.row(row.id)),historical);
  assert.equal(f.row(root.subtasks[4].id).status,'done');assert.equal(balance(f),3);
});

test('explicit true requires permission for optional work and a rejected request changes nothing',async t=>{
  const f=await scoringFixture(t),created=await f.create({...definition,assigned_to:[2,3],subtasks:[{...definition.subtasks[0],assigned_user_ids:[2]},{...definition.subtasks[1],assigned_user_ids:[3]}]});
  assert.equal(created.status,201,JSON.stringify(created));const root=created.data;
  f.grant('complete_others','none');const before=f.snapshot();
  const denied=await complete(f,root.id,true,2);assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(f.snapshot(),before);
  assert.equal((await complete(f,root.id,false,2)).status,200);assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);
});

test('explicit true retains helper skill guards for optional work while false leaves it untouched',async t=>{
  const f=await scoringFixture(t),root=(await f.create(definition)).data;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Optional completion helper',0,'normal',1)").run().lastInsertRowid);
  for(const [user,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const {setTaskSkills}=await import('../server/services/task-skills.js'),{reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
  setTaskSkills(f.d,root.subtasks[1].id,[skill]);reconcileTaskSupervision(f.d,root.id);
  const before=f.snapshot(),denied=await complete(f,root.id,true);assert.equal(denied.status,409,JSON.stringify(denied));assert.equal(f.snapshot(),before);
  assert.equal((await complete(f,root.id,false)).status,200);assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),['open','open']);
});

for(const choice of [false,true])test(`device explicit root choice ${choice} respects optional work and existing completion authority`,async t=>{
  const f=await scoringFixture(t),root=(await f.create(definition)).data;
  const {createDevice}=await import('../server/services/devices.js'),{deviceTaskStatus}=await import('../server/services/device-tasks.js');
  const device={kind:'device',...createDevice(f.d,{name:'Optional completion fixture'},1)};device.permissions.capabilities['device_tasks.complete']='allow';
  assert.equal(deviceTaskStatus(f.d,device,root.id,{status:'done',complete_remaining:choice,expected_revision:f.row(root.id).revision}).status,'done');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),choice?['done','done']:['open','open']);assert.equal(balance(f),choice?5:0);
});

test('completing whole-activity supervision through its counterpart leaves optional work untouched',async t=>{
  const f=await scoringFixture(t),root=(await f.create(definition)).data;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Whole completion supervision',0,'normal',1)").run().lastInsertRowid);
  for(const [user,proficiency] of [[1,'excluded'],[2,'supervised'],[3,'normal']])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(user,skill,proficiency);
  const {setTaskSkills}=await import('../server/services/task-skills.js'),{reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
  setTaskSkills(f.d,root.id,[skill]);reconcileTaskSupervision(f.d,root.id);
  assert.equal((await f.finish(root.subtasks[0].id)).status,200);assert.equal(f.row(root.id).status,'in_progress');
  const view=reconcileTaskSupervision(f.d,root.id),action=view.actions.find(row=>row.action_task_id===root.id),optional=f.row(root.subtasks[1].id);
  assert.ok(action.counterpart_task_id);
  const result=await f.call('PATCH',`/tasks/${action.counterpart_task_id}/status`,{status:'done',complete_remaining:true},3);
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.row(root.id).status,'done');assert.deepEqual(f.row(optional.id),optional);
});

for(const choice of [false,true])test(`editor PUT completion choice ${choice} matches status PATCH for optional work`,async t=>{
  const f=await scoringFixture(t),root=(await f.create(definition)).data,children=root.subtasks.map(row=>f.row(row.id));
  const result=await f.edit(root.id,{title:'Activity saved with completion choice',status:'done',complete_remaining:choice});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.status,'done');assert.equal(result.data.title,'Activity saved with completion choice');
  assert.deepEqual(root.subtasks.map(row=>f.row(row.id).status),choice?['done','done']:['open','open']);
  if(!choice)assert.deepEqual(root.subtasks.map(row=>f.row(row.id)),children);
  assert.equal(balance(f),choice?5:0);
});
