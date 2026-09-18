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

test('CalDAV deadline edits refresh an existing relative snapshot in household calendar days across DST',()=>{
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const id=fixture('relative-deadline');
  d.prepare("UPDATE tasks SET start_date='2026-03-06',start_time='15:30',due_date='2026-03-07',due_time='07:30',due_date_offset_days=1 WHERE id=?").run(id);
  const todo={uid:'relative-deadline',summary:'Updated deadline',description:null,due:'2026-03-10T11:30:00Z'};
  assert.equal(upsertTask(todo,42,admin),id);
  assert.equal(upsertTask(todo,42,admin),id);
  assert.deepEqual(d.prepare('SELECT start_date,start_time,due_date,due_time,due_date_offset_days FROM tasks WHERE id=?').get(id),{
    start_date:'2026-03-06',start_time:'15:30',due_date:'2026-03-10',due_time:'07:30',due_date_offset_days:4,
  });
});

test('CalDAV does not opt legacy or freshly imported Tasks into relative recurrence',()=>{
  const id=fixture('legacy-deadline');
  d.prepare("UPDATE tasks SET start_date='2026-03-06',start_time='15:30' WHERE id=?").run(id);
  upsertTask({uid:'legacy-deadline',summary:'Legacy deadline',description:null,due:'2026-03-10'},42,admin);
  assert.equal(d.prepare('SELECT due_date_offset_days FROM tasks WHERE id=?').get(id).due_date_offset_days,null);
  const imported=upsertTask({uid:'new-import',summary:'New import',description:null,due:'2026-03-10'},42,admin);
  assert.equal(d.prepare('SELECT due_date_offset_days FROM tasks WHERE id=?').get(imported).due_date_offset_days,null);
});

test('CalDAV clears a relative snapshot when its concrete boundary is missing or impossible',()=>{
  for(const [index,start,due] of [
    [0,'2026-03-06',null], [1,'2026-03-06','2026-03-05'],
    [2,null,'2026-03-10'], [3,'2026-03-06','2026-03-06T12:30:00Z'],
  ]) {
    const uid=`invalid-relative-${index}`,id=fixture(uid);
    d.prepare("UPDATE tasks SET start_date=?,start_time='15:30',due_date_offset_days=4 WHERE id=?").run(start,id);
    upsertTask({uid,summary:'Changed boundary',description:null,due},42,admin);
    assert.equal(d.prepare('SELECT due_date_offset_days FROM tasks WHERE id=?').get(id).due_date_offset_days,null);
  }
});
