import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-merged-scoring-migration';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {saveTrip}=await import('../server/services/trips.js');
const {createParentPrizeRedemption,undoPrizeRedemption}=await import('../server/services/reward-fulfillment.js');
const {postLedger,awardForCompletion}=await import('../server/services/rewards.js');
const {changeTaskStatus}=await import('../server/services/task-lifecycle.js');
const apply=(d,m)=>{if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);}).immediate();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');};
const rows=(d,name)=>d.prepare(`SELECT * FROM "${name}"`).all();
const snapshot=d=>JSON.stringify({schema:d.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),tables:Object.fromEntries(d.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({name})=>[name,rows(d,name).map(row=>JSON.stringify(row)).sort()]))});

// This maintained test applies the actual migration objects and records their
// IDs. The controller's separate encrypted automatic-runner test is mandatory.
test('actual merged10055 follows recorded10056/10057 and preserves Trip/prize/history',()=>{
 const d=new Database(':memory:');d.pragma('foreign_keys=ON');_setTestDatabase(d);
 try {
  d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT 'synthetic-test')");
  for(const m of ALL_MIGRATIONS.filter(m=>m.version!==10055))apply(d,m);
  assert.deepEqual(d.prepare('SELECT version FROM schema_migrations WHERE version>=10055 ORDER BY version').all(),[{version:10056},{version:10057}]);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'Synthetic Dad','Synthetic Dad','x','admin','dad'),(2,'Synthetic Mom','Synthetic Mom','x','member','mom'),(3,'Synthetic Child','Synthetic Child','x','member','child'); INSERT INTO reward_participants(user_id,enabled) VALUES(3,1); INSERT INTO reward_catalog(id,name,cost) VALUES(1,'Synthetic prize',10)");
  // Faithful pre55 committed fixture rows, not current55 services against a
  // schema they cannot use. Real eb2 service seeding is the encrypted gate.
  d.exec("INSERT INTO tasks(id,title,status,points,assigned_to,created_by,parent_task_id) VALUES(1,'Trip root','open',0,1,1,NULL),(2,'Pack','done',0,3,1,1),(3,'Unpack','open',0,2,1,1),(4,'Separate meal planning','open',0,1,1,NULL),(5,'Pending prize','open',0,1,NULL,NULL),(6,'Delivered prize','done',0,1,NULL,NULL),(7,'Actual-shaped earned history','done',5,3,1,NULL); INSERT INTO trip_plans(id,name,starts_at,ends_at,created_by) VALUES(1,'Historical managed Trip','2031-07-10T09:00','2031-07-14T18:00',1); INSERT INTO trip_task_groups(trip_id,parent_task_id,coordinator_id) VALUES(1,1,1); INSERT INTO trip_task_steps(trip_id,step_key,task_id,phase,recipe_json) VALUES(1,'pack',2,'before_departure','{}'),(1,'unpack',3,'post_trip','{}'); INSERT INTO task_assignments(task_id,user_id) VALUES(1,1),(1,2),(1,3),(2,3),(3,2),(5,1),(5,2),(6,1),(6,2),(7,3); INSERT INTO task_completions(task_id,series_id,user_id) VALUES(2,2,3),(6,6,2),(7,7,3); INSERT INTO reward_redemptions(id,user_id,catalog_id,reward_name,cost,status,requested_by,decided_by) VALUES(1,3,1,'Synthetic prize',10,'pending',3,NULL),(2,3,1,'Synthetic prize',10,'fulfilled',3,2); INSERT INTO reward_fulfillment_task_links(redemption_id,task_id) VALUES(1,5),(2,6); INSERT INTO reward_ledger(user_id,delta,type,task_id,redemption_id) VALUES(3,100,'bonus',NULL,NULL),(3,-10,'redeem',NULL,1),(3,-10,'redeem',NULL,2),(3,5,'earn',7,NULL); INSERT INTO reward_task_awards(task_id) VALUES(7)");
  const trip={parent_task:{id:1}},old=7;
  const preserved=['schema_migrations','trip_plans','trip_tasks','trip_task_groups','trip_task_steps','task_assignments','task_completions','reward_redemptions','reward_redemption_requests','reward_fulfillment_task_links','reward_redemption_undos','reward_ledger','reward_task_awards','notification_inbox','reminders'];
  const before=Object.fromEntries(preserved.map(name=>[name,rows(d,name)])),oldTasks=rows(d,'tasks'),clockBefore=rows(d,'task_change_clock'),roots=new Set(oldTasks.filter(row=>row.parent_task_id===null).map(row=>row.id));
  const migration=ALL_MIGRATIONS.find(m=>m.version===10055);assert.ok(migration);const start=Date.now();apply(d,migration);const end=Date.now();
  assert.equal(d.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=10055').get().n,1);assert.equal(d.prepare('SELECT MAX(version) n FROM schema_migrations').get().n,10057);
  for(const name of preserved)assert.deepEqual(rows(d,name).filter(row=>name!=='schema_migrations'||row.version!==10055),before[name],name);
  assert.deepEqual(rows(d,'tasks').map(row=>row.id).sort((a,b)=>a-b),oldTasks.map(row=>row.id).sort((a,b)=>a-b),'exact old Task IDs/count');
  for(const prior of oldTasks){const actual=d.prepare('SELECT * FROM tasks WHERE id=?').get(prior.id),root=roots.has(prior.id);for(const [field,value] of Object.entries(prior)){if(root&&field==='revision')assert.equal(actual[field],value+1,`${prior.id}.revision`);else if(root&&field==='updated_at'){assert.match(actual[field],/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);const time=Date.parse(actual[field]);assert.ok(time>=Math.floor(start/1000)*1000&&time<=Math.floor(end/1000)*1000,`${prior.id}.updated_at`);}else assert.deepEqual(actual[field],value,`${prior.id}.${field}`);}assert.deepEqual(d.prepare('SELECT scoring_mode,scoring_review_required FROM tasks WHERE id=?').get(prior.id),{scoring_mode:root?'whole_task':'legacy',scoring_review_required:0});}
  assert.deepEqual(rows(d,'task_change_clock'),clockBefore.map(row=>({...row,version:row.version+roots.size})));
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(trip.parent_task.id),[{user_id:1},{user_id:2},{user_id:3}]);
  const history=d.prepare('SELECT * FROM task_scoring_settlements WHERE task_id=?').all(old);assert.equal(history.length,1);assert.equal(history[0].points,5);assert.equal(history[0].outcome,'earned');
  const first=snapshot(d),changes=d.prepare('SELECT total_changes() n').get().n;migration.up(d);assert.equal(snapshot(d),first);assert.equal(d.prepare('SELECT total_changes() n').get().n,changes,'schema reentry is a true no-write');
  const pendingId=5;assert.equal(d.prepare('SELECT scoring_mode,points FROM tasks WHERE id=?').get(pendingId).scoring_mode,'whole_task');
  changeTaskStatus(d,pendingId,'done',{actorId:2,requireRevision:false});
  assert.equal(d.prepare('SELECT status FROM reward_redemptions WHERE id=1').get().status,'fulfilled');
  const after=snapshot(d),afterChanges=d.prepare('SELECT total_changes() n').get().n;
  assert.equal(awardForCompletion(d,pendingId,2),false);assert.equal(awardForCompletion(d,pendingId,2),false);assert.equal(snapshot(d),after);assert.equal(d.prepare('SELECT total_changes() n').get().n,afterChanges);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(pendingId).n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE task_id=?').get(pendingId).n,0);
  undoPrizeRedemption(d,{actorId:2,redemptionId:2,requestKey:'merged55-delivered-undo',expectedStatus:'fulfilled',confirmDelivered:true});assert.equal(d.prepare('SELECT status FROM tasks WHERE id=6').get().status,'done');
  const newTrip=saveTrip(d,{name:'New merged Trip',participant_ids:[1,2,3],starts_at:'2031-08-10T09:00',ends_at:'2031-08-14T18:00',request_key:'merged55-new-trip',tasks:[{step_key:'pack',phase:'before_departure',title:'Pack',assigned_user_ids:[3]}]},1);
  assert.equal(newTrip.parent_task.points,0);assert.equal(newTrip.tasks[0].assigned_to,3);console.log('MERGED55_NEW_TRIP_MODE',d.prepare('SELECT scoring_mode FROM tasks WHERE id=?').get(newTrip.parent_task.id).scoring_mode);
  const newPrize=createParentPrizeRedemption(d,{actorId:3,userId:3,catalogId:1,requestKey:'merged55-new-prize'});const newTask=d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE redemption_id=?').get(newPrize.row.id);assert.equal(newTask.scoring_mode,'whole_task');assert.equal(newTask.points,0);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.deepEqual(d.pragma('integrity_check'),[{integrity_check:'ok'}]);
 }finally{_setTestDatabase(null);d.close();}
});
