import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,command,rect,state} from './helpers/note-group-fixture.mjs';
import {createDevice,devicePreset,devicePrincipal,updateDevice,normalizeDevicePermissions} from '../server/services/devices.js';
import {readNoteBoard,setNoteLayout,setNoteLayouts,updateNote,mutateNote} from '../server/services/note-board.js';
import {applyNoteGroupCommand,readGroupedNoteBoard} from '../server/services/note-groups.js';
const actions=['move','pin','group','ungroup'];
function setup(grants={},count=6){
  const f=fixture(count),permissions=devicePreset();
  for(const a of actions)delete permissions.capabilities[`device_notes.${a}`];
  for(const [a,value] of Object.entries({view:'allow',edit:'none',...grants}))permissions.capabilities[`device_notes.${a}`]=value;
  const device=createDevice(f.d,{name:'Synthetic display',permissions},3);
  const p=devicePrincipal(f.d.prepare('SELECT * FROM household_devices WHERE id=?').get(device.id));
  return {...f,p,device,c:(kind,fields,notes,groups=[])=>command(f.d,kind,fields,notes,groups,undefined,p)};
}
function reject(f,run,status=403){const before=state(f.d);assert.throws(run,e=>e.status===status);assert.deepEqual(state(f.d),before,'denied request writes nothing');}
test('new-device preset explicitly denies every layout grant even after content Edit is enabled',()=>{
  const {d}=fixture();try{
    const permissions=devicePreset();permissions.capabilities['device_notes.view']='allow';permissions.capabilities['device_notes.edit']='allow';
    const device=createDevice(d,{name:'New display',permissions},3),p=devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(device.id));
    for(const action of actions){assert.equal(p.permissions.capabilities[`device_notes.${action}`],'none');assert.equal(readNoteBoard(d,p).notes[0].permissions[action],false);}
    assert.throws(()=>setNoteLayout(d,p,1,{expected_layout_revision:0,position_locked:true}),e=>e.status===403);
  }finally{d.close();}
});
test('missing granular grants remain sparse on cosmetic Save and inherit Edit explicitly',()=>{
  const f=setup({edit:'allow'});try{
    for(const a of actions){assert.equal(Object.hasOwn(f.device.permissions.capabilities,`device_notes.${a}`),false);assert.equal(readNoteBoard(f.d,f.p).notes[0].permissions[a],true);}
    const updated=updateDevice(f.d,f.device.id,{revision:f.device.revision,name:'Cosmetic'},3);
    for(const a of actions)assert.equal(Object.hasOwn(updated.permissions.capabilities,`device_notes.${a}`),false);
    assert.throws(()=>normalizeDevicePermissions({...updated.permissions,capabilities:{...updated.permissions.capabilities,'device_notes.move':'maybe'}}));
  }finally{f.d.close();}
});
test('Move resizes and layers without content Edit, preserves content and other owners',()=>{
  const f=setup({move:'allow',pin:'none',group:'none',ungroup:'none'});try{
    const before=f.d.prepare('SELECT * FROM notes').all(),human=readNoteBoard(f.d,1);
    const layout=setNoteLayout(f.d,f.p,1,{expected_layout_revision:0,layout:{x:18,y:22,width:5,height:9},always_on_top:true});
    assert.equal(layout.width,5);assert.equal(layout.always_on_top,true);
    assert.deepEqual(f.d.prepare('SELECT * FROM notes').all(),before);assert.deepEqual(readNoteBoard(f.d,1),human);
    reject(f,()=>updateNote(f.d,f.p,1,{content:'forbidden',expected_revision:1}));
    reject(f,()=>mutateNote(f.d,f.p,1,'pin',{expected_revision:1}));
    reject(f,()=>setNoteLayout(f.d,f.p,1,{expected_layout_revision:layout.revision,position_locked:true}));
    reject(f,()=>setNoteLayout(f.d,f.p,1,{expected_layout_revision:0,always_on_top:false}),409);
  }finally{f.d.close();}
});
test('Pin is independent; a mixed Pin plus Move batch rolls back completely',()=>{
  const f=setup({pin:'allow',move:'none'});try{
    assert.equal(setNoteLayout(f.d,f.p,1,{expected_layout_revision:0,position_locked:true}).position_locked,true);
    reject(f,()=>setNoteLayouts(f.d,f.p,{items:[{note_id:2,expected_layout_revision:0,position_locked:true},{note_id:3,expected_layout_revision:0,always_on_top:true}]}));
    reject(f,()=>setNoteLayout(f.d,f.p,2,{expected_layout_revision:0,layout:{x:1,y:1,width:4,height:6}}));
  }finally{f.d.close();}
});
for(const grants of [{view:'none',move:'allow',pin:'allow'},{edit:'allow',move:'none',pin:'none'}])test(`read and explicit layout denials are enforced: ${JSON.stringify(grants)}`,()=>{
  const f=setup(grants);try{reject(f,()=>setNoteLayout(f.d,f.p,1,{expected_layout_revision:0,position_locked:true}));}finally{f.d.close();}
});
test('Group-only create/join succeeds, requires View and cannot extract; undo requires Ungroup',()=>{
  const f=setup({group:'allow',ungroup:'none',move:'none',pin:'none'});try{
    f.d.exec(`INSERT INTO note_board_owners(owner_key,next_group_id) VALUES('device:${f.p.id}',1); INSERT INTO note_board_note_layouts(owner_key,note_id,x,y,width,height,position_locked) VALUES('device:${f.p.id}',1,0,0,6,8,1)`);
    const c=f.c('create',{source_note_id:2,target_note_id:1},[1,2]);
    const created=applyNoteGroupCommand(f.d,f.p,c),g=created.board.groups[0];
    assert.equal(created.undo_available,false,'Undo is hidden without the inverse Ungroup authority');
    assert.equal(g.permissions.group,true);assert.equal(g.permissions.move,false);assert.equal(g.permissions.ungroup,false);
    assert.equal(applyNoteGroupCommand(f.d,f.p,c).replayed,true);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('undo',{undo_operation_id:c.operation_id},[])));
    applyNoteGroupCommand(f.d,f.p,f.c('join',{target_group_id:g.id,note_ids:[3],before_note_id:null},[1,2,3],[g.id]));
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('extract',{source_group_id:g.id,selected_ids:[3],result:'individual',placements:[rect({width:6,height:8,always_on_top:false})]},[1,2,3],[g.id])));
  }finally{f.d.close();}
});
test('Group plus Ungroup enables transfer and split without granting movement or Edit',()=>{
  const f=setup({group:'allow',ungroup:'allow',move:'none',pin:'none'});try{
    const a=f.group([1,2,3],rect(),f.p),b=f.group([4,5],rect(),f.p);
    const transfer=f.c('transfer',{source_group_id:a,target_group_id:b,selected_ids:[1],before_note_id:null},[1,2,3,4,5],[a,b]);
    const moved=applyNoteGroupCommand(f.d,f.p,transfer);assert.equal(moved.undo_available,true);assert.deepEqual(moved.board.groups.find(g=>g.id===b).member_ids,[4,5,1]);
    applyNoteGroupCommand(f.d,f.p,f.c('undo',{undo_operation_id:transfer.operation_id},[]));
    const split=f.c('extract',{source_group_id:a,selected_ids:[1,2],result:'group',placements:[rect()]},[1,2,3],[a]);
    assert.equal(applyNoteGroupCommand(f.d,f.p,split).board.groups.length,2);
    reject(f,()=>setNoteLayout(f.d,f.p,6,{expected_layout_revision:0,always_on_top:true}));
  }finally{f.d.close();}
});
test('Pin-only group commands and undo work, while stale revisions and content Edit remain denied',()=>{
  const f=setup({pin:'allow',move:'none',group:'none',ungroup:'none'});try{
    const id=f.group([1,2,3],rect(),f.p);
    const c=f.c('arrange',{items:[{kind:'group',id,layout:rect({position_locked:true})}],include_locked:true},[1,2,3],[id]);
    const r=applyNoteGroupCommand(f.d,f.p,c);assert.equal(r.board.groups[0].layout.position_locked,true);assert.equal(r.undo_available,true);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,{...c,operation_id:'stale'}),409);
    assert.equal(applyNoteGroupCommand(f.d,f.p,f.c('undo',{undo_operation_id:c.operation_id},[])).board.groups[0].layout.position_locked,false);
    reject(f,()=>mutateNote(f.d,f.p,1,'check',{line:0,checked:true}));
  }finally{f.d.close();}
});
test('Ungroup-only extracts individual pages but splitting and transfer require both grants',()=>{
  const f=setup({ungroup:'allow',group:'none',move:'none',pin:'none'});try{
    const a=f.group([1,2,3],rect(),f.p),b=f.group([4,5],rect(),f.p);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('extract',{source_group_id:a,selected_ids:[1,2],result:'group',placements:[rect()]},[1,2,3],[a])));
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('transfer',{source_group_id:a,target_group_id:b,selected_ids:[1],before_note_id:null},[1,2,3,4,5],[a,b])));
    const c=f.c('extract',{source_group_id:a,selected_ids:[1],result:'individual',placements:[rect()]},[1,2,3],[a]);
    assert.equal(applyNoteGroupCommand(f.d,f.p,c).board.groups.find(g=>g.id===a).member_ids.length,2);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('undo',{undo_operation_id:c.operation_id},[])));
  }finally{f.d.close();}
});
test('Move-only reorders, arranges and undoes groups without changing pins or content',()=>{
  const f=setup({move:'allow',group:'none',ungroup:'none',pin:'none'});try{
    const id=f.group([1,2,3],rect(),f.p),before=f.d.prepare('SELECT * FROM notes').all();
    const c=f.c('reorder',{group_id:id,selected_ids:[3],before_note_id:1},[1,2,3],[id]);
    assert.deepEqual(applyNoteGroupCommand(f.d,f.p,c).board.groups[0].member_ids,[3,1,2]);
    assert.deepEqual(applyNoteGroupCommand(f.d,f.p,f.c('undo',{undo_operation_id:c.operation_id},[])).board.groups[0].member_ids,[1,2,3]);
    const arrange=f.c('arrange',{items:[{kind:'group',id,layout:rect({x:55,width:7,always_on_top:false})}],include_locked:true},[1,2,3],[id]);
    assert.equal(applyNoteGroupCommand(f.d,f.p,arrange).board.groups[0].layout.x,55);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,f.c('arrange',{items:[{kind:'group',id,layout:rect({x:90,position_locked:true})},{kind:'note',id:4,layout:rect({x:5})}],include_locked:true},[1,2,3,4],[id])));
    assert.deepEqual(f.d.prepare('SELECT * FROM notes').all(),before);
  }finally{f.d.close();}
});
test('private members, current role/grant changes and revoked devices cannot use a saved command',()=>{
  const f=setup({move:'allow'});try{
    const id=f.group([1,2,3],rect(),f.p),c=f.c('reorder',{group_id:id,selected_ids:[3],before_note_id:1},[1,2,3],[id]);
    applyNoteGroupCommand(f.d,f.p,c);
    f.d.exec("UPDATE notes SET visibility='private' WHERE id=2");reject(f,()=>applyNoteGroupCommand(f.d,f.p,c),404);
    f.d.exec("UPDATE notes SET visibility='all' WHERE id=2");
    const perms=structuredClone(f.p.permissions);perms.capabilities['device_notes.move']='none';f.d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(perms),f.p.id);
    reject(f,()=>applyNoteGroupCommand(f.d,f.p,c));
    f.d.prepare("UPDATE household_devices SET status='revoked' WHERE id=?").run(f.p.id);reject(f,()=>applyNoteGroupCommand(f.d,f.p,c),401);
  }finally{f.d.close();}
});
