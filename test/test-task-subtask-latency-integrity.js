import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'subtask-latency-integrity-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { reconcileTaskSupervision, inspectTaskSupervision } = await import('../server/services/task-supervision.js');
const { setTaskSkills } = await import('../server/services/task-skills.js');

let d, server, base, admin, learner, helper, supervisedSkill, delegatedSkill;
test.beforeEach(async () => {
  d = new Database(':memory:'); d.pragma('foreign_keys = ON');
  for (const migration of ALL_MIGRATIONS) {
    typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
    migration.afterUp?.(d);
  }
  _setTestDatabase(d);
  const user = (name, role, family) => Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
    VALUES(?,?,'x',?,?)`).run(name, name, role, family).lastInsertRowid);
  admin = user('Parent', 'admin', 'parent');
  learner = user('Learner', 'member', 'child');
  helper = user('Helper', 'member', 'parent');
  const skill = name => Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)")
    .run(name, admin).lastInsertRowid);
  supervisedSkill = skill('Sorting'); delegatedSkill = skill('Washing Machine');
  for (const id of [supervisedSkill, delegatedSkill]) {
    proficiency(admin, id, 'excluded'); proficiency(helper, id, 'normal');
  }
  proficiency(learner, supervisedSkill, 'supervised'); proficiency(learner, delegatedSkill, 'excluded');
  for (const id of [learner, helper]) d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    req.authUserId = Number(req.get('X-Actor') || admin);
    req.authRole = d.prepare('SELECT role FROM users WHERE id=?').get(req.authUserId)?.role;
    req.session = { userId: req.authUserId }; next();
  });
  app.use('/api/v1/tasks', tasksRouter); app.use('/api/tasks', tasksRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterEach(() => { server?.closeAllConnections(); server?.close(); _setTestDatabase(null); d?.close(); });

function proficiency(userId, skillId, value) {
  d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
    VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`)
    .run(userId, skillId, value, admin);
}
function task(title, parent = null, points = 0) {
  const id = Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,points,due_date,due_time)
    VALUES(?,?,?,?,?,'2099-01-03','12:00')`).run(title, admin, parent ? null : learner, parent, points).lastInsertRowid);
  if (!parent) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, learner);
  return id;
}
function routine({ mixed = false, recurring = false } = {}) {
  const root = task('Laundry', null, 20), first = task('Gather laundry', root, 2);
  const last = task('Put laundry away', root, 3);
  const result = { root, first, last };
  if (mixed) {
    result.supervised = task('Sort laundry', root, 4); setTaskSkills(d, result.supervised, [supervisedSkill]);
    result.delegated = task('Load washer', root, 7); setTaskSkills(d, result.delegated, [delegatedSkill]);
  }
  if (recurring) d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',assignment_mode='fixed' WHERE id=?").run(root);
  reconcileTaskSupervision(d, root);
  return result;
}
async function call(method, path, body, actor = admin, prefix = '/api/v1/tasks') {
  const response = await fetch(base + prefix + path, { method,
    headers: { 'Content-Type': 'application/json', 'X-Actor': String(actor) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { http: response.status, ...await response.json() };
}
async function read(id, actor = admin) {
  const response = await call('GET', `/${id}`, undefined, actor);
  assert.equal(response.http, 200, JSON.stringify(response)); return response.data;
}
const revision = row => ({ expected_revision: row.revision,
  ...(row.parent_revision ? { expected_parent_revision: row.parent_revision } : {}) });
const change = (row, status, actor = admin, extra = {}, prefix) =>
  call('PATCH', `/${row.id}/status`, { status, ...revision(row), ...extra }, actor, prefix);
const status = id => d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;
const events = (id, type) => d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? AND event_type=? ORDER BY id').all(id, type);
const earnings = id => d.prepare("SELECT user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY user_id").all(id);
const mapping = (root, id) => inspectTaskSupervision(d, root).actions.find(action => action.action_task_id === id);

test('helper completion response includes the current authorized helper checklist and source parent', async () => {
  const x = routine({ mixed: true }), action = mapping(x.root, x.supervised);
  const before = await read(action.counterpart_task_id, helper);
  const response = await change(before, 'done', helper);
  assert.equal(response.http, 200, JSON.stringify(response));
  assert.equal(response.data.status, 'done');
  assert.equal(response.data.parent_task.id, x.root);
  assert.equal(response.data.projection_parent_task.id, before.parent_task_id);
  const projection = response.data.projection_parent_task;
  assert.equal(projection.status, 'in_progress');
  assert.equal(projection.subtasks.find(row => row.id === action.counterpart_task_id).status, 'done');
  assert.equal(projection.subtask_done, 1);
  assert.equal(projection.subtask_total, 2);
  const {documents, document_count, ...freshOperational} = await read(projection.id, helper);
  assert.deepEqual(projection, freshOperational, 'response includes the fresh canonical operational projection');
});

test('helper response does not hydrate an inaccessible learner parent', async () => {
  const x = routine({ mixed: true }), action = mapping(x.root, x.supervised);
  d.prepare("UPDATE tasks SET visibility='private',title='Private learner title' WHERE id=?").run(x.root);
  // Changing a source parent's visibility does not silently rewrite the
  // visibility of existing independently shared actions or helper container.
  assert.equal((await call('GET', `/${x.root}`, undefined, helper)).http, 404);
  const response = await change(await read(action.counterpart_task_id, helper), 'done', helper);
  assert.equal(response.http, 200, JSON.stringify(response));
  assert.equal(response.data.parent_task, undefined);
  assert.ok(response.data.projection_parent_task);
  assert.ok(!JSON.stringify(response.data).includes('Private learner title'));
});

test('helper completion cannot expose a private helper container and ordinary actions gain no extra parent', async () => {
  const x = routine({ mixed: true }), action = mapping(x.root, x.supervised);
  const supportId = inspectTaskSupervision(d, x.root).support_task_id;
  d.prepare("UPDATE tasks SET visibility='private',title='Private helper title' WHERE id=?").run(supportId);
  assert.equal((await call('GET', `/${supportId}`, undefined, helper)).http, 404);
  const response = await change(await read(action.counterpart_task_id, helper), 'done', helper);
  assert.equal(response.http, 200, JSON.stringify(response));
  assert.equal(response.data.projection_parent_task, undefined);
  assert.ok(!JSON.stringify(response.data).includes('Private helper title'));
  const ordinary = await change(await read(x.first, learner), 'done', learner);
  assert.equal(ordinary.http, 200, JSON.stringify(ordinary));
  assert.equal(ordinary.data.parent_task.id, x.root);
  assert.equal(ordinary.data.projection_parent_task, undefined);
});

function mutationSnapshot() {
  return Object.fromEntries(['tasks', 'task_supervision_actions', 'task_activity_events', 'reward_ledger', 'task_completions',
    'notification_inbox', 'notification_inbox_deliveries']
    .map(table => [table, d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('rapid duplicate completion requests produce one first-step transition, one reward and one parent start', async () => {
  const x = routine(), before = await read(x.first);
  const results = await Promise.all([change(before, 'done', learner), change(before, 'done', learner)]);
  assert.deepEqual(results.map(result => result.http).sort(), [200, 409]);
  assert.equal(results.find(result => result.http === 409).reason, 'stale_revision');
  assert.equal(status(x.first), 'done'); assert.equal(status(x.root), 'in_progress');
  assert.equal(events(x.first, 'completed').length, 1); assert.equal(events(x.root, 'started').length, 1);
  assert.deepEqual(earnings(x.first), [{ user_id: learner, delta: 2 }]);
  const snapshot = mutationSnapshot();
  assert.equal((await change(await read(x.first), 'done', learner)).http, 200);
  assert.deepEqual(mutationSnapshot(), snapshot, 'acknowledging the already completed state must not create another effect');
});

test('two clients completing and reopening the same action cannot overwrite the winning snapshot', async () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const x = routine(), before = await read(x.first);
    const requests = [() => change(before, 'done', learner), () => change(before, 'in_progress', learner, {}, '/api/tasks')];
    if (attempt % 2) requests.reverse();
    const results = await Promise.all(requests.map(request => request()));
    assert.deepEqual(results.map(result => result.http).sort(), [200, 409]);
    const winner = results.find(result => result.http === 200);
    assert.equal(status(x.first), winner.data.status);
    assert.equal(earnings(x.first).length, winner.data.status === 'done' ? 1 : 0);
    assert.equal(events(x.first, 'completed').length, winner.data.status === 'done' ? 1 : 0);
    const fresh = await read(x.first), reopening = await change(fresh, 'in_progress', learner);
    assert.equal(reopening.http, 200); assert.equal(status(x.first), 'in_progress'); assert.deepEqual(earnings(x.first), []);
  }
});

test('a parent reset rejects a completion dispatched with the previous child and parent revisions without resurrection', async () => {
  const x = routine(); assert.equal((await change(await read(x.first), 'done', learner)).http, 200);
  const stale = await read(x.last), root = await read(x.root);
  assert.equal((await change(root, 'open', learner, { reset_progress: true })).http, 200);
  const snapshot = mutationSnapshot();
  const rejected = await change(stale, 'done', learner);
  assert.equal(rejected.http, 409); assert.equal(rejected.reason, 'stale_revision');
  assert.deepEqual(mutationSnapshot(), snapshot);
  assert.equal(status(x.root), 'open'); assert.equal(status(x.first), 'open'); assert.equal(status(x.last), 'open');
});

test('source and linked helper completion racing produce one shared supervised completion and no duplicate reward', async () => {
  const x = routine({ mixed: true }), action = mapping(x.root, x.supervised);
  const [source, counterpart] = await Promise.all([read(x.supervised, helper), read(action.counterpart_task_id, helper)]);
  const results = await Promise.all([change(source, 'done', helper), change(counterpart, 'done', helper)]);
  assert.deepEqual(results.map(result => result.http).sort(), [200, 409]);
  assert.equal(status(x.supervised), 'done'); assert.equal(status(action.counterpart_task_id), 'done');
  assert.equal(events(x.supervised, 'completed').length, 1);
  assert.deepEqual(earnings(x.supervised), [{ user_id: learner, delta: 4 }]);
  assert.deepEqual(earnings(action.counterpart_task_id), []);
  assert.equal(inspectTaskSupervision(d, x.root).supervisor_user_id, helper);
});

test('current supervision rejection rolls back all tentative reconciliation, reward and history changes', async () => {
  const x = routine({ mixed: true });
  for (const id of [x.supervised, x.delegated]) {
    const snapshot = mutationSnapshot(), denied = await change(await read(id), 'done', learner);
    assert.ok([403, 409].includes(denied.http), JSON.stringify(denied));
    assert.deepEqual(mutationSnapshot(), snapshot);
  }
  const action = mapping(x.root, x.supervised), rendered = await read(action.counterpart_task_id, helper);
  proficiency(helper, delegatedSkill, 'excluded');
  const snapshot = mutationSnapshot(), rejected = await change(rendered, 'done', helper);
  assert.equal(rejected.http, 409); assert.match(rejected.error, /single|supervisor|helper/i);
  assert.deepEqual(mutationSnapshot(), snapshot);
  assert.equal(status(x.supervised), 'open');
});

test('duplicate final delegated completion commits one occurrence and recurrence, keeping learner and helper rewards distinct', async () => {
  const x = routine({ mixed: true, recurring: true });
  for (const id of [x.first, x.last]) assert.equal((await change(await read(id), 'done', learner)).http, 200);
  let action = mapping(x.root, x.supervised);
  assert.equal((await change(await read(action.counterpart_task_id), 'done', helper)).http, 200);
  const waiting = await read(x.root, learner);
  assert.equal(waiting.status, 'in_progress'); assert.equal(waiting.subtask_total, waiting.subtask_done);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.root).n, 0);
  action = mapping(x.root, x.delegated);
  const before = await read(action.counterpart_task_id, helper);
  const results = await Promise.all([change(before, 'done', helper), change(before, 'done', helper)]);
  assert.deepEqual(results.map(result => result.http).sort(), [200, 409]);
  assert.equal(status(x.root), 'done'); assert.equal(status(x.delegated), 'done');
  assert.equal(status(action.counterpart_task_id), 'done');
  assert.equal(events(x.delegated, 'completed').length, 1); assert.equal(events(x.root, 'completed').length, 1);
  assert.deepEqual(earnings(x.delegated), [{ user_id: helper, delta: 7 }]);
  assert.deepEqual(earnings(x.root), [{ user_id: learner, delta: 20 }]);
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(x.root);
  assert.equal(next.length, 1); assert.equal(next[0].due_date, '2099-01-10'); assert.equal(next[0].assigned_to, learner);
  assert.equal(next[0].status, 'open');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.root).n, 1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(next[0].id).n, 1);
  assert.equal(inspectTaskSupervision(d, next[0].id).supervisor_user_id, helper);
});

test('acknowledgement and another client read observe committed source, helper, progress, rewards and history together', async () => {
  const x = routine({ mixed: true }), action = mapping(x.root, x.delegated);
  const initialClock = d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
  const response = await change(await read(action.counterpart_task_id, helper), 'done', helper);
  assert.equal(response.http, 200); assert.equal(response.data.status, 'done');
  assert.ok(d.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version > initialClock);
  const [learnerView, helperView] = await Promise.all([read(x.root, learner), read(action.counterpart_task_id, helper)]);
  assert.equal(helperView.status, 'done'); assert.equal(learnerView.status, 'in_progress');
  assert.equal(learnerView.supervision.actions.find(row => row.action_task_id === x.delegated).completed, true);
  assert.deepEqual(earnings(x.delegated), [{ user_id: helper, delta: 7 }]);
  assert.equal(events(x.delegated, 'completed').length, 1);
});
