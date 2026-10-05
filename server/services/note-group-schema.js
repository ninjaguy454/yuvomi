/** Append-only migration 10052. Group geometry is independent of every member's
 * compatibility layout. Receipts contain structural snapshots, never content. */
export function addNoteGroupSchema(d) {
  d.transaction(()=>{
    d.exec(`
      CREATE TABLE IF NOT EXISTS note_groups(
        id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL DEFAULT 1,
        x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 10000), y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 10000),
        width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12), height INTEGER NOT NULL CHECK(height BETWEEN 4 AND 100),
        position_locked INTEGER NOT NULL DEFAULT 0 CHECK(position_locked IN (0,1)),
        always_on_top INTEGER NOT NULL DEFAULT 0 CHECK(always_on_top IN (0,1)));
      CREATE TABLE IF NOT EXISTS note_group_members(
        note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL REFERENCES note_groups(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0), UNIQUE(group_id,ordinal));
      CREATE TABLE IF NOT EXISTS note_group_receipts(
        principal_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY(principal_key,operation_id));
    `);
    for(const table of ['note_groups','note_group_members'])for(const op of ['INSERT','UPDATE','DELETE']){
      d.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_board_${op.toLowerCase()} AFTER ${op} ON ${table}
        BEGIN UPDATE note_change_clock SET version=version+1 WHERE id=1; END`);
    }
  })();
}
