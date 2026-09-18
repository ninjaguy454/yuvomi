import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'activity-relative-generation-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
await import('../server/routes/tasks.js');
const { changeTaskStatus, expireTask, reopenExpiredTask } = await import('../server/services/task-lifecycle.js');
const { resolveActivityTemplate, previewWorkflow, instantiateWorkflow } = await import('../server/services/activity-workflows.js');
const { resolveActivitySchedule } = await import('../server/services/activity-schedule.js');
const { taskStartMs, taskDeadlineMs: taskDueMs } = await import('../server/services/task-window.js');

let d;
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  for (const migration of ALL_MIGRATIONS) {
    if (migration.foreignKeysOff) d.pragma('foreign_keys=OFF');
    d.transaction(() => {
      typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
      migration.afterUp?.(d);
    })();
    if (migration.foreignKeysOff) d.pragma('foreign_keys=ON');
  }
  _setTestDatabase(d);
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(1,'parent','Parent','x','admin','parent'),(2,'eleanor','Eleanor','x','member','child')");
  d.exec("INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)");
  d.exec("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')");
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
const read = (id) => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const children = (id) => d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY id').all(id);
const successor = (id) => d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
const earnCount = (id) => d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(id).n;
function activity(extra = {}) {
  const values = { name: 'Relative Activity', title_template: 'Relative Activity', start_time: '07:00', due_time: '08:00', due_date_offset_days: 0, ...extra };
  const id = Number(d.prepare(`INSERT INTO activity_templates(name,title_template,start_time,due_time,due_date_offset_days,
    assignment_strategy,assignment_policy,fixed_user_id,created_by,subject_required) VALUES(?,?,?,?,?,'fixed','fixed',2,1,0)`)
    .run(values.name, values.title_template, values.start_time, values.due_time, values.due_date_offset_days).lastInsertRowid);
  return d.prepare('SELECT * FROM activity_templates WHERE id=?').get(id);
}
function occurrence(template, start, { rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', points = 2, expiration = 'expire_incomplete', fromCompletion = 0, due = undefined } = {}) {
  const schedule = resolveActivitySchedule(template, { start_date: start, ...(due !== undefined ? { due_date: due } : {}) });
  const id = Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,start_date,start_time,due_date,due_time,due_date_offset_days,
    is_recurring,recurrence_rule,recurrence_from_completion,points,expiration_policy)
    VALUES(?,1,2,?,?,?,?,?,1,?,?,?,?)`).run(template.name, schedule.start_date, schedule.start_time, schedule.due_date,
    schedule.due_time, schedule.due_date_offset_days, rule, fromCompletion, points, expiration).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(id);
  d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(?,?)').run(id, template.id);
  const child = d.prepare(`INSERT INTO tasks(title,created_by,parent_task_id,start_date,start_time,due_date,due_time,is_optional)
    VALUES(?,1,?,?,?,?,?,?)`);
  child.run('Get dressed', id, schedule.start_date, schedule.start_time, schedule.due_date, schedule.due_time, 0);
  child.run('Earrings', id, schedule.start_date, schedule.start_time, schedule.due_date, schedule.due_time, 1);
  return read(id);
}
const complete = (id, now) => changeTaskStatus(d, id, 'done', { actorId: 2, requireRevision: false, now: new Date(now) });

test('resolver returns reusable relative timing without absolute template dates or fabricated dates', () => {
  const template = activity({ due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' });
  const result = resolveActivityTemplate(d, template.id).data;
  assert.equal(result.due_date_offset_days, 4);
  assert.equal(result.start_time, '15:30'); assert.equal(result.due_time, '07:30');
  assert.equal(Object.hasOwn(result, 'start_date'), false); assert.equal(Object.hasOwn(result, 'due_date'), false);
  assert.deepEqual(resolveActivitySchedule(template, { start_date: '2026-09-21' }), {
    start_date: '2026-09-21', start_time: '15:30', due_date: '2026-09-25', due_time: '07:30', due_date_offset_days: 4,
  });
  const missing = resolveActivitySchedule(template);
  assert.equal(missing.start_date, null); assert.equal(missing.due_date, null); assert.equal(missing.due_date_offset_days, null);
});

test('concrete overrides snapshot their actual span and explicit nulls remain cleared', () => {
  const template = activity({ due_date_offset_days: 4 });
  assert.equal(resolveActivitySchedule(template, { start_date: '2026-09-21', due_date: '2026-09-27' }).due_date_offset_days, 6);
  assert.deepEqual(resolveActivitySchedule(template, { start_date: null, start_time: null, due_date: null, due_time: null }, { fallbackStartDate: '2026-09-21' }), {
    start_date: null, start_time: null, due_date: null, due_time: null, due_date_offset_days: null,
  });
  assert.throws(() => resolveActivitySchedule(template, { start_date: '9999-12-31' }), error => error.status === 400 && /Due interval/.test(error.message));
});

test('missed Monday expires once for zero points and creates a fresh Tuesday 7–8 AM occurrence', () => {
  const monday = occurrence(activity(), '2026-09-21');
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(children(monday.id)[1].id);
  const now = new Date('2026-09-21T12:00:00Z');
  expireTask(d, monday.id, { now }); expireTask(d, monday.id, { now });
  assert.equal(read(monday.id).status, 'expired'); assert.equal(earnCount(monday.id), 0);
  assert.equal(children(monday.id)[1].status, 'done', 'partial optional history remains');
  const tuesday = successor(monday.id);
  assert.equal(tuesday.start_date, '2026-09-22'); assert.equal(tuesday.due_date, '2026-09-22');
  assert.equal(tuesday.start_time, '07:00'); assert.equal(tuesday.due_time, '08:00');
  assert.equal(tuesday.due_date_offset_days, 0); assert.equal(tuesday.points, 2);
  assert.deepEqual(children(tuesday.id).map(row => [row.status, row.is_optional]), [['open', 0], ['open', 1]]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='expired'").get(monday.id).n, 1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(monday.id).n, 1);
});

test('final required action completes morning once while optional remains open and Friday advances to Monday', () => {
  const friday = occurrence(activity(), '2026-10-30');
  complete(children(friday.id)[0].id, '2026-10-30T11:59:59Z');
  complete(friday.id, '2026-10-30T11:59:59Z');
  assert.equal(read(friday.id).status, 'done'); assert.equal(earnCount(friday.id), 1);
  assert.equal(d.prepare('SELECT SUM(delta) points FROM reward_ledger WHERE task_id=?').get(friday.id).points, 2);
  assert.equal(children(friday.id)[1].status, 'open');
  assert.equal(successor(friday.id).start_date, '2026-11-02'); assert.equal(successor(friday.id).due_date, '2026-11-02');
});

test('weekly homework recurs Monday to Friday across DST, independent of the previous Friday deadline', () => {
  const template = activity({ name: "Eleanor's Weekly Homework", due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' });
  const monday = occurrence(template, '2026-10-26', { rule: 'FREQ=WEEKLY;BYDAY=MO', points: 5, expiration: 'keep_overdue' });
  complete(children(monday.id)[0].id, '2026-10-30T11:00:00Z');
  const next = successor(monday.id);
  assert.equal(next.start_date, '2026-11-02'); assert.equal(next.due_date, '2026-11-06');
  assert.equal(next.start_time, '15:30'); assert.equal(next.due_time, '07:30'); assert.equal(next.due_date_offset_days, 4);
  assert.equal(new Date(taskStartMs(d, monday)).toISOString(), '2026-10-26T19:30:00.000Z');
  assert.equal(new Date(taskDueMs(d, monday)).toISOString(), '2026-10-30T11:30:00.000Z');
  assert.equal(new Date(taskStartMs(d, next)).toISOString(), '2026-11-02T20:30:00.000Z');
  assert.equal(new Date(taskDueMs(d, next)).toISOString(), '2026-11-06T12:30:00.000Z');
  assert.deepEqual(children(next.id).map(row => [row.start_date, row.due_date]), [['2026-11-02', '2026-11-06'], ['2026-11-02', '2026-11-06']]);
  assert.equal(d.prepare('SELECT SUM(delta) points FROM reward_ledger WHERE task_id=?').get(monday.id).points, 5);
});

test('concrete span overrides remain independent of later template changes', () => {
  const template = activity({ due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' });
  const monday = occurrence(template, '2026-10-26', { rule: 'FREQ=WEEKLY;BYDAY=MO', expiration: 'keep_overdue', due: '2026-10-31' });
  d.prepare('UPDATE activity_templates SET due_date_offset_days=1,start_time=? WHERE id=?').run('10:00', template.id);
  complete(children(monday.id)[0].id, '2026-10-30T11:00:00Z');
  const next = successor(monday.id);
  assert.equal(next.start_date, '2026-11-02'); assert.equal(next.due_date, '2026-11-07');
  assert.equal(next.due_date_offset_days, 5); assert.equal(next.start_time, '15:30');
});

test('overnight due offset uses the next calendar day across spring DST', () => {
  const template = activity({ due_date_offset_days: 1, start_time: '22:00', due_time: '06:00' });
  const saturday = occurrence(template, '2026-03-07', { rule: 'FREQ=DAILY' });
  assert.equal(saturday.due_date, '2026-03-08');
  assert.equal((taskDueMs(d, saturday) - taskStartMs(d, saturday)) / 3600000, 7);
  expireTask(d, saturday.id, { now: new Date('2026-03-08T10:00:00Z') });
  const sunday = successor(saturday.id);
  assert.equal(sunday.start_date, '2026-03-08'); assert.equal(sunday.due_date, '2026-03-09');
  assert.equal(sunday.start_time, '22:00'); assert.equal(sunday.due_time, '06:00');
});

test('completion-relative expiration pauses; an authorized reopened completion still supplies the next start anchor', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-23T12:00:00Z') });
  const template = activity({ due_date_offset_days: 1, start_time: '07:00', due_time: '08:00' });
  const monday = occurrence(template, '2026-09-21', { rule: 'FREQ=DAILY;INTERVAL=3', fromCompletion: 1 });
  expireTask(d, monday.id, { now: new Date('2026-09-22T12:00:00Z') });
  assert.equal(successor(monday.id), undefined);
  reopenExpiredTask(d, monday.id, { actorId: 1, body: { expected_revision: read(monday.id).revision, expiration_policy: 'keep_overdue' }, now: new Date('2026-09-23T12:00:00Z') });
  changeTaskStatus(d, monday.id, 'done', { actorId: 1, requireRevision: false, body: { complete_remaining: true }, now: new Date('2026-09-23T12:00:00Z') });
  const next = successor(monday.id);
  assert.equal(next.start_date, '2026-09-26'); assert.equal(next.due_date, '2026-09-27');
  assert.equal(next.recurrence_from_completion, 1);
});

test('NULL legacy Task snapshot retains existing due-anchored recurrence even when its template now has an offset', () => {
  const template = activity({ due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' });
  const monday = occurrence(template, '2026-10-26', { rule: 'FREQ=WEEKLY;BYDAY=MO', expiration: 'keep_overdue' });
  d.prepare('UPDATE tasks SET due_date_offset_days=NULL WHERE id=?').run(monday.id);
  complete(children(monday.id)[0].id, '2026-10-30T11:00:00Z');
  const next = successor(monday.id);
  assert.equal(next.start_date, '2026-10-29'); assert.equal(next.due_date, '2026-11-02'); assert.equal(next.due_date_offset_days, null);
});

test('authorized reopening with a new due date updates only an existing relative snapshot', () => {
  const template = activity();
  const relative = occurrence(template, '2026-09-21', { fromCompletion: 1 });
  expireTask(d, relative.id, { now: new Date('2026-09-21T12:00:00Z') });
  reopenExpiredTask(d, relative.id, { actorId: 1, body: { expected_revision: read(relative.id).revision, due_date: '2026-09-25' }, now: new Date('2026-09-21T12:00:00Z') });
  assert.equal(read(relative.id).due_date_offset_days, 4);
  const legacy = occurrence(template, '2026-09-21', { fromCompletion: 1 });
  d.prepare('UPDATE tasks SET due_date_offset_days=NULL WHERE id=?').run(legacy.id);
  expireTask(d, legacy.id, { now: new Date('2026-09-21T12:00:00Z') });
  reopenExpiredTask(d, legacy.id, { actorId: 1, body: { expected_revision: read(legacy.id).revision, due_date: '2026-09-25' }, now: new Date('2026-09-21T12:00:00Z') });
  assert.equal(read(legacy.id).due_date_offset_days, null);
});

test('workflow preview and creation use the supplied occurrence start and preserve untimed legacy behavior', () => {
  const homework = activity({ name: 'Homework', due_date_offset_days: 4, start_time: '15:30', due_time: '07:30' });
  const untimed = activity({ name: 'Untimed', due_date_offset_days: null, start_time: null, due_time: null });
  const workflow = Number(d.prepare("INSERT INTO workflow_templates(name,created_by,subject_required) VALUES('School week',1,0)").run().lastInsertRowid);
  const step = d.prepare('INSERT INTO workflow_template_steps(workflow_template_id,step_key,activity_template_id,sort_order) VALUES(?,?,?,?)');
  step.run(workflow, 'homework', homework.id, 0); step.run(workflow, 'untimed', untimed.id, 1);
  const preview = previewWorkflow(d, workflow, { startDate: '2026-10-05' });
  assert.equal(preview.steps[0].start_date, '2026-10-05'); assert.equal(preview.steps[0].due_date, '2026-10-09');
  assert.equal(preview.steps[1].start_date, null); assert.equal(preview.steps[1].due_date, '2026-10-05');
  const created = instantiateWorkflow(d, workflow, { startDate: '2026-10-05', createdBy: 1 });
  const generated = d.prepare('SELECT t.* FROM tasks t JOIN workflow_instance_tasks wt ON wt.task_id=t.id WHERE wt.workflow_instance_id=? AND wt.role=? ORDER BY t.id').all(created.id, 'primary');
  assert.equal(generated[0].start_date, '2026-10-05'); assert.equal(generated[0].due_date, '2026-10-09'); assert.equal(generated[0].due_date_offset_days, 4);
  assert.equal(generated[1].start_date, null); assert.equal(generated[1].due_date, '2026-10-05'); assert.equal(generated[1].due_date_offset_days, null);
});
