import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.LOG_LEVEL='error';
process.env.SESSION_SECRET='synthetic-trip-prize-integration';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveTrip}=await import('../server/services/trips.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const {taskCapabilities}=await import('../server/services/task-access.js');
const {createRedemption,postLedger,getBalance}=await import('../server/services/rewards.js');
const {createParentPrizeRedemption,undoPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
let d;
const apply=m=>{
 if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');
 d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();
 if(m.foreignKeysOff)d.pragma('foreign_keys=ON');
};
test.beforeEach(()=>{d=new Database(':memory:');d.pragma('foreign_keys=ON');_setTestDatabase(d)});
test.afterEach(()=>{_setTestDatabase(null);d.close()});
const people=()=>{
 const add=d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,'x',?,?)");
 add.run(1,'synthetic-dad','Synthetic Dad','admin','dad');
 add.run(2,'synthetic-mom','Synthetic Mom','member','mom');
 add.run(3,'synthetic-child','Synthetic Child','member','child');
 d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(3,1)').run();
 d.prepare("INSERT INTO reward_catalog(id,name,cost) VALUES(1,'Synthetic prize',10)").run();
};
const task=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const complete=(id,actorId)=>changeTaskStatus(d,id,'done',{actorId,requireRevision:false});

test('independent Trip and prize declare10056 then10057 and leave scoring10055 reserved',()=>{
 assert.deepEqual(ALL_MIGRATIONS.filter(m=>m.version>10054).map(m=>m.version),[10056,10057]);
 for(const m of ALL_MIGRATIONS)apply(m);
 assert.equal(d.prepare("SELECT 1 FROM sqlite_master WHERE name='task_scoring_settlements'").get(),undefined);
 assert.ok(!d.pragma('table_info(tasks)').some(c=>c.name==='scoring_mode'));
});

test('both metadata migrations preserve a legacy Trip, historical redemption and earned rows without backfill',()=>{
 for(const m of ALL_MIGRATIONS.filter(m=>m.version<=10054))apply(m);
 people();
 d.prepare("INSERT INTO tasks(id,title,created_by,assigned_to,status,points) VALUES(1,'Legacy packing',1,3,'done',5)").run();
 d.prepare("INSERT INTO trip_plans(id,name,starts_at,ends_at,created_by) VALUES(1,'Legacy trip','2031-07-10T09:00','2031-07-14T18:00',1)").run();
 d.prepare("INSERT INTO trip_tasks(trip_id,task_id,phase) VALUES(1,1,'before_departure')").run();
 postLedger(d,{userId:3,delta:30,type:'bonus'});postLedger(d,{userId:3,delta:5,type:'earn',taskId:1});
 createRedemption(d,{actorId:3,userId:3,catalogId:1,requestKey:'historical-prize-request'});
 const names=['tasks','trip_plans','trip_tasks','reward_redemptions','reward_redemption_requests','reward_ledger'];
 const before=Object.fromEntries(names.map(name=>[name,d.prepare('SELECT * FROM '+name).all()]));
 for(const m of ALL_MIGRATIONS.filter(m=>m.version>10054))apply(m);
 for(const name of names)assert.deepEqual(d.prepare('SELECT * FROM '+name).all(),before[name],name);
 for(const name of ['trip_task_groups','trip_task_steps','reward_fulfillment_task_links','reward_redemption_undos'])
  assert.equal(d.prepare('SELECT COUNT(*) n FROM '+name).get().n,0,name+' must not backfill');
 assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('Trip cancellation and delivered-prize Undo remain separate and award no completion points',()=>{
 for(const m of ALL_MIGRATIONS)apply(m);people();
 d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
 postLedger(d,{userId:3,delta:100,type:'bonus'});
 const trip=saveTrip(d,{name:'Synthetic new trip',participant_ids:[1,2,3],starts_at:'2031-07-10T09:00',ends_at:'2031-07-14T18:00',request_key:'combined-new-trip',
  tasks:[{step_key:'pack',phase:'before_departure',title:'Pack',assigned_user_ids:[3]},{step_key:'unpack',phase:'post_trip',title:'Unpack',assigned_user_ids:[2]}]},1);
 const purchase=createParentPrizeRedemption(d,{actorId:3,userId:3,catalogId:1,requestKey:'combined-new-prize'});
 const delivery=d.prepare('SELECT task_id FROM reward_fulfillment_task_links WHERE redemption_id=?').get(purchase.row.id).task_id;
 assert.equal(task(delivery).points,0);assert.equal(taskCapabilities(d,3,task(delivery)).view,false);
 assert.ok(trip.tasks.every(t=>task(t.id).points===0));assert.equal(task(trip.parent_task.id).points,0);
 complete(trip.tasks.find(t=>t.step_key==='pack').id,3);
 assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(purchase.row.id).status,'pending');
 assert.equal(task(delivery).status,'open');
 saveTrip(d,{status:'cancelled'},1,trip.id);
 const remaining=trip.tasks.find(t=>t.step_key==='unpack');
 assert.throws(()=>complete(remaining.id,2),/cancelled|retired/i);
 const tripRows=[trip.parent_task.id,...trip.tasks.map(t=>t.id)].map(task);
 complete(delivery,2);
 assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=?').get(purchase.row.id).status,'fulfilled');
 assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE type='earn'").get().n,0);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n,0);
 const completions=d.prepare('SELECT * FROM task_completions ORDER BY id').all();
 undoPrizeRedemption(d,{actorId:2,redemptionId:purchase.row.id,requestKey:'combined-delivered-undo',expectedStatus:'fulfilled',confirmDelivered:true});
 assert.equal(getBalance(d,3),100);assert.equal(task(delivery).status,'done');
 assert.deepEqual(d.prepare('SELECT * FROM task_completions ORDER BY id').all(),completions);
 assert.deepEqual([trip.parent_task.id,...trip.tasks.map(t=>t.id)].map(task),tripRows);
 assert.throws(()=>changeTaskStatus(d,delivery,'open',{actorId:2,requireRevision:false}),/decided|reset|delivery/i);
 assert.deepEqual(d.pragma('foreign_key_check'),[]);
});
