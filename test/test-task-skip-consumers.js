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
const {claimTask,overrideTaskAssignment,obligationInbox,respondToTaskObligation}=await import('../server/services/assignment-responsibilities.js');
const {createDevice}=await import('../server/services/devices.js');
const {deviceTaskList,deviceTaskDetail}=await import('../server/services/device-tasks.js');
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
  const id=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,status,parent_task_id,due_date,due_time,countdown,expiration_policy,skipped_at)
    VALUES(?,?,?,?,?,'2026-09-14','08:00',1,'expire_incomplete',?)`).run(title,actor,actor,status,parent,status==='skipped'?'2026-09-14T08:00:00Z':null).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,actor);
  return id;
}

test('skipped occurrences leave Dashboard, Reader, Wall, countdowns and default MCP while explicit history remains',async()=>{
  const skipped=task('Skipped unique routine','skipped'),open=task('Open unique routine');
  const before=d.prepare('SELECT version FROM task_change_clock').get().version;
  const dashboard=await(await fetch(`${base}/dashboard`)).json();
  const result=dashboard.data||dashboard;
  assert.deepEqual(result.urgentTasks.map(row=>row.id),[open]);
  assert.equal(result.openTaskCount,1);assert.equal(result.overdueTaskCount,1);
  const reader=await(await fetch(`${base}/reader?view=tasks`)).text();
  assert.ok(reader.includes('Open unique routine'));assert.ok(!reader.includes('Skipped unique routine'));
  assert.deepEqual(wallDashboard(d,actor,row=>row).urgentTasks.map(row=>row.id),[open]);
  assert.ok(!getCountdowns(d,{userId:actor,todayKey:'2026-09-15'}).items.some(row=>row.source==='task'&&row.id===skipped));
  const ctx={db:d,actor:{id:actor,role:'admin'}};
  assert.ok(!(await callTool(ctx,'list_tasks',{})).some(row=>row.id===skipped));
  assert.ok((await callTool(ctx,'list_tasks',{status:'skipped'})).some(row=>row.id===skipped));
  assert.equal(d.prepare('SELECT version FROM task_change_clock').get().version,before,'reads must not reconcile or mutate Tasks');
});

test('global search retains skipped status and excludes archived skipped history by its existing archive filter',()=>{
  const skipped=task('Morning unique routine','skipped'),open=task('Morning active routine');
  const archived=task('Morning archived routine','skipped');
  d.prepare("UPDATE tasks SET archived_at='2026-09-15T00:00:00Z' WHERE id=?").run(archived);
  const results=runSearch(d,'Morning',actor).tasks;
  assert.equal(results[0].id,open);assert.equal(results.find(row=>row.id===skipped)?.status,'skipped');
  assert.ok(!results.some(row=>row.id===archived));
});

test('queued notifications and unsent reminders cannot prompt skipped work or completed children of skipped work',async()=>{
  const skipped=task('Skipped notification','skipped'),child=task('Preserved completed child','done',skipped);
  for(const id of [skipped,child]) {
    const receipt=enqueueNotification(d,{userId:actor,sourceKey:`reminder:test-${id}`,category:'tasks',entityType:'task',entityId:id,title:'Task reminder',body:'Previously queued'});
    assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
    d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by) VALUES('task',?,'2026-09-14T09:00:00Z',?)").run(id,actor);
  }
  await processDueNotifications({database:d,now:new Date('2026-09-15T12:00:00Z'),pushService:{sendToUser:async()=>{throw new Error('Skipped work must not be sent');}}});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE reminder_id IS NOT NULL").get().n,0);
});

test('CalDAV sync preserves skipped history even when provider reports successful completion',()=>{
  const id=task('Original skipped routine','skipped');
  d.prepare("UPDATE tasks SET external_uid='skipped-remote',external_source='caldav',external_account_id=42 WHERE id=?").run(id);
  const before=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.equal(upsertTask({uid:'skipped-remote',summary:'Remote completed',description:'Remote',completed:true,due:'2026-09-16'},42,actor),id);
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(id),before);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);
});

test('skipped assignment requests are not actionable even before a stale obligation is cleaned up',()=>{
  const id=task('Skipped request','skipped');
  d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,status,responsible_user_id) VALUES('task',?,?,'skipped-request','primary','pending',?)").run(id,id,actor);
  assert.deepEqual(obligationInbox(d,actor),[]);
  assert.throws(()=>claimTask(d,id,actor),/skipped|active/);
  assert.throws(()=>overrideTaskAssignment(d,id,actor,actor),/skipped|active/);
});

// Catches the ordinary device query branch and separately projected action permissions.
test('ordinary device queries hide skipped work and explicit history has no progress controls',()=>{
  const id=task('Skipped device routine','skipped'),p={kind:'device',...createDevice(d,{name:'Synthetic wall'},actor)};
  assert.ok(!deviceTaskList(d,p,{query:{}}).some(row=>row.id===id));
  const detail=deviceTaskDetail(d,p,id);assert.equal(detail.status,'skipped');
  for(const permission of ['complete','reopen','reset','claim'])assert.equal(detail.permissions[permission],false,permission);
  assert.ok(deviceTaskList(d,p,{query:{status:'skipped'}}).some(row=>row.id===id));
});

// Catches retained/restored helper work escaping through a nonstructural source link.
test('restored helpers under skipped source stay out of active counts, device, wall, reader and notifications',async()=>{
  const source=task('Skipped source','skipped'),helper=task('Restored helper active title');
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(source,helper);
  const p={kind:'device',...createDevice(d,{name:'Synthetic wall'},actor)};
  assert.ok(!deviceTaskList(d,p).some(row=>row.id===helper));
  const dashboard=await(await fetch(`${base}/dashboard`)).json(),result=dashboard.data||dashboard;
  assert.equal(result.openTaskCount,0);assert.equal(result.overdueTaskCount,0);assert.ok(!result.urgentTasks.some(row=>row.id===helper));
  assert.ok(!wallDashboard(d,actor,row=>row).urgentTasks.some(row=>row.id===helper));
  assert.ok(!(await(await fetch(`${base}/reader?view=tasks`)).text()).includes('Restored helper active title'));
  const receipt=enqueueNotification(d,{userId:actor,sourceKey:'reminder:restored-helper',category:'tasks',entityType:'task',entityId:helper,title:'Synthetic reminder',body:'Previously queued'});
  assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
  d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by) VALUES('task',?,'2026-09-14T09:00:00Z',?)").run(helper,actor);
  await processDueNotifications({database:d,now:new Date('2026-09-15T12:00:00Z'),pushService:{sendToUser:async()=>{throw new Error('Skipped helper must not send');}}});
  assert.equal(d.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE reminder_id IS NOT NULL').get().n,0);
});

test('nonstructural skipped source suppresses both queued and unsent helper reminders',async()=>{
  const source=task('Skipped source','skipped'),helper=task('Preserved helper');
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(source,helper);
  const receipt=enqueueNotification(d,{userId:actor,sourceKey:'reminder:preserved-helper',category:'tasks',entityType:'task',entityId:helper,title:'Synthetic reminder',body:'Queued'});
  assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
  d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by) VALUES('task',?,'2026-09-14T09:00:00Z',?)").run(helper,actor);
  await processDueNotifications({database:d,now:new Date('2026-09-15T12:00:00Z'),pushService:{sendToUser:async()=>{throw new Error('Skipped helper must not send');}}});
  assert.equal(d.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE reminder_id IS NOT NULL').get().n,0);
  const nested=task('Child under linked helper','open',helper);
  const nestedReceipt=enqueueNotification(d,{userId:actor,sourceKey:'reminder:nested-helper',category:'tasks',entityType:'task',entityId:nested,title:'Synthetic reminder',body:'Queued'});
  assert.equal(isNotificationDeliveryCurrent(d,nestedReceipt),false);
  d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,status,responsible_user_id) VALUES('task',?,?,'nested-skipped','primary','pending',?)").run(nested,nested,actor);
  assert.deepEqual(obligationInbox(d,actor),[]);
  assert.throws(()=>overrideTaskAssignment(d,nested,actor,actor),/skipped|active/);
  const obligation=d.prepare("SELECT id FROM planning_obligations WHERE logical_key='nested-skipped'").get();
  for(const response of ['accept','decline','timeout'])assert.throws(()=>respondToTaskObligation(d,obligation.id,response,actor),/active/);
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'pending');
  assert.ok(!getCountdowns(d,{userId:actor,todayKey:'2026-09-15'}).items.some(row=>row.source==='task'&&row.id===nested));
});
