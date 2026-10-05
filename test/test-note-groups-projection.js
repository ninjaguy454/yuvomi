import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {readGroupedNoteBoard} from '../server/services/note-groups.js';
import {readGroupMembers} from '../server/services/note-group-store.js';
import {readNoteBoard,readNote,updateNote,readNoteMembers} from '../server/services/note-board.js';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-note-groups-projection';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
function fixture(){
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  for(const id of [1,2,3])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'x','member')").run(id,`member${id}`,`Member ${id}`);
  d.exec("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Synthetic display','{}','{}','{}')");
  const note=(title,visibility='all',owner=1)=>updateNote(d,owner,null,{title,content:`Body ${title}`,visibility,...(visibility==='selected'?{access_user_ids:[2]}:{})});
  const group=(ids,rect={x:40,y:50,width:8,height:10,position_locked:1,always_on_top:1})=>{
    const id=Number(d.prepare('INSERT INTO note_groups(x,y,width,height,position_locked,always_on_top) VALUES(?,?,?,?,?,?)').run(rect.x,rect.y,rect.width,rect.height,rect.position_locked,rect.always_on_top).lastInsertRowid);
    ids.forEach((noteId,i)=>d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,?,?)').run(noteId,id,i*3));return id;
  };
  const device={kind:'device',id:99,status:'active',scope:{member_ids:[1]},permissions:{modules:{notes:'write'},capabilities:{'device_notes.view':'allow','device_notes.edit':'allow'}}};
  return {d,note,group,device};
}
// Legacy seed fixtures deliberately exercise read-only projection for uninitialized owners.
const state=d=>({scoped:Object.fromEntries(['note_board_owners','note_board_note_layouts','note_board_groups','note_board_group_members','note_board_group_receipts'].map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()])),changes:d.prepare('SELECT total_changes() n').get().n,clock:d.prepare('SELECT version FROM note_change_clock').get().version,members:d.prepare('SELECT * FROM note_group_members ORDER BY group_id,ordinal').all(),groups:d.prepare('SELECT * FROM note_groups ORDER BY id').all(),layouts:d.prepare('SELECT * FROM note_layouts ORDER BY note_id').all()});
const ids=board=>board.notes.map(n=>n.id).sort((a,b)=>a-b);
const rect={x:40,y:50,width:8,height:10,position_locked:true,always_on_top:true};

test('Everyone device sees a mixed group singleton without hidden content, IDs or counts',()=>{
  const {d,note,group,device}=fixture();try{
    const publicNote=note('PUBLIC'),privateNote=note('PRIVATE SECRET','private'),mixedGroup=group([privateNote.id,publicNote.id]);
    const projectEveryoneDevice=()=>{const board=readGroupedNoteBoard(d,device);return {...board,visibleNoteIds:ids(board)};};
    const before=state(d);
    assert.deepEqual(projectEveryoneDevice(mixedGroup).visibleNoteIds,[publicNote.id]);
    assert.equal(projectEveryoneDevice(mixedGroup).groups.length,0);
    assert.equal(JSON.stringify(projectEveryoneDevice(mixedGroup)).includes(privateNote.title),false);
    const projected=projectEveryoneDevice().notes[0];assert.deepEqual(projected.layout,{...rect,revision:0});
    assert.equal(projected.permissions.arrange,false);assert.equal(projected.permissions.edit,true);
    assert.equal('group_id' in projected,false);assert.equal('member_ids' in projected,false);
    assert.deepEqual(state(d),before);assert.deepEqual(readGroupMembers(d,'human:1',mixedGroup),[privateNote.id,publicNote.id]);
  }finally{d.close();}
});

test('partial groups have dense visible order and cannot manage hidden canonical members',()=>{
  const {d,note,group,device}=fixture();try{
    const a=note('A'),hidden=note('HIDDEN','private'),selected=note('SELECTED','selected'),b=note('B');
    const id=group([hidden.id,b.id,selected.id,a.id]),before=state(d);
    const visible=readGroupedNoteBoard(d,2);assert.deepEqual(visible.groups,[{id,revision:1,layout:rect,member_ids:[b.id,selected.id,a.id],can_manage:false}]);
    assert.equal(JSON.stringify(visible).includes('HIDDEN'),false);assert.ok(visible.notes.every(n=>n.permissions.arrange===false));
    assert.deepEqual(readGroupedNoteBoard(d,device).groups[0].member_ids,[b.id,a.id]);
    const owner=readGroupedNoteBoard(d,1);assert.deepEqual(owner.groups[0].member_ids,[hidden.id,b.id,selected.id,a.id]);assert.equal(owner.groups[0].can_manage,true);
    assert.equal(owner.notes.find(n=>n.id===hidden.id).permissions.manage_visibility,true);assert.deepEqual(state(d),before);
  }finally{d.close();}
});

test('permission changes alter projection without dissolving or reordering stored groups',()=>{
  const {d,note,group}=fixture();try{
    const a=note('A'),b=note('B','selected'),c=note('C','private'),id=group([a.id,b.id,c.id]);
    assert.equal(readGroupedNoteBoard(d,2).groups.length,1);
    d.prepare('DELETE FROM note_access WHERE note_id=? AND user_id=2').run(b.id);let before=state(d);
    assert.equal(readGroupedNoteBoard(d,2).groups.length,0);assert.deepEqual(ids(readGroupedNoteBoard(d,2)),[a.id]);assert.deepEqual(state(d),before);
    d.prepare("UPDATE notes SET visibility='all' WHERE id IN (?,?)").run(b.id,c.id);before=state(d);
    const board=readGroupedNoteBoard(d,2);assert.deepEqual(board.groups[0].member_ids,[a.id,b.id,c.id]);assert.equal(board.groups[0].can_manage,true);assert.deepEqual(state(d),before);
    d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','notes','read')").run();
    assert.equal(readGroupedNoteBoard(d,2).groups[0].can_manage,false);
    d.prepare("UPDATE access_permissions SET access='none' WHERE subject_type='user' AND subject_id='2' AND resource_key='notes'").run();
    assert.throws(()=>readGroupedNoteBoard(d,2),e=>e.status===403);assert.deepEqual(readGroupMembers(d,'human:1',id),[a.id,b.id,c.id]);
  }finally{d.close();}
});

test('packing uses displayed group units and ignores hidden groups and obsolete member rectangles',()=>{
  const {d,note,group}=fixture();try{
    const a=note('A'),b=note('B'),hidden=note('HIDDEN','private'),hidden2=note('HIDDEN2','private');
    const groupId=group([a.id,b.id],{x:0,y:0,width:8,height:10,position_locked:0,always_on_top:0});
    group([hidden.id,hidden2.id],{x:0,y:10000,width:12,height:100,position_locked:0,always_on_top:0});
    d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,revision) VALUES(?,8,0,4,100,7)').run(a.id);
    d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,revision) VALUES(?,0,10,12,100,8)').run(b.id);
    const standalone=note('Standalone'),before=state(d),board=readGroupedNoteBoard(d,2);
    assert.equal(board.groups.length,1);assert.equal(board.groups[0].id,groupId);
    assert.deepEqual(board.notes.find(n=>n.id===standalone.id).layout,{x:8,y:0,width:4,height:6,revision:0,position_locked:false,always_on_top:false});
    for(const n of board.notes){assert.deepEqual(readNote(d,2,n.id).layout,n.layout);assert.deepEqual(readNoteBoard(d,2).notes.find(v=>v.id===n.id).layout,n.layout);}
    assert.equal(board.notes.find(n=>n.id===a.id).layout.revision,7);assert.equal(board.notes.find(n=>n.id===standalone.id).permissions.arrange,true);
    assert.ok(board.notes.every(n=>n.layout.y<10000));assert.deepEqual(state(d),before);
    d.prepare('UPDATE note_group_members SET ordinal=9 WHERE note_id=?').run(a.id);
    assert.deepEqual(readGroupedNoteBoard(d,2).groups[0].layout,board.groups[0].layout);
  }finally{d.close();}
});

test('empty and wholly private groups reveal no group extent or membership',()=>{
  const {d,note,group}=fixture();try{
    group([]);const a=note('SECRET1','private'),b=note('SECRET2','private');group([a.id,b.id]);const before=state(d);
    assert.deepEqual(readGroupedNoteBoard(d,2),{notes:[],groups:[]});assert.deepEqual(state(d),before);
  }finally{d.close();}
});

test('guest recipients and foreign household IDs stay excluded by existing audience checks',()=>{
  const {d,note,group}=fixture();try{
    // Guest identities remain household-local records, but cannot be note recipients.
    d.exec("INSERT INTO split_expense_guest_users(user_id) VALUES(3)");
    assert.ok(!readNoteMembers(d,1).some(m=>m.id===3));
    for(const recipient of [3,999])assert.throws(()=>updateNote(d,1,null,{content:'invalid',visibility:'selected',access_user_ids:[recipient]}));
    const a=note('A'),b=note('B','selected');group([a.id,b.id]);assert.throws(()=>readGroupedNoteBoard(d,999));
    assert.deepEqual(ids(readGroupedNoteBoard(d,2)),[a.id,b.id]);
  }finally{d.close();}
});
