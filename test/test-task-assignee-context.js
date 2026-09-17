import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='assignee-context-isolated';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
let d,admin,eleanor,other,server,base;
async function call(method,path,body){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,...await response.json()};}
async function activity(extra={}){
  const result=await call('POST','/automation/admin/activity-templates',{name:'Get Ready for School',title_template:'{{assignee.first_name}} Get Ready for School',
    assignment_strategy:'subject_skill',subject_required:1,allow_assignment_override:1,presence_policy:'ignore',skill_ids:[],...extra});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
test.beforeEach(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=name=>Number(d.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role) VALUES(?,?,?,'x','admin','parent')").run(name,name,name).lastInsertRowid);
  admin=user('Admin');eleanor=user('Eleanor');other=user('Alex');
  d.prepare("INSERT INTO household_variable_definitions(variable_key,label,type,kind,default_value_json,expression_json) VALUES('assignee','Assignee','household_member','value',NULL,NULL)").run();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=admin;req.authRole='admin';req.session={userId:admin,role:'admin'};next();});
  app.use('/automation',automationRouter);app.use('/tasks',tasksRouter);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});

// This regression intentionally needs no migration10036 fields: it also runs
// unchanged against2136239b to reproduce the production error before the fix.
test('unconfigured Assignee value resolves selected Eleanor rather than an invisible missing input',async()=>{
  const template=await activity();
  const clock=d.prepare('SELECT version FROM task_change_clock').get().version;
  const result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor,inputs:{}});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Eleanor Get Ready for School');
  assert.equal(result.data.inputs.assignee,eleanor);assert.deepEqual(result.input_schema,[]);
  assert.equal(d.prepare('SELECT version FROM task_change_clock').get().version,clock,'preview does not mutate lifecycle');
  const saved=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:eleanor,activity_inputs:result.data.inputs});
  assert.equal(saved.status,201,JSON.stringify(saved));assert.equal(saved.data.title,'Eleanor Get Ready for School');assert.equal(saved.data.assigned_to,eleanor);
});

test('contextual Assignee uses fixed or permitted override eligibility result instead of the selected subject',async()=>{
  const template=await activity({assignment_strategy:'fixed',fixed_user_id:other,subject_required:0});
  let result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor,inputs:{}});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Alex Get Ready for School');
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:other,assigned_to:[eleanor],inputs:{}});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Eleanor Get Ready for School');
  const saved=await call('POST','/tasks',{activity_template_id:template.id,assigned_to:[eleanor],activity_subject_user_id:other});
  assert.equal(saved.status,201,JSON.stringify(saved));assert.equal(saved.data.title,'Eleanor Get Ready for School');assert.equal(saved.data.assigned_to,eleanor);
  d.prepare('UPDATE activity_templates SET allow_assignment_override=0 WHERE id=?').run(template.id);
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:other,assigned_to:[eleanor]});assert.equal(result.status,400);
});

test('configured Assignee defaults and expressions and arbitrary member variables retain their authored meaning',async()=>{
  const template=await activity();
  d.prepare("UPDATE household_variable_definitions SET default_value_json=? WHERE variable_key='assignee'").run(JSON.stringify(other));
  let result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Alex Get Ready for School');
  d.prepare("UPDATE household_variable_definitions SET default_value_json=NULL,expression_json=? WHERE variable_key='assignee'").run(JSON.stringify({version:1,source:'context.household_member'}));
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Eleanor Get Ready for School');
  d.prepare("INSERT INTO household_variable_definitions(variable_key,label,type,kind) VALUES('reviewer','Reviewer','household_member','value')").run();
  d.prepare("UPDATE activity_templates SET title_template='{{reviewer.first_name}} reviews' WHERE id=?").run(template.id);
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor});
  assert.equal(result.status,422);assert.match(result.error,/Reviewer/);
  d.prepare("UPDATE household_variable_definitions SET kind='field',expression_json=NULL WHERE variable_key='assignee'").run();
  d.prepare("UPDATE activity_templates SET title_template='{{assignee.first_name}} chooses' WHERE id=?").run(template.id);
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor});assert.equal(result.status,422);
  result=await call('POST',`/automation/activity-templates/${template.id}/resolve`,{subject_user_id:eleanor,inputs:{assignee:other}});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.title,'Alex chooses');
});

for(const allowOverride of [0,1])test(`unchanged subject assignment stays dynamic during a title edit with overrides ${allowOverride?'allowed':'disabled'}`,async()=>{
  const template=await activity({allow_assignment_override:allowOverride});
  const created=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:eleanor});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id;
  const binding=()=>d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(id);
  const revision=()=>d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
  const originalBinding=binding();
  const edited=await call('PUT',`/tasks/${id}`,{title:'Renamed school routine',assigned_to:[eleanor],expected_revision:revision()});
  assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(edited.data.title,'Renamed school routine');
  assert.equal(edited.data.assigned_to,eleanor);assert.deepEqual(binding(),originalBinding);
  assert.equal(d.prepare('SELECT strategy FROM task_assignment_context WHERE task_id=?').get(id).strategy,'subject_skill');
  const changed=await call('PUT',`/tasks/${id}`,{assigned_to:[other],expected_revision:revision()});
  assert.equal(changed.status,allowOverride?200:400,JSON.stringify(changed));
  assert.equal(binding().assignment_override_user_id,allowOverride?other:null);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,allowOverride?other:eleanor);
  if(allowOverride){
    d.prepare('UPDATE activity_templates SET allow_assignment_override=0 WHERE id=?').run(template.id);
    const historicalBinding=binding();
    const renamed=await call('PUT',`/tasks/${id}`,{title:'Keep existing choice',assigned_to:[other],expected_revision:revision()});
    assert.equal(renamed.status,200,JSON.stringify(renamed));assert.deepEqual(binding(),historicalBinding);
  }
});

test('changing the subject with an echoed old assignee follows the new subject without inventing an override',async()=>{
  for(const allowOverride of [0,1]){
    const template=await activity({name:`Subject switch ${allowOverride}`,allow_assignment_override:allowOverride});
    const created=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:eleanor});
    assert.equal(created.status,201,JSON.stringify(created));
    const edited=await call('PUT',`/tasks/${created.data.id}`,{activity_subject_user_id:other,assigned_to:[eleanor],expected_revision:created.data.revision});
    assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(edited.data.assigned_to,other);
    assert.equal(edited.data.activity_subject_user_id,other);assert.equal(edited.data.activity_assignment_override_user_id,null);
  }
});
