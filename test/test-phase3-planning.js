import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'phase-three-test-session-secret-32-chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: planningRouter } = await import('../server/routes/planning.js');
const { default: automationRouter } = await import('../server/routes/automation.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const { evaluatePresence } = await import('../server/services/presence.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

function buildTestDb() {
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

const database = buildTestDb();
_setTestDatabase(database);
const admin = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('phase3admin', 'Phase 3 Admin', 'x', 'admin', 'parent')
`).run().lastInsertRowid);
const child = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('phase3child', 'Grace', 'x', 'member', 'child')
`).run().lastInsertRowid);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = admin;
  req.authRole = 'admin';
  req.session = { userId: admin, role: 'admin' };
  next();
});
app.use('/api/v1/planning', planningRouter);
app.use('/api/v1/automation', automationRouter);
app.use('/api/v1/meals', mealsRouter);

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
test.after(() => { server.close(); database.close(); });

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

let home;
let kitchen;
let school;

test('Phase 3 migration adds reusable planning tables and Location variable types', () => {
  for (const table of ['places', 'availability_rules', 'availability_periods', 'task_planning_context']) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  database.prepare(`
    INSERT INTO household_variable_definitions (variable_key, label, type, kind, created_by)
    VALUES ('destination', 'Destination', 'location', 'field', ?)
  `).run(admin);
  assert.equal(database.prepare("SELECT type FROM household_variable_definitions WHERE variable_key = 'destination'").get().type, 'location');
  assert.ok(database.prepare('PRAGMA table_info(calendar_events)').all().some((column) => column.name === 'place_id'));
  assert.ok(database.prepare('PRAGMA table_info(meals)').all().some((column) => column.name === 'place_id'));
});

test('Places preserve stable hierarchy references across rename and guard dependent deletion', async () => {
  const createHome = await call('POST', '/planning/admin/places', { name: 'Home', type: 'home', city: 'Springfield' });
  assert.equal(createHome.status, 201, JSON.stringify(createHome.body));
  home = createHome.body.data;
  const createKitchen = await call('POST', '/planning/admin/places', { name: 'Kitchen', type: 'room', parent_place_id: home.id });
  assert.equal(createKitchen.status, 201, JSON.stringify(createKitchen.body));
  kitchen = createKitchen.body.data;
  const createSchool = await call('POST', '/planning/admin/places', { name: 'School', type: 'school' });
  school = createSchool.body.data;

  const rename = await call('PUT', `/planning/admin/places/${home.id}`, { name: 'Household Home' });
  assert.equal(rename.status, 200, JSON.stringify(rename.body));
  const list = await call('GET', '/planning/places?active=false');
  const savedKitchen = list.body.data.find((place) => Number(place.id) === Number(kitchen.id));
  assert.equal(savedKitchen.parent_place_id, home.id);
  assert.equal(savedKitchen.city, 'Springfield');
  assert.equal(savedKitchen.path_label, 'Household Home / Kitchen');

  const guarded = await call('DELETE', `/planning/admin/places/${home.id}`);
  assert.equal(guarded.status, 409);
  assert.equal(guarded.body.usage.children, 1);
});

test('presence precedence is manual, dated exception, recurring rule, then advisory Calendar', async () => {
  const weekly = await call('POST', '/planning/admin/rules', {
    user_id: child, name: 'School hours', weekdays: [0], start_time: '08:00', end_time: '15:00',
    state: 'away', category: 'school', place_id: school.id,
  });
  assert.equal(weekly.status, 201, JSON.stringify(weekly.body));
  let result = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T12:00:00', endAt: '2026-08-31T12:30:00',
    targetPlaceId: home.id, policy: 'must_be_home',
  });
  assert.equal(result.eligible, false);
  assert.equal(result.effective.source, 'rule');

  const exception = await call('POST', '/planning/admin/periods', {
    user_id: child, source: 'explicit', category: 'general', state: 'available', place_id: home.id,
    starts_at: '2026-08-31T11:00:00', ends_at: '2026-08-31T13:00:00', note: 'Home early',
  });
  assert.equal(exception.status, 201, JSON.stringify(exception.body));
  result = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T12:00:00', endAt: '2026-08-31T12:30:00',
    targetPlaceId: home.id, policy: 'must_be_home',
  });
  assert.equal(result.eligible, true);
  assert.equal(result.effective.source, 'explicit');

  const manual = await call('POST', '/planning/admin/periods', {
    user_id: child, source: 'manual', category: 'travel', state: 'away', place_id: school.id,
    starts_at: '2026-08-31T12:00:00', ends_at: '2026-08-31T12:15:00', note: 'Temporary override',
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  result = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T12:05:00', endAt: '2026-08-31T12:10:00',
    targetPlaceId: home.id, policy: 'must_be_home',
  });
  assert.equal(result.eligible, false);
  assert.equal(result.effective.source, 'manual');

  const ignored = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T12:05:00', endAt: '2026-08-31T12:10:00',
    targetPlaceId: home.id, policy: 'ignore',
  });
  assert.equal(ignored.eligible, true, 'Ignore location must preserve existing assignment behavior');

  result = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T18:00:00', endAt: '2026-08-31T19:00:00',
    targetPlaceId: home.id, policy: 'available_before_due',
  });
  assert.equal(result.eligible, true, 'school-time absence must not remove evening eligibility');

  database.prepare(`
    INSERT INTO calendar_events (
      title, start_datetime, end_datetime, assigned_to, created_by, place_id
    ) VALUES ('Evening club', '2026-08-31T18:00:00', '2026-08-31T19:00:00', ?, ?, ?)
  `).run(child, admin, school.id);
  result = evaluatePresence(database, {
    userId: child, startAt: '2026-08-31T18:00:00', endAt: '2026-08-31T19:00:00',
    targetPlaceId: home.id, policy: 'available_before_due',
  });
  assert.equal(result.effective.source, 'calendar');
  assert.equal(result.effective.advisory, true);
  assert.equal(result.eligible, true, 'ordinary Calendar overlap remains advisory');

  const inactiveSchool = await call('PUT', `/planning/admin/places/${school.id}`, { active: false });
  assert.equal(inactiveSchool.status, 200, JSON.stringify(inactiveSchool.body));
  const preservedRule = await call('PUT', `/planning/admin/rules/${weekly.body.data.id}`, { name: 'School hours (legacy Place)' });
  assert.equal(preservedRule.status, 200, JSON.stringify(preservedRule.body));
  const rejectedRule = await call('POST', '/planning/admin/rules', {
    user_id: child, name: 'New inactive link', weekdays: [1], start_time: '08:00', end_time: '09:00',
    state: 'away', category: 'school', place_id: school.id,
  });
  assert.equal(rejectedRule.status, 400, 'inactive Places cannot be used by new schedules');
});

test('Meal Plan uses the expanded availability window and keeps fallback occurrence-local', async () => {
  const saved = await call('PUT', '/meals/planning', {
    timing_defaults: [{
      meal_type: 'lunch', earliest_time: '09:00', preferred_time: '09:15',
      latest_time: '09:30', expected_duration_minutes: 30,
    }],
    slots: [{
      weekday: 0, meal_type: 'lunch', active: true, policy: 'fixed',
      fixed_user_id: child, fallback_user_id: admin, participant_ids: [child],
      presence_required: true, place_id: home.id,
    }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const materialized = await call('POST', '/meals/planning/materialize', { week: '2026-08-31' });
  assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
  assert.equal(materialized.body.data.created, 1);
  const meal = database.prepare("SELECT * FROM meals WHERE source = 'schedule' AND date = '2026-08-31' AND meal_type = 'lunch'").get();
  assert.equal(meal.place_id, home.id);
  const roles = database.prepare('SELECT user_id, role, status FROM meal_participants WHERE meal_id = ? ORDER BY role, user_id').all(meal.id);
  assert.ok(roles.some((row) => row.user_id === child && row.role === 'participant' && row.status === 'away'));
  assert.ok(roles.some((row) => row.user_id === admin && row.role === 'chooser' && row.status === 'participating'));
  assert.equal(database.prepare('SELECT responsible_user_id FROM planning_obligations WHERE entity_type = \'meal\' AND entity_id = ?').get(meal.id).responsible_user_id, admin);
  assert.equal(database.prepare('SELECT fixed_user_id FROM meal_schedule_slots WHERE weekday = 0 AND meal_type = \'lunch\'').get().fixed_user_id, child, 'fallback must not rewrite the recurring chooser');
});

test('Location workflow inputs create tasks with stable Place context and structured substitution', async () => {
  const activity = await call('POST', '/automation/admin/activity-templates', {
    name: 'Clean selected room', title_template: 'Clean {{destination.name}}', category: 'misc',
    assignment_strategy: 'fixed', fixed_user_id: admin, subject_required: false,
    location_mode: 'workflow', location_variable_id: 'destination', presence_policy: 'ignore',
  });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const workflow = await call('POST', '/automation/admin/workflow-templates', {
    name: 'Clean {{destination.name}}', description: 'Clean at {{destination.address}}', category: 'misc',
    subject_required: false, quick_add_enabled: true,
    input_schema: [{ id: 'destination', label: 'Where?', type: 'location' }],
    steps: [{ step_key: 'clean', activity_template_id: activity.body.data.id, location_mode: 'inherit', depends_on: [] }],
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));

  const preview = await call('POST', `/automation/quick-add/${workflow.body.data.id}/preview`, { inputs: { destination: kitchen.id } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.steps[0].title, 'Clean Kitchen');
  assert.equal(preview.body.data.steps[0].place.id, kitchen.id);

  const created = await call('POST', `/automation/quick-add/${workflow.body.data.id}/create`, { inputs: { destination: kitchen.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const taskId = created.body.data.tasks.find((row) => row.role === 'primary').task_id;
  const context = database.prepare('SELECT * FROM task_planning_context WHERE task_id = ?').get(taskId);
  assert.equal(context.place_id, kitchen.id);
  assert.equal(context.source, 'workflow');

  const renamed = await call('PUT', `/planning/admin/places/${kitchen.id}`, { name: 'Main Kitchen' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(database.prepare('SELECT place_id FROM task_planning_context WHERE task_id = ?').get(taskId).place_id, kitchen.id);

  const fixedActivity = await call('POST', '/automation/admin/activity-templates', {
    name: 'Clean fixed room', title_template: 'Clean fixed room', category: 'misc',
    assignment_strategy: 'fixed', fixed_user_id: admin, subject_required: false,
    location_mode: 'fixed', place_id: kitchen.id, presence_policy: 'must_be_at_location',
  });
  assert.equal(fixedActivity.status, 201, JSON.stringify(fixedActivity.body));
  const inactiveKitchen = await call('PUT', `/planning/admin/places/${kitchen.id}`, { active: false });
  assert.equal(inactiveKitchen.status, 200, JSON.stringify(inactiveKitchen.body));
  const preservedActivity = await call('PUT', `/automation/admin/activity-templates/${fixedActivity.body.data.id}`, {
    name: 'Clean fixed room safely',
  });
  assert.equal(preservedActivity.status, 200, JSON.stringify(preservedActivity.body));
  const rejectedActivity = await call('POST', '/automation/admin/activity-templates', {
    name: 'New inactive room task', title_template: 'New inactive room task', category: 'misc',
    assignment_strategy: 'fixed', fixed_user_id: admin, subject_required: false,
    location_mode: 'fixed', place_id: kitchen.id, presence_policy: 'ignore',
  });
  assert.equal(rejectedActivity.status, 400, 'inactive Places cannot be selected for new templates');
  const guarded = await call('DELETE', `/planning/admin/places/${kitchen.id}`);
  assert.equal(guarded.status, 409);
});
