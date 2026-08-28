import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';

const { ALL_MIGRATIONS } = await import('../server/db.js');
const identityMigration = ALL_MIGRATIONS.find((migration) => migration.version === 10005);

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
}

test('existing workflow variables receive immutable definition identities without changing their keys', () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`);
  for (const migration of ALL_MIGRATIONS) {
    if (migration.version === identityMigration.version) continue;
    applyMigration(database, migration);
  }

  const schema = [
    { key: 'legacy_person', label: 'Who is this for?', type: 'household_member' },
    { id: 'day_of_week', label: 'Day of Week', type: 'select', options: ['Monday', 'Tuesday'] },
  ];
  const workflowId = Number(database.prepare(`
    INSERT INTO workflow_templates (
      name, description, category, quick_add_enabled, subject_required,
      input_schema_json, active
    ) VALUES ('Legacy workflow', NULL, 'misc', 1, 1, ?, 1)
  `).run(JSON.stringify(schema)).lastInsertRowid);

  applyMigration(database, identityMigration);

  const definitions = database.prepare(`
    SELECT id, variable_key, label, type, options_json, scope
      FROM workflow_variable_definitions
     WHERE workflow_template_id = ?
     ORDER BY id
  `).all(workflowId);
  assert.equal(definitions.length, 2);
  assert.ok(definitions.every((definition) => Number.isInteger(definition.id)));
  assert.deepEqual(definitions.map((definition) => definition.variable_key), ['legacy_person', 'day_of_week']);
  assert.equal(definitions[0].type, 'household_member');
  assert.equal(definitions[1].type, 'choice');
  assert.deepEqual(JSON.parse(definitions[1].options_json), ['Monday', 'Tuesday']);
  assert.ok(definitions.every((definition) => definition.scope === 'workflow'));
  assert.equal(
    database.prepare('SELECT input_schema_json FROM workflow_templates WHERE id = ?').get(workflowId).input_schema_json,
    JSON.stringify(schema),
  );
  database.close();
});
