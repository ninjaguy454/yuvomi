import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import {modernTaskFetch} from './helpers/task-client-revision-fixture.js';
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
process.env.SESSION_SECRET='synthetic-trip-test-session-secret';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveTrip,getTrip,deleteTrip}=await import('../server/services/trips.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:planningRouter}=await import('../server/routes/planning.js');
const {default:dashboardRouter}=await import('../server/routes/dashboard.js');
const {canReceiveNotification}=await import('../server/services/notification-inbox.js');
const {taskCapabilities}=await import('../server/services/task-access.js');
let d,admin,child;
test.beforeEach(()=>{
 d=new Database(':memory:');d.pragma('foreign_keys=ON');
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 _setTestDatabase(d);
 admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('parent','Parent','x','admin','parent')").run().lastInsertRowid);
 child=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('child','Child','x','member','child')").run().lastInsertRowid);
 d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
});
test.afterEach(()=>{_setTestDatabase(null);d.close()});
const input=(extra={})=>({name:'Beach week',participant_ids:[admin,child],starts_at:'2031-07-10T09:00',ends_at:'2031-07-14T18:00',request_key:'new-trip-request',...extra});
const step=(extra={})=>({step_key:'pack-clothing',phase:'before_departure',title:'Pack clothing',assigned_user_ids:[child],...extra});
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);

test('new Trip creates an ordinary zero-point parent and independently assigned dated children',()=>{
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'unpack',title:'Unpack',phase:'post_trip',assigned_user_ids:[admin]})]}),admin);
 assert.ok(trip.parent_task,'one ordinary Trip Task must exist');
 assert.equal(trip.parent_task.parent_task_id,null);assert.equal(trip.parent_task.points,0);assert.equal(trip.parent_task.start_date,null);
 assert.equal(trip.tasks.length,2);assert.ok(trip.tasks.every(t=>t.parent_task_id===trip.parent_task.id&&!t.is_recurring));
 assert.equal(trip.tasks.find(t=>t.step_key==='pack-clothing').assigned_to,child);
 assert.equal(trip.tasks.find(t=>t.step_key==='pack-clothing').due_date,'2031-07-09');
 assert.equal(trip.tasks.find(t=>t.step_key==='unpack').due_date,'2031-07-15');
 assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(trip.parent_task.id).map(r=>r.user_id),[admin,child]);
 assert.notEqual(trip.travel_meal_plan_task.id,trip.parent_task.id);assert.equal(trip.travel_meal_plan_task.parent_task_id,null);
 assert.equal(d.pragma('foreign_key_check').length,0);
});

test('same create request and repeated checklist saves preserve Trip and child IDs',()=>{
 const body=input({tasks:[step()]});const first=saveTrip(d,body,admin),again=saveTrip(d,body,admin);
 assert.equal(again.id,first.id);assert.equal(again.parent_task.id,first.parent_task.id);
 const edited=saveTrip(d,{name:'Beach week updated',tasks:[step()],expected_revision:first.task_group_revision},admin,first.id);
 assert.deepEqual(edited.tasks.map(t=>t.id),first.tasks.map(t=>t.id));
 assert.throws(()=>saveTrip(d,input({name:'Different request payload'}),admin),/already used|different/i);
});

test('trip date changes move managed incomplete steps and preserve completed history',()=>{
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'unpack',title:'Unpack',phase:'post_trip'})]}),admin);
 const pack=trip.tasks.find(t=>t.step_key==='pack-clothing');changeTaskStatus(d,pack.id,'done',{actorId:admin,authorize:false,requireRevision:false});
 const updated=saveTrip(d,{starts_at:'2031-07-12T09:00',ends_at:'2031-07-16T18:00'},admin,trip.id);
 assert.equal(row(pack.id).status,'done');assert.equal(row(pack.id).due_date,'2031-07-09');
 assert.equal(updated.tasks.find(t=>t.step_key==='unpack').due_date,'2031-07-17');
 assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(pack.id).n,1);
});

async function withApi(run,actor=admin){
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=actor;req.authRole=d.prepare('SELECT role FROM users WHERE id=?').get(actor).role;req.session={userId:actor,role:req.authRole};next()});
 app.use('/api/v1/tasks',tasksRouter);app.use('/api/v1/planning',planningRouter);app.use('/api/v1/dashboard',dashboardRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(method,path,body)=>{const response=await modernTaskFetch(d,`http://127.0.0.1:${server.address().port}/api/v1${path}`,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()}};
 try{await run(call)}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
}

test('direct child date and location edits survive Trip changes; parent exposes next incomplete deadline',async()=>{
 const place=Number(d.prepare("INSERT INTO places(name,type) VALUES('Hotel','hotel')").run().lastInsertRowid);
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'unpack',title:'Unpack',phase:'post_trip'})]}),admin);
 await withApi(async call=>{
  const result=await call('PUT',`/tasks/${trip.tasks[0].id}`,{due_date:'2031-07-02',location:{kind:'saved_place',place_id:place}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  saveTrip(d,{starts_at:'2031-07-12T09:00'},admin,trip.id);
  assert.equal(row(trip.tasks[0].id).due_date,'2031-07-02');
  const response=await call('GET',`/tasks/${trip.parent_task.id}`);
  assert.equal(response.body.data.next_trip_step.id,trip.tasks[0].id);
  assert.equal(response.body.data.display_due_date,'2031-07-02');
  assert.equal(response.body.data.subtasks.find(s=>s.id===trip.tasks[0].id).location.place_id,place);
 });
});

test('cancelled trip reminders cannot enqueue or dispatch and delivered receipts are preserved',()=>{
 const trip=saveTrip(d,input({tasks:[step({reminder_offset_minutes:60})]}),admin);
 const reminder=d.prepare("SELECT * FROM reminders WHERE entity_type='task' AND entity_id=?").get(trip.tasks[0].id);
 assert.equal(reminder.created_by,child);
 const at=reminder.remind_at;saveTrip(d,{starts_at:'2031-07-12T09:00'},admin,trip.id);
 assert.notEqual(d.prepare('SELECT remind_at FROM reminders WHERE id=?').get(reminder.id).remind_at,at);
 d.prepare("UPDATE reminders SET pushed_at='2031-07-01T00:00:00Z' WHERE id=?").run(reminder.id);
 const delivered=d.prepare('SELECT * FROM reminders WHERE id=?').get(reminder.id);
 saveTrip(d,{status:'cancelled'},admin,trip.id);
 assert.deepEqual(d.prepare('SELECT * FROM reminders WHERE id=?').get(reminder.id),delivered);
 assert.equal(canReceiveNotification(d,{user_id:child,entity_type:'task',entity_id:trip.tasks[0].id}),false);
});

test('direct Task deletion leaves a durable tombstone and does not regenerate a child',()=>{
 const trip=saveTrip(d,input({tasks:[step()]}),admin);const id=trip.tasks[0].id;
 d.prepare('DELETE FROM tasks WHERE id=?').run(id);
 saveTrip(d,{tasks:[step()],starts_at:'2031-07-12T09:00'},admin,trip.id);
 assert.equal(getTrip(d,trip.id).tasks.length,0);
 assert.equal(d.prepare('SELECT state,task_id FROM trip_task_steps WHERE trip_id=?').get(trip.id).state,'deleted');
 assert.equal(d.pragma('foreign_key_check').length,0);
});

test('no-op reconciliation preserves revisions and stale parent edits roll back Trip changes',()=>{
 const trip=saveTrip(d,input({tasks:[step()]}),admin);
 const before=row(trip.parent_task.id),version=trip.task_group_revision;
 saveTrip(d,{tasks:[step()]},admin,trip.id);
 assert.equal(getTrip(d,trip.id).task_group_revision,version);assert.equal(row(before.id).revision,before.revision);
 changeTaskStatus(d,trip.tasks[0].id,'done',{actorId:admin,authorize:false,requireRevision:false});
 assert.throws(()=>saveTrip(d,{name:'Stale edit',expected_parent_revision:before.revision},admin,trip.id),/changed|stale/i);
 assert.equal(getTrip(d,trip.id).name,'Beach week');
});

test('phase offsets use household wall days across DST and midnight',()=>{
 const trip=saveTrip(d,input({starts_at:'2031-03-09T00:30',ends_at:'2031-03-10T23:30',tasks:[step(),step({step_key:'back',phase:'post_trip',title:'Unpack'})]}),admin);
 assert.equal(trip.tasks.find(t=>t.step_key==='pack-clothing').due_date,'2031-03-08');
 assert.equal(trip.tasks.find(t=>t.step_key==='back').due_date,'2031-03-11');
});

test('explicit fixed deadlines and personal edits survive regeneration',()=>{
 const trip=saveTrip(d,input({tasks:[step({due_mode:'fixed',due_date:'2031-07-01',due_time:'11:00'})]}),admin);
 const updated=saveTrip(d,{starts_at:'2031-07-12T09:00'},admin,trip.id);
 assert.equal(updated.tasks[0].due_date,'2031-07-01');assert.equal(updated.tasks[0].due_time,'11:00');
});

test('cancellation preserves completed steps and prevents remaining work completion',()=>{
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'unpack',title:'Unpack',phase:'post_trip'})]}),admin);
 changeTaskStatus(d,trip.tasks[0].id,'done',{actorId:admin,authorize:false,requireRevision:false});
 saveTrip(d,{status:'cancelled'},admin,trip.id);
 assert.equal(row(trip.tasks[0].id).status,'done');assert.ok(row(trip.tasks[1].id).archived_at);
 assert.throws(()=>changeTaskStatus(d,trip.tasks[1].id,'done',{actorId:admin,authorize:false,requireRevision:false}),/cancelled|retired/i);
});

test('old Trip edits and cancellation leave linked legacy Tasks unchanged',()=>{
 const id=Number(d.prepare("INSERT INTO trip_plans(name,starts_at,ends_at,created_by) VALUES('Legacy','2031-07-10T09:00','2031-07-14T18:00',?)").run(admin).lastInsertRowid);
 d.prepare('INSERT INTO trip_participants(trip_id,user_id) VALUES(?,?)').run(id,admin);
 const task=Number(d.prepare("INSERT INTO tasks(title,created_by,due_date,assigned_to,points) VALUES('Old packing',?,'2031-07-09',?,7)").run(admin,admin).lastInsertRowid);
 d.prepare("INSERT INTO trip_tasks(trip_id,task_id,phase) VALUES(?,?,'before_departure')").run(id,task);
 const before=row(task);const trip=saveTrip(d,{starts_at:'2031-07-12T09:00',status:'cancelled'},admin,id);
 assert.equal(trip.parent_task,null);assert.deepEqual(row(task),before);assert.equal(getTrip(d,id).tasks.length,1);
 deleteTrip(d,id);assert.deepEqual(row(task),before);
});

test('private child deadlines and names stay out of parent and Trip projections',async()=>{
 const trip=saveTrip(d,input({tasks:[step({step_key:'private',title:'Private surprise',due_mode:'fixed',due_date:'2035-09-21'}),step({step_key:'visible',title:'Visible packing'})]}),admin);
 const hidden=trip.tasks.find(t=>t.step_key==='private');d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden.id);
 await withApi(async call=>{
  const parent=(await call('GET',`/tasks/${trip.parent_task.id}`)).body.data;
  assert.equal(parent.next_trip_step.title,'Visible packing');assert.equal(parent.display_due_date,'2031-07-09');
  assert.ok(!JSON.stringify(parent).includes('Private surprise'));
  assert.ok(!JSON.stringify(parent).includes('2035-09-21'));
  const list=(await call('GET','/planning/trips')).body.data;
  assert.ok(!JSON.stringify(list).includes('Private surprise'));
  assert.ok(!JSON.stringify(list).includes('2035-09-21'));
 },child);
});

test('Dashboard sorts next unfinished child deadlines before its five-row limit',async()=>{
 const trip=saveTrip(d,input({tasks:[step({due_mode:'fixed',due_date:'2024-01-01'}),step({step_key:'later',title:'Later',phase:'post_trip'})]}),admin);
 for(let i=0;i<6;i++)d.prepare("INSERT INTO tasks(title,created_by,due_date) VALUES(?,?,'2028-01-01')").run(`Other ${i}`,admin);
 await withApi(async call=>{
  const result=await call('GET','/dashboard');assert.equal(result.status,200);
  assert.equal(result.body.urgentTasks[0].id,trip.parent_task.id);
  assert.equal(result.body.urgentTasks[0].display_due_date,'2024-01-01');
  assert.ok(result.body.memberTodayTasks.some(member=>member.user_id===child&&member.open_count>=1));
 });
});

test('Trip roots cannot acquire recurrence and cancelling can explicitly restore unfinished work',async()=>{
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'later',title:'Later',phase:'post_trip'})]}),admin);
 await withApi(async call=>{const result=await call('PUT',`/tasks/${trip.parent_task.id}`,{is_recurring:1,recurrence_rule:'FREQ=DAILY'});assert.equal(result.status,400);});
 changeTaskStatus(d,trip.tasks[0].id,'done',{actorId:admin,authorize:false,requireRevision:false});
 saveTrip(d,{status:'cancelled'},admin,trip.id);
 assert.throws(()=>saveTrip(d,{status:'active'},admin,trip.id),/explicitly restore/i);
 assert.equal(getTrip(d,trip.id).status,'cancelled');
 const restored=saveTrip(d,{status:'active',restore_remaining:true},admin,trip.id);
 assert.equal(restored.tasks.find(t=>t.id===trip.tasks[0].id).status,'done');
 assert.equal(row(trip.tasks[1].id).archived_at,null);
 changeTaskStatus(d,trip.tasks[1].id,'done',{actorId:admin,authorize:false,requireRevision:false});
 assert.equal(row(trip.parent_task.id).status,'done');
});

test('deleting a grouped Trip retains Task history and blocks later reminder dispatch',()=>{
 const trip=saveTrip(d,input({tasks:[step({reminder_offset_minutes:60})]}),admin);
 const id=trip.tasks[0].id;deleteTrip(d,trip.id);
 assert.ok(row(id).archived_at);assert.equal(row(id).status,'open');
 assert.equal(canReceiveNotification(d,{user_id:child,entity_type:'task',entity_id:id}),false);
 assert.throws(()=>changeTaskStatus(d,id,'done',{actorId:admin,authorize:false,requireRevision:false}),/retired/i);
 assert.equal(d.pragma('foreign_key_check').length,0);
});

test('a personal reminder edit stays fixed while automatic reminders follow direct Task edits',async()=>{
 const trip=saveTrip(d,input({tasks:[step({reminder_offset_minutes:60})]}),admin);
 const reminder=d.prepare('SELECT * FROM reminders WHERE entity_id=?').get(trip.tasks[0].id);
 await withApi(async call=>{assert.equal((await call('PUT',`/tasks/${trip.tasks[0].id}`,{due_date:'2031-07-04'})).status,200);});
 assert.equal(d.prepare('SELECT remind_at FROM reminders WHERE id=?').get(reminder.id).remind_at.slice(0,10),'2031-07-05');
 d.prepare("UPDATE reminders SET remind_at='2031-07-03T10:00:00' WHERE id=?").run(reminder.id);
 saveTrip(d,{tasks:[step({reminder_offset_minutes:60,due_mode:'fixed',due_date:'2031-07-06'})]},admin,trip.id);
 assert.equal(d.prepare('SELECT remind_at FROM reminders WHERE id=?').get(reminder.id).remind_at,'2031-07-03T10:00:00');
});

test('an edit form cannot remove an omitted private step and external grouped edits require both revisions',async()=>{
 const trip=saveTrip(d,input({tasks:[step(),step({step_key:'visible',title:'Visible step'})]}),admin);
 const hidden=trip.tasks.find(t=>t.step_key==='pack-clothing');d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden.id);
 const other=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('admin2','Other Parent','x','admin','parent')").run().lastInsertRowid);
 await withApi(async call=>{
  assert.equal((await call('PUT',`/planning/admin/trips/${trip.id}`,{name:'No revisions'})).status,428);
  const current=getTrip(d,trip.id);
  const result=await call('PUT',`/planning/admin/trips/${trip.id}`,{starts_at:'2031-07-12T09:00',tasks:[step({step_key:'visible',title:'Visible step'})],expected_revision:current.task_group_revision,expected_parent_revision:current.parent_task.revision});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(row(hidden.id).archived_at,null);assert.equal(row(hidden.id).due_date,'2031-07-11');
  assert.equal(d.prepare('SELECT state FROM trip_task_steps WHERE task_id=?').get(hidden.id).state,'active');
  const after=getTrip(d,trip.id);
  assert.equal((await call('PUT',`/planning/admin/trips/${trip.id}`,{tasks:[step({title:'Spoofed private edit'})],expected_revision:after.task_group_revision,expected_parent_revision:after.parent_task.revision})).status,403);
  assert.equal(row(hidden.id).title,'Pack clothing');
 },other);
});

test('cancelled and non-task Trip metadata changes advance optimistic revisions',()=>{
 const trip=saveTrip(d,input({tasks:[step()]}),admin);
 const changed=saveTrip(d,{trip_type:'family',expected_revision:trip.task_group_revision},admin,trip.id);
 assert.ok(changed.task_group_revision>trip.task_group_revision);
 saveTrip(d,{status:'cancelled'},admin,trip.id);
 const cancelled=getTrip(d,trip.id);
 const tokens={expected_revision:cancelled.task_group_revision,expected_parent_revision:cancelled.parent_task.revision};
 const renamed=saveTrip(d,{name:'Updated cancelled trip',...tokens},admin,trip.id);
 assert.ok(renamed.task_group_revision>cancelled.task_group_revision);
 assert.throws(()=>saveTrip(d,{name:cancelled.name,notes:'Stale notes',...tokens},admin,trip.id),/changed|stale/i);
 assert.equal(getTrip(d,trip.id).name,'Updated cancelled trip');
 const same=saveTrip(d,{name:renamed.name},admin,trip.id);
 assert.equal(same.task_group_revision,renamed.task_group_revision);
});

test('coordinator and ordinary root assignment edits preserve child-owner participation',async()=>{
 const trip=saveTrip(d,input({tasks:[step()]}),admin);
 const other=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('coord2','Coordinator','x','admin','parent')").run().lastInsertRowid);
 saveTrip(d,{coordinator_id:other},admin,trip.id);
 assert.ok(d.prepare('SELECT 1 FROM task_assignments WHERE task_id=? AND user_id=?').get(trip.parent_task.id,child));
 assert.equal(taskCapabilities(d,child,row(trip.parent_task.id)).view,true);
 await withApi(async call=>{assert.equal((await call('PUT',`/tasks/${trip.parent_task.id}`,{assigned_to:[admin]})).status,200);});
 assert.ok(d.prepare('SELECT 1 FROM task_assignments WHERE task_id=? AND user_id=?').get(trip.parent_task.id,child));
 assert.equal(taskCapabilities(d,child,row(trip.parent_task.id)).view,true);
});

test('archiving the Trip root suppresses pending child reminders and notification dispatch',()=>{
 const trip=saveTrip(d,input({tasks:[step({reminder_offset_minutes:60})]}),admin);
 assert.equal(canReceiveNotification(d,{user_id:child,entity_type:'task',entity_id:trip.tasks[0].id}),true);
 d.prepare("UPDATE tasks SET archived_at='2031-07-01T00:00:00Z' WHERE id=?").run(trip.parent_task.id);
 assert.equal(canReceiveNotification(d,{user_id:child,entity_type:'task',entity_id:trip.tasks[0].id}),false);
});
