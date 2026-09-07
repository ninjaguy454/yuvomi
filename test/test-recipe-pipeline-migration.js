import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
const { ALL_MIGRATIONS, FORK_MIGRATIONS } = await import('../server/db.js');

function applyMigration(database, migration) {
  if (migration.foreignKeysOff) database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      if (typeof migration.up === 'function') migration.up(database);
      else database.exec(migration.up);
      if (migration.afterUp) migration.afterUp(database);
      database.prepare('INSERT INTO schema_migrations(version, description) VALUES (?, ?)').run(migration.version, migration.description);
    })();
  } finally {
    if (migration.foreignKeysOff) database.pragma('foreign_keys = ON');
  }
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function realStartup(databasePath) {
  const env = { ...process.env, DB_PATH: databasePath, TZ: 'UTC' };
  delete env.DB_ENCRYPTION_KEY;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./server/db.js");'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, `startup failed\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('10027 follows the released fork history and adds only three recipe columns', () => {
  assert.equal(FORK_MIGRATIONS.filter(item => item.version === 10027).length, 1);
  const versions = FORK_MIGRATIONS.map(item => item.version);
  for (let i = 1; i < versions.length; i++) assert.equal(versions[i], versions[i - 1] + 1);
  const migration = FORK_MIGRATIONS.find(item => item.version === 10027);
  assert.match(migration.description, /resource execution pipelines/);
  const changes = [...migration.up.matchAll(/ALTER TABLE recipes ADD COLUMN (\w+)/g)].map(match => match[1]);
  assert.deepEqual(changes, ['execution_json', 'execution_revision', 'execution_source_hash']);
  assert.doesNotMatch(migration.up, /(?:DELETE|DROP|UPDATE|CREATE TABLE)/i);
});

test('real upgrade from 10026 preserves existing data/history through 10028 and restart cannot replay or erase authored JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-pipeline-migration-'));
  const databasePath = join(directory, 'fixture.db');
  let connection;
  try {
    connection = new Database(databasePath);
    connection.pragma('foreign_keys = ON');
    connection.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
    for (const migration of ALL_MIGRATIONS.filter(item => item.version <= 10026)) applyMigration(connection, migration);
    assert.equal(connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10026);
    const userId = connection.prepare("INSERT INTO users(username, display_name, password_hash) VALUES ('migration-owner', 'Owner', 'hash')").run().lastInsertRowid;
    const recipeId = connection.prepare("INSERT INTO recipes(title, notes, recipe_url, meal_types, created_by) VALUES ('Saved bread', 'Mix and bake.', 'https://example.test/bread', 'breakfast,snack', ?)").run(userId).lastInsertRowid;
    connection.prepare("INSERT INTO recipe_ingredients(recipe_id, name, quantity, category) VALUES (?, 'flour', '2 cups', 'Baking')").run(recipeId);
    const beforeRecipe = connection.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
    const beforeIngredients = connection.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId);
    const beforeHistory = connection.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    connection.close(); connection = null;

    const firstLog = realStartup(databasePath);
    assert.equal((firstLog.match(/Migration 10027 applied:/g) || []).length, 1);
    assert.equal((firstLog.match(/Migration 10028 applied:/g) || []).length, 1);
    assert.deepEqual([...firstLog.matchAll(/Migration (\d+) applied:/g)].map(match => Number(match[1])), [10027, 10028]);
    connection = new Database(databasePath);
    const afterHistory = connection.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(afterHistory.filter(item => item.version <= 10026), beforeHistory);
    assert.equal(afterHistory.at(-1).version, 10028);
    const afterRecipe = connection.prepare('SELECT * FROM recipes WHERE id = ?').get(recipeId);
    for (const [key, value] of Object.entries(beforeRecipe)) assert.equal(afterRecipe[key], value);
    assert.equal(afterRecipe.execution_json, null);
    assert.equal(afterRecipe.execution_revision, 0);
    assert.equal(afterRecipe.execution_source_hash, null);
    assert.deepEqual(connection.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId), beforeIngredients);
    const authored = JSON.stringify({ schema_version: 1, resources: [{ id: 'bread', kind: 'component', name: 'Bread' }], operations: [{ id: 'make', label: 'Make bread', produces: ['bread'] }] });
    connection.prepare('UPDATE recipes SET execution_json = ?, execution_revision = 4, execution_source_hash = ? WHERE id = ?').run(authored, 'a'.repeat(64), recipeId);
    connection.close(); connection = null;

    const restartLog = realStartup(databasePath);
    assert.doesNotMatch(restartLog, /Migration \d+ applied:/);
    connection = new Database(databasePath);
    assert.deepEqual(connection.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), afterHistory);
    assert.deepEqual(connection.prepare('SELECT execution_json, execution_revision, execution_source_hash FROM recipes WHERE id = ?').get(recipeId), {
      execution_json: authored, execution_revision: 4, execution_source_hash: 'a'.repeat(64),
    });
    assert.deepEqual(connection.pragma('foreign_key_check'), []);
    assert.equal(connection.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    connection?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
