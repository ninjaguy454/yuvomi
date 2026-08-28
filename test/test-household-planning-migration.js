import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { ALL_MIGRATIONS } = await import('../server/db.js');
const planningMigration = ALL_MIGRATIONS.find((migration) => migration.version === 10006);

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

test('Phase 2 planning migration preserves meals and adds stable planning foundations', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const migration of ALL_MIGRATIONS) {
    if (migration.version >= planningMigration.version) continue;
    apply(database, migration);
  }

  const userId = Number(database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('planner','Planner','x','admin')").run().lastInsertRowid);
  const mealId = Number(database.prepare("INSERT INTO meals (date, meal_type, title, created_by) VALUES ('2026-08-31','dinner','Legacy dinner',?)").run(userId).lastInsertRowid);

  apply(database, planningMigration);

  const meal = database.prepare('SELECT * FROM meals WHERE id = ?').get(mealId);
  assert.equal(meal.title, 'Legacy dinner');
  assert.equal(meal.scope, 'household');
  assert.equal(meal.source, 'manual');
  assert.equal(JSON.parse(meal.provenance_json).legacy_meal_id, mealId);

  assert.deepEqual(
    database.prepare('SELECT meal_type FROM meal_timing_defaults ORDER BY meal_type').all().map((row) => row.meal_type),
    ['breakfast', 'dinner', 'lunch', 'snack'],
  );
  for (const table of [
    'household_variable_definitions', 'meal_schedule_slots', 'meal_schedule_slot_participants',
    'meal_schedule_exceptions', 'meal_participants', 'planning_obligations',
  ]) {
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
  }
  const workflowColumns = database.prepare('PRAGMA table_info(workflow_variable_definitions)').all().map((row) => row.name);
  assert.ok(workflowColumns.includes('reusable_definition_id'));
  database.close();
});
