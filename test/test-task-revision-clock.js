import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET ||= 'task-revision-clock-regression';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');
const d=new Database(':memory:');
d.pragma('foreign_keys=ON');
for(const migration of ALL_MIGRATIONS.filter(row=>row.version!==10032)) {
  if(typeof migration.up==='function')migration.up(d);else d.exec(migration.up);
  migration.afterUp?.(d);
}
const admin=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES('revision-parent','Parent','x','admin')").run().lastInsertRowid);
const insert=d.prepare('INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,status) VALUES (?,?,?,?,?)');
const legacy=Number(insert.run('Existing household task',admin,admin,null,'in_progress').lastInsertRowid);
d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES (?,?)').run(legacy,admin);
const legacyRow=d.prepare('SELECT * FROM tasks WHERE id=?').get(legacy);
const legacyAssignments=d.prepare('SELECT * FROM task_assignments').all();
ALL_MIGRATIONS.find(row=>row.version===10032).up(d);
_setTestDatabase(d);
test.after(()=>d.close());
const read=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const clock=()=>d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
function nested() {
  const group=Number(insert.run('Workflow group',admin,admin,null,'in_progress').lastInsertRowid);
  const activity=Number(insert.run('Activity',admin,admin,group,'in_progress').lastInsertRowid);
  const leaf=Number(insert.run('Completed action',admin,admin,activity,'done').lastInsertRowid);
  const pending=Number(insert.run('Remaining action',admin,admin,activity,'open').lastInsertRowid);
  return {group,activity,leaf,pending};
}

test('10032 preserves existing task columns and assignment records without activity backfill',()=>{
  const {revision,sort_order,...after}=read(legacy);
  assert.deepEqual(after,legacyRow);
  assert.equal(revision,1);assert.equal(sort_order,0);
  assert.deepEqual(d.prepare('SELECT * FROM task_assignments').all(),legacyAssignments);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n,0);
  assert.deepEqual(d.pragma('foreign_key_check'),[]);
  assert.equal(d.pragma('recursive_triggers',{simple:true}),0);
});

test('an unchanged ancestor status still receives a descendant edit revision',()=>{
  const x=nested(),before=read(x.group).revision;
  d.prepare('UPDATE tasks SET description=? WHERE id=?').run('Changed on another device',x.leaf);
  assert.ok(read(x.group).revision>before);
  assert.equal(read(x.group).status,'in_progress');
  assert.equal(read(x.activity).status,'in_progress');
});

test('stale Workflow reset cannot clear descendant progress after a concurrent leaf edit',()=>{
  const x=nested(),before=read(x.group);
  d.prepare('UPDATE tasks SET description=? WHERE id=?').run('Keep my edit and progress',x.leaf);
  assert.throws(()=>changeTaskStatus(d,x.group,'open',{actorId:admin,
    body:{expected_revision:before.revision,reset_progress:true}}),
  error=>error.status===409&&error.details?.reason==='stale_revision');
  assert.equal(read(x.leaf).status,'done');
  assert.equal(read(x.leaf).description,'Keep my edit and progress');
  assert.equal(read(x.activity).status,'in_progress');
  assert.equal(read(x.group).status,'in_progress');
});

test('nested assignment changes invalidate the root even without Task column writes',()=>{
  const x=nested(),before=read(x.group).revision;
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES (?,?)').run(x.leaf,admin);
  assert.ok(read(x.group).revision>before);
});

test('compatibility reparenting invalidates both previous and new ancestor trees',()=>{
  const from=nested(),to=nested();
  const beforeFrom=read(from.group).revision,beforeTo=read(to.group).revision;
  d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(to.activity,from.leaf);
  assert.ok(read(from.group).revision>beforeFrom);
  assert.ok(read(to.group).revision>beforeTo);
});

test('legacy parent cycles cannot loop the ancestor revision trigger',()=>{
  const x=nested();
  d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(x.activity,x.group);
  assert.doesNotThrow(()=>d.prepare('UPDATE tasks SET description=? WHERE id=?').run('Cycle-safe revision',x.leaf));
  d.prepare('UPDATE tasks SET parent_task_id=NULL WHERE id=?').run(x.group);
});

test('Task Presence requirement changes invalidate the Task and its ancestors',()=>{
  const x=nested(),before=read(x.group).revision,epoch=clock();
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy) VALUES (?,'must_be_home')").run(x.leaf);
  assert.ok(read(x.group).revision>before);assert.ok(clock()>epoch);
});

test('Place hierarchy changes invalidate explained eligibility',()=>{
  const place=Number(d.prepare("INSERT INTO places(name,type) VALUES('Home','home')").run().lastInsertRowid);
  let before=clock();d.prepare('UPDATE places SET active=0 WHERE id=?').run(place);assert.ok(clock()>before);
  before=clock();d.prepare('DELETE FROM places WHERE id=?').run(place);assert.ok(clock()>before);
});

test('Calendar advisory event and occurrence changes invalidate explanations',()=>{
  const event=Number(d.prepare("INSERT INTO calendar_events(title,start_datetime,end_datetime,created_by) VALUES('Advisory','2026-09-14T09:00:00','2026-09-14T10:00:00',?)").run(admin).lastInsertRowid);
  let before=clock();d.prepare('INSERT INTO event_assignments(event_id,user_id) VALUES (?,?)').run(event,admin);assert.ok(clock()>before);
  before=clock();d.prepare("INSERT INTO calendar_event_exceptions(event_id,exception_date) VALUES (?,'2026-09-14')").run(event);assert.ok(clock()>before);
  before=clock();d.prepare("UPDATE calendar_events SET title='Changed advisory' WHERE id=?").run(event);assert.ok(clock()>before);
});

test('Trip explanation names refresh even if the dated availability period stays unchanged',()=>{
  const trip=Number(d.prepare("INSERT INTO trip_plans(name,starts_at,ends_at) VALUES('Family visit','2026-09-14T09:00:00','2026-09-15T09:00:00')").run().lastInsertRowid);
  const before=clock();d.prepare("UPDATE trip_plans SET name='School visit' WHERE id=?").run(trip);assert.ok(clock()>before);
});

test('household timezone changes refresh Tasks without integration cursor refresh loops',()=>{
  let before=clock();d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('task_review_cursor','abc')").run();assert.equal(clock(),before);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();assert.ok(clock()>before);
  before=clock();d.prepare("UPDATE sync_config SET value='Europe/London' WHERE key='household_timezone'").run();assert.ok(clock()>before);
  before=clock();d.prepare("DELETE FROM sync_config WHERE key='household_timezone'").run();assert.ok(clock()>before);
});
