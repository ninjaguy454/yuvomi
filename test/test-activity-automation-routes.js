import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long';

const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
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

function addUser(username, displayName, role, familyRole, birthDate = null) {
  const id = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', ?, ?)
  `).run(username, displayName, role, familyRole).lastInsertRowid);
  if (birthDate) {
    db.prepare(`INSERT INTO birthdays (name, birth_date, created_by, family_user_id) VALUES (?, ?, ?, ?)`)
      .run(displayName, birthDate, id, id);
  }
  return id;
}

const admin = addUser('admin', 'Admin', 'admin', 'parent', '1990-01-01');
const grace = addUser('grace', 'Grace', 'member', 'child', '2016-01-01');
const frank = addUser('frank', 'Frank', 'member', 'child', '2020-08-25');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/automation', automationRouter);
app.use('/api/v1/tasks', tasksRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => server.close());

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

test('admins can build skills, activities and a Quick Add workflow from the API', async () => {
  const makeBedSkill = await call('POST', '/automation/admin/skills', {
    name: 'Make a bed', minimum_age: 5, age_promotion: 'supervised', active: true,
  });
  assert.equal(makeBedSkill.status, 201, JSON.stringify(makeBedSkill.body));

  const laundrySkill = await call('POST', '/automation/admin/skills', {
    name: 'Use washer and dryer', minimum_age: 10, age_promotion: 'supervised', active: true,
  });
  assert.equal(laundrySkill.status, 201, JSON.stringify(laundrySkill.body));

  for (const [skillId, userId] of [
    [makeBedSkill.body.data.id, grace],
    [makeBedSkill.body.data.id, admin],
    [laundrySkill.body.data.id, grace],
    [laundrySkill.body.data.id, admin],
  ]) {
    const response = await call('PUT', `/automation/admin/skills/${skillId}/members/${userId}`, {
      proficiency: 'normal',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }

  const wash = await call('POST', '/automation/admin/activity-templates', {
    name: 'Wash & Dry Bedding',
    title_template: "Wash & Dry {subject}'s Bedding",
    category: 'misc',
    assignment_strategy: 'eligible_round_robin',
    subject_required: true,
    skill_ids: [laundrySkill.body.data.id],
  });
  assert.equal(wash.status, 201, JSON.stringify(wash.body));

  const makeBed = await call('POST', '/automation/admin/activity-templates', {
    name: 'Make Bed',
    title_template: "Make {subject}'s Bed",
    category: 'misc',
    assignment_strategy: 'subject_skill',
    subject_required: true,
    skill_ids: [makeBedSkill.body.data.id],
  });
  assert.equal(makeBed.status, 201, JSON.stringify(makeBed.body));

  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Soiled Sheets',
    description: 'Clean and remake soiled bedding.',
    category: 'misc',
    subject_required: true,
    quick_add_enabled: true,
    input_schema: [],
    steps: [
      { step_key: 'wash', activity_template_id: wash.body.data.id, depends_on: [] },
      { step_key: 'make_bed', activity_template_id: makeBed.body.data.id, depends_on: ['wash'] },
    ],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

  const quick = await call('GET', '/automation/quick-add');
  assert.equal(quick.status, 200);
  assert.ok(quick.body.data.some((row) => row.name === 'Soiled Sheets'));

  const preview = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, {
    subject_user_id: frank,
    inputs: {},
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.steps.length, 2);
  assert.equal(preview.body.data.steps[1].subject_proficiency, 'supervised');
  assert.ok(preview.body.data.steps[1].supervisor);

  const created = await call('POST', `/automation/quick-add/${workflow.body.data.id}/create`, {
    subject_user_id: frank,
    inputs: {},
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.tasks.length, 3);

  const washTask = created.body.data.tasks.find((row) => row.step_key === 'wash' && row.role === 'primary');
  const bedTask = created.body.data.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'primary');
  const supervisorTask = created.body.data.tasks.find((row) => row.step_key === 'make_bed' && row.role === 'supervisor');
  assert.ok(washTask && bedTask && supervisorTask);

  // The workflow parent is an event container. It cannot be manually completed
  // while any generated activity remains unfinished.
  const blockedParent = await call('PATCH', `/tasks/${created.body.data.parent_task_id}/status`, { status: 'done' });
  assert.equal(blockedParent.status, 409, JSON.stringify(blockedParent.body));
  assert.deepEqual(
    new Set(blockedParent.body.dependencies.map((row) => row.id)),
    new Set(created.body.data.tasks.map((row) => row.task_id)),
  );

  // Dependency graph is enforced by the ordinary task status endpoint.
  const blocked = await call('PATCH', `/tasks/${bedTask.task_id}/status`, { status: 'done' });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.deepEqual(blocked.body.dependencies.map((row) => row.id), [washTask.task_id]);

  assert.equal((await call('PATCH', `/tasks/${washTask.task_id}/status`, { status: 'done' })).status, 200);
  assert.equal((await call('PATCH', `/tasks/${bedTask.task_id}/status`, { status: 'done' })).status, 200);
  assert.equal((await call('PATCH', `/tasks/${supervisorTask.task_id}/status`, { status: 'done' })).status, 200);

  const parent = db.prepare('SELECT status FROM tasks WHERE id = ?').get(created.body.data.parent_task_id);
  const instance = db.prepare('SELECT status FROM workflow_instances WHERE id = ?').get(created.body.data.id);
  assert.equal(parent.status, 'done');
  assert.equal(instance.status, 'done');
});
