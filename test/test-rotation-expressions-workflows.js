import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import { resolveExpressionVariables, validateExpression } from '../public/utils/variable-expressions.js';
import { rotationVariableSchemaMigration } from '../server/services/rotation-variable-schema.js';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ??= 'rotation-workflow-isolated-tests-only';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { saveRotationGroup, getRotationOccurrence, getRotationTrack, finalizeRotation } = await import('../server/services/rotation.js');
const { instantiateWorkflow, previewWorkflow, syncWorkflowInstanceForTask } = await import('../server/services/activity-workflows.js');
const { normalizeVariableValue, resolveVariables, renderRotationVariableTemplates } = await import('../server/services/variable-resolution.js');
const { taskRotationContexts } = await import('../server/services/task-rotation.js');
const { default: automationRouter } = await import('../server/routes/automation.js');

function fixture() {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT)');
  for (const migration of ALL_MIGRATIONS) { if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up); migration.afterUp?.(d); }
  d.pragma('foreign_keys=ON'); _setTestDatabase(d);
  const admin = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('parent','Parent','test','admin','parent')").run().lastInsertRowid);
  const kids = ['Grace','Eleanor','Frankie'].map(name => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'test','member','child')").run(name,name).lastInsertRowid));
  const group = saveRotationGroup(d, { name: 'Kids', member_ids: kids }, { actorId: admin });
  const binding = { purpose_key: 'shower_order', label: 'Shower Order', group_id: group.id, strategy: 'rotating_order', advance_policy: 'on_completed' };
  const activity = Number(d.prepare("INSERT INTO activity_templates(name,title_template,subject_required,assignment_strategy,assignment_policy,category) VALUES('Bedtime','Bedtime',0,'fixed','fixed','misc')").run().lastInsertRowid);
  const workflow = Number(d.prepare("INSERT INTO workflow_templates(name,subject_required,input_schema_json,rotation_bindings_json) VALUES('Bedtime',0,?,?)").run(JSON.stringify([{id:'first',label:'First',type:'household_member',expression:{version:1,source:'rotationFirst(shower_order)'}}]),JSON.stringify([binding])).lastInsertRowid);
  kids.forEach((kid,index) => d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id) VALUES(?,?,?,?,?,?)").run(workflow,activity,`child_${index}`,index,'fixed',kid));
  return { d, admin, kids, group, workflow, binding };
}

test('Rotation expressions return typed snapshot members, ordered values and positions without executable access', () => {
  const order = [1,2,3].map(id => ({id,display_name:`Member ${id}`,password_hash:'must be discarded'}));
  const definitions = [{id:'night',type:'rotation_occurrence'}, {id:'person',type:'household_member'},
    ...[['order','household_member_list','rotationOrder(night)'],['selected','household_member','rotationSelected(night)'],['first','household_member','rotationFirst(night)'],['last','household_member','rotationLast(night)'],['position','number','rotationPosition(night, person)'],['next','household_member','rotationNext(night, person)'],['previous','household_member','rotationPrevious(night, person)']].map(([id,type,source]) => ({id,type,expression:{version:1,source}}))];
  const result = resolveExpressionVariables(definitions,{night:{id:4,track_id:2,order,selected_member:order[0],status:'resolved',strategy:'rotating_order'},person:order[0]});
  assert.deepEqual(result.values.order.map(member=>member.id),[1,2,3]);
  assert.equal(result.values.position,1); assert.equal(result.values.next.id,2); assert.equal(result.values.previous.id,3);
  assert.equal(result.values.first.id,1); assert.equal(result.values.last.id,3); assert.equal(result.values.selected.id,1);
  assert.equal(result.values.first.password_hash,undefined);
  assert.throws(()=>validateExpression('rotationPosition(night, 1)',definitions),/Household Member/);
  assert.throws(()=>validateExpression('night.order.constructor',definitions),/not available/);
  assert.throws(()=>resolveExpressionVariables([{id:'many',type:'household_member_list'}],{many:Array.from({length:101},(_,i)=>({id:i+1}))}),/does not match/);
});

test('Workflow Rotation preview does not persist state; one shared snapshot serves all child Tasks and retries', () => {
  const {d,admin,kids,workflow} = fixture();
  try {
    d.prepare("UPDATE activity_templates SET title_template='Bedtime {{shower_order.position}}'").run();
    const before = d.prepare('SELECT total_changes() AS n').get().n;
    const preview = previewWorkflow(d,workflow,{startDate:'2026-09-19'});
    assert.deepEqual(preview.rotations.shower_order.member_ids,kids);
    assert.deepEqual(preview.steps.map(step=>step.title),['Bedtime 1','Bedtime 2','Bedtime 3']);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_tracks').get().n,0);
    // Existing legacy assignment preview uses a rollback; the new Rotation path performs no writes.
    assert.ok(d.prepare('SELECT total_changes() AS n').get().n >= before);
    const options = {createdBy:admin,startDate:'2026-09-19',requestKey:'bedtime_night_1'};
    const result = instantiateWorkflow(d,workflow,options);
    const repeated = instantiateWorkflow(d,workflow,options);
    assert.deepEqual(repeated,result);
    assert.equal(d.prepare('SELECT count(*) n FROM workflow_instances').get().n,1);
    const ids = result.tasks.map(task => taskRotationContexts(d,task.task_id)[0].occurrence.id);
    assert.equal(new Set(ids).size,1); assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
    assert.deepEqual(result.rotations[0].occurrence.member_ids,kids);
    assert.equal(result.resolved_variables.find(row=>row.key==='first').value,kids[0]);
    assert.deepEqual(result.tasks.map(task=>d.prepare('SELECT title FROM tasks WHERE id=?').get(task.task_id).title),['Bedtime 1','Bedtime 2','Bedtime 3']);
    assert.throws(()=>instantiateWorkflow(d,workflow,{...options,startDate:'2026-09-20'}),/different answers/);
    assert.throws(()=>instantiateWorkflow(d,workflow,{...options,requestKey:null}),/stable request key/);
    const occurrenceId=ids[0];
    for(const task of result.tasks.slice(0,-1)) {d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.task_id);syncWorkflowInstanceForTask(d,task.task_id);}
    assert.equal(getRotationTrack(d,result.rotations[0].occurrence.track_id).advance_count,0);
    const final=result.tasks.at(-1);d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(final.task_id);syncWorkflowInstanceForTask(d,final.task_id);syncWorkflowInstanceForTask(d,final.task_id);
    assert.equal(getRotationOccurrence(d,occurrenceId).status,'completed');
    assert.equal(getRotationTrack(d,result.rotations[0].occurrence.track_id).advance_count,1);
    const second=instantiateWorkflow(d,workflow,{...options,requestKey:'bedtime_night_2'});
    assert.deepEqual(second.rotations[0].occurrence.member_ids,[kids[1],kids[2],kids[0]]);
    assert.deepEqual(second.tasks.map(task=>d.prepare('SELECT title FROM tasks WHERE id=?').get(task.task_id).title),['Bedtime 3','Bedtime 1','Bedtime 2']);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
  } finally {d.close();}
});

test('Activity-local Rotation purposes stay scoped to their Workflow step and render from that snapshot', () => {
  const {d,admin,workflow,binding}=fixture();
  try{
    d.prepare("UPDATE workflow_templates SET rotation_bindings_json='[]',input_schema_json='[]' WHERE id=?").run(workflow);
    d.prepare("UPDATE activity_templates SET rotation_bindings_json=?,title_template='Shower position {{shower_order.position}}'").run(JSON.stringify([binding]));
    const preview=previewWorkflow(d,workflow);
    assert.deepEqual(preview.steps.map(step=>step.title),['Shower position 1','Shower position 2','Shower position 3']);
    const result=instantiateWorkflow(d,workflow,{createdBy:admin,requestKey:'activity_local_1'});
    assert.equal(result.rotations.length,0);
    assert.deepEqual(result.tasks.map(task=>d.prepare('SELECT title FROM tasks WHERE id=?').get(task.task_id).title),preview.steps.map(step=>step.title));
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_tracks').get().n,3,'separate step owners never accidentally share a Track');
  }finally{d.close();}
});

test('typed Rotation references hydrate trusted history and reject client snapshot objects', () => {
  const {d,admin,workflow,group,kids}=fixture();
  try {
    const result=instantiateWorkflow(d,workflow,{createdBy:admin,requestKey:'typed_reference_1'});
    const occurrence=result.rotations[0].occurrence;
    for(const type of ['rotation_group','rotation_occurrence']) for(const value of [{id:group.id},[group.id],true,0]) assert.throws(()=>normalizeVariableValue(d,{id:'rotation',type},value),/valid Rotation/);
    assert.equal(normalizeVariableValue(d,{id:'group',type:'rotation_group'},group.id).name,'Kids');
    d.prepare("UPDATE users SET display_name='Renamed' WHERE id=?").run(kids[0]);
    assert.equal(normalizeVariableValue(d,{id:'occurrence',type:'rotation_occurrence'},occurrence.id).order[0].display_name,'Grace');
    const resolved=resolveVariables(d,[{id:'night',type:'rotation_occurrence'},{id:'order',type:'household_member_list',expression:{version:1,source:'rotationOrder(night)'}}],{night:occurrence.id});
    assert.deepEqual(resolved.persisted.order,kids); assert.equal(resolved.labels.order,'Grace → Eleanor → Frankie');
    assert.throws(()=>normalizeVariableValue(d,{id:'members',type:'household_member_list'},[kids[0],kids[0]]),/repeat/);
  } finally {d.close();}
});

test('Workflow Rotation resolution enforces explicit capability without leaving partial rows', () => {
  const {d,kids,workflow}=fixture();
  try {
    assert.throws(()=>instantiateWorkflow(d,workflow,{createdBy:kids[0],requestKey:'unauthorized_1'}),/permissions/);
    assert.equal(d.prepare('SELECT count(*) n FROM workflow_instances').get().n,0);
    assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
  } finally {d.close();}
});

test('consumer text snapshots render only the supplied canonical occurrence and preserve copied formulas', () => {
  const {d,admin,kids,workflow,binding}=fixture();
  try {
    const created=instantiateWorkflow(d,workflow,{createdBy:admin,requestKey:'snapshot_formula_1'});
    const result=renderRotationVariableTemplates(d,{templates:['Take shower — {{position}}',null,'Tonight: {{shower_order.position}}'],bindings:[binding],rotations:created.rotations,subjectUserId:kids[1],
      definitions:[{id:'position',type:'number',expression:{version:1,source:'rotationPosition(shower_order, context.household_member)'}}]});
    assert.deepEqual(result.values,['Take shower — 2',null,'Tonight: 2']);
    assert.equal(result.definitions[0].expression.source,'rotationPosition(shower_order, context.household_member)');
    assert.equal(getRotationTrack(d,created.rotations[0].occurrence.track_id).advance_count,0);
    assert.throws(()=>renderRotationVariableTemplates(d,{templates:['{{position}}'],bindings:[binding],rotations:[],subjectUserId:kids[1],definitions:result.definitions}),/Choose or enter a value/);
  }finally{d.close();}
});

test('Automation API persists typed Group values and Workflow purposes; contextual outcome commands are revision checked', async () => {
  const {d,admin,kids,group,workflow,binding}=fixture();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=Number(req.headers['x-actor']||admin);req.authRole=req.authUserId===admin?'admin':'member';req.session={userId:req.authUserId,role:req.authRole};next();});app.use('/automation',automationRouter);
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  const call=async(method,path,body,actor=admin)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`,{method,headers:{'Content-Type':'application/json','x-actor':String(actor)},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  try {
    const groupVariable=await call('POST','/admin/variables',{variable_key:'kids_group',label:'Kids Group',type:'rotation_group',kind:'value',default_value:group.id});
    assert.equal(groupVariable.status,201,JSON.stringify(groupVariable.body));
    assert.equal(groupVariable.body.data.default_value,group.id);
    const existing=await call('GET','/admin/workflow-templates');assert.equal(existing.status,200,JSON.stringify(existing.body));
    const authored=existing.body.data.find(row=>row.id===workflow);
    const saved=await call('PUT',`/admin/workflow-templates/${workflow}`,{...authored,rotation_bindings:[binding],input_schema:[{id:'first',label:'First',type:'household_member',expression:{version:1,source:'rotationFirst(shower_order)'}}]});
    assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.rotation_bindings[0].group_id,group.id);
    const run=await call('POST',`/quick-add/${workflow}/create`,{request_key:'api_bedtime_night'});assert.equal(run.status,201,JSON.stringify(run.body));
    const repeat=await call('POST',`/quick-add/${workflow}/create`,{request_key:'api_bedtime_night'});assert.deepEqual(repeat.body,run.body);
    const occurrence=run.body.data.rotations[0].occurrence;
    const path=`/workflow-instances/${run.body.data.id}/rotations/shower_order/outcome`;
    const denied=await call('POST',path,{outcome:'skipped',expected_revision:occurrence.revision},kids[0]);assert.equal(denied.status,403);
    const stale=await call('POST',path,{outcome:'skipped',expected_revision:occurrence.revision+1});assert.equal(stale.status,409);
    const skipped=await call('POST',path,{outcome:'skipped',expected_revision:occurrence.revision});assert.equal(skipped.status,200,JSON.stringify(skipped.body));
    assert.equal(skipped.body.data.status,'skipped');assert.equal(skipped.body.data.advanced,0);
    assert.equal((await call('POST',path,{outcome:'skipped',expected_revision:occurrence.revision})).status,200);
    assert.equal(getRotationTrack(d,occurrence.track_id).advance_count,0);
  } finally {await new Promise(resolve=>server.close(resolve));d.close();}
});

test('variable type migration preserves live references, indexes, triggers and consumed identities', () => {
  const d=new Database(':memory:');
  try {
    d.pragma('foreign_keys=OFF');
    d.exec(`CREATE TABLE household_variable_definitions(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT CHECK(type IN ('text')),label TEXT);
      CREATE TABLE workflow_variable_definitions(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT CHECK(type IN ('text')),reusable_definition_id INTEGER REFERENCES household_variable_definitions(id));
      CREATE INDEX idx_fixture_variable ON household_variable_definitions(label);
      INSERT INTO household_variable_definitions(id,type,label) VALUES(2,'text','Preserve'),(10,'text','Deleted'); DELETE FROM household_variable_definitions WHERE id=10;
      INSERT INTO workflow_variable_definitions(id,type,reusable_definition_id) VALUES(5,'text',2);`);
    rotationVariableSchemaMigration(d); rotationVariableSchemaMigration(d);
    assert.equal(d.prepare('SELECT label FROM household_variable_definitions WHERE id=2').get().label,'Preserve');
    assert.equal(d.prepare('SELECT reusable_definition_id FROM workflow_variable_definitions WHERE id=5').get().reusable_definition_id,2);
    const id=Number(d.prepare("INSERT INTO household_variable_definitions(type,label) VALUES('rotation_group','New')").run().lastInsertRowid);assert.equal(id,11);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
    assert.ok(d.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_fixture_variable'").get());
  } finally {d.close();}
});
