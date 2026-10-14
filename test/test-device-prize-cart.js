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


test.beforeEach(()=>d.exec("INSERT INTO reward_catalog(id,name,cost,is_active) VALUES(3,'Second prize',5,1),(4,'Free prize',0,1)"));
const cart=()=>({user_id:2,items:[{catalog_id:1,quantity:2,expected_cost:10},{catalog_id:3,quantity:1,expected_cost:5}],expected_cost:25});
const counts=()=>Object.fromEntries(['reward_ledger','reward_redemptions','tasks','notification_inbox','device_prize_redemption_requests'].map(t=>[t,d.prepare('SELECT count(*) n FROM '+t).get().n]));

test('two independent SQLite writers commit the same cart once',{timeout:20000},async()=>{
 const folder=mkdtempSync(join(tmpdir(),'device-cart-writers-')),filename=join(folder,'synthetic.db'),key=randomUUID(),workers=[];
 writeFileSync(filename,d.serialize());
 try{
 const work=()=>new Promise((resolve,reject)=>{
 const worker=new Worker(new URL('./helpers/device-prize-race-worker.mjs',import.meta.url),{workerData:{filename,key,token,context,body:cart()}});workers.push(worker);
 worker.once('error',reject);worker.on('message',message=>{if(message.ready){worker.ready=true;if(workers.length===2&&workers.every(w=>w.ready))workers.forEach(w=>w.postMessage('purchase'));}else resolve(message);});
 worker.once('exit',code=>{if(code)reject(Error('Synthetic writer exited '+code));});
 });
 const results=await Promise.all([work(),work()]);assert.ok(results.every(r=>r.ok),JSON.stringify(results));assert.equal(results[0].result.data.id,results[1].result.data.id);assert.deepEqual(results.map(r=>r.result.replayed).sort(),[false,true]);
 const copy=new Database(filename);try{assert.equal(getBalance(copy,2),5);assert.equal(copy.prepare("SELECT count(*) n FROM reward_ledger WHERE type='redeem'").get().n,3);assert.equal(copy.prepare('SELECT count(*) n FROM device_prize_redemption_requests').get().n,4);assert.equal(copy.prepare('SELECT count(*) n FROM reward_fulfillment_task_links').get().n,3);assert.equal(copy.prepare('SELECT count(*) n FROM notification_inbox').get().n,6);}finally{copy.close();}
 }finally{await Promise.all(workers.map(w=>w.terminate()));rmSync(folder,{recursive:true,force:true});}
});

test('preclaimed deterministic unit key rejects the cart before any additional records',async()=>{
 const {normalizePrizeCart,cartUnits}=await import('../server/services/device-prize-cart.js'),key=randomUUID(),normalized=normalizePrizeCart(cart()),units=cartUnits(normalized,key,JSON.stringify(normalized));
 assert.equal((await call('/rewards/redemptions','POST',units[1].body,units[1].key)).status,201);
 d.prepare("INSERT INTO reward_ledger(user_id,delta,type) VALUES(2,10,'bonus')").run();
 const before=counts();const result=await call('/rewards/redemptions','POST',cart(),key);assert.equal(result.status,409);assert.equal(result.data.reason,'request_id_conflict');assert.deepEqual(counts(),before);
});

test('cart replay survives deletion of every catalog line without charging again',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',cart(),key);assert.equal(first.status,201);d.prepare('DELETE FROM reward_catalog').run();
 const before=counts(),replay=await call('/rewards/redemptions','POST',cart(),key);assert.equal(replay.status,200);assert.deepEqual(replay.data.data.items,first.data.data.items);assert.deepEqual(counts(),before);
});

test('one confirmed cart atomically creates three ordinary unit debits and private parent Tasks',async()=>{
 const key=randomUUID(),result=await call('/rewards/redemptions','POST',cart(),key);assert.equal(result.status,201,JSON.stringify(result.data));
 assert.equal(result.data.data.cost,25);assert.equal(result.data.data.unit_count,3);assert.equal(getBalance(d,2),5);assert.equal(purchased(),3);
 assert.deepEqual(result.data.data.items.map(i=>[i.catalog_id,i.quantity,i.unit_cost]),[[1,2,10],[3,1,5]]);
 const rows=d.prepare('SELECT * FROM reward_redemptions ORDER BY id').all();assert.deepEqual(rows.map(r=>r.cost),[10,10,5]);
 for(const row of rows){assert.equal(row.requested_by,null);const task=delivery(row.id);assert.equal(task.points,0);assert.equal(task.visibility,'assignees');assert.equal((await call('/tasks/'+task.id)).status,404);
 assert.equal(d.prepare('SELECT authenticated_user_id FROM device_prize_redemption_requests WHERE redemption_id=? AND request_key!=?').get(row.id,key).authenticated_user_id,null);}
 assert.equal(d.prepare('SELECT count(*) n FROM reward_fulfillment_task_links').get().n,3);assert.equal(d.prepare('SELECT count(*) n FROM notification_inbox').get().n,6);
 assert.ok(!JSON.stringify(result.data).includes('fulfillment_task_id'));
 const after=counts(),replay=await call('/rewards/redemptions','POST',cart(),key);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.deepEqual(counts(),after);assert.deepEqual(replay.data.data.items,result.data.data.items);
});

test('late changed price rejects the whole cart before any unit is debited',async()=>{
 const before=counts();d.prepare('UPDATE reward_catalog SET cost=6 WHERE id=3').run();const result=await call('/rewards/redemptions','POST',cart(),randomUUID());assert.equal(result.status,409);assert.equal(result.data.reason,'reward_price_changed');assert.deepEqual(counts(),before);assert.equal(getBalance(d,2),30);
});
test('an unavailable line rejects the whole cart with a fenceable definitive reason',async()=>{
 d.prepare('UPDATE reward_catalog SET is_active=0 WHERE id=3').run();const before=counts(),result=await call('/rewards/redemptions','POST',cart(),randomUUID());assert.equal(result.status,404);assert.equal(result.data.reason,'reward_unavailable');assert.deepEqual(counts(),before);
});
test('latest aggregate balance rejects a cart even if each single price is affordable',async()=>{
 d.prepare("INSERT INTO reward_ledger(user_id,delta,type,reason) VALUES(2,-15,'adjust','Synthetic external spend')").run();const before=counts(),result=await call('/rewards/redemptions','POST',cart(),randomUUID());assert.equal(result.status,400);assert.equal(result.data.reason,'insufficient_points');assert.deepEqual(counts(),before);
});
test('partial unit Undo and delivery are preserved in the original whole-cart replay after repricing',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',cart(),key);assert.equal(first.status,201);
 const ids=first.data.data.items.flatMap(i=>i.units.map(u=>u.id));undoPrizeRedemption(d,{actorId:1,redemptionId:ids[0],requestKey:randomUUID(),expectedStatus:'pending'});
 const {decideParentPrizeRedemption}=await import('../server/services/reward-fulfillment.js');decideParentPrizeRedemption(d,{actorId:1,redemptionId:ids[2],action:'fulfill'});
 d.prepare('UPDATE reward_catalog SET cost=99,is_active=0').run();const before=counts(),replay=await call('/rewards/redemptions','POST',cart(),key);assert.equal(replay.status,200);assert.equal(replay.data.data.cost,25);assert.equal(replay.data.balance,15);assert.deepEqual(replay.data.data.items.flatMap(i=>i.units.map(u=>u.status)),['cancelled','pending','fulfilled']);assert.deepEqual(counts(),before);
});
test('a notification failure on the third unit rolls back every earlier debit Task and receipt',async()=>{
 d.exec("CREATE TRIGGER synthetic_cart_notification_failure BEFORE INSERT ON notification_inbox WHEN (SELECT COUNT(*) FROM reward_redemptions)>=3 BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END");const before=counts(),result=await call('/rewards/redemptions','POST',cart(),randomUUID());assert.equal(result.status,500);assert.deepEqual(counts(),before);assert.equal(getBalance(d,2),30);
});
test('cart abandonment is idempotent and permanently fences an unpurchased body including after repricing',async()=>{
 const key=randomUUID();const abandoned=await call('/device/rewards/request/abandon','POST',cart(),key);assert.equal(abandoned.status,200);assert.equal(abandoned.data.abandoned,true);d.prepare('UPDATE reward_catalog SET cost=99').run();const retry=await call('/rewards/redemptions','POST',cart(),key);assert.equal(retry.status,410);assert.equal(retry.data.reason,'device_prize_abandoned');assert.equal(purchased(),0);
});
test('a committed cart cannot be abandoned or rebound to changed quantities',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',cart(),key);assert.equal(first.status,201);assert.equal((await call('/device/rewards/request/abandon','POST',cart(),key)).status,409);
 const changed=cart();changed.items[0].quantity=1;changed.expected_cost=15;assert.equal((await call('/rewards/redemptions','POST',changed,key)).status,409);assert.equal(purchased(),3);
});
test('a deleted historical unit leaves the cart request permanently unavailable rather than purchasing again',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',cart(),key);assert.equal(first.status,201);const id=first.data.data.items[1].units[0].id;d.prepare('DELETE FROM reward_redemptions WHERE id=?').run(id);const before=purchased();const retry=await call('/rewards/redemptions','POST',cart(),key);assert.equal(retry.status,410);assert.equal(purchased(),before);
});
test('quantity validation bounds free reward carts and rejects duplicate IDs unsafe totals and numeric strings',async()=>{
 const values=[{user_id:2,items:[{catalog_id:4,quantity:101,expected_cost:0}],expected_cost:0},{user_id:2,items:[{catalog_id:4,quantity:'2',expected_cost:0}],expected_cost:0},{user_id:2,items:[{catalog_id:1,quantity:1,expected_cost:10},{catalog_id:1,quantity:1,expected_cost:10}],expected_cost:20},{...cart(),expected_cost:24},{user_id:2,items:[{catalog_id:4,quantity:2,expected_cost:Number.MAX_SAFE_INTEGER}],expected_cost:0}];
 for(const value of values){const before=counts();const result=await call('/rewards/redemptions','POST',value,randomUUID());assert.equal(result.status,400);assert.deepEqual(counts(),before);}
 const free=await call('/rewards/redemptions','POST',{user_id:2,items:[{catalog_id:4,quantity:2,expected_cost:0}],expected_cost:0},randomUUID());assert.equal(free.status,201);assert.equal(free.data.data.unit_count,2);assert.equal(getBalance(d,2),30);
});
test('cart receipts revalidate current device grant and scope before revealing historical units',async()=>{
 const key=randomUUID(),first=await call('/rewards/redemptions','POST',cart(),key);assert.equal(first.status,201);d.prepare('UPDATE household_devices SET scope_json=? WHERE id=?').run(JSON.stringify({...device.scope,member_ids:[3]}),device.id);const before=counts(),retry=await call('/rewards/redemptions','POST',cart(),key);assert.equal(retry.status,403);assert.deepEqual(counts(),before);assert.ok(!JSON.stringify(retry.data).includes('Family prize'));
});
test('enabled Rewards projects a safe profile photo only for scoped enrolled members',async()=>{
 const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX5cAAAAASUVORK5CYII=';d.prepare('UPDATE users SET avatar_data=? WHERE id IN (2,3,5)').run(photo);const result=await call('/rewards/device-options');assert.equal(result.status,200);assert.equal(result.data.data.members[0].avatar_data,photo);assert.deepEqual(result.data.data.members.map(m=>m.id),[2]);assert.ok(!JSON.stringify(result.data).includes('password_hash'));
});
test('a hidden balance stays omitted from both options and cart receipt',async()=>{
 d.prepare('UPDATE household_devices SET scope_json=? WHERE id=?').run(JSON.stringify({...device.scope,show_points:false}),device.id);const options=await call('/rewards/device-options');assert.ok(!('balance' in options.data.data.members[0]));const result=await call('/rewards/redemptions','POST',cart(),randomUUID());assert.equal(result.status,201);assert.ok(!('balance' in result.data));assert.equal(result.data.data.cost,25);
});
