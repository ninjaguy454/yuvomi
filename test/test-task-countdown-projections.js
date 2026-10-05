import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET||='task-countdown-projection-test';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {hydrateTask}=await import('../server/routes/tasks.js');
const {createDevice}=await import('../server/services/devices.js');
const {deviceTaskList,deviceTaskDetail}=await import('../server/services/device-tasks.js');
const {deviceTaskUpdate}=await import('../server/services/device-task-definitions.js');
const {publicTaskProjection,wallDashboard}=await import('../server/services/wall.js');

let d,admin,member,principal;
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);}
  _setTestDatabase(d);
  const user=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
  admin=user('Admin','admin');member=user('Member','member');
  principal={kind:'device',...createDevice(d,{name:'Kitchen Wall'},admin)};
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});

function seed(title,countdown,parent=null,visibility='all') {
  const id=Number(d.prepare('INSERT INTO tasks(title,countdown,assigned_to,created_by,parent_task_id,visibility,due_date,due_time) VALUES(?,?,?,?,?,?,?,?)')
    .run(title,countdown,member,admin,parent,visibility,'2099-01-01','12:30').lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,member);
  return id;
}
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);

for(const countdown of [1,0]) {
  test(`paired-device list and detail preserve numeric countdown ${countdown} for Tasks and nested steps`,()=>{
    const parent=seed('Routine',countdown),child=seed('Step',1-countdown,parent);
    const listed=deviceTaskList(d,principal).find(task=>task.id===parent);
    const detailed=deviceTaskDetail(d,principal,parent);
    for(const task of [listed,detailed]) {
      assert.equal(task.countdown,countdown);
      assert.equal(task.subtasks.find(task=>task.id===child).countdown,1-countdown);
      assert.equal(task.due_date,'2099-01-01');
      assert.equal(task.due_time,'12:30');
    }
    assert.equal(deviceTaskDetail(d,principal,child).countdown,1-countdown);
  });

  test(`Wall detail and dashboard preserve numeric countdown ${countdown} within the shared Task projection`,()=>{
    const parent=seed('Routine',countdown),child=seed('Step',1-countdown,parent);
    const hidden=seed('Private step',1,parent,'private');
    const hydrated=hydrateTask(row(parent),admin);
    const detail=publicTaskProjection(d,hydrated,admin);
    const dashboard=wallDashboard(d,admin,hydrateTask).urgentTasks.find(task=>task.id===parent);
    for(const task of [detail,dashboard]) {
      assert.equal(task.countdown,countdown);
      assert.equal(task.subtasks.find(task=>task.id===child).countdown,1-countdown);
      assert.ok(!task.subtasks.some(task=>task.id===hidden));
      assert.deepEqual(task.permissions,{complete:false,claim:false});
      assert.ok(!('created_by' in task));
    }
  });
}

test('Wall projection leaves a missing legacy countdown flag absent',()=>{
  const id=seed('Legacy task',0),task=hydrateTask(row(id),admin);
  delete task.countdown;
  assert.ok(!Object.hasOwn(publicTaskProjection(d,task,admin),'countdown'));
});

test('exposing countdown on a device does not authorize changing it',()=>{
  const id=seed('Countdown task',1),before=row(id);
  principal.permissions.capabilities['tasks.edit_others']='allow';
  assert.throws(()=>deviceTaskUpdate(d,principal,id,{countdown:0,expected_revision:before.revision}),/plain Task/);
  assert.equal(row(id).countdown,1);
  assert.equal(row(id).revision,before.revision);
});
