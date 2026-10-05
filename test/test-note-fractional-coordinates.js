import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,command,rect,state} from './helpers/note-group-fixture.mjs';
import {readNote,setNoteLayout,setNoteLayouts,updateNote,mutateNote} from '../server/services/note-board.js';
import {applyNoteGroupCommand as apply,readGroupedNoteBoard} from '../server/services/note-groups.js';
import {addNoteLayoutStateSchema} from '../server/services/note-layout-state-schema.js';
import {addNoteGroupSchema} from '../server/services/note-group-schema.js';

const geometry={x:1.23456789012345,y:1/3,width:4,height:6};
const throwsWithoutWrites=(d,action,status)=>{const before=state(d);assert.throws(action,error=>error.status===status);assert.deepEqual(state(d),before);};

test('standalone fractional coordinates survive flags, no-op, CAS and independent dashboard pin changes',()=>{
  const {d}=fixture(2);try{
    const first=setNoteLayout(d,1,1,{expected_layout_revision:0,layout:geometry});
    assert.equal(first.x,geometry.x);assert.equal(first.y,geometry.y);
    assert.deepEqual(d.prepare('SELECT typeof(x) x,typeof(y) y FROM note_layouts WHERE note_id=1').get(),{x:'real',y:'real'});
    const pinned=setNoteLayout(d,1,1,{expected_layout_revision:1,position_locked:true,always_on_top:true});
    assert.equal(pinned.x,geometry.x);assert.equal(pinned.y,geometry.y);
    const before=state(d);assert.equal(setNoteLayout(d,1,1,{expected_layout_revision:2,layout:geometry}).revision,2);assert.deepEqual(state(d),before);
    throwsWithoutWrites(d,()=>setNoteLayout(d,1,1,{expected_layout_revision:1,layout:{...geometry,x:2.75}}),409);
    throwsWithoutWrites(d,()=>setNoteLayout(d,1,1,{expected_layout_revision:2,layout:{...geometry,x:geometry.x+0.01}}),409);
    const resized=setNoteLayout(d,1,1,{expected_layout_revision:2,layout:{...geometry,width:5}});
    assert.equal(resized.x,geometry.x);assert.equal(resized.y,geometry.y);
    const dashboard=mutateNote(d,1,1,'pin',{});assert.deepEqual(dashboard.layout,readNote(d,1,1).layout);assert.equal(dashboard.layout.x,geometry.x);
    const batch=setNoteLayouts(d,1,{items:[{note_id:2,expected_layout_revision:0,layout:{...geometry,x:9999.999999,y:0.000001}}]});
    assert.equal(batch[0].x,9999.999999);assert.equal(batch[0].y,0.000001);
  }finally{d.close();}
});

test('fractional mixed arrange receipts replay exactly, reject collisions and stale changes, and undo exactly',()=>{
  const {d,group}=fixture(3);try{
    const original=rect({x:20.125,y:30.375,position_locked:true}),id=group([1,2],original);
    const target=rect({...geometry,position_locked:true}),noteTarget=rect({x:9.000000000000002,y:5.625});
    const fields={items:[{kind:'group',id,layout:target},{kind:'note',id:3,layout:noteTarget}],include_locked:true};
    const frozen=command(d,'arrange',fields,[1,2,3],[id]);
    throwsWithoutWrites(d,()=>apply(d,1,{...frozen,include_locked:false}),409);
    const result=apply(d,1,frozen);assert.deepEqual(result.board.groups[0].layout,target);assert.equal(result.board.notes.find(note=>note.id===3).layout.x,noteTarget.x);
    const after=state(d);assert.equal(apply(d,1,structuredClone(frozen)).replayed,true);assert.deepEqual(state(d),after);
    const collision=structuredClone(frozen);collision.items[0].layout.x+=0.0001;throwsWithoutWrites(d,()=>apply(d,1,collision),409);
    throwsWithoutWrites(d,()=>apply(d,1,{...frozen,operation_id:'stale-fraction'}),409);
    const receipt=JSON.parse(d.prepare('SELECT after_json FROM note_group_receipts WHERE operation_id=?').get(frozen.operation_id).after_json);
    assert.deepEqual(receipt.groups.find(value=>value.id===id).layout,target);
    const undo=apply(d,1,command(d,'undo',{undo_operation_id:frozen.operation_id},[]));assert.deepEqual(undo.board.groups[0].layout,original);
    assert.equal(d.prepare('SELECT typeof(x) type FROM note_groups WHERE id=?').get(id).type,'real');
  }finally{d.close();}
});

for(const resultKind of ['group','individual'])test(`fractional extraction to ${resultKind} and singleton dissolution preserve exact anchors`,()=>{
  const {d,group}=fixture(3);try{
    const anchor=rect({...geometry,x:11.125,y:19.875,position_locked:true}),id=group([1,2,3],anchor),placement=rect({...geometry});
    const placements=resultKind==='group'?[placement]:[placement,{...placement,x:4.125}];
    const result=apply(d,1,command(d,'extract',{source_group_id:id,selected_ids:[1,2],result:resultKind,placements},[1,2,3],[id]));
    if(resultKind==='group')assert.deepEqual(result.board.groups[0].layout,placement);
    else for(const [index,noteId] of [1,2].entries()){
      const {revision,...layout}=result.board.notes.find(note=>note.id===noteId).layout;
      assert.ok(revision>0);assert.deepEqual(layout,placements[index]);
    }
    const survivor=result.board.notes.find(note=>note.id===3).layout;assert.equal(survivor.x,anchor.x);assert.equal(survivor.y,anchor.y);assert.equal(survivor.position_locked,true);
  }finally{d.close();}
});

test('fractional validators reject non-numbers, non-finite values, out-of-range values and fractional dimensions atomically',()=>{
  const {d,group}=fixture(3);try{
    const id=group([1,2]);
    const bad=[...['x','y'].flatMap(key=>[NaN,Infinity,-Infinity,'1.25',null,true,-0.001,10000.001].map(value=>({[key]:value}))),{width:4.5},{height:6.25}];
    for(const invalid of bad){
      throwsWithoutWrites(d,()=>setNoteLayout(d,1,3,{expected_layout_revision:0,layout:{...geometry,...invalid}}),400);
      throwsWithoutWrites(d,()=>apply(d,1,command(d,'arrange',{items:[{kind:'group',id,layout:rect({...geometry,...invalid})}],include_locked:true},[1,2],[id])),400);
    }
  }finally{d.close();}
});

test('recovery blocks fractional structural writes and ordinary edits/deletion cleanup never snap stored coordinates',()=>{
  const {d,group}=fixture(3);const previous=process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS;try{
    const anchor=rect({...geometry,position_locked:true}),id=group([1,2],anchor);
    setNoteLayout(d,1,3,{expected_layout_revision:0,layout:geometry});
    process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS='0';
    throwsWithoutWrites(d,()=>apply(d,1,command(d,'arrange',{items:[{kind:'group',id,layout:rect({x:7.25,y:8.75})}],include_locked:true},[1,2],[id])),503);
    updateNote(d,1,1,{expected_revision:1,content:'Synthetic recovery edit'});mutateNote(d,1,1,'pin',{});
    assert.deepEqual(readGroupedNoteBoard(d,1).groups[0].layout,anchor);
    const flags=setNoteLayout(d,1,3,{expected_layout_revision:1,always_on_top:true});assert.equal(flags.x,geometry.x);assert.equal(flags.y,geometry.y);
    mutateNote(d,1,1,'delete');const survivor=readNote(d,1,2).layout;assert.equal(survivor.x,geometry.x);assert.equal(survivor.y,geometry.y);
  }finally{if(previous===undefined)delete process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS;else process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS=previous;d.close();}
});

test('existing 10051 and 10052 SQLite schemas persist REAL coordinates in encrypted files without a new migration',()=>{
  const folder=mkdtempSync(join(tmpdir(),'note-fractional-schema-')),file=join(folder,'synthetic.db');let d;
  const open=()=>{const db=new Database(file);db.pragma("cipher='sqlcipher'");db.pragma("key='synthetic-fractional-key'");db.pragma('foreign_keys=ON');return db;};
  try{
    d=open();d.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY); INSERT INTO notes VALUES(1),(2); CREATE TABLE note_change_clock(id INTEGER PRIMARY KEY,version INTEGER NOT NULL); INSERT INTO note_change_clock VALUES(1,0); CREATE TABLE note_layouts(note_id INTEGER PRIMARY KEY REFERENCES notes(id),x INTEGER NOT NULL,y INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1); INSERT INTO note_layouts VALUES(1,8,73,4,6,9);');
    addNoteLayoutStateSchema(d);addNoteGroupSchema(d);
    const old=d.prepare('SELECT * FROM note_layouts WHERE note_id=1').get(),schema=d.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height) VALUES(2,?,?,4,6)').run(geometry.x,geometry.y);
    d.prepare('INSERT INTO note_groups(x,y,width,height) VALUES(?,?,4,6)').run(geometry.x,geometry.y);
    d.close();d=open();
    for(const table of ['note_layouts','note_groups']){const row=d.prepare(`SELECT x,y,typeof(x) xt,typeof(y) yt FROM ${table} WHERE x=?`).get(geometry.x);assert.deepEqual(row,{x:geometry.x,y:geometry.y,xt:'real',yt:'real'});}
    assert.deepEqual(d.prepare('SELECT * FROM note_layouts WHERE note_id=1').get(),old);assert.deepEqual(d.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),schema);
    assert.equal(d.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{d?.close();rmSync(folder,{recursive:true,force:true});}
});
