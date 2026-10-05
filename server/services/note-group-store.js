import {noteError} from './note-access.js';

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

export function assertStandaloneLayoutWrite(d,noteId) {
  if(readNoteGroup(d,noteId))throw noteError('This layout has changed. Reload the board before trying again.',409);
}

/** Geometry changes and membership transitions share one monotonic layout
 * revision. The transition fence prevents an inverse from reviving an old
 * standalone snapshot even when its stored rectangle is already identical. */
export function writeNoteGroupLayout(d,noteId,layout,{forceRevision=false}={}) {
  const current=d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(noteId);
  if(current&&!forceRevision&&JSON.stringify(groupLayout(current))===JSON.stringify(groupLayout(layout)))return;
  const {x,y,width,height,position_locked,always_on_top}=layout;
  if(current)d.prepare('UPDATE note_layouts SET x=?,y=?,width=?,height=?,position_locked=?,always_on_top=?,revision=revision+1 WHERE note_id=?').run(x,y,width,height,+position_locked,+always_on_top,noteId);
  else d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?,?)').run(noteId,x,y,width,height,+position_locked,+always_on_top);
}

/** Caller owns the delete authorization and immediate transaction. Survivors
 * are internal invariant maintenance, never returned to the deleting actor. */
export function cleanupGroupsAfterNoteDeletion(d,affectedGroupIds) {
  for(const id of new Set(affectedGroupIds)){
    const group=d.prepare('SELECT * FROM note_groups WHERE id=?').get(id);if(!group)continue;
    const members=readGroupMembers(d,id);
    if(members.length<2){
      if(members.length)writeNoteGroupLayout(d,members[0],groupLayout(group),{forceRevision:true});
      d.prepare('DELETE FROM note_groups WHERE id=?').run(id);
    }else{
      // Removing a member preserves relative order; fresh dense ordinals avoid
      // uniqueness collisions without any temporary negative CHECK violations.
      d.prepare('DELETE FROM note_group_members WHERE group_id=?').run(id);
      members.forEach((noteId,ordinal)=>d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,?,?)').run(noteId,id,ordinal));
      d.prepare('UPDATE note_groups SET revision=revision+1 WHERE id=?').run(id);
    }
  }
}
