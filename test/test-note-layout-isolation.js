import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import {createNoteGroupDraft,freezeNoteGroupCommand} from '../public/utils/note-group-draft.js';

process.env.DB_PATH=':memory:';
process.env.SESSION_SECRET='synthetic-layout-isolation';
process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS}=await import('../server/db.js');
const {devicePrincipal}=await import('../server/services/devices.js');
const {readNote,setNoteLayout,setNoteLayouts,updateNote,mutateNote}=await import('../server/services/note-board.js');
const {readGroupedNoteBoard,applyNoteGroupCommand}=await import('../server/services/note-groups.js');

const rectangle=(extra={})=>({x:17.125,y:29.875,width:4,height:6,position_locked:false,always_on_top:false,...extra});
const shape=layout=>Object.fromEntries(Object.keys(rectangle()).map(key=>[key,layout[key]]));
const geometry=layout=>Object.fromEntries(['x','y','width','height'].map(key=>[key,layout[key]]));

function fixture({grouped=false,count=8}={}) {
  const d=new Database(':memory:');d.pragma('foreign_keys=ON');
  for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
  d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'isolation-one','One','x','member'),(2,'isolation-two','Two','x','member')");
  const permissions={modules:{notes:'read'},capabilities:Object.fromEntries(['view','create','edit','delete'].map(action=>[`device_notes.${action}`,'allow']))};
  for(const id of [21,22])d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(?,? ,?,'{}','{}')").run(id,`Isolation display ${id}`,JSON.stringify(permissions));
  for(let id=1;id<=count;id++)d.prepare("INSERT INTO notes(id,title,content,created_by,visibility,pinned) VALUES(?,?,?,1,'all',?)").run(id,`Shared ${id}`,`Exact shared body ${id}\n- [ ] Keep checklist`,+(id===1));
  d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,revision,position_locked,always_on_top) VALUES(1,17.125,29.875,4,6,7,0,1)').run();
  d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height,revision,position_locked,always_on_top) VALUES(8,410.375,510.625,6,8,11,1,1)').run();
  if(grouped){
    d.prepare('INSERT INTO note_groups(id,x,y,width,height,revision,position_locked,always_on_top) VALUES(71,83.125,97.875,4,6,5,1,1)').run();
    for(const [ordinal,note] of [1,2,3].entries())d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,71,?)').run(note,ordinal);
  }
  const actors=[1,2,...[21,22].map(id=>devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(id)))];
  return {d,actors,close:()=>d.close()};
}
const board=(d,actor)=>readGroupedNoteBoard(d,actor);
const layouts=(d,actor)=>board(d,actor).notes.map(note=>({id:note.id,layout:note.layout})).sort((a,b)=>a.id-b.id);
const content=d=>d.prepare('SELECT * FROM notes ORDER BY id').all();
const seed=d=>Object.fromEntries(['note_layouts','note_groups','note_group_members','note_group_receipts'].map(table=>[table,d.prepare(`SELECT * FROM ${table}`).all()]));
const persisted=d=>Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'note_%' OR name='notes' OR name='sqlite_sequence') ORDER BY name").all().map(({name})=>[name,d.prepare(`SELECT * FROM ${name}`).all()]));
function command(d,actor,kind,fields,operationId=randomUUID()) {
  return freezeNoteGroupCommand(createNoteGroupDraft(board(d,actor),operationId),kind,fields);
}
const apply=(d,actor,kind,fields,operationId)=>applyNoteGroupCommand(d,actor,command(d,actor,kind,fields,operationId));
function setLayout(d,actor,id,fields) {
  return setNoteLayout(d,actor,id,{expected_layout_revision:readNote(d,actor,id).layout.revision,...fields});
}
function assertUnchanged(d,actors,before,message) {
  actors.forEach((actor,index)=>assert.deepEqual(board(d,actor),before[index],message));
}

test('two people and two displays independently move, resize, lock and layer the same note',()=>{
  const {d,actors,close}=fixture();try{
    const originalContent=content(d),originalSeed=seed(d);
    for(const [index,actor] of actors.entries()){
      const others=actors.filter(value=>value!==actor),before=others.map(other=>board(d,other));
      const moved=rectangle({x:100.125+index*50,y:200.875+index*30,width:5+index,height:7+index,always_on_top:true});
      setLayout(d,actor,1,{layout:geometry(moved),position_locked:false,always_on_top:true});
      setLayout(d,actor,1,{position_locked:true,always_on_top:index%2===0});
      assert.deepEqual(shape(readNote(d,actor,1).layout),{...moved,position_locked:true,always_on_top:index%2===0});
      assertUnchanged(d,others,before,'another principal retained its own complete board');
    }
    assert.deepEqual(content(d),originalContent,'canvas changes do not edit shared content or dashboard pin');
    assert.deepEqual(seed(d),originalSeed,'ordinary arrangement leaves the legacy seed frozen');
  }finally{close();}
});

test('first write preserves unread seed layouts and groups; later owners still inherit the original seed',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const originalSeed=seed(d),before=board(d,actors[0]),changes=d.prepare('SELECT total_changes() n').get().n;
    for(const actor of actors)board(d,actor);
    assert.equal(d.prepare('SELECT total_changes() n').get().n,changes,'reads never initialize a layout');
    setLayout(d,actors[0],8,{always_on_top:false});
    assert.deepEqual(board(d,actors[0]).groups,before.groups,'initialization retains group IDs, order, revisions and fractional anchor');
    for(const id of [1,2,3])assert.deepEqual(readNote(d,actors[0],id).layout,before.notes.find(note=>note.id===id).layout);
    for(const actor of actors.slice(1)){
      assert.deepEqual(board(d,actor).groups,before.groups);
      assert.deepEqual(readNote(d,actor,8).layout,before.notes.find(note=>note.id===8).layout);
    }
    assert.deepEqual(seed(d),originalSeed);
  }finally{close();}
});

test('layout CAS is shared by sessions of one human and independent across different owners',()=>{
  const {d,actors,close}=fixture();try{
    const original=readNote(d,1,1).layout;
    setNoteLayout(d,{authUserId:1},1,{expected_layout_revision:original.revision,layout:geometry(rectangle({x:310.25}))});
    assert.throws(()=>setNoteLayout(d,{authUserId:1,session:{userId:1}},1,{expected_layout_revision:original.revision,always_on_top:false}),error=>error.status===409);
    for(const [index,actor] of actors.slice(1).entries()){
      const result=setNoteLayout(d,actor,1,{expected_layout_revision:original.revision,layout:geometry(rectangle({x:420.5+index*50}))});
      assert.equal(result.revision,original.revision+1);
    }
    assert.equal(readNote(d,1,1).layout.x,310.25);
    assert.equal(readNote(d,1,1).revision,1);
  }finally{close();}
});

test('the same inherited group has independent membership order and group revisions for all four owners',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const originalSeed=seed(d),originalContent=content(d);
    for(const actor of actors){
      const others=actors.filter(value=>value!==actor),before=others.map(other=>board(d,other));
      const result=apply(d,actor,'reorder',{group_id:71,selected_ids:[3],before_note_id:1});
      assert.deepEqual(result.board.groups[0].member_ids,[3,1,2]);
      assert.equal(result.board.groups[0].revision,6);
      assertUnchanged(d,others,before,'reordering one owner never reorders another owner');
    }
    assert.deepEqual(seed(d),originalSeed);assert.deepEqual(content(d),originalContent);
  }finally{close();}
});

test('bulk layout and mixed Organize preserve every other owner and keep local flags',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const originalSeed=seed(d);
    for(const [index,actor] of actors.entries()){
      const others=actors.filter(value=>value!==actor),before=others.map(other=>board(d,other));
      const result=setNoteLayouts(d,actor,{include_locked:true,items:[4,8].map((note_id,item)=>({note_id,expected_layout_revision:readNote(d,actor,note_id).layout.revision,layout:geometry(rectangle({x:500+index*100+item*10,y:600.25})),position_locked:true,always_on_top:true}))});
      assert.equal(result.length,2);assertUnchanged(d,others,before,'a bulk save only changes its own layout');
      const arranged=apply(d,actor,'arrange',{items:[{kind:'group',id:71,layout:rectangle({x:700.5+index*20,position_locked:true,always_on_top:true})},{kind:'note',id:4,layout:rectangle({x:800.75+index*20,position_locked:true,always_on_top:true})}],include_locked:true});
      assert.equal(arranged.board.groups[0].layout.x,700.5+index*20);
      assert.deepEqual(arranged.board.groups[0].member_ids,[1,2,3]);
      assert.equal(arranged.board.notes.find(note=>note.id===4).layout.position_locked,true);
      assertUnchanged(d,others,before,'Organize does not arrange other owners');
    }
    assert.deepEqual(seed(d),originalSeed);
  }finally{close();}
});

test('each person and display can independently create a group from the same two notes',()=>{
  const {d,actors,close}=fixture();try{
    const originalContent=content(d),originalSeed=seed(d);
    for(const actor of actors){
      const others=actors.filter(value=>value!==actor),before=others.map(other=>board(d,other));
      setLayout(d,actor,1,{position_locked:true});
      const result=apply(d,actor,'create',{source_note_id:2,target_note_id:1});
      assert.equal(result.board.groups.length,1);
      assert.deepEqual(result.board.groups[0].member_ids,[1,2]);
      assert.equal(result.board.groups[0].layout.x,17.125);
      assertUnchanged(d,others,before,'grouping on a personal device leaves the display structure intact');
    }
    assert.deepEqual(content(d),originalContent);assert.deepEqual(seed(d),originalSeed);
  }finally{close();}
});

test('join, transfer and both extractions preserve other memberships and independently dissolve the source',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const originalContent=content(d),originalSeed=seed(d);
    for(const actor of actors){
      const others=actors.filter(value=>value!==actor),before=others.map(other=>board(d,other));
      const local=(kind,fields)=>{const result=apply(d,actor,kind,fields);assertUnchanged(d,others,before,`${kind} changed no other board`);return result.board;};
      local('join',{target_group_id:71,note_ids:[4,5],before_note_id:2});
      assert.deepEqual(board(d,actor).groups.find(group=>group.id===71).member_ids,[1,4,5,2,3]);
      const second=local('create',{source_note_id:6,target_note_id:8}).groups.find(group=>group.id!==71);
      assert.deepEqual(second.member_ids,[8,6]);
      local('transfer',{source_group_id:71,target_group_id:second.id,selected_ids:[5,4],before_note_id:6});
      assert.deepEqual(board(d,actor).groups.find(group=>group.id===second.id).member_ids,[8,4,5,6]);
      const extracted=local('extract',{source_group_id:71,selected_ids:[2,1],result:'group',placements:[rectangle({x:123.125,y:234.375,always_on_top:true})]});
      assert.ok(!extracted.groups.some(group=>group.id===71));
      assert.deepEqual(extracted.groups.find(group=>group.id!==second.id).member_ids,[1,2]);
      assert.deepEqual(shape(readNote(d,actor,3).layout),rectangle({x:83.125,y:97.875,position_locked:true,always_on_top:true}));
      local('extract',{source_group_id:second.id,selected_ids:[5,4],result:'individual',placements:[rectangle({x:321.125,width:6,height:8,always_on_top:true}),rectangle({x:432.25,width:6,height:8,always_on_top:true})]});
      assert.deepEqual(board(d,actor).groups.find(group=>group.id===second.id).member_ids,[8,6]);
      assert.equal(readNote(d,actor,4).layout.x,321.125);
      assert.equal(readNote(d,actor,5).layout.x,432.25);
      assert.equal(readNote(d,actor,4).layout.position_locked,false);
    }
    assert.deepEqual(content(d),originalContent);assert.deepEqual(seed(d),originalSeed);
  }finally{close();}
});

test('identical operation IDs, receipt replay and Undo belong to each independent owner',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const operationId='same-operation-on-four-boards',frozen=actors.map(actor=>command(d,actor,'reorder',{group_id:71,selected_ids:[3],before_note_id:1},operationId));
    for(const [index,actor] of actors.entries()){
      const result=applyNoteGroupCommand(d,actor,frozen[index]);assert.equal(result.replayed,false);
      assert.deepEqual(result.board.groups[0].member_ids,[3,1,2]);
      assert.equal(result.board.groups[0].revision,6);
    }
    const otherBoards=actors.slice(1).map(actor=>board(d,actor));
    const replay=applyNoteGroupCommand(d,actors[0],frozen[0]);assert.equal(replay.replayed,true);assert.equal(replay.undo_available,true);
    const restored=apply(d,actors[0],'undo',{undo_operation_id:operationId});
    assert.deepEqual(restored.board.groups[0].member_ids,[1,2,3]);assert.ok(restored.board.groups[0].revision>6);
    assertUnchanged(d,actors.slice(1),otherBoards,'Undo restores only the authoring layout');
    assert.throws(()=>apply(d,actors[1],'undo',{undo_operation_id:'only-in-another-context'}),error=>[404,409].includes(error.status));
    for(const actor of actors.slice(1)){
      const result=apply(d,actor,'undo',{undo_operation_id:operationId});
      assert.deepEqual(result.board.groups[0].member_ids,[1,2,3]);
    }
  }finally{close();}
});

test('another owner cannot address a newly created group or replay its receipt',()=>{
  const {d,actors,close}=fixture();try{
    setLayout(d,1,1,{position_locked:true});
    const frozen=command(d,1,'create',{source_note_id:2,target_note_id:1},'one-owner-only');
    const created=applyNoteGroupCommand(d,1,frozen),ownerBefore=board(d,1),id=created.board.groups[0].id;
    for(const actor of actors.slice(1)){
      assert.throws(()=>applyNoteGroupCommand(d,actor,{operation_id:randomUUID(),kind:'reorder',expected:{groups:[],notes:[]},group_id:id,selected_ids:[1],before_note_id:null}),error=>error.status===404);
      assert.throws(()=>apply(d,actor,'undo',{undo_operation_id:frozen.operation_id}),error=>[404,409].includes(error.status));
      assert.deepEqual(board(d,1),ownerBefore);
    }
  }finally{close();}
});

test('content edits and dashboard pins remain shared while layout revisions and flags remain independent',()=>{
  const {d,actors,close}=fixture();try{
    for(const [index,actor] of actors.entries())setLayout(d,actor,1,{layout:geometry(rectangle({x:600.125+index*20})),position_locked:index%2===0,always_on_top:index%2!==0});
    const before=actors.map(actor=>layouts(d,actor));
    const updated=updateNote(d,1,1,{expected_revision:1,content:'Updated shared body\n- [x] Keep checklist'});
    assert.equal(updated.revision,2);
    assert.throws(()=>updateNote(d,2,1,{expected_revision:1,content:'Stale overwrite'}),error=>error.status===409);
    for(const actor of actors)assert.equal(readNote(d,actor,1).content,updated.content);
    mutateNote(d,2,1,'pin',{expected_revision:2});
    for(const [index,actor] of actors.entries()){
      assert.equal(readNote(d,actor,1).pinned,0);
      assert.deepEqual(layouts(d,actor),before[index]);
    }
    assert.equal(d.prepare('SELECT count(*) n FROM notes WHERE id=1').get().n,1,'isolation never clones note content');
  }finally{close();}
});

test('shared deletion repairs every owner plus seed and preserves hidden singleton anchors',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    d.prepare('UPDATE notes SET created_by=2 WHERE id=3').run();
    const anchors=actors.map((actor,index)=>rectangle({x:100.125+index*200,y:150.375+index*100,position_locked:true,always_on_top:index%2===0}));
    actors.forEach((actor,index)=>apply(d,actor,'arrange',{items:[{kind:'group',id:71,layout:anchors[index]}],include_locked:true}));
    const revisions=actors.map(actor=>board(d,actor).groups[0].revision);
    updateNote(d,2,3,{expected_revision:readNote(d,2,3).revision,visibility:'private'});
    assert.equal(mutateNote(d,1,1,'delete'),null);
    actors.forEach((actor,index)=>{
      if(actor===2)assert.equal(board(d,actor).groups[0].revision,revisions[index]+1);
      else assert.ok(!JSON.stringify(board(d,actor)).includes('Exact shared body 3'));
    });
    assert.equal(mutateNote(d,1,2,'delete'),null);
    for(const actor of actors)assert.equal(board(d,actor).groups.length,0);
    updateNote(d,2,3,{expected_revision:readNote(d,2,3).revision,visibility:'all'});
    actors.forEach((actor,index)=>assert.deepEqual(shape(readNote(d,actor,3).layout),anchors[index]));
    d.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(9,'late-isolation-owner','Late','x','member')");
    assert.deepEqual(shape(readNote(d,9,3).layout),rectangle({x:83.125,y:97.875,position_locked:true,always_on_top:true}),'uninitialized owners inherit the repaired seed anchor');
    assert.equal(d.prepare('SELECT count(*) n FROM note_groups').get().n,0);
    assert.deepEqual(d.pragma('foreign_key_check'),[]);
  }finally{close();}
});

test('loss of a group member audience removes hidden metadata and blocks stale commands for every affected owner',()=>{
  const {d,actors,close}=fixture({grouped:true});try{
    const frozen=actors.map(actor=>command(d,actor,'reorder',{group_id:71,selected_ids:[3],before_note_id:1}));
    for(const actor of actors)setLayout(d,actor,8,{always_on_top:false});
    updateNote(d,1,2,{expected_revision:1,visibility:'private'});
    const ownerBefore=board(d,1);
    for(const [index,actor] of actors.entries()){
      if(index===0)continue;
      const visible=board(d,actor),group=visible.groups.find(value=>value.id===71);
      assert.ok(!visible.notes.some(note=>note.id===2));
      assert.ok(!JSON.stringify(visible).includes('Exact shared body 2'));
      assert.deepEqual(group.member_ids,[1,3]);assert.equal(group.can_manage,false);
      assert.throws(()=>applyNoteGroupCommand(d,actor,frozen[index]),error=>error.status===404);
      assert.deepEqual(board(d,1),ownerBefore);
    }
    assert.deepEqual(ownerBefore.groups[0].member_ids,[1,2,3]);
  }finally{close();}
});

test('legacy receipt retry and Undo require reload without initialization or shared structure changes',()=>{
  const {d,close}=fixture({grouped:true});try{
    // This is an actual pre-isolation wire command and receipt format. Persist
    // the old after-state directly so setup never invokes the new command writer.
    const operation='pre-isolation-reorder';
    const frozen=command(d,1,'reorder',{group_id:71,selected_ids:[3],before_note_id:1},operation);
    const snapshot=()=>{
      const value=board(d,1);
      return {notes:value.notes.filter(note=>[1,2,3].includes(note.id)).map(note=>{
        const saved=d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(note.id);
        return {id:note.id,revision:note.revision,layout_revision:saved?.revision??0,group_id:71,stored_layout:saved?{...shape(saved),position_locked:Boolean(saved.position_locked),always_on_top:Boolean(saved.always_on_top)}:null,layout:shape(note.layout)};
      }).sort((a,b)=>a.id-b.id),groups:value.groups.map(({id,revision,layout,member_ids})=>({id,revision,layout,member_ids}))};
    };
    const before=snapshot();
    d.exec('DELETE FROM note_group_members WHERE group_id=71; UPDATE note_groups SET revision=6 WHERE id=71');
    [3,1,2].forEach((id,ordinal)=>d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(?,71,?)').run(id,ordinal));
    const after=snapshot();
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const legacyRequest='{"before_note_id":1,"expected":{"groups":[{"id":71,"revision":5}],"notes":[{"id":1,"layout_revision":7,"revision":1},{"id":2,"layout_revision":0,"revision":1},{"id":3,"layout_revision":0,"revision":1}]},"group_id":71,"kind":"reorder","operation_id":"pre-isolation-reorder","selected_ids":[3]}';
    d.prepare('INSERT INTO note_group_receipts(principal_key,operation_id,request_hash,before_json,after_json) VALUES(?,?,?,?,?)').run(digest('["human:1",null]'),operation,digest(legacyRequest),JSON.stringify(before),JSON.stringify(after));
    const original=persisted(d);
    assert.throws(()=>applyNoteGroupCommand(d,1,frozen),error=>error.status===409);
    assert.deepEqual(persisted(d),original,'legacy retry must not initialize an owner or replay the write');
    assert.throws(()=>apply(d,1,'undo',{undo_operation_id:operation}),error=>error.status===409);
    assert.deepEqual(persisted(d),original,'legacy Undo cannot restore shared structures or write any owner marker');
    assert.throws(()=>applyNoteGroupCommand(d,1,{...frozen,before_note_id:2}),error=>error.status===409);
    assert.deepEqual(persisted(d),original);
  }finally{close();}
});

const raceCode=`const {parentPort,workerData}=require('node:worker_threads');
(async()=>{const Database=require('better-sqlite3-multiple-ciphers');const {setNoteLayout}=await import(workerData.service);
const d=new Database(workerData.file);d.pragma('foreign_keys=ON');d.pragma('busy_timeout=10000');
parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{const value=setNoteLayout(d,workerData.actor,1,{expected_layout_revision:7,layout:{x:workerData.x,y:12.75,width:4,height:6}});parentPort.postMessage({status:200,value});}catch(error){parentPort.postMessage({status:error.status||500,message:error.message});}finally{d.close();}});})();`;
async function raceLayouts(file,actors) {
  const workers=actors.map((actor,index)=>new Worker(raceCode,{eval:true,workerData:{actor,file,x:701.125+index*20,service:new URL('../server/services/note-board.js',import.meta.url).href}}));
  try{
    await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);} )));
    const pending=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));
    workers.forEach(worker=>worker.postMessage('go'));
    return await Promise.all(pending);
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));}
}
for(const kind of ['different humans','different displays','same human'])test(`independent SQLite connections preserve layout CAS for ${kind}`,async()=>{
  const {d,actors,close}=fixture(),folder=mkdtempSync(join(tmpdir(),'note-layout-isolation-')),file=join(folder,'synthetic.db');let reopened;
  try{
    await d.backup(file);
    const participants=kind==='same human'?[1,1]:kind==='different humans'?actors.slice(0,2):actors.slice(2);
    const results=await raceLayouts(file,participants);
    assert.deepEqual(results.map(result=>result.status).sort(),kind==='same human'?[200,409]:[200,200]);
    reopened=new Database(file);
    if(kind==='same human')assert.equal(readNote(reopened,1,1).layout.x,results.find(result=>result.status===200).value.x);
    else participants.forEach((actor,index)=>assert.equal(readNote(reopened,actor,1).layout.x,701.125+index*20));
    assert.equal(readNote(reopened,1,1).revision,1);
    assert.deepEqual(reopened.pragma('foreign_key_check'),[]);
  }finally{reopened?.close();close();rmSync(folder,{recursive:true,force:true});}
});
