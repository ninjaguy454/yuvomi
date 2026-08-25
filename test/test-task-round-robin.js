import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const db = buildTestDb();
_setTestDatabase(db);

function addUser(username, displayName, role = 'member') {
  return Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES (?, ?, '$2b$12$x', ?)
  `).run(username, displayName, role).lastInsertRowid);
}

const admin = addUser('admin', 'Admin', 'admin');
const grace = addUser('grace', 'Grace');
const eleanor = addUser('eleanor', 'Eleanor');
const frank = addUser('frank', 'Frank');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;
test.after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function followupOf(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? ORDER BY id LIMIT 1').get(taskId);
}

function assignmentIds(taskId) {
  return db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(taskId).map((row) => row.user_id);
}

function rotationIds(taskId) {
  return db.prepare('SELECT user_id FROM task_rotation_members WHERE task_id = ? ORDER BY sort_order')
    .all(taskId).map((row) => row.user_id);
}

test('round robin advances one member for each recurring occurrence and wraps', async () => {
  const created = await call('POST', '', {
    title: 'Take Shower - 1st',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor, frank],
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = db.prepare('SELECT * FROM tasks WHERE id = ?').get(created.body.data.id);
  assert.equal(first.assignment_mode, 'round_robin');
  assert.equal(first.rotation_index, 0);
  assert.equal(first.assigned_to, grace);
  assert.deepEqual(assignmentIds(first.id), [grace]);
  assert.deepEqual(rotationIds(first.id), [grace, eleanor, frank]);
  assert.deepEqual(created.body.data.rotation_user_ids, [grace, eleanor, frank]);

  assert.equal((await call('PATCH', `/${first.id}/status`, { status: 'done' })).status, 200);
  const second = followupOf(first.id);
  assert.ok(second);
  assert.equal(second.rotation_index, 1);
  assert.equal(second.assigned_to, eleanor);
  assert.deepEqual(assignmentIds(second.id), [eleanor]);
  assert.deepEqual(rotationIds(second.id), [grace, eleanor, frank]);

  assert.equal((await call('PATCH', `/${second.id}/status`, { status: 'done' })).status, 200);
  const third = followupOf(second.id);
  assert.ok(third);
  assert.equal(third.rotation_index, 2);
  assert.equal(third.assigned_to, frank);

  assert.equal((await call('PATCH', `/${third.id}/status`, { status: 'done' })).status, 200);
  const fourth = followupOf(third.id);
  assert.ok(fourth);
  assert.equal(fourth.rotation_index, 0);
  assert.equal(fourth.assigned_to, grace);
});

test('fixed recurring assignment remains unchanged', async () => {
  const created = await call('POST', '', {
    title: 'Fixed recurring task',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assigned_to: [grace],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.assignment_mode, 'fixed');

  await call('PATCH', `/${created.body.data.id}/status`, { status: 'done' });
  const next = followupOf(created.body.data.id);
  assert.equal(next.assigned_to, grace);
  assert.deepEqual(assignmentIds(next.id), [grace]);
  assert.deepEqual(rotationIds(next.id), []);
});

test('round robin requires a recurring top-level task and at least two members', async () => {
  const nonRecurring = await call('POST', '', {
    title: 'Invalid round robin',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, eleanor],
  });
  assert.equal(nonRecurring.status, 400);

  const oneMember = await call('POST', '', {
    title: 'Invalid one-person rotation',
    due_date: new Date().toISOString().slice(0, 10),
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace],
  });
  assert.equal(oneMember.status, 400);
});
