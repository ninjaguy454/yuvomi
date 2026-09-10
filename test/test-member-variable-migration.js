import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
const { ALL_MIGRATIONS, FORK_MIGRATIONS } = await import('../server/db.js');
function startup(path) {
  const env = { ...process.env, DB_PATH: path, TZ: 'UTC' }; delete env.DB_ENCRYPTION_KEY;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./server/db.js");'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return `${result.stdout}\n${result.stderr}`;
}

test('10029 upgrades once to10030 with null metadata/formulas and unchanged existing identities', () => {
  assert.equal(FORK_MIGRATIONS.filter(row => row.version === 10030).length, 1);
  const directory = mkdtempSync(join(tmpdir(), 'vidamia-member-variable-migration-'));
  const path = join(directory, 'fixture.db');
  let d;
  try {
    d = new Database(path); d.pragma('foreign_keys=ON');
    d.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
    for (const migration of ALL_MIGRATIONS.filter(row => row.version <= 10029)) {
      if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
      migration.afterUp?.(d);
      d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version, migration.description);
    }
    const id = Number(d.prepare("INSERT INTO users(username,display_name,password_hash) VALUES ('existing','Do not split my display name','x')").run().lastInsertRowid);
    d.prepare("INSERT INTO contacts(name,first_name,last_name,nickname,family_user_id) VALUES ('Existing contact','Address','Book','Address nick',?)").run(id);
    d.prepare("INSERT INTO household_variable_definitions(variable_key,label,type,kind,default_value_json) VALUES ('count','Count','number','value','0')").run();
    d.prepare("INSERT INTO tasks(title,created_by) VALUES ('Existing Task',?)").run(id);
    const tables = ['users', 'contacts', 'household_variable_definitions', 'workflow_variable_definitions', 'tasks',
      'recipes', 'meal_person_decisions', 'meal_grocery_runs', 'meal_grocery_items', 'meal_grocery_item_sources'];
    const before = Object.fromEntries(tables.map(table => [table, d.prepare(`SELECT * FROM ${table}`).all()]));
    const historyBefore = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    d.close(); d = null;
    assert.deepEqual([...startup(path).matchAll(/Migration (\d+) applied:/g)].map(match => Number(match[1])), [10030]);
    d = new Database(path);
    for (const table of tables) {
      const expected = before[table].map(row => table === 'users' ? { ...row, first_name: null, last_name: null, nickname: null }
        : table === 'household_variable_definitions' ? { ...row, expression_json: null } : row);
      assert.deepEqual(d.prepare(`SELECT * FROM ${table}`).all(), expected, table);
    }
    assert.ok(!d.pragma('table_info(workflow_variable_definitions)').some(column => column.name === 'expression_json'));
    const historyAfter = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(historyAfter.filter(row => row.version <= 10029), historyBefore);
    assert.deepEqual(d.pragma('foreign_key_check'), []);
    d.close(); d = null;
    assert.doesNotMatch(startup(path), /Migration \d+ applied:/);
    d = new Database(path);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), historyAfter);
  } finally { d?.close(); rmSync(directory, { recursive: true, force: true }); }
});
