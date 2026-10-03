/** Append-only Notes audience, revision, and independent geometry persistence. */
export function addNoteBoardSchema(d) {
  if(d.prepare('PRAGMA table_info(notes)').all().some(c=>c.name==='visibility'))return;
  d.exec(`
    ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'all' CHECK(visibility IN ('all','private','selected'));
    ALTER TABLE notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE note_access(note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(note_id,user_id));
    CREATE INDEX idx_note_access_user ON note_access(user_id,note_id);
    CREATE TABLE note_layouts(note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      x INTEGER NOT NULL CHECK(x>=0), y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 10000),
      width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12 AND x+width<=12),
      height INTEGER NOT NULL CHECK(height BETWEEN 4 AND 100), revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE note_change_clock(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO note_change_clock(id) VALUES(1);
    CREATE TRIGGER trg_note_board_revision AFTER UPDATE OF title,content,color,pinned,visibility,created_by,created_by_device ON notes
      WHEN NEW.title IS NOT OLD.title OR NEW.content IS NOT OLD.content OR NEW.color IS NOT OLD.color
        OR NEW.pinned IS NOT OLD.pinned OR NEW.visibility IS NOT OLD.visibility
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_by_device IS NOT OLD.created_by_device
      BEGIN UPDATE notes SET revision=revision+1 WHERE id=NEW.id; END;
  `);
  for(const table of ['notes','note_layouts','note_access'])for(const op of ['INSERT','UPDATE','DELETE']){
    const row=op==='DELETE'?'OLD':'NEW';
    d.exec(`CREATE TRIGGER trg_${table}_board_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN
      ${table==='note_access'?`UPDATE notes SET revision=revision+1 WHERE id=${row}.note_id;`:''}
      UPDATE note_change_clock SET version=version+1 WHERE id=1; END`);
  }
}
