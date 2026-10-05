import {readNoteBoard} from './note-board.js';
import {readGroupMembers,readNoteGroup,groupLayout,writeNoteGroupLayout} from './note-group-store.js';
import {actorId} from '../permissions.js';
import {noteDevice,noteError,assertNoteAction} from './note-access.js';
import {deviceRequestStillValid,devicePrincipal,readDeviceContext} from './devices.js';
import {groupReceiptPrincipalKey,groupRequestHash,readGroupReceipt,saveGroupReceipt,captureGroupStructure,groupStructureMatches} from './note-group-receipts.js';
import {noteLayoutOwnerKey,ensureNoteLayoutOwner,nextNoteGroupId,readNoteOwnerLayout,readNoteOwnerGroup} from './note-layout-owner.js';

/** Authorize content first, then project only visible pages. Canonical counts
 * and ordinals never cross this boundary, and reads never dissolve containers. */
export function readGroupedNoteBoard(d,principal) {
  return d.transaction(()=>{
    const ownerKey=noteLayoutOwnerKey(principal),{notes}=readNoteBoard(d,principal),visible=new Map(notes.map(note=>[note.id,note]));
    const candidates=new Map(),groups=[];
    for(const note of notes){
      const group=readNoteGroup(d,ownerKey,note.id);
      if(group)candidates.set(group.id,group);
    }
    for(const group of candidates.values()){
      const members=readGroupMembers(d,ownerKey,group.id),member_ids=members.filter(id=>visible.has(id));
      if(member_ids.length<2)continue;
      groups.push({id:group.id,revision:group.revision,layout:groupLayout(group),member_ids,
        can_manage:members.every(id=>visible.get(id)?.permissions.view&&visible.get(id)?.permissions.edit)});
    }
    return {notes,groups};
  }).deferred();
}

const invalid=()=>noteError('Invalid Notes group command.');
const conflict=()=>noteError('This board has changed. Reload it before trying again.',409);
const unavailable=()=>noteError('This Notes action is no longer available.',404);
const limit=()=>noteError('This action affects more than 500 notes. Choose fewer notes or smaller groups.');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const id=value=>{if(!Number.isSafeInteger(value)||value<1)throw invalid();return value;};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function fields(value,names){if(!object(value)||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw invalid();}
function operationId(value){if(typeof value!=='string'||!value.trim()||value.length>200)throw invalid();}
function ids(values){if(!Array.isArray(values)||!values.length||new Set(values).size!==values.length)throw invalid();values.forEach(id);if(values.length>500)throw limit();}
function rectangle(value){
  fields(value,['x','y','width','height','position_locked','always_on_top']);
  const {x,y,width,height,position_locked,always_on_top}=value;
  if(![x,y].every(Number.isFinite)||![width,height].every(Number.isSafeInteger)||x<0||x>10000||y<0||y>10000||width<3||width>12||height<4||height>100||typeof position_locked!=='boolean'||typeof always_on_top!=='boolean')throw invalid();
  return groupLayout(value);
}
function validateCommand(c){
  if(!object(c))throw invalid();operationId(c.operation_id);
  const variants={create:Object.hasOwn(c,'source_note_id')?['source_note_id','target_note_id']:['source_group_id','selected_ids','target_note_id'],reorder:['group_id','selected_ids','before_note_id'],transfer:['source_group_id','target_group_id','selected_ids','before_note_id'],join:['target_group_id','note_ids','before_note_id'],extract:['source_group_id','selected_ids','result','placements'],arrange:['items','include_locked'],undo:['undo_operation_id']};
  if(typeof c.kind!=='string'||!Object.hasOwn(variants,c.kind))throw invalid();fields(c,['operation_id','kind','expected',...variants[c.kind]]);
  fields(c.expected,['groups','notes']);
  for(const key of ['groups','notes']){
    const rows=c.expected[key];if(!Array.isArray(rows)||new Set(rows.map(row=>row?.id)).size!==rows.length)throw invalid();if(rows.length>500)throw limit();
    for(const row of rows){fields(row,key==='groups'?['id','revision']:['id','revision','layout_revision']);id(row.id);if(!Number.isSafeInteger(row.revision)||row.revision<1||key==='notes'&&(!Number.isSafeInteger(row.layout_revision)||row.layout_revision<0))throw invalid();}
  }
  for(const name of ['source_note_id','target_note_id','source_group_id','target_group_id','group_id'])if(Object.hasOwn(c,name))id(c[name]);
  for(const name of ['selected_ids','note_ids'])if(Object.hasOwn(c,name))ids(c[name]);
  if(Object.hasOwn(c,'before_note_id')&&c.before_note_id!==null)id(c.before_note_id);
  if(c.kind==='extract'){
    if(!['group','individual'].includes(c.result)||!Array.isArray(c.placements)||c.placements.length!==(c.result==='group'?1:c.selected_ids.length)||c.result==='group'&&c.selected_ids.length<2)throw invalid();c.placements.forEach(rectangle);
  }
  if(c.kind==='arrange'){
    if(typeof c.include_locked!=='boolean'||!Array.isArray(c.items)||!c.items.length)throw invalid();if(c.items.length>500)throw limit();
    const seen=new Set();for(const item of c.items){fields(item,['kind','id','layout']);id(item.id);if(!['note','group'].includes(item.kind)||seen.has(`${item.kind}:${item.id}`))throw invalid();seen.add(`${item.kind}:${item.id}`);rectangle(item.layout);}
  }
  if(c.kind==='undo'){operationId(c.undo_operation_id);if(c.expected.groups.length||c.expected.notes.length)throw invalid();}
}

/** Re-resolve both authority and receipt context inside the write transaction.
 * A request snapshot never revives a revoked device or expired personal lease. */
export function currentNoteGroupPrincipal(d,principal) {
  const request=object(principal)?principal:{authUserId:actorId(principal)};
  if(!deviceRequestStillValid(d,request))throw Object.assign(noteError('Sign-in has changed. Reload before trying again.',409),{reason:'device_context_changed'});
  const context=readDeviceContext(d,request,{expire:false}),device=noteDevice(principal);
  let current=request;
  if(device){
    const row=d.prepare("SELECT * FROM household_devices WHERE id=? AND status='active'").get(device.id);
    if(!row||context&&context.device.id!==row.id)throw noteError('Sign-in has changed. Reload before trying again.',401);
    current={...request,devicePrincipal:devicePrincipal(row)};
  }else if(!d.prepare('SELECT id FROM users WHERE id=?').get(actorId(principal)))throw noteError('Sign-in is no longer available.',401);
  current={...current,_noteGroupReceiptContext:context?{credential:context.credential.id,context:context.credential.context_key,revision:context.device.revision}:null};
  assertNoteAction(d,current,null,'view');assertNoteAction(d,current,null,'edit');return current;
}
function authorize(d,p,noteIds){
  if(noteIds.size>500)throw limit();
  for(const noteId of noteIds){
    const note=d.prepare('SELECT * FROM notes WHERE id=?').get(noteId);if(!note)throw unavailable();
    try{assertNoteAction(d,p,note,'view');assertNoteAction(d,p,note,'edit');}
    catch(error){if(error.status===404)throw unavailable();throw error;}
  }
}
function receiptScope(receipt){return {noteIds:new Set([...receipt.before.notes,...receipt.after.notes].map(n=>n.id)),groupIds:new Set([...receipt.before.groups,...receipt.after.groups].map(g=>g.id))};}
function expectedMatches(d,ownerKey,c,noteIds,groups){
  const sort=rows=>[...rows].sort((a,b)=>a.id-b.id);
  const expected={groups:sort([...groups.values()].map(g=>({id:g.id,revision:g.revision}))),notes:sort([...noteIds].map(id=>({id,revision:d.prepare('SELECT revision FROM notes WHERE id=?').get(id).revision,layout_revision:readNoteOwnerLayout(d,ownerKey,id)?.revision??0})))};
  if(!equal(expected,{groups:sort(c.expected.groups).map(({id,revision})=>({id,revision})),notes:sort(c.expected.notes).map(({id,revision,layout_revision})=>({id,revision,layout_revision}))}))throw conflict();
}
function orderedSelection(group,selected){if(selected.some(id=>!group.member_ids.includes(id)))throw invalid();return group.member_ids.filter(id=>selected.includes(id));}
function insertBefore(members,selected,before){const rest=members.filter(id=>!selected.includes(id)),index=before===null?rest.length:rest.indexOf(before);if(index<0)throw invalid();return [...rest.slice(0,index),...selected,...rest.slice(index)];}
function persistGroups(d,ownerKey,before,groups){
  const changed=[...groups.values()].filter(g=>{
    const old=before.groups.find(row=>row.id===g.id);return !old||old.missing||!equal(old.member_ids,g.member_ids)||!equal(old.layout,g.layout);
  });
  // Clear affected membership before reinsertion. This collision-free empty
  // sequence handles both cross-group moves and arbitrary page permutations.
  for(const g of changed)d.prepare('DELETE FROM note_board_group_members WHERE owner_key=? AND group_id=?').run(ownerKey,g.id);
  for(const g of changed){
    const old=before.groups.find(row=>row.id===g.id);
    if(g.member_ids.length<2){d.prepare('DELETE FROM note_board_groups WHERE owner_key=? AND id=?').run(ownerKey,g.id);continue;}
    const l=g.layout;
    if(old&&!old.missing)d.prepare('UPDATE note_board_groups SET x=?,y=?,width=?,height=?,position_locked=?,always_on_top=?,revision=revision+1 WHERE owner_key=? AND id=?').run(l.x,l.y,l.width,l.height,+l.position_locked,+l.always_on_top,ownerKey,g.id);
    else if(!readNoteOwnerGroup(d,ownerKey,g.id))d.prepare('INSERT INTO note_board_groups(owner_key,id,revision,x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?,?,?,?)').run(ownerKey,g.id,g.revision,l.x,l.y,l.width,l.height,+l.position_locked,+l.always_on_top);
    g.member_ids.forEach((noteId,ordinal)=>d.prepare('INSERT INTO note_board_group_members(owner_key,note_id,group_id,ordinal) VALUES(?,?,?,?)').run(ownerKey,noteId,g.id,ordinal));
  }
}

export function applyNoteGroupCommand(d,principal,command) {
  return d.transaction(()=>{
    if(process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS==='0')throw noteError('Notes arrangement is temporarily unavailable. You can still edit note content.',503);
    const p=currentNoteGroupPrincipal(d,principal);validateCommand(command);
    const ownerKey=noteLayoutOwnerKey(p),key=groupReceiptPrincipalKey(p),prior=readGroupReceipt(d,ownerKey,key,command.operation_id);
    if(prior){
      // Receipt structure is internal metadata, never a cached board response.
      // Always authorize its full scope before acknowledging an ID or payload.
      authorize(d,p,receiptScope(prior).noteIds);
      if(prior.legacy||prior.hash!==groupRequestHash(command))throw conflict();
      return {operation_id:command.operation_id,replayed:true,board:readGroupedNoteBoard(d,p),undo_available:groupStructureMatches(d,ownerKey,prior.after)};
    }
    let undo;
    const noteIds=new Set(),groups=new Map();
    const useGroup=groupId=>{
      if(groups.has(groupId))return groups.get(groupId);
      const row=readNoteOwnerGroup(d,ownerKey,groupId);if(!row)throw unavailable();
      const group={id:row.id,revision:row.revision,layout:groupLayout(row),member_ids:readGroupMembers(d,ownerKey,groupId)};groups.set(groupId,group);group.member_ids.forEach(id=>noteIds.add(id));return group;
    };
    if(command.kind==='undo'){
      undo=readGroupReceipt(d,ownerKey,key,command.undo_operation_id);if(!undo)throw unavailable();
      const scope=receiptScope(undo);scope.noteIds.forEach(id=>noteIds.add(id));authorize(d,p,noteIds);
      if(undo.legacy||!groupStructureMatches(d,ownerKey,undo.after))throw conflict();
      for(const id of scope.groupIds){const row=readNoteOwnerGroup(d,ownerKey,id);groups.set(id,row?{id,revision:row.revision,layout:groupLayout(row),member_ids:readGroupMembers(d,ownerKey,id)}:{id,missing:true});}
    }else{
      for(const field of ['source_group_id','target_group_id','group_id'])if(Object.hasOwn(command,field))useGroup(command[field]);
      for(const field of ['source_note_id','target_note_id'])if(Object.hasOwn(command,field))noteIds.add(command[field]);
      command.note_ids?.forEach(id=>noteIds.add(id));
      for(const item of command.items||[])item.kind==='group'?useGroup(item.id):noteIds.add(item.id);
      authorize(d,p,noteIds);expectedMatches(d,ownerKey,command,noteIds,groups);
    }
    const layouts=new Map(readNoteBoard(d,p).notes.map(n=>[n.id,n.layout]));
    ensureNoteLayoutOwner(d,ownerKey);
    const before=captureGroupStructure(d,ownerKey,noteIds,groups.keys(),layouts),noteLayouts=new Map();
    const standalone=id=>{if(readNoteGroup(d,ownerKey,id))throw conflict();return layouts.get(id);};
    const movable=id=>{const l=standalone(id);if(l.position_locked)throw noteError('Unlock the source note before moving it.',409);return l;};
    const newGroup=(members,layout)=>{
      const l=groupLayout(layout),id=nextNoteGroupId(d,ownerKey);
      groups.set(id,{id,revision:1,layout:l,member_ids:members});before.groups.push({id,missing:true});before.groups.sort((a,b)=>a.id-b.id);return id;
    };
    const c=command;
    switch(c.kind){
      case 'create': {
        const target=standalone(c.target_note_id);if(!target.position_locked)throw noteError('Choose a pinned target note.',409);
        let selected;
        if(Object.hasOwn(c,'source_note_id')){if(c.source_note_id===c.target_note_id)throw invalid();movable(c.source_note_id);selected=[c.source_note_id];}
        else {const source=groups.get(c.source_group_id);selected=orderedSelection(source,c.selected_ids);source.member_ids=source.member_ids.filter(id=>!selected.includes(id));}
        newGroup([c.target_note_id,...selected],target);break;
      }
      case 'reorder': {const g=groups.get(c.group_id),selected=orderedSelection(g,c.selected_ids);g.member_ids=insertBefore(g.member_ids,selected,c.before_note_id);break;}
      case 'transfer': {
        const source=groups.get(c.source_group_id),target=groups.get(c.target_group_id),selected=orderedSelection(source,c.selected_ids);
        source.member_ids=source.member_ids.filter(id=>!selected.includes(id));target.member_ids=insertBefore(target.member_ids,selected,c.before_note_id);break;
      }
      case 'join': {c.note_ids.forEach(movable);const target=groups.get(c.target_group_id);target.member_ids=insertBefore(target.member_ids,c.note_ids,c.before_note_id);break;}
      case 'extract': {
        const source=groups.get(c.source_group_id),selected=orderedSelection(source,c.selected_ids);
        for(const placement of c.placements)if(placement.position_locked||placement.width!==source.layout.width||placement.height!==source.layout.height||placement.always_on_top!==source.layout.always_on_top)throw invalid();
        source.member_ids=source.member_ids.filter(id=>!selected.includes(id));
        if(c.result==='group')newGroup(selected,c.placements[0]);else selected.forEach((id,i)=>noteLayouts.set(id,rectangle(c.placements[i])));break;
      }
      case 'arrange': {
        for(const item of c.items){
          const current=item.kind==='group'?groups.get(item.id).layout:standalone(item.id),next=rectangle(item.layout);
          if(current.position_locked&&next.position_locked&&!c.include_locked&&(next.x!==current.x||next.y!==current.y))throw noteError('Unlock the position before moving it.',409);
          if(item.kind==='group')groups.get(item.id).layout=next;
          else if(!equal(groupLayout(current),next))noteLayouts.set(item.id,next);
        }break;
      }
      case 'undo': {
        for(const previous of undo.before.groups){
          const current=groups.get(previous.id);
          groups.set(previous.id,previous.missing?{id:previous.id,member_ids:[],layout:current?.layout}:structuredClone({...previous,revision:Math.max(previous.revision,current?.revision??0)+1}));
        }
        for(const n of undo.before.notes){
          const after=undo.after.notes.find(row=>row.id===n.id);
          if(!equal(n.stored_layout,after.stored_layout)||n.layout_revision!==after.layout_revision||n.group_id===null&&after.group_id!==null)noteLayouts.set(n.id,n.stored_layout||n.layout);
        }break;
      }
    }
    // Actual canonical cardinality, never a filtered visible subset, controls
    // dissolution. A survivor inherits the container even if its old pin differs.
    for(const g of groups.values())if(g.member_ids.length===1)noteLayouts.set(g.member_ids[0],g.layout);
    persistGroups(d,ownerKey,before,groups);
    for(const note of before.notes){
      const membershipChanged=note.group_id!==(readNoteGroup(d,ownerKey,note.id)?.id??null);
      const layout=noteLayouts.get(note.id)||(membershipChanged?(note.stored_layout||note.layout):null);
      if(layout)writeNoteGroupLayout(d,ownerKey,note.id,layout,{forceRevision:membershipChanged});
    }
    const after=captureGroupStructure(d,ownerKey,noteIds,groups.keys(),layouts);
    saveGroupReceipt(d,ownerKey,key,c,before,after);
    return {operation_id:c.operation_id,replayed:false,board:readGroupedNoteBoard(d,p),undo_available:true};
  }).immediate();
}
