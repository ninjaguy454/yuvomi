import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {noteDevice} from './note-access.js';
import {readGroupMembers,readNoteGroup,groupLayout} from './note-group-store.js';
import {readNoteOwnerLayout,readNoteOwnerGroup} from './note-layout-owner.js';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const groupRequestHash=command=>createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex');
export function groupReceiptPrincipalKey(principal) {
  const device=noteDevice(principal),identity=device?`device:${device.id}:${device.revision}`:`human:${actorId(principal)}`;
  // Credential context values are hashed, never copied into receipt storage.
  return createHash('sha256').update(JSON.stringify([identity,principal?._noteGroupReceiptContext??null])).digest('hex');
}
export function readGroupReceipt(d,ownerKey,key,id) {
  const scoped=d.prepare('SELECT request_hash,before_json,after_json FROM note_board_group_receipts WHERE owner_key=? AND principal_key=? AND operation_id=?').get(ownerKey,key,id);
  const row=scoped||d.prepare('SELECT request_hash,before_json,after_json FROM note_group_receipts WHERE principal_key=? AND operation_id=?').get(key,id);
  return row?{hash:row.request_hash,before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),legacy:!scoped}:null;
}
export function saveGroupReceipt(d,ownerKey,key,command,before,after) {
  d.prepare('INSERT INTO note_board_group_receipts(owner_key,principal_key,operation_id,request_hash,before_json,after_json) VALUES(?,?,?,?,?,?)').run(ownerKey,key,command.operation_id,groupRequestHash(command),JSON.stringify(before),JSON.stringify(after));
}
/** IDs, revisions, rectangles and membership only. Authorization occurs before
 * capture. Projected geometry is needed to undo an unsaved standalone layout. */
export function captureGroupStructure(d,ownerKey,noteIds,groupIds,layouts) {
  return {
    notes:[...noteIds].sort((a,b)=>a-b).map(id=>{
      const note=d.prepare('SELECT revision FROM notes WHERE id=?').get(id),saved=readNoteOwnerLayout(d,ownerKey,id);
      return {id,revision:note.revision,layout_revision:saved?.revision??0,group_id:readNoteGroup(d,ownerKey,id)?.id??null,stored_layout:saved?groupLayout(saved):null,layout:saved?groupLayout(saved):groupLayout(layouts.get(id))};
    }),
    groups:[...groupIds].sort((a,b)=>a-b).map(id=>{
      const g=readNoteOwnerGroup(d,ownerKey,id);
      return g?{id,revision:g.revision,layout:groupLayout(g),member_ids:readGroupMembers(d,ownerKey,id)}:{id,missing:true};
    }),
  };
}
export function groupStructureMatches(d,ownerKey,snapshot) {
  for(const n of snapshot.notes){
    const current=d.prepare('SELECT revision FROM notes WHERE id=?').get(n.id),layout=readNoteOwnerLayout(d,ownerKey,n.id);
    if(!current||current.revision!==n.revision||(layout?.revision??0)!==n.layout_revision||(readNoteGroup(d,ownerKey,n.id)?.id??null)!==n.group_id||JSON.stringify(layout?groupLayout(layout):null)!==JSON.stringify(n.stored_layout))return false;
  }
  for(const g of snapshot.groups){
    const current=readNoteOwnerGroup(d,ownerKey,g.id);
    if(g.missing){if(current)return false;}
    else if(!current||current.revision!==g.revision||JSON.stringify(groupLayout(current))!==JSON.stringify(g.layout)||JSON.stringify(readGroupMembers(d,ownerKey,g.id))!==JSON.stringify(g.member_ids))return false;
  }
  return true;
}
