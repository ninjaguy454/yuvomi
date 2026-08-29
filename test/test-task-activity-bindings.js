import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

function buildTestDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const migration of ALL_MIGRATIONS) {
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

function addUser(username, displayName, familyRole = 'child', birthDate = null, role = 'member') {
  const id = Number(db.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES (?, ?, '$2b$12$x', ?, ?)
  `).run(username, displayName, role, familyRole).lastInsertRowid);
  if (birthDate) {
    db.prepare(`
      INSERT INTO birthdays (name, birth_date, created_by, family_user_id)
      VALUES (?, ?, ?, ?)
    `).run(displayName, birthDate, id, id);
  }
  return id;
}

const admin = addUser('admin', 'Admin', 'other', null, 'admin');
const grace = addUser('grace', 'Grace', 'child', '2016-01-01');
const frank = addUser('frank', 'Frank', 'child', '2020-08-25');
const mom = addUser('mom', 'Mom', 'mom', '1990-01-01');

function addSkill(name, { minimumAge = 0, promotion = 'supervised' } = {}) {
  return Number(db.prepare(`
    INSERT INTO skills (name, minimum_age, age_promotion, created_by)
    VALUES (?, ?, ?, ?)
  `).run(name, minimumAge, promotion, admin).lastInsertRowid);
}

function setProficiency(userId, skillId, proficiency) {
  db.prepare(`
    INSERT INTO user_skill_proficiency (user_id, skill_id, proficiency, source, updated_by)
    VALUES (?, ?, ?, 'manual', ?)
    ON CONFLICT(user_id, skill_id)
    DO UPDATE SET proficiency = excluded.proficiency, source = 'manual', updated_by = excluded.updated_by
  `).run(userId, skillId, proficiency, admin);
}

function addActivity({ name, strategy = 'subject_skill', subjectRequired = 1, skillIds = [] }) {
  const id = Number(db.prepare(`
    INSERT INTO activity_templates (
      name, title_template, category, assignment_strategy, subject_required,
      supervision_title_template, active, created_by
    ) VALUES (?, ?, 'misc', ?, ?, 'Supervise {subject}: {activity}', 1, ?)
  `).run(name, `${name} {subject}`, strategy, subjectRequired, admin).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO activity_template_skills (activity_template_id, skill_id, sort_order)
    VALUES (?, ?, ?)
  `);
  skillIds.forEach((skillId, index) => insert.run(id, skillId, index));
  return id;
}

const makeBedSkill = addSkill('Make bed', { minimumAge: 5, promotion: 'supervised' });
const laundrySkill = addSkill('Laundry', { minimumAge: 10, promotion: 'supervised' });
setProficiency(grace, makeBedSkill, 'normal');
setProficiency(mom, makeBedSkill, 'normal');
setProficiency(grace, laundrySkill, 'normal');
setProficiency(mom, laundrySkill, 'normal');

const makeBedActivity = addActivity({
  name: 'Make Bed',
  strategy: 'subject_skill',
  subjectRequired: 1,
  skillIds: [makeBedSkill],
});
const laundryActivity = addActivity({
  name: 'Laundry Rotation',
  strategy: 'eligible_round_robin',
  subjectRequired: 0,
  skillIds: [laundrySkill],
});
db.prepare(`
  INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
  VALUES (?, 'Move laundry to the dryer', 0)
`).run(laundryActivity);

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

function task(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function followupOf(id) {
  return db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ? AND parent_task_id IS NULL ORDER BY id LIMIT 1').get(id);
}

function bindingOf(id) {
  return db.prepare('SELECT * FROM task_activity_bindings WHERE task_id = ?').get(id);
}

function supportOf(id) {
  return db.prepare(`
    SELECT t.*, s.role
      FROM task_activity_support_tasks s JOIN tasks t ON t.id = s.task_id
     WHERE s.source_task_id = ?
  `).get(id);
}

function assignments(id) {
  return db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ? ORDER BY user_id')
    .all(id).map((row) => row.user_id);
}

const today = new Date().toISOString().slice(0, 10);

test('scheduled task binding uses subject proficiency and creates explicit supervision work', async () => {
  const created = await call('POST', '', {
    title: 'Frank makes his bed',
    due_date: today,
    activity_template_id: makeBedActivity,
    activity_subject_user_id: frank,
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, mom],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const parent = task(created.body.data.id);
  assert.equal(parent.assigned_to, frank);
  assert.equal(parent.assignment_mode, 'fixed', 'Activity Template owns assignment instead of Task RR');
  assert.deepEqual(assignments(parent.id), [frank]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_rotation_members WHERE task_id = ?').get(parent.id).n, 0);

  const binding = bindingOf(parent.id);
  assert.equal(binding.activity_template_id, makeBedActivity);
  assert.equal(binding.subject_user_id, frank);
  assert.equal(created.body.data.activity_template_name, 'Make Bed');

  const support = supportOf(parent.id);
  assert.ok(support, 'supervised proficiency generates separate supervisor work');
  assert.equal(support.parent_task_id, parent.id);
  assert.ok([grace, mom].includes(support.assigned_to));
  assert.deepEqual(assignments(support.id), [support.assigned_to]);
});

test('recurring Activity Template task re-resolves eligible round robin each occurrence', async () => {
  const created = await call('POST', '', {
    title: 'Household laundry',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: laundryActivity,
    activity_subject_user_id: null,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = task(created.body.data.id);
  assert.ok([grace, mom].includes(first.assigned_to));
  assert.equal(first.assignment_mode, 'fixed');
  assert.deepEqual(
    db.prepare('SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY id').all(first.id),
    [{ title: 'Move laundry to the dryer' }],
  );

  assert.equal((await call('PATCH', `/${first.id}/status`, { status: 'done' })).status, 200);
  const second = followupOf(first.id);
  assert.ok(second);
  assert.ok([grace, mom].includes(second.assigned_to));
  assert.notEqual(second.assigned_to, first.assigned_to, 'activity-level RR advances');
  assert.equal(bindingOf(second.id).activity_template_id, laundryActivity);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_rotation_members WHERE task_id = ?').get(second.id).n, 0);
  assert.deepEqual(
    db.prepare('SELECT title FROM tasks WHERE parent_task_id = ? ORDER BY id').all(second.id),
    [{ title: 'Move laundry to the dryer' }],
    'recurrence copies the Task-owned checklist once instead of rematerializing a duplicate',
  );

  // Eligibility is evaluated again for the next occurrence, not frozen as a
  // roster when the series was first created.
  setProficiency(first.assigned_to, laundrySkill, 'excluded');
  assert.equal((await call('PATCH', `/${second.id}/status`, { status: 'done' })).status, 200);
  const third = followupOf(second.id);
  assert.ok(third);
  assert.equal(third.assigned_to, second.assigned_to);
});

test('saving an unchanged binding does not consume a rotation turn and unbinding restores manual assignment', async () => {
  const skill = addSkill(`Rotation ${Date.now()}`, { minimumAge: 10, promotion: 'supervised' });
  setProficiency(grace, skill, 'normal');
  setProficiency(mom, skill, 'normal');
  const activity = addActivity({
    name: `Reusable rotation ${Date.now()}`,
    strategy: 'eligible_round_robin',
    subjectRequired: 0,
    skillIds: [skill],
  });

  const created = await call('POST', '', {
    title: 'Reusable scheduled chore',
    activity_template_id: activity,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  const before = task(id);
  const cursorBefore = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity)?.last_user_id;
  assert.equal(cursorBefore, before.assigned_to);

  const saved = await call('PUT', `/${id}`, {
    title: 'Reusable scheduled chore renamed',
    activity_template_id: activity,
    activity_subject_user_id: null,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(task(id).assigned_to, before.assigned_to);
  const cursorAfter = db.prepare(`
    SELECT last_user_id FROM activity_rotation_state
     WHERE activity_template_id = ? AND purpose = 'primary'
  `).get(activity)?.last_user_id;
  assert.equal(cursorAfter, cursorBefore, 'ordinary edit must not advance Activity Template RR');

  const unbound = await call('PUT', `/${id}`, {
    activity_template_id: null,
    activity_subject_user_id: null,
    assignment_mode: 'fixed',
    assigned_to: [mom],
  });
  assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
  assert.equal(bindingOf(id), undefined);
  assert.equal(task(id).assigned_to, mom);
  assert.deepEqual(assignments(id), [mom]);
});

test('recurrence undo treats regenerated supervision as part of the untouched next occurrence', async () => {
  const created = await call('POST', '', {
    title: 'Recurring supervised bed task',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    activity_template_id: makeBedActivity,
    activity_subject_user_id: frank,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const source = task(created.body.data.id);
  assert.ok(supportOf(source.id));

  await call('PATCH', `/${source.id}/status`, { status: 'done' });
  const next = followupOf(source.id);
  assert.ok(next);
  const nextSupport = supportOf(next.id);
  assert.ok(nextSupport);
  assert.ok(nextSupport.recurrence_origin_id, 'generated support work links to prior occurrence support');

  const reopened = await call('PATCH', `/${source.id}/status`, { status: 'open' });
  assert.equal(reopened.status, 200);
  assert.equal(followupOf(source.id), undefined, 'untouched generated occurrence is discarded atomically');
});

test('legacy manual task round robin remains independent when no Activity Template is attached', async () => {
  const created = await call('POST', '', {
    title: 'Legacy manual rotation',
    due_date: today,
    is_recurring: 1,
    recurrence_rule: 'FREQ=DAILY',
    assignment_mode: 'round_robin',
    rotation_user_ids: [grace, mom],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = task(created.body.data.id);
  assert.equal(bindingOf(first.id), undefined);
  assert.equal(first.assignment_mode, 'round_robin');

  await call('PATCH', `/${first.id}/status`, { status: 'done' });
  const next = followupOf(first.id);
  assert.ok(next);
  assert.equal(next.assignment_mode, 'round_robin');
  assert.notEqual(next.assigned_to, first.assigned_to);
  assert.equal(bindingOf(next.id), undefined);
});
