import {actorId} from '../permissions.js';
import {noteDevice,noteError} from './note-access.js';

const layoutFields='note_id,x,y,width,height,revision,position_locked,always_on_top';
const groupFields='id,revision,x,y,width,height,position_locked,always_on_top';
const memberFields='note_id,group_id,ordinal';
function checkedKey(key){
  if(typeof key!=='string'||!/^(human|device):[1-9]\d*$/.test(key)||!Number.isSafeInteger(Number(key.split(':')[1])))throw new TypeError('Invalid Notes layout owner.');
  return key;
}

/** Effective server identity only. Authentication context and credential IDs
 * remain permission fences; they never select persistent arrangement storage. */
export function noteLayoutOwnerKey(principal){
  const device=noteDevice(principal),id=device?device.id:actorId(principal);
  if(!Number.isSafeInteger(id)||id<1)throw noteError('Personal or paired-device sign-in required.',401);
  return `${device?'device':'human'}:${id}`;
}
export function hasNoteLayoutOwner(d,key){
  return Boolean(d.prepare('SELECT 1 FROM note_board_owners WHERE owner_key=?').get(checkedKey(key)));
}

/** Read-only source selection. Consumers must bind ownerKey for scoped tables;
 * a null ownerKey identifies only the unchanged legacy seed, never another owner. */
export function noteLayoutSource(d,key){
  return hasNoteLayoutOwner(d,key)
    ?{layouts:'note_board_note_layouts',groups:'note_board_groups',members:'note_board_group_members',ownerKey:key}
    :{layouts:'note_layouts',groups:'note_groups',members:'note_group_members',ownerKey:null};
}
function scope(source){return source.ownerKey===null?{sql:'1=1',args:[]}:{sql:'owner_key=?',args:[source.ownerKey]};}
export function readNoteOwnerLayout(d,key,noteId){
  const source=noteLayoutSource(d,key),s=scope(source);
  return d.prepare(`SELECT ${layoutFields} FROM ${source.layouts} WHERE ${s.sql} AND note_id=?`).get(...s.args,noteId);
}
export function readNoteOwnerGroup(d,key,id){
  const source=noteLayoutSource(d,key),s=scope(source);
  return d.prepare(`SELECT ${groupFields} FROM ${source.groups} WHERE ${s.sql} AND id=?`).get(...s.args,id);
}
export function readNoteOwnerGroupMembers(d,key,id){
  const source=noteLayoutSource(d,key),s=scope(source);
  return d.prepare(`SELECT note_id FROM ${source.members} WHERE ${s.sql} AND group_id=? ORDER BY ordinal`).all(...s.args,id).map(row=>row.note_id);
}
export function readNoteOwnerMembership(d,key,noteId){
  const source=noteLayoutSource(d,key),s=scope(source);
  return d.prepare(`SELECT ${memberFields} FROM ${source.members} WHERE ${s.sql} AND note_id=?`).get(...s.args,noteId);
}
export function listNoteOwnerGroups(d,key){
  const source=noteLayoutSource(d,key),s=scope(source);
  return d.prepare(`SELECT ${groupFields} FROM ${source.groups} WHERE ${s.sql} ORDER BY id`).all(...s.args);
}

/** Call only after current authorization, inside the arrangement transaction.
 * An immediate transaction also keeps this helper atomic for direct callers;
 * better-sqlite3 nests it as a savepoint inside the existing immediate write. */
export function ensureNoteLayoutOwner(d,key){
  checkedKey(key);
  if(hasNoteLayoutOwner(d,key))return;
  d.transaction(()=>{
    if(hasNoteLayoutOwner(d,key))return;
    const highWater=Math.max(d.prepare('SELECT COALESCE(MAX(id),0) n FROM note_groups').get().n,
      d.prepare("SELECT seq FROM sqlite_sequence WHERE name='note_groups'").get()?.seq??0);
    if(!Number.isSafeInteger(highWater)||highWater>=Number.MAX_SAFE_INTEGER)throw noteError('Notes group IDs are exhausted.',409);
    d.prepare(`INSERT INTO note_board_note_layouts(owner_key,${layoutFields}) SELECT ?,${layoutFields} FROM note_layouts`).run(key);
    d.prepare(`INSERT INTO note_board_groups(owner_key,${groupFields}) SELECT ?,${groupFields} FROM note_groups`).run(key);
    d.prepare(`INSERT INTO note_board_group_members(owner_key,${memberFields}) SELECT ?,${memberFields} FROM note_group_members`).run(key);
    // Marker last: deferred references commit atomically and seed triggers stay quiet.
    d.prepare('INSERT INTO note_board_owners(owner_key,next_group_id) VALUES(?,?)').run(key,highWater+1);
  }).immediate();
}
export function nextNoteGroupId(d,key){
  checkedKey(key);
  return d.transaction(()=>{
    ensureNoteLayoutOwner(d,key);
    const id=d.prepare('SELECT next_group_id FROM note_board_owners WHERE owner_key=?').get(key).next_group_id;
    if(!Number.isSafeInteger(id)||id>=Number.MAX_SAFE_INTEGER)throw noteError('Notes group IDs are exhausted.',409);
    d.prepare('UPDATE note_board_owners SET next_group_id=next_group_id+1 WHERE owner_key=?').run(key);
    return id;
  }).immediate();
}
