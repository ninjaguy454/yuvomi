import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.TZ='UTC';
process.env.SESSION_SECRET='task-expiration-consumers-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {runSearch}=await import('../server/services/search.js');
const {wallDashboard}=await import('../server/services/wall.js');
const {getCountdowns}=await import('../server/services/countdowns.js');
const {isNotificationDeliveryCurrent}=await import('../server/services/notification-events.js');
const {processDueNotifications}=await import('../server/services/notifications.js');
const {enqueueNotification}=await import('../server/services/notification-inbox.js');
const {upsertTask}=await import('../server/services/caldav-reminders-sync.js');
const {callTool}=await import('../server/mcp/tools.js');
const {default:dashboardRouter}=await import('../server/routes/dashboard.js');
const {default:readerRouter}=await import('../server/routes/reader.js');
const {claimTask,overrideTaskAssignment,obligationInbox}=await import('../server/services/assignment-responsibilities.js');
await import('../server/routes/tasks.js');
let d,actor,server,base;

test.beforeEach(async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-15T12:00:00Z')});
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  _setTestDatabase(d);
  actor=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('ExpiryAdmin','Expiry Admin','x','admin')").run().lastInsertRowid);
  const app=express();
  app.use((req,_res,next)=>{req.session={userId:actor,role:'admin'};req.authUserId=actor;next();});
  app.use('/dashboard',dashboardRouter);app.use('/reader',readerRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async()=>{await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
function task(title,status='open',parent=null) {
  const id=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,status,parent_task_id,due_date,due_time,countdown,expiration_policy,expired_at)
    VALUES(?,?,?,?,?,'2026-09-14','08:00',1,'expire_incomplete',?)`).run(title,actor,actor,status,parent,status==='expired'?'2026-09-14T08:00:00Z':null).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,actor);
  return id;
}

test('expired occurrences leave Dashboard, Reader, Wall, countdowns and default MCP while explicit history remains',async()=>{
  const expired=task('Expired unique routine','expired'),open=task('Open unique routine');
  const before=d.prepare('SELECT version FROM task_change_clock').get().version;
  const dashboard=await(await fetch(`${base}/dashboard`)).json();
  const result=dashboard.data||dashboard;
  assert.deepEqual(result.urgentTasks.map(row=>row.id),[open]);
  assert.equal(result.openTaskCount,1);assert.equal(result.overdueTaskCount,1);
  const reader=await(await fetch(`${base}/reader?view=tasks`)).text();
  assert.ok(reader.includes('Open unique routine'));assert.ok(!reader.includes('Expired unique routine'));
  assert.deepEqual(wallDashboard(d,actor,row=>row).urgentTasks.map(row=>row.id),[open]);
  assert.ok(!getCountdowns(d,{userId:actor,todayKey:'2026-09-15'}).items.some(row=>row.source==='task'&&row.id===expired));
  const ctx={db:d,actor:{id:actor,role:'admin'}};
  assert.ok(!(await callTool(ctx,'list_tasks',{})).some(row=>row.id===expired));
  assert.ok((await callTool(ctx,'list_tasks',{status:'expired'})).some(row=>row.id===expired));
  assert.equal(d.prepare('SELECT version FROM task_change_clock').get().version,before,'reads must not reconcile or mutate Tasks');
});

test('global search retains expired status and excludes archived expired history by its existing archive filter',()=>{
  const expired=task('Morning unique routine','expired'),open=task('Morning active routine');
  const archived=task('Morning archived routine','expired');
  d.prepare("UPDATE tasks SET archived_at='2026-09-15T00:00:00Z' WHERE id=?").run(archived);
  const results=runSearch(d,'Morning',actor).tasks;
  assert.equal(results[0].id,open);assert.equal(results.find(row=>row.id===expired)?.status,'expired');
  assert.ok(!results.some(row=>row.id===archived));
});

test('queued notifications and unsent reminders cannot prompt expired work or completed children of expired work',async()=>{
  const expired=task('Expired notification','expired'),child=task('Preserved completed child','done',expired);
  for(const id of [expired,child]) {
    const receipt=enqueueNotification(d,{userId:actor,sourceKey:`reminder:test-${id}`,category:'tasks',entityType:'task',entityId:id,title:'Task reminder',body:'Previously queued'});
    assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
    d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by) VALUES('task',?,'2026-09-14T09:00:00Z',?)").run(id,actor);
  }
  await processDueNotifications({database:d,now:new Date('2026-09-15T12:00:00Z'),pushService:{sendToUser:async()=>{throw new Error('Expired work must not be sent');}}});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE reminder_id IS NOT NULL").get().n,0);
});

test('CalDAV sync preserves expired history even when provider reports successful completion',()=>{
  const id=task('Original expired routine','expired');
  d.prepare("UPDATE tasks SET external_uid='expired-remote',external_source='caldav',external_account_id=42 WHERE id=?").run(id);
  const before=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.equal(upsertTask({uid:'expired-remote',summary:'Remote completed',description:'Remote',completed:true,due:'2026-09-16'},42,actor),id);
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(id),before);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('expired assignment requests are not actionable even before a stale obligation is cleaned up',()=>{
  const id=task('Expired request','expired');
  d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,status,responsible_user_id) VALUES('task',?,?,'expired-request','primary','pending',?)").run(id,id,actor);
  assert.deepEqual(obligationInbox(d,actor),[]);
  assert.throws(()=>claimTask(d,id,actor),/expired/);
  assert.throws(()=>overrideTaskAssignment(d,id,actor,actor),/expired/);
});

test('CalDAV cannot move the deadline and complete a missed occurrence before background expiration',()=>{
  const id=task('Missed unswept routine');
  d.prepare("UPDATE tasks SET external_uid='unswept-remote',external_source='caldav',external_account_id=42 WHERE id=?").run(id);
  const before=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.throws(()=>upsertTask({uid:'unswept-remote',summary:'Remote completed',description:'Remote',completed:true,due:'2026-09-16'},42,actor),error=>error.details?.reason==='task_expired');
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(id),before);
});
