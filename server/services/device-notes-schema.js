/** Preserve Notes and search triggers while allowing an explicit device author.
 * No rights or existing author values change. Old readers accept the nullable
 * member author through their existing LEFT JOIN. */
export function addDeviceNotesSchema(d) {
  if(d.pragma('table_info(notes)').some(row=>row.name==='created_by_device'))return;
  const original=d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notes'").get().sql;
  const artifacts=d.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='notes' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  const sequence=d.prepare("SELECT seq FROM sqlite_sequence WHERE name='notes'").get()?.seq;
  const revised=original.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?notes["`]?/i,'CREATE TABLE notes_device_upgrade')
    .replace(/(created_by\s+INTEGER)\s+NOT NULL/i,'$1')
    .replace(/\)\s*$/,', created_by_device INTEGER REFERENCES household_devices(id) ON DELETE SET NULL)');
  if(revised===original||/created_by\s+INTEGER\s+NOT NULL/i.test(revised))throw new Error('Unexpected Notes schema');
  d.exec(revised);
  d.exec('INSERT INTO notes_device_upgrade(id,title,content,color,pinned,created_by,created_at,updated_at) SELECT id,title,content,color,pinned,created_by,created_at,updated_at FROM notes');
  d.exec('DROP TABLE notes; ALTER TABLE notes_device_upgrade RENAME TO notes');
  for(const artifact of artifacts)d.exec(artifact.sql);
  if(sequence!==undefined)d.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='notes'").run(sequence);
}
