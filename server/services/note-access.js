import {actorId,actorPermissions} from '../permissions.js';

export const noteDevice = principal => principal?.devicePrincipal?.kind==='device'?principal.devicePrincipal:principal?.kind==='device'?principal:null;
export const noteError=(message,status=400)=>Object.assign(new Error(message),{status,code:status});
export function noteVisibleSql(alias='n',viewerParam='viewerId') {
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)||!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(viewerParam))throw new Error('Invalid Notes SQL identifier.');
  return `(${alias}.visibility='all' OR ${alias}.created_by=@${viewerParam}
    OR (${alias}.visibility='selected' AND EXISTS(SELECT 1 FROM note_access na WHERE na.note_id=${alias}.id AND na.user_id=@${viewerParam})))`;
}
export function noteCapabilities(d,principal,note=null) {
  const device=noteDevice(principal);
  if(device){
    const valid=device.status!=='revoked'&&Number.isSafeInteger(device.id)&&device.id>0&&['read','write'].includes(device.permissions?.modules?.notes);
    const visible=!note||note.visibility==='all';
    const allow=action=>Boolean(valid&&visible&&device.permissions?.capabilities?.[`device_notes.${action}`]==='allow');
    return {view:allow('view'),create:allow('create'),edit:allow('edit'),delete:allow('delete'),manage_visibility:false};
  }
  const me=actorId(principal),access=actorPermissions(d,principal).modules.notes;
  const visible=!note||note.visibility==='all'||Number(note.created_by)===me||note.visibility==='selected'&&!!d.prepare('SELECT 1 FROM note_access WHERE note_id=? AND user_id=?').get(note.id,me);
  return {view:Boolean(access!=='none'&&visible),create:access==='write',edit:Boolean(access==='write'&&visible),delete:Boolean(access==='write'&&visible),manage_visibility:Boolean(access==='write'&&note&&Number(note.created_by)===me)};
}
export function assertNoteAction(d,principal,note,action) {
  const device=noteDevice(principal);
  if(note && (device?note.visibility!=='all':!noteCapabilities(d,principal,note).view))throw noteError('Note not found.',404);
  const c=noteCapabilities(d,principal,note);
  if(!c[action])throw noteError('This Notes action is not allowed.',403);
  return c;
}
export function noteMembers(d) {
  return d.prepare(`SELECT u.id,u.display_name,u.avatar_color FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers w WHERE w.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id) ORDER BY u.display_name,u.id`).all();
}
export function normalizeNoteAudience(d,principal,body,previous=null) {
  const supplied=body.visibility!==undefined||body.access_user_ids!==undefined;
  const device=noteDevice(principal);
  if(device){
    if(body.visibility!==undefined&&body.visibility!=='all'||body.access_user_ids!==undefined)throw noteError('Restricted notes require personal sign-in.',403);
    return {visibility:'all',members:[]};
  }
  if(previous&&supplied)assertNoteAction(d,principal,previous,'manage_visibility');
  const visibility=body.visibility===undefined?(previous?.visibility??'all'):body.visibility;
  if(!['all','private','selected'].includes(visibility))throw noteError('Choose Private, Everyone, or Selected members.');
  const existing=previous?d.prepare('SELECT user_id FROM note_access WHERE note_id=? ORDER BY user_id').all(previous.id).map(r=>r.user_id):[];
  const members=body.access_user_ids===undefined?(visibility==='selected'?existing:[]):body.access_user_ids;
  if(!Array.isArray(members)||members.length>100||members.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(members).size!==members.length)throw noteError('Choose distinct household members.');
  if(visibility!=='selected'&&members.length)throw noteError('Recipients require Selected members visibility.');
  const owner=previous?.created_by??actorId(principal),valid=new Set(noteMembers(d).map(m=>m.id));
  if(members.some(id=>!valid.has(id)||id===owner)||visibility==='selected'&&!members.length)throw noteError('Choose at least one other household member.');
  return {visibility,members};
}
