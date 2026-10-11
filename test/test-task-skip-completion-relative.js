import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-sequence-skip-only';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router}=await import('../server/routes/tasks.js');
const {skipTaskOccurrence}=await import('../server/services/task-skip.js');
const {expireTask}=await import('../server/services/task-lifecycle.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const {ensureSeriesDefinition,appendSeriesDefinition,taskSeriesState}=await import('../server/services/task-series.js');
let d,server,base,actor;
const admin=1,child=2,other=3;
test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-11T17:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
    d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();
    if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
  _setTestDatabase(d);
  d.exec(`INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES
    (1,'manager','Manager','x','admin','parent'),(2,'member-a','Member A','x','member','child'),(3,'member-b','Member B','x','member','other');
    INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1);
    INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York');`);
  actor=admin;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{
    req.authUserId=actor;req.authRole=actor===admin?'admin':'member';req.authMethod='session';req.session={userId:actor};next();
  });
  app.use('/tasks',router);server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/tasks`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const rows=(sql,...args)=>d.prepare(sql).all(...args);
async function call(method,path='',body){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,...await response.json()};
}
async function fixture(extra={}){
  const result=await call('POST','',{title:'Routine A',assigned_to:[child,other],points:5,is_recurring:true,
    recurrence_from_completion:true,recurrence_rule:'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    start_date:'2026-10-06',start_time:'06:00',due_date:'2026-10-06',due_time:'07:20',expiration_policy:'keep_overdue',
    subtasks:[{title:'Action A',points:2},{title:'Action B',points:3}],...extra});
  assert.equal(result.status,201,JSON.stringify(result));
  // The integrated input fix must preserve real API-created step points.
  assert.deepEqual(result.data.subtasks.map(task=>task.points),[2,3]);
  if(extra.due_date_offset_days!=null)d.prepare('UPDATE tasks SET due_date_offset_days=? WHERE id=?').run(extra.due_date_offset_days,result.data.id);
  ensureSeriesDefinition(d,result.data.id);appendSeriesDefinition(d,result.data.id,{actorId:admin});return result.data;
}
const body=(task,operation_id=`sequence-${task.id}`)=>({operation_id,expected_revision:read(task.id).revision});
const skip=(task,request=body(task),now=new Date())=>skipTaskOccurrence(d,task.id,{principal:admin,body:request,now});
function successor(id){const matches=rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',id);assert.equal(matches.length,1);return matches[0];}
const definitions=()=>rows('SELECT * FROM task_recurrence_definitions ORDER BY id');
async function edit(task,changes){return call('PUT',`/${task.id}`,{edit_scope:'future',expected_revision:read(task.id).revision,
  expected_series_revision:taskSeriesState(d,task.id).revision,...changes});}

// Rejecting this recurrence mode or routing Skip through completion would fail.
test('completion-relative Skip exposes the existing action and preserves earned shared steps without awards',async()=>{
  const task=await fixture();
  const childTask=read(task.subtasks[0].id);
  actor=child;
  const completed=await call('PATCH',`/${childTask.id}/status`,{status:'done',expected_revision:childTask.revision,expected_parent_revision:read(task.id).revision});
  actor=admin;
  assert.equal(completed.status,200,JSON.stringify(completed));
  const ledger=rows('SELECT * FROM reward_ledger ORDER BY id'),completions=rows('SELECT * FROM task_completions ORDER BY id');
  assert.ok(ledger.length>0,'the fixture must contain already earned child points');
  const assignments=rows('SELECT * FROM task_assignments ORDER BY task_id,user_id');
  const definitionBefore=definitions();
  const grantsBefore=rows('SELECT * FROM access_capabilities ORDER BY subject_type,subject_id,capability_key');
  const detail=await call('GET',`/${task.id}`);assert.equal(detail.data.permissions.skip_occurrence,true);assert.equal(detail.data.can_skip_occurrence,true);
  const result=await call('POST',`/${task.id}/skip`,body(task));assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(read(task.id).status,'skipped');assert.equal(read(childTask.id).status,'done');assert.equal(read(task.subtasks[1].id).status,'skipped');
  assert.deepEqual(rows('SELECT * FROM reward_ledger ORDER BY id'),ledger);assert.deepEqual(rows('SELECT * FROM task_completions ORDER BY id'),completions);
  for(const assignment of assignments)assert.deepEqual(rows('SELECT * FROM task_assignments WHERE task_id=? AND user_id=?',assignment.task_id,assignment.user_id),[assignment]);
  assert.deepEqual(definitions(),definitionBefore);
  assert.deepEqual(rows('SELECT * FROM access_capabilities ORDER BY subject_type,subject_id,capability_key'),grantsBefore);
  const next=successor(task.id);assert.equal(next.due_date,'2026-10-07');assert.equal(next.start_date,'2026-10-07');assert.equal(next.due_time,'07:20');assert.equal(next.start_time,'06:00');
  assert.equal(next.status,'open');assert.equal(next.recurrence_from_completion,1);assert.equal(next.recurrence_rule,task.recurrence_rule);assert.equal(next.points,5);
  assert.deepEqual(rows('SELECT status,points FROM tasks WHERE parent_task_id=? ORDER BY id',next.id),[{status:'open',points:2},{status:'open',points:3}]);
  assert.deepEqual(rows('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id',next.id),[{user_id:child},{user_id:other}]);
});

// Advancing from the current date or letting the worker consume keep-overdue slots would fail.
test('repeated intentional skips walk every missed weekday slot exactly once',async()=>{
  let current=await fixture();const definitionBefore=definitions(),firstId=current.id;
  const skippedIds=[];
  for(const due of ['2026-10-07','2026-10-08','2026-10-09','2026-10-12']){
    const request=body(current);const result=skip(current,request);assert.equal(result.recurrencePending,false);skippedIds.push(current.id);
    const replay=skip(current,request,new Date('2026-10-20T03:30:00Z'));assert.equal(replay.replayed,true);assert.equal(replay.recurrencePending,false);
    current=successor(current.id);assert.equal(current.due_date,due);assert.equal(current.status,'open');
    const reconciliation=reconcileTaskExpirations(d,{now:new Date('2026-10-11T17:00:00Z'),onError:error=>{throw error;}});
    assert.equal(reconciliation.expired,0);assert.equal(read(current.id).status,'open');
  }
  assert.deepEqual(definitions(),definitionBefore);
  assert.equal(rows("SELECT * FROM tasks WHERE parent_task_id IS NULL AND status='skipped'").length,4);
  assert.equal(rows('SELECT * FROM task_skip_receipts').length,4);assert.equal(rows("SELECT * FROM task_activity_events WHERE event_type='skipped'").length,4);
  assert.equal(rows('SELECT * FROM reward_ledger').length,0);assert.equal(rows('SELECT * FROM task_completions').length,0);
  const series=rows('SELECT * FROM task_recurrence_occurrences WHERE series_id=(SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?) ORDER BY generation',firstId);
  assert.equal(series.length,5);assert.equal(new Set(series.map(row=>row.occurrence_key)).size,5);
  for(const id of skippedIds){const result=await call('PATCH',`/${id}/status`,{status:'open',expected_revision:read(id).revision});assert.equal(result.status,409);}
});

// A clock-derived recovery date or missing pending/replay support would fail.
test('failed relative successor retries across midnight and timezone changes using the same nominal slot',async t=>{
  const task=await fixture(),request=body(task),definitionBefore=definitions();
  d.exec(`CREATE TRIGGER synthetic_sequence_failure BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${task.id}
    BEGIN SELECT RAISE(ABORT,'Synthetic sequence failure'); END;`);
  const result=skip(task,request,new Date('2026-10-12T03:59:00Z'));assert.equal(result.task.status,'skipped');assert.equal(result.recurrencePending,true);
  assert.equal(rows('SELECT * FROM task_skip_receipts WHERE task_id=?',task.id).length,1);
  t.mock.timers.setTime(Date.parse('2026-10-12T04:01:00Z'));
  d.exec("UPDATE sync_config SET value='Pacific/Auckland' WHERE key='household_timezone'");
  assert.equal(skip(task,request).recurrencePending,true);assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
  d.exec('DROP TRIGGER synthetic_sequence_failure');
  for(let retry=0;retry<2;retry++)assert.equal(reconcileTaskExpirations(d,{now:new Date('2026-10-20T18:00:00Z'),onError:error=>{throw error;}}).failed,0);
  const next=successor(task.id);assert.equal(next.due_date,'2026-10-07');assert.equal(next.start_time,'06:00');assert.equal(next.due_time,'07:20');
  const replay=skip(task,request);assert.equal(replay.replayed,true);assert.equal(replay.recurrencePending,false);
  assert.deepEqual(definitions(),definitionBefore);assert.equal(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='skipped'",task.id).length,1);
});

// Using Due instead of the snapshotted Start anchor or skipping the interval would fail.
test('relative date windows advance one scheduled interval and retain wall times',async()=>{
  const task=await fixture({recurrence_rule:'FREQ=DAILY;INTERVAL=3',start_date:'2026-10-01',due_date:'2026-10-03',due_date_offset_days:2});
  skip(task);const next=successor(task.id);
  assert.equal(next.start_date,'2026-10-04');assert.equal(next.due_date,'2026-10-06');assert.equal(next.due_date_offset_days,2);assert.equal(next.start_time,'06:00');assert.equal(next.due_time,'07:20');
});

test('completion-relative weekend Skip selects the immediately following scheduled day',async()=>{
  const task=await fixture({recurrence_rule:'FREQ=WEEKLY;BYDAY=SA,SU',start_date:'2026-10-10',due_date:'2026-10-10'});
  skip(task);const sunday=successor(task.id);assert.equal(sunday.due_date,'2026-10-11');
  skip(sunday);assert.equal(successor(sunday.id).due_date,'2026-10-17');
});

test('automatic completion-relative expiry stays paused until an authorized Skip supplies sequence advancement',async()=>{
  const task=await fixture({expiration_policy:'expire_incomplete'});
  const expired=expireTask(d,task.id,{now:new Date('2026-10-06T12:00:00Z')});assert.equal(expired.expired,true);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
  reconcileTaskExpirations(d,{now:new Date('2026-10-11T17:00:00Z'),onError:error=>{throw error;}});
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
  const expiryEvidence=rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='expired'",task.id);
  skip(task);assert.equal(successor(task.id).due_date,'2026-10-07');assert.equal(read(task.id).expired_at,null);
  assert.deepEqual(rows("SELECT * FROM task_activity_events WHERE task_id=? AND event_type='expired'",task.id),expiryEvidence);
});

test('relative ended rules create no successor and historical skips never duplicate a later frontier',async()=>{
  const ended=await fixture({recurrence_rule:'FREQ=DAILY;UNTIL=20261006'});assert.equal(skip(ended).recurrencePending,false);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',ended.id).length,0);
  const task=await fixture(),request=body(task);skip(task,request);const next=successor(task.id);
  assert.equal(skip(task,request).replayed,true);assert.equal(successor(task.id).id,next.id);
  assert.equal(rows('SELECT * FROM reward_ledger').length,0);
});

test('relative Skip retains human/device and stale-revision restrictions without receipt effects',async()=>{
  const task=await fixture(),request=body(task);
  actor=child;assert.equal((await call('POST',`/${task.id}/skip`,request)).status,403);actor=admin;
  assert.throws(()=>skipTaskOccurrence(d,task.id,{principal:{kind:'device',id:1},body:request}),{status:403});
  assert.equal((await call('POST',`/${task.id}/skip`,{...request,expected_revision:request.expected_revision+1})).status,409);
  assert.equal(read(task.id).status,'open');assert.equal(rows('SELECT * FROM task_skip_receipts').length,0);
});

test('count-limited completion-relative recurrence remains unsupported without consuming its occurrence',async()=>{
  const task=await fixture({recurrence_rule:'FREQ=DAILY;COUNT=1'});
  const result=await call('POST',`/${task.id}/skip`,body(task));assert.equal(result.status,409);
  assert.equal(read(task.id).status,'open');assert.equal(rows('SELECT * FROM task_skip_receipts').length,0);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
});

test('a normally created dateless routine cannot be skipped without a nominal sequence anchor',async()=>{
  const task=await fixture({start_date:null,start_time:null,due_date:null,due_time:null});
  const detail=await call('GET',`/${task.id}`);assert.equal(detail.data.can_skip_occurrence,false);
  const result=await call('POST',`/${task.id}/skip`,body(task));assert.equal(result.status,409);
  assert.match(result.error||result.message,/scheduled date/i);
  assert.equal(read(task.id).status,'open');assert.equal(rows('SELECT * FROM task_skip_receipts').length,0);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
});

test('clearing concrete dates for one occurrence retains its durable sequence anchor for Skip',async()=>{
  const task=await fixture();
  const changed=await edit(task,{edit_scope:'occurrence',start_date:null,start_time:null,due_date:null,due_time:null});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(read(task.id).due_date,null);
  assert.equal(taskSeriesState(d,task.id).occurrence.planned_due_date,'2026-10-06');
  assert.equal((await call('GET',`/${task.id}`)).data.can_skip_occurrence,true);
  skip(task);assert.equal(successor(task.id).due_date,'2026-10-07');
});

test('a COUNT edit while Skip generation is pending cannot bypass its guard on recovery or replay',async()=>{
  const task=await fixture(),request=body(task);
  d.exec(`CREATE TRIGGER synthetic_count_retry_failure BEFORE INSERT ON tasks WHEN NEW.recurrence_origin_id=${task.id}
    BEGIN SELECT RAISE(ABORT,'Synthetic count retry failure'); END;`);
  assert.equal(skip(task,request).recurrencePending,true);d.exec('DROP TRIGGER synthetic_count_retry_failure');
  const changed=await edit(task,{recurrence_rule:'FREQ=DAILY;COUNT=1'});assert.equal(changed.status,200,JSON.stringify(changed));
  const errors=[];const recovery=reconcileTaskExpirations(d,{onError:error=>errors.push(error)});
  assert.equal(recovery.failed,1);assert.match(errors[0].message,/limited number/i);
  assert.equal(rows('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL',task.id).length,0);
  const replay=await call('POST',`/${task.id}/skip`,request);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.recurrence_pending,true);
  assert.equal(read(task.id).status,'skipped');assert.equal(rows('SELECT * FROM task_skip_receipts').length,1);
  const restored=await edit(task,{recurrence_rule:task.recurrence_rule});assert.equal(restored.status,200,JSON.stringify(restored));
  assert.equal(reconcileTaskExpirations(d,{onError:error=>{throw error;}}).failed,0);
  assert.equal(successor(task.id).due_date,'2026-10-07');assert.equal(skip(task,request).recurrencePending,false);
});

test('a this-and-future cadence edit does not regenerate the skipped concrete Saturday slot',async()=>{
  const task=await fixture({start_date:'2026-10-09',due_date:'2026-10-09',recurrence_rule:'FREQ=WEEKLY;BYDAY=FR'});
  const changed=await edit(task,{start_date:'2026-10-10',due_date:'2026-10-10',recurrence_rule:'FREQ=WEEKLY;BYDAY=SA'});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.equal(read(task.id).due_date,'2026-10-10');
  assert.equal(taskSeriesState(d,task.id).occurrence.planned_due_date,'2026-10-09');
  skip(task);assert.equal(successor(task.id).due_date,'2026-10-17');assert.equal(read(task.id).due_date,'2026-10-10');
});

test('an occurrence-only date and rule override does not move the reusable completion-relative sequence',async()=>{
  const task=await fixture({start_date:'2026-10-09',due_date:'2026-10-09',recurrence_rule:'FREQ=WEEKLY;BYDAY=FR'}),before=definitions();
  const changed=await edit(task,{edit_scope:'occurrence',start_date:'2026-10-10',due_date:'2026-10-10',recurrence_rule:'FREQ=WEEKLY;BYDAY=SA'});
  assert.equal(changed.status,200,JSON.stringify(changed));assert.deepEqual(definitions(),before);
  skip(task);assert.equal(successor(task.id).due_date,'2026-10-16');assert.equal(read(task.id).due_date,'2026-10-10');
});
