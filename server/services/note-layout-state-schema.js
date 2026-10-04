/** Append-only migration 10051. Copy rows before restoring any layout triggers
 * so rebuilding the table never changes the Notes clock or layout revisions. */
export function addNoteLayoutStateSchema(d) {
  const columns=d.prepare('PRAGMA table_info(note_layouts)').all();
  if(['position_locked','always_on_top'].every(name=>columns.some(c=>c.name===name)))return;
  d.transaction(()=>{
    const objects=d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='note_layouts' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
    d.exec(`
      CREATE TABLE note_layouts_new(note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 10000), y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 10000),
        width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12), height INTEGER NOT NULL CHECK(height BETWEEN 4 AND 100),
        revision INTEGER NOT NULL DEFAULT 1,
        position_locked INTEGER NOT NULL DEFAULT 0 CHECK(position_locked IN (0,1)),
        always_on_top INTEGER NOT NULL DEFAULT 0 CHECK(always_on_top IN (0,1)));
      INSERT INTO note_layouts_new(note_id,x,y,width,height,revision) SELECT note_id,x,y,width,height,revision FROM note_layouts;
      DROP TABLE note_layouts;
      ALTER TABLE note_layouts_new RENAME TO note_layouts;
    `);
    for(const {sql} of objects)d.exec(sql);
  })();
}
