import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='series-anchor-tests';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {taskSeriesState,definitionEqual,normalizeSeriesDefinition}=await import('../server/services/task-series.js');
let d,server,base;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-14T11:30:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin')");
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=1;req.authRole='admin';req.session={userId:1,role:'admin'};next();});
  app.use('/tasks',router);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
async function request(method,path,body){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();assert.equal(response.status,method==='POST'?201:200,JSON.stringify(data));return data;
}
async function seed(relative=false){
  const templateId=relative?Number(d.prepare(`INSERT INTO activity_templates(name,title_template,created_by,assignment_policy,assignment_strategy,
    fixed_user_id,start_time,due_time,due_date_offset_days,subject_required) VALUES('Morning','Morning',1,'fixed','fixed',1,'07:00','08:00',0,0)`).run().lastInsertRowid):null;
  const result=await request('POST','/tasks',{...(templateId?{activity_template_id:templateId}:{}),title:'Morning',assigned_to:[1],start_date:'2026-09-14',start_time:'07:00',
    due_date:'2026-09-14',due_time:'08:00',is_recurring:true,recurrence_rule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    subtasks:[{title:'Required',skill_ids:[]},{title:'Optional',is_optional:true,skill_ids:[]}]});
  return result.data.id;
}
async function edit(id,body){return request('PUT',`/tasks/${id}`,{expected_revision:row(id).revision,
  expected_series_revision:taskSeriesState(d,id).revision,edit_scope:'future',...body});}
async function finish(id){return request('PATCH',`/tasks/${id}/status`,{expected_revision:row(id).revision,status:'done',complete_remaining:true});}

async function weeklyLaundry({date,day,relative=false,offset=0,interval=1}) {
  const templateId=relative?Number(d.prepare(`INSERT INTO activity_templates(name,title_template,created_by,assignment_policy,assignment_strategy,
    fixed_user_id,start_time,due_time,due_date_offset_days,subject_required) VALUES('Weekly Laundry','Weekly Laundry',1,'fixed','fixed',1,'07:00','20:00',?,0)`)
    .run(offset).lastInsertRowid):null;
  const dueDate=relative?new Date(Date.parse(`${date}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10):date;
  const created=await request('POST','/tasks',{title:'Isolated weekly Laundry',assigned_to:[1],
    ...(templateId?{activity_template_id:templateId}:{}),start_date:date,start_time:'07:00',due_date:dueDate,due_time:'20:00',is_recurring:true,
    recurrence_rule:`FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${day}`,
    subtasks:[{title:'Wash laundry',skill_ids:[]},{title:'Optional finishing step',skill_ids:[],is_optional:true}]});
  assert.equal(row(created.data.id).due_date_offset_days,relative?offset:null);
  return created.data.id;
}

for(const relative of [false,true])for(const [day,dates] of [
  ['SA',['2026-09-19','2026-09-26','2026-10-03']],
  ['FR',['2026-09-11','2026-09-18','2026-09-25']],
])test(`${relative?'relative':'legacy'} weekly ${day} advances exactly seven calendar days without regenerating its selected date`,async t=>{
  const first=await weeklyLaundry({date:dates[0],day,relative}),seriesId=taskSeriesState(d,first).series_id;
  let current=first;
  for(const [index,date] of dates.entries()) {
    assert.equal(row(current).start_date,date);assert.equal(row(current).due_date,date);
    assert.equal(taskSeriesState(d,current).occurrence.generation,index);
    if(index===dates.length-1)break;
    t.mock.timers.setTime(Date.parse(`${date}T12:00:00Z`));
    await finish(current);
    const successor=next(current);assert.ok(successor);
    assert.notEqual(successor.due_date,date);assert.equal(successor.due_date,dates[index+1]);
    await finish(current);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(current).n,1);
    current=successor.id;
  }
  const materialized=d.prepare("SELECT occurrence_key FROM task_recurrence_occurrences WHERE series_id=? AND state='materialized' ORDER BY generation").all(seriesId);
  assert.deepEqual(materialized.map(value=>value.occurrence_key),dates);
});

for(const relative of [false,true])for(const [oldDay,oldDate,day,dates] of [
  ['FR','2026-09-18','SA',['2026-09-19','2026-09-26','2026-10-03']],
  ['SA','2026-09-12','FR',['2026-09-11','2026-09-18','2026-09-25']],
])test(`${relative?'relative':'legacy'} ${oldDay} to ${day} series schedule edit never rematerializes the selected date`,async t=>{
  const id=await weeklyLaundry({date:oldDate,day:oldDay,relative});
  const actionIds=d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY sort_order,id').all(id).map(value=>value.id);
  t.mock.timers.setTime(Date.parse(`${dates[0]}T12:00:00Z`));
  const edited=await edit(id,{start_date:dates[0],due_date:dates[0],recurrence_rule:`FREQ=WEEKLY;INTERVAL=1;BYDAY=${day}`});
  assert.equal(edited.series_edit.scope,'future');assert.equal(row(id).due_date,dates[0]);
  assert.deepEqual(d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY sort_order,id').all(id).map(value=>value.id),actionIds);
  await finish(id);
  const successor=next(id);assert.ok(successor);assert.equal(successor.due_date,dates[1]);
  assert.equal(successor.recurrence_rule,`FREQ=WEEKLY;INTERVAL=1;BYDAY=${day}`);
  t.mock.timers.setTime(Date.parse(`${dates[1]}T12:00:00Z`));
  await finish(successor.id);assert.equal(next(successor.id).due_date,dates[2]);
  assert.deepEqual(d.prepare('SELECT due_date FROM tasks WHERE parent_task_id IS NULL ORDER BY id').all().map(value=>value.due_date),dates);
});

test('an already-saved Saturday cadence with Friday nominal provenance advances without repairing history',async t=>{
  const first=await weeklyLaundry({date:'2026-09-11',day:'FR'});
  t.mock.timers.setTime(Date.parse('2026-09-11T12:00:00Z'));await finish(first);
  const current=next(first),history=row(first);
  t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
  await edit(current.id,{start_date:'2026-09-19',due_date:'2026-09-19',recurrence_rule:'FREQ=WEEKLY;BYDAY=SA'});
  await edit(current.id,{due_time:'21:00'});
  const before=taskSeriesState(d,current.id);
  assert.equal(before.occurrence.generation,1);assert.equal(before.occurrence.planned_due_date,'2026-09-18');
  assert.equal(before.occurrence.occurrence_key,'2026-09-18');assert.equal(before.definition.data.task.due_date,'2026-09-18');
  assert.equal(row(current.id).due_date,'2026-09-19');assert.equal(before.revision,3);
  await finish(current.id);assert.equal(next(current.id).due_date,'2026-09-26');
  t.mock.timers.setTime(Date.parse('2026-09-26T12:00:00Z'));
  await finish(next(current.id).id);assert.equal(next(next(current.id).id).due_date,'2026-10-03');
  assert.deepEqual(row(first),history);assert.deepEqual(taskSeriesState(d,current.id).occurrence,before.occurrence);
  assert.deepEqual(taskSeriesState(d,current.id).definition,before.definition);
});

test('a weekday series edit reconciles an untouched materialized successor past the selected concrete date',async t=>{
  const id=await weeklyLaundry({date:'2026-09-18',day:'FR'});
  t.mock.timers.setTime(Date.parse('2026-09-18T12:00:00Z'));await finish(id);
  const materialized=next(id),actionIds=d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(materialized.id);
  // A legacy reopened occurrence can retain an already materialized successor.
  // Keep its completion receipt as historical evidence while making current
  // progress incomplete; the future tree remains exactly at its saved baseline.
  d.prepare("UPDATE tasks SET status='open' WHERE id=? OR parent_task_id=?").run(id,id);
  const receipt=d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(id);
  t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
  const edited=await edit(id,{start_date:'2026-09-19',due_date:'2026-09-19',recurrence_rule:'FREQ=WEEKLY;BYDAY=SA'});
  assert.deepEqual(edited.series_edit.updated,[materialized.id]);assert.deepEqual(edited.series_edit.preserved,[]);
  assert.equal(row(materialized.id).due_date,'2026-09-26');assert.equal(next(id).id,materialized.id);
  assert.deepEqual(d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(materialized.id),actionIds);
  assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').get(id),receipt);
  await finish(id);assert.equal(next(id).id,materialized.id,'finishing the older occurrence cannot branch the latest frontier');
  t.mock.timers.setTime(Date.parse('2026-09-26T12:00:00Z'));await finish(materialized.id);
  assert.equal(next(materialized.id).due_date,'2026-10-03');
  assert.deepEqual(d.prepare('SELECT due_date FROM tasks WHERE parent_task_id IS NULL ORDER BY id').all().map(value=>value.due_date),
    ['2026-09-19','2026-09-26','2026-10-03']);
});

test('a Saturday cadence edit keeps a two-day relative Due offset and two-week interval',async t=>{
  const id=await weeklyLaundry({date:'2026-09-18',day:'FR',relative:true,offset:2,interval:2});
  t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
  await edit(id,{start_date:'2026-09-19',due_date:'2026-09-21',recurrence_rule:'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA'});
  await finish(id);const successor=next(id);
  assert.equal(successor.start_date,'2026-10-03');assert.equal(successor.due_date,'2026-10-05');assert.equal(successor.due_date_offset_days,2);
  t.mock.timers.setTime(Date.parse('2026-10-03T12:00:00Z'));await finish(successor.id);
  assert.equal(next(successor.id).start_date,'2026-10-17');assert.equal(next(successor.id).due_date,'2026-10-19');
});

test('an occurrence-only weekday and date override does not change the durable Friday cadence',async t=>{
  const id=await weeklyLaundry({date:'2026-09-18',day:'FR'}),before=taskSeriesState(d,id);
  t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
  await edit(id,{edit_scope:'occurrence',start_date:'2026-09-19',due_date:'2026-09-19',recurrence_rule:'FREQ=WEEKLY;BYDAY=SA'});
  await finish(id);assert.equal(next(id).due_date,'2026-09-25');
  assert.deepEqual(taskSeriesState(d,id).definition,before.definition);assert.equal(taskSeriesState(d,id).revision,before.revision);
});

test('a title and concrete date edit alone never supplies proof of a changed cadence',async t=>{
  const id=await weeklyLaundry({date:'2026-09-18',day:'SA'});
  t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
  await edit(id,{title:'One-date translation',start_date:'2026-09-19',due_date:'2026-09-19'});
  await finish(id);assert.equal(next(id).due_date,'2026-09-19','the unchanged series still owns its nominal Saturday slot');
});

test('equivalent rule formatting and an end limit do not turn a date override into a cadence change',async t=>{
  for(const [day,rule,storedRule] of [
    ['SA','FREQ=WEEKLY;BYDAY=SA'],
    ['SA,SU','FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,SA'],
    ['SA','FREQ=WEEKLY;INTERVAL=1;BYDAY=SA;UNTIL=20261231'],
    ['SA','FREQ=WEEKLY;BYDAY=SA','RRULE:BYDAY=SA;INTERVAL=1;FREQ=WEEKLY'],
  ]) {
    const id=await weeklyLaundry({date:'2026-09-18',day});
    if(storedRule) {
      // Older imports can retain a prefixed/reordered equivalent RRULE.
      const definition=taskSeriesState(d,id).definition;definition.data.task.recurrence_rule=storedRule;
      d.prepare('UPDATE tasks SET recurrence_rule=? WHERE id=?').run(storedRule,id);
      d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(definition.data),definition.id);
    }
    t.mock.timers.setTime(Date.parse('2026-09-19T12:00:00Z'));
    await edit(id,{title:'Equivalent cadence',start_date:'2026-09-19',due_date:'2026-09-19',recurrence_rule:rule});
    await finish(id);assert.equal(next(id).due_date,'2026-09-19',rule);
  }
});

for(const relative of [false,true])test(`a combined title and concrete date shift keeps the ${relative?'relative':'legacy'} calendar anchor`,async()=>{
  const id=await seed(relative);
  const result=await edit(id,{title:'School morning',start_date:'2026-09-13',due_date:'2026-09-13'});
  assert.equal(row(id).start_date,'2026-09-13');assert.equal(result.series_edit.scope,'future');
  const state=taskSeriesState(d,id);
  assert.equal(state.occurrence.planned_due_date,'2026-09-14');assert.equal(state.definition.data.task.due_date,'2026-09-14');
  await finish(id);assert.equal(next(id).due_date,'2026-09-15');assert.equal(next(id).title,'School morning');
});

for(const relative of [false,true])test(`an explicit API future-scope date-only save edits only the ${relative?'relative':'legacy'} occurrence`,async()=>{
  const id=await seed(relative),before=taskSeriesState(d,id);
  const result=await edit(id,{start_date:'2026-09-13',due_date:'2026-09-13'});
  assert.deepEqual(normalizeSeriesDefinition(taskSeriesState(d,id).definition.data),normalizeSeriesDefinition(before.definition.data));
  assert.equal(row(id).due_date,'2026-09-13');assert.equal(result.series_edit.scope,'occurrence');
  assert.equal(taskSeriesState(d,id).revision,before.revision);
  assert.equal(taskSeriesState(d,id).occurrence.planned_due_date,'2026-09-14');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='series_edited'").get(id).n,0);
  await finish(id);assert.equal(next(id).due_date,'2026-09-15');
});

for(const relative of [false,true])test(`historical ${relative?'relative':'legacy'} edits normalize dates and date-only requests leave all state untouched`,async()=>{
  const id=await seed(relative);await finish(id);const successor=next(id),historical=row(id);
  const result=await edit(id,{title:'Future morning',start_date:'2026-09-13',due_date:'2026-09-13'});
  assert.deepEqual(row(id),historical);assert.equal(row(successor.id).due_date,'2026-09-15');
  assert.equal(row(successor.id).title,'Future morning');assert.ok(result.series_edit.current_preserved);
  const before={task:row(successor.id),definitions:d.prepare('SELECT * FROM task_recurrence_definitions').all(),
    events:d.prepare('SELECT * FROM task_activity_events').all()};
  const noChange=await edit(id,{title:'Future morning',start_date:'2026-09-12',due_date:'2026-09-12'});
  assert.equal(noChange.unchanged,true);assert.deepEqual(row(successor.id),before.task);
  assert.deepEqual(d.prepare('SELECT * FROM task_recurrence_definitions').all(),before.definitions);
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events').all(),before.events);
});

test('definition equality is stable across prospective versus database action property ordering',async()=>{
  const id=await seed(),definition=taskSeriesState(d,id).definition.data,copy=structuredClone(definition);
  copy.subtasks=copy.subtasks.map(action=>Object.fromEntries(Object.entries(action).reverse()));
  for(const action of copy.subtasks){action.task=Object.fromEntries(Object.entries(action.task).reverse());
    if(action.task.activity_template_checklist_item_id===null)delete action.task.activity_template_checklist_item_id;}
  assert.equal(definitionEqual(definition,copy),true);
});

function rotationUsers(){
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(2,'second','Second','x','member'),(3,'third','Third','x','member')");
}
async function rotatingTask(extra={}) {
  const result=await request('POST','/tasks',{title:'Rotation',due_date:'2026-09-14',is_recurring:true,
    recurrence_rule:'FREQ=DAILY',assignment_mode:'round_robin',rotation_user_ids:[1,2,3],...extra});
  return result.data.id;
}

test('an occurrence-only fixed override preserves a nonzero grouped rotation index and cycle',async t=>{
  rotationUsers();
  const first=await rotatingTask({rotation_group:'Morning',rotation_slot:0});
  const peer=await rotatingTask({rotation_group:'Morning',rotation_slot:1});
  await finish(first);await finish(peer);
  const current=next(first),currentPeer=next(peer);
  assert.equal(current.rotation_index,1);assert.equal(current.rotation_cycle,1);
  t.mock.timers.setTime(Date.parse('2026-09-15T11:30:00Z'));
  await edit(current.id,{edit_scope:'occurrence',assignment_mode:'fixed',assigned_to:[3]});
  assert.equal(row(current.id).assigned_to,3);assert.equal(row(current.id).assignment_mode,'fixed');
  assert.equal(row(current.id).rotation_index,1);assert.equal(row(current.id).rotation_cycle,1);
  assert.equal(taskSeriesState(d,current.id).revision,1);
  await finish(current.id);assert.equal(next(current.id),undefined,'the durable cohort still waits for its peer');
  await finish(currentPeer.id);
  const successors=[next(current.id),next(currentPeer.id)];
  assert.deepEqual(successors.map(task=>task.assigned_to),[3,1]);
  assert.ok(successors.every(task=>task.rotation_index===2&&task.rotation_cycle===2&&task.rotation_group==='Morning'));
});

test('an occurrence-only roster override preserves a nonzero index for the next canonical assignment',async t=>{
  rotationUsers();const first=await rotatingTask();await finish(first);const current=next(first);
  assert.equal(current.rotation_index,1);assert.equal(current.assigned_to,2);
  t.mock.timers.setTime(Date.parse('2026-09-15T11:30:00Z'));
  await edit(current.id,{edit_scope:'occurrence',rotation_user_ids:[1,3]});
  assert.equal(row(current.id).assigned_to,1);assert.equal(row(current.id).rotation_index,1);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order').all(current.id).map(value=>value.user_id),[1,3]);
  await finish(current.id);const successor=next(current.id);
  assert.equal(successor.assigned_to,3);assert.equal(successor.rotation_index,2);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order').all(successor.id).map(value=>value.user_id),[1,2,3]);
  assert.equal(taskSeriesState(d,current.id).revision,1);
});
