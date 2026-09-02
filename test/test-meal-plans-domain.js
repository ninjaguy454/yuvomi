import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
process.env.SESSION_SECRET ??= 'meal-plan-domain-test-secret-32chars';

const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: mealsRouter } = await import('../server/routes/meals.js');
const {
  resolvePlanningContextConflict,
  savePlanningContext,
} = await import('../server/services/planning-contexts.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)`);
for (const migration of ALL_MIGRATIONS) {
  apply(database, migration);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}
_setTestDatabase(database);

const admin = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('meal-plan-admin', 'Alex', 'x', 'admin', 'parent')
`).run().lastInsertRowid);
const sam = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('meal-plan-sam', 'Sam', 'x', 'member', 'parent')
`).run().lastInsertRowid);
const jamie = Number(database.prepare(`
  INSERT INTO users (username, display_name, password_hash, role, family_role)
  VALUES ('meal-plan-jamie', 'Jamie', 'x', 'member', 'child')
`).run().lastInsertRowid);

let actor = { id: admin, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/meals', mealsRouter);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1/meals`;

test.after(() => {
  server.close();
  database.close();
});

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

function addMeal(date, title = 'Household meal') {
  return Number(database.prepare(`
    INSERT INTO meals (date, meal_type, title, created_by) VALUES (?, 'dinner', ?, ?)
  `).run(date, title, admin).lastInsertRowid);
}

function addParticipant(mealId, userId, role = 'participant') {
  database.prepare(`
    INSERT INTO meal_participants (meal_id, user_id, role, status, source)
    VALUES (?, ?, ?, 'participating', 'manual')
  `).run(mealId, userId, role);
}

test('named Meal Plans create immutable revisions and soft-delete without deleting occurrences', async () => {
  const created = await call('POST', '/plans', {
    name: 'Weeknight dinners',
    description: 'Reusable dinner chooser',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      fallback_user_id: sam,
      participant_ids: [admin, sam, jamie],
      generate_preparation: true,
      generate_cooking: false,
      generate_cleanup: true,
      preparation_duration_minutes: 45,
      cooking_duration_minutes: 25,
      cleanup_duration_minutes: 20,
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = created.body.data.id;
  assert.equal(created.body.data.current_revision, 1);
  assert.equal(created.body.data.rules[0].cooking_duration_minutes, 25);
  assert.equal(created.body.data.rules[0].generate_cooking, false);

  const firstRevision = database.prepare(`
    SELECT snapshot_json FROM meal_plan_revisions WHERE meal_plan_id = ? AND revision = 1
  `).get(planId).snapshot_json;
  const datedMeal = addMeal('2034-03-06', 'Historical dinner');
  database.prepare(`
    UPDATE meals SET meal_plan_id = ?, meal_plan_revision_id = (
      SELECT id FROM meal_plan_revisions WHERE meal_plan_id = ? AND revision = 1
    ) WHERE id = ?
  `).run(planId, planId, datedMeal);

  const updated = await call('PUT', `/plans/${planId}`, {
    name: 'Weeknight supper',
    change_note: 'Renamed and moved the cooking window.',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'fixed', fixed_user_id: sam,
      participant_ids: [admin, sam, jamie], cooking_duration_minutes: 40,
    }],
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.current_revision, 2);
  assert.equal(updated.body.data.rules[0].cooking_duration_minutes, 40);
  assert.equal(database.prepare(`
    SELECT snapshot_json FROM meal_plan_revisions WHERE meal_plan_id = ? AND revision = 1
  `).get(planId).snapshot_json, firstRevision, 'the prior revision is immutable');

  const removed = await call('DELETE', `/plans/${planId}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.data.status, 'deleted');
  assert.equal(removed.body.data.current_revision, 3);
  assert.ok(database.prepare('SELECT 1 FROM meals WHERE id = ?').get(datedMeal), 'historical dated meal remains');
  const listed = await call('GET', '/plans');
  assert.ok(!listed.body.data.some((plan) => Number(plan.id) === planId));
});

test('deleting one named Meal Plan occurrence keeps it deleted and closes its chooser request', async () => {
  actor = { id: admin, role: 'admin' };
  const date = '2052-02-05';
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const plan = await call('POST', '/plans', {
    name: 'One occurrence deletion',
    effective_from: date,
    effective_until: date,
    rules: [{
      weekday,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: sam,
      participant_ids: [admin, sam],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await call('GET', `/week-model?start=${date}&end=${date}&member_id=${sam}`)).status, 200);
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = ?
  `).get(plan.body.data.id, date);
  assert.ok(meal);
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
  `).get(meal.id));

  const removed = await call('DELETE', `/${meal.id}`);
  assert.equal(removed.status, 204, JSON.stringify(removed.body));
  assert.equal(database.prepare('SELECT 1 FROM meals WHERE id = ?').get(meal.id), undefined);
  assert.equal(database.prepare(`
    SELECT 1 FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ?
  `).get(meal.id), undefined);
  assert.ok(database.prepare(`
    SELECT 1 FROM meal_plan_occurrence_exceptions
     WHERE meal_plan_rule_id = ? AND context_scope = 'base' AND date = ?
  `).get(meal.meal_plan_rule_id, date));

  const refreshed = await call('GET', `/week-model?start=${date}&end=${date}&member_id=${sam}`);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(database.prepare(`
    SELECT 1 FROM meals WHERE meal_plan_id = ? AND date = ?
  `).get(plan.body.data.id, date), undefined, 'the skipped occurrence is not recreated');
  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
});

test('Meal Plan edits keep stable occurrence identity and execution uses the dated revision policy', async () => {
  actor = { id: admin, role: 'admin' };
  const created = await call('POST', '/plans', {
    name: 'Revision-safe dinners',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      label: 'Revision one dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      cook_user_id: admin,
      participant_ids: [admin, sam],
      preferred_time: '18:00',
      expected_duration_minutes: 60,
      generate_preparation: true,
      generate_cooking: false,
      generate_supervision: false,
      generate_serving: false,
      generate_cleanup: true,
      preparation_duration_minutes: 45,
      cooking_duration_minutes: 25,
      cleanup_duration_minutes: 20,
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = Number(created.body.data.id);
  const originalRule = created.body.data.rules[0];

  const firstRead = await call('GET', '/week-model?start=2037-01-05&end=2037-01-05');
  assert.equal(firstRead.status, 200, JSON.stringify(firstRead.body));
  const firstMeal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2037-01-05' AND planning_context_id IS NULL
  `).get(planId);
  assert.ok(firstMeal);
  const firstAssignment = database.prepare(`
    SELECT * FROM meal_occurrence_assignments WHERE meal_id = ?
  `).get(firstMeal.id);
  assert.ok(firstAssignment);

  const updated = await call('PUT', `/plans/${planId}`, {
    name: 'Revision-safe dinners',
    rules: [{
      id: originalRule.id,
      rule_key: originalRule.rule_key,
      weekday: 0,
      meal_type: 'dinner',
      label: 'Revision two dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      cook_user_id: admin,
      participant_ids: [admin, sam],
      preferred_time: '18:00',
      expected_duration_minutes: 60,
      generate_preparation: false,
      generate_cooking: true,
      generate_supervision: false,
      generate_serving: false,
      generate_cleanup: false,
      preparation_duration_minutes: 10,
      cooking_duration_minutes: 25,
      cleanup_duration_minutes: 10,
    }],
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.current_revision, 2);
  assert.equal(updated.body.data.rules[0].id, originalRule.id, 'the stable rule row remains referenced');
  assert.equal(updated.body.data.rules[0].rule_key, originalRule.rule_key);

  const reread = await call('GET', '/week-model?start=2037-01-05&end=2037-01-05');
  assert.equal(reread.status, 200, JSON.stringify(reread.body));
  const oldOccurrences = reread.body.data.occurrences.filter((row) => (
    Number(row.meal_plan_id) === planId && row.date === '2037-01-05' && row.planning_context_id == null
  ));
  assert.equal(oldOccurrences.length, 1, 'editing the plan does not duplicate an already generated date');
  assert.equal(oldOccurrences[0].id, firstMeal.id);
  assert.equal(oldOccurrences[0].assignment.id, firstAssignment.id);
  assert.equal(oldOccurrences[0].rule.label, 'Revision one dinner');
  assert.equal(oldOccurrences[0].rule.generate_preparation, true);
  assert.equal(oldOccurrences[0].rule.generate_cooking, false);
  assert.equal(database.prepare('SELECT meal_plan_rule_id FROM meals WHERE id = ?').get(firstMeal.id).meal_plan_rule_id, originalRule.id);

  database.prepare("UPDATE meals SET title = 'Revision one meal', selection_status = 'selected' WHERE id = ?").run(firstMeal.id);
  const oldExecution = await call('POST', `/${firstMeal.id}/execution-tasks`, {});
  assert.equal(oldExecution.status, 200, JSON.stringify(oldExecution.body));
  assert.deepEqual(oldExecution.body.data.tasks.map((row) => row.role), ['preparation', 'cleanup']);
  assert.equal(oldExecution.body.data.tasks.find((row) => row.role === 'preparation').due_time_snapshot, '17:15');
  assert.equal(oldExecution.body.data.tasks.find((row) => row.role === 'cleanup').due_time_snapshot, '18:20');
  const legacyReconcile = await call('POST', '/planning/reconcile', {
    date: '2037-01-05', meal_type: 'dinner',
  });
  assert.equal(legacyReconcile.status, 200, JSON.stringify(legacyReconcile.body));
  assert.ok(database.prepare('SELECT 1 FROM meals WHERE id = ?').get(firstMeal.id));
  assert.ok(database.prepare('SELECT 1 FROM meal_occurrence_assignments WHERE id = ? AND meal_id = ?')
    .get(firstAssignment.id, firstMeal.id));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM meal_execution_tasks WHERE meal_id = ?').get(firstMeal.id).count, 2);

  const nextRead = await call('GET', '/week-model?start=2037-01-12&end=2037-01-12');
  assert.equal(nextRead.status, 200, JSON.stringify(nextRead.body));
  const nextMeal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2037-01-12' AND planning_context_id IS NULL
  `).get(planId);
  assert.ok(nextMeal);
  assert.notEqual(nextMeal.meal_plan_revision_id, firstMeal.meal_plan_revision_id);
  database.prepare("UPDATE meals SET title = 'Revision two meal', selection_status = 'selected' WHERE id = ?").run(nextMeal.id);
  const newExecution = await call('POST', `/${nextMeal.id}/execution-tasks`, {});
  assert.equal(newExecution.status, 200, JSON.stringify(newExecution.body));
  assert.deepEqual(newExecution.body.data.tasks.map((row) => row.role), ['cooking']);
  assert.equal(newExecution.body.data.tasks[0].due_time_snapshot, '17:35');

  const archived = await call('DELETE', `/plans/${planId}`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
});

test('reusable slot groups, weekly cutoffs and delegated rotations materialize retry-safe execution policy', async () => {
  actor = { id: admin, role: 'admin' };
  const missingFixed = await call('POST', '/plans', {
    name: 'Invalid unnamed fixed chooser',
    rules: [{ weekday: 0, meal_type: 'dinner', policy: 'fixed', participant_ids: [admin, sam] }],
  });
  assert.equal(missingFixed.status, 400, JSON.stringify(missingFixed.body));

  const created = await call('POST', '/plans', {
    name: 'Grouped family suppers',
    effective_from: '2047-01-07',
    effective_until: '2047-01-09',
    slot_groups: [{
      weekdays: [0, 2],
      meal_type: 'custom',
      custom_label: 'Family Supper',
      policy: 'fixed',
      fixed_user_id: sam,
      chooser_backup_strategy: 'fixed',
      fallback_user_id: jamie,
      participant_ids: [admin, sam, jamie],
      cook_strategy: 'round_robin',
      cook_rotation_group: 'family-cooks',
      supervisor_strategy: 'round_robin',
      supervisor_rotation_group: 'family-supervisors',
      deadline_mode: 'weekly_cutoff',
      deadline_weekday: 5,
      deadline_time: '11:30',
      selection_deadline_value: 2,
      selection_deadline_unit: 'days',
      execution_assignment_strategies: {
        preparation: 'cook',
        cooking: 'supervisor',
        supervision: 'open_claimable',
        serving: 'chooser',
        cleanup: 'eligible_round_robin',
      },
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = Number(created.body.data.id);
  assert.equal(created.body.data.rules.length, 2);
  assert.equal(created.body.data.slot_groups.length, 1);
  assert.deepEqual(created.body.data.slot_groups[0].weekdays, [0, 2]);
  assert.equal(new Set(created.body.data.rules.map((rule) => rule.slot_group_key)).size, 1);
  for (const rule of created.body.data.rules) {
    assert.equal(rule.meal_type, 'custom');
    assert.equal(rule.custom_label, 'Family Supper');
    assert.equal(rule.chooser_backup_strategy, 'fixed');
    assert.equal(rule.deadline_mode, 'weekly_cutoff');
    assert.equal(rule.deadline_weekday, 5);
    assert.equal(rule.deadline_time, '11:30');
    assert.equal(rule.selection_deadline_value, 2);
    assert.equal(rule.selection_deadline_unit, 'days');
  }

  const week = await call('GET', '/week-model?start=2047-01-07&end=2047-01-09');
  assert.equal(week.status, 200, JSON.stringify(week.body));
  const meals = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? ORDER BY date
  `).all(planId);
  assert.equal(meals.length, 2);
  assert.deepEqual(meals.map((meal) => meal.custom_label), ['Family Supper', 'Family Supper']);
  assert.deepEqual(meals.map((meal) => meal.title), ['Choose Family Supper', 'Choose Family Supper']);
  const deadlines = database.prepare(`
    SELECT response_deadline FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id IN (?, ?) AND role = 'chooser'
     ORDER BY entity_id
  `).all(meals[0].id, meals[1].id).map((row) => row.response_deadline);
  assert.deepEqual(deadlines, ['2047-01-05T11:30:00', '2047-01-05T11:30:00'],
    'weekday 5 is the Saturday in the week before the Monday-based meal week');

  const roleRows = database.prepare(`
    SELECT m.date, ra.role, ra.strategy, ra.assigned_user_id, ra.scoped_rotation_key
      FROM meal_occurrence_role_assignments ra
      JOIN meal_occurrence_assignments oa ON oa.id = ra.occurrence_assignment_id
      JOIN meals m ON m.id = oa.meal_id
     WHERE m.meal_plan_id = ? ORDER BY m.date, ra.role
  `).all(planId);
  assert.deepEqual(
    roleRows.filter((row) => row.role === 'cook').map((row) => Number(row.assigned_user_id)),
    [admin, sam],
  );
  assert.deepEqual(
    roleRows.filter((row) => row.role === 'supervisor').map((row) => Number(row.assigned_user_id)),
    [admin, sam],
  );
  assert.notEqual(
    roleRows.find((row) => row.role === 'cook').scoped_rotation_key,
    roleRows.find((row) => row.role === 'supervisor').scoped_rotation_key,
    'cook and supervisor rotate on independent stable cursors',
  );
  const roleCursorCountsBeforeRetry = database.prepare(`
    SELECT rotation_key, occurrence_count FROM assignment_rotation_state
     WHERE rotation_key LIKE 'meal-plan:%:role:%' ORDER BY rotation_key
  `).all();
  const retryWeek = await call('GET', '/week-model?start=2047-01-07&end=2047-01-09');
  assert.equal(retryWeek.status, 200, JSON.stringify(retryWeek.body));
  assert.deepEqual(database.prepare(`
    SELECT rotation_key, occurrence_count FROM assignment_rotation_state
     WHERE rotation_key LIKE 'meal-plan:%:role:%' ORDER BY rotation_key
  `).all(), roleCursorCountsBeforeRetry, 'materialization retry does not consume delegated-role cursors');

  database.prepare("UPDATE meals SET title = 'Family Supper', selection_status = 'selected' WHERE id = ?")
    .run(meals[0].id);
  const execution = await call('POST', `/${meals[0].id}/execution-tasks`, {});
  assert.equal(execution.status, 200, JSON.stringify(execution.body));
  const byRole = new Map(execution.body.data.tasks.map((task) => [task.role, task]));
  assert.equal(byRole.get('preparation').assignment_strategy_snapshot, 'cook');
  assert.equal(byRole.get('preparation').assigned_user_id_snapshot, admin);
  assert.equal(byRole.get('cooking').assignment_strategy_snapshot, 'supervisor');
  assert.equal(byRole.get('cooking').assigned_user_id_snapshot, admin);
  assert.equal(byRole.get('serving').assignment_strategy_snapshot, 'chooser');
  assert.equal(byRole.get('serving').assigned_user_id_snapshot, sam);
  assert.equal(byRole.get('supervision').assignment_strategy_snapshot, 'open_claimable');
  assert.equal(byRole.get('supervision').assigned_user_id_snapshot, null);
  assert.equal(database.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(byRole.get('supervision').task_id).assigned_to, null);
  assert.deepEqual(database.prepare(`
    SELECT user_id FROM task_claim_eligibility WHERE task_id = ? ORDER BY user_id
  `).all(byRole.get('supervision').task_id).map((row) => Number(row.user_id)), [admin, sam, jamie]);
  assert.equal(byRole.get('cleanup').assignment_strategy_snapshot, 'eligible_round_robin');
  assert.equal(byRole.get('cleanup').assigned_user_id_snapshot, admin);
  const cleanupCursor = database.prepare(`
    SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(byRole.get('cleanup').assignment_rotation_key);
  assert.equal(cleanupCursor.occurrence_count, 1);
  const retryExecution = await call('POST', `/${meals[0].id}/execution-tasks`, {});
  assert.equal(retryExecution.status, 200, JSON.stringify(retryExecution.body));
  assert.equal(database.prepare(`
    SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(byRole.get('cleanup').assignment_rotation_key).occurrence_count, 1,
  'execution retry does not consume its assignment cursor twice');

  const disabledPlan = await call('POST', '/plans', {
    name: 'Disabled execution role',
    effective_from: '2047-01-11',
    effective_until: '2047-01-11',
    rules: [{
      weekday: 4, meal_type: 'dinner', policy: 'fixed', fixed_user_id: sam,
      participant_ids: [sam],
      execution_assignment_strategies: { preparation: 'eligible_round_robin' },
      generate_preparation: false, generate_cooking: false, generate_supervision: false,
      generate_serving: false, generate_cleanup: false,
    }],
  });
  assert.equal(disabledPlan.status, 201, JSON.stringify(disabledPlan.body));
  assert.equal((await call('GET', '/week-model?start=2047-01-11&end=2047-01-11')).status, 200);
  const disabledMeal = database.prepare(`
    SELECT id FROM meals WHERE meal_plan_id = ? AND date = '2047-01-11'
  `).get(disabledPlan.body.data.id);
  database.prepare("UPDATE meals SET title = 'Disabled execution meal', selection_status = 'selected' WHERE id = ?")
    .run(disabledMeal.id);
  const disabledExecution = await call('POST', `/${disabledMeal.id}/execution-tasks`, {});
  assert.equal(disabledExecution.status, 200, JSON.stringify(disabledExecution.body));
  assert.deepEqual(disabledExecution.body.data.tasks, []);
  const disabledRotationKey = `meal-execution:${disabledPlan.body.data.rules[0].rule_key}:task:preparation`;
  assert.equal(database.prepare(`
    SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(disabledRotationKey), undefined, 'a disabled role commits no output and consumes no cursor');
  assert.equal((await call('DELETE', `/plans/${disabledPlan.body.data.id}`)).status, 200);

  assert.equal((await call('DELETE', `/plans/${planId}`)).status, 200);
});

test('acting for another member is admin-only and every decision records beneficiary, actor and device', async () => {
  const mealId = addMeal('2034-04-03');
  addParticipant(mealId, sam, 'participant');
  addParticipant(mealId, sam, 'chooser');
  const obligationId = Number(database.prepare(`
    INSERT INTO planning_obligations (
      entity_type, entity_id, logical_key, role, responsible_user_id, status
    ) VALUES ('meal', ?, ?, 'chooser', ?, 'pending')
  `).run(mealId, `meal-domain-test:${mealId}:chooser`, sam).lastInsertRowid);
  actor = { id: jamie, role: 'member' };
  const forbiddenMenu = await call('POST', `/${mealId}/menu-items`, {
    item_type: 'entree', position: 1, title: 'Not Jamie\'s choice',
  });
  assert.equal(forbiddenMenu.status, 403);
  const forbidden = await call('POST', `/${mealId}/decisions`, {
    beneficiary_user_id: sam,
    participation: 'not_participating',
    choice_kind: 'backup',
  });
  assert.equal(forbidden.status, 403);

  actor = { id: admin, role: 'admin' };
  const saved = await call('POST', `/${mealId}/decisions`, {
    beneficiary_user_id: sam,
    participation: 'not_participating',
    choice_kind: 'household',
    menu_item_ids: [],
    device_key: 'kitchen-hub-1',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.beneficiary_user_id, sam);
  assert.equal(saved.body.data.entered_by_user_id, admin);
  assert.equal(saved.body.data.entered_via, 'administrator');
  const event = database.prepare(`
    SELECT * FROM meal_person_decision_events WHERE id = ?
  `).get(saved.body.data.audit_event_id);
  assert.equal(event.beneficiary_user_id, sam);
  assert.equal(event.actor_user_id, admin);
  assert.equal(event.actor_device_key, 'kitchen-hub-1');
  const chooser = database.prepare(`
    SELECT status FROM meal_participants WHERE meal_id = ? AND user_id = ? AND role = 'chooser'
  `).get(mealId, sam);
  const participant = database.prepare(`
    SELECT status FROM meal_participants WHERE meal_id = ? AND user_id = ? AND role = 'participant'
  `).get(mealId, sam);
  assert.equal(chooser.status, 'participating', 'skipping participation does not decline chooser responsibility');
  assert.equal(participant.status, 'not_participating');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(obligationId).status, 'pending');

  actor = { id: sam, role: 'member' };
  const entree = await call('POST', `/${mealId}/menu-items`, {
    item_type: 'entree', position: 0, title: 'Tacos',
  });
  assert.equal(entree.status, 201, JSON.stringify(entree.body));
  const chooserChoice = await call('POST', `/${mealId}/decisions`, {
    participation: 'participating', choice: 'assigned', menu_item_ids: [entree.body.data.id],
  });
  assert.equal(chooserChoice.status, 200, JSON.stringify(chooserChoice.body));
  assert.equal(chooserChoice.body.data.chooser_result.status, 'fulfilled');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(obligationId).status, 'fulfilled');
  assert.equal(database.prepare('SELECT title FROM meals WHERE id = ?').get(mealId).title, 'Tacos');
});

test('fixed chooser menu ownership separates publishing from participant choices and audits acting-for edits', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Strict fixed chooser menu',
    effective_from: '2046-01-01',
    effective_until: '2046-01-01',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: sam,
      participant_ids: [admin, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.deepEqual([...plan.body.data.rules[0].participant_ids].sort((a, b) => a - b),
    [admin, jamie, sam].sort((a, b) => a - b),
    'the fixed chooser is normalized into the participating cohort');
  const materialized = await call('GET', `/week-model?start=2046-01-01&end=2046-01-01&member_id=${admin}`);
  assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2046-01-01'
  `).get(plan.body.data.id);
  assert.ok(meal);

  const missingBeneficiary = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Unattributed edit', position: 0,
  });
  assert.equal(missingBeneficiary.status, 400, JSON.stringify(missingBeneficiary.body));
  assert.equal(missingBeneficiary.body.code, 'ACTING_FOR_CHOOSER_REQUIRED');

  const entree = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Lasagna', position: 0,
    beneficiary_user_id: sam, device_key: 'kitchen-hub-strict',
  });
  const side = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'side', title: 'Salad', position: 0,
    beneficiary_user_id: sam, device_key: 'kitchen-hub-strict',
  });
  const rejectedSharedBackup = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'backup', title: 'Soup', position: 0,
    beneficiary_user_id: sam, device_key: 'kitchen-hub-strict',
  });
  for (const response of [entree, side]) assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(rejectedSharedBackup.status, 409, JSON.stringify(rejectedSharedBackup.body));
  assert.equal(rejectedSharedBackup.body.code, 'BACKUP_MENU_ITEM_LEGACY_ONLY');
  const legacyBackupId = Number(database.prepare(`
    INSERT INTO meal_menu_items (meal_id, item_type, position, title, created_by)
    VALUES (?, 'backup', 0, 'Legacy soup backup', ?)
  `).run(meal.id, admin).lastInsertRowid);
  const legacyMenuRead = await call('GET', `/${meal.id}/menu-items`);
  assert.equal(legacyMenuRead.body.data.find((item) => Number(item.id) === legacyBackupId).legacy_only, true);
  const menuAudit = database.prepare(`
    SELECT * FROM meal_menu_item_events WHERE menu_item_id = ? ORDER BY id DESC LIMIT 1
  `).get(entree.body.data.id);
  assert.equal(menuAudit.beneficiary_user_id, sam);
  assert.equal(menuAudit.actor_user_id, admin);
  assert.equal(menuAudit.actor_device_key, 'kitchen-hub-strict');

  const actingChoice = await call('POST', `/${meal.id}/decisions`, {
    beneficiary_user_id: sam,
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [entree.body.data.id, side.body.data.id],
    confirmed: true,
    device_key: 'kitchen-hub-strict',
  });
  assert.equal(actingChoice.status, 200, JSON.stringify(actingChoice.body));
  const decisionAudit = database.prepare(`
    SELECT * FROM meal_person_decision_events WHERE id = ?
  `).get(actingChoice.body.data.audit_event_id);
  assert.equal(decisionAudit.beneficiary_user_id, sam);
  assert.equal(decisionAudit.actor_user_id, admin);
  assert.equal(decisionAudit.actor_device_key, 'kitchen-hub-strict');

  const publishedGeneration = Number(database.prepare(`
    SELECT generation FROM meal_menu_generations
     WHERE meal_id = ? AND status = 'fulfilled' ORDER BY generation DESC LIMIT 1
  `).get(meal.id).generation);
  const participantChoice = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id, side.body.data.id], confirmed: true,
  });
  assert.equal(participantChoice.status, 200, JSON.stringify(participantChoice.body));
  assert.deepEqual(participantChoice.body.data.menu_items.map((item) => item.title).sort(),
    ['Lasagna', 'Salad']);
  assert.equal(Number(database.prepare('SELECT current_menu_generation FROM meals WHERE id = ?')
    .get(meal.id).current_menu_generation), publishedGeneration,
  'an ordinary participant confirmation does not publish or replace the Household Meal');

  const actingForParticipant = await call('POST', `/${meal.id}/decisions`, {
    beneficiary_user_id: jamie,
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
    device_key: 'kitchen-hub-participant',
  });
  assert.equal(actingForParticipant.status, 200, JSON.stringify(actingForParticipant.body));
  assert.deepEqual(actingForParticipant.body.data.menu_items.map((item) => item.title), ['Lasagna']);
  assert.equal(actingForParticipant.body.data.entered_via, 'administrator');

  const missingHouseholdEntree = await call('POST', `/${meal.id}/decisions`, {
    beneficiary_user_id: jamie,
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [side.body.data.id], confirmed: true,
  });
  assert.equal(missingHouseholdEntree.status, 409, JSON.stringify(missingHouseholdEntree.body));
  assert.equal(missingHouseholdEntree.body.code, 'HOUSEHOLD_ENTREE_REQUIRED');

  actor = { id: sam, role: 'member' };
  const chooserBackup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [], selected_meal_title: 'Soup', confirmed: true,
  });
  assert.equal(chooserBackup.status, 409, JSON.stringify(chooserBackup.body));
  assert.equal(chooserBackup.body.code, 'CHOOSER_BACKUP_NOT_ALLOWED');
  const chooserSkip = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating', choice_kind: 'household', menu_item_ids: [], confirmed: true,
  });
  assert.equal(chooserSkip.status, 200, JSON.stringify(chooserSkip.body));
  assert.equal(chooserSkip.body.data.chooser_result.status, 'pending');
  assert.notEqual(chooserSkip.body.data.chooser_result.fallback.user_id, sam);

  actor = { id: jamie, role: 'member' };
  const sharedItem = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(sharedItem.status, 200, JSON.stringify(sharedItem.body));
  assert.deepEqual(sharedItem.body.data.menu_items.map((item) => item.title), ['Lasagna']);
  const mismatchedBackup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [legacyBackupId], selected_meal_title: 'Soup', confirmed: true,
  });
  assert.equal(mismatchedBackup.status, 409, JSON.stringify(mismatchedBackup.body));
  assert.equal(mismatchedBackup.body.code, 'BACKUP_MENU_IDS_NOT_ALLOWED');
  const missingBackup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup', menu_item_ids: [], confirmed: true,
  });
  assert.equal(missingBackup.status, 409, JSON.stringify(missingBackup.body));
  assert.equal(missingBackup.body.code, 'BACKUP_CHOICE_REQUIRED');
  const household = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(household.status, 200, JSON.stringify(household.body));
  assert.deepEqual(household.body.data.menu_items.map((item) => item.title), ['Lasagna']);
  const exactBackup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [], selected_meal_title: 'Soup', confirmed: true,
  });
  assert.equal(exactBackup.status, 200, JSON.stringify(exactBackup.body));
  assert.deepEqual(exactBackup.body.data.menu_items, []);
  assert.equal(exactBackup.body.data.selected_meal_title, 'Soup');
  const backupMeal = database.prepare('SELECT * FROM meals WHERE id = ?')
    .get(exactBackup.body.data.selected_meal_id);
  assert.equal(backupMeal.parent_meal_id, meal.id);
  assert.equal(backupMeal.scope, 'personal', 'Backup reuses the released individual-Meal scope domain');
  assert.equal(JSON.parse(backupMeal.provenance_json).choice_kind, 'backup');
  const backupRecipeId = Number(database.prepare(`
    INSERT INTO recipes (title, created_by) VALUES ('Freezer enchiladas', ?)
  `).run(admin).lastInsertRowid);
  const recipeBackup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [], selected_recipe_id: backupRecipeId,
    selected_meal_title: '', confirmed: true,
  });
  assert.equal(recipeBackup.status, 200, JSON.stringify(recipeBackup.body));
  assert.equal(recipeBackup.body.data.selected_meal_title, 'Freezer enchiladas');
  assert.equal(recipeBackup.body.data.selected_meal_id, exactBackup.body.data.selected_meal_id,
    'changing the individual Backup choice updates its stable linked Meal');
  assert.equal(database.prepare('SELECT recipe_id FROM meals WHERE id = ?')
    .get(recipeBackup.body.data.selected_meal_id).recipe_id, backupRecipeId);

  actor = { id: admin, role: 'admin' };
  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
});

test('a published menu stays live through a three-person chooser handoff and replacements preserve history', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Published chooser handoff',
    effective_from: '2050-01-03',
    effective_until: '2050-01-03',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: sam,
      chooser_fallback_user_ids: [jamie],
      participant_ids: [admin, sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${sam}`)).status, 200);
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2050-01-03'
  `).get(plan.body.data.id);
  assert.ok(meal);

  actor = { id: sam, role: 'member' };
  const entree = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Original casserole', position: 0,
  });
  assert.equal(entree.status, 201, JSON.stringify(entree.body));
  const original = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(original.status, 200, JSON.stringify(original.body));
  const originalObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ? ORDER BY id DESC LIMIT 1
  `).get(meal.id, sam);
  assert.equal(originalObligation.status, 'fulfilled');

  // A declines participation after publishing. B receives an editable copy,
  // while the published generation remains live for the third participant.
  const handoff = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating', choice_kind: 'household',
    menu_item_ids: [], confirmed: true,
  });
  assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
  assert.equal(handoff.body.data.chooser_result.fallback.user_id, jamie);
  const replacementObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ? AND status = 'pending'
     ORDER BY id DESC LIMIT 1
  `).get(meal.id, jamie);
  assert.ok(replacementObligation);

  const pending = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${jamie}`);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  const pendingOccurrence = pending.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(pendingOccurrence.shared_choice_active, true);
  assert.equal(pendingOccurrence.title, 'Original casserole');
  assert.equal(pendingOccurrence.selection_status, 'selected');
  assert.deepEqual(pendingOccurrence.menu_items.map((item) => item.title), ['Original casserole']);
  assert.deepEqual(pendingOccurrence.published_menu_items.map((item) => item.title), ['Original casserole']);
  assert.deepEqual(pendingOccurrence.draft_menu_items.map((item) => item.title), ['Original casserole']);
  assert.notEqual(pendingOccurrence.draft_menu_items[0].id, entree.body.data.id,
    'the incoming chooser edits a private copy rather than released menu IDs');
  assert.equal(pendingOccurrence.published_menu_generation, 1);
  assert.equal(pendingOccurrence.draft_menu_generation, 2);
  assert.equal(pendingOccurrence.menu_status, 'open');
  assert.equal(pendingOccurrence.published_menu_status, 'fulfilled');
  assert.deepEqual(pendingOccurrence.historical_menu_items, []);
  assert.equal(pendingOccurrence.current_menu_generation, 2);
  assert.deepEqual(database.prepare(`
    SELECT generation, chooser_user_id, status FROM meal_menu_generations
     WHERE meal_id = ? ORDER BY generation
  `).all(meal.id), [
    { generation: 1, chooser_user_id: sam, status: 'fulfilled' },
    { generation: 2, chooser_user_id: jamie, status: 'open' },
  ]);
  const historicalSamDecision = pendingOccurrence.decisions.find((decision) => (
    Number(decision.beneficiary_user_id) === sam
  ));
  assert.equal(historicalSamDecision.choice_kind, 'household');
  assert.equal(historicalSamDecision.is_current_choice, true);
  assert.ok(database.prepare('SELECT 1 FROM meal_person_decisions WHERE id = ?').get(original.body.data.id));

  actor = { id: admin, role: 'admin' };
  const sharedDuringHandoff = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(sharedDuringHandoff.status, 200, JSON.stringify(sharedDuringHandoff.body));
  const backupDuringHandoff = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup', menu_item_ids: [],
    selected_meal_title: 'Admin soup', confirmed: true,
  });
  assert.equal(backupDuringHandoff.status, 200, JSON.stringify(backupDuringHandoff.body));
  const handoffStatus = await call('GET', '/status?start=2050-01-03&end=2050-01-03');
  const handoffStatusOccurrence = handoffStatus.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.ok(handoffStatusOccurrence.choices.some((choice) => (
    choice.type === 'backup' && choice.title === 'Admin soup'
      && choice.people.some((person) => Number(person.user_id) === admin)
  )), 'retained shared selections never mask the beneficiary\'s current Backup Meal');

  actor = { id: jamie, role: 'member' };
  const freshMenu = await call('PUT', `/${meal.id}/menu-items`, {
    items: [{
      id: pendingOccurrence.draft_menu_items[0].id,
      item_type: 'entree', title: 'Fresh tacos', position: 0,
    }],
  });
  assert.equal(freshMenu.status, 200, JSON.stringify(freshMenu.body));
  const freshEntree = freshMenu.body.data.find((item) => item.item_type === 'entree');
  assert.ok(freshEntree);
  assert.notEqual(freshEntree.storage_position, entree.body.data.storage_position,
    'published physical positions cannot collide with the replacement draft');

  const draft = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${jamie}`);
  const draftOccurrence = draft.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(draftOccurrence.title, 'Original casserole');
  assert.equal(draftOccurrence.selection_status, 'selected');
  assert.equal(draftOccurrence.shared_choice_active, true);
  assert.deepEqual(draftOccurrence.menu_items.map((item) => item.title), ['Original casserole']);
  assert.deepEqual(draftOccurrence.draft_menu_items.map((item) => item.title), ['Fresh tacos']);

  actor = { id: sam, role: 'member' };
  const bystander = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${sam}`);
  const bystanderOccurrence = bystander.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(bystanderOccurrence.title, 'Original casserole');
  assert.deepEqual(bystanderOccurrence.menu_items.map((item) => item.title), ['Original casserole'],
    'nonchoosers keep the published menu while the incoming chooser drafts');
  assert.equal(bystanderOccurrence.controls.choose_backup, true,
    'the former chooser returns to ordinary participant controls after handoff');

  actor = { id: jamie, role: 'member' };
  const fresh = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [freshEntree.id], confirmed: true,
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?')
    .get(replacementObligation.id).status, 'fulfilled');
  const restored = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${jamie}`);
  const restoredOccurrence = restored.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(restoredOccurrence.shared_choice_active, true);
  assert.equal(restoredOccurrence.title, 'Fresh tacos');
  assert.deepEqual(restoredOccurrence.menu_items.map((item) => item.title), ['Fresh tacos']);
  assert.deepEqual(restoredOccurrence.historical_menu_items.map((item) => item.title), ['Original casserole']);
  assert.ok(database.prepare('SELECT 1 FROM meal_menu_items WHERE id = ? AND menu_generation = 1')
    .get(entree.body.data.id), 'released menu item ID remains durable');
  assert.ok(database.prepare(`
    SELECT 1 FROM meal_person_menu_selections
     WHERE decision_id = ? AND menu_item_id = ? AND selected = 1
  `).get(original.body.data.id, entree.body.data.id), 'released chooser selection remains durable');
  assert.ok(database.prepare('SELECT 1 FROM planning_obligations WHERE id = ?').get(originalObligation.id),
    'superseded responsibility remains durable history');

  // Confirmation publishes, but it does not make the chooser's menu
  // uneditable. Opening the editor clones a replacement while generation 2
  // remains live; only an explicit chooser submission activates generation 3.
  const editable = await call('GET', `/${meal.id}/menu-items`);
  assert.equal(editable.status, 200, JSON.stringify(editable.body));
  assert.equal(database.prepare('SELECT current_menu_generation FROM meals WHERE id = ?')
    .get(meal.id).current_menu_generation, 3);
  const clonedEntree = editable.body.data.find((item) => item.item_type === 'entree');
  assert.ok(clonedEntree);
  assert.notEqual(clonedEntree.id, freshEntree.id);
  const revised = await call('PUT', `/${meal.id}/menu-items`, {
    items: [{
      id: clonedEntree.id, item_type: 'entree', position: 0,
      title: 'Fresh tacos revised',
    }],
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  const duringRevision = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${admin}`);
  const duringRevisionOccurrence = duringRevision.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.deepEqual(duringRevisionOccurrence.menu_items.map((item) => item.title), ['Fresh tacos']);
  assert.deepEqual(duringRevisionOccurrence.draft_menu_items.map((item) => item.title), ['Fresh tacos revised']);
  const republished = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [revised.body.data[0].id], confirmed: true,
  });
  assert.equal(republished.status, 200, JSON.stringify(republished.body));
  const finalGenerationState = database.prepare(`
    SELECT generation, status FROM meal_menu_generations
     WHERE meal_id = ? ORDER BY generation
  `).all(meal.id);
  assert.deepEqual(finalGenerationState, [
    { generation: 1, status: 'released' },
    { generation: 2, status: 'released' },
    { generation: 3, status: 'fulfilled' },
  ]);

  // The configured closeout—not chooser confirmation—is the lock boundary.
  database.prepare(`
    UPDATE planning_obligations SET response_deadline = '2000-01-01T00:00:00Z'
     WHERE id = ?
  `).run(replacementObligation.id);
  const closed = await call('GET', `/week-model?start=2050-01-03&end=2050-01-03&member_id=${jamie}`);
  const closedOccurrence = closed.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(closedOccurrence.menu_locked, true);
  assert.equal(closedOccurrence.menu_closeout_at, '2000-01-01T00:00:00Z');
  assert.equal(closedOccurrence.controls.can_edit_shared_menu, false);
  assert.equal(closedOccurrence.controls.choose_shared_meal, false);
  assert.equal(closedOccurrence.controls.set_participation, true,
    'menu closeout does not erase the participant interaction surface');
  const generationBeforeClosedEdit = database.prepare(
    'SELECT current_menu_generation FROM meals WHERE id = ?',
  ).get(meal.id).current_menu_generation;
  const closedEdit = await call('GET', `/${meal.id}/menu-items`);
  assert.equal(closedEdit.status, 409, JSON.stringify(closedEdit.body));
  assert.equal(closedEdit.body.code, 'MEAL_MENU_CLOSED');
  assert.equal(database.prepare('SELECT current_menu_generation FROM meals WHERE id = ?')
    .get(meal.id).current_menu_generation, generationBeforeClosedEdit,
    'a rejected post-closeout editor open cannot create another generation');

  actor = { id: admin, role: 'admin' };
  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
});

test('a chooser handoff without an initial menu keeps participant backup controls usable', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'No initial menu handoff',
    effective_from: '2050-01-10',
    effective_until: '2050-01-10',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'fixed', fixed_user_id: sam,
      chooser_fallback_user_ids: [jamie], participant_ids: [admin, sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal((await call('GET', `/week-model?start=2050-01-10&end=2050-01-10&member_id=${sam}`)).status, 200);
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2050-01-10'
  `).get(plan.body.data.id);

  actor = { id: sam, role: 'member' };
  const declined = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating', choice_kind: 'household',
    menu_item_ids: [], confirmed: true,
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body.data.chooser_result.fallback.user_id, jamie);

  actor = { id: admin, role: 'admin' };
  const pending = await call('GET', `/week-model?start=2050-01-10&end=2050-01-10&member_id=${admin}`);
  const occurrence = pending.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(occurrence.shared_choice_active, false);
  assert.equal(occurrence.published_menu_generation, null);
  assert.deepEqual(occurrence.menu_items, []);
  assert.equal(occurrence.controls.choose_backup, true);
  const prematureHousehold = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [], confirmed: true,
  });
  assert.equal(prematureHousehold.status, 200, JSON.stringify(prematureHousehold.body));
  assert.equal(prematureHousehold.body.data.choice_kind, 'household');
  assert.equal(prematureHousehold.body.data.confirmed, false,
    'a household intent stays pending until a shared menu is published');
  const pendingIntent = await call('GET', `/week-model?start=2050-01-10&end=2050-01-10&member_id=${admin}`);
  const pendingIntentOccurrence = pendingIntent.body.data.occurrences
    .find((row) => Number(row.id) === Number(meal.id));
  assert.equal(pendingIntentOccurrence.my_decision.choice_kind, 'pending');
  assert.equal(pendingIntentOccurrence.my_decision.is_current_choice, false);
  assert.equal(database.prepare(`
    SELECT choice_kind FROM meal_person_decisions
     WHERE meal_id = ? AND beneficiary_user_id = ?
  `).get(meal.id, admin).choice_kind, 'household',
  'the pending projection preserves the participant\'s household intent');
  const backup = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup', menu_item_ids: [],
    selected_meal_title: 'Freezer pasta', confirmed: true,
  });
  assert.equal(backup.status, 200, JSON.stringify(backup.body));

  actor = { id: jamie, role: 'member' };
  const entree = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'New chooser curry', position: 0,
  });
  assert.equal(entree.status, 201, JSON.stringify(entree.body));
  const published = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  actor = { id: admin, role: 'admin' };
  const household = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  assert.equal(household.status, 200, JSON.stringify(household.body));
  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
});

test('Personal Choice creates one linked personal Meal, fulfills only that member, and keeps acting-for audit', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Personal Monday choices',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'personal_choice',
      participant_ids: [sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.data.rules[0].fallback_user_id, null);
  assert.equal(plan.body.data.rules[0].chooser_backup_strategy, 'next_eligible');
  const planId = Number(plan.body.data.id);
  const week = await call('GET', '/week-model?start=2039-01-03&end=2039-01-03&member_id=2');
  assert.equal(week.status, 200, JSON.stringify(week.body));
  const parent = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2039-01-03'
      AND planning_context_id IS NULL AND parent_meal_id IS NULL
  `).get(planId);
  assert.ok(parent);
  const samObligation = database.prepare(`
    SELECT id, status FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ?
  `).get(parent.id, sam);
  const jamieObligation = database.prepare(`
    SELECT id, status FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ?
  `).get(parent.id, jamie);
  assert.equal(samObligation.status, 'pending');
  assert.equal(jamieObligation.status, 'pending');

  // Simulate data written before Personal Choice and shared-menu semantics were
  // separated. It remains in storage as audit/history, but every modern read
  // and write surface must treat it as inapplicable.
  const legacyEntreeId = Number(database.prepare(`
    INSERT INTO meal_menu_items (meal_id, item_type, position, title, created_by)
    VALUES (?, 'entree', 0, 'Legacy shared entree', ?)
  `).run(parent.id, admin).lastInsertRowid);
  const legacyBackupId = Number(database.prepare(`
    INSERT INTO meal_menu_items (meal_id, item_type, position, title, created_by)
    VALUES (?, 'backup', 0, 'Legacy backup', ?)
  `).run(parent.id, admin).lastInsertRowid);
  const legacyDecisionId = Number(database.prepare(`
    INSERT INTO meal_person_decisions (
      meal_id, beneficiary_user_id, participation, choice_kind, confirmed,
      entered_by_user_id, entered_via
    ) VALUES (?, ?, 'participating', 'backup', 1, ?, 'self')
  `).run(parent.id, sam, sam).lastInsertRowid);
  database.prepare(`
    INSERT INTO meal_person_menu_selections (decision_id, menu_item_id, selected)
    VALUES (?, ?, 1)
  `).run(legacyDecisionId, legacyBackupId);

  const legacyRead = await call('GET', `/week-model?start=2039-01-03&end=2039-01-03&member_id=${sam}`);
  const legacyOccurrence = legacyRead.body.data.occurrences.find((row) => Number(row.id) === Number(parent.id));
  assert.deepEqual(legacyOccurrence.menu_items, []);
  assert.deepEqual(legacyOccurrence.my_decision.menu_items, []);
  assert.equal(legacyOccurrence.controls.choose_backup, false);
  assert.equal(legacyOccurrence.controls.can_edit_shared_menu, false);
  const legacyStatus = await call('GET', '/status?start=2039-01-03&end=2039-01-03');
  const legacyStatusOccurrence = legacyStatus.body.data.occurrences.find((row) => Number(row.id) === Number(parent.id));
  assert.deepEqual(legacyStatusOccurrence.menu_items, []);
  assert.deepEqual(legacyStatusOccurrence.decisions.find((row) => Number(row.beneficiary_user_id) === sam).menu_items, []);
  assert.ok(!legacyStatusOccurrence.choices.some((choice) => choice.type === 'backup'));

  actor = { id: sam, role: 'member' };
  const personalMenuEdit = await call('POST', `/${parent.id}/menu-items`, {
    item_type: 'entree', title: 'Shared menu takeover', position: 0,
  });
  assert.equal(personalMenuEdit.status, 403, 'Personal Choice ownership never grants shared-menu authority');
  const craftedBackup = await call('POST', `/${parent.id}/decisions`, {
    participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [legacyBackupId], confirmed: true,
  });
  assert.equal(craftedBackup.status, 409, JSON.stringify(craftedBackup.body));
  assert.equal(craftedBackup.body.code, 'PERSONAL_CHOICE_BACKUP_NOT_ALLOWED');
  const craftedShared = await call('POST', `/${parent.id}/decisions`, {
    participation: 'participating', choice_kind: 'household',
    menu_item_ids: [legacyEntreeId], confirmed: true,
  });
  assert.equal(craftedShared.status, 409, JSON.stringify(craftedShared.body));
  assert.equal(craftedShared.body.code, 'PERSONAL_CHOICE_MENU_NOT_ALLOWED');

  actor = { id: admin, role: 'admin' };
  const adminMenuEdit = await call('POST', `/${parent.id}/menu-items`, {
    item_type: 'entree', title: 'Admin shared takeover', position: 1,
    beneficiary_user_id: sam,
  });
  assert.equal(adminMenuEdit.status, 403, JSON.stringify(adminMenuEdit.body));
  assert.equal(adminMenuEdit.body.code, 'MEAL_MENU_PERSONAL_CHOICE_NOT_ALLOWED');
  const selected = await call('POST', `/${parent.id}/decisions`, {
    beneficiary_user_id: sam,
    participation: 'participating',
    choice_kind: 'restaurant',
    selected_meal_title: 'Corner Cafe',
    confirmed: true,
    device_key: 'kitchen-wall-display',
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.data.beneficiary_user_id, sam);
  assert.equal(selected.body.data.entered_by_user_id, admin);
  assert.equal(selected.body.data.entered_by_device_key, 'kitchen-wall-display');
  assert.equal(selected.body.data.selected_meal_title, 'Corner Cafe');
  assert.equal(selected.body.data.chooser_result.status, 'fulfilled');
  assert.deepEqual(selected.body.data.menu_items, []);
  assert.ok(database.prepare(`
    SELECT 1 FROM meal_person_menu_selections WHERE decision_id = ? AND menu_item_id = ?
  `).get(legacyDecisionId, legacyBackupId), 'legacy selection history remains stored');

  const personalMealId = Number(selected.body.data.selected_meal_id);
  const personalMeal = database.prepare('SELECT * FROM meals WHERE id = ?').get(personalMealId);
  assert.equal(personalMeal.parent_meal_id, parent.id);
  assert.equal(personalMeal.scope, 'restaurant');
  assert.equal(personalMeal.source_key, `meal-person-decision:${parent.id}:${sam}`);
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(samObligation.id).status, 'fulfilled');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(jamieObligation.id).status, 'pending');

  actor = { id: sam, role: 'member' };
  const revised = await call('POST', `/${parent.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'takeout',
    selected_meal_title: 'Noodle takeout',
    selected_recipe_id: null,
    confirmed: true,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(Number(revised.body.data.selected_meal_id), personalMealId, 'editing reuses the stable personal Meal');
  assert.equal(database.prepare('SELECT title FROM meals WHERE id = ?').get(personalMealId).title, 'Noodle takeout');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM meal_person_decision_events WHERE decision_id = ?
  `).get(revised.body.data.id).count, 2);

  const reread = await call('GET', '/week-model?start=2039-01-03&end=2039-01-03&member_id=2');
  assert.equal(reread.status, 200, JSON.stringify(reread.body));
  const matching = reread.body.data.occurrences.filter((row) => Number(row.id) === Number(parent.id));
  assert.equal(matching.length, 1, 'the personal child never becomes a duplicate weekly occurrence');
  assert.equal(matching[0].my_decision.selected_meal_title, 'Noodle takeout');
  actor = { id: admin, role: 'admin' };
  const archived = await call('DELETE', `/plans/${planId}`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
});

test('unscoped one-off household Meals stay visible without unsafe decision controls', async () => {
  actor = { id: admin, role: 'admin' };
  const mealId = addMeal('2040-01-02', 'One-off family supper');
  const read = await call('GET', `/week-model?start=2040-01-02&end=2040-01-02&member_id=${admin}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const occurrence = read.body.data.occurrences.find((row) => Number(row.id) === mealId);
  assert.ok(occurrence);
  assert.equal(occurrence.applicable, true);
  assert.deepEqual(occurrence.controls, {
    can_edit_shared_menu: false,
    choose_shared_meal: false,
    choose_personal_meal: false,
    set_participation: false,
    choose_backup: false,
    skip: false,
    add_notes: false,
  });
});

test('manual and recurring custom Meals require and preserve their display label', async () => {
  actor = { id: admin, role: 'admin' };
  const missing = await call('POST', '/', {
    date: '2049-01-04', meal_type: 'custom', title: 'Tea service',
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  const created = await call('POST', '/', {
    date: '2049-01-04', meal_type: 'custom', custom_label: 'Afternoon Tea',
    title: 'Tea service', repeat_weekly: true,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.custom_label, 'Afternoon Tea');
  const template = database.prepare(`
    SELECT * FROM meal_recurrence_templates WHERE id = ?
  `).get(created.body.data.recurrence_template_id);
  assert.equal(template.custom_label, 'Afternoon Tea');
  const future = await call('GET', '/?week=2049-01-11');
  assert.equal(future.status, 200, JSON.stringify(future.body));
  const next = future.body.data.find((meal) => Number(meal.recurrence_template_id) === Number(template.id));
  assert.equal(next.custom_label, 'Afternoon Tea');

  const invalidEdit = await call('PUT', `/${created.body.data.id}?scope=series`, { custom_label: '' });
  assert.equal(invalidEdit.status, 400, JSON.stringify(invalidEdit.body));
  const updated = await call('PUT', `/${created.body.data.id}?scope=series`, {
    custom_label: 'Sunday Tea',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(database.prepare('SELECT custom_label FROM meal_recurrence_templates WHERE id = ?').get(template.id).custom_label, 'Sunday Tea');
  assert.deepEqual(database.prepare(`
    SELECT DISTINCT custom_label FROM meals WHERE recurrence_template_id = ?
  `).all(template.id).map((row) => row.custom_label), ['Sunday Tea']);
  assert.equal((await call('DELETE', `/${created.body.data.id}?scope=series`)).status, 204);
});

test('complete menu replacement is atomic, chooser-authorized, and preserves selected history', async () => {
  actor = { id: admin, role: 'admin' };
  const mealId = addMeal('2040-02-01', 'Menu replacement supper');
  addParticipant(mealId, admin, 'participant');
  addParticipant(mealId, sam, 'chooser');
  const entree = await call('POST', `/${mealId}/menu-items`, {
    item_type: 'entree', position: 0, title: 'Old tacos', beneficiary_user_id: sam,
  });
  const side = await call('POST', `/${mealId}/menu-items`, {
    item_type: 'side', position: 0, title: 'Rice', beneficiary_user_id: sam,
  });
  assert.equal(entree.status, 201, JSON.stringify(entree.body));
  assert.equal(side.status, 201, JSON.stringify(side.body));
  const legacyBackupId = Number(database.prepare(`
    INSERT INTO meal_menu_items (meal_id, item_type, position, title, created_by)
    VALUES (?, 'backup', 0, 'Frozen pizza', ?)
  `).run(mealId, admin).lastInsertRowid);

  actor = { id: sam, role: 'member' };
  const selected = await call('POST', `/${mealId}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [side.body.data.id],
    confirmed: false,
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));

  const replaced = await call('PUT', `/${mealId}/menu-items`, {
    items: [
      {
        id: entree.body.data.id, item_type: 'entree', position: 0,
        title: 'Vegetable tacos', recipe_id: null, notes: null,
      },
      {
        id: side.body.data.id, item_type: 'side', position: 0,
        title: 'Rice', recipe_id: null, notes: null,
      },
      { item_type: 'side', title: 'Black beans' },
    ],
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(
    replaced.body.data.map((item) => [item.item_type, item.position, item.title]),
    [
      ['entree', 0, 'Vegetable tacos'],
      ['side', 0, 'Rice'],
      ['side', 1, 'Black beans'],
      ['backup', 0, 'Frozen pizza'],
    ],
  );
  assert.ok(database.prepare('SELECT 1 FROM meal_menu_items WHERE id = ?').get(legacyBackupId),
    'a released Backup menu row is preserved as immutable audit history');
  assert.equal(replaced.body.data.find((item) => Number(item.id) === legacyBackupId).legacy_only, true);
  const legacyBackupEdit = await call('PUT', `/${mealId}/menu-items/${legacyBackupId}`, {
    item_type: 'backup', title: 'Changed frozen pizza', position: 0,
  });
  assert.equal(legacyBackupEdit.status, 409, JSON.stringify(legacyBackupEdit.body));
  assert.equal(legacyBackupEdit.body.code, 'BACKUP_MENU_ITEM_LEGACY_ONLY');
  const legacyBackupDelete = await call('DELETE', `/${mealId}/menu-items/${legacyBackupId}`);
  assert.equal(legacyBackupDelete.status, 409, JSON.stringify(legacyBackupDelete.body));
  assert.equal(legacyBackupDelete.body.code, 'BACKUP_MENU_ITEM_LEGACY_ONLY');
  assert.ok(database.prepare('SELECT 1 FROM meal_person_menu_selections WHERE menu_item_id = ? AND selected = 1')
    .get(side.body.data.id));

  const completeMenu = replaced.body.data.map((item) => ({
    id: item.id,
    item_type: item.item_type,
    position: item.position,
    title: item.title,
    recipe_id: item.recipe_id,
    notes: item.notes,
  }));
  const snapshot = () => database.prepare(`
    SELECT id, item_type, position, title, recipe_id, notes
      FROM meal_menu_items WHERE meal_id = ? ORDER BY id
  `).all(mealId);
  const beforeRejectedChanges = snapshot();

  const omittedSelection = await call('PUT', `/${mealId}/menu-items`, {
    items: completeMenu.filter((item) => Number(item.id) !== Number(side.body.data.id)),
  });
  assert.equal(omittedSelection.status, 409, JSON.stringify(omittedSelection.body));
  assert.equal(omittedSelection.body.code, 'MENU_ITEM_IN_USE');
  assert.deepEqual(snapshot(), beforeRejectedChanges, 'rejected omission writes nothing');

  const mutatedSelection = await call('PUT', `/${mealId}/menu-items`, {
    items: completeMenu.map((item) => Number(item.id) === Number(side.body.data.id)
      ? { ...item, title: 'Changed historical rice' }
      : item),
  });
  assert.equal(mutatedSelection.status, 409, JSON.stringify(mutatedSelection.body));
  assert.equal(mutatedSelection.body.code, 'MENU_ITEM_IN_USE');
  assert.deepEqual(snapshot(), beforeRejectedChanges, 'rejected mutation writes nothing');

  const tooManyEntrees = await call('PUT', `/${mealId}/menu-items`, {
    items: [...completeMenu, { item_type: 'entree', position: 1, title: 'Second entree' }],
  });
  assert.equal(tooManyEntrees.status, 400, JSON.stringify(tooManyEntrees.body));
  assert.equal(tooManyEntrees.body.code, 'MEAL_MENU_LIMIT_EXCEEDED');
  assert.deepEqual(snapshot(), beforeRejectedChanges, 'limit validation writes nothing');

  const otherMealId = addMeal('2040-02-02', 'Other menu');
  actor = { id: admin, role: 'admin' };
  const otherItem = await call('POST', `/${otherMealId}/menu-items`, {
    item_type: 'entree', position: 0, title: 'Other entree',
  });
  actor = { id: sam, role: 'member' };
  const foreignItem = await call('PUT', `/${mealId}/menu-items`, {
    items: [...completeMenu, { id: otherItem.body.data.id, item_type: 'backup', position: 0, title: 'Foreign' }],
  });
  assert.equal(foreignItem.status, 404, JSON.stringify(foreignItem.body));
  assert.equal(foreignItem.body.code, 'MENU_ITEM_NOT_FOUND');
  assert.deepEqual(snapshot(), beforeRejectedChanges, 'foreign ownership validation writes nothing');

  actor = { id: jamie, role: 'member' };
  const unauthorized = await call('PUT', `/${mealId}/menu-items`, { items: completeMenu });
  assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.body));
  assert.equal(unauthorized.body.code, 'MEAL_MENU_NOT_ALLOWED');
  assert.deepEqual(snapshot(), beforeRejectedChanges, 'authorization failure writes nothing');

  actor = { id: admin, role: 'admin' };
  const swapMealId = addMeal('2040-02-03', 'Side-order swap');
  const firstSide = await call('POST', `/${swapMealId}/menu-items`, {
    item_type: 'side', position: 0, title: 'Salad',
  });
  const secondSide = await call('POST', `/${swapMealId}/menu-items`, {
    item_type: 'side', position: 1, title: 'Bread',
  });
  const swapped = await call('PUT', `/${swapMealId}/menu-items`, {
    items: [
      { id: firstSide.body.data.id, item_type: 'side', position: 1, title: 'Salad' },
      { id: secondSide.body.data.id, item_type: 'side', position: 0, title: 'Bread' },
    ],
  });
  assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
  assert.deepEqual(
    swapped.body.data.map((item) => [Number(item.id), item.position]),
    [[Number(secondSide.body.data.id), 0], [Number(firstSide.body.data.id), 1]],
    'position swaps succeed without a transient unique-position failure',
  );
});

test('Meal Status aggregates household, Backup Meal and unresolved people independently', async () => {
  actor = { id: admin, role: 'admin' };
  const mealId = addMeal('2034-05-01', 'Spaghetti');
  for (const userId of [admin, sam, jamie]) addParticipant(mealId, userId);
  const entree = await call('POST', `/${mealId}/menu-items`, {
    item_type: 'entree', position: 0, title: 'Spaghetti',
  });
  await call('POST', `/${mealId}/decisions`, {
    beneficiary_user_id: admin, participation: 'participating', choice_kind: 'household',
    menu_item_ids: [entree.body.data.id], confirmed: true,
  });
  await call('POST', `/${mealId}/decisions`, {
    beneficiary_user_id: sam, participation: 'participating', choice_kind: 'backup',
    menu_item_ids: [], selected_meal_title: 'Chicken nuggets', confirmed: true,
  });

  const status = await call('GET', '/status?start=2034-05-01&end=2034-05-01');
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const occurrence = status.body.data.occurrences.find((row) => Number(row.id) === mealId);
  assert.equal(occurrence.choices.find((row) => row.title === 'Spaghetti').count, 1);
  assert.equal(occurrence.choices.find((row) => row.title === 'Chicken nuggets').count, 1);
  assert.deepEqual(occurrence.pending_people.map((row) => row.id), [jamie]);
  assert.equal(occurrence.totals.pending, 1);
});

test('context occurrence assignments use an isolated cursor and never advance the base rotation', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Monday rotation',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'round_robin', rotation_group: 'family-dinner',
      participant_ids: [admin, sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const planId = plan.body.data.id;
  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:meal-plan-test', 'Business trip', 'travel',
      '2026-08-31T00:00:00', '2026-08-31T23:59:00', ?)
  `).run(admin).lastInsertRowid);
  for (const userId of [admin, sam]) {
    database.prepare(`
      INSERT INTO planning_context_members (planning_context_id, user_id, added_by)
      VALUES (?, ?, ?)
    `).run(contextId, userId, admin);
  }
  database.prepare(`
    INSERT INTO planning_context_meal_plans (planning_context_id, meal_plan_id, created_by)
    VALUES (?, ?, ?)
  `).run(contextId, planId, admin);

  const contextRead = await call('GET', `/week-model?start=2026-08-31&end=2026-08-31&context_id=${contextId}&member_id=${admin}`);
  assert.equal(contextRead.status, 200, JSON.stringify(contextRead.body));
  const contextKey = `meal-plan:${planId}:family-dinner:chooser:context:${contextId}`;
  const baseKey = `meal-plan:${planId}:family-dinner:chooser`;
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(contextKey).occurrence_count, 1);
  assert.equal(database.prepare('SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey), undefined);

  const repeatContextRead = await call('GET', `/week-model?start=2026-08-31&end=2026-08-31&planning_context_id=${contextId}&member_id=${sam}`);
  assert.equal(repeatContextRead.status, 200, JSON.stringify(repeatContextRead.body));
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(contextKey).occurrence_count, 1);

  const householdRead = await call('GET', `/week-model?start=2026-08-31&end=2026-08-31&member_id=${jamie}`);
  assert.equal(householdRead.status, 200, JSON.stringify(householdRead.body));
  assert.equal(database.prepare('SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey), undefined);
  const homeSplitKey = `${baseKey}:home-split:${contextId}`;
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(homeSplitKey).occurrence_count, 1);
  const baseAssignment = database.prepare(`
    SELECT * FROM meal_occurrence_assignments WHERE scoped_rotation_key = ?
  `).get(homeSplitKey);
  assert.equal(baseAssignment.assigned_user_id, jamie, 'travelers are excluded from the home occurrence pool');
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(contextKey).occurrence_count, 1);

  const resumedHomeRead = await call('GET', `/week-model?start=2026-09-07&end=2026-09-07&member_id=${admin}`);
  assert.equal(resumedHomeRead.status, 200, JSON.stringify(resumedHomeRead.body));
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey).occurrence_count, 1);
  const resumedAssignment = database.prepare(`
    SELECT * FROM meal_occurrence_assignments WHERE scoped_rotation_key = ?
  `).get(baseKey);
  assert.equal(resumedAssignment.assigned_user_id, admin, 'the permanent rotation resumes from its pre-split cursor');
});

test('Meal Plans can be disabled at Home while a Trip inherits its own date window and grocery override', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Trip-only dinners',
    home_enabled: false,
    effective_from: '2026-08-31',
    effective_until: '2026-08-31',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'fixed', fixed_user_id: admin,
      participant_ids: [admin],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.data.home_enabled, false);
  const planId = Number(plan.body.data.id);

  const disabledHome = await call('GET', '/week-model?start=2026-08-31&end=2026-08-31');
  assert.equal(disabledHome.status, 200, JSON.stringify(disabledHome.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meals
     WHERE meal_plan_id = ? AND planning_context_id IS NULL AND date = '2026-08-31'
  `).get(planId).n, 0);

  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:context-activation-test', 'Context activation trip', 'travel',
      '2026-09-07T00:00:00Z', '2026-09-08T00:00:00Z', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by)
    VALUES (?, ?, ?)
  `).run(contextId, admin, admin);

  const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.deepEqual(database.prepare(`
    SELECT effective_from, effective_until
      FROM planning_context_meal_plans
     WHERE planning_context_id = ? AND meal_plan_id = ?
  `).get(contextId, planId), { effective_from: '2026-09-07', effective_until: '2026-09-07' });

  const tripRead = await call('GET', `/week-model?start=2026-09-07&end=2026-09-07&context_id=${contextId}`);
  assert.equal(tripRead.status, 200, JSON.stringify(tripRead.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meals
     WHERE meal_plan_id = ? AND planning_context_id = ? AND date = '2026-09-07'
  `).get(planId, contextId).n, 1, 'Trip dates govern the attached reusable plan');

  const grocery = await call('PUT', `/grocery-settings/contexts/${contextId}`, { track_groceries: false });
  assert.equal(grocery.status, 200, JSON.stringify(grocery.body));
  assert.equal(grocery.body.data.track_groceries, false);
  const groceryRead = await call('GET', `/grocery-settings/contexts/${contextId}`);
  assert.equal(groceryRead.status, 200, JSON.stringify(groceryRead.body));
  assert.equal(groceryRead.body.data.track_groceries, false);

  const enabled = await call('PUT', `/plans/${planId}/home`, { enabled: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.data.home_enabled, true);
  const enabledHome = await call('GET', '/week-model?start=2026-08-31&end=2026-08-31');
  assert.equal(enabledHome.status, 200, JSON.stringify(enabledHome.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meals
     WHERE meal_plan_id = ? AND planning_context_id IS NULL AND date = '2026-08-31'
  `).get(planId).n, 1);
});

test('a Travel context added after week generation safely re-scopes untouched home output without consuming the permanent cursor', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Late travel reconciliation',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'round_robin', rotation_group: 'late-travel-dinner',
      participant_ids: [admin, sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const planId = Number(plan.body.data.id);
  const baseKey = `meal-plan:${planId}:late-travel-dinner:chooser`;

  const initial = await call('GET', '/week-model?start=2036-01-07&end=2036-01-07');
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const original = database.prepare(`
    SELECT oa.*, m.id AS generated_meal_id
      FROM meal_occurrence_assignments oa
      JOIN meals m ON m.id = oa.meal_id
     WHERE oa.base_rotation_key = ? AND oa.planning_context_id IS NULL
       AND m.date = '2036-01-07'
  `).get(baseKey);
  assert.ok(original);
  assert.equal(original.scoped_rotation_key, baseKey);
  assert.equal(original.assigned_user_id, admin);
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey).occurrence_count, 1);

  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:late-travel-reconcile', 'Late trip', 'travel',
      '2036-01-07T00:00:00', '2036-01-08T00:00:00', ?)
  `).run(admin).lastInsertRowid);
  for (const userId of [admin, sam]) {
    database.prepare(`
      INSERT INTO planning_context_members (planning_context_id, user_id, added_by)
      VALUES (?, ?, ?)
    `).run(contextId, userId, admin);
  }
  const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
  assert.equal(attached.status, 200, JSON.stringify(attached.body));

  const reconciled = await call('GET', '/week-model?start=2036-01-07&end=2036-01-07');
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  const homeSplitKey = `${baseKey}:home-split:${contextId}`;
  const home = database.prepare(`
    SELECT * FROM meal_occurrence_assignments WHERE id = ?
  `).get(original.id);
  assert.equal(home.meal_id, original.generated_meal_id, 'focused reconciliation keeps the same dated Meal identity');
  assert.equal(home.scoped_rotation_key, homeSplitKey);
  assert.equal(home.assigned_user_id, jamie);
  assert.equal(database.prepare('SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey), undefined);
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(homeSplitKey).occurrence_count, 1);
  assert.deepEqual(database.prepare(`
    SELECT user_id FROM meal_participants
     WHERE meal_id = ? AND role = 'participant' AND source = 'schedule'
     ORDER BY user_id
  `).all(home.meal_id).map((row) => Number(row.user_id)), [jamie]);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM meal_occurrence_assignments
     WHERE meal_plan_rule_id = ? AND occurrence_key LIKE '%:2036-01-07:%'
  `).get(plan.body.data.rules[0].id).count, 2, 'one home occurrence and one context occurrence exist');

  const retry = await call('GET', '/week-model?start=2036-01-07&end=2036-01-07');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(homeSplitKey).occurrence_count, 1);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM meal_occurrence_assignments
     WHERE meal_plan_rule_id = ? AND occurrence_key LIKE '%:2036-01-07:%'
  `).get(plan.body.data.rules[0].id).count, 2, 'retry remains idempotent');

  const resumed = await call('GET', '/week-model?start=2036-01-14&end=2036-01-14');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(baseKey).occurrence_count, 1);
  assert.equal(database.prepare(`
    SELECT assigned_user_id FROM meal_occurrence_assignments
     WHERE base_rotation_key = ? AND scoped_rotation_key = ? AND occurrence_key LIKE '%:2036-01-14:%'
  `).get(baseKey, baseKey).assigned_user_id, admin, 'the permanent sequence resumes from its pre-trip cursor');

  const archived = await call('DELETE', `/plans/${planId}`);
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
});

test('migration-backed schedule slots keep their legacy cursor isolated during a household split', async () => {
  actor = { id: admin, role: 'admin' };
  const slotId = Number(database.prepare(`
    INSERT INTO meal_schedule_slots (
      weekday, meal_type, policy, rotation_group, active, created_by
    ) VALUES (1, 'dinner', 'round_robin', 'legacy-family', 1, ?)
  `).run(admin).lastInsertRowid);
  for (const userId of [admin, sam, jamie]) {
    database.prepare(`
      INSERT INTO meal_schedule_slot_participants (schedule_slot_id, user_id) VALUES (?, ?)
    `).run(slotId, userId);
  }
  const planId = Number(database.prepare(`
    INSERT INTO meal_plans (
      name, status, current_revision, legacy_schedule_slot_id, created_by
    ) VALUES ('Imported Tuesday dinner', 'active', 1, ?, ?)
  `).run(slotId, admin).lastInsertRowid);
  database.prepare('UPDATE meal_schedule_slots SET meal_plan_id = ? WHERE id = ?').run(planId, slotId);
  const ruleId = Number(database.prepare(`
    INSERT INTO meal_plan_rules (
      meal_plan_id, weekday, meal_type, policy, rotation_group, active
    ) VALUES (?, 1, 'dinner', 'round_robin', 'legacy-family', 1)
  `).run(planId).lastInsertRowid);
  for (const userId of [admin, sam, jamie]) {
    database.prepare(`
      INSERT INTO meal_plan_rule_participants (meal_plan_rule_id, user_id) VALUES (?, ?)
    `).run(ruleId, userId);
  }
  database.prepare(`
    INSERT INTO meal_plan_revisions (meal_plan_id, revision, snapshot_json, created_by)
    VALUES (?, 1, '{}', ?)
  `).run(planId, admin);

  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:legacy-meal-plan-test', 'Legacy cursor trip', 'travel',
      '2035-01-02T00:00:00', '2035-01-03T00:00:00', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by)
    VALUES (?, ?, ?)
  `).run(contextId, admin, admin);
  const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
  assert.equal(attached.status, 200, JSON.stringify(attached.body));

  const splitRead = await call('GET', '/week-model?start=2035-01-02&end=2035-01-02');
  assert.equal(splitRead.status, 200, JSON.stringify(splitRead.body));
  const permanentKey = 'meal:legacy-family:chooser';
  const homeSplitKey = `${permanentKey}:home-split:${contextId}`;
  const contextKey = `${permanentKey}:context:${contextId}`;
  assert.equal(database.prepare('SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?').get(permanentKey), undefined);
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(homeSplitKey).occurrence_count, 1);
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(contextKey).occurrence_count, 1);
  assert.equal(database.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE scoped_rotation_key = ?').get(homeSplitKey).assigned_user_id, sam);
  assert.equal(database.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE scoped_rotation_key = ?').get(contextKey).assigned_user_id, admin);

  const resumedRead = await call('GET', '/week-model?start=2035-01-09&end=2035-01-09');
  assert.equal(resumedRead.status, 200, JSON.stringify(resumedRead.body));
  assert.equal(database.prepare('SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?').get(permanentKey).occurrence_count, 1);
  assert.equal(database.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE scoped_rotation_key = ?').get(permanentKey).assigned_user_id, admin);
});

test('post-migration legacy schedule writes promote into the canonical context-aware Meal Plan engine', async () => {
  actor = { id: admin, role: 'admin' };
  const legacyPayload = (active, policy = 'round_robin') => ({
    timing_defaults: [],
    slots: [{
      weekday: 4,
      meal_type: 'dinner',
      policy,
      rotation_group: 'post-migration-friday',
      participant_ids: [admin, sam, jamie],
      preferred_time: '18:00',
      expected_duration_minutes: 60,
      selection_deadline_minutes: 1440,
      reminder_minutes: 120,
      snack_choice_limit: 3,
      active,
    }],
  });
  const created = await call('PUT', '/planning', legacyPayload(true));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const slot = database.prepare(`
    SELECT * FROM meal_schedule_slots WHERE weekday = 4 AND meal_type = 'dinner'
  `).get();
  assert.ok(slot?.meal_plan_id, 'a new compatibility slot is linked to a canonical Meal Plan');
  const planId = Number(slot.meal_plan_id);
  const plan = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(planId);
  assert.equal(plan.legacy_schedule_slot_id, slot.id);
  assert.equal(plan.current_revision, 1);
  const rule = database.prepare(`
    SELECT * FROM meal_plan_rules WHERE meal_plan_id = ? AND retired_at IS NULL
  `).get(planId);
  assert.equal(rule.rule_key, `legacy-slot:${slot.id}`);
  assert.equal(rule.policy, 'round_robin');

  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:post-migration-slot', 'Friday trip', 'travel',
      '2038-01-08T00:00:00', '2038-01-09T00:00:00', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by)
    VALUES (?, ?, ?)
  `).run(contextId, admin, admin);
  const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
  assert.equal(attached.status, 200, JSON.stringify(attached.body));

  const split = await call('GET', '/week-model?start=2038-01-08&end=2038-01-08');
  assert.equal(split.status, 200, JSON.stringify(split.body));
  const permanentKey = 'meal:post-migration-friday:chooser';
  assert.equal(database.prepare('SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?').get(permanentKey), undefined);
  assert.equal(database.prepare(`
    SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(`${permanentKey}:home-split:${contextId}`).occurrence_count, 1);
  assert.equal(database.prepare(`
    SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(`${permanentKey}:context:${contextId}`).occurrence_count, 1);

  const edited = await call('PUT', '/planning', legacyPayload(true, 'fixed'));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const editedPlan = database.prepare('SELECT * FROM meal_plans WHERE id = ?').get(planId);
  assert.equal(editedPlan.current_revision, 2);
  assert.equal(database.prepare(`
    SELECT policy FROM meal_plan_rules WHERE meal_plan_id = ? AND retired_at IS NULL
  `).get(planId).policy, 'fixed');

  const disabled = await call('PUT', '/planning', legacyPayload(false, 'fixed'));
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(database.prepare('SELECT status FROM meal_plans WHERE id = ?').get(planId).status, 'archived');
  const future = await call('GET', '/week-model?start=2038-01-15&end=2038-01-15');
  assert.equal(future.status, 200, JSON.stringify(future.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM meals WHERE meal_plan_id = ? AND date = '2038-01-15'
  `).get(planId).count, 0, 'deactivation prevents future named or legacy fallback output');
});

test('fresh contexts auto-attach only one unambiguous active plan and otherwise require explicit selection', async () => {
  actor = { id: admin, role: 'admin' };
  const defaultPlan = database.prepare(`
    SELECT id FROM meal_plans WHERE name = 'Monday rotation' AND status = 'active'
  `).get();
  assert.ok(defaultPlan);
  const autoContext = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:auto-plan-test', 'Solo trip', 'travel',
      '2026-09-07T00:00:00', '2026-09-07T23:59:00', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by) VALUES (?, ?, ?)
  `).run(autoContext, admin, admin);
  const auto = await call('GET', `/week-model?start=2026-09-07&end=2026-09-07&planning_context_id=${autoContext}`);
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(auto.body.data.context_plan.status, 'auto_attached');
  assert.equal(auto.body.data.context_plan.plans[0].meal_plan_id, defaultPlan.id);
  assert.equal(auto.body.data.occurrences.length, 1);
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_context_meal_plans WHERE planning_context_id = ? AND meal_plan_id = ?
  `).get(autoContext, defaultPlan.id));

  const alternate = await call('POST', '/plans', {
    name: 'Alternate travel meals',
    rules: [{ weekday: 0, meal_type: 'dinner', policy: 'personal_choice', participant_ids: [admin, sam] }],
  });
  assert.equal(alternate.status, 201, JSON.stringify(alternate.body));
  const ambiguousContext = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:ambiguous-plan-test', 'Group trip', 'travel',
      '2026-09-14T00:00:00', '2026-09-14T23:59:00', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by) VALUES (?, ?, ?)
  `).run(ambiguousContext, sam, admin);

  const empty = await call('GET', `/week-model?start=2026-09-14&end=2026-09-14&context=${ambiguousContext}`);
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.data.context_plan.status, 'requires_plan_selection');
  assert.equal(empty.body.data.context_plan.reason, 'multiple_active_plans');
  assert.equal(empty.body.data.occurrences.length, 0);
  assert.equal(database.prepare('SELECT 1 FROM planning_context_meal_plans WHERE planning_context_id = ?').get(ambiguousContext), undefined);

  const attached = await call('PUT', `/plans/${alternate.body.data.id}/contexts/${ambiguousContext}`, {
    starts_on: '2026-09-14', ends_on: '2026-09-14', is_primary: true,
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  const selected = await call('GET', `/week-model?start=2026-09-14&end=2026-09-14&context_id=${ambiguousContext}`);
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.data.context_plan.status, 'attached');
  assert.equal(selected.body.data.occurrences.length, 1);
  const occurrenceId = selected.body.data.occurrences[0].id;

  const detached = await call('DELETE', `/plans/${alternate.body.data.id}/contexts/${ambiguousContext}`);
  assert.equal(detached.status, 200, JSON.stringify(detached.body));
  assert.ok(database.prepare('SELECT 1 FROM meals WHERE id = ?').get(occurrenceId), 'detaching never deletes a dated occurrence');
});

test('planning contexts use a half-open time window so midnight end excludes that date', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Travel boundary meals',
    rules: [
      { weekday: 1, meal_type: 'dinner', policy: 'fixed', fixed_user_id: admin, participant_ids: [admin] },
      { weekday: 2, meal_type: 'dinner', policy: 'fixed', fixed_user_id: admin, participant_ids: [admin] },
    ],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const contextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:exclusive-end-test', 'July trip', 'travel',
      '2026-07-10T00:00:00', '2026-07-15T00:00:00', ?)
  `).run(admin).lastInsertRowid);
  database.prepare(`
    INSERT INTO planning_context_members (planning_context_id, user_id, added_by) VALUES (?, ?, ?)
  `).run(contextId, admin, admin);
  const attached = await call('PUT', `/plans/${plan.body.data.id}/contexts/${contextId}`, {});
  assert.equal(attached.status, 200, JSON.stringify(attached.body));

  const travel = await call('GET', `/week-model?start=2026-07-10&end=2026-07-15&context_id=${contextId}`);
  assert.equal(travel.status, 200, JSON.stringify(travel.body));
  assert.ok(travel.body.data.occurrences.some((row) => row.date === '2026-07-14'));
  assert.ok(!travel.body.data.occurrences.some((row) => row.date === '2026-07-15'), 'midnight end is exclusive');

  const home = await call('GET', '/week-model?start=2026-07-15&end=2026-07-15');
  assert.equal(home.status, 200, JSON.stringify(home.body));
  const homeOccurrence = home.body.data.occurrences.find((row) => (
    Number(row.meal_plan_id) === Number(plan.body.data.id)
    && row.date === '2026-07-15'
    && row.planning_context_id == null
  ));
  assert.ok(homeOccurrence, 'the same member returns to the base plan on the end date');
  assert.equal(homeOccurrence.applicable, true);
  assert.equal(homeOccurrence.my_participant.status, 'participating');
});

test('context conflicts reconcile pending materialized meals in both creation orders without losing audit', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Conflict-safe travel dinners',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: sam,
      fallback_user_id: admin,
      participant_ids: [admin, sam],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const planId = Number(plan.body.data.id);
  const ruleId = Number(plan.body.data.rules[0].id);
  const window = {
    starts_at: '2045-01-02T00:00:00',
    ends_at: '2045-01-03T00:00:00',
  };
  const first = savePlanningContext(database, {
    context_key: 'trip:late-conflict-first',
    name: 'First late-conflict trip',
    context_type: 'travel',
    ...window,
    member_ids: [sam],
  }, admin);
  const second = savePlanningContext(database, {
    context_key: 'trip:late-conflict-second',
    name: 'Second late-conflict trip',
    context_type: 'travel',
    ...window,
    member_ids: [admin],
  }, admin);
  for (const contextId of [first.id, second.id]) {
    const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const generated = await call('GET', `/week-model?start=2045-01-02&end=2045-01-02&context_id=${contextId}`);
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
  }
  const firstMeal = database.prepare(`
    SELECT * FROM meals
     WHERE meal_plan_rule_id = ? AND planning_context_id = ? AND date = '2045-01-02'
  `).get(ruleId, first.id);
  const firstObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
  `).get(firstMeal.id);
  assert.equal(firstObligation.responsible_user_id, sam);
  assert.equal(firstObligation.status, 'pending');
  const selectedEntree = await call('POST', `/${firstMeal.id}/menu-items`, {
    item_type: 'entree', position: 0, title: 'Travel curry',
    beneficiary_user_id: sam,
  });
  assert.equal(selectedEntree.status, 201, JSON.stringify(selectedEntree.body));
  const selectedDecision = await call('POST', `/${firstMeal.id}/decisions`, {
    beneficiary_user_id: sam,
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [selectedEntree.body.data.id],
    confirmed: true,
  });
  assert.equal(selectedDecision.status, 200, JSON.stringify(selectedDecision.body));
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?')
    .get(firstObligation.id).status, 'fulfilled');

  savePlanningContext(database, {
    context_key: second.context_key,
    name: second.name,
    context_type: second.context_type,
    starts_at: second.starts_at,
    ends_at: second.ends_at,
    member_ids: [admin, sam],
  }, admin, second.id);
  const lateConflict = database.prepare(`
    SELECT * FROM planning_context_conflicts
     WHERE user_id = ? AND status = 'open'
       AND first_context_id IN (?, ?) AND second_context_id IN (?, ?)
  `).get(sam, first.id, second.id, first.id, second.id);
  assert.ok(lateConflict);
  assert.equal(database.prepare(`
    SELECT status FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'participant'
  `).get(firstMeal.id, sam).status, 'away');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?')
    .get(firstObligation.id).status, 'superseded');
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligation_events
     WHERE obligation_id = ? AND event = 'planning_context_suspended'
  `).get(firstObligation.id));
  const conflictedProjection = await call('GET',
    `/week-model?start=2045-01-02&end=2045-01-02&context_id=${first.id}&member_id=${sam}`);
  const conflictedOccurrence = conflictedProjection.body.data.occurrences.find((row) => (
    Number(row.id) === Number(firstMeal.id)
  ));
  assert.equal(conflictedOccurrence.title, 'Travel curry');
  assert.deepEqual(conflictedOccurrence.menu_items.map((item) => item.title), ['Travel curry']);
  assert.deepEqual(conflictedOccurrence.published_menu_items.map((item) => item.title), ['Travel curry']);
  assert.deepEqual(conflictedOccurrence.historical_menu_items, []);

  const keepFirst = Number(lateConflict.first_context_id) === Number(first.id)
    ? 'keep_first'
    : 'keep_second';
  resolvePlanningContextConflict(database, lateConflict.id, keepFirst, admin);
  assert.equal(database.prepare(`
    SELECT status FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'participant'
  `).get(firstMeal.id, sam).status, 'participating');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?')
    .get(firstObligation.id).status, 'superseded', 'fulfilled history is never silently reactivated');
  const freshFirstObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ? AND status = 'pending'
     ORDER BY id DESC LIMIT 1
  `).get(firstMeal.id, sam);
  assert.ok(freshFirstObligation);
  assert.equal(freshFirstObligation.parent_obligation_id, firstObligation.id);
  assert.ok(database.prepare(`
    SELECT 1 FROM planning_obligation_events
     WHERE obligation_id = ? AND event = 'planning_context_reassigned'
  `).get(freshFirstObligation.id));
  assert.equal(database.prepare(`
    SELECT membership_status FROM planning_context_members
     WHERE planning_context_id = ? AND user_id = ?
  `).get(second.id, sam).membership_status, 'released');

  const earlyFirst = savePlanningContext(database, {
    context_key: 'trip:early-conflict-first',
    name: 'First early-conflict trip',
    context_type: 'travel',
    starts_at: '2045-01-09T00:00:00',
    ends_at: '2045-01-10T00:00:00',
    member_ids: [sam],
  }, admin);
  const earlySecond = savePlanningContext(database, {
    context_key: 'trip:early-conflict-second',
    name: 'Second early-conflict trip',
    context_type: 'travel',
    starts_at: '2045-01-09T00:00:00',
    ends_at: '2045-01-10T00:00:00',
    member_ids: [sam],
  }, admin);
  for (const contextId of [earlyFirst.id, earlySecond.id]) {
    assert.equal((await call('PUT', `/plans/${planId}/contexts/${contextId}`, {})).status, 200);
    assert.equal((await call('GET', `/week-model?start=2045-01-09&end=2045-01-09&context_id=${contextId}`)).status, 200);
  }
  const earlyConflict = database.prepare(`
    SELECT * FROM planning_context_conflicts
     WHERE user_id = ? AND status = 'open'
       AND first_context_id IN (?, ?) AND second_context_id IN (?, ?)
  `).get(sam, earlyFirst.id, earlySecond.id, earlyFirst.id, earlySecond.id);
  assert.ok(earlyConflict);
  const earlyKeptId = Number(earlyConflict.first_context_id);
  const earlyReleasedId = Number(earlyConflict.second_context_id);
  const keptMeal = database.prepare(`
    SELECT * FROM meals
     WHERE meal_plan_rule_id = ? AND planning_context_id = ? AND date = '2045-01-09'
  `).get(ruleId, earlyKeptId);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND status = 'participating'
  `).get(keptMeal.id, sam).n, 0, 'an unresolved overlap creates no active obligation in either context');

  resolvePlanningContextConflict(database, earlyConflict.id, 'keep_first', admin);
  assert.deepEqual(database.prepare(`
    SELECT role FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND status = 'participating'
     ORDER BY role
  `).all(keptMeal.id, sam).map((row) => row.role), ['chooser', 'participant']);
  assert.equal(database.prepare(`
    SELECT status FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ?
  `).get(keptMeal.id, sam).status, 'pending');
  const releasedMeal = database.prepare(`
    SELECT id FROM meals
     WHERE meal_plan_rule_id = ? AND planning_context_id = ? AND date = '2045-01-09'
  `).get(ruleId, earlyReleasedId);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND status = 'participating'
  `).get(releasedMeal.id, sam).n, 0);

  const longContext = savePlanningContext(database, {
    context_key: 'trip:partial-overlap-long',
    name: 'Long trip with a short overlap',
    context_type: 'travel',
    starts_at: '2045-01-16T00:00:00',
    ends_at: '2045-01-24T00:00:00',
    member_ids: [sam],
  }, admin);
  const shortContext = savePlanningContext(database, {
    context_key: 'trip:partial-overlap-short',
    name: 'Short overlapping trip',
    context_type: 'travel',
    starts_at: '2045-01-16T17:00:00',
    ends_at: '2045-01-17T23:59:00',
    member_ids: [sam],
  }, admin);
  for (const contextId of [longContext.id, shortContext.id]) {
    assert.equal((await call('PUT', `/plans/${planId}/contexts/${contextId}`, {})).status, 200);
  }
  assert.equal((await call('GET', `/week-model?start=2045-01-16&end=2045-01-23&context_id=${longContext.id}`)).status, 200);
  assert.equal((await call('GET', `/week-model?start=2045-01-16&end=2045-01-16&context_id=${shortContext.id}`)).status, 200);
  const overlappingMeal = database.prepare(`
    SELECT id FROM meals
     WHERE meal_plan_rule_id = ? AND planning_context_id = ? AND date = '2045-01-16'
  `).get(ruleId, longContext.id);
  const outsideOverlapMeal = database.prepare(`
    SELECT id FROM meals
     WHERE meal_plan_rule_id = ? AND planning_context_id = ? AND date = '2045-01-23'
  `).get(ruleId, longContext.id);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND status = 'participating'
  `).get(overlappingMeal.id, sam).n, 0, 'the overlapping meal period stays blocked');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'participant' AND status = 'participating'
  `).get(outsideOverlapMeal.id, sam).n, 1,
  'the same context remains usable outside the explicit overlap window');
});

test('grocery settings are independently editable while the legacy settings remain synchronized', async () => {
  actor = { id: admin, role: 'admin' };
  const empty = await call('GET', '/grocery-settings');
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.data.default_shopping_list_id, null);
  assert.equal(empty.body.data.shopping_list_action, 'create');

  const saved = await call('PUT', '/grocery-settings', {
    enabled: true,
    new_shopping_list_name: 'Weekly groceries',
    auto_create_grocery_draft: false,
    auto_finalize_grocery: true,
    grocery_lead_minutes: 2880,
    aggregation_mode: 'recipe',
    grouping_mode: 'category',
    timing_mode: 'weekly',
    draft_weekday: 5,
    draft_time: '09:00',
    finalization_weekday: 6,
    finalization_time: '09:00',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.default_shopping_list.name, 'Weekly groceries');
  assert.equal(saved.body.data.shopping_list_action, 'use_existing');
  assert.equal(saved.body.data.grocery_lead_minutes, 2880);
  assert.equal(saved.body.data.aggregation_mode, 'recipe');
  assert.equal(saved.body.data.grouping_mode, 'category');
  assert.equal(saved.body.data.weekly_timing.target, 'following_week');
  assert.equal(saved.body.data.weekly_timing.automatic_execution, false);
  assert.equal(saved.body.data.finalization_weekday, 6);

  database.prepare(`INSERT INTO shopping_lists (name, created_by) VALUES ('Alpha groceries', ?)`).run(admin);
  const alphabeticalDefault = await call('PUT', '/grocery-settings', {
    default_shopping_list_id: null,
  });
  assert.equal(alphabeticalDefault.status, 200, JSON.stringify(alphabeticalDefault.body));
  assert.equal(alphabeticalDefault.body.data.default_shopping_list.name, 'Alpha groceries');
  assert.deepEqual(
    alphabeticalDefault.body.data.shopping_lists.map((list) => list.name),
    ['Alpha groceries', 'Weekly groceries'],
  );

  const invalidOrder = await call('PUT', '/grocery-settings', {
    draft_weekday: 6,
    draft_time: '10:00',
    finalization_weekday: 6,
    finalization_time: '09:00',
  });
  assert.equal(invalidOrder.status, 409, JSON.stringify(invalidOrder.body));
  assert.equal(invalidOrder.body.code, 'GROCERY_WEEKLY_TIMING_ORDER');

  const defaults = await call('GET', '/plan-defaults');
  assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
  assert.equal(defaults.body.data.grocery_settings.grouping_mode, 'category');
  assert.equal(defaults.body.data.grocery_settings.default_shopping_list.name, 'Alpha groceries');

  const invalidCombined = await call('PUT', '/plan-defaults', {
    default_cook_strategy: 'none',
    grocery_settings: {
      draft_weekday: 6,
      draft_time: '10:00',
      finalization_weekday: 6,
      finalization_time: '09:00',
    },
  });
  assert.equal(invalidCombined.status, 409, JSON.stringify(invalidCombined.body));
  assert.equal(
    (await call('GET', '/plan-defaults')).body.data.default_cook_strategy,
    'round_robin',
    'the combined defaults write is atomic when grocery timing is invalid',
  );

  const legacy = database.prepare('SELECT * FROM meal_execution_settings WHERE id = 1').get();
  assert.equal(legacy.auto_create_grocery_draft, 0);
  assert.equal(legacy.auto_finalize_grocery, 1);

  const legacyWrite = await call('PUT', '/execution-settings', {
    ...legacy,
    auto_create_grocery_draft: true,
    auto_finalize_grocery: false,
  });
  assert.equal(legacyWrite.status, 200, JSON.stringify(legacyWrite.body));
  const separate = database.prepare('SELECT * FROM meal_grocery_settings WHERE id = 1').get();
  assert.equal(separate.auto_create_grocery_draft, 1);
  assert.equal(separate.auto_finalize_grocery, 0);
  assert.equal(separate.grocery_lead_minutes, 2880, 'legacy writes preserve new grocery-only fields');
  assert.equal(separate.aggregation_mode, 'recipe');
  assert.equal(separate.grouping_mode, 'category');
  assert.equal(separate.finalization_weekday, 6);
  assert.equal(separate.finalization_time, '09:00');
});

test('separated Meal Plan and Grocery settings payloads persist without discarding each other', async () => {
  actor = { id: admin, role: 'admin' };
  const listId = Number(database.prepare(`
    INSERT INTO shopping_lists (name, created_by) VALUES ('Meal Plan List', ?)
  `).run(admin).lastInsertRowid);

  const groceryPayload = {
    enabled: true,
    default_shopping_list_id: listId,
    auto_create_grocery_draft: true,
    auto_finalize_grocery: true,
    timing_mode: 'weekly',
    draft_weekday: 4,
    draft_time: '09:00',
    finalization_weekday: 6,
    finalization_time: '08:00',
    grouping_mode: 'category',
  };
  const savedGrocery = await call('PUT', '/grocery-settings', groceryPayload);
  assert.equal(savedGrocery.status, 200, JSON.stringify(savedGrocery.body));
  assert.equal(savedGrocery.body.data.enabled, 1);
  assert.equal(savedGrocery.body.data.default_shopping_list_id, listId);
  assert.equal(savedGrocery.body.data.default_shopping_list.name, 'Meal Plan List');
  assert.equal(savedGrocery.body.data.auto_create_grocery_draft, 1);
  assert.equal(savedGrocery.body.data.auto_finalize_grocery, 1);
  assert.equal(savedGrocery.body.data.draft_weekday, 4);
  assert.equal(savedGrocery.body.data.draft_time, '09:00');
  assert.equal(savedGrocery.body.data.finalization_weekday, 6);
  assert.equal(savedGrocery.body.data.finalization_time, '08:00');
  assert.equal(savedGrocery.body.data.grouping_mode, 'category');

  const reloadedGrocery = await call('GET', '/grocery-settings');
  assert.equal(reloadedGrocery.status, 200, JSON.stringify(reloadedGrocery.body));
  for (const [key, expected] of Object.entries({
    enabled: 1,
    default_shopping_list_id: listId,
    auto_create_grocery_draft: 1,
    auto_finalize_grocery: 1,
    draft_weekday: 4,
    draft_time: '09:00',
    finalization_weekday: 6,
    finalization_time: '08:00',
    grouping_mode: 'category',
  })) assert.equal(reloadedGrocery.body.data[key], expected, `reloaded grocery ${key}`);

  const disabledGrocery = await call('PUT', '/grocery-settings', {
    ...groceryPayload,
    enabled: false,
    auto_finalize_grocery: false,
  });
  assert.equal(disabledGrocery.status, 200, JSON.stringify(disabledGrocery.body));
  assert.equal(disabledGrocery.body.data.enabled, 0);
  assert.equal(disabledGrocery.body.data.auto_finalize_grocery, 0);
  assert.equal((await call('GET', '/grocery-settings')).body.data.enabled, 0);
  assert.equal((await call('GET', '/grocery-settings')).body.data.auto_finalize_grocery, 0);

  const restoredGrocery = await call('PUT', '/grocery-settings', groceryPayload);
  assert.equal(restoredGrocery.status, 200, JSON.stringify(restoredGrocery.body));
  assert.equal(restoredGrocery.body.data.enabled, 1);
  assert.equal(restoredGrocery.body.data.auto_finalize_grocery, 1);

  const savedPlanDefaults = await call('PUT', '/plan-defaults', {
    chooser_terminal_strategy: 'eligible_round_robin',
    chooser_terminal_user_id: null,
    chooser_round_robin_user_ids: [admin],
    default_cook_strategy: 'none',
    default_supervisor_strategy: 'round_robin',
  });
  assert.equal(savedPlanDefaults.status, 200, JSON.stringify(savedPlanDefaults.body));
  assert.equal(savedPlanDefaults.body.data.chooser_terminal_strategy, 'eligible_round_robin');
  assert.deepEqual(savedPlanDefaults.body.data.chooser_round_robin_user_ids, [admin]);
  assert.equal(savedPlanDefaults.body.data.default_cook_strategy, 'none');
  assert.equal(savedPlanDefaults.body.data.default_supervisor_strategy, 'round_robin');

  const savedExecution = await call('PUT', '/execution-settings', {
    enabled: false,
    default_shopping_list_id: listId,
    auto_create_grocery_draft: true,
    auto_finalize_grocery: true,
    generate_preparation: false,
    generate_cooking: true,
    generate_supervision: false,
    generate_serving: true,
    generate_cleanup: false,
    preparation_lead_minutes: 75,
    cooking_lead_minutes: 45,
    cleanup_delay_minutes: 90,
  });
  assert.equal(savedExecution.status, 200, JSON.stringify(savedExecution.body));

  const reloadedPlanDefaults = await call('GET', '/plan-defaults');
  const reloadedExecution = await call('GET', '/execution-settings');
  assert.equal(reloadedPlanDefaults.status, 200, JSON.stringify(reloadedPlanDefaults.body));
  assert.equal(reloadedExecution.status, 200, JSON.stringify(reloadedExecution.body));
  assert.equal(reloadedPlanDefaults.body.data.chooser_terminal_strategy, 'eligible_round_robin');
  assert.deepEqual(reloadedPlanDefaults.body.data.chooser_round_robin_user_ids, [admin]);
  assert.equal(reloadedPlanDefaults.body.data.default_cook_strategy, 'none');
  assert.equal(reloadedPlanDefaults.body.data.default_supervisor_strategy, 'round_robin');
  for (const [key, expected] of Object.entries({
    enabled: 0,
    generate_preparation: 0,
    generate_cooking: 1,
    generate_supervision: 0,
    generate_serving: 1,
    generate_cleanup: 0,
    preparation_lead_minutes: 75,
    cooking_lead_minutes: 45,
    cleanup_delay_minutes: 90,
  })) assert.equal(reloadedExecution.body.data[key], expected, `reloaded execution ${key}`);

  const groceryAfterPlanSave = await call('GET', '/grocery-settings');
  assert.equal(groceryAfterPlanSave.body.data.enabled, 1,
    'Meal Plan automation does not overwrite the separate grocery preparation switch');
  assert.equal(groceryAfterPlanSave.body.data.default_shopping_list_id, listId);
  assert.equal(groceryAfterPlanSave.body.data.auto_create_grocery_draft, 1);
  assert.equal(groceryAfterPlanSave.body.data.auto_finalize_grocery, 1);
  assert.equal(groceryAfterPlanSave.body.data.grouping_mode, 'category');
  assert.equal(groceryAfterPlanSave.body.data.draft_weekday, 4);
  assert.equal(groceryAfterPlanSave.body.data.finalization_time, '08:00');

  const tripContextId = Number(database.prepare(`
    INSERT INTO planning_contexts (
      context_key, name, context_type, starts_at, ends_at, created_by
    ) VALUES ('trip:separated-settings-test', 'Separated settings trip', 'travel',
      '2046-05-01T00:00:00Z', '2046-05-07T23:59:59Z', ?)
  `).run(admin).lastInsertRowid);
  const tripOverride = await call('PUT', `/grocery-settings/contexts/${tripContextId}`, {
    track_groceries: false,
  });
  assert.equal(tripOverride.status, 200, JSON.stringify(tripOverride.body));
  assert.equal(tripOverride.body.data.track_groceries, false);
  assert.equal(tripOverride.body.data.inherits_household_defaults, true);
  const householdAfterTripOverride = await call('GET', '/grocery-settings');
  assert.equal(householdAfterTripOverride.body.data.enabled, 1);
  assert.equal(householdAfterTripOverride.body.data.default_shopping_list_id, listId);
  assert.equal(householdAfterTripOverride.body.data.grouping_mode, 'category');
});

test('new Meal rules default Cook to the presence-aware rotation and keep Supervisor opt-in', async () => {
  actor = { id: admin, role: 'admin' };
  const defaults = await call('PUT', '/plan-defaults', {
    default_cook_strategy: 'round_robin',
    default_supervisor_strategy: 'none',
  });
  assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
  assert.equal(defaults.body.data.default_cook_strategy, 'round_robin');
  assert.equal(defaults.body.data.default_supervisor_strategy, 'none');

  const created = await call('POST', '/plans', {
    name: 'Safe role defaults',
    effective_from: '2060-01-05',
    effective_until: '2060-01-05',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      participant_ids: [admin, sam],
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = Number(created.body.data.id);
  assert.equal(created.body.data.rules[0].cook_strategy, 'round_robin');
  assert.equal(created.body.data.rules[0].supervisor_strategy, 'none');
  assert.equal(created.body.data.rules[0].generate_supervision, false);

  const materialized = await call('GET', '/week-model?start=2060-01-05&end=2060-01-05');
  assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
  const roleAssignments = database.prepare(`
    SELECT role.role, role.strategy, role.assigned_user_id
      FROM meal_occurrence_role_assignments role
      JOIN meal_occurrence_assignments occurrence
        ON occurrence.id = role.occurrence_assignment_id
      JOIN meals meal ON meal.id = occurrence.meal_id
     WHERE meal.meal_plan_id = ?
     ORDER BY role.role
  `).all(planId);
  const cook = roleAssignments.find((row) => row.role === 'cook');
  const supervisor = roleAssignments.find((row) => row.role === 'supervisor');
  assert.equal(cook.strategy, 'round_robin');
  assert.ok([admin, sam].includes(Number(cook.assigned_user_id)));
  assert.equal(supervisor.strategy, 'none');
  assert.equal(supervisor.assigned_user_id, null);

  const explicitNone = await call('POST', '/plans', {
    name: 'Explicitly unassigned cook',
    status: 'archived',
    rules: [{
      weekday: 1,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      participant_ids: [admin],
      cook_strategy: 'none',
    }],
  });
  assert.equal(explicitNone.status, 201, JSON.stringify(explicitNone.body));
  assert.equal(explicitNone.body.data.rules[0].cook_strategy, 'none');
});

test('two same-date named Meal Plans decline and time out into distinct fallback obligations', async () => {
  actor = { id: admin, role: 'admin' };
  const createPlan = async (name, mealType) => {
    const response = await call('POST', '/plans', {
      name,
      rules: [{
        weekday: 0,
        meal_type: mealType,
        policy: 'fixed',
        fixed_user_id: sam,
        fallback_user_id: admin,
        participant_ids: [admin, sam],
      }],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return Number(response.body.data.id);
  };
  const breakfastPlanId = await createPlan('Fallback breakfast', 'breakfast');
  const dinnerPlanId = await createPlan('Fallback dinner', 'dinner');

  const materialized = await call('GET', '/week-model?start=2041-01-07&end=2041-01-07');
  assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
  const meals = database.prepare(`
    SELECT id, meal_plan_id FROM meals
     WHERE date = '2041-01-07' AND meal_plan_id IN (?, ?)
     ORDER BY meal_plan_id
  `).all(breakfastPlanId, dinnerPlanId);
  assert.equal(meals.length, 2);
  const byPlan = new Map(meals.map((meal) => [Number(meal.meal_plan_id), Number(meal.id)]));
  const breakfastObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser' AND attempt = 1
  `).get(byPlan.get(breakfastPlanId));
  const dinnerObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser' AND attempt = 1
  `).get(byPlan.get(dinnerPlanId));
  assert.equal(breakfastObligation.responsible_user_id, sam);
  assert.equal(dinnerObligation.responsible_user_id, sam);

  // Keep every pre-existing request out of the timeout sweep, then make only
  // the dinner request due. The breakfast fallback inherits the future date.
  database.prepare(`
    UPDATE planning_obligations SET response_deadline = '2099-01-01T00:00:00Z'
     WHERE entity_type = 'meal' AND role = 'chooser' AND status IN ('pending', 'accepted')
  `).run();
  database.prepare(`
    UPDATE planning_obligations SET response_deadline = '2000-01-01T00:00:00Z' WHERE id = ?
  `).run(dinnerObligation.id);

  actor = { id: sam, role: 'member' };
  const declined = await call('POST', `/selection-requests/${breakfastObligation.id}/respond`, {
    action: 'decline',
    note: 'Please ask the backup chooser.',
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.ok(declined.body.data.replacement_obligation_id);

  actor = { id: admin, role: 'admin' };
  const timedOut = await call('POST', '/selection-requests/process-timeouts', {});
  assert.equal(timedOut.status, 200, JSON.stringify(timedOut.body));
  assert.equal(timedOut.body.data.processed, 1);
  const dinnerResult = timedOut.body.data.results.find((row) => Number(row.obligation_id) === Number(dinnerObligation.id));
  assert.ok(dinnerResult);
  assert.equal(dinnerResult.status, 'timed_out');
  assert.ok(dinnerResult.replacement_obligation_id);

  const replacements = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE parent_obligation_id IN (?, ?)
     ORDER BY parent_obligation_id
  `).all(breakfastObligation.id, dinnerObligation.id);
  assert.equal(replacements.length, 2, 'each named occurrence receives its own fallback attempt');
  assert.equal(new Set(replacements.map((row) => row.logical_key)).size, 2);
  for (const replacement of replacements) {
    const original = Number(replacement.parent_obligation_id) === Number(breakfastObligation.id)
      ? breakfastObligation
      : dinnerObligation;
    assert.equal(replacement.logical_key, `${original.logical_key}:fallback:attempt:2`);
    assert.equal(replacement.responsible_user_id, admin);
    assert.equal(replacement.status, 'pending');
  }
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(breakfastObligation.id).status, 'declined');
  assert.equal(database.prepare('SELECT status FROM planning_obligations WHERE id = ?').get(dinnerObligation.id).status, 'timed_out');
  for (const mealId of byPlan.values()) {
    assert.deepEqual(database.prepare(`
      SELECT user_id FROM meal_participants
       WHERE meal_id = ? AND role = 'chooser' AND status = 'participating'
    `).all(mealId).map((row) => Number(row.user_id)), [admin]);
    assert.equal(database.prepare(`
      SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id = ?
    `).get(mealId).assigned_user_id, admin,
    'fallback chooser becomes the occurrence ledger\'s canonical assignee');
  }

  assert.equal((await call('DELETE', `/plans/${breakfastPlanId}`)).status, 200);
  assert.equal((await call('DELETE', `/plans/${dinnerPlanId}`)).status, 200);
});

test('home and two disjoint concurrent travel groups materialize isolated cohorts and cursors idempotently', async () => {
  actor = { id: admin, role: 'admin' };
  const taylor = Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES ('meal-plan-taylor', 'Taylor', 'x', 'member', 'parent')
  `).run().lastInsertRowid);
  const morgan = Number(database.prepare(`
    INSERT INTO users (username, display_name, password_hash, role, family_role)
    VALUES ('meal-plan-morgan', 'Morgan', 'x', 'member', 'parent')
  `).run().lastInsertRowid);
  const participantIds = [admin, sam, jamie, taylor, morgan];
  const created = await call('POST', '/plans', {
    name: 'Concurrent context dinners',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'round_robin',
      rotation_group: 'concurrent-context-dinner',
      participant_ids: participantIds,
    }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const planId = Number(created.body.data.id);
  const ruleId = Number(created.body.data.rules[0].id);
  const startsAt = '2044-01-04T00:00:00';
  const endsAt = '2044-01-05T00:00:00';
  const soloContext = savePlanningContext(database, {
    context_key: 'trip:concurrent-solo',
    name: 'Solo business trip',
    context_type: 'travel',
    starts_at: startsAt,
    ends_at: endsAt,
    member_ids: [admin],
  }, admin);
  const groupContext = savePlanningContext(database, {
    context_key: 'trip:concurrent-group',
    name: 'Group trip',
    context_type: 'travel',
    starts_at: startsAt,
    ends_at: endsAt,
    member_ids: [sam, jamie],
  }, admin);
  assert.equal(soloContext.status, 'active');
  assert.equal(groupContext.status, 'active');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM planning_context_conflicts
     WHERE first_context_id IN (?, ?) OR second_context_id IN (?, ?)
  `).get(soloContext.id, groupContext.id, soloContext.id, groupContext.id).count, 0,
  'disjoint travelers must not create a planning-context conflict');

  for (const contextId of [soloContext.id, groupContext.id]) {
    const attached = await call('PUT', `/plans/${planId}/contexts/${contextId}`, {});
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
  }

  const first = await call('GET', `/week-model?start=2044-01-04&end=2044-01-04&member_id=${taylor}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const occurrences = first.body.data.occurrences.filter((row) => Number(row.rule?.id) === ruleId);
  assert.equal(occurrences.length, 3, 'home plus both travel contexts each receive one occurrence');
  assert.deepEqual(
    occurrences.map((row) => Number(row.context?.id) || null).sort((left, right) => (left || 0) - (right || 0)),
    [null, Number(soloContext.id), Number(groupContext.id)].sort((left, right) => (left || 0) - (right || 0)),
  );

  const assignments = database.prepare(`
    SELECT oa.*, m.planning_context_id
      FROM meal_occurrence_assignments oa
      JOIN meals m ON m.id = oa.meal_id
     WHERE oa.meal_plan_rule_id = ? AND m.date = '2044-01-04'
     ORDER BY COALESCE(m.planning_context_id, 0)
  `).all(ruleId);
  assert.equal(assignments.length, 3);
  const byContext = new Map(assignments.map((row) => [Number(row.planning_context_id) || null, row]));
  const orderedContextIds = [Number(soloContext.id), Number(groupContext.id)].sort((left, right) => left - right);
  const baseKey = `meal-plan:${planId}:concurrent-context-dinner:chooser`;
  const expected = new Map([
    [null, {
      cohort: [taylor, morgan].sort((left, right) => left - right),
      assignee: Math.min(taylor, morgan),
      rotationKey: `${baseKey}:home-split:${orderedContextIds.join('.')}`,
    }],
    [Number(soloContext.id), {
      cohort: [admin],
      assignee: admin,
      rotationKey: `${baseKey}:context:${soloContext.id}`,
    }],
    [Number(groupContext.id), {
      cohort: [sam, jamie].sort((left, right) => left - right),
      assignee: Math.min(sam, jamie),
      rotationKey: `${baseKey}:context:${groupContext.id}`,
    }],
  ]);
  for (const [contextId, expectation] of expected) {
    const assignment = byContext.get(contextId);
    assert.ok(assignment, `missing assignment for context ${contextId ?? 'home'}`);
    assert.equal(assignment.scoped_rotation_key, expectation.rotationKey);
    assert.equal(Number(assignment.assigned_user_id), expectation.assignee);
    assert.deepEqual(database.prepare(`
      SELECT user_id FROM meal_participants
       WHERE meal_id = ? AND role = 'participant' AND source = 'schedule'
       ORDER BY user_id
    `).all(assignment.meal_id).map((row) => Number(row.user_id)), expectation.cohort);
    const state = database.prepare(`
      SELECT cursor_user_id, occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
    `).get(expectation.rotationKey);
    assert.equal(Number(state.cursor_user_id), expectation.assignee);
    assert.equal(state.occurrence_count, 1);
  }
  assert.equal(database.prepare(`
    SELECT 1 FROM assignment_rotation_state WHERE rotation_key = ?
  `).get(baseKey), undefined, 'temporary household splits must not consume the permanent cursor');

  const beforeRetry = assignments.map((row) => ({
    id: Number(row.id),
    meal_id: Number(row.meal_id),
    occurrence_key: row.occurrence_key,
    assigned_user_id: Number(row.assigned_user_id),
    scoped_rotation_key: row.scoped_rotation_key,
  }));
  const retry = await call('GET', `/week-model?start=2044-01-04&end=2044-01-04&member_id=${morgan}`);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const afterRetry = database.prepare(`
    SELECT oa.*, m.planning_context_id
      FROM meal_occurrence_assignments oa
      JOIN meals m ON m.id = oa.meal_id
     WHERE oa.meal_plan_rule_id = ? AND m.date = '2044-01-04'
     ORDER BY COALESCE(m.planning_context_id, 0)
  `).all(ruleId).map((row) => ({
    id: Number(row.id),
    meal_id: Number(row.meal_id),
    occurrence_key: row.occurrence_key,
    assigned_user_id: Number(row.assigned_user_id),
    scoped_rotation_key: row.scoped_rotation_key,
  }));
  assert.deepEqual(afterRetry, beforeRetry, 'rematerialization keeps the same three occurrence identities');
  for (const expectation of expected.values()) {
    assert.equal(database.prepare(`
      SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key = ?
    `).get(expectation.rotationKey).occurrence_count, 1, 'rematerialization must not advance a scoped cursor twice');
  }

  assert.equal((await call('DELETE', `/plans/${planId}`)).status, 200);
});

test('ordered chooser fallbacks preserve draft history, snapshot terminal defaults, enforce course limits, and repair idempotently', async () => {
  actor = { id: admin, role: 'admin' };
  const fixedDefaults = await call('PUT', '/plan-defaults', {
    chooser_terminal_strategy: 'fixed',
    chooser_terminal_user_id: admin,
    chooser_round_robin_user_ids: [sam, jamie],
  });
  assert.equal(fixedDefaults.status, 200, JSON.stringify(fixedDefaults.body));
  assert.equal(fixedDefaults.body.data.chooser_terminal_strategy, 'fixed');
  assert.deepEqual(fixedDefaults.body.data.chooser_round_robin_user_ids, [sam, jamie]);

  const zeroLimits = await call('POST', '/plans', {
    name: 'Zero-course compatibility plan', status: 'archived',
    rules: [{
      weekday: 0, meal_type: 'snack', policy: 'fixed', fixed_user_id: sam,
      participant_ids: [sam], max_entree_choices: 0, max_side_choices: 0,
      choice_limit: 0,
    }],
  });
  assert.equal(zeroLimits.status, 201, JSON.stringify(zeroLimits.body));
  assert.equal(zeroLimits.body.data.rules[0].max_entree_choices, 0);
  assert.equal(zeroLimits.body.data.rules[0].max_side_choices, 0);
  assert.equal(zeroLimits.body.data.rules[0].choice_limit, 1,
    'legacy choice_limit remains schema-compatible when modern side maximum is zero');
  assert.equal((await call('DELETE', `/plans/${zeroLimits.body.data.id}`)).status, 200);

  const duplicate = await call('POST', '/plans', {
    name: 'Invalid duplicate fallback plan',
    rules: [{
      weekday: 0, meal_type: 'lunch', policy: 'fixed', fixed_user_id: sam,
      chooser_fallback_user_ids: [jamie, jamie], participant_ids: [sam, jamie],
    }],
  });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, 'DUPLICATE_CHOOSER_FALLBACK');

  const plan = await call('POST', '/plans', {
    name: 'Ordered fallback dinner',
    effective_from: '2055-01-04',
    effective_until: '2055-01-04',
    rules: [{
      weekday: 0, meal_type: 'dinner', policy: 'fixed', fixed_user_id: sam,
      chooser_fallback_user_ids: [jamie],
      participant_ids: [admin, sam, jamie],
      max_entree_choices: 2,
      max_side_choices: 1,
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.deepEqual(plan.body.data.rules[0].chooser_fallback_user_ids, [jamie]);
  assert.equal(plan.body.data.rules[0].max_entree_choices, 2);
  assert.equal(plan.body.data.rules[0].max_side_choices, 1);

  const initial = await call('GET', `/week-model?start=2055-01-04&end=2055-01-04&member_id=${sam}`);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2055-01-04'
  `).get(plan.body.data.id);
  const projectedOccurrence = initial.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(projectedOccurrence.max_entree_choices, 2);
  assert.equal(projectedOccurrence.max_side_choices, 1);
  assert.deepEqual(projectedOccurrence.menu_limits, {
    max_entree_choices: 2,
    max_side_choices: 1,
  });
  assert.equal(projectedOccurrence.rule.max_entree_choices, 2);
  assert.equal(projectedOccurrence.rule.max_side_choices, 1);
  const firstObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
     ORDER BY id DESC LIMIT 1
  `).get(meal.id);
  const firstSnapshot = JSON.parse(firstObligation.metadata_json);
  assert.deepEqual(firstSnapshot.chooser_fallback_user_ids, [jamie]);
  assert.equal(firstSnapshot.chooser_terminal_strategy, 'fixed');
  assert.equal(firstSnapshot.chooser_terminal_user_id, admin);
  assert.equal(firstSnapshot.max_entree_choices, 2);
  assert.equal(firstSnapshot.max_side_choices, 1);

  // Future defaults must not rewrite this already-materialized occurrence.
  const changedDefaults = await call('PUT', '/plan-defaults', {
    chooser_terminal_strategy: 'personal_choice',
    chooser_terminal_user_id: null,
    chooser_round_robin_user_ids: [],
  });
  assert.equal(changedDefaults.status, 200, JSON.stringify(changedDefaults.body));

  actor = { id: sam, role: 'member' };
  const samDraft = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Sam draft casserole', position: 0,
  });
  assert.equal(samDraft.status, 201, JSON.stringify(samDraft.body));
  const samDecline = await call('POST', `/selection-requests/${firstObligation.id}/respond`, {
    action: 'decline', note: 'Jamie should choose.',
  });
  assert.equal(samDecline.status, 200, JSON.stringify(samDecline.body));
  assert.equal(samDecline.body.data.fallback.user_id, jamie);
  assert.equal(samDecline.body.data.fallback.stage, 'ordered_fixed_fallback');
  let mealState = database.prepare('SELECT * FROM meals WHERE id = ?').get(meal.id);
  assert.equal(mealState.current_menu_generation, 2);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM meal_menu_items
     WHERE meal_id = ? AND menu_generation = 1 AND title = 'Sam draft casserole'
  `).get(meal.id).n, 1, 'Sam\'s released draft remains durable history');

  const jamieWeek = await call('GET', `/week-model?start=2055-01-04&end=2055-01-04&member_id=${jamie}`);
  const jamieOccurrence = jamieWeek.body.data.occurrences.find((row) => Number(row.id) === Number(meal.id));
  assert.equal(jamieOccurrence.title, null);
  assert.deepEqual(jamieOccurrence.menu_items, []);
  assert.deepEqual(jamieOccurrence.historical_menu_items.map((row) => row.title), ['Sam draft casserole']);

  actor = { id: jamie, role: 'member' };
  const jamieEntreeA = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Jamie entree one', position: 0,
  });
  const jamieEntreeB = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Jamie entree two', position: 1,
  });
  const jamieSide = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'side', title: 'Jamie side', position: 0,
  });
  for (const response of [jamieEntreeA, jamieEntreeB, jamieSide]) {
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }
  const tooManyEntrees = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Jamie entree three', position: 2,
  });
  assert.equal(tooManyEntrees.status, 409, JSON.stringify(tooManyEntrees.body));
  assert.equal(tooManyEntrees.body.code, 'MEAL_ENTREE_LIMIT_EXCEEDED');
  const tooManySides = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'side', title: 'Jamie second side', position: 1,
  });
  assert.equal(tooManySides.status, 409, JSON.stringify(tooManySides.body));
  assert.equal(tooManySides.body.code, 'MEAL_SIDE_LIMIT_EXCEEDED');

  const multipleEntreeSelection = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating', choice_kind: 'household', confirmed: true,
    menu_item_ids: [jamieEntreeA.body.data.id, jamieEntreeB.body.data.id],
  });
  assert.equal(multipleEntreeSelection.status, 409, JSON.stringify(multipleEntreeSelection.body));
  assert.equal(multipleEntreeSelection.body.code, 'SHARED_ENTREE_REQUIRED',
    'multiple authored entrée options do not change one-entrée diner selection semantics');

  const jamieObligation = database.prepare(`
    SELECT * FROM planning_obligations
     WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
       AND responsible_user_id = ? AND status = 'pending'
     ORDER BY id DESC LIMIT 1
  `).get(meal.id, jamie);
  const jamieDecline = await call('POST', `/selection-requests/${jamieObligation.id}/respond`, {
    action: 'decline', note: 'Use the last resort.',
  });
  assert.equal(jamieDecline.status, 200, JSON.stringify(jamieDecline.body));
  assert.equal(jamieDecline.body.data.fallback.user_id, admin,
    'the occurrence retains its fixed terminal snapshot after household defaults change');
  assert.equal(jamieDecline.body.data.fallback.stage, 'fixed');
  mealState = database.prepare('SELECT * FROM meals WHERE id = ?').get(meal.id);
  assert.equal(mealState.current_menu_generation, 3);

  actor = { id: admin, role: 'admin' };
  const beforeRepair = {
    obligations: database.prepare(`
      SELECT COUNT(*) AS n FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
    `).get(meal.id).n,
    generation: mealState.current_menu_generation,
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const repaired = await call('POST', `/${meal.id}/chooser/repair`, {});
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.equal(repaired.body.data.changed, false);
    assert.equal(repaired.body.data.fallback.user_id, admin);
  }
  assert.deepEqual({
    obligations: database.prepare(`
      SELECT COUNT(*) AS n FROM planning_obligations WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
    `).get(meal.id).n,
    generation: database.prepare('SELECT current_menu_generation FROM meals WHERE id = ?').get(meal.id).current_menu_generation,
  }, beforeRepair, 'repeated repair does not create obligations or menu generations');

  const staleActingFor = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Stale Jamie edit', position: 0,
    beneficiary_user_id: jamie,
  });
  assert.equal(staleActingFor.status, 409, JSON.stringify(staleActingFor.body));
  assert.equal(staleActingFor.body.code, 'MEAL_CHOOSER_REPAIR_REQUIRED');

  const terminalDraft = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'Last resort draft', position: 0,
  });
  assert.equal(terminalDraft.status, 201, JSON.stringify(terminalDraft.body));
  const terminalSkip = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating', choice_kind: 'household',
    menu_item_ids: [], confirmed: true,
  });
  assert.equal(terminalSkip.status, 200, JSON.stringify(terminalSkip.body));
  assert.equal(terminalSkip.body.data.chooser_result.fallback.user_id, admin,
    'a fixed terminal member may be prompted again after skipping');
  assert.equal(database.prepare(`
    SELECT status FROM meal_participants
     WHERE meal_id = ? AND user_id = ? AND role = 'participant'
  `).get(meal.id, admin).status, 'participating');
  assert.equal(database.prepare('SELECT current_menu_generation FROM meals WHERE id = ?')
    .get(meal.id).current_menu_generation, 4);

  const archived = await call('POST', '/plans', {
    name: 'Inactive date-overlap plan', status: 'archived',
    effective_from: '2055-01-04', effective_until: '2055-01-04',
    rules: [{
      weekday: 0, meal_type: 'lunch', policy: 'fixed', fixed_user_id: sam,
      participant_ids: [sam],
    }],
  });
  assert.equal(archived.status, 201, JSON.stringify(archived.body));
  const archivedRead = await call('GET', `/week-model?start=2055-01-04&end=2055-01-04&member_id=${sam}`);
  assert.ok(!archivedRead.body.data.occurrences.some((row) => Number(row.meal_plan_id) === Number(archived.body.data.id)),
    'inactive plan status overrides matching effective dates');

  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
  await call('PUT', '/plan-defaults', {
    chooser_terminal_strategy: 'eligible_round_robin',
    chooser_terminal_user_id: null,
    chooser_round_robin_user_ids: [],
  });
});

test('a nonparticipant can opt into one existing-pipeline reminder per actual published menu change', async () => {
  actor = { id: admin, role: 'admin' };
  const plan = await call('POST', '/plans', {
    name: 'Menu change notification proof',
    effective_from: '2070-01-06',
    effective_until: '2070-01-06',
    rules: [{
      weekday: 0,
      meal_type: 'dinner',
      policy: 'fixed',
      fixed_user_id: admin,
      participant_ids: [admin, sam, jamie],
    }],
  });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const materialized = await call(
    'GET', `/week-model?start=2070-01-06&end=2070-01-06&member_id=${admin}`,
  );
  assert.equal(materialized.status, 200, JSON.stringify(materialized.body));
  const meal = database.prepare(`
    SELECT * FROM meals WHERE meal_plan_id = ? AND date = '2070-01-06'
  `).get(plan.body.data.id);
  assert.ok(meal);

  actor = { id: sam, role: 'member' };
  const optedIn = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating',
    choice_kind: 'household',
    menu_item_ids: [],
    confirmed: true,
    notify_on_menu_change: true,
  });
  assert.equal(optedIn.status, 200, JSON.stringify(optedIn.body));
  assert.equal(optedIn.body.data.notify_on_menu_change, true);
  assert.equal(database.prepare(`
    SELECT notify_on_menu_change FROM meal_person_decisions
     WHERE meal_id = ? AND beneficiary_user_id = ?
  `).get(meal.id, sam).notify_on_menu_change, 1);

  const projected = await call(
    'GET', `/week-model?start=2070-01-06&end=2070-01-06&member_id=${sam}`,
  );
  const projectedMeal = projected.body.data.occurrences
    .find((occurrence) => Number(occurrence.id) === Number(meal.id));
  assert.equal(projectedMeal.my_decision.notify_on_menu_change, true);

  actor = { id: jamie, role: 'member' };
  const stayedOut = await call('POST', `/${meal.id}/decisions`, {
    participation: 'not_participating',
    choice_kind: 'household',
    menu_item_ids: [],
    confirmed: true,
    notify_on_menu_change: false,
  });
  assert.equal(stayedOut.status, 200, JSON.stringify(stayedOut.body));

  actor = { id: admin, role: 'admin' };
  const firstEntree = await call('POST', `/${meal.id}/menu-items`, {
    item_type: 'entree', title: 'First published menu', position: 0,
  });
  assert.equal(firstEntree.status, 201, JSON.stringify(firstEntree.body));
  const firstPublish = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [firstEntree.body.data.id],
    confirmed: true,
  });
  assert.equal(firstPublish.status, 200, JSON.stringify(firstPublish.body));
  let reminders = database.prepare(`
    SELECT * FROM reminders WHERE entity_type = 'meal' AND entity_id = ? ORDER BY id
  `).all(meal.id);
  assert.equal(reminders.length, 1);
  assert.equal(Number(reminders[0].created_by), sam,
    'only the opted-in nonparticipant is the reminder beneficiary');
  const coalescedReminderId = Number(reminders[0].id);

  const identicalRetry = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [firstEntree.body.data.id],
    confirmed: true,
  });
  assert.equal(identicalRetry.status, 200, JSON.stringify(identicalRetry.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'meal' AND entity_id = ?
  `).get(meal.id).n, 1, 'an identical publication is not another Meal change');

  const secondDraft = await call('GET', `/${meal.id}/menu-items`);
  assert.equal(secondDraft.status, 200, JSON.stringify(secondDraft.body));
  const secondEntree = secondDraft.body.data.find((item) => item.item_type === 'entree');
  const changedOnce = await call('PUT', `/${meal.id}/menu-items`, {
    items: [{
      id: secondEntree.id,
      item_type: 'entree',
      position: 0,
      title: 'Second published menu',
    }],
  });
  assert.equal(changedOnce.status, 200, JSON.stringify(changedOnce.body));
  const secondPublish = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [changedOnce.body.data[0].id],
    confirmed: true,
  });
  assert.equal(secondPublish.status, 200, JSON.stringify(secondPublish.body));
  reminders = database.prepare(`
    SELECT * FROM reminders WHERE entity_type = 'meal' AND entity_id = ? ORDER BY id
  `).all(meal.id);
  assert.equal(reminders.length, 1, 'changes coalesce while the reminder is still undelivered');
  assert.equal(Number(reminders[0].id), coalescedReminderId);

  database.prepare(`
    UPDATE reminders SET pushed_at = '2070-01-01T00:00:00Z' WHERE id = ?
  `).run(coalescedReminderId);
  const thirdDraft = await call('GET', `/${meal.id}/menu-items`);
  assert.equal(thirdDraft.status, 200, JSON.stringify(thirdDraft.body));
  const thirdEntree = thirdDraft.body.data.find((item) => item.item_type === 'entree');
  const changedAgain = await call('PUT', `/${meal.id}/menu-items`, {
    items: [{
      id: thirdEntree.id,
      item_type: 'entree',
      position: 0,
      title: 'Third published menu',
    }],
  });
  assert.equal(changedAgain.status, 200, JSON.stringify(changedAgain.body));
  const thirdPublish = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [changedAgain.body.data[0].id],
    confirmed: true,
  });
  assert.equal(thirdPublish.status, 200, JSON.stringify(thirdPublish.body));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM reminders WHERE entity_type = 'meal' AND entity_id = ?
  `).get(meal.id).n, 2, 'a later change may notify again after the previous reminder delivered');

  actor = { id: sam, role: 'member' };
  const rejoined = await call('POST', `/${meal.id}/decisions`, {
    participation: 'participating',
    choice_kind: 'household',
    menu_item_ids: [changedAgain.body.data[0].id],
    confirmed: true,
    notify_on_menu_change: true,
  });
  assert.equal(rejoined.status, 200, JSON.stringify(rejoined.body));
  assert.equal(rejoined.body.data.notify_on_menu_change, false,
    'the opt-in cannot remain active after the person rejoins');

  actor = { id: admin, role: 'admin' };
  assert.equal((await call('DELETE', `/plans/${plan.body.data.id}`)).status, 200);
});
