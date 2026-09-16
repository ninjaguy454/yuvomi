import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='task-expiration-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:router,reconcileTaskRecurrence}=await import('../server/routes/tasks.js');
const {changeTaskStatus,expireTask,reopenExpiredTask}=await import('../server/services/task-lifecycle.js');
const {reconcileTaskExpirations}=await import('../server/services/task-expiration.js');
const {taskDeadlineMs}=await import('../server/services/task-window.js');
const {awardForCompletion}=await import('../server/services/rewards.js');
let d,admin,child,actor,server,base;
function migrations(database,until=Infinity) {
  for(const m of ALL_MIGRATIONS.filter(row=>row.version<=until)) {
    if(m.foreignKeysOff)database.pragma('foreign_keys=OFF');
    database.transaction(()=>{typeof m.up==='function'?m.up(database):database.exec(m.up);m.afterUp?.(database);})();
    if(m.foreignKeysOff)database.pragma('foreign_keys=ON');
  }
}
test.before(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');migrations(d);_setTestDatabase(d);
  const user=d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)");
  admin=Number(user.run('parent','Parent','admin','parent').lastInsertRowid);
  child=Number(user.run('child','Child','member','child').lastInsertRowid);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(child);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  for(const key of ['tasks.edit_own','tasks.edit_others','tasks.change_dates'])d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,'none')").run(String(child),key);
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  d.prepare('INSERT INTO sessions(sid,sess,expired_at) VALUES(?,?,?)').run('expiration-live-session',JSON.stringify({userId:admin}),Date.now()+600_000);
  actor=admin;
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=actor;req.authRole=actor===admin?'admin':'member';req.authMethod='session';req.sessionID='expiration-live-session';req.session={userId:actor};next();});
  app.use('/tasks',router);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/tasks`;
});
test.after(()=>{server.closeAllConnections();server.close();_setTestDatabase(null);d.close();});
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const count=(sql,...args)=>d.prepare(sql).get(...args).n;
const next=id=>d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(id);
async function call(method,path='',body){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,...(r.status===204?{}:await r.json())};}
async function fixture(extra={}) {
  actor=admin;
  const r=await call('POST','',{title:'Get Ready for the Day',assigned_to:[child],points:2,
    is_recurring:true,recurrence_rule:'FREQ=DAILY',start_date:'2026-09-14',start_time:'07:00',due_date:'2026-09-14',due_time:'08:00',
    expiration_policy:'expire_incomplete',subtasks:[{title:'Brush teeth'},{title:'Get dressed'}],...extra});
  assert.equal(r.status,201,JSON.stringify(r));return r.data;
}
const at=value=>new Date(value);
function complete(id,now,extra={}){return changeTaskStatus(d,id,'done',{actorId:child,requireRevision:false,now:at(now),body:extra});}

test('Monday expires at 8, preserves partial progress, awards zero and creates fresh anchored Tuesday',async()=>{
  const task=await fixture();
  complete(task.subtasks[0].id,'2026-09-14T11:30:00Z');
  assert.equal(read(task.id).status,'in_progress');
  const before=count('SELECT COUNT(*) n FROM reward_ledger');
  assert.equal(expireTask(d,task.id,{now:at('2026-09-14T11:59:59Z')}).expired,false);
  const clock=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  assert.equal(expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')}).expired,true);
  assert.equal(read(task.id).status,'expired');assert.equal(read(task.id).archived_at,null);
  assert.equal(read(task.subtasks[0].id).status,'done');assert.equal(read(task.subtasks[1].id).status,'expired');
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'),before);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?',task.id),0);
  assert.equal(awardForCompletion(d,task.id,child),false);
  const tuesday=next(task.id)[0];assert.equal(next(task.id).length,1);
  assert.equal(tuesday.start_date,'2026-09-15');assert.equal(tuesday.start_time,'07:00');
  assert.equal(tuesday.due_date,'2026-09-15');assert.equal(tuesday.due_time,'08:00');assert.equal(tuesday.points,2);
  assert.equal(tuesday.expiration_policy,'expire_incomplete');
  assert.ok(d.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(tuesday.id).every(row=>row.status==='open'));
  assert.ok(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version>clock,'live stream revision advances');
  for(let i=0;i<3;i++){expireTask(d,task.id,{now:at('2026-09-14T12:01:00Z')});reconcileTaskRecurrence(task.id);}
  assert.equal(next(task.id).length,1);assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='expired'",task.id),1);
  const active=await call('GET','?include_future=1');assert.ok(!active.data.some(row=>row.id===task.id));
  const history=await call('GET','/completions');const event=history.data.find(row=>row.task_id===task.id);
  assert.equal(event.event_type,'expired');assert.equal(event.points,0);assert.equal(event.completed_at,null);
  const series=await call('GET',`/${tuesday.id}/completions`);assert.ok(series.data.some(row=>row.task_id===task.id&&row.event_type==='expired'));
});

test('completion one second before deadline earns once and expiration loses the race',async()=>{
  const task=await fixture();complete(task.id,'2026-09-14T11:59:59Z',{complete_remaining:true});
  assert.equal(read(task.id).status,'done');assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",task.id),1);
  assert.equal(d.prepare("SELECT delta FROM reward_ledger WHERE task_id=? AND type='earn'").get(task.id).delta,2);
  assert.equal(expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')}).expired,false);
  assert.equal(next(task.id).length,1);
});

test('at deadline completion loses even before a background sweep, then stale writes cannot revive expiration',async()=>{
  const task=await fixture();
  assert.throws(()=>complete(task.id,'2026-09-14T12:00:00Z',{complete_remaining:true}),error=>error.details?.reason==='task_expired');
  expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')});
  assert.throws(()=>complete(task.subtasks[1].id,'2026-09-14T12:00:00Z'),/expired/);
  actor=admin;const stale=await call('PATCH',`/${task.id}/status`,{status:'done',expected_revision:task.revision,complete_remaining:true});
  assert.equal(stale.status,409);assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?",task.id),0);
  await Promise.all(Array.from({length:5},()=>Promise.resolve().then(()=>reconcileTaskRecurrence(task.id))));
  assert.equal(next(task.id).length,1);
});

test('restart reconciliation catches up missed days with no overdue pileup and is idempotent',async()=>{
  const task=await fixture({due_date:'2026-08-31',start_date:'2026-08-31'});
  // No page loads: the startup worker alone processes all missed windows.
  const now=at('2026-09-03T12:00:00Z');
  const result=reconcileTaskExpirations(d,{now,onError:error=>{throw error;}});assert.equal(result.failed,0);
  const series=d.prepare(`SELECT t.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id WHERE o.series_id=? ORDER BY generation`).all(task.id);
  assert.deepEqual(series.map(row=>[row.due_date,row.status]),[['2026-08-31','expired'],['2026-09-01','expired'],['2026-09-02','expired'],['2026-09-03','expired'],['2026-09-04','open']]);
  const version=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  assert.equal(reconcileTaskExpirations(d,{now}).expired,0);assert.equal(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,version);
});

test('completion-relative expiration pauses without a synthetic completion clock',async()=>{
  const task=await fixture({recurrence_from_completion:true});expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')});
  assert.equal(next(task.id).length,0);reconcileTaskRecurrence(task.id);assert.equal(next(task.id).length,0);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?',task.id),0);
});

test('authorized explicit reopen retains progress and existing successor; child and ordinary status routes cannot reopen',async()=>{
  const task=await fixture();complete(task.subtasks[0].id,'2026-09-14T11:30:00Z');expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')});
  const successor=next(task.id)[0];actor=child;
  assert.equal((await call('POST',`/${task.id}/reopen`,{expected_revision:read(task.id).revision,expiration_policy:'keep_overdue'})).status,403);
  actor=admin;assert.equal((await call('PATCH',`/${task.id}/status`,{expected_revision:read(task.id).revision,status:'in_progress'})).status,409);
  const response=await call('POST',`/${task.id}/reopen`,{expected_revision:read(task.id).revision,expiration_policy:'keep_overdue'});
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(read(task.subtasks[0].id).status,'done');assert.equal(read(task.subtasks[1].id).status,'open');
  assert.equal(read(task.id).status,'in_progress');assert.equal(read(task.id).expired_at,null);assert.equal(next(task.id)[0].id,successor.id);
  complete(task.id,'2026-09-14T12:15:00Z',{complete_remaining:true});assert.equal(next(task.id).length,1);
  assert.equal(count("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'",task.id),1);
});

test('archive is independent of expiration and history remains accessible',async()=>{
  const task=await fixture();expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')});
  actor=admin;const r=await call('PATCH',`/${task.id}/status`,{status:'archived',expected_revision:read(task.id).revision});assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(read(task.id).status,'expired');assert.ok(read(task.id).archived_at);
  assert.equal((await call('POST',`/${task.id}/reopen`,{expected_revision:read(task.id).revision,expiration_policy:'keep_overdue'})).status,409);
  assert.ok((await call('GET','?status=archived&include_future=1')).data.some(row=>row.id===task.id));
});

test('DST local deadline uses the correct offset, gap/fold policy and full date-only due day',()=>{
  for(const [due_date,due_time,expected] of [
    ['2026-03-08','08:00','2026-03-08T12:00:00Z'],['2026-11-01','08:00','2026-11-01T13:00:00Z'],
    ['2026-03-08','02:30','2026-03-08T07:30:00Z'],['2026-11-01','01:30','2026-11-01T05:30:00Z'],
    ['2026-03-08',null,'2026-03-09T04:00:00Z'],
  ])assert.equal(taskDeadlineMs(d,{due_date,due_time}),Date.parse(expected));
});

test('policy defaults, due validation and start time guard preserve existing overdue behavior',async()=>{
  const task=await fixture({expiration_policy:'keep_overdue'});assert.equal(expireTask(d,task.id,{now:at('2026-10-01T12:00:00Z')}).expired,false);
  assert.throws(()=>complete(task.id,'2026-09-14T10:59:59Z',{complete_remaining:true}),error=>error.details?.reason==='occurrence_not_started');
  assert.equal((await call('POST','',{title:'No deadline',expiration_policy:'expire_incomplete'})).status,400);
  const plain=await call('POST','',{title:'Existing default'});assert.equal(plain.data.expiration_policy,'keep_overdue');
  const version=d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  await call('GET',`/${task.id}`);await call('GET','?include_future=1');await call('GET','/completions');
  assert.equal(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version,version,'reads remain side-effect free');
});

test('upgrade preserves linked rows, trigger/index definitions and deleted-ID high-water mark',()=>{
  const prior=new Database(':memory:');prior.pragma('foreign_keys=ON');migrations(prior,10034);
  const owner=Number(prior.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('u','U','x','admin')").run().lastInsertRowid);
  prior.prepare("INSERT INTO tasks(id,title,created_by) VALUES(500,'Retained',?)").run(owner);
  prior.prepare("INSERT INTO tasks(id,title,created_by,parent_task_id) VALUES(501,'Child',?,500)").run(owner);
  prior.prepare("INSERT INTO tasks(id,title,created_by) VALUES(999,'Deleted',?)").run(owner);prior.prepare('DELETE FROM tasks WHERE id=999').run();
  prior.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(500,?)').run(owner);
  const triggers=prior.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  const before=prior.prepare('SELECT * FROM tasks ORDER BY id').all();const events=prior.prepare('SELECT * FROM task_activity_events').all();
  const m=ALL_MIGRATIONS.find(row=>row.version===10035);prior.pragma('foreign_keys=OFF');prior.transaction(()=>m.up(prior))();prior.pragma('foreign_keys=ON');
  for(const row of before)for(const [key,value] of Object.entries(row))assert.equal(prior.prepare('SELECT * FROM tasks WHERE id=?').get(row.id)[key],value,key);
  assert.deepEqual(prior.prepare('SELECT * FROM task_activity_events').all(),events);
  for(const t of triggers)assert.equal(prior.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(t.name).sql,t.sql);
  assert.equal(prior.prepare('SELECT COUNT(*) n FROM task_assignments').get().n,1);assert.deepEqual(prior.pragma('foreign_key_check'),[]);
  assert.ok(prior.prepare("INSERT INTO tasks(title,created_by) VALUES('New',?)").run(owner).lastInsertRowid>999);prior.close();
});


test('two already-open authenticated SSE clients receive expiration invalidation and fresh canonical reads',async()=>{
  const task=await fixture();
  const open=async()=>{
    const abort=new AbortController();
    const response=await fetch(base+'/changes',{signal:abort.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
    const reader=response.body.getReader();
    const initial=new TextDecoder().decode((await reader.read()).value);
    return {abort,reader,version:JSON.parse(initial.match(/data: (.*)/)[1]).version};
  };
  const clients=await Promise.all([open(),open()]);
  const timeout=setTimeout(()=>clients.forEach(client=>client.abort.abort()),4000);
  try {
    expireTask(d,task.id,{now:at('2026-09-14T12:00:00Z')});
    for(const client of clients) {
      const message=new TextDecoder().decode((await client.reader.read()).value);
      assert.match(message,/event: change/);
      assert.ok(JSON.parse(message.match(/data: (.*)/)[1]).version>client.version);
      assert.doesNotMatch(message,/Get Ready|title|assigned_to/,'stream only invalidates, with no private Task payload');
    }
    const refreshed=await call('GET',`/${task.id}`);assert.equal(refreshed.data.status,'expired');
    const active=await call('GET','?status=open&status=in_progress&include_future=1');
    assert.ok(!active.data.some(row=>row.id===task.id));
    assert.equal(active.data.find(row=>row.recurrence_origin_id===task.id).points,2);
  } finally {clearTimeout(timeout);clients.forEach(client=>client.abort.abort());}
});
