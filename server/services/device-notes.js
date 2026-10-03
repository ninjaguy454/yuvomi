/** Regular Notes are module-wide. Device rights are independent, never inherited
 * from a member or from authorship. This boundary never enters human routers. */
import { assertDeviceModule, deviceMembers } from './device-content.js';
import { auditDevice } from './devices.js';
import { str, color, collectErrors, MAX_TEXT, MAX_TITLE } from '../middleware/validate.js';
import { toggleChecklistLine } from '../../public/utils/markdown-checklist.js';

const allowed=(p,action)=>p.permissions?.capabilities?.[`device_notes.${action}`]==='allow';
const fail=(message,status=403)=>{throw Object.assign(new Error(message),{status});};
function requireAction(p,action){assertDeviceModule(p,'notes');if(!allowed(p,action))fail('This Notes action is not allowed on this device.');}
function projection(d,p,row){
  const member=deviceMembers(d,p).find(item=>item.id===row.created_by);
  const device=row.created_by_device?d.prepare('SELECT name FROM household_devices WHERE id=?').get(row.created_by_device):null;
  return {id:row.id,title:row.title,content:row.content,color:row.color,pinned:row.pinned,
    created_at:row.created_at,updated_at:row.updated_at,
    creator_name:device?.name||member?.display_name||null,creator_color:member?.avatar_color||null};
}
export function deviceNotesRequest(d,p,method,id,action,body={}) {
  const right=method==='GET'?'view':method==='POST'?'create':method==='DELETE'?'delete':'edit';
  requireAction(p,right);
  if(method==='GET')return {status:200,body:{data:d.prepare('SELECT * FROM notes ORDER BY pinned DESC,updated_at DESC').all().map(row=>projection(d,p,row))}};
  return d.transaction(()=>{
    const previous=method==='POST'?null:d.prepare('SELECT * FROM notes WHERE id=?').get(id);
    if(method!=='POST'&&!previous)fail('Note not found.',404);
    if(method==='DELETE'){
      d.prepare('DELETE FROM notes WHERE id=?').run(id);
      auditDevice(d,p.id,null,'note_deleted',{note_id:id});
      return {status:204};
    }
    if(action==='pin')d.prepare('UPDATE notes SET pinned=? WHERE id=?').run(previous.pinned?0:1,id);
    else if(action==='check'){
      if(!Number.isInteger(body.line)||body.line<0||typeof body.checked!=='boolean'||(body.expect!=null&&typeof body.expect!=='string'))fail('Invalid checklist change.',400);
      const changed=toggleChecklistLine(previous.content,body.line,body.checked,body.expect);
      if(!changed.ok)fail('The note has changed. Reload it before trying again.',409);
      if(changed.changed)d.prepare('UPDATE notes SET content=? WHERE id=?').run(changed.content,id);
    } else {
      const content=str(body.content??previous?.content,'Content',{max:MAX_TEXT});
      const title=str(body.title===undefined?previous?.title:body.title,'Title',{max:MAX_TITLE,required:false});
      const tint=color(body.color??previous?.color??'#FFEB3B','Color');
      const errors=collectErrors([content,title,tint]);if(errors.length)fail(errors.join(' '),400);
      if(body.pinned!==undefined&&![true,false,0,1].includes(body.pinned))fail('Invalid pinned value.',400);
      const pinned=body.pinned===undefined?(previous?.pinned||0):(body.pinned?1:0);
      if(method==='POST')id=Number(d.prepare('INSERT INTO notes(content,title,color,pinned,created_by,created_by_device) VALUES(?,?,?,?,NULL,?)').run(content.value,title.value,tint.value,pinned,p.id).lastInsertRowid);
      else d.prepare('UPDATE notes SET content=?,title=?,color=?,pinned=? WHERE id=?').run(content.value,title.value,tint.value,pinned,id);
    }
    auditDevice(d,p.id,null,method==='POST'?'note_created':'note_updated',{note_id:id});
    const data=allowed(p,'view')?projection(d,p,d.prepare('SELECT * FROM notes WHERE id=?').get(id)):null;
    return {status:method==='POST'?201:200,body:{data}};
  }).immediate();
}
