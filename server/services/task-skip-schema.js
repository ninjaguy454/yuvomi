/** Rebuild the status constraint without losing IDs, references or triggers. */
export function addTaskSkipSchema(d) {
  const quote=name=>`"${name.replaceAll('"','""')}"`;
  const original=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  const expanded=original.replace(/CHECK\s*\(status\s+IN\s*\(([^)]+)\)\)/i,(_all,states)=>`CHECK(status IN (${states}, 'skipped'))`);
  if(expanded===original)throw new Error('Task status constraint missing; refusing incomplete skip migration.');
  const indexes=d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL").all();
  const triggers=d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  const sequence=d.prepare("SELECT seq FROM sqlite_sequence WHERE name='tasks'").get()?.seq||0;
  const legacy=d.pragma('legacy_alter_table',{simple:true});
  try {
    d.pragma('legacy_alter_table=ON');
    for(const trigger of triggers)d.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    d.exec(expanded.replace(/^CREATE TABLE\s+(?:"tasks"|tasks)/i,'CREATE TABLE tasks_skip_new'));
    d.exec('INSERT INTO tasks_skip_new SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_skip_new RENAME TO tasks;');
    d.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tasks'").run(sequence);
    for(const index of indexes)d.exec(index.sql);
    for(const trigger of triggers)d.exec(trigger.sql);
  } finally {d.pragma(`legacy_alter_table=${legacy?'ON':'OFF'}`);}
  d.exec(`ALTER TABLE tasks ADD COLUMN skipped_at TEXT;
    CREATE TABLE task_skip_receipts (
      principal_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY(principal_key,operation_id));
    CREATE INDEX idx_task_skip_receipts_task ON task_skip_receipts(task_id);
    CREATE TRIGGER trg_tasks_skipped_revision AFTER UPDATE OF skipped_at ON tasks
      WHEN NEW.skipped_at IS NOT OLD.skipped_at
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;
    CREATE TRIGGER trg_tasks_skipped_closed BEFORE UPDATE OF status ON tasks
      WHEN OLD.status='skipped' AND NEW.status!='skipped'
      BEGIN SELECT RAISE(ABORT,'Skipped Tasks cannot be reopened or completed.'); END;
  `);
}
