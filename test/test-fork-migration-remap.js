import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('a live-like v10014 database applies upstream 168/169 once without replaying fork migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuvomi-v254-migration-'));
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
    for (const migration of FORK_MIGRATIONS) applyMigration(before, migration);

    const userId = Number(before.prepare(`
      INSERT INTO users (username, display_name, password_hash, role)
      VALUES ('migration-existing-user', 'Existing User', 'x', 'member')
    `).run().lastInsertRowid);
    const eventId = Number(before.prepare(`
      INSERT INTO calendar_events (title, start_datetime, end_datetime, created_by, visibility)
      VALUES ('Migration sentinel', '2032-01-01T10:00:00', '2032-01-01T11:00:00', ?, 'all')
    `).run(userId).lastInsertRowid);
    before.prepare(`
      INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
      VALUES ('event', ?, '2032-01-01T09:00:00', ?)
    `).run(eventId, userId);

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
    assert.doesNotMatch(firstLog, /Migration 100\d+ applied:/, 'released fork migrations must not replay');

    const afterFirst = new Database(databasePath, { readonly: true, fileMustExist: true });
    const firstHistory = afterFirst.prepare(`
      SELECT version, description, applied_at FROM schema_migrations ORDER BY version
    `).all();
    assert.equal(firstHistory.length, 184, 'only migrations 168 and 169 are added');
    assert.deepEqual(
      firstHistory.filter((row) => row.version !== 168 && row.version !== 169),
      originalHistory,
      'all released core/fork migration records and timestamps remain byte-for-byte logical matches',
    );
    assert.deepEqual(
      firstHistory.filter((row) => row.version === 168 || row.version === 169).map((row) => row.version),
      [168, 169],
    );
    assert.equal(afterFirst.prepare('SELECT onboarding_version FROM users WHERE id = ?').get(userId).onboarding_version, 1);
    assert.equal(afterFirst.prepare('SELECT assigned_from FROM reminders WHERE entity_type = ? AND entity_id = ?')
      .get('event', eventId).assigned_from, null);
    assert.ok(afterFirst.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_reminders_assigned_from'").get());
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
    assert.equal(afterFirst.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
    assert.equal(afterFirst.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 10014,
      'fork namespace remains the numeric maximum; direct 168/169 row checks are authoritative');
    assert.deepEqual(afterFirst.pragma('foreign_key_check'), []);
    assert.deepEqual(afterFirst.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    afterFirst.close();

    const secondLog = runRealMigrator(databasePath);
    assert.doesNotMatch(secondLog, /Migration \d+ applied:/, 'a second start must not apply any migration');

    const afterSecond = new Database(databasePath, { readonly: true, fileMustExist: true });
    assert.deepEqual(
      afterSecond.prepare('SELECT version, description, applied_at FROM schema_migrations ORDER BY version').all(),
      firstHistory,
      'the second start leaves the complete migration history untouched',
    );
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM calendar_events').get().n, 1);
    assert.equal(afterSecond.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
    assert.deepEqual(afterSecond.pragma('foreign_key_check'), []);
    assert.deepEqual(afterSecond.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    afterSecond.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
