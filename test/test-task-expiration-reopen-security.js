import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'expiration-reopen-security-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { expireTask, reopenExpiredTask } = await import('../server/services/task-lifecycle.js');
const { reconcileTaskExpirations } = await import('../server/services/task-expiration.js');
const { reconcileTaskSupervision, inspectTaskSupervision } = await import('../server/services/task-supervision.js');
const { claimTask } = await import('../server/services/assignment-responsibilities.js');
const { setTaskSkills } = await import('../server/services/task-skills.js');
const { replaceSubjectPermissions } = await import('../server/permissions.js');
const { RESTRICTED_MEMBER_CAPABILITIES } = await import('../server/task-capabilities.js');

let d, admin, editor, learner, helper, other, server, base;
const deadline = new Date('2026-09-14T12:00:00Z');
const read = id => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const count = (sql, ...args) => d.prepare(sql).get(...args).n;
const successors = id => d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(id);
function seed(extra = {}) {
  const row = { title: 'Morning occurrence', created_by: admin, assigned_to: learner,
    start_date: '2026-09-14', start_time: '07:00', due_date: '2026-09-14', due_time: '08:00',
    expiration_policy: 'expire_incomplete', points: 2, ...extra };
  return Number(d.prepare(`INSERT INTO tasks(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`)
    .run(...Object.values(row)).lastInsertRowid);
}
function reopen(id, body = {}, actorId = admin) {
  const task = read(id);
  return reopenExpiredTask(d, id, { actorId, now: deadline, body: {
    expected_revision: task.revision,
    ...(task.parent_task_id ? { expected_parent_revision: read(task.parent_task_id).revision } : {}), ...body,
  } });
}
async function request(method, id, body, actorId = admin) {
  const response = await fetch(`${base}/${id}`, { method, headers: { 'Content-Type': 'application/json', 'x-user': String(actorId) },
    body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const actor = d.prepare('SELECT id,role FROM users WHERE id=?').get(Number(req.headers['x-user']) || admin);
    req.authUserId = actor.id; req.authRole = actor.role; req.session = { userId: actor.id, role: actor.role }; next();
  });
  app.use('/tasks', tasksRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/tasks`;
});
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  for (const migration of ALL_MIGRATIONS) {
    if (migration.foreignKeysOff) d.pragma('foreign_keys=OFF');
    d.transaction(() => { typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up); migration.afterUp?.(d); })();
    if (migration.foreignKeysOff) d.pragma('foreign_keys=ON');
  }
  _setTestDatabase(d);
  const user = (name, role = 'member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')")
    .run(name, name, role).lastInsertRowid);
  admin = user('Administrator', 'admin'); editor = user('Limited editor'); learner = user('Learner'); helper = user('Helper'); other = user('Other member');
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
test.after(() => { server.closeAllConnections(); server.close(); });

test('explicit reopening restores claimable assignment context and allows a fresh eligible claim', () => {
  const id = seed({ assigned_to: null });
  d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state,source) VALUES(?,'open_claimable','open','planning_context')").run(id);
  d.prepare('INSERT INTO task_claim_eligibility(task_id,user_id) VALUES(?,?)').run(id, learner);
  expireTask(d, id, { now: deadline });
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'cancelled');
  reopen(id, { expiration_policy: 'keep_overdue' });
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'open');
  assert.doesNotThrow(() => claimTask(d, id, learner));
  assert.equal(read(id).assigned_to, learner);
  assert.equal(d.prepare('SELECT state FROM task_assignment_context WHERE task_id=?').get(id).state, 'assigned');
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'), 0);
});

test('reopening rejects malformed and nonexistent local deadlines through the service and leaves history intact', () => {
  const id = seed(); expireTask(d, id, { now: deadline });
  const before = read(id);
  for (const body of [
    { due_date: 'tomorrow' }, { due_date: '2099-02-30' }, { due_date: '2099-15-01' },
    { due_date: '2099-09-15', due_time: '25:00' }, { due_date: '2099-09-15', due_time: '08:99' },
    { due_date: '2026-09-14', due_time: '06:59', expiration_policy: 'keep_overdue' },
  ]) {
    assert.throws(() => reopen(id, body), error => error.status === 400, JSON.stringify(body));
    assert.deepEqual(read(id), before, 'failed reopen must leave occurrence and revision unchanged');
  }
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='reopened'", id), 0);
});

test('a parent editor cannot reactivate an independently private child they cannot edit', async () => {
  replaceSubjectPermissions(d, 'user', editor, { capabilities: { ...RESTRICTED_MEMBER_CAPABILITIES,
    'tasks.edit_own': 'allow', 'tasks.change_dates': 'allow',
  } });
  const parent = seed({ created_by: editor, assigned_to: editor });
  const child = seed({ title: 'Independent private child', created_by: other, assigned_to: other,
    parent_task_id: parent, visibility: 'private', expiration_policy: 'keep_overdue' });
  expireTask(d, parent, { now: deadline });
  const parentBefore = read(parent), childBefore = read(child);
  const response = await request('POST', `${parent}/reopen`, {
    expected_revision: parentBefore.revision, expiration_policy: 'keep_overdue',
  }, editor);
  assert.ok([403,404].includes(response.status), JSON.stringify(response));
  assert.deepEqual(read(parent), parentBefore); assert.deepEqual(read(child), childBefore);
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE event_type='reopened'"), 0);
});

test('future-deadline reopen advances inherited checklist and helper windows while preserving independent dates', () => {
  const parent = seed();
  const child = seed({ title: 'Supervised morning step', parent_task_id: parent, assigned_to: null,
    points: 0, expiration_policy: 'keep_overdue' });
  const independent = seed({ title: 'Independently dated action', parent_task_id: parent, assigned_to: null,
    points: 0, due_date: '2026-09-16', expiration_policy: 'keep_overdue' });
  const skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Morning step',0,'normal',?)").run(admin).lastInsertRowid);
  for (const [userId, proficiency] of [[learner, 'supervised'], [helper, 'normal'], [admin, 'excluded'], [editor, 'excluded'], [other, 'excluded']]) {
    d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(userId, skill, proficiency, admin);
  }
  setTaskSkills(d, child, [skill]);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(parent);
  d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at) VALUES(?,'explicit','busy','2026-09-14T00:00:00','2026-09-16T00:00:00')").run(helper);
  d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at) VALUES(?,'explicit','available','2026-09-15T07:00:00','2026-09-15T09:00:00')").run(helper);
  const original = reconcileTaskSupervision(d, parent);
  assert.equal(original.state, 'needed', 'no helper is available in the original Monday window');
  expireTask(d, parent, { now: deadline });
  reopen(parent, { due_date: '2026-09-15', due_time: '08:00' });
  assert.equal(read(child).due_date, '2026-09-15');
  assert.equal(read(child).start_time, '07:00');
  assert.equal(read(independent).due_date, '2026-09-16');
  const view = inspectTaskSupervision(d, parent);
  assert.equal(view.state, 'assigned'); assert.equal(view.supervisor_user_id, helper);
  assert.equal(view.support_task_id, original.support_task_id);
  for (const id of [view.support_task_id, view.actions[0].counterpart_task_id]) {
    assert.equal(read(id).due_date, '2026-09-15'); assert.equal(read(id).due_time, '08:00');
  }
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger'), 0);
});

test('PUT cannot launder a passed deadline by moving it or changing policy before completion', async () => {
  for (const change of [
    { expiration_policy: 'keep_overdue', status: 'done' },
    { due_date: '2099-09-15', status: 'done' },
    { expiration_policy: 'keep_overdue' },
    { due_date: '2099-09-15' },
  ]) {
    // The persisted row is still open: this models the interval before the
    // background worker observes the elapsed deadline.
    const id = seed({ start_date: '2000-01-03', due_date: '2000-01-03' });
    const before = read(id);
    const response = await request('PUT', id, { expected_revision: before.revision, ...change });
    assert.equal(response.status, 409, JSON.stringify(response));
    assert.notEqual(read(id).status, 'done');
    assert.equal(read(id).due_date, before.due_date);
    assert.equal(read(id).expiration_policy, before.expiration_policy);
    assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?', id), 0);
  }
});

test('successor materialization failure preserves expiration and retries fairly past exhausted frontiers', () => {
  const ended = seed({is_recurring:1,recurrence_rule:'FREQ=DAILY;UNTIL=20260914'});
  reconcileTaskExpirations(d,{now:deadline});
  assert.equal(read(ended).status,'expired');assert.equal(successors(ended).length,0);
  const id = seed({ is_recurring: 1, recurrence_rule: 'FREQ=DAILY' });
  d.exec(`CREATE TRIGGER fail_expiration_successor BEFORE INSERT ON tasks
    WHEN NEW.recurrence_origin_id=${id} BEGIN SELECT RAISE(ABORT,'temporary successor failure'); END`);
  const errors = [];
  reconcileTaskExpirations(d, { now: deadline, onError: (error, taskId) => errors.push({ error, taskId }) });
  assert.equal(read(id).status, 'expired', 'successor failure must not return the original occurrence to Active/Overdue');
  assert.equal(successors(id).length, 0);
  assert.ok(errors.length, 'the background failure remains visible for retry/diagnosis');
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='expired'", id), 1);
  assert.equal(count('SELECT COUNT(*) n FROM task_completions WHERE task_id=?', id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?', id), 0);
  d.exec('DROP TRIGGER fail_expiration_successor');
  const retry = reconcileTaskExpirations(d, { now: deadline, maxOccurrences:1, onError: error => { throw error; } });
  assert.equal(retry.failed, 0);
  assert.equal(successors(id).length, 1); assert.equal(successors(id)[0].due_date, '2026-09-15');
  assert.equal(successors(id)[0].points, 2); assert.equal(successors(id)[0].status, 'open');
  const version = d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  reconcileTaskExpirations(d, { now: deadline, onError: error => { throw error; } });
  assert.equal(successors(id).length, 1);
  assert.equal(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version, version);
  assert.equal(count("SELECT COUNT(*) n FROM task_activity_events WHERE action_task_id=? AND event_type='expired'", id), 1);
});
