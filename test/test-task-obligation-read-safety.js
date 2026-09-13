import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'obligation-read-safety-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { recordTaskAssignment, obligationInbox, respondToTaskObligation, overrideTaskAssignment,
  reconcileOverdueTaskObligations } = await import('../server/services/assignment-responsibilities.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { buildInboxRouter } = await import('../server/routes/notification-inbox.js');
const { enqueueNotification } = await import('../server/services/notification-inbox.js');

let d, admin, learner, other;
const app = express(); app.use(express.json());
app.use((req, _res, next) => {
  const actor = d.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user'] || learner));
  req.authUserId = actor.id; req.authRole = actor.role; req.authMethod = 'session';
  req.session = { userId: actor.id, role: actor.role };
  req.sessionID = `obligation-read-${actor.id}`;
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(d, actor)); next();
});
app.use('/api/v1/tasks', tasksRouter); app.use('/api/tasks', tasksRouter);
app.use('/api/v1/automation', automationRouter);
app.use('/api/v1/notifications', buildInboxRouter());
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.closeAllConnections(); server.close(); });
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
    migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version, migration.description);
  }
  _setTestDatabase(d);
  d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
  const user = (name, role = 'member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name, name, role).lastInsertRowid);
  admin = user('Admin', 'admin'); learner = user('Learner'); other = user('Other');
  for (const id of [admin, learner, other]) d.prepare('INSERT INTO sessions(sid,sess,expired_at) VALUES(?,?,?)')
    .run(`obligation-read-${id}`, JSON.stringify({ userId: id }), Date.now() + 60_000);
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });

const NOW = '2030-01-01T12:00:00Z';
function seed(strategy = 'eligible_round_robin', assigned = learner) {
  const activityId = Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,presence_policy,created_by)
    VALUES('Laundry','Laundry',?,?,?,'ignore',?)`).run(strategy, strategy, assigned, admin).lastInsertRowid);
  const taskId = Number(d.prepare(`INSERT INTO tasks(title,description,assigned_to,created_by,due_date,due_time,points,recurrence_rule)
    VALUES('Laundry','Keep learner instructions',?,?,'2026-09-01','23:59',10,'FREQ=WEEKLY;BYDAY=TU')`).run(assigned, admin).lastInsertRowid);
  d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id,subject_user_id) VALUES(?,?,?)').run(taskId, activityId, assigned);
  const member = d.prepare('SELECT * FROM users WHERE id=?').get(assigned);
  const activity = d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId);
  recordTaskAssignment(d, taskId, activity, { primary: member, participants: [member], subject: member, strategy });
  const obligation = d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND role='primary' AND status='pending'").get(taskId);
  // A production-shaped legacy obligation has the already expired Task due date
  // duplicated into its response deadline. Do not depend on the new creation rule.
  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-01T23:59:00' WHERE id=?").run(obligation.id);
  return { taskId, obligationId: obligation.id, activityId };
}
function snapshot() {
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(row => row.name).filter(name => /^(tasks$|task_|planning_obligation|notification_|reward_|activity_rotation)/.test(name));
  return Object.fromEntries(tables.map(name => [name, d.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
const assigned = id => d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to;
const row = id => d.prepare('SELECT * FROM planning_obligations WHERE id=?').get(id);
async function request(path, user = learner, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { 'Content-Type': 'application/json', 'x-user': String(user), ...options.headers } });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}

test('personal and all-household obligation reads leave every assignment, obligation, history and notification row unchanged', () => {
  const own = seed(), someoneElse = seed('eligible_round_robin', other), before = snapshot();
  for (let pass = 0; pass < 5; pass++) {
    assert.ok(obligationInbox(d, learner, { nowAt: NOW }).some(item => item.id === own.obligationId));
    assert.ok(obligationInbox(d, other, { nowAt: NOW }).some(item => item.id === someoneElse.obligationId));
    assert.equal(obligationInbox(d, admin, { includeAll: true, nowAt: NOW }).length, 2);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(assigned(own.taskId), learner); assert.equal(assigned(someoneElse.taskId), other);
});

test('GET obligation inbox, Task lists/details and notification reads cannot consume expired assignments', async () => {
  const x = seed();
  const notice = enqueueNotification(d, { userId: learner, sourceKey: 'read-safe-task', category: 'tasks', entityType: 'task', entityId: x.taskId, title: 'Laundry', body: 'Assigned work' });
  const before = snapshot();
  for (let pass = 0; pass < 3; pass++) {
    for (const [path, actor] of [
      ['/api/v1/automation/obligations', learner], ['/api/v1/automation/obligations', other],
      ['/api/v1/automation/admin/obligations', admin], ['/api/v1/tasks?include_future=1', learner],
      ['/api/tasks?include_future=1', learner], [`/api/v1/tasks/${x.taskId}`, learner],
      [`/api/tasks/${x.taskId}`, learner], [`/api/v1/tasks/${x.taskId}/activity`, learner],
      ['/api/v1/notifications/inbox', learner], [`/api/v1/notifications/inbox/${notice.id}`, learner],
    ]) {
      const result = await request(path, actor); assert.equal(result.status, 200, `${path}: ${result.text}`);
      assert.deepEqual(snapshot(), before, `${path} must be side-effect free`);
    }
  }
});

test('a Task event-stream connection and live-client refreshes cannot reassign overdue work', async () => {
  const x = seed(), before = snapshot(), abort = new AbortController();
  const stream = await fetch(`${base}/api/v1/tasks/changes`, { headers: { 'x-user': String(learner) }, signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const event = new TextDecoder().decode((await reader.read()).value); assert.match(event, /event: change/);
  abort.abort(); await reader.cancel().catch(() => {});
  const source = readFileSync(new URL('../public/utils/task-live.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const sources = [], callbacks = [];
  const events = () => ({ addEventListener() {}, removeEventListener() {} });
  class EventSource {
    constructor() { this.handlers = new Map(); sources.push(this); }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    close() {}
  }
  const context = vm.createContext({ document: events(), window: events(), navigator: { onLine: true }, EventSource,
    auth: { me: async () => {} }, setTimeout: callback => (callbacks.push(callback), callbacks.length), clearTimeout() {} });
  vm.runInContext(`${source}\nthis.subject={watchTaskChanges,latestTaskLoader};`, context);
  let latestLoad, refreshes = 0;
  const loader = context.subject.latestTaskLoader(() => Promise.all([
    request('/api/v1/tasks?include_future=1'), request('/api/v1/automation/obligations'), request(`/api/v1/tasks/${x.taskId}`),
  ]), results => { for (const result of results) assert.equal(result.status, 200); refreshes++; });
  const stop = context.subject.watchTaskChanges(() => { latestLoad = loader.load(); });
  try {
    for (const version of [1, 2, 3, 4]) {
      sources[0].handlers.get('change')({ data: JSON.stringify({ version }) });
      await callbacks.shift()(); await latestLoad; assert.deepEqual(snapshot(), before);
    }
    assert.equal(refreshes, 4); assert.equal(assigned(x.taskId), learner);
  } finally { stop(); loader.dispose(); }
});

test('only explicit reconciliation expires an overdue pending request and gives its replacement a future response window', () => {
  const x = seed(); obligationInbox(d, learner, { nowAt: NOW }); assert.equal(row(x.obligationId).status, 'pending');
  const result = reconcileOverdueTaskObligations(d, { nowAt: NOW, actorUserId: admin });
  assert.equal(result.processed, 1); assert.equal(row(x.obligationId).status, 'timed_out');
  assert.notEqual(assigned(x.taskId), learner);
  const replacement = d.prepare('SELECT * FROM planning_obligations WHERE parent_obligation_id=?').get(x.obligationId);
  assert.ok(replacement); assert.equal(replacement.due_at, row(x.obligationId).due_at);
  assert.equal(Date.parse(replacement.response_deadline) - Date.parse(NOW), 24 * 60 * 60 * 1000);
});

test('repeated reconciliation at the same instant is an exact no-op including notifications and history', () => {
  const x = seed(); reconcileOverdueTaskObligations(d, { nowAt: NOW, actorUserId: admin });
  const before = snapshot(), replacement = assigned(x.taskId);
  for (let pass = 0; pass < 5; pass++) {
    assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW, actorUserId: admin }).processed, 0);
    assert.deepEqual(snapshot(), before); assert.equal(assigned(x.taskId), replacement);
  }
});

for (const policy of ['fixed', 'subject_skill']) {
  test(`${policy} timeout preserves the actual learner, responsibilities, visibility and learner progress`, () => {
    const x = seed(policy);
    const done = Number(d.prepare("INSERT INTO tasks(title,parent_task_id,assigned_to,created_by,status) VALUES('Completed action',?,?,?,'done')").run(x.taskId, learner, admin).lastInsertRowid);
    d.prepare("INSERT INTO tasks(title,parent_task_id,created_by) VALUES('Remaining action',?,?)").run(x.taskId, admin);
    d.prepare('INSERT INTO task_completions(task_id,series_id,user_id) VALUES(?,?,?)').run(done, done, learner);
    d.prepare("INSERT INTO task_comments(task_id,user_id,comment) VALUES(?,?,'Already completed the first step')").run(x.taskId, learner);
    const original = d.prepare('SELECT * FROM tasks WHERE id=?').get(x.taskId);
    const progress = () => ({
      children: d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY id').all(x.taskId),
      completions: d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(done),
      comments: d.prepare('SELECT * FROM task_comments WHERE task_id=?').all(x.taskId),
    });
    const priorProgress = progress();
    const responsibilities = d.prepare('SELECT * FROM task_responsibilities WHERE task_id=? ORDER BY user_id,role').all(x.taskId);
    const visibility = d.prepare('SELECT * FROM task_assignments WHERE task_id=?').all(x.taskId);
    const result = reconcileOverdueTaskObligations(d, { nowAt: NOW, actorUserId: admin });
    assert.equal(result.processed, 1); assert.equal(row(x.obligationId).status, 'timed_out');
    assert.equal(assigned(x.taskId), learner);
    const current = d.prepare('SELECT * FROM tasks WHERE id=?').get(x.taskId);
    for (const field of ['description', 'due_date', 'due_time', 'recurrence_rule', 'points', 'status']) assert.equal(current[field], original[field]);
    assert.deepEqual(progress(), priorProgress);
    assert.deepEqual(d.prepare('SELECT * FROM task_responsibilities WHERE task_id=? ORDER BY user_id,role').all(x.taskId), responsibilities);
    assert.deepEqual(d.prepare('SELECT * FROM task_assignments WHERE task_id=?').all(x.taskId), visibility);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM planning_obligations WHERE parent_obligation_id=?').get(x.obligationId).n, 0);
    const settled = snapshot(); reconcileOverdueTaskObligations(d, { nowAt: NOW }); assert.deepEqual(snapshot(), settled);
  });
  test(`${policy} explicit decline closes the request without silently choosing a different learner`, () => {
    const x = seed(policy); respondToTaskObligation(d, x.obligationId, 'decline', learner);
    assert.equal(row(x.obligationId).status, 'declined'); assert.equal(assigned(x.taskId), learner);
    assert.equal(d.prepare('SELECT COUNT(*) n FROM planning_obligations WHERE parent_obligation_id=?').get(x.obligationId).n, 0);
  });
}

test('accepted requests, completed Tasks and archived Tasks cannot timeout through reconciliation', () => {
  const accepted = seed(), completed = seed(), archived = seed();
  d.prepare("UPDATE planning_obligations SET status='accepted' WHERE id=?").run(accepted.obligationId);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(completed.taskId);
  d.prepare("UPDATE tasks SET archived_at='2029-01-01T00:00:00Z' WHERE id=?").run(archived.taskId);
  const before = snapshot(); assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW }).processed, 0);
  assert.deepEqual(snapshot(), before);
});

test('scoped reconciliation leaves another household member\'s overdue request untouched', () => {
  const own = seed(), another = seed('eligible_round_robin', other);
  assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW, taskIds: [own.taskId] }).processed, 1);
  assert.equal(row(another.obligationId).status, 'pending'); assert.equal(assigned(another.taskId), other);
});

test('overdue open claimable work remains unassigned until somebody explicitly claims it', () => {
  const x = seed();
  const activity = { ...d.prepare('SELECT * FROM activity_templates WHERE id=?').get(x.activityId), assignment_policy: 'open_claimable' };
  d.prepare('UPDATE tasks SET assigned_to=NULL WHERE id=?').run(x.taskId);
  recordTaskAssignment(d, x.taskId, activity, { primary: null, participants: [], strategy: 'open_claimable', eligible: d.prepare('SELECT * FROM users').all() });
  const open = d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND status='pending'").get(x.taskId);
  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-01T23:59:00' WHERE id=?").run(open.id);
  const before = snapshot();
  assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW }).processed, 0);
  assert.deepEqual(snapshot(), before); assert.equal(assigned(x.taskId), null); assert.equal(row(open.id).status, 'pending');
});

test('repeated acceptance is idempotent and does not append repeated obligation history', () => {
  const x = seed(); respondToTaskObligation(d, x.obligationId, 'accept', learner);
  const before = snapshot();
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(respondToTaskObligation(d, x.obligationId, 'accept', learner).status, 'accepted');
    assert.deepEqual(snapshot(), before);
  }
});

test('an accepted request still rechecks current learner qualification before treating acceptance as a no-op', () => {
  const x = seed();
  const skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washing Machine',0,'normal',?)").run(admin).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id,sort_order) VALUES(?,?,0)').run(x.activityId, skill);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'normal','manual',?)").run(learner, skill, admin);
  respondToTaskObligation(d, x.obligationId, 'accept', learner);
  d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id=?").run(learner, skill);
  const before = snapshot();
  assert.throws(() => respondToTaskObligation(d, x.obligationId, 'accept', learner), /skill|permitted|perform|excluded/i);
  assert.deepEqual(snapshot(), before); assert.equal(row(x.obligationId).status, 'accepted');
});

test('replacement preserves a meaningful future custom deadline after an explicit decline', () => {
  const x = seed(); d.prepare("UPDATE planning_obligations SET response_deadline='2099-01-01T10:30:00Z' WHERE id=?").run(x.obligationId);
  const result = respondToTaskObligation(d, x.obligationId, 'decline', learner);
  const replacement = row(result.replacement_obligation_id);
  assert.equal(replacement.response_deadline, '2099-01-01T10:30:00Z');
  assert.equal(replacement.due_at, row(x.obligationId).due_at);
});

test('a deliberately absent response deadline stays absent on replacement', () => {
  const x = seed(); d.prepare('UPDATE planning_obligations SET response_deadline=NULL WHERE id=?').run(x.obligationId);
  const result = respondToTaskObligation(d, x.obligationId, 'decline', learner);
  assert.equal(row(result.replacement_obligation_id).response_deadline, null);
});

test('an expired custom response deadline can use the still meaningful future Task due date', () => {
  const x = seed();
  d.prepare("UPDATE planning_obligations SET due_at='2030-01-03T12:00:00Z',response_deadline='2030-01-01T11:59:59Z' WHERE id=?").run(x.obligationId);
  reconcileOverdueTaskObligations(d, { nowAt: NOW });
  const replacement = d.prepare('SELECT * FROM planning_obligations WHERE parent_obligation_id=?').get(x.obligationId);
  assert.equal(replacement.response_deadline, '2030-01-03T12:00:00Z');
});

test('a stale primary request cannot replace a newer actual Task assignee', () => {
  const x = seed(); d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(other, x.taskId);
  const before = snapshot();
  assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW }).processed, 0);
  assert.deepEqual(snapshot(), before); assert.equal(assigned(x.taskId), other);
});

test('renewed response windows span exactly 24 elapsed hours through both household DST changes', () => {
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  for (const nowAt of ['2026-03-08T06:30:00Z', '2026-11-01T05:30:00Z']) {
    const x = seed();
    d.prepare("UPDATE planning_obligations SET due_at='2020-01-01T23:59:00',response_deadline='2020-01-01T23:59:00' WHERE id=?").run(x.obligationId);
    reconcileOverdueTaskObligations(d, { nowAt, taskIds: [x.taskId] });
    const replacement = d.prepare('SELECT * FROM planning_obligations WHERE parent_obligation_id=?').get(x.obligationId);
    assert.equal(Date.parse(replacement.response_deadline) - Date.parse(nowAt), 24 * 60 * 60 * 1000);
    const before = snapshot();
    const beforeExpiry = new Date(Date.parse(replacement.response_deadline) - 1).toISOString();
    assert.equal(reconcileOverdueTaskObligations(d, { nowAt: beforeExpiry, taskIds: [x.taskId] }).processed, 0);
    assert.deepEqual(snapshot(), before);
  }
});

test('a future custom deadline without an offset uses household timezone and remains intact on replacement', () => {
  const x = seed();
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  d.prepare("UPDATE planning_obligations SET response_deadline='2030-01-01T08:00:00' WHERE id=?").run(x.obligationId);
  const result = respondToTaskObligation(d, x.obligationId, 'decline', learner, null, { nowAt: NOW });
  assert.equal(row(result.replacement_obligation_id).response_deadline, '2030-01-01T08:00:00');
});

test('a manual assignment on a rotating policy remains assigned when its response expires', () => {
  const x = seed(); overrideTaskAssignment(d, x.taskId, learner, admin);
  const request = d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND status='pending' AND role='primary'").get(x.taskId);
  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-01T23:59:00' WHERE id=?").run(request.id);
  const beforeResponsibilities = d.prepare('SELECT * FROM task_responsibilities WHERE task_id=? ORDER BY user_id,role').all(x.taskId);
  assert.equal(reconcileOverdueTaskObligations(d, { nowAt: NOW }).processed, 1);
  assert.equal(assigned(x.taskId), learner); assert.equal(row(request.id).status, 'timed_out');
  assert.deepEqual(d.prepare('SELECT * FROM task_responsibilities WHERE task_id=? ORDER BY user_id,role').all(x.taskId), beforeResponsibilities);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM planning_obligations WHERE parent_obligation_id=?').get(request.id).n, 0);
});

test('explicit admin reconciliation is the only HTTP expiry command, requires fresh revisions, and is idempotent', async () => {
  const x = seed(), path = '/api/v1/automation/admin/obligations/reconcile';
  const revision = () => d.prepare('SELECT revision FROM tasks WHERE id=?').get(x.taskId).revision;
  const body = () => ({ task_ids: [x.taskId], expected_revisions: { [x.taskId]: revision() } });
  const before = snapshot();
  assert.equal((await request(path, admin)).status, 404); assert.deepEqual(snapshot(), before);
  for (const alternate of [path, `${path}/`, path.toUpperCase()]) {
    assert.equal((await request(alternate, learner, { method: 'POST', body: JSON.stringify(body()) })).status, 403);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal((await request(path, admin, { method: 'POST', body: JSON.stringify({ task_ids: [x.taskId] }) })).status, 428);
  assert.equal((await request(path, admin, { method: 'POST', body: JSON.stringify({ ...body(), expected_revisions: { [x.taskId]: revision() - 1 } }) })).status, 409);
  assert.deepEqual(snapshot(), before);
  const applied = await request(path, admin, { method: 'POST', body: JSON.stringify(body()) });
  assert.equal(applied.status, 200, applied.text); assert.equal(applied.data.data.processed, 1);
  assert.notEqual(assigned(x.taskId), learner);
  const after = snapshot();
  for (let pass = 0; pass < 3; pass++) {
    const repeated = await request(path, admin, { method: 'POST', body: JSON.stringify(body()) });
    assert.equal(repeated.status, 200, repeated.text); assert.equal(repeated.data.data.processed, 0);
    assert.deepEqual(snapshot(), after);
  }
});

test('admin reconciliation validates every Task revision before mutating any selected Task', async () => {
  const first = seed(), second = seed(), before = snapshot();
  const revision = id => d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
  const response = await request('/api/v1/automation/admin/obligations/reconcile', admin, { method: 'POST', body: JSON.stringify({
    task_ids: [first.taskId, second.taskId], expected_revisions: { [first.taskId]: revision(first.taskId), [second.taskId]: revision(second.taskId) - 1 },
  }) });
  assert.equal(response.status, 409, response.text); assert.deepEqual(snapshot(), before);
});

test('admin reconciliation of a subtask also requires its parent revision', async () => {
  const parent = seed('fixed'), child = seed('fixed'); d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(parent.taskId, child.taskId);
  const revision = id => d.prepare('SELECT revision FROM tasks WHERE id=?').get(id).revision;
  const body = { task_ids: [child.taskId], expected_revisions: { [child.taskId]: revision(child.taskId) } }, before = snapshot();
  const path = '/api/v1/automation/admin/obligations/reconcile';
  assert.equal((await request(path, admin, { method: 'POST', body: JSON.stringify(body) })).status, 428);
  body.expected_parent_revisions = { [child.taskId]: revision(parent.taskId) - 1 };
  assert.equal((await request(path, admin, { method: 'POST', body: JSON.stringify(body) })).status, 409);
  assert.deepEqual(snapshot(), before);
  body.expected_parent_revisions[child.taskId] = revision(parent.taskId);
  const response = await request(path, admin, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 200, response.text); assert.equal(response.data.data.processed, 1);
  assert.equal(assigned(child.taskId), learner);
});
