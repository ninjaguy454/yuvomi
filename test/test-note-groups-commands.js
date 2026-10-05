import test from 'node:test';
import assert from 'node:assert/strict';
import {readGroupMembers} from '../server/services/note-group-store.js';
import {mutateNote,setNoteLayout,setNoteLayouts,updateNote} from '../server/services/note-board.js';
import {fixture,command,rect,state} from './helpers/note-group-fixture.mjs';
const service=await import('../server/services/note-groups.js');
const {devicePrincipal,deviceHash}=await import('../server/services/devices.js');
const apply=(...args)=>{assert.equal(typeof service.applyNoteGroupCommand,'function','canonical command service exists');return service.applyNoteGroupCommand(...args);};
const rejects=(d,p,c,status,reason)=>{const before=state(d);assert.throws(()=>apply(d,p,c),e=>e.status===status&&(!reason||e.reason===reason));assert.deepEqual(state(d),before);};

test('create takes target geometry, preserves records, retries fresh projection, and undoes monotonically',()=>{
  const {d,pin}=fixture(2);try{
    pin(1);const before=d.prepare('SELECT * FROM notes').all(),c=command(d,'create',{source_note_id:2,target_note_id:1},[1,2]);
    const r=apply(d,1,c);assert.equal(r.replayed,false);assert.equal(r.undo_available,true);assert.deepEqual(r.board.groups[0].member_ids,[1,2]);
    assert.deepEqual(r.board.groups[0].layout,rect({x:40,y:50,width:8,height:10,position_locked:true}));assert.deepEqual(d.prepare('SELECT * FROM notes').all(),before);
    const snap=state(d);assert.equal(apply(d,1,c).replayed,true);assert.deepEqual(state(d),snap);
    const undo=apply(d,1,command(d,'undo',{undo_operation_id:c.operation_id},[]));assert.equal(undo.board.groups.length,0);assert.equal(undo.board.notes.find(n=>n.id===1).layout.position_locked,true);
    assert.equal(apply(d,1,c).replayed,true);
    const receipts=JSON.stringify(d.prepare('SELECT * FROM note_group_receipts').all());for(const forbidden of ['PRIVATE BODY','access_user_ids','visibility','creator_name'])assert.equal(receipts.includes(forbidden),false);
  }finally{d.close();}
});
test('selected block reorders canonically, stable group ID and no-op clocks/revisions',()=>{
  const {d,group}=fixture();try{
    const id=group([1,2,3,4,5,6,7,8,9,10]);const c=command(d,'reorder',{group_id:id,selected_ids:[9,2,7,5],before_note_id:4},[1,2,3,4,5,6,7,8,9,10],[id]);
    const r=apply(d,1,c);assert.deepEqual(r.board.groups[0].member_ids,[1,3,2,5,7,9,4,6,8,10]);assert.equal(r.board.groups[0].id,id);assert.equal(r.board.groups[0].revision,2);
    const b=state(d);apply(d,1,command(d,'reorder',{group_id:id,selected_ids:[2,5,7,9],before_note_id:4},[1,2,3,4,5,6,7,8,9,10],[id]));
    const a=state(d);delete a.note_group_receipts;delete b.note_group_receipts;assert.deepEqual(a,b);
  }finally{d.close();}
});
for(const result of ['group','individual'])test(`extract ${result} ignores obsolete member pins, unlocks results, dissolves singleton at source anchor`,()=>{
  const {d,group,pin}=fixture(3);try{
    pin(1);const id=group([1,2,3]),placement=rect({x:100,y:200});const placements=result==='group'?[placement]:[placement,{...placement,x:110}];
    const r=apply(d,1,command(d,'extract',{source_group_id:id,selected_ids:[2,1],result,placements},[1,2,3],[id]));
    assert.equal(d.prepare('SELECT id FROM note_groups WHERE id=?').get(id),undefined);
    assert.deepEqual({...r.board.notes.find(n=>n.id===3).layout,revision:undefined},{...rect({position_locked:true}),revision:undefined});
    if(result==='group'){assert.deepEqual(r.board.groups[0].member_ids,[1,2]);assert.deepEqual(r.board.groups[0].layout,placement);}
    else {assert.equal(r.board.groups.length,0);for(const n of r.board.notes.filter(n=>n.id!==3))assert.equal(n.layout.position_locked,false);}
  }finally{d.close();}
});
test('atomic selected extraction onto pinned target and empty source removal',()=>{
  const {d,group,pin}=fixture(4);try{
    pin(4);const id=group([1,2,3]);const r=apply(d,1,command(d,'create',{source_group_id:id,selected_ids:[3,1,2],target_note_id:4},[1,2,3,4],[id]));
    assert.equal(r.board.groups.length,1);assert.deepEqual(r.board.groups[0].member_ids,[4,1,2,3]);assert.notEqual(r.board.groups[0].id,id);
  }finally{d.close();}
});
test('join and transfer normalize memberships once; same-group transfer is a reorder',()=>{
  const {d,group}=fixture(6);try{
    const a=group([1,2]),b=group([3,4]);apply(d,1,command(d,'join',{target_group_id:a,note_ids:[5,6],before_note_id:2},[1,2,5,6],[a]));assert.deepEqual(readGroupMembers(d,a),[1,5,6,2]);
    apply(d,1,command(d,'transfer',{source_group_id:a,target_group_id:b,selected_ids:[2,6,5],before_note_id:4},[1,2,3,4,5,6],[a,b]));assert.deepEqual(readGroupMembers(d,b),[3,5,6,2,4]);assert.equal(d.prepare('SELECT revision FROM note_groups WHERE id=?').get(b).revision,2);assert.equal(d.prepare('SELECT id FROM note_groups WHERE id=?').get(a),undefined);
    apply(d,1,command(d,'transfer',{source_group_id:b,target_group_id:b,selected_ids:[4],before_note_id:3},[2,3,4,5,6],[b]));assert.deepEqual(readGroupMembers(d,b),[4,3,5,6,2]);
  }finally{d.close();}
});
test('source lock, unpinned target and group member legacy writes reject atomically',()=>{
  const {d,group,pin}=fixture(4);try{
    rejects(d,1,command(d,'create',{source_note_id:2,target_note_id:1},[1,2]),409);pin(1);pin(2);rejects(d,1,command(d,'create',{source_note_id:2,target_note_id:1},[1,2]),409);
    const id=group([3,4]);const before=state(d);assert.throws(()=>setNoteLayout(d,1,3,{expected_layout_revision:0,position_locked:true}),e=>e.status===409);
    assert.throws(()=>setNoteLayouts(d,1,{items:[{note_id:1,expected_layout_revision:1,always_on_top:false},{note_id:3,expected_layout_revision:0,always_on_top:false}]}),e=>e.status===409);assert.deepEqual(state(d),before);
    assert.equal(readGroupMembers(d,id).length,2);
  }finally{d.close();}
});
test('mixed arrange respects locks, permits explicit include_locked and does not group overlapping notes',()=>{
  const {d,group}=fixture(4);try{
    const id=group([1,2]),items=[{kind:'group',id,layout:rect({x:100,position_locked:true})},{kind:'note',id:3,layout:rect({x:100})},{kind:'note',id:4,layout:rect({x:100})}];
    rejects(d,1,command(d,'arrange',{items,include_locked:false},[1,2,3,4],[id]),409);
    const r=apply(d,1,command(d,'arrange',{items,include_locked:true},[1,2,3,4],[id]));assert.equal(r.board.groups.length,1);assert.equal(r.board.groups[0].layout.position_locked,true);assert.deepEqual(readGroupMembers(d,id),[1,2]);
    const before=state(d);apply(d,1,command(d,'arrange',{items,include_locked:true},[1,2,3,4],[id]));const after=state(d);delete before.note_group_receipts;delete after.note_group_receipts;assert.deepEqual(after,before);
  }finally{d.close();}
});
test('all geometry and flag transitions preserve note content and dashboard pin',()=>{
  const {d,group}=fixture(3);try{
    const id=group([1,2]);for(const position_locked of [true,false])for(const always_on_top of [true,false]){
      const r=apply(d,1,command(d,'arrange',{items:[{kind:'group',id,layout:rect({position_locked,always_on_top})},{kind:'note',id:3,layout:rect({position_locked,always_on_top})}],include_locked:true},[1,2,3],[id]));
      assert.equal(r.board.groups[0].layout.position_locked,position_locked);assert.equal(r.board.notes.find(n=>n.id===3).layout.always_on_top,always_on_top);assert.equal(r.board.notes.find(n=>n.id===1).pinned,1);assert.ok(r.board.notes.every(n=>n.revision===1));
    }
  }finally{d.close();}
});
test('strict variants, distinct IDs, exact complete revisions and bounds reject with zero writes',()=>{
  const {d,group}=fixture(4);try{
    const id=group([1,2,3]),good=command(d,'reorder',{group_id:id,selected_ids:[1],before_note_id:null},[1,2,3],[id]);
    for(const patch of [{unexpected:1},{kind:['reorder']},{selected_ids:[]},{selected_ids:[1,1]},{selected_ids:[0]},{selected_ids:[2**53]},{before_note_id:1},{group_id:'1'}])rejects(d,1,{...good,...patch},400);
    for(const expected of [{...good.expected,notes:good.expected.notes.slice(1)},{...good.expected,notes:[...good.expected.notes,{id:4,revision:1,layout_revision:0}]},{...good.expected,groups:[]},{...good.expected,notes:good.expected.notes.map(n=>({...n,revision:999}))}])rejects(d,1,{...good,expected},409);
    for(const bad of [{x:-1},{y:10001},{width:2},{height:101},{x:1.5},{position_locked:1},{oops:true}])rejects(d,1,command(d,'arrange',{items:[{kind:'group',id,layout:rect(bad)}],include_locked:true},[1,2,3],[id]),400);
  }finally{d.close();}
});
test('receipt replay reauthorizes all members and projects current content; payload collision and stale undo fail',()=>{
  const {d,group}=fixture(3);try{
    const id=group([1,2,3]),c=command(d,'reorder',{group_id:id,selected_ids:[3],before_note_id:1},[1,2,3],[id]);apply(d,2,c);
    rejects(d,2,{...c,before_note_id:2},409);updateNote(d,1,1,{expected_revision:1,content:'Fresh content'});assert.equal(apply(d,2,c).board.notes.find(n=>n.id===1).content,'Fresh content');
    rejects(d,2,command(d,'undo',{undo_operation_id:c.operation_id},[]),409);
    d.prepare("UPDATE notes SET visibility='private' WHERE id=2").run();rejects(d,2,c,404);rejects(d,2,command(d,'undo',{undo_operation_id:c.operation_id},[]),404);
    rejects(d,2,{...c,operation_id:'forged',expected:{groups:[{id,revision:2}],notes:[{id:1,revision:2,layout_revision:0},{id:3,revision:1,layout_revision:0}]}},404);
  }finally{d.close();}
});
test('human current permissions and removed members invalidate replay',()=>{
  const {d,group}=fixture(3);try{
    const id=group([1,2,3]),c=command(d,'reorder',{group_id:id,selected_ids:[3],before_note_id:1},[1,2,3],[id]);apply(d,2,c);
    d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','notes','read')");rejects(d,2,c,403);d.exec('DELETE FROM access_permissions');
    mutateNote(d,1,3,'delete');rejects(d,2,c,404);
  }finally{d.close();}
});
test('ordinary authorized deletion maintains hidden singleton anchor without disclosing it; denied deletion writes nothing',()=>{
  const {d,group}=fixture(3);try{
    d.exec("UPDATE notes SET created_by=2,visibility='private' WHERE id=2");const id=group([1,2]);const before=state(d);assert.throws(()=>mutateNote(d,1,2,'delete'),e=>e.status===404);assert.deepEqual(state(d),before);
    assert.equal(mutateNote(d,1,1,'delete'),null);assert.equal(d.prepare('SELECT id FROM note_groups WHERE id=?').get(id),undefined);const l=d.prepare('SELECT * FROM note_layouts WHERE note_id=2').get();assert.equal(l.x,20);assert.equal(l.position_locked,1);assert.equal(l.always_on_top,1);assert.equal(d.prepare('SELECT revision FROM notes WHERE id=2').get().revision,2);
  }finally{d.close();}
});
test('ordinary deletion advances remaining group once, preserves order and removes empty group',()=>{
  const {d,group}=fixture(3);try{
    const id=group([1,2,3]);mutateNote(d,1,1,'delete');assert.equal(d.prepare('SELECT revision FROM note_groups WHERE id=?').get(id).revision,2);assert.deepEqual(readGroupMembers(d,id),[2,3]);mutateNote(d,1,2,'delete');mutateNote(d,1,3,'delete');assert.equal(d.prepare('SELECT count(*) n FROM note_groups').get().n,0);
  }finally{d.close();}
});
test('device service refreshes grants and rejects revoked credentials/context and expired temporary access',()=>{
  const {d,group}=fixture(3);try{
    const permissions={modules:{notes:'read'},capabilities:{'device_notes.view':'allow','device_notes.edit':'allow'}};
    d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json,last_seen_at) VALUES(99,'Synthetic',?,'{}','{}',?)").run(JSON.stringify(permissions),new Date().toISOString());
    const row=()=>d.prepare('SELECT * FROM household_devices WHERE id=99').get(),p=devicePrincipal(row());const id=group([1,2,3]),c=command(d,'reorder',{group_id:id,selected_ids:[3],before_note_id:1},[1,2,3],[id]);apply(d,p,c);
    permissions.capabilities['device_notes.edit']='none';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=99').run(JSON.stringify(permissions));rejects(d,p,c,403);
    permissions.capabilities['device_notes.edit']='allow';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=99').run(JSON.stringify(permissions));d.exec("UPDATE household_devices SET status='revoked' WHERE id=99");rejects(d,p,c,401);d.exec("UPDATE household_devices SET status='active' WHERE id=99");
    d.prepare("INSERT INTO device_credentials(id,device_id,token_hash,context_key) VALUES(7,99,?,'context-a')").run(deviceHash('synthetic-token'));
    const req={devicePrincipal:p,headers:{cookie:'vidamia.device=synthetic-token','x-auth-context':'context-a'}};const c2=command(d,'reorder',{group_id:id,selected_ids:[2],before_note_id:3},[1,2,3],[id]);apply(d,req,c2);
    d.exec("UPDATE device_credentials SET context_key='context-b' WHERE id=7");rejects(d,req,c2,409,'device_context_changed');
    const old=Date.now()-3600000;d.prepare("UPDATE device_credentials SET context_key='context-a',temporary_sid='sid',temporary_user_id=3,temporary_started_at=?,temporary_idle_at=? WHERE id=7").run(old,old);
    rejects(d,{...req,devicePrincipal:undefined,authUserId:3,sessionID:'sid',session:{userId:3,deviceCredentialId:7}},c2,409,'device_context_changed');
  }finally{d.close();}
});
test('recovery switch blocks new commands, replay and undo but allows ordinary content and mandatory deletion cleanup',()=>{
  const {d,group}=fixture(2);try{
    const id=group([1,2]),c=command(d,'reorder',{group_id:id,selected_ids:[2],before_note_id:1},[1,2],[id]);apply(d,1,c);process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS='0';
    rejects(d,1,c,503);rejects(d,1,command(d,'undo',{undo_operation_id:c.operation_id},[]),503);updateNote(d,1,1,{expected_revision:1,content:'Recovery edit'});mutateNote(d,1,1,'delete');assert.equal(d.prepare('SELECT count(*) n FROM note_groups').get().n,0);
  }finally{delete process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS;d.close();}
});

for(const kind of ['transfer','extract','create'])test(`undo ${kind} restores exact order and anchor with newer surviving/recreated revisions`,()=>{
  const {d,group,pin}=fixture(6);try{
    const a=group([1,2,3]),b=group([4,5]);pin(6);
    const fields=kind==='transfer'?{source_group_id:a,target_group_id:b,selected_ids:[1,2],before_note_id:5}:kind==='extract'?{source_group_id:a,selected_ids:[1,2],result:'group',placements:[rect({x:70,y:80})]}:{source_group_id:a,selected_ids:[1,2],target_note_id:6};
    const ns=kind==='transfer'?[1,2,3,4,5]:kind==='create'?[1,2,3,6]:[1,2,3],gs=kind==='transfer'?[a,b]:[a],c=command(d,kind,fields,ns,gs);apply(d,1,c);
    const result=apply(d,1,command(d,'undo',{undo_operation_id:c.operation_id},[]));assert.deepEqual(readGroupMembers(d,a),[1,2,3]);assert.deepEqual(readGroupMembers(d,b),[4,5]);assert.equal(result.board.groups.length,2);assert.ok(result.board.groups.find(g=>g.id===a).revision>1);assert.deepEqual(result.board.groups.find(g=>g.id===a).layout,rect({position_locked:true}));
    const before=state(d);rejects(d,1,command(d,'undo',{undo_operation_id:c.operation_id},[]),409);assert.deepEqual(state(d),before);
  }finally{d.close();}
});
test('stale transfer, newly added canonical member and deleted canonical member reject complete batch',()=>{
  const {d,group}=fixture(7);try{
    const a=group([1,2,3]),b=group([4,5,6]),c=command(d,'transfer',{source_group_id:a,target_group_id:b,selected_ids:[2],before_note_id:null},[1,2,3,4,5,6],[a,b]);
    d.prepare('INSERT INTO note_group_members(note_id,group_id,ordinal) VALUES(7,?,3)').run(b);rejects(d,1,c,409);d.prepare('DELETE FROM note_group_members WHERE note_id=7').run();
    mutateNote(d,1,4,'delete');rejects(d,1,c,409);
    rejects(d,1,{operation_id:'bad-undo',kind:'undo',expected:{groups:[{id:a,revision:1}],notes:[]},undo_operation_id:'unknown'},400);
  }finally{d.close();}
});
test('hidden and nonexistent groups have the same generic error without member metadata',()=>{
  const {d,group}=fixture(2);try{
    const id=group([1,2]);d.exec("UPDATE notes SET visibility='private' WHERE id=2");
    const c={operation_id:'generic',kind:'reorder',expected:{groups:[],notes:[]},group_id:id,selected_ids:[1],before_note_id:null};
    const error=group_id=>{try{apply(d,2,{...c,group_id});assert.fail('denied');}catch(e){assert.equal(e.status,404);return e.message;}};
    assert.equal(error(id),error(999));
  }finally{d.close();}
});
test('501 distinct affected notes returns actionable limit without writes',()=>{
  const {d,group}=fixture(501);try{
    const members=Array.from({length:501},(_,i)=>i+1),id=group(members),c=command(d,'reorder',{group_id:id,selected_ids:[1],before_note_id:null},members,[id]),before=state(d);
    assert.throws(()=>apply(d,1,c),e=>e.status===400&&/500/.test(e.message));assert.deepEqual(state(d),before);
  }finally{d.close();}
});
test('device capability combinations require both view and edit, with no new create/delete grant',()=>{
  const {d,group}=fixture(2);try{
    d.exec("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Synthetic','{}','{}','{}')");const id=group([1,2]);
    for(let mask=0;mask<16;mask++){
      const permissions={modules:{notes:'read'},capabilities:Object.fromEntries(['view','create','edit','delete'].map((action,i)=>[`device_notes.${action}`,mask&(1<<i)?'allow':'none']))};d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=99').run(JSON.stringify(permissions));
      const p=devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=99').get()),c=command(d,'reorder',{group_id:id,selected_ids:[2],before_note_id:1},[1,2],[id]);
      if((mask&5)===5)assert.equal(apply(d,p,c).replayed,false);else rejects(d,p,c,403);
    }
  }finally{d.close();}
});
test('device receipt identity is isolated across credential contexts and device revision',()=>{
  const {d,group}=fixture(2);try{
    const permissions={modules:{notes:'read'},capabilities:{'device_notes.view':'allow','device_notes.edit':'allow'}};d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json,last_seen_at) VALUES(99,'Synthetic',?,'{}','{}',?)").run(JSON.stringify(permissions),new Date().toISOString());d.prepare("INSERT INTO device_credentials(id,device_id,token_hash,context_key) VALUES(7,99,?,'a')").run(deviceHash('synthetic-context-token'));
    const p=devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=99').get()),req=context=>({devicePrincipal:p,headers:{cookie:'vidamia.device=synthetic-context-token','x-auth-context':context}}),id=group([1,2]),c=command(d,'reorder',{group_id:id,selected_ids:[2],before_note_id:1},[1,2],[id]);apply(d,req('a'),c);
    d.exec("UPDATE device_credentials SET context_key='b' WHERE id=7");rejects(d,req('b'),c,409);
    d.exec("UPDATE device_credentials SET context_key='a' WHERE id=7; UPDATE household_devices SET revision=revision+1 WHERE id=99");rejects(d,req('a'),c,409);
  }finally{d.close();}
});
