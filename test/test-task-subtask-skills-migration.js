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
test('10028 upgrades once to10029 without modifying existing Tasks, activities or skill requirements', () => {
  assert.equal(FORK_MIGRATIONS.filter((migration) => migration.version === 10029).length, 1);
  const directory = mkdtempSync(join(tmpdir(), 'yuvomi-task-skills-migration-'));
  const path = join(directory, 'fixture.db');
  let d;
  try {
    d = new Database(path); d.pragma('foreign_keys=ON');
    d.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
    for (const migration of ALL_MIGRATIONS.filter((item) => item.version <= 10028)) {
      if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
      migration.afterUp?.(d);
      d.prepare('INSERT INTO schema_migrations(version,description) VALUES (?,?)').run(migration.version, migration.description);
    }
    const userId = Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES ('migration','Migration','x','admin')").run().lastInsertRowid);
    const taskId = Number(d.prepare("INSERT INTO tasks(title,description,priority,points,created_by) VALUES ('Existing Task','Keep instructions','high',12,?)").run(userId).lastInsertRowid);
    const childId = Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by) VALUES ('Existing subtask',?,?)").run(taskId, userId).lastInsertRowid);
    const skillId = Number(d.prepare("INSERT INTO skills(name) VALUES ('Existing skill')").run().lastInsertRowid);
    const activityId = Number(d.prepare("INSERT INTO activity_templates(name,title_template) VALUES ('Existing template','Existing {subject}')").run().lastInsertRowid);
    d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES (?,?)').run(activityId, skillId);
    d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES (?,'Existing checklist')").run(activityId);
    const tasksBefore = d.prepare('SELECT * FROM tasks WHERE id IN (?,?) ORDER BY id').all(taskId, childId);
    const activityBefore = d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId);
    const requirementsBefore = d.prepare('SELECT * FROM activity_template_skills WHERE activity_template_id=?').all(activityId);
    const historyBefore = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    d.close(); d = null;
    const first = startup(path);
    assert.deepEqual([...first.matchAll(/Migration (\d+) applied:/g)].map((match) => Number(match[1])),
      ALL_MIGRATIONS.filter((migration) => migration.version > 10028).map((migration) => migration.version));
    d = new Database(path); d.pragma('foreign_keys=ON');
    const oldTaskColumns=Object.keys(tasksBefore[0]).join(',');
    assert.deepEqual(d.prepare(`SELECT ${oldTaskColumns} FROM tasks WHERE id IN (?,?) ORDER BY id`).all(taskId, childId), tasksBefore);
    assert.deepEqual(d.prepare('SELECT revision,sort_order FROM tasks WHERE id IN (?,?) ORDER BY id').all(taskId,childId),
      [{revision:1,sort_order:0},{revision:1,sort_order:0}]);
    assert.deepEqual(d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityId), {
      ...activityBefore, priority: 'none', points: 0, tags_json: '[]',
    });
    assert.deepEqual(d.prepare('SELECT * FROM activity_template_skills WHERE activity_template_id=?').all(activityId), requirementsBefore);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM task_skill_requirements').get().n, 0);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM activity_template_checklist_skills').get().n, 0);
    const historyAfter = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(historyAfter.filter((item) => item.version <= 10028), historyBefore);
    d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES (?,?)').run(childId, skillId);
    assert.throws(() => d.prepare('DELETE FROM skills WHERE id=?').run(skillId), /FOREIGN KEY/);
    const requirementsAfter = d.prepare('SELECT * FROM task_skill_requirements').all();
    d.close(); d = null;
    const restart = startup(path);
    assert.doesNotMatch(restart, /Migration \d+ applied:/);
    d = new Database(path);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), historyAfter);
    assert.deepEqual(d.prepare('SELECT * FROM task_skill_requirements').all(), requirementsAfter);
    assert.deepEqual(d.pragma('foreign_key_check'), []);
  } finally { d?.close(); rmSync(directory, { recursive: true, force: true }); }
});
