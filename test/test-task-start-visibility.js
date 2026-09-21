import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET||='task-start-visibility-tests';
const {ALL_MIGRATIONS,get,_setTestDatabase}=await import('../server/db.js');
const imported=get(); imported.close();
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:dashboardRouter}=await import('../server/routes/dashboard.js');
const {deviceAppMiddleware}=await import('../server/services/device-app.js');
const {createDevice}=await import('../server/services/devices.js');
const {assertRecurringCompletionStarted}=await import('../server/services/task-lifecycle.js');
const {saveRotationGroupUsage,reconcileSharedRotationPeriods}=await import('../server/services/rotation-shared.js');
const scope=await import('../server/services/task-scope.js');
let d,p,server,base;
test.beforeEach(async()=>{
  d=new Database(':memory:'); d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  _setTestDatabase(d);
  d.exec(`INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York');
    INSERT INTO users(id,username,display_name,password_hash,role) VALUES
      (1,'parent','Parent','x','admin'),(2,'eleanor','Eleanor','x','member'),(3,'frankie','Frankie','x','member');`);
  p={kind:'device',...createDevice(d,{name:'Kitchen Wall',scope:{member_ids:[2]}},1)};
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{if(req.get('X-Test-Device'))req.devicePrincipal=p;
    else {req.authUserId=1;req.authRole='admin';req.session={userId:1,role:'admin'};req.sessionModuleAccess=null;} next();});
  app.use('/api/v1',deviceAppMiddleware);app.use('/api/v1/tasks',tasksRouter);app.use('/api/v1/dashboard',dashboardRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}/api/v1`;
});
test.afterEach(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
function task({title='Bedtime',date='2026-09-20',time='19:00',parent=null,status='open',assigned=2,visibility='all',recurring=0,optional=0,points=0}={}) {
  const id=Number(d.prepare(`INSERT INTO tasks(title,start_date,start_time,due_date,parent_task_id,status,assigned_to,visibility,created_by,is_recurring,recurrence_rule,is_optional,points)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title,date,time,date,parent,status,assigned,visibility,1,recurring,recurring?'FREQ=DAILY':null,optional,points).lastInsertRowid);
  if(assigned)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assigned);
  return id;
}
async function read(path='/tasks',device=false){const r=await fetch(base+path,{headers:device?{'X-Test-Device':'1'}:{}});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
const ids=body=>body.data.map(row=>row.id);
const at=(t,instant)=>t.mock.timers.setTime(Date.parse(instant));
function clock(t,instant='2026-09-20T11:30:00Z'){t.mock.timers.enable({apis:['Date'],now:Date.parse(instant)});}

test('bedtime same-day start is hidden before 19:00 and visible exactly at its household-local boundary',async t=>{
  clock(t);const id=task();
  for(const instant of ['2026-09-20T11:30:00Z','2026-09-20T22:59:59.999Z']){
    at(t,instant);const body=await read();assert.ok(!ids(body).includes(id));
    assert.deepEqual(body.visibility,{server_now:Date.parse(instant),next_start_at:Date.parse('2026-09-20T23:00:00Z')});
  }
  for(const instant of ['2026-09-20T23:00:00Z','2026-09-20T23:00:00.001Z']){
    at(t,instant);const body=await read();assert.ok(ids(body).includes(id));assert.equal(body.visibility.next_start_at,null);
  }
});

test('date-only starts use household midnight; tomorrow is upcoming; overdue and in-progress work remain',async t=>{
  clock(t);const tonight=task(),tomorrow=task({date:'2026-09-21',time:null}),today=task({time:null}),undated=task({date:null,time:null});
  const past=task({date:'2026-09-19',status:'in_progress'});
  const body=await read();assert.deepEqual(new Set(ids(body)),new Set([today,undated,past]));
  assert.deepEqual(new Set(ids(await read('/tasks?include_future=1'))),new Set([tonight,tomorrow,today,undated,past]));
  assert.equal((await read('/tasks?include_future=1')).visibility.next_start_at,null);
  assert.equal((await read(`/tasks/${tonight}`)).data.id,tonight,'detail remains available for planning');
  at(t,'2026-09-21T03:59:59.999Z');assert.ok(!ids(await read()).includes(tomorrow));
  at(t,'2026-09-21T04:00:00Z');assert.ok(ids(await read()).includes(tomorrow));
});

test('early recurring occurrences and linked helpers cannot leak a hidden source parent',async t=>{
  clock(t);const parent=task({recurring:1}),child=task({parent,date:null,time:null});
  const helper=task({title:'Supervisor projection',date:null,time:null}),counterpart=task({title:'Helper action',parent:helper,date:null,time:null});
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(parent,helper);
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES(?,?,?,?,?,'assigned')").run(parent,child,counterpart,2,1);
  for(const device of [false,true])assert.deepEqual(ids(await read('/tasks',device)),[]);
  assert.throws(()=>assertRecurringCompletionStarted(d,child),error=>error.details?.reason==='occurrence_not_started');
  assert.throws(()=>assertRecurringCompletionStarted(d,counterpart),error=>error.details?.reason==='occurrence_not_started');
  at(t,'2026-09-20T23:00:00Z');assert.ok(ids(await read()).includes(parent));assert.ok(ids(await read()).includes(helper));
  assert.doesNotThrow(()=>assertRecurringCompletionStarted(d,counterpart));
});

test('future nested actions hide without reporting the visible required steps as all complete',async t=>{
  clock(t);const parent=task({date:null,time:null});const done=task({parent,date:null,time:null,status:'done',points:1});
  const later=task({parent,time:'13:00',points:2});task({parent,time:'14:00',optional:1});
  for(const device of [false,true]){
    const body=await read('/tasks',device),row=body.data.find(value=>value.id===parent);
    assert.deepEqual(row.subtasks.map(value=>value.id),[done]);assert.equal(row.subtask_total,2);assert.equal(row.subtask_done,1);
    assert.equal(row.scheduled_action_count,2);assert.equal(row.scheduled_subtask_total,1);assert.equal(row.scheduled_subtask_points,2);
    assert.equal(row.scheduled_optional_subtask_total,1);assert.equal(body.visibility.next_start_at,Date.parse('2026-09-20T17:00:00Z'));
  }
  assert.ok((await read(`/tasks/${parent}`)).data.subtasks.some(value=>value.id===later),'details still expose planned steps');
});

test('helper counterpart follows its source action window even when its own saved window is stale',async t=>{
  clock(t);const parent=task({date:null,time:null}),child=task({parent});
  const helper=task({date:null,time:null}),counterpart=task({parent:helper,date:null,time:null});
  d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(parent,helper);
  d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,state) VALUES(?,?,?,?,?,'assigned')").run(parent,child,counterpart,2,1);
  const row=(await read()).data.find(value=>value.id===helper);assert.ok(row);assert.deepEqual(row.subtasks,[]);
  assert.equal(row.scheduled_subtask_total,1);assert.equal(row.scheduled_action_count,1);
  at(t,'2026-09-20T23:00:00Z');assert.ok((await read()).data.find(value=>value.id===helper).subtasks.some(value=>value.id===counterpart));
});

test('hidden-action accounting uses the canonical delegated and helper progress rules',t=>{
  clock(t);const parent=task({date:null,time:null});
  const normal=task({parent}),delegated=task({parent}),notRequired=task({parent}),optionalDelegated=task({parent,optional:1}),support=task({parent});
  const children=[{id:normal,points:1},{id:delegated,points:2,status:'done',supervision_action:{execution_mode:'delegated',state:'assigned'}},
    {id:notRequired,points:3,supervision_action:{execution_mode:'delegated',state:'not_required'}},
    {id:optionalDelegated,is_optional:1,supervision_action:{execution_mode:'delegated',state:'assigned'}},{id:support,is_support_task:true}];
  const projected=scope.taskStartProjection(d,{tasks:[{id:parent}]}).project({id:parent,subtasks:children});
  assert.equal(projected.scheduled_action_count,5);assert.equal(projected.scheduled_subtask_total,2);
  assert.equal(projected.scheduled_completed_action_count,1);
  assert.equal(projected.scheduled_subtask_points,4);assert.equal(projected.scheduled_optional_subtask_total,0);
});

test('paired List and Kanban use canonical scope and metadata cannot reveal private or out-of-scope starts',async t=>{
  clock(t);const id=task();task({title:'PRIVATE',time:'08:00',visibility:'private'});task({title:'OUT OF SCOPE',time:'09:00',assigned:3});
  for(const view of ['list','kanban']){
    const body=await read(`/tasks?view=${view}`,true);assert.deepEqual(body.data,[]);assert.equal(body.visibility.next_start_at,Date.parse('2026-09-20T23:00:00Z'));
    assert.ok(!JSON.stringify(body).includes('PRIVATE'));assert.deepEqual(ids(await read(`/tasks?view=${view}&include_future=1`,true)),[id]);
  }
  at(t,'2026-09-20T23:00:00Z');assert.deepEqual(ids(await read('/tasks',true)),[id]);
});

test('DST gaps move forward and overlap starts stay visible through the repeated hour',async t=>{
  clock(t,'2026-03-08T07:29:59.999Z');const gap=task({date:'2026-03-08',time:'02:30'});
  assert.ok(!ids(await read()).includes(gap));assert.equal((await read()).visibility.next_start_at,Date.parse('2026-03-08T07:30:00Z'));
  at(t,'2026-03-08T07:30:00Z');assert.ok(ids(await read()).includes(gap));
  const overlap=task({date:'2026-11-01',time:'01:30'});
  at(t,'2026-11-01T05:29:59.999Z');assert.ok(!ids(await read()).includes(overlap));
  for(const instant of ['2026-11-01T05:30:00Z','2026-11-01T06:00:00Z','2026-11-01T06:30:00Z']){at(t,instant);assert.ok(ids(await read()).includes(overlap));}
});

test('Dashboard aggregates and normal Tasks use the same full start instant before limits',async t=>{
  clock(t);const future=task();const started=task({date:'2026-09-19',status:'in_progress'});
  const body=await read('/dashboard');assert.equal(body.openTaskCount,1);assert.equal(body.overdueTaskCount,1);
  assert.ok(body.urgentTasks.some(row=>row.id===started));assert.ok(!body.urgentTasks.some(row=>row.id===future));
});

test('Rotation-bound recurring work stays hidden until its own start and visibility reads never resolve or advance',async t=>{
  clock(t);
  const group=saveRotationGroupUsage(d,{name:'Shared shower order',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',starting_member_id:2,effective_date:'2026-09-20',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:1});
  const response=await fetch(base+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Rotation bedtime',assigned_to:[2],
    start_date:'2026-09-20',start_time:'19:00',due_date:'2026-09-20',due_time:'23:00',due_date_offset_days:0,is_recurring:true,recurrence_rule:'FREQ=DAILY',
    rotation_bindings:[{purpose_key:'shower_order',label:'Shower Order',group_id:group.id,strategy:'rotating_order',advance_policy:'on_finalized'}],
    subtasks:[{title:'Take shower',assigned_user_ids:[2]}]})});
  const created=await response.json();assert.equal(response.status,201,JSON.stringify(created));const id=created.data.id;
  const snapshot=()=>JSON.stringify({tracks:d.prepare('SELECT * FROM rotation_tracks').all(),occurrences:d.prepare('SELECT * FROM rotation_occurrences').all(),tasks:d.prepare('SELECT id,revision,status,start_date,start_time FROM tasks').all()});
  let before=snapshot();assert.ok(!ids(await read()).includes(id));assert.equal(snapshot(),before);
  at(t,'2026-09-20T22:00:00Z');reconcileSharedRotationPeriods(d,{now:new Date(),groupId:group.id});
  before=snapshot();assert.ok(!ids(await read()).includes(id));assert.equal(snapshot(),before,'group activation does not expose the future Task');
  at(t,'2026-09-20T23:00:00Z');const body=await read();assert.ok(ids(body).includes(id));assert.ok(body.data.find(row=>row.id===id).rotations.length);
  assert.equal(snapshot(),before,'visible projection does not materialize or advance rotation');
});

test('projection is read-only and batches nested ancestor lookup within a request',t=>{
  clock(t);const root=task(),children=Array.from({length:30},()=>task({parent:root,date:null,time:null}));
  const before=d.prepare('SELECT total_changes() AS n').get().n,original=d.prepare.bind(d);let reads=0;
  d.prepare=(...args)=>{reads++;return original(...args);};
  const projection=scope.taskStartProjection(d,{tasks:[{id:root}]});
  for(const id of children)assert.equal(projection.visible(id),false);
  d.prepare=original;
  assert.ok(reads<=4,`expected bounded graph reads, got ${reads}`);assert.equal(d.prepare('SELECT total_changes() AS n').get().n,before);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});
