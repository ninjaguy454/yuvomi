import {noteError} from './note-access.js';
import {noteLayoutSource,ensureNoteLayoutOwner,readNoteOwnerMembership,readNoteOwnerGroup,readNoteOwnerGroupMembers,readNoteOwnerLayout} from './note-layout-owner.js';

// null is reserved for mandatory seed repair after shared content deletion.
const source=(d,key)=>key===null?{layouts:'note_layouts',groups:'note_groups',members:'note_group_members',ownerKey:null}:noteLayoutSource(d,key);
const scope=s=>s.ownerKey===null?{sql:'',args:[]}:{sql:'owner_key=? AND ',args:[s.ownerKey]};

/** Internal canonical reads. Never serialize these records before authorizing
 * each note: the membership list includes notes hidden from the caller. */
export function readGroupMembers(d,ownerKey,groupId) {
  if(ownerKey!==null)return readNoteOwnerGroupMembers(d,ownerKey,groupId);
  return d.prepare('SELECT note_id FROM note_group_members WHERE group_id=? ORDER BY ordinal,note_id').all(groupId).map(row=>row.note_id);
}

export function readNoteGroup(d,ownerKey,noteId) {
  const member=readNoteOwnerMembership(d,ownerKey,noteId);
  return member?readNoteOwnerGroup(d,ownerKey,member.group_id):undefined;
}

export function groupLayout(group) {
  const {x,y,width,height,position_locked,always_on_top}=group;
  return {x,y,width,height,position_locked:Boolean(position_locked),always_on_top:Boolean(always_on_top)};
}

export function assertStandaloneLayoutWrite(d,ownerKey,noteId) {
  if(readNoteGroup(d,ownerKey,noteId))throw noteError('This layout has changed. Reload the board before trying again.',409);
}

/** Geometry changes and membership transitions share one monotonic layout
 * revision. The transition fence prevents an inverse from reviving an old
 * standalone snapshot even when its stored rectangle is already identical. */
export function writeNoteGroupLayout(d,ownerKey,noteId,layout,{forceRevision=false}={}) {
  if(ownerKey!==null)ensureNoteLayoutOwner(d,ownerKey);
  const s=source(d,ownerKey),q=scope(s);
  const current=ownerKey===null?d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(noteId):readNoteOwnerLayout(d,ownerKey,noteId);
  if(current&&!forceRevision&&JSON.stringify(groupLayout(current))===JSON.stringify(groupLayout(layout)))return;
  const {x,y,width,height,position_locked,always_on_top}=layout;
  if(current)d.prepare(`UPDATE ${s.layouts} SET x=?,y=?,width=?,height=?,position_locked=?,always_on_top=?,revision=revision+1 WHERE ${q.sql}note_id=?`).run(x,y,width,height,+position_locked,+always_on_top,...q.args,noteId);
  else d.prepare(`INSERT INTO ${s.layouts}(${s.ownerKey===null?'':'owner_key,'}note_id,x,y,width,height,position_locked,always_on_top) VALUES(${s.ownerKey===null?'':'?,'}?,?,?,?,?,?,?)`).run(...q.args,noteId,x,y,width,height,+position_locked,+always_on_top);
}

/** Collect all scopes before the shared note's foreign-key cascades run. */
export function groupsAffectedByNoteDeletion(d,noteId) {
  return [
    ...d.prepare('SELECT group_id AS id FROM note_group_members WHERE note_id=?').all(noteId).map(row=>({ownerKey:null,id:row.id})),
    ...d.prepare('SELECT owner_key,group_id AS id FROM note_board_group_members WHERE note_id=?').all(noteId).map(row=>({ownerKey:row.owner_key,id:row.id})),
  ];
}

/** Caller owns the delete authorization and immediate transaction. Survivors
 * are internal invariant maintenance, never returned to the deleting actor. */
export function cleanupGroupsAfterNoteDeletion(d,affectedGroups) {
  const seen=new Set();
  for(const {ownerKey,id} of affectedGroups){
    const identity=JSON.stringify([ownerKey,id]);if(seen.has(identity))continue;seen.add(identity);
    const s=source(d,ownerKey),q=scope(s);
    const group=d.prepare(`SELECT * FROM ${s.groups} WHERE ${q.sql}id=?`).get(...q.args,id);if(!group)continue;
    const members=readGroupMembers(d,ownerKey,id);
    if(members.length<2){
      if(members.length)writeNoteGroupLayout(d,ownerKey,members[0],groupLayout(group),{forceRevision:true});
      d.prepare(`DELETE FROM ${s.groups} WHERE ${q.sql}id=?`).run(...q.args,id);
    }else{
      // Removing a member preserves relative order; fresh dense ordinals avoid
      // uniqueness collisions without temporary negative CHECK violations.
      d.prepare(`DELETE FROM ${s.members} WHERE ${q.sql}group_id=?`).run(...q.args,id);
      members.forEach((noteId,ordinal)=>d.prepare(`INSERT INTO ${s.members}(${s.ownerKey===null?'':'owner_key,'}note_id,group_id,ordinal) VALUES(${s.ownerKey===null?'':'?,'}?,?,?)`).run(...q.args,noteId,id,ordinal));
      d.prepare(`UPDATE ${s.groups} SET revision=revision+1 WHERE ${q.sql}id=?`).run(...q.args,id);
    }
  }
}
