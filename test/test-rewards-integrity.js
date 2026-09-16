import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='reward-integrity-tests';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {awardForCompletion,syncTaskRewards,getBalance,postLedger,createRedemption,decideRedemption}=await import('../server/services/rewards.js');
const {changeTaskStatus,assertRecurringCompletionStarted}=await import('../server/services/task-lifecycle.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {default:rewardsRouter}=await import('../server/routes/rewards.js');
const {upsertTask}=await import('../server/services/caldav-reminders-sync.js');
const directory=mkdtempSync(join(tmpdir(),'vidamia-reward-integrity-')),path=join(directory,'household.db');
const d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=10000');
for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
_setTestDatabase(d);
let sequence=0;
const user=(role='member')=>Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
  VALUES(?,?,'x',?,'parent')`).run(`reward-${++sequence}`,`Person ${sequence}`,role).lastInsertRowid);
const admin=user('admin');
function member(points=0){const id=user();d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  if(points)postLedger(d,{userId:id,delta:points,type:'bonus'});return id;}
const reward=(cost=10)=>Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Movie',?)").run(cost).lastInsertRowid);
function task(assignee,points=5,parent=null){const id=Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,points,parent_task_id)
  VALUES('Laundry occurrence',?,?,?,?)`).run(admin,assignee,points,parent).lastInsertRowid);
  if(assignee)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assignee);return id;}
const earnings=id=>d.prepare("SELECT * FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY id").all(id);
const transition=(id,status,actor=admin,body={})=>changeTaskStatus(d,id,status,{actorId:actor,authorize:false,body});
const intent=(id,catalog=reward(),key=randomUUID())=>({actorId:id,userId:id,catalogId:catalog,requestKey:key});
const app=express();app.use(express.json());
app.use((req,res,next)=>{req.authUserId=Number(req.get('x-user')||admin);req.authRole=req.authUserId===admin?'admin':'member';
  req.authMethod='session';req.sessionID=req.get('x-session');req.session={userId:req.authUserId};next();});
app.use('/tasks',tasksRouter);app.use('/compat/tasks',tasksRouter);app.use('/rewards',rewardsRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
async function call(method,url,body,{actor=admin,key,session}={}){const response=await fetch(base+url,{method,
  headers:{'Content-Type':'application/json','x-user':String(actor),...(key?{'Idempotency-Key':key}:{}),...(session?{'x-session':session}:{})},
  body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),replayed:response.headers.get('Idempotent-Replayed')};}
test.after(()=>{server.closeAllConnections();server.close();_setTestDatabase(null);d.close();
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});

test('one occurrence keeps its original ledger and recipients across reopen, reassignment, repeated completion and direct retries',()=>{
  const a=member(),b=member(),id=task(a);transition(id,'done');const original=earnings(id);
  for(let i=0;i<3;i++){transition(id,'in_progress');transition(id,'done');awardForCompletion(d,id,admin);}
  d.prepare('UPDATE task_assignments SET user_id=? WHERE task_id=?').run(b,id);
  syncTaskRewards(d,id,'open','done',b);
  assert.deepEqual(earnings(id),original);assert.equal(getBalance(d,a),5);assert.equal(getBalance(d,b),0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE task_id=?').get(id).n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='completed'").get(id).n,4);
});

test('concurrent requests for the same final subtask award its parent once and stale revision retries fail',async()=>{
  const a=member(),root=task(a),child=task(a,0,root);
  const revisions=d.prepare('SELECT revision FROM tasks WHERE id IN (?,?) ORDER BY id').all(root,child);
  const body={status:'done',expected_revision:revisions[1].revision,expected_parent_revision:revisions[0].revision};
  const responses=await Promise.all([call('PATCH',`/tasks/${child}/status`,body),call('PATCH',`/compat/tasks/${child}/status`,body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal(earnings(root).length,1);assert.equal(getBalance(d,a),5);
});

async function concurrent(kind,args){const gate=new SharedArrayBuffer(4);
  const workers=args.map(arg=>new Worker(new URL('./reward-integrity-worker.mjs',import.meta.url),{workerData:{path,kind,args:arg,gate}}));
  const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',value=>{if(!value.ready)resolve(value);});}));
  await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));
  Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,workers.length);
  const out=await Promise.all(results);await Promise.all(workers.map(worker=>worker.terminate()));return out;
}

test('separate SQLite connections concurrently claim one occurrence exactly once',async()=>{
  const a=member(),id=task(a);const results=await concurrent('award',Array.from({length:4},()=>[id,admin]));
  assert.equal(results.filter(r=>r.result===true).length,1);assert.ok(results.every(r=>!r.error));
  assert.equal(earnings(id).length,1);assert.equal(getBalance(d,a),5);
});

test('redemption requests require durable IDs; parallel replay deducts once even after generic cache expiry',async()=>{
  const a=member(100),catalog=reward(),key=randomUUID();
  assert.equal((await call('POST','/rewards/redemptions',{catalog_id:catalog},{actor:a})).status,428);
  const responses=await Promise.all(Array.from({length:4},()=>call('POST','/rewards/redemptions',{catalog_id:catalog},{actor:a,key})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,200,200,201]);
  const id=responses[0].body.data.id;assert.ok(responses.every(r=>r.body.data.id===id));
  d.prepare("DELETE FROM idempotency_keys").run();
  d.prepare("UPDATE reward_redemption_requests SET created_at='2000-01-01' WHERE request_key=?").run(key);
  assert.equal((await call('POST','/rewards/redemptions',{catalog_id:catalog},{actor:a,key})).body.data.id,id);
  assert.equal(getBalance(d,a),90);assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='redeem'").get(id).n,1);
});

test('durable redemption replay survives new connection, catalog deletion and disabled participation',()=>{
  const a=member(20),args=intent(a),created=createRedemption(d,args);
  d.prepare('DELETE FROM reward_catalog WHERE id=?').run(args.catalogId);
  d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=?').run(a);
  const reopened=new Database(path);try{const replay=createRedemption(reopened,args);assert.equal(replay.row.id,created.row.id);assert.equal(replay.replayed,true);}finally{reopened.close();}
  assert.equal(getBalance(d,a),10);
});

test('same durable key with changed intent conflicts and cannot charge another recipient',()=>{
  const a=member(30),b=member(30),args=intent(a);createRedemption(d,args);
  assert.throws(()=>createRedemption(d,{...args,userId:b}),e=>e.status===409);
  assert.throws(()=>createRedemption(d,{...args,note:'different'}),e=>e.status===409);
  assert.equal(getBalance(d,a),20);assert.equal(getBalance(d,b),30);
});

test('parallel separate database writers cannot spend the same available balance twice',async()=>{
  const a=member(10),catalog=reward();const results=await concurrent('redeem',[intent(a,catalog),intent(a,catalog)]);
  assert.equal(results.filter(r=>r.result).length,1);assert.equal(results.filter(r=>r.error==='Insufficient points.').length,1);
  assert.equal(getBalance(d,a),0);
});

test('separate writers replay the same redemption key once and concurrent cancellation refunds once',async()=>{
  const a=member(30),args=intent(a);const responses=await concurrent('redeem',[args,args,args]);
  assert.ok(responses.every(r=>!r.error));const id=responses[0].result.row.id;
  assert.ok(responses.every(r=>r.result.row.id===id));assert.equal(getBalance(d,a),20);
  const decision={actorId:a,isAdmin:false,redemptionId:id,action:'cancel'};
  const cancelled=await concurrent('decision',[decision,decision,decision]);assert.ok(cancelled.every(r=>r.result.status==='cancelled'));
  assert.equal(getBalance(d,a),30);assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,1);
});

test('conflicting decisions and untrusted acting-for requests cannot double refund or touch another balance',async()=>{
  const a=member(30),b=member(30),catalog=reward();
  const response=await call('POST','/rewards/redemptions',{catalog_id:catalog,user_id:b},{actor:a,key:randomUUID()});
  assert.equal(response.body.data.user_id,a);const id=response.body.data.id;
  assert.equal((await call('PATCH',`/rewards/redemptions/${id}`,{action:'cancel'},{actor:b})).status,403);
  decideRedemption(d,{actorId:admin,isAdmin:true,redemptionId:id,action:'fulfill'});
  assert.throws(()=>decideRedemption(d,{actorId:admin,isAdmin:true,redemptionId:id,action:'reject'}),e=>e.status===409);
  assert.equal(getBalance(d,a),20);assert.equal(getBalance(d,b),30);
});

test('ledger guard refuses duplicate deductions and refunds even through an alternate direct writer',()=>{
  const a=member(20),{row}=createRedemption(d,intent(a));
  assert.throws(()=>postLedger(d,{userId:a,delta:-10,type:'redeem',redemptionId:row.id}),/only once/);
  decideRedemption(d,{actorId:a,isAdmin:false,redemptionId:row.id,action:'cancel'});
  assert.throws(()=>postLedger(d,{userId:a,delta:10,type:'reversal',redemptionId:row.id}),/only once/);
  assert.equal(getBalance(d,a),20);
});

test('long RGI family and flag sequences are stored intact; oversized icon input is rejected',async()=>{
  for(const icon of ['🧑🏿‍🤝‍🧑🏻','👨‍👩‍👧‍👦','🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}']){
    const created=await call('POST','/rewards/catalog',{name:'Icon test',cost:1,icon});assert.equal(created.status,201);assert.equal(created.body.data.icon,icon);
    const edited=await call('PATCH',`/rewards/catalog/${created.body.data.id}`,{icon});assert.equal(edited.body.data.icon,icon);
  }
  assert.equal((await call('POST','/rewards/catalog',{name:'Too long',cost:1,icon:'x'.repeat(129)})).status,400);
});

test('recurring start gate uses household-local midnight, independent of server timezone and DST',()=>{
  const id=task(admin,0);d.prepare("UPDATE tasks SET is_recurring=1,start_date='2026-03-08' WHERE id=?").run(id);
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  assert.throws(()=>assertRecurringCompletionStarted(d,id,new Date('2026-03-08T04:59:59.999Z')),e=>e.details.reason==='occurrence_not_started');
  assert.doesNotThrow(()=>assertRecurringCompletionStarted(d,id,new Date('2026-03-08T05:00:00Z')));
  d.prepare("UPDATE tasks SET start_date='2026-11-01' WHERE id=?").run(id);
  assert.throws(()=>assertRecurringCompletionStarted(d,id,new Date('2026-11-01T03:59:59.999Z')));
  assert.doesNotThrow(()=>assertRecurringCompletionStarted(d,id,new Date('2026-11-01T04:00:00Z')));
  d.prepare("UPDATE sync_config SET value='Pacific/Auckland' WHERE key='household_timezone'").run();
  assert.doesNotThrow(()=>assertRecurringCompletionStarted(d,id,new Date('2026-10-31T11:00:00Z')));
  d.prepare("UPDATE sync_config SET value='America/New_York' WHERE key='household_timezone'").run();
});

test('future recurring occurrence blocks parent bulk, first subtask and compatibility completion without any mutation',async()=>{
  const a=member(),root=task(a),child=task(a,0,root);
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2099-01-03',due_date='2099-01-03' WHERE id=?").run(root);
  const before=d.prepare('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id').all(root,child);
  for(const prefix of ['/tasks','/compat/tasks'])for(const id of [root,child]){
    const row=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    const body={status:'done',complete_remaining:true,expected_revision:row.revision,...(id===child?{expected_parent_revision:before[0].revision}:{})};
    const res=await call('PATCH',`${prefix}/${id}/status`,body);assert.equal(res.status,409);assert.equal(res.body.reason,'occurrence_not_started');
    assert.match(res.body.error,/2099-01-03/);
    const edited=await call('PUT',`${prefix}/${id}`,{...body,title:'Must roll back this edit'});
    assert.equal(edited.status,409);assert.equal(edited.body.reason,'occurrence_not_started');
  }
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id').all(root,child),before);
  assert.equal(earnings(root).length,0);
});

test('structured CalDAV completion uses the same future recurring occurrence gate and rolls back the inbound mutation',()=>{
  const a=member(),id=task(a),uid=randomUUID();
  const account=Number(d.prepare("INSERT INTO caldav_accounts(name,caldav_url,username,password) VALUES('Fixture','https://example.test/calendar','fixture','x')").run().lastInsertRowid);
  d.prepare(`UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2099-01-03',due_date='2099-01-03',
    external_source='caldav',external_uid=?,external_account_id=? WHERE id=?`).run(uid,account,id);
  const before=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  assert.throws(()=>d.transaction(()=>upsertTask({uid,summary:'Provider title',description:null,priority:5,
    completed:true,due:'2099-01-03'},account,admin))(),e=>e.details.reason==='occurrence_not_started');
  assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(id),before);assert.equal(earnings(id).length,0);
});

test('future start gate follows supervised/delegated helper mappings and mixed remaining scope',()=>{
  const a=member(),root=task(a),child=task(a,0,root),skill=Number(d.prepare("INSERT INTO skills(name,created_by,minimum_age,age_promotion) VALUES('Washer',?,0,'normal')").run(admin).lastInsertRowid);
  setTaskSkills(d,child,[skill]);
  for(const [uid,value] of [[a,'excluded'],[admin,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,?,'manual')").run(uid,skill,value);
  const view=reconcileTaskSupervision(d,root);assert.ok(view.support_task_id);const counterpart=view.actions.find(r=>r.action_task_id===child).counterpart_task_id;
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2099-01-03' WHERE id=?").run(root);
  for(const id of [child,counterpart,view.support_task_id])assert.throws(()=>transition(id,'done',admin,{complete_remaining:true}),e=>e.details.reason==='occurrence_not_started');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');assert.equal(earnings(root).length,0);
});

test('recurrence gets a fresh independent award only when the next occurrence start date arrives',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-18T16:00:00Z')});
  const a=member(),root=task(a);d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2026-09-18',due_date='2026-09-18' WHERE id=?").run(root);
  transition(root,'done');const next=d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=?').get(root);
  assert.equal(next.start_date,'2026-09-25');assert.throws(()=>transition(next.id,'done'),e=>e.details.reason==='occurrence_not_started');
  assert.equal(getBalance(d,a),5);
  t.mock.timers.setTime(new Date('2026-09-25T16:00:00Z').getTime());transition(next.id,'done');
  assert.equal(earnings(root).length,1);assert.equal(earnings(next.id).length,1);assert.equal(getBalance(d,a),10);
});

test('nonrecurring future Tasks retain their existing completion policy',()=>{
  const id=task(admin,0);d.prepare("UPDATE tasks SET start_date='2099-01-03' WHERE id=?").run(id);
  assert.doesNotThrow(()=>transition(id,'done'));
});

test('Rewards-only live stream reconnects with current revision, exposes no content and closes on logout or permission revocation',async()=>{
  const a=member(),sid=randomUUID();
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  const session=()=>d.prepare('INSERT OR REPLACE INTO sessions(sid,sess,expired_at) VALUES(?,?,?)').run(sid,JSON.stringify({userId:a}),Date.now()+60000);
  const deny=module=>d.prepare("INSERT OR REPLACE INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user',?,'module',?,'none')").run(String(a),module);
  session();deny('tasks');
  const open=async()=>{const controller=new AbortController(),res=await fetch(base+'/rewards/changes',{
    headers:{'x-user':String(a),'x-session':sid},signal:controller.signal});
    assert.equal(res.status,200);const reader=res.body.getReader(),decode=new TextDecoder();
    return {controller,reader,read:async()=>{const item=await reader.read();return item.done?null:decode.decode(item.value);}};};
  let stream=await open();const initial=await stream.read();assert.match(initial,/event: change/);
  postLedger(d,{userId:a,delta:4,type:'bonus',reason:'Private reward reason must not enter the stream'});
  const changed=await stream.read();assert.match(changed,/event: change/);assert.doesNotMatch(changed,/Private|user_id|delta|reason/);
  assert.ok(JSON.parse(changed.match(/data: (.+)/)[1]).version>JSON.parse(initial.match(/data: (.+)/)[1]).version);
  stream.controller.abort();await stream.reader.cancel().catch(()=>{});
  stream=await open();assert.match(await stream.read(),/event: change/);
  d.prepare('DELETE FROM sessions WHERE sid=?').run(sid);assert.equal(await stream.read(),null);
  assert.equal((await call('GET','/rewards/changes',undefined,{actor:a,session:sid})).status,403);
  session();stream=await open();await stream.read();deny('rewards');assert.equal(await stream.read(),null);
  assert.equal((await call('GET','/rewards/changes',undefined,{actor:a,session:sid})).status,403);
});
