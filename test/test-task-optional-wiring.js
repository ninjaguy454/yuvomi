import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='optional-wiring-fixture';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {changeTaskStatus,expireTask}=await import('../server/services/task-lifecycle.js');
const {instantiateWorkflow,unresolvedDependencies}=await import('../server/services/activity-workflows.js');
let d,admin,eleanor,other,server,base;
const names=['Get dressed','Put pajamas / dirty clothes away','Make bed','Brush teeth','Brush / fix hair','Wash face','Put on socks and shoes','Get backpack / school items ready','Ready for the day'];
const description="Complete your morning routine so you're clean, dressed, organized, and ready for the day. Finish each required step before the morning deadline to complete the activity and earn your points.";
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY sort_order,id').all(id);
const successor=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
async function call(method,path,body,actorId=admin) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-user':String(actorId)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,...await response.json()};
}
async function template(extra={}) {
  const result=await call('POST','/automation/admin/activity-templates',{
    name:'Get Ready for the Day',title_template:'Get Ready for the Day',description,category:'misc',points:2,
    assignment_strategy:'fixed',fixed_user_id:eleanor,allow_assignment_override:true,
    start_time:'07:00',due_time:'08:00',recurrence_rule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',recurrence_from_completion:0,
    expiration_policy:'expire_incomplete',
    checklist:[...names.map(title_template=>({title_template})),{title_template:'Put in earrings',is_optional:true}],...extra});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
async function create(extra={}) {
  const result=await call('POST','/tasks',{title:'Morning routine',start_date:'2026-09-21',due_date:'2026-09-21',...extra});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;
}
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-21T11:30:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
  admin=user('Admin','admin');eleanor=user('Eleanor');other=user('Other member');
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(eleanor);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{const actor=d.prepare('SELECT id,role FROM users WHERE id=?').get(Number(req.headers['x-user'])||admin);req.authUserId=actor.id;req.authRole=actor.role;req.session={userId:actor.id,role:actor.role};next();});
  app.use('/tasks',tasksRouter);app.use('/automation',automationRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});

test('template create, catalogue, resolve, update and Task materialization retain optional step and reusable morning schedule',async()=>{
  const activity=await template();
  assert.equal(activity.description,description);
  assert.deepEqual(activity.checklist.map(row=>row.title_template),[...names,'Put in earrings']);
  assert.deepEqual(activity.checklist.map(row=>row.is_optional),[0,0,0,0,0,0,0,0,0,1]);
  const options=await call('GET','/automation/activity-options');
  const option=options.data.activities.find(row=>row.id===activity.id);
  assert.equal(option.fixed_user_id,eleanor);assert.equal(option.allow_assignment_override,1);
  assert.equal(option.start_time,'07:00');assert.equal(option.due_time,'08:00');assert.equal(option.is_recurring,1);
  const resolved=await call('POST',`/automation/activity-templates/${activity.id}/resolve`,{});
  assert.equal(resolved.data.start_time,'07:00');assert.equal(resolved.data.checklist.at(-1).is_optional,1);
  const updated=await call('PUT',`/automation/admin/activity-templates/${activity.id}`,{name:'Renamed morning template',checklist:activity.checklist.map(({is_optional,...row})=>row)});
  assert.equal(updated.status,200,JSON.stringify(updated));assert.equal(updated.data.checklist.at(-1).is_optional,1);
  const task=await create({activity_template_id:activity.id});
  assert.equal(task.description,description);
  assert.deepEqual(task.subtasks.map(row=>row.title),[...names,'Put in earrings']);
  assert.equal(task.assigned_to,eleanor);assert.equal(task.start_time,'07:00');assert.equal(task.due_time,'08:00');assert.equal(task.points,2);
  assert.equal(task.recurrence_from_completion,0);assert.equal(task.recurrence_rule,'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(task.subtasks.at(-1).is_optional,1);assert.equal(task.subtask_total,9);
  const listed=(await call('GET','/tasks')).data.find(row=>row.id===task.id);
  assert.equal(listed.subtask_total,9);assert.equal(listed.subtasks.at(-1).is_optional,1);
});

test('nine required completions earn two points once; unfinished optional copies fresh into Tuesday',async()=>{
  const activity=await template(),task=await create({activity_template_id:activity.id});
  for(const step of children(task.id).filter(row=>!row.is_optional)){
    const result=await call('PATCH',`/tasks/${step.id}/status`,{status:'done',expected_revision:read(step.id).revision,expected_parent_revision:read(task.id).revision},eleanor);
    assert.equal(result.status,200,JSON.stringify(result));
  }
  assert.equal(read(task.id).status,'done');assert.equal(children(task.id).at(-1).status,'open');
  const award=d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(task.id);assert.deepEqual(award.map(row=>row.delta),[2]);
  const next=successor(task.id);assert.equal(next.due_date,'2026-09-22');assert.equal(next.start_time,'07:00');assert.equal(next.points,2);
  assert.equal(children(next.id).length,10);assert.ok(children(next.id).every(row=>row.status==='open'));assert.equal(children(next.id).at(-1).is_optional,1);
  assert.throws(()=>changeTaskStatus(d,children(task.id).at(-1).id,'done',{actorId:eleanor,requireRevision:false}),/completed parent|parent.*reopen|Reopen/i);
});

test('expiration copies optional metadata without earning or completing any unfinished step',async()=>{
  const activity=await template(),task=await create({activity_template_id:activity.id});
  assert.equal(expireTask(d,task.id,{now:new Date('2026-09-21T12:00:00Z')}).expired,true);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(task.id).n,0);
  assert.ok(children(task.id).every(row=>row.status==='expired'));
  assert.equal(children(successor(task.id).id).at(-1).is_optional,1);
});

test('optional checklist supervision does not hold a completed workflow open or invent helper completion',async()=>{
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion) VALUES('Earrings assistance',0,'normal')").run().lastInsertRowid);
  for(const [id,level] of [[admin,'excluded'],[eleanor,'supervised'],[other,'normal']])
    d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(id,skill,level,admin);
  const activity=await template({recurrence_rule:null,expiration_policy:'keep_overdue',checklist:[
    {title_template:'Get dressed'},{title_template:'Put in earrings',is_optional:true,skill_ids:[skill]}]});
  const workflow=Number(d.prepare("INSERT INTO workflow_templates(name,category,subject_required,created_by) VALUES('Morning workflow','misc',0,?)").run(admin).lastInsertRowid);
  d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(?,?,'morning',0)").run(workflow,activity.id);
  const instance=instantiateWorkflow(d,workflow,{createdBy:admin});
  const primary=instance.tasks.find(row=>row.role==='primary'),support=instance.tasks.find(row=>row.role==='supervisor');
  assert.ok(support,'optional skill can still request useful supervision');
  assert.deepEqual(unresolvedDependencies(d,instance.parent_task_id).map(row=>row.id),[primary.task_id]);
  const required=children(primary.task_id).find(row=>row.title==='Get dressed');
  changeTaskStatus(d,required.id,'done',{actorId:eleanor,requireRevision:false});
  assert.equal(read(primary.task_id).status,'done');assert.equal(read(instance.parent_task_id).status,'done');
  assert.equal(d.prepare('SELECT status FROM workflow_instances WHERE id=?').get(instance.id).status,'done');
  assert.equal(read(support.task_id).status,'open');assert.ok(read(support.task_id).archived_at);
  assert.equal(children(primary.task_id).find(row=>row.title==='Put in earrings').status,'open');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(support.task_id).n,0);
});

test('blank manual selected assignee with skilled required child saves, and child optionality survives partial edits and duplication payload',async()=>{
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion) VALUES('Routine skill',0,'normal')").run().lastInsertRowid);
  const task=await create({assigned_to:[eleanor],subtasks:[{title:'Required',skill_ids:[skill]},{title:'Earrings',is_optional:true}]});
  assert.equal(task.assigned_to,eleanor);assert.equal(task.subtasks[0].effective_assignee_id,eleanor);
  let child=task.subtasks[1];
  let result=await call('PUT',`/tasks/${child.id}`,{title:'Optional earrings',expected_revision:read(child.id).revision,expected_parent_revision:read(task.id).revision});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(read(child.id).is_optional,1);
  result=await call('PUT',`/tasks/${task.id}`,{expected_revision:read(task.id).revision,subtasks:children(task.id).map(row=>({id:row.id,title:row.title,skill_ids:row.id===task.subtasks[0].id?[skill]:[]}))});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(read(child.id).is_optional,1);
  const duplicate=await create({assigned_to:[eleanor],subtasks:children(task.id).map(row=>({title:row.title,is_optional:row.is_optional}))});
  assert.equal(duplicate.subtasks[1].is_optional,1);assert.ok(duplicate.subtasks.every(row=>row.status==='open'));
});

test('permitted fixed-template assignee choices persist through edit and recurrence; locked template rejects another choice',async()=>{
  const activity=await template();
  const task=await create({activity_template_id:activity.id,assigned_to:[other]});
  assert.equal(task.assigned_to,other);assert.equal(task.activity_assignment_override_user_id,other);
  let result=await call('PUT',`/tasks/${task.id}`,{expected_revision:read(task.id).revision,assigned_to:[eleanor]});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.assigned_to,eleanor);
  changeTaskStatus(d,task.id,'done',{actorId:eleanor,requireRevision:false,body:{complete_remaining:true}});
  assert.equal(successor(task.id).assigned_to,eleanor);
  assert.equal(d.prepare('SELECT assignment_override_user_id FROM task_activity_bindings WHERE task_id=?').get(successor(task.id).id).assignment_override_user_id,eleanor);
  const locked=await template({name:'Locked assignment',allow_assignment_override:false});
  const defaultTask=await create({activity_template_id:locked.id,assigned_to:[eleanor]});assert.equal(defaultTask.assigned_to,eleanor);
  result=await call('POST','/tasks',{activity_template_id:locked.id,title:'Forbidden override',assigned_to:[other],start_date:'2026-09-21',due_date:'2026-09-21'});
  assert.equal(result.status,400);assert.match(result.error,/does not allow/);
});

test('switching template to Blank respects the chosen manual assignee without retaining a binding',async()=>{
  const activity=await template(),task=await create({activity_template_id:activity.id});
  const result=await call('PUT',`/tasks/${task.id}`,{expected_revision:read(task.id).revision,activity_template_id:null,assigned_to:[other]});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.assigned_to,other);assert.equal(result.data.activity_template_id,null);
});

for(const terminal of ['done','expired'])test(`disabled template overrides leave ${terminal} occurrence history intact and resolve one successor under current policy`,async()=>{
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(other);
  const activity=await template(),task=await create({activity_template_id:activity.id,assigned_to:[other]});
  const updated=await call('PUT',`/automation/admin/activity-templates/${activity.id}`,{allow_assignment_override:false});
  assert.equal(updated.status,200,JSON.stringify(updated));
  const finish=()=>terminal==='done'
    ? changeTaskStatus(d,task.id,'done',{actorId:other,requireRevision:false,body:{complete_remaining:true}})
    : expireTask(d,task.id,{now:new Date('2026-09-21T12:00:00Z')});
  finish();finish();
  assert.equal(read(task.id).status,terminal);assert.equal(read(task.id).assigned_to,other);
  assert.equal(d.prepare('SELECT assignment_override_user_id FROM task_activity_bindings WHERE task_id=?').get(task.id).assignment_override_user_id,other);
  const next=successor(task.id);
  assert.ok(next);assert.equal(next.assigned_to,eleanor);assert.equal(next.due_date,'2026-09-22');assert.equal(next.points,2);
  assert.equal(d.prepare('SELECT assignment_override_user_id FROM task_activity_bindings WHERE task_id=?').get(next.id).assignment_override_user_id,null);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id).n,1);
  assert.deepEqual(d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(task.id).map(row=>row.delta),terminal==='done'?[2]:[]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(next.id).n,0);
  const denied=await call('POST','/tasks',{activity_template_id:activity.id,assigned_to:[other],start_date:'2026-09-21',due_date:'2026-09-21'});
  assert.equal(denied.status,400);assert.match(denied.error,/does not allow/);
});

test('invalid reusable timing, optional flags and changing completed parent optionality are rejected',async()=>{
  let result=await call('POST','/automation/admin/activity-templates',{name:'Invalid',assignment_strategy:'fixed',fixed_user_id:eleanor,start_time:'08:00',due_time:'07:00'});
  assert.equal(result.status,400);assert.match(result.error,/Due Time/);
  result=await call('POST','/tasks',{title:'Bad optional',subtasks:[{title:'Step',is_optional:'sometimes'}]});assert.equal(result.status,400);
  const task=await create({assigned_to:[eleanor],subtasks:[{title:'Required'},{title:'Optional',is_optional:1}]});
  changeTaskStatus(d,task.subtasks[0].id,'done',{actorId:eleanor,requireRevision:false});
  const required=read(task.subtasks[0].id);
  result=await call('PUT',`/tasks/${required.id}`,{is_optional:1,expected_revision:required.revision,expected_parent_revision:read(task.id).revision});
  assert.equal(result.status,409);assert.equal(read(required.id).is_optional,0);
  result=await call('POST','/tasks',{title:'Late optional',parent_task_id:task.id,is_optional:true,expected_parent_revision:read(task.id).revision});
  assert.equal(result.status,409);assert.equal(children(task.id).length,2);
});
