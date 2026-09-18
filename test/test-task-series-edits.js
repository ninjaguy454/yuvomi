import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='series-edits-isolated-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
let d,parent,grace,eleanor,frankie,server,base;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-14T11:30:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  parent=user('Parent','admin');grace=user('Grace','member');eleanor=user('Eleanor','member');frankie=user('Frankie','member');
  for(const id of [grace,eleanor,frankie])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{const id=Number(req.headers['x-test-user'])||parent;
    const role=d.prepare('SELECT role FROM users WHERE id=?').get(id).role;req.authUserId=id;req.authRole=role;req.session={userId:id,role};next();});
  app.use('/tasks',tasksRouter);app.use('/automation',automationRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare(`SELECT t.* FROM tasks t WHERE parent_task_id=?
  AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
  AND NOT EXISTS(SELECT 1 FROM task_supervision_actions s WHERE s.counterpart_task_id=t.id) ORDER BY sort_order,id`).all(id);
const active=id=>children(id).filter(child=>!child.archived_at);
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
async function call(method,path,body,actor=parent){
  if(body&&/^\/tasks\/\d+/.test(path)&&['PUT','PATCH'].includes(method)){
    const current=row(Number(path.split('/')[2]));body={expected_revision:current.revision,
      ...(current.parent_task_id?{expected_parent_revision:row(current.parent_task_id).revision}:{}),...body};}
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','x-test-user':String(actor)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();return{status:response.status,...text?JSON.parse(text):{}};
}
async function detail(id){const result=await call('GET',`/tasks/${id}`);assert.equal(result.status,200,JSON.stringify(result));return result.data;}
async function edit(id,body,actor=parent){const task=await detail(id);return call('PUT',`/tasks/${id}`,{
  ...(body.edit_scope==='future'?{expected_series_revision:task.recurrence_series_revision}:{}),...body},actor);}
async function template(extra={}){const result=await call('POST','/automation/admin/activity-templates',{
  name:'Get Ready for the Day',title_template:'Get Ready for the Day',assignment_strategy:'fixed',fixed_user_id:eleanor,
  subject_required:false,allow_assignment_override:true,start_time:'07:00',due_time:'08:00',due_date_offset_days:0,
  recurrence_rule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',points:2,
  checklist:[{title_template:'Get dressed'},{title_template:'Brush teeth'},{title_template:'Make bed'},{title_template:'Ready for the day'},{title_template:'Put in earrings',is_optional:true}],...extra});
  assert.equal(result.status,201,JSON.stringify(result));return result.data;}
async function create(activity,assignee=eleanor,extra={}){const result=await call('POST','/tasks',{
  activity_template_id:activity.id,start_date:'2026-09-14',assigned_to:[assignee],...extra});assert.equal(result.status,201,JSON.stringify(result));return result.data;}
async function finish(id,actor=parent){const result=await call('PATCH',`/tasks/${id}/status`,{status:'done',complete_remaining:true},actor);assert.equal(result.status,200,JSON.stringify(result));return result;}
function document(taskId){const id=Number(d.prepare(`INSERT INTO family_documents(name,original_name,mime_type,file_size,content_data,created_by)
  VALUES('School note','note.txt','text/plain',1,?,?)`).run(Buffer.from('x'),parent).lastInsertRowid);
  d.prepare('INSERT INTO task_documents(task_id,document_id,created_by) VALUES(?,?,?)').run(taskId,id,parent);return id;}

test('Eleanor current and future structural edit preserves completed evidence and isolates Grace, Frankie and the template',async()=>{
  const activity=await template(),g=await create(activity,grace),e=await create(activity),f=await create(activity,frankie);
  const templateBefore=d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activity.id);
  const untouched=[g.id,f.id].map(id=>({root:row(id),children:children(id)}));
  const [dressed,teeth,bed,ready,earrings]=active(e.id);
  await finish(dressed.id);await finish(teeth.id);
  await call('POST',`/tasks/${teeth.id}/comments`,{comment:'Completed before the definition changed.'});const doc=document(teeth.id);
  const receipt=d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(teeth.id);
  const result=await edit(e.id,{edit_scope:'future',title:"Eleanor's morning",subtasks:[
    {id:ready.id,title:ready.title,skill_ids:[],is_optional:0},
    {id:dressed.id,title:'Get dressed for school',skill_ids:[],is_optional:0},
    {id:bed.id,title:bed.title,skill_ids:[],is_optional:1},
    {id:earrings.id,title:earrings.title,skill_ids:[],is_optional:1},
    {title:'Pack backpack',skill_ids:[],is_optional:0},
  ]});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(row(dressed.id).status,'done');
  assert.equal(row(teeth.id).status,'done');assert.ok(row(teeth.id).archived_at);
  assert.equal(d.prepare('SELECT comment FROM task_comments WHERE task_id=?').get(teeth.id).comment,'Completed before the definition changed.');
  assert.ok(d.prepare('SELECT 1 FROM task_documents WHERE task_id=? AND document_id=?').get(teeth.id,doc));
  assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(teeth.id),receipt);
  assert.deepEqual(active(e.id).slice(0,4).map(step=>step.id),[ready.id,dressed.id,bed.id,earrings.id]);
  assert.equal(result.data.subtask_total,3);assert.equal(result.data.subtask_done,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(e.id).n,0);
  await finish(ready.id);await finish(active(e.id).find(step=>step.title==='Pack backpack').id);
  assert.equal(row(e.id).status,'done');assert.equal(row(earrings.id).status,'open');
  const earnings=d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(e.id);
  assert.deepEqual(earnings,[{delta:2}]);
  const successor=next(e.id);assert.ok(successor);assert.equal(successor.title,"Eleanor's morning");
  assert.equal(successor.start_date,'2026-09-15');assert.equal(successor.due_date,'2026-09-15');
  assert.equal(active(successor.id).length,5);assert.ok(active(successor.id).every(step=>step.status==='open'));
  assert.equal(active(successor.id).filter(step=>step.is_optional).length,2);
  assert.deepEqual([g.id,f.id].map(id=>({root:row(id),children:children(id)})),untouched);
  assert.deepEqual(d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activity.id),templateBefore);
});

test('occurrence-only title, optionality and date overrides never leak into the next definition',async()=>{
  const activity=await template(),source=await create(activity),steps=active(source.id);
  const result=await edit(source.id,{edit_scope:'occurrence',title:'Today only',due_time:'09:00',subtasks:steps.map((step,index)=>({
    id:step.id,title:index===0?'Today-only dressed':step.title,is_optional:index===0?1:step.is_optional,skill_ids:[]}))});
  assert.equal(result.status,200,JSON.stringify(result));await finish(source.id);
  const successor=next(source.id);assert.equal(successor.title,'Get Ready for the Day');assert.equal(successor.due_time,'08:00');
  assert.equal(active(successor.id)[0].title,'Get dressed');assert.equal(active(successor.id)[0].is_optional,0);
});

test('editing a completed occurrence updates its untouched materialized successor while preserving the historical Task and receipts',async()=>{
  const source=await create(await template());await finish(source.id);
  const before=row(source.id),receipt=d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(source.id),future=next(source.id);
  const result=await edit(source.id,{edit_scope:'future',title:'New future title',points:5,start_time:'07:15',due_time:'08:30'});
  assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.series_edit.updated.includes(future.id));
  assert.deepEqual(row(source.id),before);assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(source.id),receipt);
  assert.equal(row(future.id).title,'New future title');assert.equal(row(future.id).points,5);
  assert.equal(row(future.id).start_time,'07:15');assert.equal(row(future.id).due_time,'08:30');
});

for(const meaningful of ['comment','document','progress','manual edit','supervision history','assignment response']) {
  test(`future occurrence with ${meaningful} is preserved as an exception`,async t=>{
    const source=await create(await template());await finish(source.id);const future=next(source.id);
    if(meaningful==='comment')await call('POST',`/tasks/${future.id}/comments`,{comment:'Keep this planned occurrence.'});
    if(meaningful==='document')document(future.id);
    if(meaningful==='progress'){t.mock.timers.setTime(Date.parse('2026-09-15T11:30:00Z'));await finish(active(future.id)[0].id);}
    if(meaningful==='manual edit'){const changed=await edit(future.id,{edit_scope:'occurrence',description:'One-off instructions'});assert.equal(changed.status,200,JSON.stringify(changed));}
    if(meaningful==='supervision history')d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'supervisor_reassigned','{}')").run(future.id,future.id,parent);
    if(meaningful==='assignment response')d.prepare("UPDATE planning_obligations SET responded_at='2026-09-14T12:00:00Z',status='accepted' WHERE task_id=?").run(future.id);
    const before=row(future.id),stepBefore=children(future.id);
    const result=await edit(source.id,{edit_scope:'future',title:'New series instructions'});
    assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.series_edit.preserved.some(item=>item.task_id===future.id));
    assert.deepEqual(row(future.id),before);assert.deepEqual(children(future.id),stepBefore);
  });
}

test('series CAS and current permissions reject stale or unauthorized edits without partial writes',async()=>{
  const source=await create(await template());const original=await detail(source.id);
  assert.ok(Number.isSafeInteger(original.recurrence_series_id));assert.equal(original.recurrence_series_revision,1);
  const first=await edit(source.id,{edit_scope:'future',title:'First editor'});assert.equal(first.status,200,JSON.stringify(first));
  const before=row(source.id),count=d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n;
  const stale=await edit(source.id,{edit_scope:'future',expected_series_revision:original.recurrence_series_revision,title:'Stale editor'});
  assert.equal(stale.status,409,JSON.stringify(stale));assert.equal(stale.reason,'series_revision_conflict');
  assert.deepEqual(row(source.id),before);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,count);
  d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.change_dates','none')").run(String(eleanor));
  const denied=await edit(source.id,{edit_scope:'future',title:'Child change'},eleanor);assert.equal(denied.status,403,JSON.stringify(denied));
  assert.deepEqual(row(source.id),before);
});

test('one edit changing assignee and frozen root skills uses the incoming requirements for validation and persistence',async()=>{
  const source=await create(await template());
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Special step',0,'normal',?)").run(parent).lastInsertRowid);
  for(const [id,proficiency] of [[eleanor,'normal'],[frankie,'excluded'],[grace,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(id,skill,proficiency);
  const rejected=await edit(source.id,{edit_scope:'future',assigned_to:[frankie],skill_ids:[skill]});assert.equal(rejected.status,400,JSON.stringify(rejected));
  assert.equal(row(source.id).assigned_to,eleanor);
  const accepted=await edit(source.id,{edit_scope:'future',assigned_to:[grace],skill_ids:[skill]});assert.equal(accepted.status,200,JSON.stringify(accepted));
  assert.equal(accepted.data.assigned_to,grace);assert.deepEqual(accepted.data.skill_ids,[skill]);
  assert.deepEqual(JSON.parse(d.prepare('SELECT definition_snapshot_json FROM task_activity_bindings WHERE task_id=?').get(source.id).definition_snapshot_json).required_skill_ids,[skill]);
});

test('explicitly promoting an occurrence-only definition to future scope is a change, while an identical series save is idempotent',async()=>{
  const source=await create(await template());
  const local=await edit(source.id,{edit_scope:'occurrence',title:'Promote these instructions'});assert.equal(local.status,200,JSON.stringify(local));
  const before=await detail(source.id);
  const promoted=await edit(source.id,{edit_scope:'future',title:'Promote these instructions'});assert.equal(promoted.status,200,JSON.stringify(promoted));
  assert.equal(promoted.data.recurrence_series_revision,before.recurrence_series_revision+1);
  const definitions=d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n;
  const events=d.prepare('SELECT COUNT(*) n FROM task_activity_events WHERE task_id=?').get(source.id).n;
  const repeated=await edit(source.id,{edit_scope:'future',title:'Promote these instructions'});assert.equal(repeated.status,200,JSON.stringify(repeated));
  assert.equal(repeated.data.recurrence_series_revision,promoted.data.recurrence_series_revision);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,definitions);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events WHERE task_id=?').get(source.id).n,events);
  await finish(source.id);assert.equal(next(source.id).title,'Promote these instructions');
});

test('fixed multi-assignee series preserve the selected primary through generation and a historical future edit',async()=>{
  const created=await call('POST','/tasks',{title:'Shared morning',assigned_to:[eleanor,grace],is_recurring:true,
    recurrence_rule:'FREQ=DAILY',start_date:'2026-09-14',due_date:'2026-09-14',due_time:'08:00'});
  assert.equal(created.status,201,JSON.stringify(created));assert.equal(row(created.data.id).assigned_to,eleanor);
  await finish(created.data.id);const successor=next(created.data.id);assert.equal(successor.assigned_to,eleanor);
  const changed=await edit(created.data.id,{edit_scope:'future',title:'Shared morning revised'});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.ok(changed.series_edit.updated.includes(successor.id));
  assert.equal(row(successor.id).assigned_to,eleanor);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(successor.id),[{user_id:grace},{user_id:eleanor}]);
});

test('adding an optional supervised action preserves current progress and creates a fresh helper scope with live proficiency',async t=>{
  const source=await create(await template());const steps=active(source.id);await finish(steps[0].id,eleanor);
  const receipt=d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(steps[0].id);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Optional earrings care',0,'normal',?)").run(parent).lastInsertRowid);
  for(const [id,proficiency] of [[parent,'normal'],[eleanor,'supervised'],[grace,'excluded'],[frankie,'excluded']])
    d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(id,skill,proficiency);
  const edited=await edit(source.id,{edit_scope:'future',subtasks:[...steps.map(step=>({id:step.id,title:step.title,is_optional:step.is_optional,skill_ids:[]})),
    {title:'Clean earrings',is_optional:true,skill_ids:[skill]}]});
  assert.equal(edited.status,200,JSON.stringify(edited));assert.equal(row(steps[0].id).status,'done');
  assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(steps[0].id),receipt);
  const optional=active(source.id).find(step=>step.title==='Clean earrings');
  const blocked=await call('PATCH',`/tasks/${optional.id}/status`,{status:'done'},eleanor);
  assert.equal(blocked.status,409,JSON.stringify(blocked));assert.equal(row(optional.id).status,'open');
  for(const step of active(source.id).filter(step=>!step.is_optional&&step.status!=='done'))await finish(step.id,eleanor);
  assert.equal(row(source.id).status,'done');assert.equal(row(optional.id).status,'open');
  const successor=next(source.id),futureOptional=active(successor.id).find(step=>step.title==='Clean earrings');
  assert.equal(futureOptional.is_optional,1);assert.equal(futureOptional.status,'open');
  assert.deepEqual(d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id=?').all(futureOptional.id),[{skill_id:skill}]);
  t.mock.timers.setTime(Date.parse('2026-09-15T11:30:00Z'));
  const future=await detail(successor.id),action=future.supervision.actions.find(item=>item.action_task_id===futureOptional.id);
  assert.ok(action);assert.equal(action.supervisor_user_id,parent);assert.notEqual(action.counterpart_task_id,optional.id);
  d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id=?").run(eleanor,skill);
  const performed=await call('PATCH',`/tasks/${futureOptional.id}/status`,{status:'done'},eleanor);
  assert.equal(performed.status,200,JSON.stringify(performed));assert.equal(row(futureOptional.id).status,'done');
  assert.notEqual(row(successor.id).status,'done');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(source.id).n,1);
});

test('promoting a one-off points exception requires permission to change the durable series points',async()=>{
  const source=await create(await template({points:5}));
  const exception=await edit(source.id,{edit_scope:'occurrence',points:2});assert.equal(exception.status,200,JSON.stringify(exception));
  d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.change_points','none')").run(String(eleanor));
  const before=row(source.id),series=(await detail(source.id)).recurrence_series_revision;
  const count=d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n;
  const events=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  const denied=await edit(source.id,{edit_scope:'future',title:'Cannot quietly lower future points'},eleanor);
  assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(denied.reason,'series_definition_permission');
  assert.deepEqual(row(source.id),before);assert.equal((await detail(source.id)).recurrence_series_revision,series);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,count);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,events);
});

test('an unlocked one-off occurrence cannot bypass the durable series definition lock',async()=>{
  const source=await create(await template(),eleanor,{locked:true});
  const exception=await edit(source.id,{edit_scope:'occurrence',locked:false});assert.equal(exception.status,200,JSON.stringify(exception));
  assert.equal(row(source.id).locked,0);
  const before=row(source.id),series=(await detail(source.id)).recurrence_series_revision;
  const events=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  const denied=await edit(source.id,{edit_scope:'future',title:'Cannot silently unlock future instructions'},eleanor);
  assert.equal(denied.status,403,JSON.stringify(denied));assert.equal(denied.reason,'series_definition_locked');
  assert.deepEqual(row(source.id),before);assert.equal((await detail(source.id)).recurrence_series_revision,series);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,events);
});

test('exact morning routine: Gracelynn adds deodorant and optional earrings, Eleanor adds only optional earrings, and all three series remain independent',async t=>{
  const {expireTask}=await import('../server/services/task-lifecycle.js');
  d.prepare("UPDATE users SET display_name='Gracelynn' WHERE id=?").run(grace);
  const names=['Get dressed','Put pajamas / dirty clothes away','Make bed','Brush teeth','Brush / fix hair',
    'Wash face','Put on socks and shoes','Get backpack / school items ready','Ready for the day'];
  const activity=await template({description:"Complete your morning routine so you're clean, dressed, organized, and ready for the day. Finish each required step before the morning deadline to complete the activity and earn your points.",
    recurrence_from_completion:0,expiration_policy:'expire_incomplete',checklist:names.map(title_template=>({title_template,is_optional:false}))});
  const g=await create(activity,grace),e=await create(activity,eleanor),f=await create(activity,frankie);
  const templateSnapshot=()=>({root:d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activity.id),
    checklist:d.prepare('SELECT * FROM activity_template_checklist_items WHERE activity_template_id=? ORDER BY sort_order,id').all(activity.id)});
  const taskSnapshot=id=>({root:row(id),children:children(id)});
  const templateBefore=templateSnapshot(),eleanorBefore=taskSnapshot(e.id),frankieBefore=taskSnapshot(f.id);
  assert.equal(new Set([g.recurrence_series_id,e.recurrence_series_id,f.recurrence_series_id]).size,3);
  assert.ok([g,e,f].every(task=>active(task.id).length===9&&active(task.id).every(step=>step.is_optional===0)));
  const graceSteps=active(g.id);await finish(graceSteps[0].id,grace);await finish(graceSteps[1].id,grace);
  const priorReceipts=graceSteps.slice(0,2).map(step=>d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(step.id));
  const graceEdit=await edit(g.id,{edit_scope:'future',subtasks:[...graceSteps.map(step=>({id:step.id,title:step.title,is_optional:false,skill_ids:[]})),
    {title:'Put on deodorant',is_optional:false,skill_ids:[]},{title:'Put in earrings',is_optional:true,skill_ids:[]}]});
  assert.equal(graceEdit.status,200,JSON.stringify(graceEdit));assert.equal(graceEdit.data.subtask_done,2);assert.equal(graceEdit.data.subtask_total,10);
  assert.deepEqual(active(g.id).slice(0,9).map(step=>step.id),graceSteps.map(step=>step.id));
  assert.deepEqual(graceSteps.slice(0,2).map(step=>d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(step.id)),priorReceipts);
  assert.deepEqual(taskSnapshot(e.id),eleanorBefore);assert.deepEqual(taskSnapshot(f.id),frankieBefore);assert.deepEqual(templateSnapshot(),templateBefore);
  const graceAfterEdit=taskSnapshot(g.id),eleanorSteps=active(e.id);
  const eleanorEdit=await edit(e.id,{edit_scope:'future',subtasks:[...eleanorSteps.map(step=>({id:step.id,title:step.title,is_optional:false,skill_ids:[]})),
    {title:'Put in earrings',is_optional:true,skill_ids:[]}]});
  assert.equal(eleanorEdit.status,200,JSON.stringify(eleanorEdit));assert.equal(eleanorEdit.data.subtask_total,9);
  assert.deepEqual(taskSnapshot(g.id),graceAfterEdit);assert.deepEqual(taskSnapshot(f.id),frankieBefore);assert.deepEqual(templateSnapshot(),templateBefore);
  for(const [task,member] of [[g,grace],[e,eleanor]])for(const step of active(task.id).filter(step=>!step.is_optional&&step.status!=='done'))await finish(step.id,member);
  const earnings=id=>d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY id").all(id);
  assert.deepEqual(earnings(g.id),[{user_id:grace,delta:2}]);assert.deepEqual(earnings(e.id),[{user_id:eleanor,delta:2}]);
  assert.equal(active(g.id).find(step=>step.title==='Put in earrings').status,'open');
  assert.equal(active(e.id).find(step=>step.title==='Put in earrings').status,'open');
  await finish(g.id,grace);await finish(e.id,eleanor);
  assert.equal(earnings(g.id).length,1);assert.equal(earnings(e.id).length,1);
  const gTuesday=next(g.id),eTuesday=next(e.id);
  const assertFresh=(task,member,expectedNames,required)=>{
    assert.equal(task.assigned_to,member);assert.equal(task.start_time,'07:00');assert.equal(task.due_time,'08:00');
    assert.equal(task.points,2);assert.equal(task.recurrence_rule,'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    assert.equal(task.recurrence_from_completion,0);assert.equal(task.expiration_policy,'expire_incomplete');
    assert.deepEqual(active(task.id).map(step=>step.title),expectedNames);
    assert.equal(active(task.id).filter(step=>!step.is_optional).length,required);
    assert.ok(active(task.id).every(step=>step.status==='open'));assert.deepEqual(earnings(task.id),[]);
  };
  assert.equal(gTuesday.start_date,'2026-09-15');assert.equal(gTuesday.due_date,'2026-09-15');
  assert.equal(eTuesday.start_date,'2026-09-15');assert.equal(eTuesday.due_date,'2026-09-15');
  assertFresh(gTuesday,grace,[...names,'Put on deodorant','Put in earrings'],10);
  assertFresh(eTuesday,eleanor,[...names,'Put in earrings'],9);
  const graceMondayHistory=taskSnapshot(g.id);
  t.mock.timers.setTime(Date.parse('2026-09-15T11:30:00Z'));
  for(const step of active(gTuesday.id).filter(step=>!step.is_optional))await finish(step.id,grace);
  assert.deepEqual(earnings(gTuesday.id),[{user_id:grace,delta:2}]);
  const gWednesday=next(gTuesday.id);assert.equal(gWednesday.start_date,'2026-09-16');assert.equal(gWednesday.due_date,'2026-09-16');
  assertFresh(gWednesday,grace,[...names,'Put on deodorant','Put in earrings'],10);
  assert.deepEqual(taskSnapshot(g.id),graceMondayHistory);
  t.mock.timers.setTime(Date.parse('2026-09-15T12:00:00Z'));
  assert.equal(expireTask(d,eTuesday.id,{now:new Date('2026-09-15T12:00:00Z')}).expired,true);
  assert.equal(row(eTuesday.id).status,'expired');assert.deepEqual(earnings(eTuesday.id),[]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(eTuesday.id).n,0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'").get(eTuesday.id).n,1);
  const eWednesday=next(eTuesday.id);assert.equal(eWednesday.start_date,'2026-09-16');assert.equal(eWednesday.due_date,'2026-09-16');
  assertFresh(eWednesday,eleanor,[...names,'Put in earrings'],9);
  assert.deepEqual(taskSnapshot(f.id),frankieBefore);assert.deepEqual(templateSnapshot(),templateBefore);
});
