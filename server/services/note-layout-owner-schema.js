/** Append-only migration 10053. Legacy arrangements remain the immutable seed.
 * Deferred owner references let first-write initialization copy all child rows
 * before inserting the owner marker; seed copies therefore do not invalidate
 * the board clock. Normal arrangement writes always have that marker. */
export function addNoteLayoutOwnerSchema(d) {
  d.transaction(()=>{
    d.exec(`
      CREATE TABLE IF NOT EXISTS note_board_owners(
        owner_key TEXT NOT NULL PRIMARY KEY,
        next_group_id INTEGER NOT NULL CHECK(next_group_id>=1));
      CREATE TABLE IF NOT EXISTS note_board_note_layouts(
        owner_key TEXT NOT NULL REFERENCES note_board_owners(owner_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 10000), y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 10000),
        width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12), height INTEGER NOT NULL CHECK(height BETWEEN 4 AND 100),
        revision INTEGER NOT NULL DEFAULT 1,
        position_locked INTEGER NOT NULL DEFAULT 0 CHECK(position_locked IN (0,1)),
        always_on_top INTEGER NOT NULL DEFAULT 0 CHECK(always_on_top IN (0,1)),
        PRIMARY KEY(owner_key,note_id));
      CREATE INDEX IF NOT EXISTS idx_note_board_note_layouts_note ON note_board_note_layouts(note_id,owner_key);
      CREATE TABLE IF NOT EXISTS note_board_groups(
        owner_key TEXT NOT NULL REFERENCES note_board_owners(owner_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        id INTEGER NOT NULL CHECK(id>=1), revision INTEGER NOT NULL DEFAULT 1,
        x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 10000), y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 10000),
        width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12), height INTEGER NOT NULL CHECK(height BETWEEN 4 AND 100),
        position_locked INTEGER NOT NULL DEFAULT 0 CHECK(position_locked IN (0,1)),
        always_on_top INTEGER NOT NULL DEFAULT 0 CHECK(always_on_top IN (0,1)),
        PRIMARY KEY(owner_key,id));
      CREATE TABLE IF NOT EXISTS note_board_group_members(
        owner_key TEXT NOT NULL REFERENCES note_board_owners(owner_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
        PRIMARY KEY(owner_key,note_id), UNIQUE(owner_key,group_id,ordinal),
        FOREIGN KEY(owner_key,group_id) REFERENCES note_board_groups(owner_key,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_note_board_group_members_note ON note_board_group_members(note_id,owner_key);
      CREATE TABLE IF NOT EXISTS note_board_group_receipts(
        owner_key TEXT NOT NULL REFERENCES note_board_owners(owner_key) ON DELETE CASCADE,
        principal_key TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        PRIMARY KEY(owner_key,principal_key,operation_id));
    `);
    const changes={
      note_board_note_layouts:['owner_key','note_id','x','y','width','height','position_locked','always_on_top'],
      note_board_groups:['owner_key','id','x','y','width','height','position_locked','always_on_top'],
      note_board_group_members:['owner_key','note_id','group_id','ordinal'],
    };
    for(const [table,fields] of Object.entries(changes))for(const op of ['INSERT','UPDATE','DELETE']){
      const row=op==='DELETE'?'OLD':'NEW';
      const changed=op==='UPDATE'?` AND (${fields.map(field=>`NEW.${field} IS NOT OLD.${field}`).join(' OR ')})`:'';
      d.exec(`CREATE TRIGGER IF NOT EXISTS trg_${table}_board_${op.toLowerCase()} AFTER ${op} ON ${table}
        WHEN EXISTS(SELECT 1 FROM note_board_owners WHERE owner_key=${row}.owner_key)${changed}
        BEGIN UPDATE note_change_clock SET version=version+1 WHERE id=1; END`);
    }
  })();
}
