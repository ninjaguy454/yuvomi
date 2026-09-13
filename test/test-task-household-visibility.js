import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'task-household-visibility-test';
process.env.LOG_LEVEL = 'error';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { replaceSubjectPermissions, resolvePermissions, buildSessionModuleAccess,
  moduleAccessVerdict, MODULE_ACCESS_ALLOW } = await import('../server/permissions.js');
const { moduleForPath, requiredAccess } = await import('../server/scopes.js');
const { RESTRICTED_MEMBER_CAPABILITIES } = await import('../server/task-capabilities.js');
const { taskCapabilities } = await import('../server/services/task-access.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: readerRouter } = await import('../server/routes/reader.js');

const d = new Database(':memory:');
d.pragma('foreign_keys = ON');
d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT)');
for (const migration of ALL_MIGRATIONS) {
  if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
  migration.afterUp?.(d);
  d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version, migration.description);
}
_setTestDatabase(d);
const member = (name, role = 'member', familyRole = 'parent') => Number(d.prepare(`INSERT INTO users
  (username,display_name,password_hash,role,family_role) VALUES (?,?,'x',?,?)`).run(name, name, role, familyRole).lastInsertRowid);
const creator = member('Task creator');
const eleanor = member('Eleanor', 'member', 'child');
const householdViewer = member('Household viewer');
const administrator = member('Other administrator', 'admin');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  const actor = d.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user'] || creator));
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.authMethod = 'session';
  req.session = { userId: actor.id, role: actor.role, csrfToken: 'household-visibility-csrf' };
  req.sessionModuleAccess = buildSessionModuleAccess(resolvePermissions(d, actor));
  next();
});
// Exercise the same module decision used by index.js, including compatibility
// routes. Aggregate readers apply their own per-module projection checks.
function moduleGuard(req, res, next) {
  const verdict = moduleAccessVerdict(req.sessionModuleAccess, moduleForPath(req.path), requiredAccess(req.method));
  if (verdict !== MODULE_ACCESS_ALLOW) return res.status(403).json({ error: 'Module access denied.' });
  next();
}
app.use('/api/v1', moduleGuard);
app.use('/api', moduleGuard);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/reader', readerRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); d.close(); });
test.beforeEach(() => {
  d.prepare('DELETE FROM access_capabilities').run();
  d.prepare('DELETE FROM access_permissions').run();
});

async function request(method, path, body, userId = creator) {
  const response = await fetch(base + path, {
    method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'x-user': String(userId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, text };
}
let sequence = 0;
async function createTask(fields = {}, userId = creator) {
  const payload = { title: `Household visibility Task ${++sequence}`, assigned_to: [eleanor], visibility: 'all', ...fields };
  const response = await request('POST', '/api/v1/tasks', payload, userId);
  assert.equal(response.status, 201, response.text);
  return { payload, task: response.data.data };
}
async function list(userId, query = '', prefix = '/api/v1/tasks') {
  const response = await request('GET', prefix + query, undefined, userId);
  assert.equal(response.status, 200, response.text);
  return response.data.data;
}
async function assertAudience(task, userId, visible) {
  assert.equal(taskCapabilities(d, userId, task).view, visible, 'canonical capability result');
  for (const prefix of ['/api/v1/tasks', '/api/tasks']) {
    const first = await list(userId, '', prefix);
    const refreshed = await list(userId, '', prefix);
    assert.equal(first.some(row => row.id === task.id), visible, `${prefix} list audience`);
    assert.deepEqual(refreshed.map(row => row.id), first.map(row => row.id), 'refresh preserves the same audience');
    const detail = await request('GET', `${prefix}/${task.id}`, undefined, userId);
    assert.equal(detail.status, visible ? 200 : 404, `${prefix} detail audience`);
    if (visible) {
      assert.equal(detail.data.data.id, task.id);
      assert.equal(detail.data.data.permissions.view, true);
    }
  }
}

test('creation persists explicit household visibility, actual assignee and creator without changing the audience', async () => {
  const { payload, task } = await createTask();
  const persisted = d.prepare('SELECT created_by,assigned_to,visibility,status,archived_at,parent_task_id FROM tasks WHERE id=?').get(task.id);
  assert.deepEqual(persisted, {
    created_by: creator, assigned_to: eleanor, visibility: payload.visibility,
    status: 'open', archived_at: null, parent_task_id: null,
  });
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id), [{ user_id: eleanor }]);
  assert.equal(task.visibility, 'all');
  assert.deepEqual(task.assigned_users.map(user => user.id), [eleanor]);
  for (const userId of [creator, householdViewer, eleanor]) await assertAudience(task, userId, true);
});

test('an explicit assignee filter narrows the list without changing household Task authorization', async () => {
  const { task } = await createTask();
  assert.ok((await list(creator, `?assigned_to=${eleanor}`)).some(row => row.id === task.id));
  assert.ok(!(await list(creator, `?assigned_to=${creator}`)).some(row => row.id === task.id));
  assert.equal((await request('GET', `/api/v1/tasks/${task.id}`, undefined, creator)).status, 200);
});

test('Not Started and In Progress household Tasks both appear under the normal active status filter', async () => {
  const { task } = await createTask();
  const active = '?status=open&status=in_progress';
  assert.ok((await list(householdViewer, active)).some(row => row.id === task.id && row.status === 'open'));
  const changed = await request('PATCH', `/api/v1/tasks/${task.id}/status`, { status: 'in_progress', expected_revision: task.revision });
  assert.equal(changed.status, 200, changed.text);
  assert.ok((await list(householdViewer, active)).some(row => row.id === task.id && row.status === 'in_progress'));
  await assertAudience(task, householdViewer, true);
});

test('future start is a list scope choice; include_future reveals the authorized Task and detail remains accessible', async () => {
  const { task } = await createTask({ start_date: '2199-01-01' });
  for (const userId of [creator, householdViewer, eleanor]) {
    assert.ok(!(await list(userId)).some(row => row.id === task.id));
    assert.ok((await list(userId, '?include_future=1')).some(row => row.id === task.id));
    assert.equal((await request('GET', `/api/v1/tasks/${task.id}`, undefined, userId)).status, 200);
  }
});

test('private Task stays creator-only despite assignment and an unrelated administrator role', async () => {
  const { task } = await createTask({ visibility: 'private' });
  await assertAudience(task, creator, true);
  for (const userId of [eleanor, householdViewer, administrator]) await assertAudience(task, userId, false);
});

test('assignee-only Task remains limited to creator and explicit assignees', async () => {
  const { task } = await createTask({ visibility: 'assignees' });
  for (const userId of [creator, eleanor]) await assertAudience(task, userId, true);
  for (const userId of [householdViewer, administrator]) await assertAudience(task, userId, false);
});

test('view own Tasks allows the assigned child but does not disclose another member household-visible work', async () => {
  replaceSubjectPermissions(d, 'user', eleanor, { capabilities: RESTRICTED_MEMBER_CAPABILITIES });
  const own = (await createTask()).task;
  const other = (await createTask({ assigned_to: [householdViewer] })).task;
  await assertAudience(own, eleanor, true);
  await assertAudience(other, eleanor, false);
});

test('granting household viewing reveals household Tasks without revealing private or other assignee-only Tasks', async () => {
  replaceSubjectPermissions(d, 'user', eleanor, { capabilities: {
    ...RESTRICTED_MEMBER_CAPABILITIES, 'tasks.view_household': 'allow',
  } });
  const shared = (await createTask({ assigned_to: [householdViewer] })).task;
  const privateTask = (await createTask({ assigned_to: [householdViewer], visibility: 'private' })).task;
  const ownOnly = (await createTask({ assigned_to: [householdViewer], visibility: 'assignees' })).task;
  await assertAudience(shared, eleanor, true);
  await assertAudience(privateTask, eleanor, false);
  await assertAudience(ownOnly, eleanor, false);
});

test('module denial caps household capability on normal and compatibility Task APIs', async () => {
  const { task } = await createTask();
  replaceSubjectPermissions(d, 'user', householdViewer, {
    modules: { tasks: 'none' }, capabilities: { 'tasks.view_household': 'allow' },
  });
  assert.equal(taskCapabilities(d, householdViewer, task).view, false);
  for (const prefix of ['/api/v1/tasks', '/api/tasks']) {
    assert.equal((await request('GET', prefix, undefined, householdViewer)).status, 403);
    assert.equal((await request('GET', `${prefix}/${task.id}`, undefined, householdViewer)).status, 403);
  }
});

test('read-only Task module retains household visibility while denying Task creation', async () => {
  const { task } = await createTask();
  replaceSubjectPermissions(d, 'user', householdViewer, { modules: { tasks: 'read' } });
  await assertAudience(task, householdViewer, true);
  assert.equal((await request('POST', '/api/v1/tasks', { title: 'Denied create', visibility: 'all' }, householdViewer)).status, 403);
});

test('Reader and Dashboard expose authorized household Tasks and honor own-only restrictions', async () => {
  const { task } = await createTask({ title: 'Visible on aggregate surfaces', due_date: '2000-01-01', priority: 'urgent' });
  const dashboard = await request('GET', '/api/v1/dashboard', undefined, householdViewer);
  assert.equal(dashboard.status, 200, dashboard.text);
  assert.ok(dashboard.data.urgentTasks.some(row => row.id === task.id));
  const reader = await request('GET', '/reader?view=tasks', undefined, householdViewer);
  assert.equal(reader.status, 200, reader.text);
  assert.ok(reader.text.includes(task.title));
  replaceSubjectPermissions(d, 'user', householdViewer, { capabilities: RESTRICTED_MEMBER_CAPABILITIES });
  const restrictedDashboard = await request('GET', '/api/v1/dashboard', undefined, householdViewer);
  assert.ok(!restrictedDashboard.data.urgentTasks.some(row => row.id === task.id));
  const restrictedReader = await request('GET', '/reader?view=tasks', undefined, householdViewer);
  assert.ok(!restrictedReader.text.includes(task.title));
});
