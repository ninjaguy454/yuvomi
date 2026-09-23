import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-rotation-task-test';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:rotationsRouter}=await import('../server/routes/rotations.js');
const {saveRotationGroup,getRotationTrack,getRotationOccurrence}=await import('../server/services/rotation.js');
const {expireTask}=await import('../server/services/task-lifecycle.js');
const {taskRotationContexts}=await import('../server/services/task-rotation.js');
const {taskSeriesState}=await import('../server/services/task-series.js');
const S=await import('../server/services/rotation-shared.js');
let d,admin,grace,eleanor,frankie,group,server,base;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-19T23:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);})();
    if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,role==='admin'?'parent':'child').lastInsertRowid);
  admin=user('Parent','admin');grace=user('Grace','member');eleanor=user('Eleanor','member');frankie=user('Frankie','member');
  for(const userId of [grace,eleanor,frankie])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(userId);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  group=S.saveRotationGroupUsage(d,{name:'Kids Shower Order',member_ids:[grace,eleanor,frankie],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:grace,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:admin});
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
const sharedTrack=()=>d.prepare("SELECT * FROM rotation_tracks WHERE consumer_type='rotation_group_schedule' AND group_id=?").get(group.id);
const tick=iso=>S.reconcileSharedRotationPeriods(d,{now:new Date(iso),groupId:group.id});
async function independent(kid,date='2026-09-19',extra={}) {
  return create({title:`${rowName(kid)} bedtime`,assigned_to:[kid],start_date:date,start_time:'18:30',due_date:date,due_time:'23:30',
    subtasks:[{title:'Take shower',assigned_user_ids:[kid]},{title:'Brush teeth'}],...extra});
}
const rowName=id=>d.prepare('SELECT display_name FROM users WHERE id=?').get(id).display_name;
async function expressionTemplate() {
  const result=await call('POST','/automation/admin/activity-templates',{name:'Independent bedtime',title_template:'Bedtime · {{shower_order.position_label}}',
    description:'My position: {{shower_order.position}}',assignment_strategy:'subject_skill',subject_required:true,presence_policy:'ignore',
    start_time:'18:30',due_time:'23:30',due_date_offset_days:0,recurrence_rule:'FREQ=DAILY',rotation_bindings:[binding()],points:2,
    checklist:[{title_template:'Take shower · {{shower_order.position_label}}'},{title_template:'Brush teeth'}]});
  assert.equal(result.status,201,JSON.stringify(result));return result.data.id;
}
async function fromTemplate(template,kid,date='2026-09-19') {
  const result=await call('POST','/tasks',{activity_template_id:template,activity_subject_user_id:kid,start_date:date});
  assert.equal(result.status,201,JSON.stringify(result));return row(result.data.id);
}

async function verifyFourEvenings(t, expected) {
  const template=await expressionTemplate(),series=new Map();
  for(const kid of [frankie,grace,eleanor])series.set(kid,await fromTemplate(template,kid));
  assert.equal(new Set([...series.values()].map(task=>taskSeriesState(d,task.id).occurrence.series_id)).size,3);
  assert.ok([...series.values()].every(task=>task.parent_task_id===null));
  for(let night=0;night<4;night++) {
    const date=`2026-09-${19+night}`;t.mock.timers.setTime(Date.parse(`${date}T23:00:00Z`));tick(`${date}T23:00:00Z`);
    const present=night===1?[frankie,grace]:[eleanor,grace,frankie];
    for(const kid of present) {
      let task=series.get(kid);
      if(!task||task.start_date!==date){task=await fromTemplate(template,kid,date);series.set(kid,task);}
      const context=taskRotationContexts(d,row(task.id))[0];
      assert.deepEqual(context.occurrence.member_ids,expected[night]);assert.equal(context.position,expected[night].indexOf(kid)+1);
      assert.equal(children(task.id)[0].title,`Take shower · ${['1st','2nd','3rd'][expected[night].indexOf(kid)]}`);
      const childDetail=(await call('GET',`/tasks/${children(task.id)[0].id}`,undefined,admin)).data;
      assert.equal(childDetail.rotations[0].position,expected[night].indexOf(kid)+1,'inherited assignee, never the signed-in parent, supplies the action position');
    }
    const ids=present.map(kid=>ownerLink(series.get(kid).id).occurrence_id);assert.equal(new Set(ids).size,1);
    for(const kid of present){await finish(series.get(kid).id);series.set(kid,next(series.get(kid).id));}
    assert.equal(sharedTrack().advance_count,night,'Task completion does not settle the shared period');
    if(night===0){const absent=series.get(eleanor);d.prepare("UPDATE tasks SET archived_at='2026-09-20T00:00:00Z' WHERE id=?").run(absent.id);series.delete(eleanor);}
    tick(`2026-09-${20+night}T06:00:00Z`);assert.equal(sharedTrack().advance_count,night+1);
    tick(`2026-09-${20+night}T06:00:00Z`);assert.equal(sharedTrack().advance_count,night+1);
  }
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods').get().n,4);
  assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE event_type='finalized' AND track_id=?").get(sharedTrack().id).n,4);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
}

test('four scheduled evenings share one snapshot across independent recurring series; absence and child completion cannot advance it',async t=>{
  await verifyFourEvenings(t,[[grace,eleanor,frankie],[eleanor,frankie,grace],[frankie,grace,eleanor],[grace,eleanor,frankie]]);
});

test('last moves to first gives independent bedtime assignees positions 1, 2, 3, 1 through real Task creation and recurrence',async t=>{
  group=S.saveRotationGroupUsage(d,{name:'Kids reverse shower order',member_ids:[grace,eleanor,frankie],usage_mode:'shared',
    shared_config:{...group.shared_config,strategy:'rotating_order',direction:'last_to_first',starting_member_id:grace,
      effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},
    {actorId:admin});
  await verifyFourEvenings(t,[[grace,eleanor,frankie],[frankie,grace,eleanor],[eleanor,frankie,grace],[grace,eleanor,frankie]]);
  assert.equal(sharedTrack().direction,'last_to_first');
  const snapshots=d.prepare('SELECT config_json FROM rotation_occurrences WHERE track_id=? ORDER BY id').all(sharedTrack().id);
  assert.equal(snapshots.length,4);
  assert.ok(snapshots.every(snapshot=>JSON.parse(snapshot.config_json).direction==='last_to_first'));
});

test('early generation remains provisional; skipping tonight preserves the next order without consuming future turns',async t=>{
  const template=await expressionTemplate(),current=await fromTemplate(template,grace),future=await fromTemplate(template,grace,'2026-09-20');
  const context=taskRotationContexts(d,future)[0];assert.equal(context.occurrence.id,0);assert.equal(context.occurrence.provisional,true);
  assert.equal(row(future.id).title,'Bedtime · 3rd');assert.equal(sharedTrack().advance_count,0);
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
  const occurrence=getRotationOccurrence(d,ownerLink(current.id).occurrence_id);
  const skipped=await call('POST',`/automation/rotation-occurrences/${occurrence.id}/skip`,{expected_revision:occurrence.revision});
  assert.equal(skipped.status,200,JSON.stringify(skipped));assert.equal(row(future.id).title,'Bedtime · 1st');
  assert.equal(sharedTrack().advance_count,0);
  t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));tick('2026-09-20T23:00:00Z');
  assert.deepEqual(taskRotationContexts(d,row(future.id))[0].occurrence.member_ids,[grace,eleanor,frankie]);
  assert.equal(d.prepare("SELECT count(*) n FROM rotation_events WHERE occurrence_id=? AND event_type='skipped'").get(occurrence.id).n,1);
});

test('one learner expiration awards zero and cannot pause or advance the shared scheduled period',async t=>{
  const expired=await independent(eleanor,'2026-09-19',{expiration_policy:'expire_incomplete'}),remaining=await independent(grace);
  await finish(children(expired.id)[0].id);
  t.mock.timers.setTime(Date.parse('2026-09-20T03:31:00Z'));
  assert.equal(expireTask(d,expired.id,{now:new Date()}).expired,true);
  assert.equal(row(children(expired.id)[0].id).status,'done');
  assert.equal(d.prepare("SELECT count(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(expired.id).n,0);
  assert.equal(sharedTrack().advance_count,0);assert.equal(getRotationOccurrence(d,ownerLink(expired.id).occurrence_id).status,'resolved');
  await finish(remaining.id);assert.equal(sharedTrack().advance_count,0);
  tick('2026-09-20T06:00:00Z');assert.equal(sharedTrack().advance_count,1);
  assert.deepEqual(d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").all(remaining.id),[{delta:2}]);
});

test('shared override refreshes independent generated fields and actual performer position while retaining manual and historical text',async()=>{
  const template=await expressionTemplate(),tasks=await Promise.all([grace,eleanor,frankie].map(kid=>fromTemplate(template,kid)));
  const historical=children(tasks[2].id)[0];await finish(historical.id);const historicalTitle=row(historical.id).title;
  const manual=await edit(tasks[0].id,{title:'My authored words 99'},'occurrence');assert.equal(manual.status,200,JSON.stringify(manual));
  const occurrence=getRotationOccurrence(d,ownerLink(tasks[0].id).occurrence_id);
  const changed=await call('POST',`/automation/rotation-occurrences/${occurrence.id}/override`,{expected_revision:occurrence.revision,member_ids:[frankie,grace,eleanor]});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(row(tasks[0].id).title,'My authored words 99');
  assert.equal(row(tasks[1].id).title,'Bedtime · 3rd');assert.equal(row(tasks[1].id).description,'My position: 3');
  assert.equal(children(tasks[1].id)[0].title,'Take shower · 3rd');assert.equal(row(historical.id).title,historicalTitle);
  const reassigned=await edit(tasks[1].id,{subtasks:children(tasks[1].id).map(child=>({id:child.id,title:child.title,skill_ids:[],assigned_user_ids:[grace]}))},'occurrence');
  assert.equal(reassigned.status,200,JSON.stringify(reassigned));assert.equal(children(tasks[1].id)[0].title,'Take shower · 2nd');
  assert.equal(sharedTrack().advance_count,0);assert.deepEqual(getRotationOccurrence(d,occurrence.id).original_order.map(member=>member.id),[grace,eleanor,frankie]);
});

test('later weekend windows and after-midnight starts retain the intended evening; a window edit rebinds only that occurrence',async t=>{
  const early=await independent(grace),late=await independent(eleanor,'2026-09-19',{start_time:'19:30'});
  t.mock.timers.setTime(Date.parse('2026-09-20T04:30:00Z'));
  const overnight=await independent(frankie,'2026-09-20',{start_time:'00:15',due_time:'01:30'});
  assert.equal(ownerLink(early.id).occurrence_id,ownerLink(late.id).occurrence_id);assert.equal(ownerLink(late.id).occurrence_id,ownerLink(overnight.id).occurrence_id);
  assert.equal(d.prepare('SELECT period_date FROM task_rotation_periods WHERE task_id=?').get(overnight.id).period_date,'2026-09-19');
  const moved=await edit(late.id,{start_date:'2026-09-20',due_date:'2026-09-20'},'occurrence');assert.equal(moved.status,200,JSON.stringify(moved));
  assert.equal(taskRotationContexts(d,row(late.id))[0].occurrence.id,0);assert.equal(ownerLink(early.id).occurrence_id,ownerLink(overnight.id).occurrence_id);
  assert.equal(sharedTrack().advance_count,0);
});

test('the fall DST overlap preserves the previous evening identity and does not resolve a second period',async t=>{
  t.mock.timers.setTime(Date.parse('2026-11-01T06:30:00Z'));
  const dst=S.saveRotationGroupUsage(d,{name:'DST evenings',member_ids:[grace,eleanor,frankie],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:grace,
    effective_date:'2026-10-31',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}},{actorId:admin,now:new Date('2026-10-31T20:00:00Z')});
  const task=await independent(eleanor,'2026-11-01',{start_time:'01:15',due_time:'01:45',rotation_bindings:[binding({group_id:dst.id})]});
  const period=d.prepare('SELECT * FROM rotation_group_periods WHERE occurrence_id=?').get(ownerLink(task.id).occurrence_id);
  assert.equal(period.period_date,'2026-10-31');assert.equal(period.starts_at,'2026-10-31T22:00:00.000Z');assert.equal(period.ends_at,'2026-11-01T07:00:00.000Z');
  const repeated=(await call('GET',`/tasks/${task.id}`)).data.rotations[0];assert.equal(repeated.position,2);
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods WHERE schedule_id=?').get(period.schedule_id).n,1);
});

test('unscheduled dates remain explicit unresolved bindings and pure Task/Group reads cannot consume turns',async()=>{
  const weekday=S.saveRotationGroupUsage(d,{name:'School evenings',member_ids:[grace,eleanor,frankie],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:grace,
    effective_date:'2026-09-19',weekdays:[1,2,3,4,5],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}},{actorId:admin});
  const task=await independent(grace,'2026-09-19',{rotation_bindings:[binding({group_id:weekday.id})]});
  const before=d.prepare('SELECT total_changes() n').get().n;
  const result=(await call('GET',`/tasks/${task.id}`)).data.rotations[0];
  assert.equal(result.position,null);assert.equal(result.occurrence.state,'not_scheduled');
  await call('GET',`/automation/rotation-groups/${weekday.id}`);
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
});

test('occurrence-only Group changes preserve another purpose and leave the recurring definition and source template independent',async()=>{
  const other=saveRotationGroup(d,{name:'Independent chores',member_ids:[grace,eleanor,frankie]},{actorId:admin});
  const task=await independent(grace,'2026-09-19',{rotation_bindings:[binding(),binding({purpose_key:'chores',group_id:other.id})]});
  const before=taskRotationContexts(d,task).find(item=>item.purpose_key==='chores');
  const definition=taskSeriesState(d,task.id).definition;
  const saved=await edit(task.id,{rotation_bindings:[binding({group_id:other.id}),binding({purpose_key:'chores',group_id:other.id})]},'occurrence');
  assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(taskRotationContexts(d,row(task.id)).find(item=>item.purpose_key==='chores'),before);
  assert.deepEqual(taskSeriesState(d,task.id).definition,definition);assert.equal(sharedTrack().advance_count,0);
});

async function convert(groupId,input) {
  const current=(await call('GET',`/automation/rotation-groups/${groupId}`)).data;
  const body={...input,expected_revision:current.revision};
  const preview=await call('POST',`/automation/rotation-groups/${groupId}/usage-preview`,body);
  assert.equal(preview.status,200,JSON.stringify(preview));
  const saved=await call('PUT',`/automation/rotation-groups/${groupId}`,{...body,confirmation_token:preview.data.confirmation_token});
  assert.equal(saved.status,200,JSON.stringify(saved));return preview.data;
}
test('conversion previews current positions, joins untouched future Tasks and preserves a progressed future occurrence as an explicit exception',async()=>{
  const independentGroup=saveRotationGroup(d,{name:'Former independent',member_ids:[grace,eleanor,frankie]},{actorId:admin});
  const tasks=[];for(const kid of [grace,eleanor])tasks.push(await independent(kid,'2026-09-20',{rotation_bindings:[binding({group_id:independentGroup.id})]}));
  d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(tasks[1].id);
  const protectedLink=ownerLink(tasks[1].id),oldLinks=tasks.map(task=>ownerLink(task.id));
  const input={usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:frankie,effective_date:'2026-09-20',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}};
  const before=(await call('GET',`/automation/rotation-groups/${independentGroup.id}`)).data;
  const rejected=await call('PUT',`/automation/rotation-groups/${independentGroup.id}`,{...input,expected_revision:before.revision});assert.equal(rejected.status,409);
  const preview=await convert(independentGroup.id,input);assert.equal(preview.consumers.length,2);assert.equal(preview.exceptions.length,1);
  assert.deepEqual(preview.proposed_order.map(member=>member.id),[frankie,grace,eleanor]);
  assert.equal(taskRotationContexts(d,row(tasks[0].id))[0].occurrence.id,0);
  assert.deepEqual(ownerLink(tasks[1].id),protectedLink);
  for(const link of oldLinks)assert.ok(getRotationOccurrence(d,link.occurrence_id),'all previous decisions retained');
});

test('shared-to-independent conversion requires explicit per-series starts and materializes each without resetting others',async t=>{
  await independent(grace);
  const tasks=[];for(const kid of [grace,eleanor,frankie])tasks.push(await independent(kid,'2026-09-20'));
  const input={usage_mode:'independent',effective_date:'2026-09-20'};
  const preview=await call('POST',`/automation/rotation-groups/${group.id}/usage-preview`,input);assert.equal(preview.status,200,JSON.stringify(preview));
  const starts=preview.data.consumers.map((consumer,index)=>({consumer_type:consumer.consumer_type,consumer_id:consumer.consumer_id,purpose_key:consumer.purpose_key,next_member_id:[eleanor,frankie,grace][index%3]}));
  const current=(await call('GET',`/automation/rotation-groups/${group.id}`)).data;
  const rejected=await call('PUT',`/automation/rotation-groups/${group.id}`,{...input,expected_revision:current.revision,confirmation_token:preview.data.confirmation_token});assert.equal(rejected.status,400);
  await convert(group.id,{...input,independent_starts:starts});
  for(const task of tasks) {
    const link=ownerLink(task.id);assert.ok(link);
    const identity=taskSeriesState(d,task.id).occurrence.series_id;
    const seed=starts.find(item=>item.consumer_type==='task_series'&&item.consumer_id===String(identity));assert.ok(seed);
    assert.equal(getRotationOccurrence(d,link.occurrence_id).member_ids[0],seed.next_member_id);
    assert.notEqual(getRotationTrack(d,link.track_id).consumer_type,'rotation_group_schedule');
  }
  t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));tick('2026-09-20T23:00:00Z');
  const before=tasks.map(task=>getRotationTrack(d,ownerLink(task.id).track_id));await finish(tasks[0].id);
  assert.equal(getRotationTrack(d,before[0].id).advance_count,1);assert.deepEqual(getRotationTrack(d,before[1].id),before[1]);
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_group_periods').get().n,1);
});

test('independent to shared to independent preserves superseded history without blocking the original Track or settling it on shared completion',async t=>{
  const oldGroup=saveRotationGroup(d,{name:'Round trip',member_ids:[grace,eleanor,frankie]},{actorId:admin});
  const task=await independent(grace,'2026-09-20',{rotation_bindings:[binding({group_id:oldGroup.id})]});
  const oldLink=ownerLink(task.id),oldSnapshot=d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(oldLink.occurrence_id);
  await convert(oldGroup.id,{usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:eleanor,effective_date:'2026-09-20',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1}});
  assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(oldLink.occurrence_id),oldSnapshot);
  assert.ok(getRotationOccurrence(d,oldLink.occurrence_id).supersession);
  t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));S.reconcileSharedRotationPeriods(d,{now:new Date(),groupId:oldGroup.id});
  await finish(task.id);assert.equal(getRotationTrack(d,oldLink.track_id).advance_count,0);
  const future=next(task.id),seriesId=taskSeriesState(d,future.id).occurrence.series_id;
  await convert(oldGroup.id,{usage_mode:'independent',effective_date:'2026-09-21',independent_starts:[{consumer_type:'task_series',consumer_id:String(seriesId),purpose_key:'shower_order',next_member_id:frankie}]});
  t.mock.timers.setTime(Date.parse('2026-09-21T23:00:00Z'));S.reconcileSharedRotationPeriods(d,{now:new Date(),groupId:oldGroup.id});
  const futureLink=ownerLink(future.id);assert.equal(futureLink.track_id,oldLink.track_id);
  assert.equal(getRotationOccurrence(d,futureLink.occurrence_id).member_ids[0],frankie);
  await finish(future.id);assert.equal(getRotationTrack(d,oldLink.track_id).advance_count,1);
  assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(oldLink.occurrence_id),oldSnapshot);
});
