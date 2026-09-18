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
