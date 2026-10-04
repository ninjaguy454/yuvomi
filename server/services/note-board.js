import {actorId} from '../permissions.js';
import {str,color,collectErrors,MAX_TEXT,MAX_TITLE} from '../middleware/validate.js';
import {toggleChecklistLine} from '../../public/utils/markdown-checklist.js';
import {noteDevice,noteError,noteVisibleSql,noteCapabilities,assertNoteAction,noteMembers,normalizeNoteAudience} from './note-access.js';

const fields=['title','content','color','pinned','visibility','access_user_ids','expected_revision'];
const idValue=id=>{if(!Number.isSafeInteger(Number(id))||Number(id)<1)throw noteError('Note not found.',404);return Number(id);};
function requireNote(d,p,id,action){const note=d.prepare('SELECT * FROM notes WHERE id=?').get(idValue(id));if(!note)throw noteError('Note not found.',404);assertNoteAction(d,p,note,action);return note;}
function revision(note,body,{required=false}={}){
  if(body.expected_revision===undefined&&!required)return;
  if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision!==note.revision)throw noteError('The note has changed. Reload it before trying again.',409);
}
function savedLayout(d,n){
  const layout=d.prepare('SELECT x,y,width,height,revision,position_locked,always_on_top FROM note_layouts WHERE note_id=?').get(n.id);
  return layout?{...layout,position_locked:Boolean(layout.position_locked),always_on_top:Boolean(layout.always_on_top)}:undefined;
}
function visibleNotes(d,p){
  const device=noteDevice(p);
  return d.prepare(`SELECT n.* FROM notes n WHERE ${device?"n.visibility='all'":noteVisibleSql()} ORDER BY n.pinned DESC,n.updated_at DESC,n.id DESC`)
    .all(...(device?[]:[{viewerId:actorId(p)}]));
}
/** Defaults are a read-only packing of authorized cards. Saved rectangles are
 * obstacles; hidden notes never affect positions. Pinned cards keep priority;
 * stable IDs within each group keep content edits/new cards from shuffling it. */
function projectedLayouts(d,p,notes=visibleNotes(d,p)){
  const result=new Map(),occupied=[];
  for(const note of notes){const saved=savedLayout(d,note);if(saved){result.set(note.id,saved);occupied.push(saved);}}
  for(const note of [...notes].sort((a,b)=>b.pinned-a.pinned||a.id-b.id)){
    if(result.has(note.id))continue;
    let placed;
    const rows=[...new Set([0,...occupied.map(r=>r.y+r.height)])].filter(y=>y<=10000).sort((a,b)=>a-b);
    for(const y of rows){
      for(const x of [0,4,8,1,2,3,5,6,7]){
        const candidate={x,y,width:4,height:6,revision:0,position_locked:false,always_on_top:false};
        if(occupied.every(r=>x+4<=r.x||r.x+r.width<=x||y+6<=r.y||r.y+r.height<=y)){placed=candidate;break;}
      }
      if(placed)break;
    }
    // A fully occupied bounded board remains readable in compact view. Never
    // emit out-of-bounds geometry that the client would clamp over another card.
    result.set(note.id,placed||{x:0,y:0,width:4,height:6,revision:0,position_locked:false,always_on_top:false,overflow:true});
    if(placed)occupied.push(placed);
  }
  return result;
}
function project(d,p,n,layouts){
  const permissions=noteCapabilities(d,p,n),device=noteDevice(p);
  if(!permissions.view)return null;
  const creator=n.created_by?d.prepare('SELECT display_name,avatar_color,avatar_data FROM users WHERE id=?').get(n.created_by):null;
  const source=n.created_by_device?d.prepare('SELECT name FROM household_devices WHERE id=?').get(n.created_by_device):null;
  const scoped=!device||!device.scope?.member_ids?.length||device.scope.member_ids.includes(n.created_by);
  const out={id:n.id,title:n.title,content:n.content,color:n.color,pinned:n.pinned,visibility:n.visibility,revision:n.revision,
    created_at:n.created_at,updated_at:n.updated_at,creator_name:source?.name||(scoped?creator?.display_name:null)||null,
    creator_color:scoped?creator?.avatar_color||null:null,permissions,layout:(layouts||projectedLayouts(d,p)).get(n.id)};
  if(!device){out.created_by=n.created_by;out.created_by_device=n.created_by_device;out.creator_avatar=creator?.avatar_data||null;}
  if(permissions.manage_visibility)out.access_user_ids=d.prepare('SELECT user_id FROM note_access WHERE note_id=? ORDER BY user_id').all(n.id).map(r=>r.user_id);
  return out;
}
export function readNoteBoard(d,p){
  assertNoteAction(d,p,null,'view');
  return d.transaction(()=>{const notes=visibleNotes(d,p),layouts=projectedLayouts(d,p,notes);return {notes:notes.map(n=>project(d,p,n,layouts))};}).deferred();
}
export function readNote(d,p,id){return d.transaction(()=>project(d,p,requireNote(d,p,id,'view'))).deferred();}
export function readNoteMembers(d,p){if(noteDevice(p))throw noteError('Personal sign-in required.',403);assertNoteAction(d,p,null,'create');return noteMembers(d);}
function saveMembers(d,id,members){
  const before=d.prepare('SELECT user_id FROM note_access WHERE note_id=? ORDER BY user_id').all(id).map(r=>r.user_id);
  if(JSON.stringify(before)===JSON.stringify([...members].sort((a,b)=>a-b)))return;
  d.prepare('DELETE FROM note_access WHERE note_id=?').run(id);
  for(const member of members)d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,?)').run(id,member);
}
/** Internal result keeps creation attribution even when the caller cannot view
 * the saved note. Only data is serialized by the human/device adapters. */
export function saveNote(d,p,id,body={}){
  return d.transaction(()=>{
    const previous=id==null?null:requireNote(d,p,id,'edit');
    if(!previous)assertNoteAction(d,p,null,'create');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!fields.includes(key)))throw noteError('Invalid Notes fields.');
    const checks=[str(body.content??previous?.content,'Content',{max:MAX_TEXT,required:!previous}),str(body.title===undefined?previous?.title:body.title,'Title',{max:MAX_TITLE,required:false}),color(body.color??previous?.color??'#FFEB3B','Color')];
    const errors=collectErrors(checks);if(errors.length)throw noteError(errors.join(' '));
    if(body.pinned!==undefined&&![true,false,0,1].includes(body.pinned))throw noteError('Invalid pinned value.');
    const audience=normalizeNoteAudience(d,p,body,previous);
    // Blind Edit-only devices retain Phase1's independent grant; readers must
    // provide the revision of the content snapshot they are replacing.
    if(previous)revision(previous,body,{required:noteCapabilities(d,p,previous).view});
    if(previous){
      d.prepare('UPDATE notes SET content=?,title=?,color=?,pinned=?,visibility=? WHERE id=?').run(checks[0].value??'',checks[1].value,checks[2].value,body.pinned===undefined?previous.pinned:body.pinned?1:0,audience.visibility,previous.id);id=previous.id;
    }else{
      const device=noteDevice(p);
      id=Number(d.prepare('INSERT INTO notes(content,title,color,pinned,visibility,created_by,created_by_device) VALUES(?,?,?,?,?,?,?)').run(checks[0].value,checks[1].value,checks[2].value,body.pinned?1:0,audience.visibility,device?null:actorId(p),device?.id??null).lastInsertRowid);
    }
    saveMembers(d,id,audience.members);
    return {noteId:id,data:project(d,p,d.prepare('SELECT * FROM notes WHERE id=?').get(id))};
  }).immediate();
}
export function updateNote(d,p,id,body={}){return saveNote(d,p,id,body).data;}
export function mutateNote(d,p,id,action,body={}){
  return d.transaction(()=>{
    const note=requireNote(d,p,id,action==='delete'?'delete':'edit');
    if(action==='delete'){revision(note,body);d.prepare('DELETE FROM notes WHERE id=?').run(note.id);return null;}
    if(action==='pin'){revision(note,body);d.prepare('UPDATE notes SET pinned=? WHERE id=?').run(note.pinned?0:1,note.id);}
    else if(action==='check'){
      if(!Number.isInteger(body.line)||body.line<0||typeof body.checked!=='boolean'||body.expect!=null&&typeof body.expect!=='string')throw noteError('Invalid checklist change.');
      const result=toggleChecklistLine(note.content,body.line,body.checked,body.expect);
      if(!result.ok)throw Object.assign(noteError('The note has changed. Reload it before trying again.',409),{reason:result.reason});
      if(result.changed)d.prepare('UPDATE notes SET content=? WHERE id=?').run(result.content,note.id);
    }else throw noteError('Unknown Notes action.');
    return project(d,p,d.prepare('SELECT * FROM notes WHERE id=?').get(note.id));
  }).immediate();
}
function checkedLayout(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['x','y','width','height'].includes(key)))throw noteError('Invalid note layout.');
  const {x,y,width,height}=value;
  if(![x,y,width,height].every(Number.isSafeInteger)||x<0||x>10000||y<0||y>10000||width<3||width>12||height<4||height>100)throw noteError('Invalid note layout.');
  return {x,y,width,height};
}
const layoutChangeFields=['layout','position_locked','always_on_top'];
const layoutRequestFields=['expected_layout_revision',...layoutChangeFields];
const owns=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
export function setNoteLayouts(d,p,body={}){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['items','include_locked'].includes(key))||owns(body,'include_locked')&&typeof body.include_locked!=='boolean')throw noteError('Invalid note layout request.');
  const {items,include_locked=false}=body;
  if(!Array.isArray(items)||!items.length||items.length>500||new Set(items.map(i=>i?.note_id)).size!==items.length)throw noteError('Choose distinct notes to arrange.');
  return d.transaction(()=>{
    let defaults;
    const planned=items.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item)||!Number.isSafeInteger(item.note_id)||item.note_id<1||Object.keys(item).some(key=>!['note_id',...layoutRequestFields].includes(key))||!layoutChangeFields.some(key=>owns(item,key)))throw noteError('Invalid note layout request.');
      const note=requireNote(d,p,item.note_id,'edit');assertNoteAction(d,p,note,'view');
      for(const flag of ['position_locked','always_on_top'])if(owns(item,flag)&&typeof item[flag]!=='boolean')throw noteError('Invalid note layout flag.');
      const saved=savedLayout(d,note),current=saved||(defaults??=projectedLayouts(d,p)).get(note.id);
      if(!Number.isSafeInteger(item.expected_layout_revision)||item.expected_layout_revision!==current.revision)throw noteError('The note layout changed. Reload before trying again.',409);
      const geometry=owns(item,'layout')?checkedLayout(item.layout):{x:current.x,y:current.y,width:current.width,height:current.height};
      const flags={position_locked:owns(item,'position_locked')?item.position_locked:current.position_locked,always_on_top:owns(item,'always_on_top')?item.always_on_top:current.always_on_top};
      if(current.position_locked&&flags.position_locked&&!include_locked&&(geometry.x!==current.x||geometry.y!==current.y))throw noteError('The note position is locked. Unlock it before moving it.',409);
      return {note,geometry,flags,current,saved,hasGeometry:owns(item,'layout')};
    });
    return planned.map(({note,geometry:g,flags,current,saved,hasGeometry})=>{
      if(!saved&&!hasGeometry&&['position_locked','always_on_top'].every(key=>flags[key]===current[key]))return {note_id:note.id,...current};
      if(!saved)d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?,?)').run(note.id,g.x,g.y,g.width,g.height,flags.position_locked?1:0,flags.always_on_top?1:0);
      else if(['x','y','width','height'].some(key=>g[key]!==current[key])||['position_locked','always_on_top'].some(key=>flags[key]!==current[key]))d.prepare('UPDATE note_layouts SET x=?,y=?,width=?,height=?,position_locked=?,always_on_top=?,revision=revision+1 WHERE note_id=?').run(g.x,g.y,g.width,g.height,flags.position_locked?1:0,flags.always_on_top?1:0,note.id);
      return {note_id:note.id,...savedLayout(d,note)};
    });
  }).immediate();
}
export function setNoteLayout(d,p,id,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!layoutRequestFields.includes(key)))throw noteError('Invalid note layout request.');
  return setNoteLayouts(d,p,{items:[{...body,note_id:idValue(id)}]})[0];
}
