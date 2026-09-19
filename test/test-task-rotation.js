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

test('one parent recurrence shares one nightly order across three children and advances exactly once over four nights',async t=>{
  let task=await create();const expected=[[grace,eleanor,frankie],[eleanor,frankie,grace],[frankie,grace,eleanor],[grace,eleanor,frankie]];
  const trackId=ownerLink(task.id).track_id;
  for(let night=0;night<4;night++){
    t.mock.timers.setTime(Date.parse(`2026-09-${19+night}T20:00:00Z`));
    const link=ownerLink(task.id),occurrence=getRotationOccurrence(d,link.occurrence_id);
    assert.deepEqual(occurrence.member_ids,expected[night]);
    for(const child of children(task.id)){
      const context=(await call('GET',`/tasks/${child.id}`)).data.rotations[0];
      assert.equal(context.occurrence.id,occurrence.id);assert.equal(context.position,expected[night].indexOf(child.assigned_to)+1);
    }
    const steps=children(task.id);await finish(steps[0].id);await finish(steps[1].id);
    assert.equal(getRotationTrack(d,trackId).advance_count,night,'individual child actions cannot advance');
    await finish(steps[2].id);assert.equal(row(task.id).status,'done');
    assert.equal(getRotationTrack(d,trackId).advance_count,night+1);
    await finish(steps[2].id);assert.equal(getRotationTrack(d,trackId).advance_count,night+1,'repeated action cannot advance twice');
    assert.deepEqual(d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY user_id").all(task.id),
      [grace,eleanor,frankie].map(user_id=>({user_id,delta:2})), 'existing participation rewards remain once per member');
    task=next(task.id);assert.ok(task);
  }
  assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences WHERE track_id=?').get(trackId).n,5);
});

test('independent recurring series using one Group never advance each other',async()=>{
  const first=await create(),second=await create({title:'Separate purpose'});
  const before=getRotationTrack(d,ownerLink(second.id).track_id);
  await finish(first.id);
  assert.deepEqual(getRotationTrack(d,ownerLink(second.id).track_id),before);
  assert.notEqual(ownerLink(first.id).track_id,ownerLink(second.id).track_id);
});

test('occurrence-only configuration uses an isolated exception and retains original series provenance',async()=>{
  const task=await create(),original=ownerLink(task.id);
  const result=await edit(task.id,{rotation_bindings:[binding({strategy:'round_robin'})]},'occurrence');
  assert.equal(result.status,200,JSON.stringify(result));
  const exception=ownerLink(task.id);assert.notEqual(exception.track_id,original.track_id);
  assert.ok(d.prepare('SELECT retired_at FROM task_rotation_occurrences WHERE id=?').get(original.id).retired_at);
  assert.equal(getRotationTrack(d,original.track_id).strategy,'rotating_order');
  await finish(task.id);
  assert.equal(getRotationTrack(d,original.track_id).advance_count,1);
  const successor=next(task.id),followup=ownerLink(successor.id);
  assert.equal(followup.track_id,original.track_id);
  assert.deepEqual(getRotationOccurrence(d,followup.occurrence_id).member_ids,[eleanor,frankie,grace]);
  assert.equal(getRotationOccurrence(d,original.occurrence_id).status,'completed');
});

test('this and future config preserves current partial order and progress but next occurrence uses revised Group',async()=>{
  const task=await create(),first=children(task.id)[0];await finish(first.id);
  const original=ownerLink(task.id),before=getRotationOccurrence(d,original.occurrence_id);
  const other=saveRotationGroup(d,{name:'Other order',member_ids:[frankie,eleanor]},{actorId:admin});
  const result=await edit(task.id,{rotation_bindings:[binding({group_id:other.id})]});
  assert.equal(result.status,200,JSON.stringify(result));assert.match(result.rotation_warning,/preserved/);
  assert.deepEqual(getRotationOccurrence(d,original.occurrence_id),before);assert.equal(row(first.id).status,'done');
  await finish(task.id);const successor=next(task.id),resolved=getRotationOccurrence(d,ownerLink(successor.id).occurrence_id);
  assert.deepEqual(resolved.member_ids,[frankie,eleanor]);
});

test('expiration skips without advancing, zero completion award, and creates a successor with same order',async()=>{
  const task=await create({expiration_policy:'expire_incomplete'}),link=ownerLink(task.id);
  const result=expireTask(d,task.id,{now:new Date('2026-09-20T01:00:00Z')});assert.equal(result.expired,true);assert.equal(result.recurrenceError,null);
  assert.equal(getRotationOccurrence(d,link.occurrence_id).status,'skipped');assert.equal(getRotationTrack(d,link.track_id).advance_count,0);
  assert.deepEqual(getRotationOccurrence(d,ownerLink(next(task.id).id).occurrence_id).member_ids,[grace,eleanor,frankie]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(task.id).n,0);
});

test('manual advancement policy settles successful parent but retains the next member',async()=>{
  const task=await create({rotation_bindings:[binding({advance_policy:'manual'})]}),link=ownerLink(task.id);await finish(task.id);
  assert.equal(getRotationOccurrence(d,link.occurrence_id).status,'completed');assert.equal(getRotationTrack(d,link.track_id).advance_count,0);
  assert.deepEqual(getRotationOccurrence(d,ownerLink(next(task.id).id).occurrence_id).member_ids,[grace,eleanor,frankie]);
});

test('read projection is side effect free and history capabilities do not leak eligibility provenance',async()=>{
  const task=await create(),count=d.prepare('SELECT total_changes() n').get().n;
  const first=taskRotationContexts(d,task,grace),second=taskRotationContexts(d,task,grace);
  assert.deepEqual(first,second);assert.equal(d.prepare('SELECT total_changes() n').get().n,count);
  assert.equal(first[0].occurrence.original_order,undefined);assert.equal(first[0].occurrence.skipped,undefined);
});

test('restricted member cannot configure parent rotation or attach a separate subtask source',async()=>{
  const task=await create();const before=row(task.id);
  const denied=await edit(task.id,{rotation_bindings:[]},'occurrence');assert.equal(denied.status,200); // Admin control verifies payload.
  const changed=await call('PUT',`/tasks/${task.id}`,{rotation_bindings:[binding()]},grace);assert.equal(changed.status,403);
  const child=children(task.id)[0];const childAttempt=await call('PUT',`/tasks/${child.id}`,{rotation_bindings:[binding()]});assert.equal(childAttempt.status,400);
  assert.equal(JSON.parse(before.rotation_bindings_json)[0].group_id,group.id);
});

test('stale Task/series edit cannot change rotation configuration',async()=>{
  const task=await create(),track=getRotationTrack(d,ownerLink(task.id).track_id);
  const edited=await edit(task.id,{title:'A newer title'});assert.equal(edited.status,200);
  const stale=await call('PUT',`/tasks/${task.id}`,{expected_revision:task.revision,expected_series_revision:task.recurrence_series_revision,edit_scope:'future',rotation_bindings:[binding({strategy:'fixed_order'})]});
  assert.equal(stale.status,409);assert.deepEqual(getRotationTrack(d,track.id),track);
});

test('Activity Template rotation config is copied into independent series and later template edits cannot rewrite it',async()=>{
  const saved=await call('POST','/automation/admin/activity-templates',{name:'Bedtime Template',title_template:'Bedtime',assignment_strategy:'fixed',fixed_user_id:grace,
    subject_required:false,start_time:'15:00',due_time:'20:00',due_date_offset_days:0,recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],checklist:[{title_template:'Ready for bed'}]});
  assert.equal(saved.status,201,JSON.stringify(saved));
  const first=await call('POST','/tasks',{activity_template_id:saved.data.id,start_date:'2026-09-19'});
  const second=await call('POST','/tasks',{activity_template_id:saved.data.id,start_date:'2026-09-19'});
  assert.equal(first.status,201,JSON.stringify(first));assert.equal(second.status,201,JSON.stringify(second));
  assert.notEqual(ownerLink(first.data.id).track_id,ownerLink(second.data.id).track_id);
  const templateEdit=await call('PUT',`/automation/admin/activity-templates/${saved.data.id}`,{rotation_bindings:[binding({strategy:'fixed_order'})]});
  assert.equal(templateEdit.status,200,JSON.stringify(templateEdit));
  await finish(first.data.id);
  const successor=next(first.data.id);
  assert.equal(JSON.parse(successor.rotation_bindings_json)[0].strategy,'rotating_order');
  assert.deepEqual(getRotationOccurrence(d,ownerLink(successor.id).occurrence_id).member_ids,[eleanor,frankie,grace]);
  assert.equal(getRotationTrack(d,ownerLink(second.data.id).track_id).advance_count,0);
});

test('inactive Group does not block Task completion or recurrence; explicit retry resolves after reactivation',async()=>{
  const task=await create(),link=ownerLink(task.id);
  const disabled=saveRotationGroup(d,{name:'Kids',active:false,member_ids:[grace,eleanor,frankie]},{id:group.id,actorId:admin,expectedRevision:group.revision});
  await finish(task.id);const successor=next(task.id);assert.ok(successor);
  assert.equal(ownerLink(successor.id),undefined);
  const pending=(await call('GET',`/tasks/${successor.id}`)).data;
  assert.equal(pending.rotations[0].pending,true);assert.equal(pending.rotations[0].occurrence.id,null);
  saveRotationGroup(d,{name:'Kids',active:true,member_ids:[grace,eleanor,frankie]},{id:group.id,actorId:admin,expectedRevision:disabled.revision});
  const retry=await call('POST',`/tasks/${successor.id}/rotation/reconcile`,{expected_revision:row(successor.id).revision});
  assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.data.rotations[0].pending,undefined);
  assert.equal(ownerLink(successor.id).track_id,link.track_id);
  assert.equal(getRotationTrack(d,link.track_id).advance_count,1);
  assert.deepEqual(getRotationOccurrence(d,ownerLink(successor.id).occurrence_id).member_ids,[eleanor,frankie,grace]);
});

test('rotation resolution and finalization rollback with a failed Task successor write',async()=>{
  const task=await create(),link=ownerLink(task.id),before=getRotationTrack(d,link.track_id);
  d.exec(`CREATE TEMP TRIGGER fail_rotation_successor BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${task.id}
    BEGIN SELECT RAISE(ABORT,'isolated successor failure'); END;`);
  const failed=await call('PATCH',`/tasks/${task.id}/status`,{status:'done',complete_remaining:true});assert.equal(failed.status,500);
  assert.deepEqual(getRotationTrack(d,link.track_id),before);assert.equal(getRotationOccurrence(d,link.occurrence_id).status,'resolved');
  assert.equal(row(task.id).status,'open');assert.equal(next(task.id),undefined);
  d.exec('DROP TRIGGER fail_rotation_successor');await finish(task.id);
  assert.equal(getRotationTrack(d,link.track_id).advance_count,1);
});

test('shared participant assignees validate actual membership and remain independent stable actions on edit',async()=>{
  const rejected=await call('POST','/tasks',{title:'Invalid participants',assigned_to:[grace],rotation_bindings:[binding()],subtasks:[{title:'Action',assigned_user_ids:[999999]}]});
  assert.equal(rejected.status,400);assert.match(rejected.error,/household member/);
  const task=await create(),steps=children(task.id);
  assert.deepEqual(steps.map(child=>child.assigned_to),[grace,eleanor,frankie]);
  await finish(steps[0].id);
  const edited=await edit(task.id,{subtasks:steps.map((child,index)=>({...child,title:index===1?'Eleanor revised':child.title,skill_ids:[],assigned_user_ids:[child.assigned_to]}))});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.deepEqual(children(task.id).map(child=>child.id),steps.map(child=>child.id));assert.equal(row(steps[0].id).status,'done');
  await finish(task.id);assert.deepEqual(children(next(task.id).id).map(child=>child.assigned_to),[grace,eleanor,frankie]);
});

test('canonical Rotation expressions rerender per occurrence and participant, keep frozen authorship, and detach an edited field',async t=>{
  const saved=await call('POST','/automation/admin/activity-templates',{name:'Expression bedtime',title_template:'Bedtime — {{shower_order.position}}',
    assignment_strategy:'fixed',fixed_user_id:grace,subject_required:false,start_time:'15:00',due_time:'20:00',due_date_offset_days:0,
    recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],checklist:[grace,eleanor,frankie].map(()=>({title_template:'Take shower — {{shower_order.position}}'}))});
  assert.equal(saved.status,201,JSON.stringify(saved));
  const template=(await call('GET','/automation/admin/activity-templates')).data.find(item=>item.id===saved.data.id);
  const made=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:grace,start_date:'2026-09-19',
    subtasks:template.checklist.map((step,index)=>({title:'Take shower — 1',activity_template_checklist_item_id:step.id,assigned_user_ids:[[grace,eleanor,frankie][index]]}))});
  assert.equal(made.status,201,JSON.stringify(made));const task=made.data;
  assert.equal(row(task.id).title,'Bedtime — 1');assert.deepEqual(children(task.id).map(child=>child.title),['Take shower — 1','Take shower — 2','Take shower — 3']);
  const noChange=await edit(task.id,{title:task.title});assert.equal(noChange.status,200,JSON.stringify(noChange));
  assert.equal(noChange.data.recurrence_series_revision,task.recurrence_series_revision);
  d.prepare("UPDATE activity_templates SET title_template='Changed source template' WHERE id=?").run(template.id);
  await finish(task.id);const second=next(task.id);
  assert.equal(second.title,'Bedtime — 3');assert.deepEqual(children(second.id).map(child=>child.title),['Take shower — 3','Take shower — 1','Take shower — 2']);
  const literal=await edit(second.id,{title:'Our authored title'});assert.equal(literal.status,200,JSON.stringify(literal));
  t.mock.timers.setTime(Date.parse('2026-09-20T20:00:00Z'));
  await finish(second.id);const third=next(second.id);
  assert.equal(third.title,'Our authored title');assert.deepEqual(children(third.id).map(child=>child.title),['Take shower — 2','Take shower — 3','Take shower — 1']);
  assert.deepEqual(children(task.id).map(child=>child.title),['Take shower — 1','Take shower — 2','Take shower — 3']);
  const removed=await edit(third.id,{rotation_bindings:[]});assert.equal(removed.status,200,JSON.stringify(removed));
  t.mock.timers.setTime(Date.parse('2026-09-21T20:00:00Z'));await finish(third.id);
  const fourth=next(third.id);assert.equal(ownerLink(fourth.id),undefined);
  assert.deepEqual(children(fourth.id).map(child=>child.title),['Take shower — 2','Take shower — 3','Take shower — 1'],'removing a purpose detaches its authored expressions as preserved literal text');
});

test('expiration settles a previously finalized on-completion purpose without advancing',async()=>{
  const task=await create({expiration_policy:'expire_incomplete',rotation_bindings:[binding({advance_policy:'on_completed'})]}),link=ownerLink(task.id);
  finalizeRotation(d,link.occurrence_id,{outcome:'finalized',expectedRevision:getRotationOccurrence(d,link.occurrence_id).revision,actorId:admin,trusted:true});
  const result=expireTask(d,task.id,{now:new Date('2026-09-20T01:00:00Z')});assert.equal(result.expired,true);
  assert.equal(getRotationOccurrence(d,link.occurrence_id).status,'skipped');assert.equal(getRotationTrack(d,link.track_id).advance_count,0);
  assert.ok(ownerLink(next(task.id).id));
});

test('occurrence override atomically rerenders current bound Task fields while preserving literals and completed evidence',async()=>{
  const saved=await call('POST','/automation/admin/activity-templates',{name:'Override labels',title_template:'Bedtime — {{shower_order.position}}',
    assignment_strategy:'fixed',fixed_user_id:grace,subject_required:false,start_time:'15:00',due_time:'20:00',due_date_offset_days:0,
    recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],checklist:[grace,eleanor,frankie].map(()=>({title_template:'Take shower — {{shower_order.position}}'}))});
  const template=(await call('GET','/automation/admin/activity-templates')).data.find(item=>item.id===saved.data.id);
  const made=await call('POST','/tasks',{activity_template_id:template.id,activity_subject_user_id:grace,start_date:'2026-09-19',
    subtasks:template.checklist.map((step,index)=>({title:'Take shower — 1',activity_template_checklist_item_id:step.id,assigned_user_ids:[[grace,eleanor,frankie][index]]}))});
  assert.equal(made.status,201,JSON.stringify(made));const task=made.data,steps=children(task.id),link=ownerLink(task.id);
  await finish(steps[0].id);await call('PUT',`/tasks/${steps[1].id}`,{title:'My literal instruction'});
  const receipts=d.prepare('SELECT * FROM task_completions ORDER BY id').all(),rewards=d.prepare('SELECT * FROM reward_ledger ORDER BY id').all();
  const before=getRotationOccurrence(d,link.occurrence_id);
  d.exec(`CREATE TEMP TRIGGER fail_rotation_render BEFORE UPDATE OF title ON tasks WHEN NEW.id=${task.id}
    BEGIN SELECT RAISE(ABORT,'isolated render failure'); END;`);
  const payload={member_ids:[frankie,eleanor,grace],expected_revision:before.revision};
  const failed=await call('POST',`/automation/rotation-occurrences/${before.id}/override`,payload);assert.equal(failed.status,400);
  assert.deepEqual(getRotationOccurrence(d,before.id),before);d.exec('DROP TRIGGER fail_rotation_render');
  const changed=await call('POST',`/automation/rotation-occurrences/${before.id}/override`,payload);assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(row(task.id).title,'Bedtime — 3');assert.deepEqual(children(task.id).map(child=>child.title),['Take shower — 1','My literal instruction','Take shower — 1']);
  assert.deepEqual(d.prepare('SELECT * FROM task_completions ORDER BY id').all(),receipts);assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),rewards);
  assert.equal(getRotationTrack(d,link.track_id).advance_count,0);
});

test('Rotation view denial removes configuration and context from Task API without blocking ordinary Task access',async()=>{
  const task=await create();d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'rotations.view','none')").run(String(grace));
  const shown=await call('GET',`/tasks/${task.id}`,undefined,grace);assert.equal(shown.status,200);
  assert.deepEqual(shown.data.rotations,[]);assert.deepEqual(shown.data.rotation_bindings,[]);assert.equal(shown.data.rotation_bindings_json,undefined);
  const list=await call('GET','/tasks',undefined,grace);assert.equal(list.status,200,JSON.stringify(list));assert.ok(list.data.find(row=>row.id===task.id));
});

test('already resolved future rotation snapshots are reported as preserved exceptions, while harmless title edits reconcile',async()=>{
  const task=await create({rotation_bindings:[binding({strategy:'fixed_order'})]}),futureId=materializeAhead(task.id),link=ownerLink(futureId);
  const harmless=await edit(task.id,{title:'Updated bedtime'});assert.equal(harmless.status,200,JSON.stringify(harmless));
  assert.deepEqual(harmless.series_edit.updated,[futureId],JSON.stringify(harmless.series_edit));assert.deepEqual(harmless.series_edit.preserved,[]);
  const before=row(futureId),snapshot=getRotationOccurrence(d,link.occurrence_id),originalChildren=children(futureId);
  const changed=await edit(task.id,{rotation_bindings:[binding({strategy:'round_robin'})]});assert.equal(changed.status,200,JSON.stringify(changed));
  assert.deepEqual(changed.series_edit.updated,[]);assert.deepEqual(changed.series_edit.preserved,[{task_id:futureId,reason:'rotation_snapshot'}]);
  assert.deepEqual(row(futureId),before);assert.deepEqual(children(futureId),originalChildren);assert.deepEqual(getRotationOccurrence(d,link.occurrence_id),snapshot);
});

test('future pending rotation accepts revised configuration and resolves once when its registered predecessor completes',async()=>{
  const task=await create(),futureId=materializeAhead(task.id);assert.equal(ownerLink(futureId),undefined);
  const other=saveRotationGroup(d,{name:'New future order',member_ids:[frankie,eleanor,grace]},{actorId:admin});
  const changed=await edit(task.id,{rotation_bindings:[binding({group_id:other.id})]});assert.equal(changed.status,200,JSON.stringify(changed));
  assert.deepEqual(changed.series_edit.updated,[futureId]);assert.deepEqual(changed.series_edit.preserved,[]);
  assert.equal(changed.series_edit.pending_rotations[0].task_id,futureId);assert.equal(ownerLink(futureId),undefined);
  const clock=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  await finish(task.id);const linked=ownerLink(futureId);assert.ok(linked);
  assert.deepEqual(getRotationOccurrence(d,linked.occurrence_id).member_ids,[frankie,eleanor,grace]);
  assert.equal(getRotationOccurrence(d,linked.occurrence_id).group_id,other.id);
  const count=d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,pointer=getRotationTrack(d,linked.track_id);
  await finish(task.id);reconcileTaskRecurrence(task.id);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM rotation_occurrences').get().n,count);assert.deepEqual(getRotationTrack(d,linked.track_id),pointer);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_occurrences WHERE series_id=?').get(task.id).n,2);
  assert.ok(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version>clock);
});

for(const state of ['comment','progress'])test(`future pending occurrence with ${state} is preserved and cannot reconfigure the canonical series Track backward`,async()=>{
  const task=await create(),futureId=materializeAhead(task.id),oldConfig=row(futureId).rotation_bindings_json;
  if(state==='comment')d.prepare("INSERT INTO task_comments(task_id,user_id,comment) VALUES(?,?,'Keep this plan')").run(futureId,admin);
  else d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(children(futureId)[0].id);
  const changed=await edit(task.id,{rotation_bindings:[binding({strategy:'round_robin'})]});assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(changed.series_edit.preserved[0].task_id,futureId);assert.equal(row(futureId).rotation_bindings_json,oldConfig);
  const canonical=ownerLink(task.id).track_id;assert.equal(getRotationTrack(d,canonical).strategy,'round_robin');
  await finish(task.id);const exception=ownerLink(futureId);assert.ok(exception);assert.notEqual(exception.track_id,canonical);
  assert.equal(getRotationTrack(d,exception.track_id).strategy,'rotating_order');assert.equal(getRotationTrack(d,canonical).strategy,'round_robin');
  if(state==='comment')assert.equal(d.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_id=?').get(futureId).n,1);
  else assert.equal(children(futureId)[0].status,'done');
});

test('fixed future Rotation window snapshots stay historical when the reusable schedule changes',async()=>{
  const task=await create({rotation_bindings:[binding({strategy:'fixed_order'})]}),futureId=materializeAhead(task.id),before=row(futureId);
  const result=await edit(task.id,{due_time:'21:00'});assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(result.series_edit.preserved,[{task_id:futureId,reason:'rotation_snapshot'}]);assert.deepEqual(row(futureId),before);
});

test('expiration settles skip and resolves existing pending future work without advancing or generating duplicate Tasks',async()=>{
  const task=await create({expiration_policy:'expire_incomplete'}),futureId=materializeAhead(task.id),original=ownerLink(task.id);
  assert.equal(ownerLink(futureId),undefined);
  const result=expireTask(d,task.id,{now:new Date('2026-09-20T01:00:00Z')});assert.equal(result.expired,true);assert.equal(result.recurrenceError,null);
  assert.deepEqual(getRotationOccurrence(d,ownerLink(futureId).occurrence_id).member_ids,[grace,eleanor,frankie]);
  assert.equal(getRotationTrack(d,original.track_id).advance_count,0);assert.equal(next(task.id).id,futureId);
});
