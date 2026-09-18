import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'template-offset-migration-test';
const { ALL_MIGRATIONS } = await import('../server/db.js');

test('10036 encrypted production-shaped schedules gain relative offsets at10037 and series at10038 without replay', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'activity-template-offset-'));
  const databasePath = path.join(directory, 'database.db');
  const key = randomBytes(32).toString('hex');
  const open = (options = {}) => {
    const database = new Database(databasePath, options);
    database.pragma("cipher='sqlcipher'");
    database.pragma(`key="x'${Buffer.from(key).toString('hex')}'"`);
    return database;
  };
  try {
    const d = open();
    d.pragma('foreign_keys=ON');
    d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT '2026-09-17T00:00:00Z')");
    for (const migration of ALL_MIGRATIONS.filter(row => row.version <= 10036)) {
      if (migration.foreignKeysOff) d.pragma('foreign_keys=OFF');
      d.transaction(() => {
        typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
        migration.afterUp?.(d);
        d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version, migration.description);
      })();
      if (migration.foreignKeysOff) d.pragma('foreign_keys=ON');
    }
    d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'parent','Parent','x','admin')").run();
    d.prepare(`INSERT INTO activity_templates(id,name,title_template,created_by,start_time,due_time,recurrence_rule,expiration_policy,points)
      VALUES(1,'Morning','Morning',1,'07:00','08:00','FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR','expire_incomplete',2)`).run();
    d.prepare("INSERT INTO activity_templates(id,name,title_template,created_by) VALUES(2,'Untimed','Untimed',1)").run();
    d.prepare("INSERT INTO activity_templates(id,name,title_template,created_by,due_time) VALUES(3,'Due only','Due only',1,'17:00')").run();
    d.prepare("INSERT INTO activity_templates(id,name,title_template,created_by,start_time) VALUES(4,'Start only','Start only',1,'07:00')").run();
    d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template,sort_order,is_optional) VALUES(1,'Earrings',0,1)").run();
    d.prepare("INSERT INTO tasks(id,title,created_by,start_date,start_time,due_date,due_time) VALUES(1,'Existing occurrence',1,'2026-09-21','07:00','2026-09-21','08:00')").run();
    const original = d.prepare('SELECT * FROM activity_templates ORDER BY id').all();
    const templateColumns = d.pragma('table_info(activity_templates)').map(column => column.name);
    const taskColumns = d.pragma('table_info(tasks)').map(column => column.name);
    const taskBefore = d.prepare('SELECT * FROM tasks WHERE id=1').get();
    const originalHistory = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    d.close();
    const withoutKey = new Database(databasePath, { readonly: true });
    assert.throws(() => withoutKey.prepare('SELECT * FROM schema_migrations').all());
    withoutKey.close();

    const boot = () => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const db=await import('./server/db.js');db.init();console.log('SCHEMA',db.currentVersion());db.get().close();"], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60000,
        env: { ...process.env, DB_PATH: databasePath, DB_ENCRYPTION_KEY: key, NODE_ENV: 'test' },
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      return child.stdout + child.stderr;
    };
    const first = boot();
    assert.deepEqual([...first.matchAll(/Migration (\d+) applied:/g)].map(row => Number(row[1])), [10037,10038]);
    const migrated = open({ readonly: true });
    const after = migrated.prepare('SELECT * FROM activity_templates ORDER BY id').all();
    for (let index = 0; index < original.length; index++) {
      for (const [key, value] of Object.entries(original[index])) assert.deepEqual(after[index][key], value, key);
    }
    assert.deepEqual(after.map(row => row.due_date_offset_days), [0, null, 0, 0]);
    assert.deepEqual(migrated.pragma('table_info(activity_templates)').map(column => column.name), [...templateColumns, 'due_date_offset_days']);
    assert.deepEqual(migrated.pragma('table_info(tasks)').map(column => column.name), [...taskColumns, 'due_date_offset_days']);
    assert.deepEqual(migrated.prepare('SELECT * FROM tasks WHERE id=1').get(), { ...taskBefore, due_date_offset_days: null });
    assert.equal(migrated.prepare('SELECT is_optional FROM activity_template_checklist_items').get().is_optional, 1);
    const history = migrated.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(history.filter(row => row.version <= 10036), originalHistory);
    assert.equal(history.length, originalHistory.length + 2);
    assert.equal(migrated.prepare('SELECT COUNT(*) n FROM task_recurrence_series').get().n,0,'non-recurring Tasks gain no series');
    assert.equal(migrated.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(migrated.pragma('foreign_key_check'), []);
    migrated.close();
    assert.doesNotMatch(boot(), /Migration \d+ applied:/);
    const restarted = open({ readonly: true });
    assert.deepEqual(restarted.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), history);
    restarted.close();
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('activity-template-offset-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
