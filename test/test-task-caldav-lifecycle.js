import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET ||= 'task-caldav-lifecycle-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
await import('../server/routes/tasks.js');
const { upsertTask } = await import('../server/services/caldav-reminders-sync.js');

const d=new Database(':memory:');
for(const migration of ALL_MIGRATIONS){if(typeof migration.up==='function')migration.up(d);else d.exec(migration.up);migration.afterUp?.(d);}
_setTestDatabase(d);
const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('dav-parent','Parent','x','admin')").run().lastInsertRowid);
const learner=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('dav-learner','Learner','x','member')").run().lastInsertRowid);
test.after(()=>d.close());
function fixture(uid,assignee=admin){
  const id=Number(d.prepare("INSERT INTO tasks(title,description,created_by,assigned_to,external_uid,external_source,external_account_id,due_date) VALUES('Original','Original instructions',?,?,?,'caldav',42,'2099-01-03')").run(admin,assignee,uid).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,assignee);return id;
}
const complete=uid=>d.transaction(()=>upsertTask({uid,summary:'Remote title',description:'Remote instructions',completed:true,due:'2099-01-03'},42,admin))();

test('CalDAV completion of standalone recurring Task creates one fresh occurrence through canonical lifecycle',()=>{
  const id=fixture('standalone-recurring');
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY' WHERE id=?").run(id);
  complete('standalone-recurring');complete('standalone-recurring');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
  const next=d.prepare('SELECT status,due_date FROM tasks WHERE recurrence_origin_id=?').all(id);
  assert.equal(next.length,1);assert.equal(next[0].status,'open');assert.equal(next[0].due_date,'2099-01-10');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='completed'").get(id).n,1);
});

test('CalDAV cannot complete a legacy explicit-skill Task before supervision mapping exists',()=>{
  const id=fixture('legacy-skills',learner);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion) VALUES('Washer',0,'supervised')").run().lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,'excluded','manual')").run(admin,skill);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) VALUES(?,?,'supervised','manual')").run(learner,skill);
  d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(?,?)').run(id,skill);
  assert.throws(()=>complete('legacy-skills'),error=>error.status===409&&/supervis/i.test(error.message));
  assert.deepEqual(d.prepare('SELECT title,status FROM tasks WHERE id=?').get(id),{title:'Original',status:'open'});
});

test('CalDAV does not silently cascade completion across an unfinished checklist',()=>{
  const id=fixture('structured-checklist');
  const child=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by) VALUES('First',?,?)").run(id,admin).lastInsertRowid);
  assert.throws(()=>complete('structured-checklist'),error=>error.status===409&&error.details?.confirmation_required==='complete_remaining');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');
  assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(id).title,'Original');
});
