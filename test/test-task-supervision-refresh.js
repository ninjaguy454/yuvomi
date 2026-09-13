import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='task-supervision-refresh';
const { ALL_MIGRATIONS, _setTestDatabase }=await import('../server/db.js');
const { reconcileTaskSupervision, inspectTaskSupervision }=await import('../server/services/task-supervision.js');
const { createTaskSupervisionRefresher, refreshExistingTaskSupervision }=await import('../server/services/task-supervision-refresh.js');
const { setTaskSkills }=await import('../server/services/task-skills.js');

let d, admin, learner, first, second, skill, root, action, at;
test.beforeEach(()=>{
  d=new Database(':memory:');d.pragma('foreign_keys=ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for(const migration of ALL_MIGRATIONS){typeof migration.up==='function'?migration.up(d):d.exec(migration.up);migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);}
  _setTestDatabase(d);at=0;
  const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
  admin=user('Creator','admin');learner=user('Learner');first=user('First');second=user('Second');
  skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',?)").run(admin).lastInsertRowid);
  proficiency(admin,'excluded');proficiency(learner,'supervised');proficiency(first,'normal');proficiency(second,'normal');
  root=task('Laundry');action=task('Load washer',root);setTaskSkills(d,action,[skill]);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(root);
  for(const id of [learner,first,second]) d.prepare(`INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,created_by)
    VALUES(?,'Available','[0,1,2,3,4,5,6]','00:00','23:59','available',?)`).run(id,admin);
});
test.afterEach(()=>{_setTestDatabase(null);d.close();});
function proficiency(user,value){d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
 VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(user,skill,value,admin);}
function task(title,parent=null){return Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,due_date,due_time) VALUES(?,?,?,?, '2026-09-14','12:00')")
 .run(title,admin,parent?null:learner,parent).lastInsertRowid);}
function busy(user){return Number(d.prepare(`INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,created_by)
 VALUES(?,'explicit','busy','2026-09-14T11:00:00','2026-09-14T13:00:00',?)`).run(user,admin).lastInsertRowid);}
const clock=()=>d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
const observer=options=>createTaskSupervisionRefresher({getDatabase:()=>d,now:()=>at,...options});

test('clock gate limits checks to five seconds and rechecks time-sensitive state every minute without database changes',()=>{
  let calls=0;
  const tick=observer({refresh:()=>{calls++;return {inspected:0,reconciled:0,failed:0};}});
  assert.equal(tick().skipped,false);assert.equal(calls,1);
  at=4000;d.prepare('UPDATE tasks SET title=? WHERE id=?').run('Changed',root);
  assert.equal(tick().skipped,true);assert.equal(calls,1);
  at=5000;assert.equal(tick().skipped,false);assert.equal(calls,2);
  at=10000;assert.equal(tick().skipped,true);
  at=65000;assert.equal(tick().skipped,false);assert.equal(calls,3);
});

test('Availability change replaces one invalid supervisor without any connected Task viewer',()=>{
  const before=reconcileTaskSupervision(d,root);assert.equal(before.supervisor_user_id,first);
  const tick=observer();tick();busy(first);at=5000;
  const result=tick();assert.equal(result.reconciled,1);
  const after=inspectTaskSupervision(d,root);assert.equal(after.supervisor_user_id,second);
  assert.equal(after.support_task_id,before.support_task_id);
  const active=d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(root);
  assert.deepEqual(active.map(row=>row.user_id),[second]);
  const ownVersion=clock();at=10000;assert.equal(tick().skipped,true);assert.equal(clock(),ownVersion);
});

test('no available replacement becomes unresolved with deduplicated notification and unchanged learner progress',()=>{
  reconcileTaskSupervision(d,root);const independent=task('Gather laundry',root);d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(independent);
  const tick=observer();tick();busy(first);busy(second);at=5000;
  assert.equal(tick().reconciled,1);assert.equal(inspectTaskSupervision(d,root).state,'needed');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(root).assigned_to,learner);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(independent).status,'done');
  const notifications=d.prepare('SELECT COUNT(*) n FROM notification_inbox').get().n;
  const activity=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  const version=clock();at=65000;assert.equal(tick().skipped,false);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM notification_inbox').get().n,notifications);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,activity);
  assert.equal(clock(),version);
});

test('maintenance preserves valid current selection even when an earlier candidate becomes qualified',()=>{
  proficiency(first,'excluded');assert.equal(reconcileTaskSupervision(d,root).supervisor_user_id,second);
  const tick=observer();tick();proficiency(first,'normal');const version=clock();at=5000;
  assert.equal(tick().reconciled,1);assert.equal(inspectTaskSupervision(d,root).supervisor_user_id,second);assert.equal(clock(),version);
});

test('newly supervised requirement gains a linked projection while retaining the one valid supervisor',()=>{
  const extra=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Dryer',0,'normal',?)").run(admin).lastInsertRowid);
  const nextAction=task('Start dryer',root);setTaskSkills(d,nextAction,[extra]);
  const before=reconcileTaskSupervision(d,root);assert.equal(before.actions.length,1);
  const tick=observer();tick();
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'supervised','manual',?)").run(learner,extra,admin);
  at=5000;assert.equal(tick().reconciled,1);
  const after=inspectTaskSupervision(d,root);assert.equal(after.actions.length,2);
  assert.ok(after.actions.every(row=>row.supervisor_user_id===first&&row.counterpart_task_id));
  assert.equal(after.support_task_id,before.support_task_id);
});

test('learner skill progression retires no-longer-required helper projections and active relationship',()=>{
  const before=reconcileTaskSupervision(d,root);const tick=observer();tick();proficiency(learner,'normal');at=5000;
  assert.equal(tick().reconciled,1);assert.equal(inspectTaskSupervision(d,root).state,'none');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").get(root).n,0);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(before.support_task_id).archived_at);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(action).status,'open');
});

test('maintenance does not discover or backfill existing Tasks that have no linked supervision data',()=>{
  const result=refreshExistingTaskSupervision(d);assert.equal(result.inspected,0);assert.equal(result.reconciled,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions').get().n,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks').get().n,0);
});

test('completed and archived sources are left intact by the operational maintenance sweep',()=>{
  const before=reconcileTaskSupervision(d,root);d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(root);
  assert.equal(refreshExistingTaskSupervision(d).inspected,0);
  d.prepare("UPDATE tasks SET status='open',archived_at='2026-09-14T00:00:00Z' WHERE id=?").run(root);
  assert.equal(refreshExistingTaskSupervision(d).inspected,0);
  assert.equal(d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(action).supervisor_user_id,before.supervisor_user_id);
});

test('one failed source does not stop independent linked Tasks from being examined',()=>{
  reconcileTaskSupervision(d,root);const other=task('Second laundry');const child=task('Other washer',other);setTaskSkills(d,child,[skill]);
  reconcileTaskSupervision(d,other);const errors=[];
  const result=refreshExistingTaskSupervision(d,{reconcile:(database,id)=>{if(id===root)throw new Error('Broken scope');return reconcileTaskSupervision(database,id);},
    onError:(error,id)=>errors.push([error.message,id])});
  assert.equal(result.failed,1);assert.equal(result.inspected,1);assert.deepEqual(errors,[['Broken scope',root]]);
});

test('legacy nested source identifiers resolve once to their ordinary canonical Task and respect its archive',()=>{
  const otherAction=task('Dryer',root);
  for(const id of [action,otherAction]) d.prepare(`INSERT INTO task_supervision_actions(source_task_id,action_task_id,learner_user_id,state)
    VALUES(?,?,?,'unresolved')`).run(id,id,learner);
  const visited=[];const options={reconcile:(_database,id)=>visited.push(id)};
  assert.equal(refreshExistingTaskSupervision(d,options).reconciled,1);assert.deepEqual(visited,[root]);
  d.prepare("UPDATE tasks SET archived_at='2026-09-14T00:00:00Z' WHERE id=?").run(root);
  assert.equal(refreshExistingTaskSupervision(d,options).reconciled,0);assert.deepEqual(visited,[root]);
});
