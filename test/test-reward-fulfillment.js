import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-prize-fulfillment';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {default:rewardsRouter}=await import('../server/routes/rewards.js');
const {getBalance,postLedger,createRedemption}=await import('../server/services/rewards.js');
const {isNotificationDeliveryCurrent}=await import('../server/services/notification-events.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
_setTestDatabase(d);
let sequence=0;
const person=(familyRole,role='member')=>Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
  VALUES(?,?,'x',?,?)`).run(`prize-${++sequence}`,`Synthetic ${sequence}`,role,familyRole).lastInsertRowid);
const dad=person('dad','admin'),mom=person('mom'),adult=person('relative');
function purchaseFixture(points=30){const child=person('child');d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(child);
  postLedger(d,{userId:child,delta:points,type:'bonus'});
  const catalog=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic movie',10)").run().lastInsertRowid);
  return {child,catalog,key:randomUUID()};}
const app=express();app.use(express.json());
app.use((req,res,next)=>{const id=Number(req.get('x-user')||dad),user=d.prepare('SELECT role FROM users WHERE id=?').get(id);
  req.authUserId=id;req.authRole=user?.role;req.authMethod='session';req.session={userId:id};
  if(req.get('x-scopes'))req.authScopes=JSON.parse(req.get('x-scopes'));next();});
app.use('/rewards',rewardsRouter);app.use('/tasks',tasksRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function call(method,path,body,{actor=dad,key,scopes}={}){const response=await fetch(origin+path,{method,
  headers:{'Content-Type':'application/json','x-user':String(actor),...(key?{'Idempotency-Key':key}:{}),...(scopes?{'x-scopes':JSON.stringify(scopes)}:{})},
  body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:response.headers.get('Content-Type')?.includes('json')?await response.json():{error:await response.text()},replayed:response.headers.get('Idempotent-Replayed')};}
async function redeem(f){return call('POST','/rewards/redemptions',{catalog_id:f.catalog},{actor:f.child,key:f.key});}
const linkedTask=redemption=>d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id=?').get(redemption);
test.after(()=>{server.closeAllConnections();server.close();_setTestDatabase(null);d.close();});

test('child purchase atomically spends once and creates one private zero-point Task for both parents',async()=>{
  const f=purchaseFixture(),before=d.prepare('SELECT COUNT(*) n FROM tasks').get().n,result=await redeem(f);
  assert.equal(result.status,201);assert.equal(result.body.data.status,'pending');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before+1,'The purchase must create the parent delivery Task');
  const task=linkedTask(result.body.data.id);
  assert.equal(task.points,0);assert.equal(task.visibility,'assignees');assert.equal(task.created_by,null);
  assert.equal(task.parent_task_id,null);assert.equal(task.is_recurring,0);
  assert.equal(task.target_caldav_account_id,null);assert.equal(task.target_caldav_list_url,null);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(r=>r.user_id),[dad,mom]);
  assert.equal(getBalance(d,f.child),20);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='redeem'").get(result.body.data.id).n,1);
  assert.equal((await call('GET',`/tasks/${task.id}`,undefined,{actor:f.child})).status,404);
  const replay=await redeem(f);assert.equal(replay.status,200);assert.equal(replay.body.data.id,result.body.data.id);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before+1);assert.equal(getBalance(d,f.child),20);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE entity_type='task' AND entity_id=?").get(task.id).n,2);
});

test('no eligible parent rolls back the debit and durable purchase receipt',async()=>{
  const f=purchaseFixture();d.prepare("UPDATE users SET family_role='other' WHERE id IN (?,?)").run(dad,mom);
  try{const result=await redeem(f);assert.equal(result.status,409);assert.equal(result.body.reason,'no_eligible_parent');
    assert.equal(getBalance(d,f.child),30);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemptions WHERE user_id=?').get(f.child).n,0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemption_requests WHERE actor_user_id=?').get(f.child).n,0);
  }finally{d.prepare("UPDATE users SET family_role='dad' WHERE id=?").run(dad);d.prepare("UPDATE users SET family_role='mom' WHERE id=?").run(mom);}
});

test('notification insertion failure rolls back the entire purchase and Task',async()=>{
  const f=purchaseFixture(),before=d.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  d.exec("CREATE TEMP TRIGGER reject_prize_notification BEFORE INSERT ON notification_inbox BEGIN SELECT RAISE(ABORT,'synthetic notification failure'); END");
  try{assert.equal((await redeem(f)).status,500);assert.equal(getBalance(d,f.child),30);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemptions WHERE user_id=?').get(f.child).n,0);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemption_requests WHERE actor_user_id=?').get(f.child).n,0);
  }finally{d.exec('DROP TRIGGER reject_prize_notification');}
});

test('old human receipt replays without creating historical delivery work after catalog/enrollment changes',async()=>{
  const f=purchaseFixture(),old=createRedemption(d,{actorId:f.child,userId:f.child,catalogId:f.catalog,requestKey:f.key});
  d.prepare('DELETE FROM reward_catalog WHERE id=?').run(f.catalog);
  d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=?').run(f.child);
  const before=d.prepare('SELECT COUNT(*) n FROM tasks').get().n,result=await redeem(f);
  assert.equal(result.status,200);assert.equal(result.body.data.id,old.row.id);assert.equal(linkedTask(old.row.id),undefined);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);assert.equal(getBalance(d,f.child),20);
});

test('queued parent requests stop being current after fulfillment or pending Undo',async()=>{
  for(const action of ['fulfill','undo']){
    const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
    const receipts=d.prepare("SELECT * FROM notification_inbox WHERE entity_type='task' AND entity_id=?").all(task.id);
    assert.equal(receipts.length,2);assert.ok(receipts.every(r=>isNotificationDeliveryCurrent(d,r)));
    if(action==='fulfill')assert.equal((await call('PATCH',`/rewards/redemptions/${id}`,{action:'fulfill'},{actor:mom})).status,200);
    else assert.equal((await call('POST',`/rewards/redemptions/${id}/undo`,{request_id:randomUUID(),expected_status:'pending'},{actor:mom})).status,200);
    assert.ok(receipts.every(r=>!isNotificationDeliveryCurrent(d,r)));
  }
});

test('raw parent Task explicitly chooses Whole Task scoring with incoming legacy-default schema',async()=>{
  if(!d.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='scoring_mode'))
    d.exec("ALTER TABLE tasks ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'legacy'; ALTER TABLE tasks ADD COLUMN scoring_review_required INTEGER NOT NULL DEFAULT 0");
  const f=purchaseFixture(),result=await redeem(f),task=linkedTask(result.body.data.id);
  assert.equal(task.scoring_mode,'whole_task');assert.equal(task.scoring_review_required,0);assert.equal(task.points,0);
});

const complete=task=>({status:'done',expected_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(task.id).revision});
test('either assigned parent completes delivery atomically without earning points',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,complete(task),{actor:mom})).status,200);
  assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(id).status,'fulfilled');
  assert.equal(d.prepare('SELECT decided_by FROM reward_redemptions WHERE id=?').get(id).decided_by,mom);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(task.id).n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(task.id).n,1);
});

test('Fulfill from the redemption record closes the same Task',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  assert.equal((await call('PATCH',`/rewards/redemptions/${id}`,{action:'fulfill'},{actor:mom})).status,200);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'done');
  assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(id).status,'fulfilled');
});

test('an assigned parent can retry consistent done delivery without another completion or reward',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,{status:'done',expected_revision:task.revision},{actor:mom})).status,200);
  const done=d.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  const completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id);
  const replay=await call('PATCH',`/tasks/${task.id}/status`,{status:'done',expected_revision:done.revision},{actor:mom});
  assert.equal(replay.status,200);assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id),completion);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(task.id).n,0);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,{status:'open',expected_revision:done.revision},{actor:mom})).status,409);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,{status:'done',expected_revision:done.revision},{actor:mom,scopes:['tasks:write','rewards:read']})).status,403);
});

test('linked Task cannot gain points, detach, be deleted, or receive child steps',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),task=linkedTask(purchase.body.data.id);
  for(const fields of [{points:5},{assigned_to:[f.child]},{is_recurring:1,recurrence_rule:'FREQ=DAILY'}])
    assert.equal((await call('PUT',`/tasks/${task.id}`,{...fields,expected_revision:task.revision},{actor:dad})).status,409);
  assert.equal((await call('DELETE',`/tasks/${task.id}`,undefined,{actor:dad})).status,409);
  assert.equal((await call('POST','/tasks',{title:'Cannot attach',parent_task_id:task.id},{actor:dad})).status,409);
});

const undoBody=(status='pending',extra={})=>({expected_status:status,reason:'Accidental redemption',...extra});
const undo=(id,body=undoBody(),options={})=>call('POST',`/rewards/redemptions/${id}/undo`,body,{key:randomUUID(),...options});
test('parent Undo refunds once and cancels unfinished delivery without recording completion',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id),key=randomUUID();
  const result=await undo(id,undoBody(),{actor:mom,key});assert.equal(result.status,200);assert.equal(getBalance(d,f.child),30);
  assert.equal(result.body.data.display_status,'undone');assert.equal(result.body.data.undo.prior_status,'pending');
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(task.id).archived_at);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(task.id).n,0);
  assert.equal((await undo(id,undoBody(),{actor:mom,key})).status,200);
  assert.equal((await undo(id,undoBody(),{actor:dad})).status,200);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemption_undos WHERE redemption_id=?').get(id).n,1);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='redemption_undone'").get(task.id).n,1);
});

test('delivered Undo requires stronger confirmation and preserves the recorded delivery Task',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  await call('PATCH',`/tasks/${task.id}/status`,complete(task),{actor:dad});
  const completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id);
  assert.equal((await undo(id,undoBody('fulfilled'),{actor:mom})).status,409);assert.equal(getBalance(d,f.child),20);
  const result=await undo(id,undoBody('fulfilled',{confirm_delivered:true}),{actor:mom});assert.equal(result.status,200);
  assert.equal(result.body.data.undo.prior_status,'fulfilled');assert.equal(result.body.data.undo.prior_decided_by,dad);
  assert.equal(getBalance(d,f.child),30);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'done');
  assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(task.id),completion);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,{status:'open',reset_progress:true,expected_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(task.id).revision},{actor:dad})).status,409);
});

test('Undo forbids child/generic adult/read-only token and revalidates a parent role',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id;
  for(const actor of [f.child,adult])assert.equal((await undo(id,undoBody(),{actor})).status,403);
  assert.equal((await undo(id,undoBody(),{actor:mom,scopes:['rewards:read']})).status,403);
  d.prepare("UPDATE users SET family_role='relative' WHERE id=?").run(mom);
  try{assert.equal((await undo(id,undoBody(),{actor:mom})).status,403);}finally{d.prepare("UPDATE users SET family_role='mom' WHERE id=?").run(mom);}
  assert.equal(getBalance(d,f.child),20);
});

test('a confirmation made while pending cannot silently undo a delivered prize',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  await call('PATCH',`/tasks/${task.id}/status`,complete(task),{actor:dad});
  assert.equal((await undo(id,undoBody('pending',{confirm_delivered:true}),{actor:mom})).status,409);
  assert.equal(getBalance(d,f.child),20);
});

test('record reads expose parent actions while keeping the private Task link out of child/admin-only views',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  const records=async actor=>(await call('GET','/rewards/redemptions',undefined,{actor})).body.data.find(r=>r.id===id);
  const parent=await records(mom);assert.equal(parent.can_fulfill,true);assert.equal(parent.can_undo,true);assert.equal(parent.fulfillment_task_id,task.id);
  const child=await records(f.child);assert.equal(child.can_undo,false);assert.equal(child.fulfillment_task_id,undefined);
  const otherAdmin=person('other','admin'),adminRecord=await records(otherAdmin);
  assert.equal(adminRecord.can_undo,true);assert.equal(adminRecord.fulfillment_task_id,undefined);
  const result=await undo(id,undoBody(),{actor:otherAdmin});assert.equal(result.status,200);assert.equal(result.body.data.fulfillment_task_id,undefined);
});

test('hidden delivery Task mutation does not disclose its existence to a child',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),task=linkedTask(purchase.body.data.id);
  assert.equal((await call('PATCH',`/tasks/${task.id}/status`,complete(task),{actor:f.child})).status,404);
  assert.equal((await call('POST','/tasks',{title:'Cannot probe',parent_task_id:task.id},{actor:f.child})).status,404);
});

test('a device principal cannot impersonate a parent by reusing a human numeric ID',async()=>{
  const {undoPrizeRedemption,decideParentPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id;
  const device={kind:'device',id:dad,permissions:{modules:{tasks:'read',rewards:'read'},capabilities:{'device_tasks.complete':'allow'}}};
  assert.throws(()=>undoPrizeRedemption(d,{actorId:dad,principal:device,redemptionId:id,requestKey:randomUUID(),expectedStatus:'pending'}),e=>e.status===403);
  assert.throws(()=>decideParentPrizeRedemption(d,{actorId:dad,principal:device,redemptionId:id,action:'fulfill'}),e=>e.status===403);
  assert.equal(getBalance(d,f.child),20);
});

test('Undo request conflicts cannot change intent or produce another refund',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,key=randomUUID();
  assert.equal((await undo(id,undoBody(),{actor:mom,key})).status,200);
  assert.equal((await undo(id,undoBody('pending',{reason:'Different explanation'}),{actor:mom,key})).status,409);
  assert.equal(getBalance(d,f.child),30);
});

test('linked owner cancellation closes unfinished work and rejected records cannot refund twice',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  assert.equal((await call('PATCH',`/rewards/redemptions/${id}`,{action:'cancel'},{actor:f.child})).status,200);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(task.id).archived_at);
  assert.equal((await undo(id,undoBody(),{actor:mom})).body.outcome,'already_refunded');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,1);
});

test('a failing Task completion rolls back its linked fulfillment decision',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  d.exec(`CREATE TEMP TRIGGER reject_prize_completion BEFORE INSERT ON task_completions WHEN NEW.task_id=${task.id}
    BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END`);
  try{assert.equal((await call('PATCH',`/tasks/${task.id}/status`,complete(task),{actor:mom})).status,500);
    assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(id).status,'pending');
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'open');
  }finally{d.exec('DROP TRIGGER reject_prize_completion');}
});

test('Undo detects malformed historical debits instead of manufacturing points',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id;
  d.prepare("UPDATE reward_ledger SET delta=-7 WHERE redemption_id=? AND type='redeem'").run(id);
  const before=getBalance(d,f.child),result=await undo(id,undoBody(),{actor:mom});
  assert.equal(result.status,409);assert.equal(result.body.reason,'redemption_ledger_inconsistent');assert.equal(getBalance(d,f.child),before);
});

test('history is paginated and a child receives only their own redemption records',async()=>{
  const f=purchaseFixture(),insert=d.prepare("INSERT INTO reward_redemptions(user_id,reward_name,cost,status) VALUES(?,'Synthetic historical prize',10,'fulfilled')");
  for(let index=0;index<301;index++)insert.run(f.child);
  const first=await call('GET','/rewards/redemptions?history=1',undefined,{actor:f.child});
  assert.equal(first.status,200);assert.equal(first.body.data.length,300);assert.ok(first.body.data.every(row=>row.user_id===f.child));
  assert.ok(Number.isInteger(first.body.next_cursor));
  const last=await call('GET',`/rewards/redemptions?history=1&before_id=${first.body.next_cursor}`,undefined,{actor:f.child});
  assert.equal(last.body.data.length,1);assert.equal(last.body.next_cursor,null);
});

async function race(operations,check) {
  const folder=mkdtempSync(join(tmpdir(),'vidamia-prize-race-')),path=join(folder,'synthetic.db'),gate=new SharedArrayBuffer(4);
  await d.backup(path);const workers=[];
  try {
    const jobs=operations.map(operation=>{
      const worker=new Worker(new URL('./reward-fulfillment-worker.mjs',import.meta.url),{workerData:{...operation,path,gate}});
      workers.push(worker);let readyResolve,resultResolve;
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;worker.once('error',reject);});
      const result=new Promise((resolve,reject)=>{resultResolve=resolve;worker.once('error',reject);});
      worker.on('message',message=>message.ready?readyResolve():resultResolve(message));
      return {ready,result};
    });
    await Promise.all(jobs.map(job=>job.ready));Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,workers.length);
    const results=await Promise.all(jobs.map(job=>job.result)),snapshot=new Database(path);
    try{check(snapshot,results);}finally{snapshot.close();}
  }finally{
    await Promise.all(workers.map(worker=>worker.terminate()));assert.equal(dirname(resolve(folder)),resolve(tmpdir()));
    rmSync(folder,{recursive:true,force:true});
  }
}

test('separate SQLite writers replay one purchase with exactly one Task, debit and notification per parent',async()=>{
  const f=purchaseFixture(),args={actorId:f.child,userId:f.child,catalogId:f.catalog,requestKey:f.key};
  await race(Array.from({length:3},()=>({kind:'purchase',args})),(snapshot,results)=>{
    assert.ok(results.every(r=>r.result));const id=results[0].result.row.id;
    assert.ok(results.every(r=>r.result.row.id===id));assert.equal(getBalance(snapshot,f.child),20);
    assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM reward_fulfillment_task_links WHERE redemption_id=?').get(id).n,1);
    assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='redeem'").get(id).n,1);
    const task=snapshot.prepare('SELECT task_id FROM reward_fulfillment_task_links WHERE redemption_id=?').get(id).task_id;
    assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE entity_type='task' AND entity_id=?").get(task).n,2);
  });
});

test('independent parents racing Undo append one reversal and one immutable audit event',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id;
  await race([dad,mom].map(actorId=>({kind:'undo',args:{actorId,redemptionId:id,requestKey:randomUUID(),expectedStatus:'pending'}})),(snapshot,results)=>{
    assert.ok(results.every(r=>r.result));assert.equal(getBalance(snapshot,f.child),30);
    assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,1);
    assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM reward_redemption_undos WHERE redemption_id=?').get(id).n,1);
    assert.throws(()=>snapshot.prepare("UPDATE reward_redemption_undos SET reason='rewrite' WHERE redemption_id=?").run(id),/immutable/);
  });
});

test('fulfillment racing pending-confirmed Undo has one winner and preserves the corresponding history',async()=>{
  const f=purchaseFixture(),purchase=await redeem(f),id=purchase.body.data.id,task=linkedTask(id);
  await race([{kind:'decision',args:{actorId:dad,redemptionId:id,action:'fulfill'}},
    {kind:'undo',args:{actorId:mom,redemptionId:id,requestKey:randomUUID(),expectedStatus:'pending'}}],(snapshot,results)=>{
    assert.equal(results.filter(r=>r.result).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
    const row=snapshot.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(id),work=snapshot.prepare('SELECT status,archived_at FROM tasks WHERE id=?').get(task.id);
    if(row.status==='fulfilled'){
      assert.equal(work.status,'done');assert.equal(getBalance(snapshot,f.child),20);
      assert.equal(snapshot.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,0);
      assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(task.id).n,1);
    }else{
      assert.equal(row.status,'cancelled');assert.equal(work.status,'open');assert.ok(work.archived_at);assert.equal(getBalance(snapshot,f.child),30);
      assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(task.id).n,0);
    }
  });
});

test('new child delivery stays pending when purchase approval is off',async()=>{
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('rewards_require_approval','0')").run();
  try{const f=purchaseFixture(),result=await redeem(f);
    assert.equal(result.status,201);assert.equal(result.body.data.status,'pending','Turning approval off cannot mark a physical prize delivered');
    assert.ok(linkedTask(result.body.data.id));
  }finally{d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('rewards_require_approval','1')").run();}
});
