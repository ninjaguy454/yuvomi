import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {deviceDashboard,deviceSharedRotations}=await import('../server/services/device-content.js');
const {createDevice,updateDevice,devicePrincipal,DEVICE_WIDGETS,normalizeDevicePreferences}=await import('../server/services/devices.js');
const S=await import('../server/services/rotation-shared.js');
const R=await import('../server/services/rotation.js');
const now=new Date('2026-09-20T01:00:00Z');
function fixture(){
 const d=new Database(':memory:');d.pragma('foreign_keys=ON');
 for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d)})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 d.exec(`INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin'),(2,'grace','Grace','x','member'),(3,'eleanor','Eleanor','x','member'),(4,'frankie','Frankie','x','member');
  INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York'),('color_theme:user:1','SECRET personal preference');
  INSERT INTO calendar_events(id,title,description,start_datetime,visibility,created_by,external_source,assigned_to) VALUES
   (1,'Shared family event','Shared description','2026-09-19T22:00:00','all',1,'local',NULL),
   (2,'SECRET private event','SECRET description','2026-09-19T21:00:00','private',1,'local',1),
   (3,'Grace event','For Grace','2026-09-19T22:30:00','all',1,'local',2),
   (4,'OUT-OF-SCOPE Eleanor event','Outside scope','2026-09-19T23:00:00','all',1,'local',3);
  INSERT INTO event_assignments(event_id,user_id) VALUES(3,2),(4,3);
  INSERT INTO ics_subscriptions(id,name,url,created_by,shared) VALUES(1,'SECRET feed','https://invalid.example/private',1,0);
  INSERT INTO calendar_events(id,title,start_datetime,visibility,created_by,external_source,subscription_id) VALUES(5,'SECRET private feed event','2026-09-19T22:00:00','all',1,'ics',1);
  INSERT INTO meals(id,date,meal_type,title,notes,created_by,scope,selection_status) VALUES
   (1,'2026-09-19','dinner','Shared dinner','Household note',1,'household','selected'),
   (2,'2026-09-19','breakfast','SECRET private meal','SECRET meal note',1,'personal','selected'),
   (3,'2026-09-19','lunch','SECRET draft meal','SECRET draft note',1,'household','awaiting_choice');
  INSERT INTO shopping_lists(id,name,created_by) VALUES(1,'Groceries',1);
  INSERT INTO shopping_items(id,list_id,name,quantity) VALUES(1,1,'Milk','1');
  INSERT INTO reward_catalog(id,name,cost,created_by) VALUES(1,'Family reward',4,1);
  INSERT INTO reward_participants(user_id) VALUES(2),(3),(4);
  INSERT INTO reward_ledger(user_id,delta,type,reason,created_by) VALUES(2,3,'bonus','SECRET ledger note',1),(3,7,'bonus','SECRET ledger note',1);
  INSERT INTO notes(title,content,created_by) VALUES('SECRET personal note','SECRET note body',1);`);
 return d;
}
const principal=()=>({kind:'device',id:1,status:'active',permissions:{modules:{dashboard:'read',tasks:'read',calendar:'read',meals:'read',shopping:'read',rewards:'read'},capabilities:{'rotations.view':'allow'}},scope:{member_ids:[],show_points:true},preferences:{default_view:'kanban',appearance:{theme:'dark',density:'compact'}}});
const group=(d,name='Kids Shower Order')=>S.saveRotationGroupUsage(d,{name,member_ids:[2,3,4],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:2,effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'20:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false,eligibility:{}}},{actorId:1,now:new Date('2026-09-19T18:00:00Z')});

test('device dashboard returns explicit shared projections without personal, draft, feed, ledger or preference contents',()=>{
 const d=fixture();try{
  const value=deviceDashboard(d,principal(),{now}),payload=JSON.stringify(value);
  assert.ok(!payload.includes('SECRET'),payload);
  assert.deepEqual(value.calendar.map(row=>row.id),[1,3,4]);
  assert.deepEqual(value.meals.map(row=>row.id),[1]);
  assert.equal(value.shopping[0].items[0].name,'Milk');
  assert.deepEqual(value.points.map(row=>row.balance),[7,0,3]);
  assert.equal(value.preferences.appearance.theme,'dark');
  assert.equal(value.preferences.appearance.density,'compact');
  assert.equal(value.preferences.default_view,'kanban');
  assert.ok(value.unsupported_modules.includes('documents'));assert.ok(value.unsupported_modules.includes('reader'));
  assert.ok(!('created_by' in value.meals[0]));assert.ok(!('username' in value.members[0]));
 }finally{d.close();}
});
test('module denial, points opt-in and member authorization apply independently of displayed widgets',()=>{
 const d=fixture();try{
  const p=principal();p.scope.member_ids=[2];
  const scoped=deviceDashboard(d,p,{now});
  assert.deepEqual(scoped.members.map(row=>row.id),[2]);assert.deepEqual(scoped.points.map(row=>row.user_id),[2]);
  assert.deepEqual(scoped.calendar.map(row=>row.id),[1,3]);assert.ok(!JSON.stringify(scoped).includes('OUT-OF-SCOPE'));
  p.scope.show_points=false;assert.deepEqual(deviceDashboard(d,p,{now}).points,[]);
  for(const key of ['calendar','meals','shopping','rewards'])p.permissions.modules[key]='none';
  const denied=deviceDashboard(d,p,{now});for(const key of ['calendar','meals','shopping','rewards','points'])assert.deepEqual(denied[key],[]);
  p.permissions.modules.dashboard='none';assert.throws(()=>deviceDashboard(d,p,{now}),error=>error.status===403);
 }finally{d.close();}
});
test('shared order projection permits the Group order while excluding nested private consumers and contaminated context',()=>{
 const d=fixture();try{
  const g=group(d),occurrence=S.resolveSharedRotation(d,g.id,{dateKey:'2026-09-19',now});
  d.prepare("UPDATE rotation_occurrences SET context_json=?,consumer_eligibility_json=?,order_json=? WHERE id=?").run(
   JSON.stringify({task_id:72,title:'SECRET private Task',date:'SECRET private date',nested:{description:'SECRET'}}),
   JSON.stringify({subject:'SECRET subject',reason:'SECRET availability'}),
   JSON.stringify(occurrence.order.map(member=>({...member,context:{title:'SECRET nested member'}}))),occurrence.id);
  d.exec("INSERT INTO tasks(id,title,description,visibility,created_by,assigned_to) VALUES(72,'SECRET private Task','SECRET body','private',1,2)");
  d.prepare('INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(72,?,?,?,72)').run('shower',occurrence.track_id,occurrence.id);
  const value=deviceSharedRotations(d,principal(),{now});
  assert.equal(value.length,1);assert.deepEqual(value[0].order.map(row=>row.id),[2,3,4]);
  assert.deepEqual(value[0].order.map(row=>row.position),[1,2,3]);assert.equal(value[0].occurrence_id,occurrence.id);
  const payload=JSON.stringify(value);assert.ok(!payload.includes('SECRET'),payload);
  for(const forbidden of ['consumer_id','track_id','context_json','context','consumer_eligibility','used_by','completion_order','actor_user_id','membership_id'])assert.ok(!payload.includes(`\"${forbidden}\"`),forbidden);
  assert.equal(value[0].period_date,'2026-09-19');
 }finally{d.close();}
});
test('Group allowlist and Rotation permission deny results; read preview never creates, finalizes or advances',()=>{
 const d=fixture();try{
  const a=group(d),b=group(d,'Other Shared Group');
  R.saveRotationGroup(d,{name:'SECRET Independent Group',member_ids:[2,3,4]},{actorId:1});
  const p=principal(),before=d.prepare('SELECT total_changes() n').get().n;
  p.scope.rotation_group_ids=[a.id];const preview=deviceSharedRotations(d,p,{now});
  assert.equal(preview.length,1);assert.equal(preview[0].id,a.id);assert.equal(preview[0].provisional,true);
  p.scope.rotation_group_ids=[];assert.deepEqual(deviceSharedRotations(d,p,{now}),[]);
  p.scope.rotation_group_ids=null;assert.deepEqual(deviceSharedRotations(d,p,{now}).map(row=>row.id),[a.id,b.id]);
  p.permissions.capabilities['rotations.view']='none';assert.deepEqual(deviceSharedRotations(d,p,{now}),[]);
  assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
 }finally{d.close();}
});
test('shared active overnight period uses its intended evening and an override updates its order without exposing history',()=>{
 const d=fixture();try{
  const g=group(d),occurrence=S.resolveSharedRotation(d,g.id,{dateKey:'2026-09-19',now});
  R.overrideRotation(d,occurrence.id,{member_ids:[4,2,3],expected_revision:occurrence.revision,actorId:1});
  const value=deviceSharedRotations(d,principal(),{now:new Date('2026-09-20T05:00:00Z')});
  assert.equal(value[0].period_date,'2026-09-19');assert.deepEqual(value[0].order.map(row=>row.id),[4,2,3]);
  assert.ok(!('original_order' in value[0]));assert.ok(!('override_actor_id' in value[0]));
 }finally{d.close();}
});
test('human or revoked principals cannot use the device projection boundary',()=>{
 const d=fixture();try{
  for(const p of [{kind:'member',id:1},{...principal(),status:'revoked'},null])assert.throws(()=>deviceDashboard(d,p),error=>error.status===403);
 }finally{d.close();}
});

test('device widgets default to the seven supported surfaces and customization stays separate from household and human preferences',()=>{
 const d=fixture();try{
  d.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run('wall_dashboard_v1',JSON.stringify({appearance:{theme:'light',font:'serif',density:'compact'},widgets:[{id:'tasks',visible:true,size:'small'}]}));
  const before=d.prepare('SELECT * FROM sync_config ORDER BY key').all();
  let device=createDevice(d,{name:'Kitchen Wall'},1);
  assert.deepEqual(device.preferences.widgets.map(row=>row.id),DEVICE_WIDGETS);
  assert.ok(device.preferences.widgets.every(row=>row.visible));
  assert.equal(device.preferences.appearance.theme,'light');assert.equal(device.preferences.appearance.font,'serif');
  const widgets=[...device.preferences.widgets].reverse().map((row,index)=>({...row,order:index,visible:row.id!=='shopping',size:row.id==='rotations'?'large':'small'}));
  device=updateDevice(d,device.id,{revision:device.revision,preferences:{...device.preferences,widgets,default_view:'list',appearance:{theme:'dark',font:'default',density:'comfortable'}}},1);
  const actual=deviceDashboard(d,devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(device.id)),{now});
  assert.deepEqual(actual.preferences.widgets.map(row=>row.id),[...DEVICE_WIDGETS].reverse());
  assert.equal(actual.preferences.widgets.find(row=>row.id==='shopping').visible,false);
  assert.equal(actual.preferences.widgets.find(row=>row.id==='rotations').size,'large');
  assert.equal(actual.preferences.default_view,'list');assert.equal(actual.preferences.appearance.theme,'dark');
  assert.deepEqual(d.prepare('SELECT * FROM sync_config ORDER BY key').all(),before);
  for(const widgets of [[{id:'tasks'},{id:'tasks'}],[{id:'documents'}],[{id:'rotations',size:'huge'}]])
   assert.throws(()=>normalizeDevicePreferences(d,{widgets}),error=>error.status===400);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
 }finally{d.close();}
});
