import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-skip-tests';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {changeTaskStatus,expireTask}=await import('../server/services/task-lifecycle.js');
const {awardForCompletion}=await import('../server/services/rewards.js');
const {inspectTaskSupervision,reconcileTaskSupervision,supervisionProjectionUpdates}=await import('../server/services/task-supervision.js');
const {refreshExistingTaskSupervision}=await import('../server/services/task-supervision-refresh.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const {getCountdowns}=await import('../server/services/countdowns.js');
let d,admin,child,other,actor,server,base;
test.before(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  const user=d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)");
  admin=Number(user.run('parent','Parent','admin','parent').lastInsertRowid);
  child=Number(user.run('child','Child','member','child').lastInsertRowid);
  other=Number(user.run('other','Other','member','other').lastInsertRowid);
  for(const id of [child,other])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  actor=admin;const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=actor;req.authRole=actor===admin?'admin':'member';req.authMethod='session';req.session={userId:actor};next();});
  app.use('/tasks',router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/tasks`;
});
test.after(()=>{server.closeAllConnections();server.close();_setTestDatabase(null);d.close();});
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const rows=(sql,...args)=>d.prepare(sql).all(...args);
async function call(method,path='',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data={error:text};}return {status:r.status,...data};}
async function fixture(extra={}){
  actor=admin;const r=await call('POST','',{title:'Synthetic routine',assigned_to:[child,other],points:5,is_recurring:true,recurrence_rule:'FREQ=DAILY',start_date:'2026-11-01',due_date:'2026-11-01',due_time:'08:00',expiration_policy:'expire_incomplete',subtasks:[{title:'First',points:2},{title:'Second',points:3}],...extra});
  assert.equal(r.status,201,JSON.stringify(r));return r.data;
}
function request(task,operation_id=`skip-${task.id}`,extra={}){return {operation_id,expected_revision:read(task.id).revision,...extra};}
const skip=(task,body=request(task))=>call('POST',`/${task.id}/skip`,body);

// Catches accidental completion, child loss, award mutation, assignment edits or timestamp anchoring.
test('whole future occurrence closes unfinished work, preserves earned child points and advances the nominal calendar',async()=>{
  const t=await fixture();changeTaskStatus(d,t.subtasks[0].id,'done',{actorId:child,requireRevision:false,now:new Date('2026-11-01T12:30:00Z')});
  const ledger=rows('SELECT * FROM reward_ledger'),completions=rows('SELECT * FROM task_completions');
  const assignments=rows('SELECT * FROM task_assignments WHERE task_id=? ORDER BY user_id',t.id);
  const r=await skip(t);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.status,'skipped');assert.ok(r.data.skipped_at);
  assert.equal(read(t.subtasks[0].id).status,'done');assert.equal(read(t.subtasks[1].id).status,'skipped');
  assert.deepEqual(rows('SELECT * FROM reward_ledger'),ledger);assert.deepEqual(rows('SELECT * FROM task_completions'),completions);
  assert.deepEqual(rows('SELECT * FROM task_assignments WHERE task_id=? ORDER BY user_id',t.id),assignments);
  assert.equal(read(t.id).points,5);assert.equal(awardForCompletion(d,t.id,child),false);
  const next=rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',t.id);assert.equal(next.length,1);
  assert.equal(next[0].due_date,'2026-11-02');assert.equal(next[0].start_date,'2026-11-02');assert.equal(next[0].status,'open');assert.equal(next[0].points,5);
  assert.deepEqual(rows('SELECT status FROM tasks WHERE parent_task_id=? ORDER BY id',next[0].id).map(x=>x.status),['open','open']);
  assert.equal(rows('SELECT state FROM task_recurrence_occurrences WHERE task_id=?',t.id)[0].state,'materialized');
});
// Catches duplicate effects, revision-before-receipt ordering and revoked-authority replay.
test('identical retry survives archive, makes one audit and successor, and still rechecks authority',async()=>{
  const t=await fixture(),body=request(t);assert.equal((await skip(t,body)).status,200);
  assert.equal((await call('PATCH',`/${t.id}/status`,{status:'archived',expected_revision:read(t.id).revision})).status,200);
  const replay=await skip(t,body);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.replayed,true);assert.ok(replay.data.archived_at);
  assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='skipped'",t.id).length,1);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',t.id).length,1);
  assert.equal((await skip(t,{...body,expected_revision:read(t.id).revision})).status,409);
  actor=child;assert.equal((await skip(t,body)).status,403);
});
// Catches partial writes on invalid requests and capability leakage from complete_own or default edit.
test('child default permission, stale revision and reason input are denied without effects',async()=>{
  const t=await fixture(),body=request(t);actor=child;assert.equal((await skip(t,body)).status,403);actor=admin;
  assert.equal((await skip(t,{...body,expected_revision:body.expected_revision+1})).status,409);
  assert.equal((await skip(t,{...body,reason:'not collected'})).status,400);
  assert.equal(read(t.id).status,'open');assert.equal(rows('SELECT * FROM task_skip_receipts WHERE task_id=?',t.id).length,0);
});
// Catches generic completion/reopen bypass after excusal.
test('skipped root and child reject operational writers and deadline processing',async()=>{
  const t=await fixture();assert.equal((await skip(t)).status,200);
  for(const id of [t.id,t.subtasks[1].id])for(const status of ['open','in_progress','done']){
    const r=await call('PATCH',`/${id}/status`,{status,expected_revision:read(id).revision,expected_parent_revision:read(t.id).revision,complete_remaining:true});assert.equal(r.status,409,JSON.stringify(r));
  }
  assert.equal((await call('POST',`/${t.id}/reopen`,{expected_revision:read(t.id).revision})).status,409);
  assert.equal(expireTask(d,t.id,{now:new Date('2026-11-03T15:00:00Z')}).expired,false);
});
// Catches expiry audit destruction or future frontier regeneration during manager correction.
test('expired correction retains original evidence and existing successor',async()=>{
  const t=await fixture();expireTask(d,t.id,{now:new Date('2026-11-01T13:00:00Z')});
  const next=rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',t.id);
  const r=await skip(t);assert.equal(r.status,200,JSON.stringify(r));assert.equal(read(t.id).expired_at,null);
  assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='expired'",t.id).length,1);
  assert.deepEqual(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',t.id),next);
  const history=await call('GET',`/${t.id}/completions`);
  assert.equal(history.status,200,JSON.stringify(history));
  assert.deepEqual(history.data.map(row=>row.event_type),['skipped']);
  assert.equal(history.data[0].points,0);assert.equal(history.data[0].user_name,'Parent');
});
// Catches accidental support for recurrence modes without a defined excusal contract.
test('completion-relative, plain, child, completed and pending-export targets reject',async()=>{
  for(const extra of [{recurrence_from_completion:true},{is_recurring:false,recurrence_rule:null},{assignment_mode:'round_robin',rotation_user_ids:[child,other]}]){
    const t=await fixture(extra),r=await skip(t);assert.equal(r.status,409,JSON.stringify(r));assert.equal(read(t.id).status,'open');
  }
  const t=await fixture();const r=await call('POST',`/${t.subtasks[0].id}/skip`,request(t.subtasks[0],`child-${t.id}`));assert.equal(r.status,409,JSON.stringify(r));
  d.prepare('UPDATE tasks SET target_caldav_account_id=42,target_caldav_list_url=? WHERE id=?').run('https://example.invalid/list',t.subtasks[1].id);
  assert.equal((await skip(t)).status,409);assert.equal(read(t.id).status,'open');
  const done=await fixture();changeTaskStatus(d,done.id,'done',{actorId:child,requireRevision:false,now:new Date('2026-11-01T12:30:00Z'),body:{complete_remaining:true}});assert.equal((await skip(done)).status,409);
});

// Catches background resurrection and empty helper scopes becoming successful completions.
test('linked unfinished helpers remain skipped through reads and supervisor refresh',async()=>{
  const t=await fixture();
  const insert=d.prepare('INSERT INTO tasks(title,created_by,assigned_to,parent_task_id) VALUES(?,?,?,?)');
  const helper=Number(insert.run('Synthetic supervisor',admin,other,null).lastInsertRowid);
  const counterpart=Number(insert.run('Synthetic supervision step',admin,other,helper).lastInsertRowid);
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(t.id,helper);
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES(?,?,?,?,?,'assigned')").run(t.id,t.subtasks[0].id,counterpart,child,other);
  assert.equal((await skip(t)).status,200);
  assert.equal(read(helper).status,'skipped');assert.equal(read(counterpart).status,'skipped');
  const before=rows('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id',helper,counterpart);
  const view=inspectTaskSupervision(d,t.id);assert.equal(view.actions[0].state,'not_required');assert.equal(view.actions[0].skipped,true);
  assert.deepEqual(supervisionProjectionUpdates(d,t.id).map(x=>x.status),['skipped','skipped']);
  reconcileTaskSupervision(d,t.id);assert.equal(refreshExistingTaskSupervision(d).failed,0);
  assert.deepEqual(rows('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id',helper,counterpart),before);
});

// Catches rollback of durable excusal, false replay success, and duplicate recovery slots.
test('generation failure commits excusal and receipt, reports pending on replay and recovers one nominal successor',async()=>{
  const t=await fixture(),body=request(t);
  d.exec(`CREATE TRIGGER synthetic_generation_failure BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${t.id}
    BEGIN SELECT RAISE(ABORT,'Synthetic materialization failure'); END;`);
  const r=await skip(t,body);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.recurrence_pending,true);assert.equal(read(t.id).status,'skipped');
  assert.equal(rows('SELECT * FROM task_skip_receipts WHERE task_id=?',t.id).length,1);
  assert.equal((await skip(t,body)).recurrence_pending,true);
  d.exec('DROP TRIGGER synthetic_generation_failure');
  assert.equal(reconcileTaskExpirations(d,{now:new Date('2026-10-10T12:00:00Z'),onError:error=>{throw error;}}).failed,0);
  const successor=rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',t.id);
  assert.equal(successor.length,1);assert.equal(successor[0].due_date,'2026-11-02');
  assert.equal((await skip(t,body)).recurrence_pending,false);
  assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='skipped'",t.id).length,1);
});

// Catches a restored historical child becoming an active countdown or expiring independently.
test('independently archived child stays preserved and its later restore does not reopen occurrence work',async()=>{
  const t=await fixture(),id=t.subtasks[1].id;
  d.prepare("UPDATE tasks SET archived_at='2026-10-10T12:00:00Z',due_date='2026-11-01',countdown=1 WHERE id=?").run(id);
  assert.equal((await skip(t)).status,200);assert.equal(read(id).status,'open');assert.ok(read(id).archived_at);
  const r=await call('PATCH',`/${id}/archive`,{archived:false,expected_revision:read(id).revision,expected_parent_revision:read(t.id).revision});assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(expireTask(d,id,{now:new Date('2026-11-03T15:00:00Z')}).expired,false);
  assert.ok(!getCountdowns(d,{userId:admin,todayKey:'2026-11-01'}).items.some(row=>row.source==='task'&&row.id===id));
  assert.throws(()=>changeTaskStatus(d,id,'done',{actorId:admin,requireRevision:false,now:new Date('2026-11-01T12:30:00Z')}),error=>error.details?.reason==='task_skipped');
});
