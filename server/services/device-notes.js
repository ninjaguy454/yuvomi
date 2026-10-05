/** Device Notes keep independent grants and explicit device authorship. */
import {auditDevice} from './devices.js';
import {readNoteBoard,readNote,saveNote,mutateNote,setNoteLayout,setNoteLayouts} from './note-board.js';
import {readGroupedNoteBoard,applyNoteGroupCommand} from './note-groups.js';
import {noteDevice} from './note-access.js';
export function deviceNotesRequest(d,p,method,id,action,body={}) {
  if(method==='GET'&&action==='board')return {status:200,body:{data:readGroupedNoteBoard(d,p)}};
  if(method==='GET')return {status:200,body:{data:id?readNote(d,p,id):readNoteBoard(d,p).notes}};
  return d.transaction(()=>{
    if(method==='POST'&&action==='group-operations') {
      const data=applyNoteGroupCommand(d,p,body);
      if(!data.replayed)auditDevice(d,noteDevice(p).id,null,'note_group_operation',{operation_id:data.operation_id,kind:body.kind});
      return {status:200,body:{data}};
    }
    let data,noteId=id;
    if(action==='layout')data=id?setNoteLayout(d,p,id,body):setNoteLayouts(d,p,body);
    else if(method==='POST'||method==='PUT'){const saved=saveNote(d,p,method==='POST'?null:id,body);data=saved.data;noteId=saved.noteId;}
    else data=mutateNote(d,p,id,method==='DELETE'?'delete':action,body);
    auditDevice(d,p.id,null,method==='POST'?'note_created':method==='DELETE'?'note_deleted':'note_updated',{note_id:noteId??null});
    return method==='DELETE'?{status:204}:{status:method==='POST'?201:200,body:{data}};
  }).immediate();
}
