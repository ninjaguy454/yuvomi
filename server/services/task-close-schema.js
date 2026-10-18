/** Preserve old rows, identities, references and triggers while adding a real terminal state. */
export function addTaskCloseSchema(d) {
  const quote=name=>`"${name.replaceAll('"','""')}"`;
  const original=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  const expanded=original.replace(/CHECK\s*\(status\s+IN\s*\(([^)]+)\)\)/i,(_all,states)=>`CHECK(status IN (${states}, 'closed_incomplete'))`);
  if(expanded===original)throw new Error('Task status constraint missing; refusing incomplete closure migration.');
  const indexes=d.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL").all();
  const triggers=d.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
  const sequence=d.prepare("SELECT seq FROM sqlite_sequence WHERE name='tasks'").get()?.seq||0;
  const legacy=d.pragma('legacy_alter_table',{simple:true});
  try {
    d.pragma('legacy_alter_table=ON');
    for(const trigger of triggers)d.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    d.exec(expanded.replace(/^CREATE TABLE\s+(?:"tasks"|tasks)/i,'CREATE TABLE tasks_close_new'));
    d.exec('INSERT INTO tasks_close_new SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_close_new RENAME TO tasks;');
    d.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tasks'").run(sequence);
    for(const index of indexes)d.exec(index.sql);
    for(const trigger of triggers)d.exec(trigger.sql);
  } finally {d.pragma(`legacy_alter_table=${legacy?'ON':'OFF'}`);}
  d.exec(`ALTER TABLE tasks ADD COLUMN closed_incomplete_at TEXT;
    CREATE TABLE task_incomplete_closures (
      task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      first_closed_at TEXT NOT NULL,
      recurrence_closed_at TEXT,
      recurrence_handled INTEGER NOT NULL DEFAULT 0 CHECK(recurrence_handled IN (0,1)));
    CREATE TABLE task_close_receipts (
      principal_key TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('close','reopen')),created_at TEXT NOT NULL,
      PRIMARY KEY(principal_key,operation_id));
    CREATE INDEX idx_task_close_receipts_task ON task_close_receipts(task_id);
    CREATE TRIGGER trg_tasks_close_revision AFTER UPDATE OF closed_incomplete_at ON tasks
      WHEN NEW.closed_incomplete_at IS NOT OLD.closed_incomplete_at
      BEGIN UPDATE tasks SET revision=revision+1 WHERE id=NEW.id; END;
  `);
}
