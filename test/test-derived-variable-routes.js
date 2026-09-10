import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ??= 'derived-variable-isolated-test-session-only';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: router } = await import('../server/routes/automation.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { resolveVariables } = await import('../server/services/variable-resolution.js');
const { applyTaskActivityBinding, copyTaskActivityBinding } = await import('../server/services/task-activity-bindings.js');
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(db); else db.exec(migration.up);
  migration.afterUp?.(db);
  db.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version,migration.description);
}
_setTestDatabase(db);
const user = (username,displayName,firstName,nickname) => Number(db.prepare(`INSERT INTO users(username,display_name,first_name,nickname,password_hash,role,family_role) VALUES (?,?,?,?, 'test','admin','parent')`).run(username,displayName,firstName,nickname).lastInsertRowid);
const alex = user('alex','Alex Morgan','Alex','Lex');
const sam = user('sam','Sam Rivers','Sam',null);
const blank = user('blank','Household member',null,null);
const app = express(); app.use(express.json());
app.use((req,_res,next) => { req.authUserId = alex; req.authRole = req.headers['x-test-role'] || 'admin'; req.session = { userId:alex,role:req.authRole }; next(); });
app.use('/automation',router);
app.use('/tasks',tasksRouter);
const server = await new Promise(resolve => { const started = app.listen(0,'127.0.0.1',()=>resolve(started)); });
test.after(() => { server.close(); db.close(); });
async function call(method,path,body,role='admin') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/automation${path}`, { method,headers:{'Content-Type':'application/json','x-test-role':role},body:body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text(); return {status:response.status,body:raw ? JSON.parse(raw) : null};
}
const expression = source => ({version:1,source});
async function createVariable(key,type,extra={}) {
  const result = await call('POST','/admin/variables',{variable_key:key,label:key,type,...extra});
  assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.data;
}
async function createActivity(title='Prepare {{who}}',checklist=[]) {
  const result = await call('POST','/admin/activity-templates',{name:'Preparation',title_template:title,description:'For {{who}}',category:'misc',assignment_strategy:'open_claimable',subject_required:false,checklist});
  assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.data;
}
async function createWorkflow(activity,schema) {
  const result = await call('POST','/admin/workflow-templates',{name:'For {{who}}',category:'misc',subject_required:false,input_schema:schema,steps:[{step_key:'prepare',activity_template_id:activity.id}]});
  assert.equal(result.status,201,JSON.stringify(result.body)); return result.body.data;
}
let person,who,activity,workflow;

test('reusable calculation previews distinguish missing samples from invalid structure without writes',async()=>{
  person = await createVariable('person','household_member');
  who = await createVariable('who','text',{expression:expression('coalesce(person.nickname, person.first_name, person.display_name)')});
  const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const missing = await call('POST','/admin/variables/preview',{variable:who});
  assert.equal(missing.status,422,JSON.stringify(missing.body)); assert.equal(missing.body.reason,'missing_input');
  assert.deepEqual(missing.body.input_schema.map(row=>row.id),['person']);
  const preview = await call('POST','/admin/variables/preview',{variable:who,inputs:{person:alex}});
  assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.data.value,'Lex');
  const invalid = await call('POST','/admin/variables/preview',{variable:{...who,expression:expression('person.password_hash')}});
  assert.equal(invalid.status,400); assert.equal(invalid.body.reason,'invalid_expression');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,before);
});

test('unrelated stale defaults and unused legacy fields do not block a requested calculation',async()=>{
  const definitions=[{id:'old_place',type:'location',kind:'value',default_value:999999},
    {id:'old_member',type:'household_member',kind:'value',default_value:999999},
    {id:'unused',type:'text',kind:'field'}, {id:'visible',type:'text',expression:expression('"Ready"')}];
  const result=resolveVariables(db,definitions,{}, {keys:['visible']});
  assert.equal(result.values.visible,'Ready');
  assert.deepEqual(result.persisted,{visible:'Ready'});
  const activityResult=await call('POST','/admin/activity-templates',{name:'Legacy',title_template:'Still works',assignment_strategy:'open_claimable',subject_required:false});
  const workflowResult=await call('POST','/admin/workflow-templates',{name:'Legacy workflow',subject_required:false,input_schema:[{id:'unused',label:'Unused',type:'text'}],steps:[{step_key:'work',activity_template_id:activityResult.body.data.id}]});
  assert.equal(workflowResult.status,201,JSON.stringify(workflowResult.body));
  assert.equal((await call('POST',`/quick-add/${workflowResult.body.data.id}/create`,{inputs:{}})).status,201);
});

test('entity hydration rejects coercible objects and inactive transitive dependencies',()=>{
  for(const type of ['household_member','location']) for(const value of [true,[1],['1'],{id:1},'',9007199254740992]) {
    assert.throws(()=>resolveVariables(db,[{id:'entity',type}],{entity:value},{keys:['entity']}),/valid household member|active Place/);
  }
  assert.throws(()=>resolveVariables(db,[{id:'off',type:'text',active:0,default_value:'Disabled'},
    {id:'a',type:'text',expression:expression('off')},{id:'b',type:'text',expression:expression('a')}],{}, {keys:['b']}),/inactive/);
});

test('invalid unselected branches and oversized previews are rejected before writes',async()=>{
  const invalid=await call('POST','/admin/variables',{variable_key:'bad_branch',label:'Invalid',type:'text',expression:expression('if(true, "ok", unknown_key)')});
  assert.equal(invalid.status,400);
  const oversized=await call('POST','/admin/variables/preview',{variable:{variable_key:'constant',type:'text',expression:expression('"ok"')},definitions:Array.from({length:101},(_,i)=>({id:`x${i}`,type:'text'}))});
  assert.equal(oversized.status,400); assert.match(oversized.body.error,/100/);
});

test('workflow preview and actual generated tasks use the selected member; instances snapshot IDs and computed values',async()=>{
  activity = await createActivity('Prepare {{who}}',[{title_template:'Wash {{who}} sheets'}]);
  workflow = await createWorkflow(activity,[{id:'who',label:'Name',type:'text',reusable_definition_id:who.id}]);
  assert.equal(workflow.input_schema.find(row=>row.id==='who').expression.source,who.expression.source);
  assert.ok(workflow.input_schema.some(row=>row.id==='person'));
  for (const [id,name] of [[alex,'Lex'],[sam,'Sam'],[blank,'Household member']]) {
    const preview = await call('POST',`/quick-add/${workflow.id}/preview`,{inputs:{person:id,who:'Spoofed'}});
    assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.data.steps[0].title,`Prepare ${name}`);
    const created = await call('POST',`/quick-add/${workflow.id}/create`,{inputs:{person:id,who:'Spoofed'}});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const instance = db.prepare('SELECT * FROM workflow_instances ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual(JSON.parse(instance.input_json),{person:id,who:name});
    const task = db.prepare('SELECT t.* FROM tasks t JOIN workflow_instance_tasks it ON it.task_id=t.id WHERE it.workflow_instance_id=? AND it.role=\'primary\'').get(instance.id);
    assert.equal(task.title,`Prepare ${name}`);
    assert.equal(db.prepare('SELECT title FROM tasks WHERE parent_task_id=?').get(task.id).title,`Wash ${name} sheets`);
  }
});

test('missing or spoofed member input cannot create tasks or instances',async()=>{
  const counts=()=>[db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,db.prepare('SELECT COUNT(*) AS n FROM workflow_instances').get().n];
  const before=counts();
  for (const inputs of [{},{person:{id:alex,nickname:'Spoofed'}},{person:999999}]) {
    const result=await call('POST',`/quick-add/${workflow.id}/create`,{inputs});
    assert.equal(result.status,400,JSON.stringify(result.body)); assert.deepEqual(counts(),before);
  }
});

test('linked reusable edits are canonical on the next run and do not rewrite created tasks',async()=>{
  const oldTitles=db.prepare('SELECT id,title FROM tasks ORDER BY id').all();
  const update=await call('PUT',`/admin/variables/${who.id}`,{expression:expression('upper(coalesce(person.first_name, person.display_name))')});
  assert.equal(update.status,200,JSON.stringify(update.body));
  const preview=await call('POST',`/quick-add/${workflow.id}/preview`,{inputs:{person:sam}});
  assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.data.steps[0].title,'Prepare SAM');
  assert.deepEqual(db.prepare('SELECT id,title FROM tasks ORDER BY id').all(),oldTitles);
});

test('ordinary members resolve a standalone Activity draft with the same engine and no Task writes',async()=>{
  const before=db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const result=await call('POST',`/activity-templates/${activity.id}/resolve`,{inputs:{person:alex}},'member');
  assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(result.body.data.title,'Prepare ALEX');
  assert.equal(result.body.data.checklist[0].title_template,'Wash ALEX sheets');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,before);
  const denied=await call('POST','/admin/variables/preview',{variable:who,inputs:{person:alex}},'member');
  assert.equal(denied.status,403);
});

test('dependent deletion is blocked and key rename updates expressions and linked metadata while preserving identity',async()=>{
  assert.equal((await call('DELETE',`/admin/variables/${person.id}`)).status,409);
  const renamed=await call('PUT',`/admin/variables/${person.id}/key`,{variable_key:'selected_person'});
  assert.equal(renamed.status,200,JSON.stringify(renamed.body)); assert.equal(renamed.body.data.id,person.id);
  const source=JSON.parse(db.prepare('SELECT expression_json FROM household_variable_definitions WHERE id=?').get(who.id).expression_json).source;
  assert.match(source,/selected_person\.first_name/);
  const preview=await call('POST',`/quick-add/${workflow.id}/preview`,{inputs:{selected_person:sam}});
  assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.data.steps[0].title,'Prepare SAM');
});

test('cycle and invalid-result-type changes are rejected before a definition changes',async()=>{
  const a=await createVariable('cycle_a','text',{expression:expression('"start"')});
  await createVariable('cycle_b','text',{expression:expression('cycle_a')});
  const cycle=await call('PUT',`/admin/variables/${a.id}`,{expression:expression('cycle_b')});
  assert.equal(cycle.status,400); assert.match(cycle.body.error,/cycle|circular/i);
  const mismatch=await call('PUT',`/admin/variables/${a.id}`,{expression:expression('true')});
  assert.equal(mismatch.status,400);
  assert.equal(JSON.parse(db.prepare('SELECT expression_json FROM household_variable_definitions WHERE id=?').get(a.id).expression_json).source,'"start"');
});

test('context metadata and saved scalar defaults are resolved server-side with precise false and zero values',async()=>{
  await createVariable('has_pet','boolean',{kind:'value',default_value:false});
  await createVariable('pet_count','number',{kind:'value',default_value:0});
  const contextual=await createVariable('context_name','text',{expression:expression('if(has_pet == false, coalesce(context.household_member.nickname, context.household_member.display_name), "Pets")')});
  const missing=await call('POST','/admin/variables/preview',{variable:contextual}); assert.equal(missing.status,422);
  const preview=await call('POST','/admin/variables/preview',{variable:contextual,subject_user_id:alex});
  assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.data.value,'Lex');
  const zero=await call('POST','/admin/variables/preview',{variable:{variable_key:'zero_check',label:'Zero',type:'boolean',expression:expression('pet_count == 0')}});
  assert.equal(zero.status,200,JSON.stringify(zero.body)); assert.equal(zero.body.data.value,true);
});

test('Task creation revalidates Activity inputs and preserves manual edits while copying resolved subtasks',async()=>{
  const save=async body=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const before=db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const missing=await save({title:'Manual title',activity_template_id:activity.id});
  assert.equal(missing.status,400,JSON.stringify(missing.body));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,before);
  const created=await save({title:'My edited title',description:'My edited description',activity_template_id:activity.id,activity_inputs:{selected_person:sam}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal(created.body.data.title,'My edited title'); assert.equal(created.body.data.description,'My edited description');
  assert.equal(created.body.data.subtasks[0].title,'Wash SAM sheets');
  const defaulted=await save({activity_template_id:activity.id,activity_inputs:{selected_person:alex},subtasks:[{title:'Custom subtask'}]});
  assert.equal(defaulted.status,201,JSON.stringify(defaulted.body));
  assert.equal(defaulted.body.data.title,'Prepare ALEX'); assert.equal(defaulted.body.data.subtasks[0].title,'Custom subtask');
});

test('recurring Activity supervision uses the frozen Task title when no authoring inputs are retained',()=>{
  const skill=Number(db.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES ('Supervised cooking',0,'supervised',?)").run(alex).lastInsertRowid);
  for (const [id,proficiency] of [[alex,'normal'],[sam,'supervised']]) db.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES (?,?,?,'manual',?)").run(id,skill,proficiency,alex);
  const activityId=Number(db.prepare("INSERT INTO activity_templates(name,title_template,category,assignment_strategy,subject_required,supervision_title_template,created_by) VALUES ('Cook','Cook {{who}}','misc','subject_skill',1,'Help {{who}} cook',?)").run(alex).lastInsertRowid);
  db.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES (?,?,0)').run(activityId,skill);
  const task=()=>Number(db.prepare("INSERT INTO tasks(title,category,created_by) VALUES ('Cook SAM','misc',?)").run(alex).lastInsertRowid);
  const source=task();
  applyTaskActivityBinding(db,source,{activityTemplateId:activityId,subjectUserId:sam,variableLabels:{who:'SAM'}});
  const support=id=>db.prepare('SELECT t.title FROM tasks t JOIN task_activity_support_tasks s ON s.task_id=t.id WHERE s.source_task_id=?').get(id)?.title;
  assert.equal(support(source),'Help SAM cook');
  const next=task(); copyTaskActivityBinding(db,source,next);
  assert.equal(support(next),'Supervise Sam Rivers: Cook SAM');
  assert.doesNotMatch(support(next),/\{\{/);
});
