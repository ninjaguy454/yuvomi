import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-rotation-task-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter,reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:rotationsRouter}=await import('../server/routes/rotations.js');
const {saveRotationGroup,getRotationTrack,getRotationOccurrence,finalizeRotation}=await import('../server/services/rotation.js');
const {expireTask,reopenExpiredTask}=await import('../server/services/task-lifecycle.js');
const {taskRotationContexts,bindTaskRotations}=await import('../server/services/task-rotation.js');
const {registerRecurrenceOccurrence}=await import('../server/services/task-recurrence-frontier.js');
const {recordOccurrenceDefinition,registerSeriesAction,taskSeriesState}=await import('../server/services/task-series.js');
let d,admin,grace,eleanor,frankie,group,server,base;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-19T20:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  admin=user('Parent','admin');grace=user('Grace','member');eleanor=user('Eleanor','member');frankie=user('Frankie','member');
  for(const userId of [grace,eleanor,frankie])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(userId);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  group=saveRotationGroup(d,{name:'Kids',member_ids:[grace,eleanor,frankie]},{actorId:admin});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{const id=Number(req.headers['x-test-user'])||admin;
    const role=d.prepare('SELECT role FROM users WHERE id=?').get(id).role;req.authUserId=id;req.authRole=role;req.session={userId:id,role};next();});
  app.use('/tasks',tasksRouter);app.use('/automation',automationRouter);app.use('/automation',rotationsRouter);
  // Windows can allocate an ephemeral port in Fetch's reserved-port list.
  const blocked=new Set([1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
  do {
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    if(server.address().port>=1024&&!blocked.has(server.address().port))break;
    await new Promise(resolve=>server.close(resolve));
  }while(true);
  base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(id);
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
const binding=(extra={})=>({purpose_key:'shower_order',label:'Shower Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_finalized',...extra});
const ownerLink=id=>d.prepare('SELECT * FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').get(id);
async function call(method,path,body,actor=admin){
  if(body&&/^\/tasks\/\d+/.test(path)&&['PUT','PATCH'].includes(method)){
    const current=row(Number(path.split('/')[2]));body={expected_revision:current.revision,
      ...(current.parent_task_id?{expected_parent_revision:row(current.parent_task_id).revision}:{}),...body};}
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-test-user':String(actor)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();return{status:response.status,...text?JSON.parse(text):{}};
}
async function create(extra={}){
  const result=await call('POST','/tasks',{title:'Get Ready for Bed',assigned_to:[grace],start_date:'2026-09-19',start_time:'15:00',due_date:'2026-09-19',due_time:'20:00',
    is_recurring:true,recurrence_rule:'FREQ=DAILY',due_date_offset_days:0,rotation_bindings:[binding()],points:2,
    subtasks:[{title:'Grace: Take shower',assigned_user_ids:[grace]},{title:'Eleanor: Take shower',assigned_user_ids:[eleanor]},{title:'Frankie: Take shower',assigned_user_ids:[frankie]}],...extra});
  assert.equal(result.status,201,JSON.stringify(result));
  return (await call('GET',`/tasks/${result.data.id}`)).data;
}
async function finish(id){const result=await call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true});assert.equal(result.status,200,JSON.stringify(result));return result;}
async function edit(id,extra,scope='future'){
  const current=(await call('GET',`/tasks/${id}`)).data;
  return call('PUT',`/tasks/${id}`,{edit_scope:scope,...(scope==='future'?{expected_series_revision:current.recurrence_series_revision}:{}),...extra});
}
function materializeAhead(sourceId){
  const source=row(sourceId),state=taskSeriesState(d,sourceId);
  const id=Number(d.prepare(`INSERT INTO tasks(title,description,created_by,assigned_to,start_date,start_time,due_date,due_time,
    is_recurring,recurrence_rule,recurrence_origin_id,rotation_bindings_json,due_date_offset_days,points)
    VALUES(?,?,?,?,'2026-09-20',?,'2026-09-20',?,1,?,?,?,?,?)`).run(source.title,source.description,source.created_by,source.assigned_to,
      source.start_time,source.due_time,source.recurrence_rule,sourceId,source.rotation_bindings_json,source.due_date_offset_days,source.points).lastInsertRowid);
  registerRecurrenceOccurrence(d,id,{predecessorId:sourceId});
  d.prepare('INSERT INTO task_assignments(task_id,user_id) SELECT ?,user_id FROM task_assignments WHERE task_id=?').run(id,sourceId);
  for(const step of children(sourceId)){
    const childId=Number(d.prepare(`INSERT INTO tasks(title,created_by,parent_task_id,assigned_to,start_date,start_time,due_date,due_time,is_optional,sort_order)
      VALUES(?,?,?,?,'2026-09-20',?,'2026-09-20',?,?,?)`).run(step.title,step.created_by,id,step.assigned_to,step.start_time,step.due_time,step.is_optional,step.sort_order).lastInsertRowid);
    const action=d.prepare('SELECT action_key FROM task_recurrence_actions WHERE task_id=?').get(step.id);
    registerSeriesAction(d,childId,id,action.action_key);
    d.prepare('INSERT INTO task_assignments(task_id,user_id) SELECT ?,user_id FROM task_assignments WHERE task_id=?').run(childId,step.id);
  }
  bindTaskRotations(d,id,{actorId:admin});recordOccurrenceDefinition(d,id,{definitionId:state.definition.id,baseline:true});
  return id;
}

const {instantiateWorkflow}=await import('../server/services/activity-workflows.js');
const {overrideRotation}=await import('../server/services/rotation.js');
const {refreshRotationTaskRendering}=await import('../server/services/task-rotation-rendering.js');

test('F2: Workflow override recomputes frozen title, description and checklist expressions; manual and historical text stays intact',()=>{
  const activity=Number(d.prepare(`INSERT INTO activity_templates(name,title_template,description,subject_required,assignment_strategy,assignment_policy)
    VALUES('Bedtime','Bed {{shower_order.position}}','Turn {{shower_order.position}}',0,'fixed','fixed')`).run().lastInsertRowid);
  d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template,sort_order) VALUES(?,'Shower {{shower_order.position}}',0)").run(activity);
  const workflow=Number(d.prepare("INSERT INTO workflow_templates(name,subject_required,rotation_bindings_json) VALUES('Night',0,?)").run(JSON.stringify([binding()])).lastInsertRowid);
  [grace,eleanor,frankie].forEach((id,i)=>d.prepare(`INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id,title_override,description_override)
    VALUES(?,?,?,?,'fixed',?,'Ready {{shower_order.position}}','My turn {{shower_order.position}}')`).run(workflow,activity,`child_${i}`,i,id));
  const result=instantiateWorkflow(d,workflow,{createdBy:admin,startDate:'2026-09-19',requestKey:'closure_night_one'});
  const tasks=result.tasks.filter(value=>value.role==='primary');
  // A manually changed field detaches; other bound fields continue to reconcile.
  d.prepare("UPDATE tasks SET title='My own words 99' WHERE id=?").run(tasks[0].task_id);
  const historicalChild=tasks[2].checklist_task_ids[0];
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(historicalChild);
  const historicalText=row(historicalChild).title;
  const occurrence=getRotationOccurrence(d,result.rotations[0].occurrence.id),original=occurrence.original_order;
  d.transaction(()=>{overrideRotation(d,occurrence.id,{member_ids:[frankie,grace,eleanor],expected_revision:occurrence.revision,actorId:admin});refreshRotationTaskRendering(d,occurrence.id);})();
  assert.equal(row(tasks[0].task_id).title,'My own words 99');
  [2,3,1].forEach((position,index)=>{
    const task=row(tasks[index].task_id);
    if(index)assert.equal(task.title,`Ready ${position}`);
    assert.equal(task.description,`My turn ${position}`);
    if(index!==2)assert.equal(row(tasks[index].checklist_task_ids[0]).title,`Shower ${position}`);
  });
  assert.equal(row(historicalChild).title,historicalText);
  assert.deepEqual(getRotationOccurrence(d,occurrence.id).original_order,original);
});

for(const operation of ['change','add','remove'])test(`F3: occurrence-only ${operation} of one purpose preserves unrelated binding and position`,async()=>{
  const routine=await create({subtasks:[],rotation_bindings:[binding(),binding({purpose_key:'chores',label:'Chores'})]});
  await finish(routine.id);const current=next(routine.id);
  const before=taskRotationContexts(d,current.id).find(value=>value.purpose_key==='chores');
  const linkBefore=d.prepare("SELECT * FROM task_rotation_occurrences WHERE task_id=? AND purpose_key='chores' AND retired_at IS NULL").get(current.id);
  const trackBefore=getRotationTrack(d,before.occurrence.track_id);
  let config=JSON.parse(current.rotation_bindings_json);
  if(operation==='change')config[0].strategy='round_robin';
  if(operation==='add')config.push(binding({purpose_key:'extra',label:'Extra'}));
  if(operation==='remove')config=config.filter(value=>value.purpose_key!=='shower_order');
  const saved=await edit(current.id,{rotation_bindings:config},'occurrence');assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(taskRotationContexts(d,current.id).find(value=>value.purpose_key==='chores'),before);
  assert.deepEqual(d.prepare("SELECT * FROM task_rotation_occurrences WHERE task_id=? AND purpose_key='chores' AND retired_at IS NULL").get(current.id),linkBefore);
  assert.deepEqual(getRotationTrack(d,before.occurrence.track_id),trackBefore);
});

test('F4: edited participant assignments recompute bound checklist text without changing manually authored text',async()=>{
  const made=await call('POST','/automation/admin/activity-templates',{name:'Bedtime',title_template:'Bedtime',assignment_strategy:'fixed',fixed_user_id:grace,subject_required:false,
    recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],checklist:[grace,eleanor,frankie].map(()=>({title_template:'Take shower — {{shower_order.position}}'}))});
  assert.equal(made.status,201,JSON.stringify(made));
  const template=(await call('GET','/automation/admin/activity-templates')).data.find(value=>value.id===made.data.id);
  const routine=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:grace,start_date:'2026-09-19',subtasks:template.checklist.map((step,i)=>({title:'Take shower — 1',activity_template_checklist_item_id:step.id,assigned_user_ids:[[grace,eleanor,frankie][i]]}))});
  assert.equal(routine.status,201,JSON.stringify(routine));const id=routine.data.id;
  const result=await edit(id,{subtasks:children(id).map((child,i)=>({id:child.id,title:i===2?'Manually written 7':child.title,skill_ids:[],assigned_user_ids:[[eleanor,grace,frankie][i]]}))},'occurrence');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(children(id).map(child=>child.title),['Take shower — 2','Take shower — 1','Manually written 7']);
});

test('authored Workflow operations persist, resolve/reuse, authorize and finalize/skip idempotently through the run API',async()=>{
  const activity=await call('POST','/automation/admin/activity-templates',{name:'Bedtime step',title_template:'Bedtime',assignment_strategy:'fixed',fixed_user_id:grace,subject_required:false});
  const definition=await call('POST','/automation/admin/workflow-templates',{name:'Shared bedtime',subject_required:false,
    rotation_bindings:[binding({workflow_operations:['resolve','finalize','skip']})],steps:[{step_key:'grace',activity_template_id:activity.data.id}]});
  assert.equal(definition.status,201,JSON.stringify(definition));
  const instance=instantiateWorkflow(d,definition.data.id,{createdBy:admin,startDate:'2026-09-19',requestKey:'authored_run_one'});
  const owner=row(instance.parent_task_id),context=taskRotationContexts(d,owner)[0];
  const detail=(await call('GET',`/tasks/${owner.id}`)).data;
  assert.deepEqual(detail.workflow_rotation_operations.purposes[0].operations,['resolve','finalize','skip']);
  const path=`/automation/workflow-instances/${instance.id}/rotations/shower_order/operations/`;
  const body={expected_revision:owner.revision,expected_occurrence_revision:context.occurrence.revision};
  const denied=await call('POST',path+'finalize',body,eleanor);assert.equal(denied.status,403);
  const reuse=await call('POST',path+'resolve',body);assert.equal(reuse.status,200,JSON.stringify(reuse));
  assert.equal(reuse.data[0].occurrence.id,context.occurrence.id);
  const finalize=await call('POST',path+'finalize',body);assert.equal(finalize.status,200,JSON.stringify(finalize));
  const again=await call('POST',path+'finalize',body);assert.equal(again.status,200,JSON.stringify(again));
  assert.equal(getRotationTrack(d,context.occurrence.track_id).advance_count,1);
  assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE occurrence_id=? AND event_type='finalized'").get(context.occurrence.id).n,1);
  assert.equal(row(owner.id).status,'open');
  const nextRun=instantiateWorkflow(d,definition.data.id,{createdBy:admin,startDate:'2026-09-20',requestKey:'authored_run_two'});
  const nextOwner=row(nextRun.parent_task_id),nextContext=taskRotationContexts(d,nextOwner)[0];
  const skip=await call('POST',`/automation/workflow-instances/${nextRun.id}/rotations/shower_order/operations/skip`,
    {expected_revision:nextOwner.revision,expected_occurrence_revision:nextContext.occurrence.revision});
  assert.equal(skip.status,200,JSON.stringify(skip));assert.equal(skip.data[0].occurrence.status,'skipped');
  assert.equal(getRotationTrack(d,context.occurrence.track_id).advance_count,1);
});

test('recorded completion evidence stays separate from planned order and never orders bulk or tied records',async()=>{
  const routine=await create();const child=children(routine.id)[0];
  await finish(child.id);
  const detail=(await call('GET',`/tasks/${routine.id}`)).data;
  assert.ok(detail.rotations[0].recorded_completions.some(group=>group.events.some(event=>event.task_id===child.id)));
  assert.deepEqual(detail.rotations[0].occurrence.member_ids,[grace,eleanor,frankie]);
  await finish(routine.id);
  const after=(await call('GET',`/tasks/${routine.id}`)).data.rotations[0];
  assert.ok(after.recorded_completions.filter(group=>group.events.some(event=>event.bulk)).every(group=>group.unordered));
  assert.deepEqual(after.occurrence.member_ids,[grace,eleanor,frankie]);
  const evidence=after.recorded_completions.flatMap(group=>group.events);
  assert.equal(evidence.length,3);assert.equal(evidence.filter(event=>event.bulk).length,2);
});

test('Workflow resolve targets one purpose and reuses its snapshot without writing on a retry',async()=>{
  const activity=await call('POST','/automation/admin/activity-templates',{name:'Bedtime step',title_template:'Bedtime',assignment_strategy:'fixed',fixed_user_id:grace,subject_required:false});
  const definition=await call('POST','/automation/admin/workflow-templates',{name:'Two purposes',subject_required:false,
    rotation_bindings:[binding({workflow_operations:['resolve','finalize']}),binding({purpose_key:'chores',label:'Chores',workflow_operations:['resolve','skip']})],
    steps:[{step_key:'grace',activity_template_id:activity.data.id}]});
  assert.equal(definition.status,201,JSON.stringify(definition));
  const instance=instantiateWorkflow(d,definition.data.id,{createdBy:admin,startDate:'2026-09-19',requestKey:'specific_purpose_reuse'});
  const initial=taskRotationContexts(d,instance.parent_task_id),chores=initial.find(value=>value.purpose_key==='chores');
  // Simulate missing consumer links while canonical occurrence history survives;
  // resolution must restore only its explicitly authored purpose.
  d.prepare("UPDATE task_rotation_occurrences SET retired_at='2026-09-19T21:00:00Z' WHERE owner_task_id=?").run(instance.parent_task_id);
  const owner=row(instance.parent_task_id),beforeChores=getRotationTrack(d,chores.occurrence.track_id);
  const path=`/automation/workflow-instances/${instance.id}/rotations/shower_order/operations/resolve`,body={expected_revision:owner.revision};
  const restored=await call('POST',path,body);assert.equal(restored.status,200,JSON.stringify(restored));
  assert.equal(restored.data.find(value=>value.purpose_key==='shower_order').occurrence.id,initial.find(value=>value.purpose_key==='shower_order').occurrence.id);
  assert.equal(restored.data.find(value=>value.purpose_key==='chores').pending,true);
  assert.deepEqual(getRotationTrack(d,chores.occurrence.track_id),beforeChores);
  const before=d.prepare('SELECT total_changes() n').get().n;
  const replay=await call('POST',path,body);assert.equal(replay.status,200,JSON.stringify(replay));
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before,'read-only reuse never rewrites rendering or bindings');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,2);
});
