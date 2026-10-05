/** Internal canonical reads. Never serialize these records before authorizing
 * each note: the membership list includes notes hidden from the caller. */
export function readGroupMembers(d,groupId) {
  return d.prepare('SELECT note_id FROM note_group_members WHERE group_id=? ORDER BY ordinal,note_id').all(groupId).map(row=>row.note_id);
}

export function readNoteGroup(d,noteId) {
  return d.prepare(`SELECT g.* FROM note_groups g JOIN note_group_members m ON m.group_id=g.id WHERE m.note_id=?`).get(noteId);
}

export function groupLayout(group) {
  const {x,y,width,height,position_locked,always_on_top}=group;
  return {x,y,width,height,position_locked:Boolean(position_locked),always_on_top:Boolean(always_on_top)};
}
