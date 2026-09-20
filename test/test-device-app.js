import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET||='device-normal-app-tests';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {deviceAppMiddleware,deviceAppRouteSupported}=await import('../server/services/device-app.js');
const {createDevice}=await import('../server/services/devices.js');
const {deviceTaskStatus}=await import('../server/services/device-tasks.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
let d,p,server,base;
test.beforeEach(async()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}_setTestDatabase(d);
  d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'grace','Grace','x','member'),(3,'eleanor','Eleanor','x','member');
    INSERT INTO tasks(id,title,description,assigned_to,visibility,created_by,points) VALUES(1,'Shared routine','Shared description',2,'all',1,2),(2,'PRIVATE TASK','PRIVATE BODY',3,'private',1,30),(3,'OUTSIDE SCOPE','Out of scope',3,'all',1,0);
    INSERT INTO tasks(id,title,parent_task_id,created_by,visibility) VALUES(4,'Brush teeth',1,1,'all');
    INSERT INTO task_assignments(task_id,user_id) VALUES(1,2),(2,3),(3,3);
    INSERT INTO task_tags(task_id,tag,tag_key) VALUES(1,'Routine','routine'),(2,'PRIVATE TAG','private tag');
    INSERT INTO reward_participants(user_id) VALUES(2),(3);
    INSERT INTO reward_catalog(id,name,cost,created_by) VALUES(1,'Family reward',4,1);
    INSERT INTO reward_ledger(user_id,delta,type,reason,created_by) VALUES(2,5,'bonus','PRIVATE LEDGER',1),(3,20,'bonus','PRIVATE OTHER',1);
    INSERT INTO calendar_events(id,title,start_datetime,visibility,created_by,external_source,assigned_to) VALUES(1,'Shared event','2026-09-19T12:00:00','all',1,'local',2),(2,'PRIVATE EVENT','2026-09-19T13:00:00','private',1,'local',1),(3,'OUTSIDE EVENT','2026-09-19T14:00:00','all',1,'local',3);
    INSERT INTO event_assignments(event_id,user_id) VALUES(1,2),(3,3);
    INSERT INTO meals(id,date,meal_type,title,created_by,scope,selection_status) VALUES(1,'2026-09-19','dinner','Family meal',1,'household','selected'),(2,'2026-09-19','lunch','PRIVATE MEAL',1,'personal','selected');
    INSERT INTO shopping_lists(id,name,created_by) VALUES(1,'Groceries',1);INSERT INTO shopping_items(id,list_id,name,quantity) VALUES(1,1,'Milk','1');`);
  p={kind:'device',...createDevice(d,{name:'Kitchen Wall',scope:{member_ids:[2],show_points:true}},1)};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.devicePrincipal=p;next();});
  app.use('/api/v1',deviceAppMiddleware);app.use((_req,res)=>res.json({secret:'HUMAN ROUTER FALLTHROUGH'}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/api/v1`;
});
test.afterEach(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
async function call(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body&&method!=='GET'?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),replayed:r.headers.get('Idempotent-Replayed')};}
const revision=id=>d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;

test('normal Task board and metadata use the same scoped identity without private nested content',async()=>{
  const list=await call('/tasks?include_future=1');assert.equal(list.status,200);assert.deepEqual(list.body.data.map(row=>row.id),[1]);
  assert.equal(list.body.data[0].subtasks[0].title,'Brush teeth');assert.deepEqual(list.body.data[0].tags,['Routine']);
  const meta=await call('/tasks/meta/options');assert.equal(meta.status,200);assert.deepEqual(meta.body.users.map(row=>row.id),[2]);
  assert.ok(meta.body.categories.length);assert.deepEqual(meta.body.tags,[{tag:'Routine',count:1}]);
  for(const path of ['/tasks/2','/tasks/3','/tasks/2/activity','/tasks/3/comments'])assert.equal((await call(path)).status,404,path);
  assert.ok(!JSON.stringify([list.body,meta.body]).includes('PRIVATE'));
  assert.deepEqual((await call('/tasks?status=done')).body.data,[]);
});

test('canonical board mutations award the responsibility once and return a scoped parent snapshot',async()=>{
  const payload={status:'done',expected_revision:revision(4),expected_parent_revision:revision(1)};
  const done=await call('/tasks/4/status','PATCH',payload);assert.equal(done.status,200,JSON.stringify(done.body));
  assert.equal(done.body.data.status,'done');assert.equal(done.body.data.parent_task.status,'done');
  const ledger=d.prepare('SELECT user_id,delta,created_by FROM reward_ledger WHERE task_id=1').all();assert.deepEqual(ledger,[{user_id:2,delta:2,created_by:null}]);
  const repeated=await call('/tasks/4/status','PATCH',{status:'done',expected_revision:revision(4),expected_parent_revision:revision(1)});assert.equal(repeated.status,200);
  assert.equal(d.prepare('SELECT count(*) n FROM reward_task_awards WHERE task_id=1').get().n,1);
  const history=await call('/tasks/1/activity');assert.equal(history.status,200);assert.ok(history.body.data.some(row=>row.details.source_device?.name==='Kitchen Wall'));
  const completed=await call('/tasks?status=done');assert.equal(completed.body.data[0].id,1);
});

test('normal Calendar Meals Shopping and Rewards screen contracts stay shared and read-only',async()=>{
  const calendar=await call('/calendar?from=2026-09-19&to=2026-09-20');assert.equal(calendar.status,200);assert.deepEqual(calendar.body.data.map(row=>row.id),[1]);
  const meals=await call('/meals/week-model?start=2026-09-19&end=2026-09-20');assert.equal(meals.status,200);assert.deepEqual(meals.body.data.occurrences.map(row=>row.id),[1]);assert.equal(meals.body.data.can_act_for,false);
  const shopping=await call('/shopping/1/items');assert.equal(shopping.status,200);assert.equal(shopping.body.data[0].name,'Milk');
  const rewards=await call('/rewards/overview');assert.equal(rewards.status,200);assert.deepEqual(rewards.body.data.balances.map(row=>row.id),[2]);assert.equal(rewards.body.data.me,null);
  assert.ok(!JSON.stringify([calendar.body,meals.body,shopping.body,rewards.body]).includes('PRIVATE'));
  for(const [path,method]of [['/calendar','POST'],['/meals','POST'],['/shopping/items/1','PATCH'],['/rewards/redemptions','POST'],['/rewards/ledger','GET']])assert.equal((await call(path,method,{})).status,403,path);
});

test('device preferences never inherit a person and module denial never falls through to human routes',async()=>{
  p.preferences.appearance={theme:'dark',palette:'warm',font:'serif',density:'compact'};
  const prefs=await call('/preferences');assert.equal(prefs.status,200);assert.equal(prefs.body.data.theme,'dark');assert.equal(prefs.body.data.heading_font,'serif');
  assert.equal((await call('/preferences','PUT',{theme:'light'})).status,403);
  p.permissions.modules.tasks='none';assert.equal((await call('/tasks')).status,403);assert.equal((await call('/tasks/meta/options')).status,403);
  p.permissions.modules.calendar='none';assert.equal((await call('/calendar')).status,403);
  for(const path of ['/search','/documents/1','/auth/api-tokens','/automation/rotation-tracks/1','/automation/rotation-occurrences/1','/notes']){
    const result=await call(path);assert.equal(result.status,403,path);assert.ok(!JSON.stringify(result.body).includes('HUMAN ROUTER'));
  }
  assert.equal(deviceAppRouteSupported('GET','/api/v1/tasks?status=open'),true);
  assert.equal(deviceAppRouteSupported('POST','/api/v1/tasks/1/duplicate'),false);
});

test('Task history projects known fields instead of leaking arbitrary consumer context from event details',async()=>{
  d.prepare('INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(1,1,1,?,?)')
    .run('updated',JSON.stringify({title:'Shared routine',context:{title:'PRIVATE NESTED'},from:'open',to:'in_progress',source_device:{id:1,name:'Kitchen Wall',token:'PRIVATE TOKEN'}}));
  const r=await call('/tasks/1/activity');assert.equal(r.status,200);assert.equal(r.body.data[0].actor_name,null);assert.ok(!JSON.stringify(r.body).includes('PRIVATE'));
});

test('completion pagination never discloses hidden occurrence IDs dates or existence through its cursor',async()=>{
  const insertTask=d.prepare("INSERT INTO tasks(title,assigned_to,visibility,status) VALUES('Hidden completion',3,'all','done')");
  const insertCompletion=d.prepare('INSERT INTO task_completions(task_id,series_id,user_id,completed_at) VALUES(?,?,?,?)');
  d.transaction(()=>{for(let index=0;index<1001;index++){const id=Number(insertTask.run().lastInsertRowid);insertCompletion.run(id,id,3,'2099-12-31T23:59:59Z');}})();
  assert.deepEqual((await call('/tasks/completions?limit=1')).body,{data:[],has_more:false,next_cursor:null});
  insertCompletion.run(1,1,2,'2026-09-19T10:00:00Z');insertCompletion.run(4,1,2,'2026-09-18T10:00:00Z');
  const first=await call('/tasks/completions?limit=1');assert.equal(first.body.data[0].task_id,1);assert.equal(first.body.has_more,true);
  assert.deepEqual(first.body.next_cursor,{before_at:'2026-09-19T10:00:00Z',before_id:first.body.data[0].id});
  assert.ok(!JSON.stringify(first.body).includes('2099-12-31'));
  const second=await call(`/tasks/completions?limit=1&before_at=${first.body.next_cursor.before_at}&before_id=${first.body.next_cursor.before_id}`);
  assert.equal(second.body.data[0].task_id,4);assert.equal(second.body.has_more,false);assert.equal(second.body.next_cursor,null);
});

test('normal editor inert fields allow authorized plain creation and editing without enabling structural or reward bypasses',async()=>{
  for(const cap of ['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.reassign','tasks.change_dates'])p.permissions.capabilities[cap]='allow';
  const body={title:'New plain Task',description:null,assigned_to:[2],points:0,priority:'none',category:'misc',tags:[],
    start_date:null,start_time:null,due_date:null,due_time:null,activity_template_id:null,activity_subject_user_id:null,assignment_mode:'fixed',
    rotation_user_ids:[],rotation_group:null,rotation_slot:0,visibility:'all',is_recurring:0,recurrence_rule:null,recurrence_from_completion:0,
    countdown:0,locked:0,expiration_policy:'keep_overdue',location:{kind:'none'},skill_ids:[],rotation_bindings:[],subtasks:[],sync_target:'',status:'open'};
  const created=await call('/tasks','POST',body);assert.equal(created.status,201,JSON.stringify(created.body));
  const updated=await call(`/tasks/${created.body.data.id}`,'PUT',{...body,title:'Edited plain Task',expected_revision:created.body.data.revision});assert.equal(updated.status,200,JSON.stringify(updated.body));
  for(const extra of [{points:99},{subtasks:[{title:'Reward bypass',points:99}]},{activity_template_id:1},{status:'done'},{skill_ids:[1]}])assert.equal((await call('/tasks','POST',{...body,...extra})).status,403,JSON.stringify(extra));
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('normal scoped board exposes approval only for a protected action and never grants its checkbox human authority',async()=>{
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',1)").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(2,?,'supervised','manual',1)").run(skill);
  setTaskSkills(d,4,[skill]);reconcileTaskSupervision(d,1);
  const value=await call('/tasks/1');assert.equal(value.status,200);
  assert.equal(value.body.data.permissions.supervisor_approval,false);
  assert.equal(value.body.data.permissions.complete,false,'protected required descendant is not offered as a bulk completion');
  assert.equal(value.body.data.subtasks[0].permissions.supervisor_approval,true);
  assert.equal(value.body.data.subtasks[0].permissions.complete,false);
  assert.equal(value.body.data.subtasks[0].supervision_action.can_complete,false);
  const rejected=await call('/tasks/4/status','PATCH',{status:'done',expected_revision:revision(4),expected_parent_revision:revision(1)});assert.equal(rejected.status,403);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=4').get().status,'open');
  p.permissions.capabilities['device_tasks.complete']='none';assert.equal((await call('/tasks/4')).body.data.permissions.supervisor_approval,false);
});

test('normal opt-in claim carries an explicit permitted recipient rather than a persistent acting member',async()=>{
  d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=3').run();d.prepare('DELETE FROM task_assignments WHERE task_id=3').run();
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(3,'open_claimable','open','planning_context')").run();
  d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(3,2)').run();
  p.permissions.capabilities['device_tasks.claim']='allow';
  const view=await call('/tasks/3');assert.equal(view.body.data.activity_assignment_state,'open');assert.deepEqual(view.body.data.claim_candidates.map(row=>row.id),[2]);
  assert.equal((await call('/automation/tasks/3/claim','POST',{expected_revision:revision(3)})).status,400);
  assert.equal((await call('/automation/tasks/3/claim','POST',{user_id:3,expected_revision:revision(3)})).status,403);
  const claimed=await call('/automation/tasks/3/claim','POST',{user_id:2,expected_revision:revision(3)});assert.equal(claimed.status,200);assert.equal(claimed.body.data.assigned_to,2);
  assert.equal(p.kind,'device');assert.equal(p.name,'Kitchen Wall');
});

test('normal creation retries use device-owned durable receipts with fresh grants and response projection',async()=>{
  for(const cap of ['tasks.create','tasks.change_assignment'])p.permissions.capabilities[cap]='allow';
  const body={title:'Retry-safe Task',assigned_to:[2],points:0},headers={'Idempotency-Key':'same-draft'};
  const first=await call('/tasks','POST',body,headers),retry=await call('/tasks','POST',body,headers);
  assert.equal(first.status,201);assert.equal(retry.status,201);assert.equal(retry.replayed,'true');assert.equal(first.body.data.id,retry.body.data.id);
  assert.equal((await call('/tasks','POST',{...body,title:'Conflicting draft'},headers)).status,409);
  p.permissions.capabilities['tasks.create']='none';assert.equal((await call('/tasks','POST',body,headers)).status,403);
  p.permissions.capabilities['tasks.create']='allow';p.scope.member_ids=[3];assert.equal((await call('/tasks','POST',body,headers)).status,404);
  p.scope.member_ids=[2];d.prepare('UPDATE tasks SET points=5 WHERE id=?').run(first.body.data.id);
  assert.equal((await call('/tasks','POST',body,headers)).status,403,'replay rechecks actual reward value after permissions or definition change');
  assert.equal(d.prepare('SELECT count(*) n FROM device_task_creation_receipts').get().n,1);
  assert.equal(d.prepare("SELECT count(*) n FROM tasks WHERE title='Retry-safe Task'").get().n,1);
  assert.deepEqual(d.prepare('PRAGMA table_info(device_task_creation_receipts)').all().map(row=>row.name),['device_id','request_key','request_hash','task_id','created_at']);
});

test('two database workers concurrently retry one device draft and commit one Task and receipt',async()=>{
  for(const cap of ['tasks.create','tasks.change_assignment'])p.permissions.capabilities[cap]='allow';
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'vidamia-device-retry-')),file=path.join(folder,'fixture.db');
  await d.backup(file);const gate=new SharedArrayBuffer(4),workers=[];
  try {
    const starts=[0,1].map(()=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./helpers/device-create-retry-worker.mjs',import.meta.url),{workerData:{path:file,gate,principal:p,key:'concurrent-draft',body:{title:'One concurrent Task',assigned_to:[2],points:0}}});
      workers.push(worker);worker.once('error',reject);worker.once('message',message=>{assert.equal(message.ready,true);resolve();});
    }));
    await Promise.all(starts);
    const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('message',resolve);}));
    Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,2);
    const values=await Promise.all(results);assert.ok(values.every(value=>!value.error),JSON.stringify(values));
    assert.equal(values[0].id,values[1].id);assert.deepEqual(values.map(value=>value.replayed).sort(),[false,true]);
    const checked=new Database(file);try{assert.equal(checked.prepare("SELECT count(*) n FROM tasks WHERE title='One concurrent Task'").get().n,1);assert.equal(checked.prepare('SELECT count(*) n FROM device_task_creation_receipts').get().n,1);assert.deepEqual(checked.pragma('foreign_key_check'),[]);}finally{checked.close();}
  }finally {
    await Promise.all(workers.map(worker=>worker.terminate()));
    const resolved=path.resolve(folder),temporaryRoot=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),temporaryRoot);assert.ok(path.basename(resolved).startsWith('vidamia-device-retry-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
