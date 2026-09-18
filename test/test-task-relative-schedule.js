import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'isolated-relative-task-schedule';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');
let d, parent, learner, server, base;

test.beforeEach(async () => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  for (const migration of ALL_MIGRATIONS) {
    if (migration.foreignKeysOff) d.pragma('foreign_keys=OFF');
    d.transaction(() => { typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up); migration.afterUp?.(d); })();
    if (migration.foreignKeysOff) d.pragma('foreign_keys=ON');
  }
  _setTestDatabase(d);
  parent = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('parent','Parent','x','admin','parent')").run().lastInsertRowid);
  learner = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES('eleanor','Eleanor','x','member','child')").run().lastInsertRowid);
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.authUserId = parent; req.authRole = 'admin'; req.session = { userId: parent, role: 'admin' }; next(); });
  app.use('/tasks', tasksRouter); app.use('/automation', automationRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); _setTestDatabase(null); d.close(); });
async function call(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...await response.json() };
}
async function template(extra = {}) {
  const result = await call('POST', '/automation/admin/activity-templates', {
    name: "Eleanor's Weekly Homework", title_template: "Eleanor's Weekly Homework", assignment_strategy: 'fixed', fixed_user_id: learner,
    presence_policy: 'ignore', start_time: '15:30', due_time: '07:30', due_date_offset_days: 4,
    points: 5, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', ...extra,
  });
  assert.equal(result.status, 201, JSON.stringify(result)); return result.data;
}
const read = id => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const window = task => [task.start_date, task.start_time, task.due_date, task.due_time, task.due_date_offset_days];

test('template Task resolves its concrete Monday start to Friday and saves a frozen relative span', async () => {
  const activity = await template();
  const result = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-09-21' });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.deepEqual(window(read(result.data.id)), ['2026-09-21', '15:30', '2026-09-25', '07:30', 4]);
  assert.equal(result.data.assigned_to, learner); assert.equal(result.data.points, 5);
  assert.equal(result.data.recurrence_rule, 'FREQ=WEEKLY;BYDAY=MO');
});

test('explicit Task date/time overrides win and freeze their actual span without editing the template', async () => {
  const activity = await template();
  const result = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-09-21', due_date: '2026-09-26', start_time: '16:00', due_time: '09:00' });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.deepEqual(window(read(result.data.id)), ['2026-09-21', '16:00', '2026-09-26', '09:00', 5]);
  assert.equal(d.prepare('SELECT due_date_offset_days FROM activity_templates WHERE id=?').get(activity.id).due_date_offset_days, 4);
  const updated = await call('PUT', `/tasks/${result.data.id}`, { expected_revision: read(result.data.id).revision, start_date: '2026-09-28', due_date: '2026-10-02' });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.deepEqual(window(read(result.data.id)), ['2026-09-28', '16:00', '2026-10-02', '09:00', 4]);
});

test('relative scheduling requires a supplied start when a due date needs resolving, without inventing today', async () => {
  const activity = await template({ start_time: null, due_time: null });
  const result = await call('POST', '/tasks', { activity_template_id: activity.id });
  assert.equal(result.status, 400); assert.match(result.error, /Start Date/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n, 0);
});

test('explicit null concrete due and time remain unset instead of being silently inherited', async () => {
  const activity = await template();
  const result = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-09-21', due_date: null, due_time: null, is_recurring: 0, recurrence_rule: null });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.deepEqual(window(read(result.data.id)), ['2026-09-21', '15:30', null, null, null]);
});

test('blank/manual Task keeps legacy concrete scheduling and cannot forge its internal recurrence mode', async () => {
  const result = await call('POST', '/tasks', { title: 'Manual window', assigned_to: learner,
    start_date: '2026-09-21', due_date: '2026-09-25', due_date_offset_days: 4 });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(read(result.data.id).due_date_offset_days, null);
  const updated = await call('PUT', `/tasks/${result.data.id}`, { expected_revision: read(result.data.id).revision, due_date_offset_days: 99, due_date: '2026-09-26' });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.equal(read(result.data.id).due_date_offset_days, null);
  assert.equal(read(result.data.id).due_date, '2026-09-26');
});

test('changing a reusable template cannot change an existing concrete window or snapshot', async () => {
  const activity = await template();
  const result = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-10-26' });
  assert.equal(result.status, 201, JSON.stringify(result));
  const before = window(read(result.data.id));
  const updated = await call('PUT', `/automation/admin/activity-templates/${activity.id}`, { due_date_offset_days: 2 });
  assert.equal(updated.status, 200, JSON.stringify(updated));
  assert.deepEqual(window(read(result.data.id)), before);
});

test('untimed reusable templates preserve empty Task scheduling and explicit recurring windows keep legacy mode', async () => {
  const activity = await template({ start_time: null, due_time: null, due_date_offset_days: null, recurrence_rule: null });
  const result = await call('POST', '/tasks', { activity_template_id: activity.id });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.deepEqual(window(read(result.data.id)), [null, null, null, null, null]);
  const windowed = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-09-21', due_date: '2026-09-25', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY' });
  assert.equal(windowed.status, 201, JSON.stringify(windowed)); assert.equal(read(windowed.data.id).due_date_offset_days, null);
});

test('clearing either concrete date boundary ends relative recurrence and restoring dates keeps legacy mode', async () => {
  const activity = await template();
  for (const boundary of ['start_date', 'due_date']) {
    const result = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-09-21' });
    assert.equal(result.status, 201, JSON.stringify(result));
    const id = result.data.id;
    const cleared = await call('PUT', `/tasks/${id}`, { expected_revision: read(id).revision,
      [boundary]: null, ...(boundary === 'start_date' ? { start_time: null } : {}) });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    assert.equal(read(id)[boundary], null); assert.equal(read(id).due_date_offset_days, null);
    const restored = await call('PUT', `/tasks/${id}`, { expected_revision: read(id).revision,
      start_date: '2026-09-21', start_time: '15:30', due_date: '2026-09-25' });
    assert.equal(restored.status, 200, JSON.stringify(restored));
    assert.equal(read(id).due_date_offset_days, null, 'restoring dates does not silently re-enable relative recurrence');
  }
});

async function relativeForGroup(activity, dates = {}) {
  const created = await call('POST', '/tasks', { activity_template_id: activity.id, start_date: '2026-10-26', ...dates });
  assert.equal(created.status, 201, JSON.stringify(created)); return created.data.id;
}
const groupFields = (slot, group = 'Relative chores') => ({
  assignment_mode: 'round_robin', rotation_user_ids: [parent, learner], rotation_group: group, rotation_slot: slot,
});
async function joinRelative(id, slot, extra = {}) {
  const current=(await call('GET',`/tasks/${id}`)).data;
  return call('PUT', `/tasks/${id}`, { expected_revision: read(id).revision, activity_template_id: null,
    edit_scope:'future',expected_series_revision:current.recurrence_series_revision,
    ...groupFields(slot), ...extra });
}

test('detached relative occurrences cannot join a legacy cohort with matching deadlines but a different recurrence anchor', async () => {
  const activity = await template();
  const legacy = await call('POST', '/tasks', { title: 'Legacy chore', start_date: '2026-10-26', due_date: '2026-10-30',
    due_time: '07:30', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', ...groupFields(0) });
  assert.equal(legacy.status, 201, JSON.stringify(legacy));
  const id = await relativeForGroup(activity);
  const joined = await joinRelative(id, 1);
  assert.equal(joined.status, 400); assert.match(joined.error, /same relative start and due schedule/);
  assert.equal(read(id).rotation_group, null); assert.equal(read(id).due_date_offset_days, 4);
});

test('a new legacy Task cannot join an existing relative cohort and incompatible relative spans cannot join either', async () => {
  const activity = await template();
  const first = await relativeForGroup(activity);
  assert.equal((await joinRelative(first, 0)).status, 200);
  const legacy = await call('POST', '/tasks', { title: 'Legacy chore', start_date: '2026-10-26', due_date: '2026-10-30',
    due_time: '07:30', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', ...groupFields(1) });
  assert.equal(legacy.status, 400); assert.match(legacy.error, /same relative start and due schedule/);
  const different = await relativeForGroup(activity, { start_date: '2026-10-27', due_date: '2026-10-30' });
  const joined = await joinRelative(different, 1);
  assert.equal(joined.status, 400); assert.match(joined.error, /same relative start and due schedule/);
  assert.equal(read(different).rotation_group, null);
});

test('matching relative cohorts advance together from Monday starts to Friday deadlines and reject divergent date edits', async () => {
  const activity = await template();
  const first = await relativeForGroup(activity), second = await relativeForGroup(activity);
  assert.equal((await joinRelative(first, 0)).status, 200);
  assert.equal((await joinRelative(second, 1)).status, 200);
  const edited = await call('PUT', `/tasks/${second}`, { expected_revision: read(second).revision, start_date: '2026-10-27' });
  assert.equal(edited.status, 400); assert.match(edited.error, /same relative start and due schedule/);
  for (const id of [first, second]) changeTaskStatus(d, id, 'done', {
    actorId: parent, requireRevision: false, now: new Date('2026-10-30T11:00:00Z'),
  });
  const successors = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id IN (?,?) ORDER BY rotation_slot').all(first, second);
  assert.equal(successors.length, 2);
  assert.deepEqual(successors.map(row => [row.start_date, row.due_date, row.due_date_offset_days]),
    [['2026-11-02', '2026-11-06', 4], ['2026-11-02', '2026-11-06', 4]]);
  assert.deepEqual(successors.map(row => row.assigned_to), [learner, parent]);
});

test('legacy rotation cohorts retain different concrete Start Date lead-ins', async () => {
  for (const [slot, start] of [[0, '2026-10-26'], [1, '2026-10-27']]) {
    const created = await call('POST', '/tasks', { title: `Legacy chore ${slot}`, start_date: start, due_date: '2026-10-30',
      due_time: '07:30', is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO', ...groupFields(slot) });
    assert.equal(created.status, 201, JSON.stringify(created)); assert.equal(read(created.data.id).due_date_offset_days, null);
  }
});
