import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='rotation-security-test-session';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveRotationGroup}=await import('../server/services/rotation.js');
const {instantiateWorkflow}=await import('../server/services/activity-workflows.js');
const {bindTaskRotations}=await import('../server/services/task-rotation.js');
const {hydrateTask,default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:rotationsRouter}=await import('../server/routes/rotations.js');
const {default:readerRouter}=await import('../server/routes/reader.js');
const {publicTaskProjection}=await import('../server/services/wall.js');
const {wallSessionAllows}=await import('../server/services/wall-session.js');
const {callTool}=await import('../server/mcp/tools.js');
const {moduleForPath,tokenAllows,requiredAccess}=await import('../server/scopes.js');
const {default:idempotencyMiddleware}=await import('../server/middleware/idempotency.js');

function fixture(){
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const add=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'test',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  const admin=add('Admin','admin'),member=add('Member'),other=add('Other');
  const group=saveRotationGroup(d,{name:'Private rotation configuration',member_ids:[member,other]},{actorId:admin});
  const binding={purpose_key:'shared_order',label:'Private purpose marker',group_id:group.id,strategy:'rotating_order',advance_policy:'on_completed'};
  const activity=Number(d.prepare("INSERT INTO activity_templates(name,title_template,subject_required,assignment_strategy,assignment_policy,category,rotation_bindings_json) VALUES('Bound Activity','Position {{shared_order.position}}',0,'fixed','fixed','misc',?)").run(JSON.stringify([binding])).lastInsertRowid);
  const workflow=Number(d.prepare("INSERT INTO workflow_templates(name,subject_required,input_schema_json,rotation_bindings_json) VALUES('Activity-local rotation',0,'[]','[]')").run().lastInsertRowid);
  d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id) VALUES(?,?,'one',0,'fixed',?)").run(workflow,activity,member);
  const capability=(key,access)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(member),key,access);
  return {d,admin,member,other,group,binding,activity,workflow,capability};
}
const withFixture=fn=>async()=>{const f=fixture();try{await fn(f);assert.deepEqual(f.d.pragma('foreign_key_check'),[]);}finally{_setTestDatabase(null);f.d.close();}};
async function serve(f,run){
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=Number(req.headers['x-user'])||f.member;req.authRole=req.authUserId===f.admin?'admin':'member';req.session={userId:req.authUserId,role:req.authRole,wallMode:req.headers['x-wall']==='1'};next();});app.use(idempotencyMiddleware);app.use('/tasks',tasksRouter);app.use('/automation',rotationsRouter);app.use('/automation',automationRouter);app.use('/reader',readerRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const request=async(method,path,body,headers={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});const text=await response.text();return {status:response.status,text,body:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null};};
  try{await run(request);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('Workflow previews and creation honor Rotation view permission for Activity-local purposes',withFixture(async f=>{
  f.capability('rotations.view','none');f.capability('rotations.configure','allow');
  await serve(f,async request=>{
    const preview=await request('POST',`/automation/quick-add/${f.workflow}/preview`,{});
    assert.equal(preview.status,403);assert.doesNotMatch(preview.text,/Position 1/);
    const created=await request('POST',`/automation/quick-add/${f.workflow}/create`,{request_key:'denied-child-rotation'});
    assert.equal(created.status,403);
    assert.equal(f.d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
  });
}));

test('Workflow retry rechecks revoked Rotation access even after current templates remove the binding',withFixture(f=>{
  f.capability('rotations.configure','allow');
  const options={createdBy:f.member,requestKey:'saved-child-rotation'};
  const created=instantiateWorkflow(f.d,f.workflow,options);
  assert.equal(created.rotations.length,0,'this is an Activity-local binding');
  f.d.prepare("UPDATE activity_templates SET rotation_bindings_json='[]',title_template='Ordinary Activity' WHERE id=?").run(f.activity);
  f.capability('rotations.view','none');
  assert.throws(()=>instantiateWorkflow(f.d,f.workflow,options),error=>error.status===403);
  f.d.prepare('DELETE FROM tasks WHERE id=? OR parent_task_id=?').run(created.parent_task_id,created.parent_task_id);
  assert.throws(()=>instantiateWorkflow(f.d,f.workflow,options),error=>error.status===403,'deleted Tasks cannot erase the saved response permission boundary');
  assert.equal(f.d.prepare('SELECT count(*) n FROM workflow_instances').get().n,1);
}));

test('HTTP idempotency headers cannot replay a Workflow preview or creation after Rotation view is revoked',withFixture(async f=>{
  f.capability('rotations.configure','allow');
  await serve(f,async request=>{
    const previewPath=`/automation/quick-add/${f.workflow}/preview`,createPath=`/automation/quick-add/${f.workflow}/create`;
    const previewHeaders={'idempotency-key':'preview-before-revocation'},createHeaders={'idempotency-key':'creation-before-revocation'},body={request_key:'durable-workflow-retry'};
    assert.equal((await request('POST',previewPath,{},previewHeaders)).status,200);
    const created=await request('POST',createPath,body,createHeaders);assert.equal(created.status,201);
    assert.deepEqual((await request('POST',createPath,body,createHeaders)).body,created.body);
    f.capability('rotations.view','none');
    assert.equal((await request('POST',previewPath,{},previewHeaders)).status,403);
    f.d.prepare("UPDATE activity_templates SET rotation_bindings_json='[]',title_template='Ordinary Activity' WHERE id=?").run(f.activity);
    f.d.prepare('DELETE FROM tasks WHERE id=? OR parent_task_id=?').run(created.body.data.parent_task_id,created.body.data.parent_task_id);
    assert.equal((await request('POST',createPath,body,createHeaders)).status,403);
    assert.equal(f.d.prepare('SELECT count(*) n FROM workflow_instances').get().n,1);
  });
}));

test('header-only non-Rotation Workflow creation stays idempotent and cached typed history still requires permission',withFixture(async f=>{
  const task=Number(f.d.prepare("INSERT INTO tasks(title,created_by,rotation_bindings_json) VALUES('Snapshot owner',?,?)").run(f.admin,JSON.stringify([f.binding])).lastInsertRowid);
  bindTaskRotations(f.d,task,{actorId:f.admin});
  const occurrence=f.d.prepare('SELECT occurrence_id FROM task_rotation_occurrences WHERE task_id=?').get(task).occurrence_id;
  f.d.prepare("UPDATE activity_templates SET rotation_bindings_json='[]',title_template='Historical {{past}}' WHERE id=?").run(f.activity);
  f.d.prepare('UPDATE workflow_templates SET input_schema_json=? WHERE id=?').run(JSON.stringify([{id:'past',label:'Past',type:'rotation_occurrence'}]),f.workflow);
  await serve(f,async request=>{
    const path=`/automation/quick-add/${f.workflow}/create`,body={inputs:{past:occurrence}},headers={'idempotency-key':'header-only-history'};
    const created=await request('POST',path,body,headers);assert.equal(created.status,201);
    assert.deepEqual((await request('POST',path,body,headers)).body,created.body);
    assert.equal(f.d.prepare('SELECT count(*) n FROM workflow_instances').get().n,1);
    assert.equal(f.d.prepare('SELECT count(*) n FROM rotation_workflow_requests').get().n,0,'header-only requests retain the existing cache contract');
    f.d.prepare("UPDATE activity_templates SET title_template='Ordinary Activity' WHERE id=?").run(f.activity);
    f.d.prepare("UPDATE workflow_templates SET input_schema_json='[]' WHERE id=?").run(f.workflow);
    f.d.prepare('DELETE FROM tasks WHERE id=? OR parent_task_id=?').run(created.body.data.parent_task_id,created.body.data.parent_task_id);
    f.capability('rotations.history','none');
    assert.equal((await request('POST',path,body,headers)).status,403);
  });
}));

test('Group creation and native occurrence commands recheck capabilities before any HTTP replay',withFixture(async f=>{
  f.capability('rotations.manage','allow');f.capability('rotations.override','allow');
  const task=Number(f.d.prepare("INSERT INTO tasks(title,created_by,rotation_bindings_json) VALUES('Snapshot owner',?,?)").run(f.admin,JSON.stringify([f.binding])).lastInsertRowid);
  bindTaskRotations(f.d,task,{actorId:f.admin});
  const occurrence=f.d.prepare('SELECT occurrence_id FROM task_rotation_occurrences WHERE task_id=?').get(task).occurrence_id;
  await serve(f,async request=>{
    const body={name:'Cached Group creation',member_ids:[f.member,f.other]},headers={'idempotency-key':'create-group-once'};
    const created=await request('POST','/automation/rotation-groups',body,headers);assert.equal(created.status,201);
    assert.deepEqual((await request('POST','/automation/rotation-groups',body,headers)).body,created.body);
    f.capability('rotations.manage','none');assert.equal((await request('POST','/automation/rotation-groups',body,headers)).status,403);
    const overridePath=`/automation/rotation-occurrences/${occurrence}/override`,override={expected_revision:1,member_ids:[f.other,f.member]},overrideHeaders={'idempotency-key':'override-once'};
    assert.equal((await request('POST',overridePath,override,overrideHeaders)).status,200);
    f.capability('rotations.override','none');assert.equal((await request('POST',overridePath,override,overrideHeaders)).status,403);
  });
}));

for(const kind of ['Task','Activity Template','Workflow Template'])test(`cached ${kind} creation cannot expose Rotation configuration after view or configure revocation`,withFixture(async f=>{
  for(const capability of ['rotations.configure','activities.create','workflows.create'])f.capability(capability,'allow');
  await serve(f,async request=>{
    let path='/tasks',body={title:'Cached Task',assigned_to:[f.member],rotation_bindings:[f.binding]};
    if(kind!=='Task') {
      path=kind==='Activity Template'?'/automation/admin/activity-templates':'/automation/admin/workflow-templates';
      const source=await request('GET',path);assert.equal(source.status,200);
      body={...source.body.data[0],name:`Cached ${kind}`,rotation_bindings:[f.binding]};
      if(kind==='Activity Template')body.fixed_user_id=f.member;
    }
    const headers={'idempotency-key':`cached-${kind.replaceAll(' ','-')}`};
    const created=await request('POST',path,body,headers);assert.equal(created.status,201,created.text);
    assert.deepEqual((await request('POST',path,body,headers)).body,created.body);
    f.capability('rotations.view','none');assert.equal((await request('POST',path,body,headers)).status,403);
    f.capability('rotations.view','allow');f.capability('rotations.configure','none');assert.equal((await request('POST',path,body,headers)).status,403);
  });
}));

test('Task serialization removes Rotation context/configuration when viewing is denied and strips sensitive history for viewers',withFixture(f=>{
  const task=Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,rotation_bindings_json) VALUES('Ordinary visible Task',?,?,?)").run(f.admin,f.member,JSON.stringify([f.binding])).lastInsertRowid);
  bindTaskRotations(f.d,task,{actorId:f.admin});
  f.capability('rotations.view','none');
  let result=JSON.parse(JSON.stringify(hydrateTask({id:task},f.member)));
  assert.deepEqual(result.rotations,[]);assert.deepEqual(result.rotation_bindings,[]);assert.equal(result.rotation_bindings_json,undefined);
  f.capability('rotations.view','allow');f.capability('rotations.history','none');
  result=JSON.parse(JSON.stringify(hydrateTask({id:task},f.member)));
  assert.equal(result.rotations.length,1);
  for(const key of ['context','config','eligible','skipped','consumer_eligibility_json','original_order','override_actor_id'])assert.equal(result.rotations[0].occurrence[key],undefined,key);
  const wall=publicTaskProjection(f.d,result,f.admin);
  assert.equal(wall.rotations,undefined);assert.equal(wall.rotation_bindings,undefined);assert.equal(wall.rotation_bindings_json,undefined);
  assert.doesNotMatch(JSON.stringify(wall),/Private purpose marker|eligible_json|consumer_eligibility/);
}));

test('Wall session lock and Reader/MCP projections cannot expose Rotation configuration or bypass its APIs',withFixture(async f=>{
  const task=Number(f.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,rotation_bindings_json) VALUES('Ordinary visible Task',?,?,?)").run(f.admin,f.member,JSON.stringify([f.binding])).lastInsertRowid);
  bindTaskRotations(f.d,task,{actorId:f.admin});
  f.capability('rotations.view','none');
  for(const path of ['/api/v1/automation/rotation-groups','/api/v1/automation/rotation-occurrences/1','/api/v1/automation/quick-add/1/preview','/api/v1/automation/workflow-instances/1/rotations','/reader','/mcp'])assert.equal(wallSessionAllows({session:{wallMode:true},originalUrl:path}),false,path);
  assert.equal(wallSessionAllows({session:{wallMode:true},originalUrl:'/api/v1/tasks/changes'}),true);
  await serve(f,async request=>{
    const reader=await request('GET','/reader?view=tasks');assert.equal(reader.status,200);assert.match(reader.text,/Ordinary visible Task/);assert.doesNotMatch(reader.text,/Private purpose marker|rotation_bindings|eligible_json/);
    assert.equal((await request('GET','/reader?view=tasks',null,{'x-wall':'1'})).status,423);
  });
  const values=await callTool({db:f.d,actor:{id:f.member,scopes:['tasks:read'],moduleAccess:null}},'list_tasks',{});
  assert.ok(values.some(value=>value.id===task));assert.doesNotMatch(JSON.stringify(values),/Private purpose marker|rotation_bindings|eligible_json/);
  await assert.rejects(()=>callTool({db:f.d,actor:{id:f.member,scopes:['family:read'],moduleAccess:null}},'list_tasks',{}),/not permitted/);
}));

test('Rotation integration endpoints require their consumer scope as well as account capabilities',()=>{
  for(const path of ['/automation/rotation-groups','/automation/rotation-occurrences/1/override'])assert.equal(moduleForPath(path),'family');
  for(const path of ['/automation/workflow-instances/1/rotations','/automation/workflow-instances/1/rotations/shared_order/outcome'])assert.equal(moduleForPath(path),'tasks');
  assert.equal(tokenAllows(['tasks:read'],moduleForPath('/automation/rotation-groups'),requiredAccess('GET')),false);
  assert.equal(tokenAllows(['tasks:read'],moduleForPath('/automation/workflow-instances/1/rotations'),requiredAccess('GET')),true);
  assert.equal(tokenAllows(['tasks:read'],moduleForPath('/automation/workflow-instances/1/rotations/shared_order/outcome'),requiredAccess('POST')),false);
});
