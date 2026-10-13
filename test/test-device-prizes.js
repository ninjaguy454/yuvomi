import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='synthetic-device-prizes';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {deviceAppMiddleware}=await import('../server/services/device-app.js');
const {createDevice,devicePreset,devicePrincipal,deviceHash,readDeviceContext,updateDevice}=await import('../server/services/devices.js');
const {getBalance}=await import('../server/services/rewards.js');
const {undoPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
let d,server,origin,device,token,context;
test.beforeEach(async()=>{
 d=new Database(':memory:');d.pragma('foreign_keys=ON');
 for(const migration of ALL_MIGRATIONS){if(migration.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d)})();if(migration.foreignKeysOff)d.pragma('foreign_keys=ON');}
 _setTestDatabase(d);
 d.exec(`INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES
 (1,'parent','Parent','x','admin','dad'),(2,'allowed','Allowed child','x','member','child'),
 (3,'outside','PRIVATE outside member','x','member','child'),(4,'mother','Mother','x','member','mom'),(5,'inactive','Inactive child','x','member','child');
 INSERT INTO reward_participants(user_id,enabled) VALUES(2,1),(3,1),(5,0);
 INSERT INTO reward_catalog(id,name,cost,is_active) VALUES(1,'Family prize',10,1),(2,'Retired prize',1,0);
 INSERT INTO reward_ledger(user_id,delta,type,reason,created_by) VALUES(2,30,'bonus','PRIVATE ledger explanation',1),(3,99,'bonus','PRIVATE outside balance',1);`);
 const permissions=devicePreset();permissions.capabilities['device_rewards.redeem']='allow';permissions.prize_redemption_mode='trusted_display';
 device=createDevice(d,{name:'Synthetic display',permissions,scope:{member_ids:[2,5],show_points:true}},1);
 token='synthetic-device-prize-token';context='synthetic-device-prize-context';
 d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),context);
 const app=express();app.use(express.json());app.use((req,res,next)=>{
  try{req.sessionID='synthetic-device-prize-session';req.session={};req.deviceContext=readDeviceContext(d,req);req.devicePrincipal=devicePrincipal(req.deviceContext.device);next();}
  catch(error){res.status(error.status||500).json({error:error.message,reason:error.reason});}
 });
 app.use('/api/v1',deviceAppMiddleware);app.use((_req,res)=>res.json({PRIVATE_HUMAN_FALLTHROUGH:true}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin=`http://127.0.0.1:${server.address().port}/api/v1`;
});
test.afterEach(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));_setTestDatabase(null);d.close();});
const body=()=>({catalog_id:1,user_id:2,expected_cost:10});
async function call(path,method='GET',value,key){const response=await fetch(origin+path,{method,headers:{Cookie:`vidamia.device=${token}`,'X-Auth-Context':context,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(value?{body:JSON.stringify(value)}:{})});return {status:response.status,data:await response.json()};}
const purchased=()=>d.prepare("SELECT count(*) n FROM reward_ledger WHERE type='redeem'").get().n;
const delivery=id=>d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id=?').get(id);

test('old and new device settings require explicit enablement and default to member authentication',()=>{
 const preset=devicePreset();assert.equal(preset.capabilities['device_rewards.redeem'],'none');assert.equal(preset.prize_redemption_mode,'member_signin');
 assert.throws(()=>createDevice(d,{name:'Bad mode',permissions:{...preset,prize_redemption_mode:'anonymous'}},1),/sign-in/);
});

test('enabled device options expose only scoped enrolled members and permitted balances, never private history',async()=>{
 const result=await call('/rewards/device-options');assert.equal(result.status,200,JSON.stringify(result.data));
 assert.equal(result.data.data.mode,'trusted_display');assert.equal(result.data.data.device_revision,device.revision);
 assert.deepEqual(result.data.data.members.map(member=>member.id),[2]);assert.equal(result.data.data.members[0].balance,30);
 assert.deepEqual(result.data.data.catalog.map(item=>item.id),[1]);
 assert.ok(!JSON.stringify(result.data).includes('PRIVATE'));assert.equal(purchased(),0);
});
test('point visibility off omits balances and affordability hints while retaining safe member choice',async()=>{
 const changed=updateDevice(d,device.id,{revision:device.revision,scope:{show_points:false}},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 const result=await call('/rewards/device-options');assert.equal(result.status,200,JSON.stringify(result.data));
 const member=result.data.data.members[0];assert.equal(member.id,2);assert.ok(!('balance' in member));assert.ok(!('can_afford' in member));
 assert.equal(result.data.data.device_revision,changed.revision);assert.ok(!JSON.stringify(result.data).includes('PRIVATE'));
});
test('trusted purchase has device provenance, one debit and one private zero-point parent delivery',async()=>{
 const result=await call('/rewards/redemptions','POST',body(),randomUUID());assert.equal(result.status,201,JSON.stringify(result.data));
 const id=result.data.data.id;assert.equal(getBalance(d,2),20);assert.equal(purchased(),1);
 assert.equal(d.prepare('SELECT requested_by FROM reward_redemptions WHERE id=?').get(id).requested_by,null);
 assert.equal(d.prepare("SELECT created_by FROM reward_ledger WHERE redemption_id=? AND type='redeem'").get(id).created_by,null);
 const task=delivery(id);assert.ok(task);assert.equal(task.points,0);assert.equal(task.visibility,'assignees');assert.equal(task.created_by,null);
 assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(row=>row.user_id),[1,4]);
 assert.equal((await call(`/tasks/${task.id}`)).status,404);assert.ok(!('fulfillment_task_id' in result.data.data));
 assert.equal(d.prepare('SELECT device_id,authenticated_user_id FROM device_prize_redemption_requests WHERE redemption_id=?').get(id).device_id,device.id);
 assert.equal(d.prepare('SELECT authenticated_user_id FROM device_prize_redemption_requests WHERE redemption_id=?').get(id).authenticated_user_id,null);
});
test('duplicate taps and replay after parent Undo retain the same purchase with exactly one refund',async()=>{
 const key=randomUUID(),[first,second]=await Promise.all([call('/rewards/redemptions','POST',body(),key),call('/rewards/redemptions','POST',body(),key)]);
 assert.deepEqual([first.status,second.status].sort(),[200,201]);assert.equal(first.data.data.id,second.data.data.id);
 assert.equal(getBalance(d,2),20);assert.equal(purchased(),1);const id=first.data.data.id,task=delivery(id);
 assert.equal(d.prepare('SELECT count(*) n FROM notification_inbox WHERE entity_id=? AND entity_type=\'task\'').get(task.id).n,2);
 const conflict=await call('/rewards/redemptions','POST',{...body(),note:'Different intent'},key);assert.equal(conflict.status,409);
 undoPrizeRedemption(d,{actorId:1,redemptionId:id,requestKey:randomUUID(),expectedStatus:'pending'});
 assert.equal(getBalance(d,2),30);const replay=await call('/rewards/redemptions','POST',body(),key);assert.equal(replay.status,200);
 assert.equal(replay.data.data.id,id);assert.equal(purchased(),1);assert.equal(d.prepare("SELECT count(*) n FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(id).n,1);
});
test('disabled grant, out-of-scope recipient and unverified member-sign-in mode cannot debit points',async()=>{
 assert.equal((await call('/rewards/redemptions','POST',{...body(),user_id:3},randomUUID())).status,403);
 const permissions={...device.permissions,prize_redemption_mode:'member_signin'};updateDevice(d,device.id,{revision:device.revision,permissions},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 const denied=await call('/rewards/redemptions','POST',body(),randomUUID());assert.equal(denied.status,409);assert.equal(denied.data.reason,'member_signin_required');
 const current=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(device.id);
 permissions.capabilities['device_rewards.redeem']='none';updateDevice(d,device.id,{revision:current.revision,permissions},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 assert.equal((await call('/rewards/device-options')).status,403);assert.equal((await call('/rewards/redemptions','POST',body(),randomUUID())).status,403);
 assert.equal(getBalance(d,2),30);assert.equal(purchased(),0);
});
test('insufficient points, stale price, missing key and forged actor leave no partial purchase',async()=>{
 assert.equal((await call('/rewards/redemptions','POST',{...body(),expected_cost:9},randomUUID())).status,409);
 assert.equal((await call('/rewards/redemptions','POST',body())).status,428);
 assert.equal((await call('/rewards/redemptions','POST',{...body(),authenticatedUserId:2},randomUUID())).status,400);
 d.prepare('UPDATE reward_ledger SET delta=5 WHERE user_id=2').run();
 assert.equal((await call('/rewards/redemptions','POST',body(),randomUUID())).status,400);
 assert.equal(getBalance(d,2),5);assert.equal(purchased(),0);assert.equal(d.prepare('SELECT count(*) n FROM reward_redemptions').get().n,0);
});
test('lost device context and missing eligible parent roll back without consuming the key',async()=>{
 const key=randomUUID();d.prepare("UPDATE users SET family_role='relative' WHERE id IN (1,4)").run();
 const rejected=await call('/rewards/redemptions','POST',body(),key);assert.equal(rejected.status,409);assert.equal(rejected.data.reason,'no_eligible_parent');assert.equal(purchased(),0);
 d.prepare("UPDATE users SET family_role='dad' WHERE id=1").run();d.prepare("UPDATE users SET family_role='mom' WHERE id=4").run();
 const current=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(device.id);updateDevice(d,device.id,{revision:current.revision,name:'Renamed display'},1);
 const stale=await call('/rewards/redemptions','POST',body(),key);assert.equal(stale.status,409);assert.equal(stale.data.reason,'device_context_changed');assert.equal(purchased(),0);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 assert.equal((await call('/rewards/redemptions','POST',body(),key)).status,201);assert.equal(purchased(),1);
});

test('replay preserves the charged snapshot through repricing and catalog deletion and rechecks scope before disclosure',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',body(),key);assert.equal(first.status,201);
 d.prepare('UPDATE reward_catalog SET cost=99 WHERE id=1').run();
 const repriced=await call('/rewards/redemptions','POST',body(),key);assert.equal(repriced.status,200);assert.equal(repriced.data.data.cost,10);
 d.prepare('DELETE FROM reward_catalog WHERE id=1').run();
 const deleted=await call('/rewards/redemptions','POST',body(),key);assert.equal(deleted.status,200);assert.equal(deleted.data.data.id,first.data.data.id);assert.equal(purchased(),1);
 updateDevice(d,device.id,{revision:device.revision,scope:{member_ids:[5]}},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 const denied=await call('/rewards/redemptions','POST',body(),key);assert.equal(denied.status,403);assert.ok(!('data' in denied.data));assert.equal(purchased(),1);
});
test('a deleted purchase remains a durable tombstone and cannot turn a retry into another debit',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',body(),key);assert.equal(first.status,201);
 d.prepare('DELETE FROM reward_redemptions WHERE id=?').run(first.data.data.id);
 const replay=await call('/rewards/redemptions','POST',body(),key);assert.equal(replay.status,410);assert.equal(purchased(),1);
 assert.equal(d.prepare('SELECT redemption_id FROM device_prize_redemption_requests WHERE request_key=?').get(key).redemption_id,null);
});
test('a notification failure rolls back debit, request claim and delivery then a retry succeeds once',async()=>{
 d.exec("CREATE TRIGGER synthetic_notification_failure BEFORE INSERT ON notification_inbox BEGIN SELECT RAISE(ABORT,'synthetic notification failure'); END;");
 const key=randomUUID(),failed=await call('/rewards/redemptions','POST',body(),key);assert.equal(failed.status,500);assert.equal(purchased(),0);assert.equal(getBalance(d,2),30);
 assert.equal(d.prepare('SELECT count(*) n FROM device_prize_redemption_requests').get().n,0);assert.equal(d.prepare('SELECT count(*) n FROM reward_fulfillment_task_links').get().n,0);
 d.exec('DROP TRIGGER synthetic_notification_failure');assert.equal((await call('/rewards/redemptions','POST',body(),key)).status,201);assert.equal(purchased(),1);
});
test('competing deliberate requests cannot overdraw the same remaining balance',async()=>{
 d.prepare('UPDATE reward_ledger SET delta=15 WHERE user_id=2').run();
 const responses=await Promise.all([call('/rewards/redemptions','POST',body(),randomUUID()),call('/rewards/redemptions','POST',body(),randomUUID())]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,400]);assert.equal(getBalance(d,2),5);assert.equal(purchased(),1);
 assert.equal(responses.find(r=>r.status===400).data.reason,'insufficient_points');
});
test('safe abandonment tombstones only an unpurchased intent and forbids a delayed purchase on its old key',async()=>{
 const key=randomUUID();d.prepare('UPDATE reward_ledger SET delta=5 WHERE user_id=2').run();
 assert.equal((await call('/rewards/redemptions','POST',body(),key)).status,400);
 const abandoned=await call('/device/rewards/request/abandon','POST',body(),key);assert.equal(abandoned.status,200,JSON.stringify(abandoned.data));assert.equal(abandoned.data.abandoned,true);
 assert.equal((await call('/device/rewards/request/abandon','POST',body(),key)).status,200);
 d.prepare('UPDATE reward_ledger SET delta=30 WHERE user_id=2').run();
 const delayed=await call('/rewards/redemptions','POST',body(),key);assert.equal(delayed.status,410);assert.equal(delayed.data.reason,'device_prize_abandoned');assert.equal(purchased(),0);
 assert.equal((await call('/rewards/redemptions','POST',body(),randomUUID())).status,201);assert.equal(purchased(),1);
});
test('abandon racing a committed purchase refuses to hide its durable receipt or debit again',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',body(),key);assert.equal(first.status,201);
 const cancelled=await call('/device/rewards/request/abandon','POST',body(),key);assert.equal(cancelled.status,409);assert.equal(cancelled.data.reason,'device_prize_already_recorded');assert.ok(!('data' in cancelled.data));
 const replay=await call('/rewards/redemptions','POST',body(),key);assert.equal(replay.status,200);assert.equal(replay.data.data.id,first.data.data.id);assert.equal(purchased(),1);assert.equal(getBalance(d,2),20);
});
test('abandon permits no-purchase cleanup in sign-in mode without exposing or discarding a receipt',async()=>{
 updateDevice(d,device.id,{revision:device.revision,permissions:{...device.permissions,prize_redemption_mode:'member_signin'}},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 const key=randomUUID(),stale={...body(),expected_cost:9};
 assert.equal((await call('/device/rewards/request/abandon','POST',stale,key)).status,200);
 const forbidden=await call('/rewards/redemptions','POST',stale,key);assert.equal(forbidden.status,410);assert.equal(forbidden.data.reason,'device_prize_abandoned');assert.equal(purchased(),0);
 const scope=await call('/device/rewards/request/abandon','POST',{...body(),user_id:3},randomUUID());assert.equal(scope.status,403);
 const current=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(device.id);
 updateDevice(d,device.id,{revision:current.revision,permissions:{capabilities:{'device_rewards.redeem':'none'}}},1);
 context=d.prepare('SELECT context_key FROM device_credentials WHERE device_id=?').get(device.id).context_key;
 assert.equal((await call('/device/rewards/request/abandon','POST',body(),randomUUID())).status,403);
 assert.equal(purchased(),0);assert.equal(d.prepare('SELECT count(*) n FROM device_prize_redemption_requests').get().n,1);
});
test('independent SQLite writers share one device receipt, debit, delivery and notification set',{timeout:20000},async()=>{
 const folder=mkdtempSync(join(tmpdir(),'device-prize-writers-')),filename=join(folder,'synthetic.db'),key=randomUUID();
 writeFileSync(filename,d.serialize());const workers=[];
 try {
   const work=()=>new Promise((resolve,reject)=>{
     const worker=new Worker(new URL('./helpers/device-prize-race-worker.mjs',import.meta.url),{workerData:{filename,key,token,context}});workers.push(worker);
     worker.once('error',reject);worker.on('message',message=>{if(message.ready){worker.ready=true;if(workers.length===2&&workers.every(item=>item.ready))workers.forEach(item=>item.postMessage('purchase'));}else resolve(message);});
     worker.once('exit',code=>{if(code)reject(new Error(`Synthetic writer exited ${code}`));});
   });
   const outcomes=await Promise.all([work(),work()]);assert.ok(outcomes.every(result=>result.ok),JSON.stringify(outcomes));
   assert.equal(outcomes[0].result.data.id,outcomes[1].result.data.id);assert.deepEqual(outcomes.map(result=>result.result.replayed).sort(),[false,true]);
   const copy=new Database(filename);try{
     assert.equal(getBalance(copy,2),20);assert.equal(copy.prepare("SELECT count(*) n FROM reward_ledger WHERE type='redeem'").get().n,1);
     assert.equal(copy.prepare('SELECT count(*) n FROM device_prize_redemption_requests').get().n,1);assert.equal(copy.prepare('SELECT count(*) n FROM reward_fulfillment_task_links').get().n,1);
     assert.equal(copy.prepare("SELECT count(*) n FROM notification_inbox WHERE entity_type='task'").get().n,2);
   }finally{copy.close();}
 }finally{await Promise.all(workers.map(worker=>worker.terminate()));rmSync(folder,{recursive:true,force:true});}
});
