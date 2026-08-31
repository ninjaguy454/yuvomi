import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'phase-four-test-session-secret-32-chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const {
  resolveActivityAssignment,
} = await import('../server/services/activity-eligibility.js');
const {
  claimTask,
  overrideTaskAssignment,
  respondToTaskObligation,
} = await import('../server/services/assignment-responsibilities.js');
const { applyTaskActivityBinding } = await import('../server/services/task-activity-bindings.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

function buildDb() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const migration of ALL_MIGRATIONS) {
    apply(database, migration);
    database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  }
  return database;
}

const database = buildDb();
_setTestDatabase(database);
const admin = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('p4admin','Alex','x','admin','parent')").run().lastInsertRowid);
const sam = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('p4sam','Sam','x','member','parent')").run().lastInsertRowid);
const child = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role, family_role) VALUES ('p4child','Jamie','x','member','child')").run().lastInsertRowid);
const skill = Number(database.prepare("INSERT INTO skills (name, adult_only, age_promotion, created_by) VALUES ('Phase 4 safety',1,'normal',?)").run(admin).lastInsertRowid);
for (const userId of [admin, sam, child]) {
  database.prepare("INSERT INTO user_skill_proficiency (user_id, skill_id, proficiency, source, updated_by) VALUES (?,?,'normal','manual',?)")
    .run(userId, skill, admin);
}

function addActivity(policy, options = {}) {
  const result = database.prepare(`
    INSERT INTO activity_templates (
      name, title_template, category, assignment_strategy, assignment_policy,
      subject_required, participant_count, allow_assignment_override,
      rotation_group, active, created_by
    ) VALUES (?, ?, 'misc', 'eligible_round_robin', ?, 0, ?, ?, ?, 1, ?)
  `).run(`P4 ${policy}`, `P4 ${policy}`, policy, options.count || 1,
    options.override === false ? 0 : 1, options.group || null, admin);
  const id = Number(result.lastInsertRowid);
  if (options.skill !== false) database.prepare('INSERT INTO activity_template_skills (activity_template_id, skill_id, sort_order) VALUES (?, ?, 0)').run(id, skill);
  return database.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
}

function addTask(title) {
  return Number(database.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, assigned_to, created_by,
      is_recurring, assignment_mode, rotation_index, points, visibility, countdown, locked)
    VALUES (?, 'misc', 'none', 'open', '2026-08-31', NULL, ?, 0, 'fixed', 0, 0, 'all', 0, 0)
  `).run(title, admin).lastInsertRowid);
}

test('Phase 4 migration is additive and exposes durable responsibility tables', () => {
  assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE version = 10008').get());
  for (const table of ['assignment_rotation_state', 'task_assignment_context', 'task_responsibilities', 'planning_obligation_events', 'meal_selection_responses']) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const columns = database.prepare('PRAGMA table_info(planning_obligations)').all().map((row) => row.name);
  assert.ok(columns.includes('response_deadline'));
  assert.ok(columns.includes('metadata_json'));
});

test('Eligible Random is uniform-pool based and never consumes rotation state', () => {
  const activity = addActivity('eligible_random', { skill: false });
  const first = resolveActivityAssignment(database, activity, { random: () => 0, dateKey: '2026-08-31' });
  const last = resolveActivityAssignment(database, activity, { random: () => 0.999, dateKey: '2026-08-31' });
  assert.notEqual(first.primary.id, last.primary.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assignment_rotation_state').get().n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM activity_rotation_state WHERE activity_template_id = ?').get(activity.id).n, 0);
});

test('multi-person preview is pure and one committed occurrence advances its shared cursor once', () => {
  const activity = addActivity('rotating_multi', { count: 2, skill: false, group: 'weekend-team' });
  const preview = resolveActivityAssignment(database, activity, { commitRotation: false, dateKey: '2026-08-31' });
  assert.equal(preview.participants.length, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assignment_rotation_state').get().n, 0);
  const created = resolveActivityAssignment(database, activity, { commitRotation: true, dateKey: '2026-08-31' });
  assert.equal(created.participants.length, 2);
  const cursor = database.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key = 'activity-group:weekend-team:primary'").get();
  assert.equal(cursor.occurrence_count, 1);
  assert.equal(cursor.cursor_user_id, created.participants.at(-1).id);
});

test('open tasks claim atomically and retain independent beneficiary and participant roles', () => {
  const activity = addActivity('open_claimable', { skill: false });
  const taskId = addTask('Claim me');
  applyTaskActivityBinding(database, taskId, { activityTemplateId: activity.id, subjectUserId: null });
  assert.equal(database.prepare('SELECT state FROM task_assignment_context WHERE task_id = ?').get(taskId).state, 'open');
  const claimed = claimTask(database, taskId, sam);
  assert.equal(claimed.assigned_to.id, sam);
  assert.throws(() => claimTask(database, taskId, admin), /already been claimed/i);
  const roles = database.prepare('SELECT role FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND status = \'active\' ORDER BY role').all(taskId, sam).map((row) => row.role);
  assert.deepEqual(roles, ['participant', 'primary']);
});

test('manual override and claim cannot bypass adult-only safety', () => {
  const activity = addActivity('open_claimable');
  const taskId = addTask('Adult only');
  applyTaskActivityBinding(database, taskId, { activityTemplateId: activity.id });
  assert.throws(() => claimTask(database, taskId, child), /not independently qualified/i);
  assert.throws(() => overrideTaskAssignment(database, taskId, child, admin), /not independently qualified/i);
});

test('decline creates an occurrence-local fallback without moving the base rotation cursor', () => {
  const activity = addActivity('eligible_round_robin', { skill: false, group: 'chores' });
  const taskId = addTask('Fallback task');
  applyTaskActivityBinding(database, taskId, { activityTemplateId: activity.id });
  const before = database.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key = 'activity-group:chores:primary'").get();
  const obligation = database.prepare("SELECT * FROM planning_obligations WHERE task_id = ? AND status = 'pending'").get(taskId);
  const result = respondToTaskObligation(database, obligation.id, 'decline', obligation.responsible_user_id);
  assert.ok(result.replacement_obligation_id);
  const after = database.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key = 'activity-group:chores:primary'").get();
  assert.deepEqual(after, before);
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/meals', mealsRouter);
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); database.close(); });

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

test('a subtask assignee becomes a parent participant without becoming its primary assignee', async () => {
  const activity = addActivity('open_claimable', { skill: false });
  const parentId = addTask('Parent activity');
  applyTaskActivityBinding(database, parentId, { activityTemplateId: activity.id });
  const created = await call('POST', '/tasks', {
    title: 'Assigned subtask', category: 'misc', priority: 'none', parent_task_id: parentId,
    assigned_to: [sam], visibility: 'all', status: 'open',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const parentRole = database.prepare("SELECT * FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND role = 'participant' AND status = 'active'").get(parentId, sam);
  const primaryRole = database.prepare("SELECT * FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND role = 'primary' AND status = 'active'").get(parentId, sam);
  const childRole = database.prepare("SELECT * FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND role = 'subtask_assignee' AND status = 'active'").get(created.body.data.id, sam);
  assert.ok(parentRole);
  assert.equal(primaryRole, undefined);
  assert.ok(childRole);
});

test('Personal Choice creates one durable request per participant and remains idempotent', async () => {
  const plan = await call('PUT', '/meals/planning', {
    timing_defaults: [],
    slots: [{
      weekday: 0, meal_type: 'dinner', policy: 'personal_choice', active: true,
      participant_ids: [admin, sam], fallback_user_id: null, presence_required: false,
      selection_deadline_minutes: 1440, reminder_minutes: 120, snack_choice_limit: 3,
    }],
  });
  assert.equal(plan.status, 200);
  const first = await call('POST', '/meals/planning/materialize', { week: '2026-08-31' });
  const second = await call('POST', '/meals/planning/materialize', { week: '2026-08-31' });
  assert.equal(first.body.data.created, 1);
  assert.equal(second.body.data.created, 0);
  const meal = database.prepare("SELECT * FROM meals WHERE date = '2026-08-31' AND meal_type = 'dinner' AND source = 'schedule'").get();
  const requests = database.prepare("SELECT * FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ? ORDER BY responsible_user_id").all(meal.id);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((row) => row.responsible_user_id), [admin, sam]);
  const answer = await call('POST', `/meals/selection-requests/${requests[0].id}/respond`, { action: 'choose', title: 'Tacos' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const alternative = database.prepare("SELECT * FROM meals WHERE parent_meal_id = ? AND scope = 'personal'").get(meal.id);
  assert.equal(alternative.title, 'Tacos');
  assert.equal(alternative.source_key, `meal-person-decision:${meal.id}:${admin}`);
  const canonicalDecision = database.prepare(`
    SELECT * FROM meal_person_decisions WHERE meal_id = ? AND beneficiary_user_id = ?
  `).get(meal.id, admin);
  assert.ok(canonicalDecision, 'legacy response also writes the canonical audited decision');
  assert.equal(Number(canonicalDecision.selected_meal_id), Number(alternative.id));
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM meals WHERE parent_meal_id = ? AND scope = 'personal'`).get(meal.id).count, 1);
  assert.equal(database.prepare('SELECT title FROM meals WHERE id = ?').get(meal.id).title, 'Choose dinner');
});
