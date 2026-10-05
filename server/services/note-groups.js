import {readNoteBoard} from './note-board.js';
import {readGroupMembers,readNoteGroup,groupLayout} from './note-group-store.js';

/** Authorize content first, then project only visible pages. Canonical counts
 * and ordinals never cross this boundary, and reads never dissolve containers. */
export function readGroupedNoteBoard(d,principal) {
  return d.transaction(()=>{
    const {notes}=readNoteBoard(d,principal),visible=new Map(notes.map(note=>[note.id,note]));
    const candidates=new Map(),groups=[];
    for(const note of notes){
      const group=readNoteGroup(d,note.id);
      if(group)candidates.set(group.id,group);
    }
    for(const group of candidates.values()){
      const members=readGroupMembers(d,group.id),member_ids=members.filter(id=>visible.has(id));
      if(member_ids.length<2)continue;
      groups.push({id:group.id,revision:group.revision,layout:groupLayout(group),member_ids,
        can_manage:members.every(id=>visible.get(id)?.permissions.view&&visible.get(id)?.permissions.edit)});
    }
    return {notes,groups};
  }).deferred();
}
