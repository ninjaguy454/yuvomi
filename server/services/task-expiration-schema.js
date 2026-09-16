/** Add a real terminal status while preserving all rows, references and triggers.
 * The migration runner disables foreign keys outside its atomic transaction. */
export function addTaskExpirationSchema(d) {
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  const original = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  const expanded = original.replace(/CHECK\s*\(status\s+IN\s*\(([^)]+)\)\)/i,
    (_all, states) => `CHECK(status IN (${states}, 'expired'))`);
  if (expanded === original) throw new Error('Task status constraint was not found; refusing an incomplete migration.');
  const indexes = d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL").all();
  // Other tables' triggers can reference tasks during ALTER TABLE validation.
  const triggers = d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  const sequence = d.prepare("SELECT seq FROM sqlite_sequence WHERE name='tasks'").get()?.seq || 0;
  const legacy = d.pragma('legacy_alter_table', {simple:true});
  try {
    d.pragma('legacy_alter_table=ON');
    for (const trigger of triggers) d.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    d.exec(expanded.replace(/^CREATE TABLE\s+(?:"tasks"|tasks)/i, 'CREATE TABLE tasks_expiration_new'));
    d.exec('INSERT INTO tasks_expiration_new SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_expiration_new RENAME TO tasks;');
    d.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tasks'").run(sequence);
    for (const index of indexes) d.exec(index.sql);
    for (const trigger of triggers) d.exec(trigger.sql);
  } finally { d.pragma(`legacy_alter_table=${legacy ? 'ON' : 'OFF'}`); }
  d.exec(`ALTER TABLE tasks ADD COLUMN expiration_policy TEXT NOT NULL DEFAULT 'keep_overdue'
      CHECK(expiration_policy IN ('keep_overdue','expire_incomplete'));
    ALTER TABLE tasks ADD COLUMN expired_at TEXT;
    ALTER TABLE tasks ADD COLUMN start_time TEXT;
    ALTER TABLE activity_templates ADD COLUMN expiration_policy TEXT NOT NULL DEFAULT 'keep_overdue'
      CHECK(expiration_policy IN ('keep_overdue','expire_incomplete'));
    CREATE INDEX idx_tasks_expiration_pending ON tasks(due_date,due_time)
      WHERE expiration_policy='expire_incomplete' AND status IN ('open','in_progress') AND archived_at IS NULL;
    CREATE TRIGGER trg_tasks_expiration_revision AFTER UPDATE OF expiration_policy,expired_at,start_time ON tasks
      WHEN NEW.expiration_policy IS NOT OLD.expiration_policy OR NEW.expired_at IS NOT OLD.expired_at
        OR NEW.start_time IS NOT OLD.start_time
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;
  `);
}
