import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
const { MIGRATIONS, FORK_MIGRATIONS, remapForkMigrationVersions } = await import('../server/db.js');
const forkRows = [
  [160, 10000, 'Tasks: ordered round-robin assignment for recurring tasks'],
  [161, 10001, 'Tasks: synchronized rotation groups for recurring round-robin cohorts'],
  [162, 10002, 'Household automation: skills, activity templates, workflows and Quick Add'],
  [163, 10003, 'Tasks: bind scheduled and recurring work to Activity Templates'],
];
function makeDb() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  return d;
}
test('legacy fork records move into fork namespace', () => {
  const d = makeDb();
  const ins = d.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)');
  for (const [oldVersion, , description] of forkRows) ins.run(oldVersion, description);
  remapForkMigrationVersions(d);
  for (const [oldVersion, newVersion, description] of forkRows) {
    assert.equal(d.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(oldVersion), undefined);
    assert.equal(d.prepare('SELECT description FROM schema_migrations WHERE version = ?').get(newVersion)?.description, description);
  }
  d.close();
});
test('stock upstream rows with the same numeric versions stay untouched', () => {
  const d = makeDb();
  const stock = [
    [160, 'Quick links: household links as a tile row on the overview (#469)'],
    [161, 'Task completions: erledigen wird ein Ereignis, nicht nur ein Zustand (#791)'],
    [162, 'Pantry: widen reminders for pantry_item so a best-before date can notify (#811)'],
    [163, 'Quick links: a built-in symbol as a third face, next to image and monogram (#873)'],
  ];
  const ins = d.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)');
  for (const row of stock) ins.run(...row);
  remapForkMigrationVersions(d);
  assert.deepEqual(d.prepare('SELECT version, description FROM schema_migrations ORDER BY version').all(), stock.map(([version, description]) => ({ version, description })));
  d.close();
});

function applyMigration(database, migration) {
  const run = database.transaction(() => {
    if (typeof migration.up === 'function') migration.up(database);
    else database.exec(migration.up);
    if (typeof migration.afterUp === 'function') migration.afterUp(database);
    database.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)')
      .run(migration.version, migration.description);
  });

  if (!migration.foreignKeysOff) return run();
  database.pragma('foreign_keys = OFF');
  try {
    run();
  } finally {
    database.pragma('foreign_keys = ON');
  }
  assert.deepEqual(database.pragma('foreign_key_check'), [], `migration ${migration.version} left FK violations`);
}

function runRealMigrator(databasePath) {
  const env = { ...process.env, DB_PATH: databasePath, TZ: 'UTC' };
  delete env.DB_ENCRYPTION_KEY;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', 'await import("./server/db.js");'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `migrator failed\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  );
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

const compatibilityFixtureTables = [
  'places',
  'shopping_lists',
  'shopping_items',
  'tasks',
  'calendar_events',
  'reminders',
  'meal_schedule_slots',
  'meal_schedule_slot_participants',
  'meal_recurrence_templates',
  'meal_recurrence_ingredients',
  'meal_recurrence_exceptions',
  'meals',
  'meal_ingredients',
  'meal_participants',
  'planning_obligations',
  'planning_obligation_events',
  'meal_selection_responses',
  'meal_selection_response_items',
  'assignment_rotation_state',
  'availability_periods',
  'trip_plans',
  'trip_participants',
  'trip_stages',
  'trip_tasks',
  'meal_grocery_runs',
  'meal_grocery_items',
  'meal_grocery_item_sources',
  'meal_execution_settings',
  'meal_execution_snapshots',
  'meal_execution_tasks',
  'pantry_items',
  'pantry_movements',
];

const compatibilityBackfillTables = [
  'meal_plans',
  'meal_plan_revisions',
  'meal_plan_rules',
  'meal_plan_rule_participants',
  'planning_contexts',
  'planning_context_sources',
  'planning_context_members',
  'planning_context_conflicts',
  'planning_context_meal_plans',
  'meal_occurrence_assignments',
  'meal_person_decisions',
  'meal_person_decision_events',
  'meal_menu_items',
  'meal_person_menu_selections',
  'calendar_travel_details',
  'task_claim_eligibility',
  'task_action_links',
  'meal_grocery_settings',
  'meal_occurrence_role_assignments',
  'meal_menu_item_events',
  'meal_menu_generations',
  'meal_plan_default_settings',
  'meal_plan_occurrence_exceptions',
  'planning_context_grocery_settings',
];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function captureColumns(database, tables) {
  return Object.fromEntries(tables.map((table) => [
    table,
    database.pragma(`table_info(${quoteIdentifier(table)})`).map((column) => column.name),
  ]));
}

function captureRows(database, columnsByTable) {
  return Object.fromEntries(Object.entries(columnsByTable).map(([table, columns]) => {
    const selected = columns.map(quoteIdentifier).join(', ');
    return [table, database.prepare(`SELECT ${selected} FROM ${quoteIdentifier(table)} ORDER BY rowid`).all()];
  }));
}

test('migration 10018 preserves released menu IDs, selection/event FKs, and is restart-idempotent', () => {
  const dir = mkdtempSync(fileURLToPath(new URL('../.test-menu-generation-migration-', import.meta.url)));
  const databasePath = join(dir, 'candidate.db');
  try {
    const before = new Database(databasePath);
    before.pragma('foreign_keys = ON');
    before.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`);
    for (const migration of MIGRATIONS) applyMigration(before, migration);
    for (const migration of FORK_MIGRATIONS.filter((item) => item.version <= 10017)) {
      applyMigration(before, migration);
    }
    const userId = Number(before.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('menu-generation-owner', 'Menu Owner', 'x', 'member')
    `).run().lastInsertRowid);
    const mealId = Number(before.prepare(`
      INSERT INTO meals (date, meal_type, title, selection_status, created_by)
      VALUES ('2044-04-04', 'dinner', 'Released curry', 'selected', ?)
    `).run(userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO meal_participants (meal_id, user_id, role, status, source)
      VALUES (?, ?, 'chooser', 'participating', 'schedule')
    `).run(mealId, userId);
    const obligationId = Number(before.prepare(`
      INSERT INTO planning_obligations (
        entity_type, entity_id, logical_key, role, responsible_user_id,
        status, responded_at
      ) VALUES ('meal', ?, ?, 'chooser', ?, 'fulfilled', '2044-04-01T12:00:00Z')
    `).run(mealId, `migration-menu:${mealId}:chooser`, userId).lastInsertRowid);
    const itemId = Number(before.prepare(`
      INSERT INTO meal_menu_items (
        meal_id, item_type, position, title, created_by,
        created_at, updated_at
      ) VALUES (?, 'entree', 0, 'Released curry', ?,
        '2044-04-01T11:00:00Z', '2044-04-01T11:30:00Z')
    `).run(mealId, userId).lastInsertRowid);
    const decisionId = Number(before.prepare(`
      INSERT INTO meal_person_decisions (
        meal_id, beneficiary_user_id, participation, choice_kind, confirmed,
        entered_by_user_id, entered_via
      ) VALUES (?, ?, 'participating', 'household', 1, ?, 'self')
    `).run(mealId, userId, userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO meal_person_menu_selections (decision_id, menu_item_id, selected)
      VALUES (?, ?, 1)
    `).run(decisionId, itemId);
    const eventId = Number(before.prepare(`
      INSERT INTO meal_menu_item_events (
        meal_id, menu_item_id, event, beneficiary_user_id, actor_user_id,
        after_json
      ) VALUES (?, ?, 'created', ?, ?, '{"title":"Released curry"}')
    `).run(mealId, itemId, userId, userId).lastInsertRowid);
    const releasedItem = before.prepare(`
      SELECT id, meal_id, item_type, position, title, recipe_id, notes,
             created_by, created_at, updated_at
        FROM meal_menu_items WHERE id = ?
    `).get(itemId);
    before.close();

    const firstLog = runRealMigrator(databasePath);
    assert.match(firstLog, /Migration 10018 applied:/);
    assert.doesNotMatch(firstLog, /Migration 1001[5-7] applied:/);
    const afterFirst = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(afterFirst.prepare(`
      SELECT id, meal_id, item_type, position, title, recipe_id, notes,
             created_by, created_at, updated_at
        FROM meal_menu_items WHERE id = ?
    `).get(itemId), releasedItem, 'released menu row identity and values remain exact');
    assert.deepEqual(afterFirst.prepare(`
      SELECT decision_id, menu_item_id, selected
        FROM meal_person_menu_selections WHERE decision_id = ? AND menu_item_id = ?
    `).get(decisionId, itemId), { decision_id: decisionId, menu_item_id: itemId, selected: 1 });
    assert.equal(afterFirst.prepare('SELECT menu_item_id FROM meal_menu_item_events WHERE id = ?')
      .get(eventId).menu_item_id, itemId);
    assert.deepEqual(afterFirst.prepare(`
      SELECT menu_generation, generation_position FROM meal_menu_items WHERE id = ?
    `).get(itemId), { menu_generation: 1, generation_position: 0 });
    assert.deepEqual(afterFirst.prepare(`
      SELECT meal_id, generation, chooser_user_id, chooser_obligation_id, status
        FROM meal_menu_generations WHERE meal_id = ?
    `).get(mealId), {
      meal_id: mealId,
      generation: 1,
      chooser_user_id: userId,
      chooser_obligation_id: obligationId,
      status: 'fulfilled',
    });
    const firstHistory = afterFirst.prepare(`
      SELECT version, description, applied_at FROM schema_migrations ORDER BY version
    `).all();
    assert.deepEqual(afterFirst.pragma('foreign_key_check'), []);
    assert.deepEqual(afterFirst.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    afterFirst.close();

    const secondLog = runRealMigrator(databasePath);
    assert.doesNotMatch(secondLog, /Migration \d+ applied:/);
    const afterSecond = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(afterSecond.prepare(`
      SELECT version, description, applied_at FROM schema_migrations ORDER BY version
    `).all(), firstHistory);
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS count FROM meal_menu_generations WHERE meal_id = ?')
      .get(mealId).count, 1);
    assert.equal(afterSecond.prepare('SELECT menu_item_id FROM meal_menu_item_events WHERE id = ?')
      .get(eventId).menu_item_id, itemId);
    assert.deepEqual(afterSecond.pragma('foreign_key_check'), []);
    assert.deepEqual(afterSecond.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    afterSecond.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      if (!(process.platform === 'win32' && err?.code === 'EPERM')) throw err;
    }
  }
});

test('a live-like v10014 database applies upstream 168/169 and new fork 10015-10024 exactly once', () => {
  // Keep the disposable proof beside the worktree. On managed Windows hosts
  // the OS temp directory can permit creation but reject recursive cleanup
  // from a child test process, leaving an otherwise successful proof red.
  const dir = mkdtempSync(fileURLToPath(new URL('../.test-v254-migration-', import.meta.url)));
  const databasePath = join(dir, 'candidate.db');
  try {
    const before = new Database(databasePath);
    before.pragma('foreign_keys = ON');
    before.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`);
    for (const migration of MIGRATIONS.filter((item) => item.version <= 167)) {
      applyMigration(before, migration);
    }
    for (const migration of FORK_MIGRATIONS.filter((item) => item.version <= 10014)) {
      applyMigration(before, migration);
    }

    const userId = Number(before.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('migration-existing-user', 'Existing User', 'x', 'member')
    `).run().lastInsertRowid);
    const participantId = Number(before.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('migration-participant', 'Migration Participant', 'x', 'member')
    `).run().lastInsertRowid);
    const homePlaceId = Number(before.prepare(`
      INSERT INTO places (name, type, created_by, created_at, updated_at)
      VALUES ('Migration Kitchen', 'home', ?, '2031-12-01T08:00:00Z', '2031-12-01T08:00:00Z')
    `).run(userId).lastInsertRowid);
    const destinationPlaceId = Number(before.prepare(`
      INSERT INTO places (name, type, created_by, created_at, updated_at)
      VALUES ('Migration Lodge', 'hotel', ?, '2031-12-01T08:01:00Z', '2031-12-01T08:01:00Z')
    `).run(userId).lastInsertRowid);
    const shoppingListId = Number(before.prepare(`
      INSERT INTO shopping_lists (name, created_by, created_at, updated_at)
      VALUES ('Migration Groceries', ?, '2031-12-01T08:02:00Z', '2031-12-01T08:02:00Z')
    `).run(userId).lastInsertRowid);

    const activeSlotId = Number(before.prepare(`
      INSERT INTO meal_schedule_slots (
        weekday, meal_type, policy, fallback_user_id, rotation_group, presence_required,
        earliest_time, preferred_time, latest_time, expected_duration_minutes, active,
        revision, created_by, created_at, updated_at, place_id,
        selection_deadline_minutes, reminder_minutes, snack_choice_limit,
        cook_user_id, supervisor_user_id
      ) VALUES (
        2, 'dinner', 'round_robin', ?, 'migration-cooks', 1,
        '17:30', '18:15', '19:30', 75, 1,
        4, ?, '2031-12-01T08:03:00Z', '2031-12-02T08:03:00Z', ?,
        600, 90, 3, ?, ?
      )
    `).run(userId, userId, homePlaceId, participantId, userId).lastInsertRowid);
    const archivedSlotId = Number(before.prepare(`
      INSERT INTO meal_schedule_slots (
        weekday, meal_type, policy, fixed_user_id, fallback_user_id, presence_required,
        earliest_time, preferred_time, latest_time, expected_duration_minutes, active,
        revision, created_by, created_at, updated_at, place_id,
        selection_deadline_minutes, reminder_minutes, snack_choice_limit
      ) VALUES (
        5, 'snack', 'personal_choice', ?, ?, 0,
        '14:00', '15:00', '17:00', 20, 0,
        2, ?, '2031-12-01T08:04:00Z', '2031-12-02T08:04:00Z', ?,
        240, 30, 5
      )
    `).run(participantId, userId, participantId, homePlaceId).lastInsertRowid);
    const addSlotParticipant = before.prepare(`
      INSERT INTO meal_schedule_slot_participants (schedule_slot_id, user_id) VALUES (?, ?)
    `);
    addSlotParticipant.run(activeSlotId, userId);
    addSlotParticipant.run(activeSlotId, participantId);
    addSlotParticipant.run(archivedSlotId, participantId);

    const mealId = Number(before.prepare(`
      INSERT INTO meals (
        date, meal_type, title, notes, created_by, scope, scheduled_time,
        earliest_time, preferred_time, latest_time, expected_duration_minutes,
        source, source_key, schedule_slot_id, schedule_revision, provenance_json,
        place_id, selection_status, created_at, updated_at
      ) VALUES (
        '2032-01-07', 'dinner', 'Migration stew', 'Keep every legacy field', ?,
        'household', '18:15', '17:30', '18:15', '19:30', 75,
        'schedule', 'migration-fixture:meal:1', ?, 4, '{"fixture":"pre-10015"}',
        ?, 'selected', '2031-12-03T08:00:00Z', '2031-12-03T09:00:00Z'
      )
    `).run(userId, activeSlotId, homePlaceId).lastInsertRowid);
    const ingredientId = Number(before.prepare(`
      INSERT INTO meal_ingredients (
        meal_id, name, quantity, on_shopping_list, category, created_at, updated_at
      ) VALUES (?, 'Rice', '2 kg', 1, 'Vorrat', '2031-12-03T08:01:00Z', '2031-12-03T08:01:00Z')
    `).run(mealId).lastInsertRowid);
    before.prepare(`
      INSERT INTO meal_participants (meal_id, user_id, role, status, source, created_at, updated_at)
      VALUES (?, ?, 'cook', 'participating', 'schedule', '2031-12-03T08:02:00Z', '2031-12-03T08:02:00Z')
    `).run(mealId, userId);
    before.prepare(`
      INSERT INTO meal_participants (meal_id, user_id, role, status, source, created_at, updated_at)
      VALUES (?, ?, 'participant', 'participating', 'schedule', '2031-12-03T08:03:00Z', '2031-12-03T08:03:00Z')
    `).run(mealId, participantId);

    const obligationId = Number(before.prepare(`
      INSERT INTO planning_obligations (
        entity_type, entity_id, logical_key, role, responsible_user_id, responsible_group,
        due_at, status, attempt, fallback_source, response_deadline, reminder_at,
        responded_at, response_note, metadata_json, created_at, updated_at
      ) VALUES (
        'meal', ?, 'migration-fixture:choice:1', 'chooser', ?, 'migration-household',
        '2032-01-06T18:15:00Z', 'fulfilled', 2, 'migration-fallback',
        '2032-01-06T18:15:00Z', '2032-01-06T16:45:00Z',
        '2032-01-06T17:00:00Z', 'Answered by another member', '{"fixture":true}',
        '2031-12-03T08:04:00Z', '2032-01-06T17:00:00Z'
      )
    `).run(mealId, participantId).lastInsertRowid);
    before.prepare(`
      INSERT INTO planning_obligation_events (
        obligation_id, event, actor_user_id, details_json, created_at
      ) VALUES (?, 'fulfilled', ?, '{"fixture":true}', '2032-01-06T17:00:00Z')
    `).run(obligationId, userId);
    before.prepare(`
      INSERT INTO meal_selection_responses (
        obligation_id, meal_id, title, notes, scope, responded_by, created_at, updated_at
      ) VALUES (
        ?, ?, 'Migration stew', 'Legacy response', 'personal', ?,
        '2032-01-06T17:00:00Z', '2032-01-06T17:00:00Z'
      )
    `).run(obligationId, mealId, userId);
    before.prepare(`
      INSERT INTO meal_selection_response_items (
        obligation_id, position, meal_id, title, notes
      ) VALUES (?, 0, ?, 'Migration stew', 'Legacy entree')
    `).run(obligationId, mealId);
    before.prepare(`
      INSERT INTO assignment_rotation_state (
        rotation_key, cursor_user_id, occurrence_count, updated_at
      ) VALUES ('meal:migration-cooks:chooser', ?, 7, '2031-12-03T08:05:00Z')
    `).run(participantId);

    const eventId = Number(before.prepare(`
      INSERT INTO calendar_events (
        title, start_datetime, end_datetime, assigned_to, created_by, visibility, place_id,
        created_at, updated_at
      ) VALUES (
        'Migration travel sentinel', '2032-01-10T10:00:00', '2032-01-10T12:00:00',
        ?, ?, 'all', ?, '2031-12-03T08:06:00Z', '2031-12-03T08:06:00Z'
      )
    `).run(participantId, userId, destinationPlaceId).lastInsertRowid);
    before.prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('event', ?, '2032-01-10T09:00:00', ?)
    `).run(eventId, userId);

    const availabilityPeriodId = Number(before.prepare(`
      INSERT INTO availability_periods (
        user_id, source, category, state, place_id, starts_at, ends_at, note,
        active, created_by, created_at, updated_at
      ) VALUES (
        ?, 'manual', 'travel', 'away', ?, '2032-01-10T10:00:00', '2032-01-12T18:00:00',
        'Pre-10015 trip availability', 1, ?, '2031-12-03T08:07:00Z', '2031-12-03T08:07:00Z'
      )
    `).run(participantId, destinationPlaceId, userId).lastInsertRowid);
    const tripId = Number(before.prepare(`
      INSERT INTO trip_plans (
        name, destination_place_id, starts_at, ends_at, trip_type, status,
        create_away_periods, notes, created_by, created_at, updated_at
      ) VALUES (
        'Migration trip', ?, '2032-01-10T10:00:00', '2032-01-12T18:00:00',
        'vacation', 'active', 1, 'Preserve the released trip', ?,
        '2031-12-03T08:08:00Z', '2031-12-03T08:08:00Z'
      )
    `).run(destinationPlaceId, userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO trip_participants (trip_id, user_id, availability_period_id)
      VALUES (?, ?, ?)
    `).run(tripId, participantId, availabilityPeriodId);
    before.prepare(`
      INSERT INTO trip_stages (
        trip_id, phase, title, starts_at, place_id, notes, sort_order, created_at, updated_at
      ) VALUES (
        ?, 'departure', 'Leave for migration trip', '2032-01-10T10:00:00', ?,
        'Legacy stage', 0, '2031-12-03T08:09:00Z', '2031-12-03T08:09:00Z'
      )
    `).run(tripId, destinationPlaceId);
    const tripTaskId = Number(before.prepare(`
      INSERT INTO tasks (title, due_date, assigned_to, created_by, created_at, updated_at)
      VALUES (
        'Pack migration bags', '2032-01-09', ?, ?,
        '2031-12-03T08:10:00Z', '2031-12-03T08:10:00Z'
      )
    `).run(participantId, userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO trip_tasks (trip_id, task_id, phase) VALUES (?, ?, 'before_departure')
    `).run(tripId, tripTaskId);

    const executionTaskId = Number(before.prepare(`
      INSERT INTO tasks (title, due_date, due_time, assigned_to, created_by, created_at, updated_at)
      VALUES (
        'Cook migration stew', '2032-01-07', '18:15', ?, ?,
        '2031-12-03T08:11:00Z', '2031-12-03T08:11:00Z'
      )
    `).run(userId, userId).lastInsertRowid);
    const shoppingItemId = Number(before.prepare(`
      INSERT INTO shopping_items (
        list_id, name, quantity, category, is_checked, added_from_meal, created_at, updated_at
      ) VALUES (
        ?, 'Rice', '2 kg', 'Vorrat', 1, ?,
        '2031-12-03T08:12:00Z', '2031-12-03T08:12:00Z'
      )
    `).run(shoppingListId, mealId).lastInsertRowid);
    const pantryItemId = Number(before.prepare(`
      INSERT INTO pantry_items (
        name, quantity, unit, category, expires_on, created_by, created_at, updated_at
      ) VALUES (
        'Rice', 2, 'kg', 'Vorrat', '2033-01-01', ?,
        '2031-12-03T08:13:00Z', '2031-12-03T08:13:00Z'
      )
    `).run(userId).lastInsertRowid);
    before.prepare(`
      UPDATE meal_execution_settings
         SET enabled = 0,
             default_shopping_list_id = ?,
             auto_create_grocery_draft = 0,
             auto_finalize_grocery = 1,
             generate_preparation = 0,
             generate_cooking = 1,
             generate_supervision = 0,
             generate_serving = 1,
             generate_cleanup = 0,
             preparation_lead_minutes = 75,
             cooking_lead_minutes = 40,
             cleanup_delay_minutes = 90,
             updated_by = ?,
             updated_at = '2031-12-03T08:14:00Z'
       WHERE id = 1
    `).run(shoppingListId, userId);
    const groceryRunId = Number(before.prepare(`
      INSERT INTO meal_grocery_runs (
        logical_key, shopping_list_id, start_date, end_date, status, source_fingerprint,
        revision, created_by, finalized_at, added_to_shopping_at, purchased_at,
        reconciled_at, created_at, updated_at
      ) VALUES (
        'migration-fixture:grocery-run', ?, '2032-01-05', '2032-01-11', 'reconciled',
        'migration-grocery-fingerprint', 2, ?, '2032-01-04T12:00:00Z',
        '2032-01-04T12:05:00Z', '2032-01-05T12:00:00Z', '2032-01-05T12:30:00Z',
        '2032-01-04T11:00:00Z', '2032-01-05T12:30:00Z'
      )
    `).run(shoppingListId, userId).lastInsertRowid);
    const groceryItemId = Number(before.prepare(`
      INSERT INTO meal_grocery_items (
        grocery_run_id, logical_key, name, quantity, category, planned_quantity,
        unit, purchased_quantity, remaining_quantity, purchase_status,
        shopping_item_id, published_at, pantry_item_id, reconciled_quantity,
        reconciled_at, created_at, updated_at
      ) VALUES (
        ?, 'migration-fixture:rice', 'Rice', '2 kg', 'Vorrat', 2,
        'kg', 2, 0, 'purchased', ?, '2032-01-04T12:05:00Z', ?, 2,
        '2032-01-05T12:30:00Z', '2032-01-04T11:01:00Z', '2032-01-05T12:30:00Z'
      )
    `).run(groceryRunId, shoppingItemId, pantryItemId).lastInsertRowid);
    before.prepare(`
      INSERT INTO meal_grocery_item_sources (
        grocery_item_id, source_key, source_kind, meal_id, meal_ingredient_id,
        meal_date_snapshot, meal_title_snapshot, ingredient_name_snapshot,
        quantity_snapshot, category_snapshot, created_at
      ) VALUES (
        ?, 'migration-fixture:ingredient-source', 'meal_ingredient', ?, ?,
        '2032-01-07', 'Migration stew', 'Rice', '2 kg', 'Vorrat',
        '2032-01-04T11:02:00Z'
      )
    `).run(groceryItemId, mealId, ingredientId);
    const mealSnapshotId = Number(before.prepare(`
      INSERT INTO meal_execution_snapshots (
        logical_key, meal_id, source_fingerprint, revision, status,
        meal_date_snapshot, meal_type_snapshot, meal_title_snapshot,
        scheduled_time_snapshot, snapshot_json, frozen_at, completed_at,
        created_by, created_at, updated_at
      ) VALUES (
        'migration-fixture:meal-snapshot', ?, 'migration-meal-fingerprint', 3, 'completed',
        '2032-01-07', 'dinner', 'Migration stew', '18:15',
        '{"fixture":"pre-10015"}', '2032-01-07T17:30:00Z', '2032-01-07T19:30:00Z',
        ?, '2032-01-07T16:00:00Z', '2032-01-07T19:30:00Z'
      )
    `).run(mealId, userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO meal_execution_tasks (
        meal_snapshot_id, meal_id, role, logical_key, task_id,
        assigned_user_id_snapshot, title_snapshot, due_date_snapshot,
        due_time_snapshot, created_at, updated_at
      ) VALUES (
        ?, ?, 'cooking', 'migration-fixture:execution-task', ?, ?,
        'Cook migration stew', '2032-01-07', '18:15',
        '2032-01-07T16:01:00Z', '2032-01-07T16:01:00Z'
      )
    `).run(mealSnapshotId, mealId, executionTaskId, userId);
    before.prepare(`
      INSERT INTO pantry_movements (
        logical_key, pantry_item_id, grocery_run_id, grocery_item_id, meal_id,
        meal_snapshot_id, task_id, movement_type, quantity, unit, name_snapshot,
        quantity_before, quantity_after, notes, created_by, created_at
      ) VALUES (
        'migration-fixture:pantry-movement', ?, ?, ?, ?, ?, ?,
        'purchase', 2, 'kg', 'Rice', 0, 2, 'Legacy reconciliation', ?,
        '2032-01-05T12:30:00Z'
      )
    `).run(
      pantryItemId, groceryRunId, groceryItemId, mealId,
      mealSnapshotId, executionTaskId, userId,
    );

    const legacyColumns = captureColumns(before, compatibilityFixtureTables);
    const originalFixtureState = captureRows(before, legacyColumns);
    const cursorBefore = before.prepare(`
      SELECT * FROM assignment_rotation_state WHERE rotation_key = 'meal:migration-cooks:chooser'
    `).get();

    const originalHistory = before.prepare(`
      SELECT version, description, applied_at FROM schema_migrations ORDER BY version
    `).all();
    assert.equal(originalHistory.length, 182);
    assert.equal(before.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 10014);
    assert.equal(before.pragma('table_info(users)').some((column) => column.name === 'onboarding_version'), false);
    assert.equal(before.pragma('table_info(reminders)').some((column) => column.name === 'assigned_from'), false);
    assert.deepEqual(before.pragma('foreign_key_check'), []);
    assert.deepEqual(before.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    before.close();

    const firstLog = runRealMigrator(databasePath);
    assert.match(firstLog, /Migration 168 applied:/);
    assert.match(firstLog, /Migration 169 applied:/);
    assert.match(firstLog, /Migration 10015 applied:/);
    assert.match(firstLog, /Migration 10016 applied:/);
    assert.match(firstLog, /Migration 10017 applied:/);
    assert.match(firstLog, /Migration 10018 applied:/);
    assert.match(firstLog, /Migration 10019 applied:/);
    assert.match(firstLog, /Migration 10020 applied:/);
    assert.match(firstLog, /Migration 10021 applied:/);
    assert.match(firstLog, /Migration 10022 applied:/);
    assert.match(firstLog, /Migration 10023 applied:/);
    assert.match(firstLog, /Migration 10024 applied:/);
    assert.doesNotMatch(firstLog, /Migration 100(?:0\d|1[0-4]) applied:/, 'released fork migrations must not replay');

    const afterFirst = new Database(databasePath, { readonly: true, fileMustExist: true });
    const firstHistory = afterFirst.prepare(`
      SELECT version, description, applied_at FROM schema_migrations ORDER BY version
    `).all();
    assert.equal(firstHistory.length, 194, 'only migrations 168, 169 and 10015-10024 are added');
    assert.deepEqual(
      firstHistory.filter((row) => ![168, 169, 10015, 10016, 10017, 10018, 10019, 10020, 10021, 10022, 10023, 10024].includes(row.version)),
      originalHistory,
      'all released core/fork migration records and timestamps remain byte-for-byte logical matches',
    );
    assert.deepEqual(
      firstHistory.filter((row) => row.version === 168 || row.version === 169).map((row) => row.version),
      [168, 169],
    );
    assert.equal(firstHistory.find((row) => row.version === 10015)?.description,
      'Meal plans, scoped planning contexts, travel coordination and audited meal choices');
    assert.equal(firstHistory.find((row) => row.version === 10016)?.description,
      'Stable Meal Plan rule identity and compatibility reconciliation');
    assert.equal(firstHistory.find((row) => row.version === 10017)?.description,
      'Reusable Meal Plan slots, delegated roles, weekly deadlines and custom meal types');
    assert.equal(firstHistory.find((row) => row.version === 10018)?.description,
      'Chooser-scoped Meal menu generations and durable released menu history');
    assert.equal(firstHistory.find((row) => row.version === 10019)?.description,
      'Meal chooser fallback chains, terminal defaults and per-course limits');
    assert.equal(firstHistory.find((row) => row.version === 10020)?.description,
      'Meal portions for canonical Add/Edit menu options');
    assert.equal(firstHistory.find((row) => row.version === 10021)?.description,
      'Places and Pantry: default Home plus product and preferred-store identity');
    assert.equal(firstHistory.find((row) => row.version === 10022)?.description,
      'Meal defaults: weekly grocery cutoffs, department grouping and safe role assignment');
    assert.equal(firstHistory.find((row) => row.version === 10023)?.description,
      'Meal menu-change opt-ins through the existing reminder pipeline');
    assert.equal(firstHistory.find((row) => row.version === 10024)?.description,
      'Context-specific Meal Plan activation, occurrence skips and grocery overrides');
    assert.equal(afterFirst.prepare('SELECT onboarding_version FROM users WHERE id = ?').get(userId).onboarding_version, 1);
    assert.equal(afterFirst.prepare('SELECT assigned_from FROM reminders WHERE entity_type = ? AND entity_id = ?')
      .get('event', eventId).assigned_from, null);
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_reminders_assigned_from'").get());
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
    assert.equal(afterFirst.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 10024,
      'fork namespace remains the numeric maximum; direct 168/169 row checks are authoritative');
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meal_plans'").get());
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'planning_contexts'").get());
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meal_person_decision_events'").get());
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meal_plan_occurrence_exceptions'").get());
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'planning_context_grocery_settings'").get());
    assert.ok(afterFirst.pragma('table_info(meal_plans)').some((column) => column.name === 'home_enabled'));
    assert.ok(afterFirst.pragma('table_info(meal_person_decisions)')
      .some((column) => column.name === 'notify_on_menu_change'));
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_reminders_meal_pending'").get());
    assert.ok(afterFirst.pragma('table_info(meal_plan_rules)').some((column) => column.name === 'rule_key'));
    assert.ok(afterFirst.pragma('table_info(meal_plan_rules)').some((column) => column.name === 'retired_at'));
    const ruleColumns = new Set(afterFirst.pragma('table_info(meal_plan_rules)').map((column) => column.name));
    for (const column of [
      'slot_group_key', 'custom_label', 'chooser_backup_strategy', 'cook_strategy',
      'cook_rotation_group', 'supervisor_strategy', 'supervisor_rotation_group',
      'deadline_mode', 'deadline_weekday', 'deadline_time',
      'execution_assignment_strategies_json',
    ]) assert.ok(ruleColumns.has(column), `migration 10017 adds meal_plan_rules.${column}`);
    for (const column of [
      'chooser_fallback_user_ids_json', 'max_entree_choices', 'max_side_choices',
    ]) assert.ok(ruleColumns.has(column), `migration 10019 adds meal_plan_rules.${column}`);
    assert.deepEqual(afterFirst.prepare(`
      SELECT json_valid(chooser_fallback_user_ids_json) AS fallback_json_valid,
             max_entree_choices, max_side_choices, choice_limit
        FROM meal_plan_rules ORDER BY id
    `).all().map((row) => ({
      ...row,
      expected_sides: Math.min(9, Math.max(0, Number(row.choice_limit))),
    })), afterFirst.prepare(`
      SELECT 1 AS fallback_json_valid, 1 AS max_entree_choices,
             MIN(9, MAX(0, choice_limit)) AS max_side_choices, choice_limit,
             MIN(9, MAX(0, choice_limit)) AS expected_sides
        FROM meal_plan_rules ORDER BY id
    `).all(), 'migration 10019 backfills valid ordered fallbacks and legacy-compatible course limits');
    assert.deepEqual(afterFirst.prepare(`
      SELECT id, chooser_terminal_strategy, chooser_terminal_user_id,
             chooser_round_robin_user_ids_json, updated_by
        FROM meal_plan_default_settings WHERE id = 1
    `).get(), {
      id: 1,
      chooser_terminal_strategy: 'eligible_round_robin',
      chooser_terminal_user_id: null,
      chooser_round_robin_user_ids_json: '[]',
      updated_by: null,
    });
    assert.ok(afterFirst.pragma('table_info(meals)').some((column) => column.name === 'custom_label'));
    assert.ok(afterFirst.pragma('table_info(meals)').some((column) => column.name === 'current_menu_generation'));
    assert.ok(afterFirst.pragma('table_info(meals)').some((column) => column.name === 'selection_policy_override'));
    assert.equal(afterFirst.prepare('SELECT selection_policy_override FROM meals WHERE id = ?')
      .get(mealId).selection_policy_override, null);
    for (const column of ['menu_generation', 'generation_position']) {
      assert.ok(afterFirst.pragma('table_info(meal_menu_items)').some((candidate) => candidate.name === column),
        `migration 10018 adds meal_menu_items.${column}`);
    }
    assert.ok(afterFirst.pragma('table_info(meal_recurrence_templates)').some((column) => column.name === 'custom_label'));
    const executionColumns = new Set(afterFirst.pragma('table_info(meal_execution_tasks)').map((column) => column.name));
    for (const column of [
      'assignment_strategy_snapshot', 'assignment_rotation_key',
      'cursor_before_user_id', 'cursor_after_user_id', 'eligible_user_ids_json',
    ]) assert.ok(executionColumns.has(column), `migration 10017 adds meal_execution_tasks.${column}`);
    for (const table of ['meal_occurrence_role_assignments', 'meal_menu_item_events', 'meal_menu_generations']) {
      assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    }
    for (const index of [
      'idx_meal_plan_rules_group_day', 'idx_meal_occurrence_role_user',
      'idx_meal_menu_item_events_meal', 'idx_meal_menu_items_generation_position',
      'idx_meal_menu_items_generation', 'idx_meal_menu_generations_chooser',
    ]) {
      assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));
    }
    for (const trigger of [
      'trg_meal_plan_rules_custom_label_insert', 'trg_meal_plan_rules_custom_label_update',
      'trg_meals_custom_label_insert', 'trg_meals_custom_label_update',
      'trg_meal_recurrence_custom_label_insert', 'trg_meal_recurrence_custom_label_update',
    ]) assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger));
    for (const table of ['meal_plan_rules', 'meals', 'meal_recurrence_templates']) {
      assert.match(
        afterFirst.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql,
        /'breakfast'.*'lunch'.*'dinner'.*'snack'.*'custom'/s,
        `${table} accepts the additive custom meal type`,
      );
    }
    const afterLegacyState = captureRows(afterFirst, legacyColumns);
    const originalPlaceIds = new Set(originalFixtureState.places.map((row) => Number(row.id)));
    afterLegacyState.places = afterLegacyState.places.filter((row) => originalPlaceIds.has(Number(row.id)));
    assert.deepEqual(
      afterLegacyState,
      originalFixtureState,
      '10015-10024 preserve every pre-existing Kitchen, travel, planning, grocery and execution value',
    );
    assert.equal(afterFirst.prepare(`
      SELECT COUNT(*) AS n FROM places WHERE type = 'home' AND active = 1
    `).get().n, 1, 'migration 10021 adds exactly one reusable active Home Place when missing');
    assert.deepEqual(
      afterFirst.prepare(`
        SELECT * FROM assignment_rotation_state WHERE rotation_key = 'meal:migration-cooks:chooser'
      `).get(),
      cursorBefore,
      'compatibility backfill must not consume or update the released household cursor',
    );
    assert.equal(afterFirst.prepare('SELECT custom_label FROM meals WHERE id = ?').get(mealId).custom_label, null);
    assert.deepEqual(afterFirst.prepare(`
      SELECT assignment_strategy_snapshot, assignment_rotation_key,
             cursor_before_user_id, cursor_after_user_id, eligible_user_ids_json
        FROM meal_execution_tasks WHERE logical_key = 'migration-fixture:execution-task'
    `).get(), {
      assignment_strategy_snapshot: null,
      assignment_rotation_key: null,
      cursor_before_user_id: null,
      cursor_after_user_id: null,
      eligible_user_ids_json: null,
    }, 'new execution assignment snapshots do not reinterpret released output');
    assert.deepEqual(afterFirst.prepare(`
      SELECT
        (SELECT COUNT(*) FROM meal_schedule_slots) AS schedule_slots,
        (SELECT COUNT(*) FROM meal_schedule_slot_participants) AS schedule_participants,
        (SELECT COUNT(*) FROM meals) AS meals,
        (SELECT COUNT(*) FROM meal_ingredients) AS meal_ingredients,
        (SELECT COUNT(*) FROM planning_obligations) AS obligations,
        (SELECT COUNT(*) FROM assignment_rotation_state) AS rotation_cursors,
        (SELECT COUNT(*) FROM trip_plans) AS trips,
        (SELECT COUNT(*) FROM trip_participants) AS trip_participants,
        (SELECT COUNT(*) FROM trip_stages) AS trip_stages,
        (SELECT COUNT(*) FROM trip_tasks) AS trip_tasks,
        (SELECT COUNT(*) FROM meal_grocery_runs) AS grocery_runs,
        (SELECT COUNT(*) FROM meal_grocery_items) AS grocery_items,
        (SELECT COUNT(*) FROM meal_grocery_item_sources) AS grocery_sources,
        (SELECT COUNT(*) FROM meal_execution_snapshots) AS execution_snapshots,
        (SELECT COUNT(*) FROM meal_execution_tasks) AS execution_tasks,
        (SELECT COUNT(*) FROM pantry_movements) AS pantry_movements
    `).get(), {
      schedule_slots: 2,
      schedule_participants: 3,
      meals: 1,
      meal_ingredients: 1,
      obligations: 1,
      rotation_cursors: 1,
      trips: 1,
      trip_participants: 1,
      trip_stages: 1,
      trip_tasks: 1,
      grocery_runs: 1,
      grocery_items: 1,
      grocery_sources: 1,
      execution_snapshots: 1,
      execution_tasks: 1,
      pantry_movements: 1,
    });

    const plans = afterFirst.prepare(`
      SELECT p.id, p.name, p.status, p.home_enabled, p.current_revision, p.legacy_schedule_slot_id,
             p.created_by, s.meal_plan_id
        FROM meal_plans p
        JOIN meal_schedule_slots s ON s.id = p.legacy_schedule_slot_id
       ORDER BY p.legacy_schedule_slot_id
    `).all();
    assert.deepEqual(plans.map((plan) => ({
      name: plan.name,
      status: plan.status,
      home_enabled: plan.home_enabled,
      current_revision: plan.current_revision,
      legacy_schedule_slot_id: plan.legacy_schedule_slot_id,
      created_by: plan.created_by,
      linked_plan_id: plan.meal_plan_id,
    })), [
      {
        name: 'Dinner - Wednesday',
        status: 'active',
        home_enabled: 1,
        current_revision: 4,
        legacy_schedule_slot_id: activeSlotId,
        created_by: userId,
        linked_plan_id: plans[0].id,
      },
      {
        name: 'Snack - Saturday',
        status: 'active',
        home_enabled: 0,
        current_revision: 2,
        legacy_schedule_slot_id: archivedSlotId,
        created_by: participantId,
        linked_plan_id: plans[1].id,
      },
    ]);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_plans').get().n, 2);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_plan_rules').get().n, 2);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_plan_revisions').get().n, 2);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_plan_rule_participants').get().n, 3);
    assert.equal(afterFirst.prepare(`
      SELECT COUNT(*) AS n
        FROM meal_schedule_slots s
        JOIN meal_plans p ON p.legacy_schedule_slot_id = s.id
        JOIN meal_plan_rules r ON r.meal_plan_id = p.id
       WHERE r.weekday IS NOT s.weekday
          OR r.meal_type IS NOT s.meal_type
          OR r.policy IS NOT s.policy
          OR r.fixed_user_id IS NOT s.fixed_user_id
          OR r.fallback_user_id IS NOT s.fallback_user_id
          OR r.rotation_group IS NOT s.rotation_group
          OR r.presence_required IS NOT s.presence_required
          OR r.place_id IS NOT s.place_id
          OR r.earliest_time IS NOT s.earliest_time
          OR r.preferred_time IS NOT s.preferred_time
          OR r.latest_time IS NOT s.latest_time
          OR r.expected_duration_minutes IS NOT s.expected_duration_minutes
          OR r.selection_deadline_minutes IS NOT s.selection_deadline_minutes
          OR r.reminder_minutes IS NOT s.reminder_minutes
          OR r.choice_limit IS NOT s.snack_choice_limit
          OR r.cook_user_id IS NOT s.cook_user_id
          OR r.supervisor_user_id IS NOT s.supervisor_user_id
          OR r.active IS NOT s.active
          OR r.created_at IS NOT s.created_at
          OR r.updated_at IS NOT s.updated_at
          OR r.sort_order IS NOT 0
    `).get().n, 0, 'every released slot field maps losslessly into its compatibility rule');

    const rules = afterFirst.prepare(`
      SELECT p.legacy_schedule_slot_id, r.weekday, r.meal_type, r.policy,
             r.rotation_group, r.active, r.choice_limit, r.rule_key, r.retired_at,
             r.generate_preparation, r.generate_cooking, r.generate_supervision,
             r.generate_serving, r.generate_cleanup,
             r.preparation_duration_minutes, r.cooking_duration_minutes,
             r.cleanup_duration_minutes
        FROM meal_plan_rules r
        JOIN meal_plans p ON p.id = r.meal_plan_id
       ORDER BY p.legacy_schedule_slot_id
    `).all();
    assert.deepEqual(rules, [
      {
        legacy_schedule_slot_id: activeSlotId,
        weekday: 2,
        meal_type: 'dinner',
        policy: 'round_robin',
        rotation_group: 'migration-cooks',
        active: 1,
        choice_limit: 3,
        rule_key: `legacy-slot:${activeSlotId}`,
        retired_at: null,
        generate_preparation: 0,
        generate_cooking: 1,
        generate_supervision: 0,
        generate_serving: 1,
        generate_cleanup: 0,
        preparation_duration_minutes: 75,
        cooking_duration_minutes: 40,
        cleanup_duration_minutes: 90,
      },
      {
        legacy_schedule_slot_id: archivedSlotId,
        weekday: 5,
        meal_type: 'snack',
        policy: 'personal_choice',
        rotation_group: null,
        active: 0,
        choice_limit: 5,
        rule_key: `legacy-slot:${archivedSlotId}`,
        retired_at: null,
        generate_preparation: 0,
        generate_cooking: 1,
        generate_supervision: 0,
        generate_serving: 1,
        generate_cleanup: 0,
        preparation_duration_minutes: 75,
        cooking_duration_minutes: 40,
        cleanup_duration_minutes: 90,
      },
    ]);
    assert.deepEqual(afterFirst.prepare(`
      SELECT p.legacy_schedule_slot_id, rp.user_id
        FROM meal_plan_rule_participants rp
        JOIN meal_plan_rules r ON r.id = rp.meal_plan_rule_id
        JOIN meal_plans p ON p.id = r.meal_plan_id
       ORDER BY p.legacy_schedule_slot_id, rp.user_id
    `).all(), [
      { legacy_schedule_slot_id: activeSlotId, user_id: userId },
      { legacy_schedule_slot_id: activeSlotId, user_id: participantId },
      { legacy_schedule_slot_id: archivedSlotId, user_id: participantId },
    ]);
    assert.deepEqual(afterFirst.prepare(`
      SELECT p.legacy_schedule_slot_id, pr.revision,
             json_valid(pr.snapshot_json) AS snapshot_valid,
             json_extract(pr.snapshot_json, '$.legacy_schedule_slot_id') AS snapshot_slot_id,
             pr.change_note
        FROM meal_plan_revisions pr
        JOIN meal_plans p ON p.id = pr.meal_plan_id
       ORDER BY p.legacy_schedule_slot_id
    `).all(), [
      {
        legacy_schedule_slot_id: activeSlotId,
        revision: 4,
        snapshot_valid: 1,
        snapshot_slot_id: activeSlotId,
        change_note: 'Compatibility snapshot from migration 10015.',
      },
      {
        legacy_schedule_slot_id: archivedSlotId,
        revision: 2,
        snapshot_valid: 1,
        snapshot_slot_id: archivedSlotId,
        change_note: 'Compatibility snapshot from migration 10015.',
      },
    ]);

    assert.deepEqual(afterFirst.prepare(`
      SELECT meal_plan_id, meal_plan_revision_id, meal_plan_rule_id,
             planning_context_id, user_modified
        FROM meals WHERE id = ?
    `).get(mealId), {
      meal_plan_id: null,
      meal_plan_revision_id: null,
      meal_plan_rule_id: null,
      planning_context_id: null,
      user_modified: 0,
    });
    assert.deepEqual(afterFirst.prepare(`
      SELECT beneficiary_user_id, entered_by_user_id, entered_by_device_key
        FROM meal_selection_responses WHERE obligation_id = ?
    `).get(obligationId), {
      beneficiary_user_id: participantId,
      entered_by_user_id: userId,
      entered_by_device_key: null,
    });
    assert.equal(afterFirst.prepare(`
      SELECT item_type FROM meal_selection_response_items WHERE obligation_id = ? AND position = 0
    `).get(obligationId).item_type, 'entree');
    assert.deepEqual(afterFirst.prepare(`
      SELECT id, enabled, default_shopping_list_id, auto_create_grocery_draft,
             auto_finalize_grocery, grocery_lead_minutes, aggregation_mode,
             updated_by, updated_at
        FROM meal_grocery_settings WHERE id = 1
    `).get(), {
      id: 1,
      enabled: 0,
      default_shopping_list_id: shoppingListId,
      auto_create_grocery_draft: 0,
      auto_finalize_grocery: 1,
      grocery_lead_minutes: 1440,
      aggregation_mode: 'ingredient',
      updated_by: userId,
      updated_at: '2031-12-03T08:14:00Z',
    });
    assert.deepEqual(afterFirst.prepare(`
      SELECT timing_mode, draft_weekday, draft_time,
             finalization_weekday, finalization_time, grouping_mode
        FROM meal_grocery_settings WHERE id = 1
    `).get(), {
      timing_mode: 'weekly',
      draft_weekday: 5,
      draft_time: '09:00',
      finalization_weekday: 6,
      finalization_time: '09:00',
      grouping_mode: 'ingredient',
    });
    assert.deepEqual(afterFirst.prepare(`
      SELECT default_cook_strategy, default_supervisor_strategy
        FROM meal_plan_default_settings WHERE id = 1
    `).get(), {
      default_cook_strategy: 'round_robin',
      default_supervisor_strategy: 'none',
    });
    assert.equal(afterFirst.prepare('SELECT event_kind FROM calendar_events WHERE id = ?').get(eventId).event_kind, 'general');
    assert.deepEqual(afterFirst.prepare(`
      SELECT planning_context_id, calendar_event_id FROM trip_plans WHERE id = ?
    `).get(tripId), { planning_context_id: null, calendar_event_id: null });
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM planning_contexts').get().n, 0);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM calendar_travel_details').get().n, 0);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_occurrence_assignments').get().n, 0);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM meal_person_decisions').get().n, 0);

    assert.deepEqual(afterFirst.pragma('foreign_key_check'), []);
    assert.deepEqual(afterFirst.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    const migratedColumns = captureColumns(
      afterFirst,
      [...compatibilityFixtureTables, ...compatibilityBackfillTables],
    );
    const firstFixtureState = captureRows(afterFirst, migratedColumns);
    afterFirst.close();

    const secondLog = runRealMigrator(databasePath);
    assert.doesNotMatch(secondLog, /Migration \d+ applied:/, 'a second start must not apply any migration');

    const afterSecond = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(
      afterSecond.prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version').all(),
      firstHistory,
      'the second start leaves the complete migration history untouched',
    );
    assert.deepEqual(
      captureRows(afterSecond, migratedColumns),
      firstFixtureState,
      'a second start leaves all legacy records and compatibility backfill rows untouched',
    );
    assert.deepEqual(
      afterSecond.prepare(`
        SELECT * FROM assignment_rotation_state WHERE rotation_key = 'meal:migration-cooks:chooser'
      `).get(),
      cursorBefore,
      'the second start also leaves the household cursor byte-for-byte unchanged',
    );
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
    assert.deepEqual(afterSecond.pragma('foreign_key_check'), []);
    assert.deepEqual(afterSecond.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    afterSecond.close();
  } finally {
    // Windows can retain the SQLite directory handle for a few milliseconds
    // after the one-shot child migrator exits. Retry cleanup instead of turning
    // a fully successful migration proof into an EPERM test failure.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // Some managed Windows test hosts deny directory removal to the Node
      // child token even though the proof database was created and closed by
      // that same token. This is cleanup-only; never suppress another platform
      // or error code because those can signal a real resource leak.
      if (!(process.platform === 'win32' && err?.code === 'EPERM')) throw err;
    }
  }
});

test('migration 10022 preserves an existing Meal or Recipe grocery grouping preference', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      CREATE TABLE meal_grocery_settings (
        id INTEGER PRIMARY KEY,
        aggregation_mode TEXT NOT NULL
      );
      INSERT INTO meal_grocery_settings (id, aggregation_mode) VALUES (1, 'recipe');
      CREATE TABLE meal_plan_default_settings (id INTEGER PRIMARY KEY);
      INSERT INTO meal_plan_default_settings (id) VALUES (1);
    `);
    const migration = FORK_MIGRATIONS.find((candidate) => candidate.version === 10022);
    assert.ok(migration);
    applyMigration(database, migration);
    assert.equal(database.prepare(`
      SELECT grouping_mode FROM meal_grocery_settings WHERE id = 1
    `).get().grouping_mode, 'recipe');
  } finally {
    database.close();
  }
});
