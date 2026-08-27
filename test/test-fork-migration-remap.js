import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
process.env.DB_PATH = ':memory:';
process.env.TZ = 'UTC';
const { remapForkMigrationVersions } = await import('../server/db.js');
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
