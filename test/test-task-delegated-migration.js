import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'delegated-migration-fixture';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { reconcileTaskSupervision } = await import('../server/services/task-supervision.js');

function migrateFixture(d, through) {
  d.pragma('foreign_keys=ON');
  d.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  for (const migration of ALL_MIGRATIONS.filter(item => item.version <= through)) {
    typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
    migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version, migration.description);
  }
}
function seed(d) {
  const addUser = (name, role, family) => Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
    VALUES(?,?,'x',?,?)`).run(name, name, role, family).lastInsertRowid);
  const creator = addUser('Creator', 'admin', 'parent'), learner = addUser('Frank', 'member', 'child'), helper = addUser('Duane', 'member', 'parent');
  const skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washing Machine',0,'normal',?)").run(creator).lastInsertRowid);
  for (const [user, value] of [[creator, 'excluded'], [learner, 'excluded'], [helper, 'normal']]) d.prepare(`
    INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)`).run(user, skill, value, creator);
  const makeTask = (title, parent, assignee, status = 'open') => Number(d.prepare(`
    INSERT INTO tasks(title,description,parent_task_id,assigned_to,status,created_by,start_date,due_date,due_time,points)
    VALUES(?,'Keep instructions',?,?,?,?, '2026-09-14','2026-09-14','12:00',?)`).run(title, parent, assignee, status, creator, parent == null ? 19 : 0).lastInsertRowid);
  const source = makeTask("Frank's Laundry", null, learner), current = makeTask('Load washer', source, null);
  const historical = makeTask('Previously supervised wash', source, null, 'done');
  const support = makeTask("Supervise Frank's Laundry", source, null);
  const currentProjection = makeTask('Supervise: Load washer', support, null);
  const historicalProjection = makeTask('Supervise: Previously supervised wash', support, helper, 'done');
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY;BYDAY=MO' WHERE id=?").run(source);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(source, learner);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(historicalProjection, helper);
  d.prepare('INSERT INTO task_activity_support_tasks(source_task_id,task_id) VALUES(?,?)').run(source, support);
  for (const [action, counterpart, supervisor, state] of [[current, currentProjection, null, 'excluded'], [historical, historicalProjection, helper, 'assigned']]) {
    d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(?,?)').run(action, skill);
    d.prepare(`INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,
      required_skill_ids_json,state,reason) VALUES(?,?,?,?,?,?,?,'Keep original explanation')`).run(source, action, counterpart, learner, supervisor, JSON.stringify([skill]), state);
  }
  d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'completed',?)")
    .run(source, historical, helper, JSON.stringify({ title: 'Previously supervised wash', source: 'historical fixture' }));
  d.prepare('INSERT INTO task_completions(task_id,series_id,user_id) VALUES(?,?,?)').run(historical, source, helper);
  d.prepare("INSERT INTO task_comments(task_id,user_id,comment) VALUES(?,?,'Keep the existing discussion')").run(source, learner);
  const document = Number(d.prepare(`INSERT INTO family_documents(name,original_name,mime_type,file_size,content_data,created_by)
    VALUES('Instructions','instructions.txt','text/plain',4,'a2VlcA==',?)`).run(creator).lastInsertRowid);
  d.prepare('INSERT INTO task_documents(task_id,document_id,created_by) VALUES(?,?,?)').run(source, document, creator);
  const template = Number(d.prepare("INSERT INTO activity_templates(name,title_template,subject_required) VALUES('Laundry','Laundry',0)").run().lastInsertRowid);
  const item = Number(d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES(?,'Load washer')").run(template).lastInsertRowid);
  return { source, current, historical, support, currentProjection, historicalProjection, learner, helper, creator, template, item };
}
const preservedTables = ['tasks', 'task_assignments', 'task_supervision_actions', 'task_activity_support_tasks',
  'task_skill_requirements', 'task_activity_events', 'task_completions', 'task_comments', 'task_documents',
  'family_documents', 'task_responsibilities', 'planning_obligations', 'planning_obligation_events', 'notification_inbox', 'task_change_clock'];
function capture(d) { return Object.fromEntries(preservedTables.map(name => [name, d.prepare(`SELECT * FROM ${name}`).all()])); }
function startup(path) {
  const env = { ...process.env, DB_PATH: path, TZ: 'America/New_York', LOG_LEVEL: 'info' }; delete env.DB_ENCRYPTION_KEY;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./server/db.js");'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

test('supported startup upgrades populated schema 10032 once to 10033 and restart preserves the entire migration ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vidamia-delegated-migration-')), path = join(directory, 'fixture.db');
  let d;
  try {
    d = new Database(path); migrateFixture(d, 10032); const ids = seed(d);
    const before = capture(d), ledgerBefore = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(ledgerBefore.at(-1).version, 10032); d.close(); d = null;
    const output = startup(path);
    assert.deepEqual([...output.matchAll(/Migration (\d+) applied:/g)].map(match => Number(match[1])), [10033]);
    d = new Database(path); d.pragma('foreign_keys=ON');
    for (const [name, rows] of Object.entries(before)) {
      const columns = rows.length ? Object.keys(rows[0]).join(',') : '*';
      assert.deepEqual(d.prepare(`SELECT ${columns} FROM ${name}`).all(), rows, name);
    }
    assert.deepEqual(d.prepare('SELECT execution_mode FROM task_supervision_actions ORDER BY id').all(),
      [{ execution_mode: 'supervised' }, { execution_mode: 'supervised' }]);
    assert.ok(d.prepare('SELECT activity_template_checklist_item_id FROM tasks').all().every(row => row.activity_template_checklist_item_id == null));
    assert.equal(d.prepare('SELECT state FROM task_supervision_actions WHERE action_task_id=?').get(ids.current).state, 'excluded', 'schema migration does not perform the operational reconciliation');
    const ledger = d.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(ledger.filter(row => row.version <= 10032), ledgerBefore); assert.equal(ledger.length, ledgerBefore.length + 1);
    assert.throws(() => d.prepare("UPDATE task_supervision_actions SET execution_mode='learner' WHERE action_task_id=?").run(ids.current), /CHECK/);
    const migrated = capture(d); d.close(); d = null;
    const restarted = startup(path); assert.doesNotMatch(restarted, /Migration \d+ applied:/);
    d = new Database(path);
    assert.deepEqual(d.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledger);
    assert.deepEqual(capture(d), migrated); assert.deepEqual(d.pragma('foreign_key_check'), []);
    assert.equal(d.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 10033);
  } finally {
    d?.close();
    assert.equal(dirname(resolve(path)), resolve(directory));
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nullable template provenance never destroys occurrence work or historical evidence when a definition is removed', () => {
  const d = new Database(':memory:');
  try {
    migrateFixture(d, 10033); const ids = seed(d);
    d.prepare('UPDATE tasks SET activity_template_checklist_item_id=? WHERE id=?').run(ids.item, ids.current);
    d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'template_action_created',?)")
      .run(ids.source, ids.current, ids.creator, JSON.stringify({ activity_template_id: ids.template, activity_template_checklist_item_id: ids.item }));
    const before = capture(d), currentBefore = d.prepare('SELECT * FROM tasks WHERE id=?').get(ids.current);
    assert.throws(() => d.prepare('UPDATE tasks SET activity_template_checklist_item_id=987654 WHERE id=?').run(ids.current), /FOREIGN KEY/);
    d.prepare('DELETE FROM activity_template_checklist_items WHERE id=?').run(ids.item);
    const current = d.prepare('SELECT * FROM tasks WHERE id=?').get(ids.current);
    assert.equal(current.activity_template_checklist_item_id, null); assert.ok(current.revision > currentBefore.revision);
    for (const [name, rows] of Object.entries(before)) if (!['tasks', 'task_change_clock'].includes(name)) assert.deepEqual(d.prepare(`SELECT * FROM ${name}`).all(), rows, name);
    for (const row of before.tasks) {
      const after = d.prepare('SELECT * FROM tasks WHERE id=?').get(row.id);
      for (const key of Object.keys(row).filter(key => !['revision', 'updated_at', 'activity_template_checklist_item_id'].includes(key))) assert.equal(after[key], row[key], `${row.id}.${key}`);
    }
    assert.deepEqual(d.pragma('foreign_key_check'), []);
  } finally { d.close(); }
});

test('unchanged delegated reconciliation makes zero SQLite writes including search-index triggers', () => {
  const d = new Database(':memory:');
  try {
    migrateFixture(d, 10033); const ids = seed(d); _setTestDatabase(d);
    const initial = reconcileTaskSupervision(d, ids.source);
    assert.equal(initial.supervisor_user_id, ids.helper);
    assert.equal(d.prepare('SELECT execution_mode FROM task_supervision_actions WHERE action_task_id=?').get(ids.current).execution_mode, 'delegated');
    assert.equal(d.prepare('SELECT execution_mode FROM task_supervision_actions WHERE action_task_id=?').get(ids.historical).execution_mode, 'supervised');
    const before = capture(d), writes = d.prepare('SELECT total_changes() AS n').get().n;
    assert.equal(typeof writes, 'number');
    for (let attempt = 0; attempt < 3; attempt++) reconcileTaskSupervision(d, ids.source);
    assert.equal(d.prepare('SELECT total_changes() AS n').get().n, writes);
    assert.deepEqual(capture(d), before);
  } finally { _setTestDatabase(null); d.close(); }
});
