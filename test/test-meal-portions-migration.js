import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
const { ALL_MIGRATIONS, FORK_MIGRATIONS } = await import('../server/db.js');

function apply(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
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

test('real 10027 upgrade preserves data and 10028 cannot replay on restart', () => {
  const migration = FORK_MIGRATIONS.find((item) => item.version === 10028);
  assert.ok(migration);
  assert.equal(FORK_MIGRATIONS.filter((item) => item.version === 10028).length, 1);
  assert.equal(FORK_MIGRATIONS.at(-1).version, 10028);

  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-portions-migration-'));
  const databasePath = join(directory, 'fixture.db');
  let database;
  try {
    database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`);
    for (const item of ALL_MIGRATIONS.filter((candidate) => candidate.version <= 10027)) {
      apply(database, item);
      database.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)')
        .run(item.version, item.description);
    }
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10027);
    const historyBefore = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();

    const userId = Number(database.prepare(`INSERT INTO users
      (username,display_name,password_hash,role,family_role) VALUES ('portion-migration','Portion migration','x','admin','other')`)
      .run().lastInsertRowid);
    const recipeId = Number(database.prepare(`INSERT INTO recipes(title,created_by) VALUES ('Existing recipe',?)`)
      .run(userId).lastInsertRowid);
    const authoredPipeline = JSON.stringify({ schema_version: 1, resources: [{ id: 'meal', kind: 'component', name: 'Meal' }],
      operations: [{ id: 'prepare', label: 'Prepare meal', produces: ['meal'] }] });
    database.prepare('UPDATE recipes SET execution_json=?,execution_revision=3,execution_source_hash=? WHERE id=?')
      .run(authoredPipeline, 'a'.repeat(64), recipeId);
    database.prepare("INSERT INTO recipe_ingredients(recipe_id,name,quantity,category) VALUES (?,'Flour','2 cups','Baking')")
      .run(recipeId);
    const priorRecipe = database.prepare('SELECT * FROM recipes WHERE id=?').get(recipeId);
    const priorIngredients = database.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id=?').all(recipeId);
    const mealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,recipe_id,created_by,portions)
      VALUES ('2046-01-01','dinner','Existing meal',?,?,4)`).run(recipeId, userId).lastInsertRowid);
    database.prepare("UPDATE meals SET updated_at='2045-12-01T12:00:00Z' WHERE id=?").run(mealId);
    const priorUpdatedAt = database.prepare('SELECT updated_at FROM meals WHERE id=?').get(mealId).updated_at;
    database.prepare(`INSERT INTO meal_person_decisions
      (meal_id,beneficiary_user_id,participation,choice_kind,entered_by_user_id)
      VALUES (?,?,'participating','household',?)`).run(mealId, userId, userId);
    const participatingMealId = Number(database.prepare(`INSERT INTO meals(date,meal_type,title,created_by,portions_mode,portions)
      VALUES ('2046-01-02','dinner','Existing fixed meal',?,'fixed',4)`).run(userId).lastInsertRowid);
    database.prepare(`INSERT INTO meal_participants(meal_id,user_id,role,status,source)
      VALUES (?,?,'participant','participating','manual'), (?,?,'cook','participating','manual')`)
      .run(participatingMealId, userId, participatingMealId, userId);

    database.close(); database = null;
    const firstLog = realStartup(databasePath);
    assert.deepEqual([...firstLog.matchAll(/Migration (\d+) applied:/g)].map((match) => Number(match[1])), [10028]);
    database = new Database(databasePath);
    const historyAfter = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(historyAfter.at(-1).version, 10028);
    const upgradedRecipe = database.prepare('SELECT * FROM recipes WHERE id=?').get(recipeId);
    for (const [column, value] of Object.entries(priorRecipe)) assert.equal(upgradedRecipe[column], value, `recipe.${column}`);
    assert.deepEqual(database.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id=?').all(recipeId), priorIngredients);

    assert.deepEqual(database.prepare('SELECT planned_portions,updated_at FROM meals WHERE id=?').get(mealId), {
      planned_portions: 0, updated_at: priorUpdatedAt,
    });
    assert.deepEqual(database.prepare('SELECT planned_portions,portions_mode,portions FROM meals WHERE id=?').get(participatingMealId), {
      planned_portions: 1, portions_mode: 'fixed', portions: 4,
    });
    assert.deepEqual(database.prepare(`SELECT yield_portions,serving_basis_amount FROM recipes WHERE id=?`).get(recipeId), {
      yield_portions: null, serving_basis_amount: null,
    });
    assert.deepEqual(database.prepare(`SELECT portion_amount,revision FROM meal_person_decisions WHERE meal_id=?`).get(mealId), {
      portion_amount: 1, revision: 1,
    });
    for (const [table, columns] of Object.entries({
      meals: ['planned_portions'],
      recipes: ['yield_portions', 'serving_basis_amount', 'serving_basis_unit', 'serving_basis_label'],
      meal_person_decisions: ['portion_amount', 'revision'],
      meal_grocery_item_sources: ['planned_portions_snapshot', 'cook_portions_snapshot'],
    })) {
      const present = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      for (const column of columns) assert.ok(present.has(column), `${table}.${column}`);
    }

    assert.deepEqual(
      database.prepare('SELECT * FROM schema_migrations WHERE version<10028 ORDER BY version').all(),
      historyBefore,
    );
    database.prepare('UPDATE meal_person_decisions SET portion_amount=1.25,revision=2 WHERE meal_id=?').run(mealId);
    database.prepare('UPDATE meals SET planned_portions=1.25 WHERE id=?').run(mealId);
    const beforeRestartMeal = database.prepare('SELECT * FROM meals WHERE id=?').get(mealId);
    const beforeRestartDecision = database.prepare('SELECT * FROM meal_person_decisions WHERE meal_id=?').get(mealId);
    database.close(); database = null;

    const restartLog = realStartup(databasePath);
    assert.doesNotMatch(restartLog, /Migration \d+ applied:/);
    database = new Database(databasePath);
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), historyAfter);
    assert.deepEqual(database.prepare('SELECT * FROM meals WHERE id=?').get(mealId), beforeRestartMeal);
    assert.deepEqual(database.prepare('SELECT * FROM meal_person_decisions WHERE meal_id=?').get(mealId), beforeRestartDecision);
    assert.deepEqual(database.prepare('SELECT * FROM recipes WHERE id=?').get(recipeId), upgradedRecipe);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=10028').get().count, 1);
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'cleanup stays inside the temporary directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
