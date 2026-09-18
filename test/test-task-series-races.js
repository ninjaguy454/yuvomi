import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='isolated-series-races';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {todayKey}=await import('../server/utils/timezone.js');
let d,server,origin,admin,child;
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children=id=>d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(id);
const successor=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
test.beforeEach(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('parent','Parent','x','admin','parent')").run().lastInsertRowid);
  child=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('child','Child','x','member','child')").run().lastInsertRowid);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(child);
  const app=express();app.use(express.json());app.use((req,res,next)=>{const id=Number(req.headers['x-actor']||admin),u=d.prepare('SELECT role FROM users WHERE id=?').get(id);req.authUserId=id;req.authRole=u.role;req.session={userId:id,role:u.role};next();});app.use('/tasks',router);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
async function call(method,path,body,actor=admin){const res=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','x-actor':String(actor)},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,...await res.json()};}
async function create(extra={}){
  const yesterday=new Date(Date.parse(`${todayKey(d)}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  const r=await call('POST','/tasks',{title:'Routine',assigned_to:[child],points:2,is_recurring:1,recurrence_rule:'FREQ=DAILY',start_date:yesterday,due_date:yesterday,subtasks:[{title:'First'},{title:'Last'}],...extra});
  assert.equal(r.status,201,JSON.stringify(r));return r.data;
}
async function fresh(id){const r=await call('GET',`/tasks/${id}`);assert.equal(r.status,200);return r.data;}
async function editFuture(task,body){return call('PUT',`/tasks/${task.id}`,{expected_revision:task.revision,expected_series_revision:task.recurrence_series_revision,edit_scope:'future',...body});}

test('no-op edit changes no Task/series revision or Activity entry',async()=>{
  const task=await create(),events=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  const response=await call('PUT',`/tasks/${task.id}`,{expected_revision:task.revision,title:task.title});
  assert.equal(response.status,200);assert.equal(response.unchanged,true);
  assert.equal(read(task.id).revision,task.revision);assert.equal(response.data.recurrence_series_revision,task.recurrence_series_revision);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,events);
});

test('series revision rejects a second editor even with a fresh occurrence revision',async()=>{
  const task=await create();const winner=await editFuture(task,{title:'First editor'});assert.equal(winner.status,200,JSON.stringify(winner));
  const stale=await call('PUT',`/tasks/${task.id}`,{expected_revision:read(task.id).revision,expected_series_revision:task.recurrence_series_revision,edit_scope:'future',title:'Stale editor'});
  assert.equal(stale.status,409);assert.equal(stale.reason,'series_revision_conflict');assert.equal(read(task.id).title,'First editor');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,2);
});

test('completion racing series editing has one revision winner and never duplicates rewards or recurrence',async()=>{
  const task=await create();
  const results=await Promise.all([
    call('PATCH',`/tasks/${task.id}/status`,{expected_revision:task.revision,status:'done',complete_remaining:true}),
    editFuture(task,{title:'Revised routine'}),
  ]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  if(read(task.id).status!=='done')changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(task.id).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(task.id).n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND action_task_id=? AND event_type='completed'").get(task.id,task.id).n,1);
});

test('future progress racing propagation is either preserved or rejected as stale, never overwritten',async()=>{
  const task=await create();changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  const past=await fresh(task.id),future=successor(task.id),step=children(future.id)[0];
  const [edit,progress]=await Promise.all([
    editFuture(past,{title:'New future definition'}),
    call('PATCH',`/tasks/${step.id}/status`,{expected_revision:step.revision,expected_parent_revision:future.revision,status:'done'}),
  ]);
  assert.equal(edit.status,200,JSON.stringify(edit));assert.ok([200,409].includes(progress.status),JSON.stringify(progress));
  if(progress.status===200){assert.equal(read(step.id).status,'done');assert.equal(edit.series_edit.preserved.length,1);assert.equal(read(future.id).title,'Routine');}
  else {assert.equal(read(step.id).status,'open');assert.deepEqual(edit.series_edit.updated,[future.id]);}
  assert.equal(read(task.id).title,'Routine');assert.equal(edit.series_edit.current_preserved,true);
});

test('an unexpected future write failure rolls back the series and every attempted propagation',async()=>{
  const task=await create();changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  const past=await fresh(task.id),future=successor(task.id),before=read(future.id),count=d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n;
  d.exec(`CREATE TRIGGER injected_series_failure BEFORE UPDATE OF title ON tasks WHEN OLD.id=${future.id} BEGIN SELECT RAISE(ABORT,'injected series propagation failure'); END;`);
  const result=await editFuture(past,{title:'Must roll back'});
  assert.equal(result.status,500,JSON.stringify(result));assert.deepEqual(read(future.id),before);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_recurrence_definitions').get().n,count);
  assert.equal((await fresh(task.id)).recurrence_series_revision,past.recurrence_series_revision);
});

test('restricted members cannot forge future scope and non-recurring Tasks cannot acquire a series via scope alone',async()=>{
  d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,'tasks.change_dates','none')").run(String(child));
  const task=await create();const before=read(task.id);
  const denied=await call('PUT',`/tasks/${task.id}`,{expected_revision:task.revision,expected_series_revision:task.recurrence_series_revision,edit_scope:'future',title:'Unauthorized'},child);
  assert.equal(denied.status,403);assert.deepEqual(read(task.id),before);
  const standalone=await create({is_recurring:0,recurrence_rule:null});
  const invalid=await call('PUT',`/tasks/${standalone.id}`,{expected_revision:standalone.revision,expected_series_revision:1,edit_scope:'future',title:'Invalid series'});
  assert.equal(invalid.status,400);assert.equal(read(standalone.id).title,'Routine');
});

test('future reconciliation retains manual rotation position instead of the selected historical assignee',async()=>{
  const task=await create({assignment_mode:'round_robin',rotation_user_ids:[child,admin]});
  changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  const future=successor(task.id),past=await fresh(task.id);
  assert.equal(future.assigned_to,admin);
  const result=await editFuture(past,{title:'Revised rotation'});
  assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.series_edit.updated,[future.id]);
  assert.equal(read(future.id).assigned_to,admin);assert.equal(read(future.id).rotation_index,future.rotation_index);
});

test('weekday, relative span, time, expiry and point changes update a pristine future without rewriting history',async()=>{
  const task=await create();changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  const past=await fresh(task.id),future=successor(task.id),historical=read(task.id);
  const due=new Date(Date.parse(`${past.start_date}T00:00:00Z`)+4*86400000).toISOString().slice(0,10);
  const result=await editFuture(past,{recurrence_rule:'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',start_time:'15:30',due_date:due,due_time:'07:30',expiration_policy:'expire_incomplete',points:5});
  assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.series_edit.updated,[future.id]);
  const revised=read(future.id);assert.equal(new Date(`${revised.start_date}T00:00:00Z`).getUTCDay(),1);
  assert.equal(Date.parse(revised.due_date)-Date.parse(revised.start_date),4*86400000);
  assert.equal(revised.start_time,'15:30');assert.equal(revised.due_time,'07:30');assert.equal(revised.points,5);
  assert.equal(revised.expiration_policy,'expire_incomplete');assert.deepEqual(read(task.id),historical);
  assert.equal(d.prepare('SELECT SUM(delta) n FROM reward_ledger WHERE task_id=?').get(task.id).n,2);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(future.id).n,0);
});

test('ending a series preserves existing future work as an explicit exception and generates no successor',async()=>{
  const task=await create();changeTaskStatus(d,task.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  const past=await fresh(task.id),future=successor(task.id),before=read(future.id);
  const result=await editFuture(past,{is_recurring:0,recurrence_rule:null});
  assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(result.series_edit.preserved,[{task_id:future.id,reason:'schedule_ended'}]);
  assert.deepEqual(read(future.id),before);
  changeTaskStatus(d,future.id,'done',{actorId:admin,requireRevision:false,body:{complete_remaining:true}});
  assert.equal(successor(future.id),undefined);
});

test('changing only a child Optional flag is not mistaken for a no-op',async()=>{
  const task=await create(),step=children(task.id)[0];
  const result=await call('PUT',`/tasks/${step.id}`,{expected_revision:step.revision,expected_parent_revision:task.revision,is_optional:1});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(read(step.id).is_optional,1);assert.notEqual(result.unchanged,true);
});
