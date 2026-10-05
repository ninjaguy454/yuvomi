import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-note-layout-state';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {readNote,readNoteBoard,setNoteLayout,setNoteLayouts,mutateNote}=await import('../server/services/note-board.js');
const {devicePreset,normalizeDevicePermissions}=await import('../server/services/devices.js');
const d=get();
d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'layout-owner','Owner','x','member'),(2,'layout-other','Other','x','member'); INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Layout display','{}','{}','{}')");
const shape={x:0,y:0,width:4,height:6};
const make=(visibility='all',pinned=0)=>Number(d.prepare('INSERT INTO notes(content,created_by,visibility,pinned) VALUES(?,1,?,?)').run('Synthetic layout note',visibility,pinned).lastInsertRowid);
const clock=()=>d.prepare('SELECT version FROM note_change_clock WHERE id=1').get().version;
const patch=(id,revision,changes)=>setNoteLayout(d,1,id,{expected_layout_revision:revision,...changes});

test('unsaved layouts expose false boolean flags without a read-time write',()=>{
  const id=make(),before=clock(),n=readNote(d,1,id);
  assert.equal(n.layout.position_locked,false);assert.equal(n.layout.always_on_top,false);assert.equal(n.layout.revision,0);
  assert.equal(clock(),before);assert.equal(d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(id),undefined);
});
test('first flag mutation saves the authorized projection and leaves content and dashboard pin intact',()=>{
  const hidden=make('private');patch(hidden,0,{layout:{...shape,x:20,y:40}});
  const id=make('all',1),before=readNote(d,2,id),content=d.prepare('SELECT * FROM notes WHERE id=?').get(id);
  const after=setNoteLayout(d,2,id,{expected_layout_revision:0,position_locked:true});
  for(const key of ['x','y','width','height'])assert.equal(after[key],before.layout[key],key);
  assert.equal(after.position_locked,true);assert.equal(after.always_on_top,false);assert.equal(after.revision,1);
  assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(id),content);
  assert.equal(readNote(d,1,id).layout.position_locked,true);
});
test('layout flags and geometry share CAS while legacy clients preserve flags',()=>{
  const id=make();patch(id,0,{layout:shape,position_locked:true,always_on_top:true});
  const resized=patch(id,1,{layout:{...shape,width:6,height:8}});
  assert.equal(resized.revision,2);assert.equal(resized.position_locked,true);assert.equal(resized.always_on_top,true);
  assert.throws(()=>patch(id,1,{always_on_top:false}),e=>e.status===409);
  const unlocked=patch(id,2,{position_locked:false,layout:{...shape,x:30}});
  assert.equal(unlocked.x,30);assert.equal(unlocked.position_locked,false);assert.equal(unlocked.always_on_top,true);
  assert.equal(unlocked.revision,3);
});
test('locked position rejects movement and permits resize at the same x/y',()=>{
  const id=make();patch(id,0,{layout:shape,position_locked:true});const before=clock();
  for(const changed of [{...shape,x:1},{...shape,y:1}])assert.throws(()=>patch(id,1,{layout:changed}),e=>e.status===409);
  assert.equal(clock(),before);assert.equal(patch(id,1,{layout:{...shape,width:8}}).revision,2);
});
test('explicit bulk include_locked moves a card and retains its lock',()=>{
  const id=make();patch(id,0,{layout:shape,position_locked:true});
  const items=[{note_id:id,expected_layout_revision:1,layout:{...shape,x:150,y:200}}];
  assert.throws(()=>setNoteLayouts(d,1,{items}),e=>e.status===409);
  const [after]=setNoteLayouts(d,1,{items,include_locked:true});
  assert.equal(after.position_locked,true);assert.equal(after.x,150);assert.equal(after.revision,2);
});
test('no-op geometry and flags do not change layout revision or change clock',()=>{
  const id=make();patch(id,0,{layout:shape,position_locked:true,always_on_top:true});const before=clock();
  assert.equal(patch(id,1,{layout:shape,position_locked:true,always_on_top:true}).revision,1);
  assert.equal(patch(id,1,{always_on_top:true}).revision,1);assert.equal(clock(),before);
});
test('false flag-only no-op on an unsaved projection keeps revision zero without a write',()=>{
  const id=make(),before=clock(),initial=readNote(d,1,id).layout;
  const after=patch(id,0,{position_locked:false,always_on_top:false});
  assert.deepEqual(after,{note_id:id,...initial});assert.equal(clock(),before);assert.equal(d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(id),undefined);
});
test('strict flags, geometry, unknown fields and missing mutations are rejected',()=>{
  const id=make(),before=clock();
  for(const body of [{},{position_locked:null},{position_locked:1},{always_on_top:'true'},{always_on_top:0},{layout:null},{layout:shape,include_locked:true},{extra:true},{expected_revision:0,position_locked:true}])assert.throws(()=>patch(id,0,body),e=>e.status===400);
  for(const body of [{include_locked:1},{include_locked:null},{unknown:true}])assert.throws(()=>setNoteLayouts(d,1,{items:[{note_id:id,expected_layout_revision:0,layout:shape}],...body}),e=>e.status===400);
  assert.equal(clock(),before);
});
test('widened coordinates accept the upper x/y boundary and reject unsafe geometry',()=>{
  const id=make();assert.equal(patch(id,0,{layout:{...shape,x:10000,y:10000,width:12,height:100}}).x,10000);
  for(const bad of [{x:10001},{y:10001},{x:-1},{width:13},{height:101},{width:3.5}])assert.throws(()=>patch(id,1,{layout:{...shape,...bad}}),e=>e.status===400);
});
test('stale, inaccessible, invalid and locked items fail a batch without partial writes',()=>{
  const a=make(),b=make(),privateId=make('private');patch(a,0,{layout:shape});patch(b,0,{layout:shape,position_locked:true});
  const before=clock(),base={note_id:a,expected_layout_revision:1,always_on_top:true};
  for(const bad of [{note_id:b,expected_layout_revision:0,always_on_top:true},{note_id:b,expected_layout_revision:1,position_locked:1},{note_id:b,expected_layout_revision:1,layout:{...shape,x:4}}])assert.throws(()=>setNoteLayouts(d,1,{items:[base,bad]}),e=>[400,409].includes(e.status));
  assert.throws(()=>setNoteLayouts(d,2,{items:[base,{note_id:privateId,expected_layout_revision:0,position_locked:true}]}),e=>e.status===404);
  assert.equal(readNote(d,1,a).layout.always_on_top,false);assert.equal(clock(),before);
});
test('flag mutation requires independent device view and edit grants',()=>{
  const id=make();
  for(const grants of [[false,true],[true,false],[true,true]]){
    const permissions=devicePreset();permissions.capabilities['device_notes.view']=grants[0]?'allow':'none';permissions.capabilities['device_notes.edit']=grants[1]?'allow':'none';
    const p={kind:'device',id:99,status:'active',permissions:normalizeDevicePermissions(permissions),scope:{}};
    if(grants.every(Boolean))assert.equal(setNoteLayout(d,p,id,{expected_layout_revision:0,position_locked:true}).position_locked,true);
    else assert.throws(()=>setNoteLayout(d,p,id,{expected_layout_revision:0,position_locked:true}),e=>e.status===403);
  }
});
test('hidden saved layouts never affect visible default projections or board extents',()=>{
  const hidden=make('private'),id=make();const before=readNote(d,2,id).layout;
  patch(hidden,0,{layout:{...shape,x:9999,y:9999},always_on_top:true,position_locked:true});
  assert.deepEqual(readNote(d,2,id).layout,before);assert.ok(!readNoteBoard(d,2).notes.some(n=>n.id===hidden));
});
test('dashboard pin toggles do not convert or clear persistent layout flags',()=>{
  const id=make();patch(id,0,{layout:shape,position_locked:true,always_on_top:true});const before=readNote(d,1,id).layout;
  const pinned=mutateNote(d,1,id,'pin',{});assert.equal(pinned.pinned,1);assert.deepEqual(pinned.layout,before);
});
test('two SQLite connections contend flags and geometry on one shared layout CAS',async()=>{
  const id=make();patch(id,0,{layout:shape});const folder=mkdtempSync(join(tmpdir(),'notes-state-race-')),file=join(folder,'synthetic.db');let check;const workers=[];
  try{
    await d.backup(file);
    const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const Database=require('better-sqlite3-multiple-ciphers');const {setNoteLayout}=await import(workerData.service);const d=new Database(workerData.file);d.pragma('busy_timeout=10000');d.pragma('foreign_keys=ON');parentPort.postMessage('ready');parentPort.once('message',()=>{try{parentPort.postMessage({status:200,result:setNoteLayout(d,1,workerData.id,{expected_layout_revision:1,...workerData.changes})});}catch(e){parentPort.postMessage({status:e.status||500});}finally{d.close();}});})();`;
    for(const changes of [{position_locked:true},{layout:{...shape,x:40},always_on_top:true}])workers.push(new Worker(source,{eval:true,workerData:{file,id,changes,service:new URL('../server/services/note-board.js',import.meta.url).href}}));
    await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);})));const pending=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',resolve);w.once('error',reject);}));workers.forEach(w=>w.postMessage('go'));
    const results=await Promise.all(pending);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);check=new Database(file);const row=check.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(id),winner=results.find(r=>r.status===200).result;
    assert.equal(row.revision,2);assert.equal(Boolean(row.position_locked),winner.position_locked);assert.equal(Boolean(row.always_on_top),winner.always_on_top);assert.equal(row.x,winner.x);assert.deepEqual(check.pragma('foreign_key_check'),[]);
  }finally{await Promise.all(workers.map(w=>w.terminate()));check?.close();rmSync(folder,{recursive:true,force:true});}
});
