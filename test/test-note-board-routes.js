import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='notes-board-synthetic';
const {get}=await import('../server/db.js');
const {default:router}=await import('../server/routes/notes.js');
const {deviceNotesRequest}=await import('../server/services/device-notes.js');
const {devicePreset,normalizeDevicePermissions}=await import('../server/services/devices.js');
const d=get();
const arrangementState=()=>Object.fromEntries(['note_board_owners','note_board_note_layouts','note_board_groups','note_board_group_members','note_board_group_receipts'].map(table=>[table,d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

for(const [id,role] of [[1,'member'],[2,'member'],[3,'admin']])d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id,`notes${id}`,`Member ${id}`,'x',role);
let actor=1;const app=express();app.use(express.json());app.use((req,res,next)=>{req.authUserId=actor;req.session={userId:actor};next();});app.use('/',router);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
const call=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:r.status===204?null:await r.json()};};
test.after(()=>server.close());
let privateNote,selectedNote,sharedNote;
test('Private and Selected audiences are persisted and filter members including unrelated admin',async()=>{
  actor=1;
  privateNote=(await call('POST','/',{content:'private secret',visibility:'private'})).body.data;
  selectedNote=(await call('POST','/',{content:'selected secret',visibility:'selected',access_user_ids:[2]})).body.data;
  sharedNote=(await call('POST','/',{content:'everyone',visibility:'all'})).body.data;
  assert.equal(privateNote.visibility,'private');assert.equal(selectedNote.visibility,'selected');
  actor=2;assert.deepEqual((await call('GET','/')).body.data.map(n=>n.id).sort(),[selectedNote.id,sharedNote.id].sort());
  actor=3;assert.deepEqual((await call('GET','/')).body.data.map(n=>n.id),[sharedNote.id]);
});
test('all direct mutation paths conceal inaccessible notes and no creator impersonation is accepted',async()=>{
  actor=2;
  for(const [method,path,body] of [['GET',`/${privateNote.id}`],['PUT',`/${privateNote.id}`,{content:'attack'}],['PATCH',`/${privateNote.id}/pin`,{}],['PATCH',`/${privateNote.id}/check`,{line:0,checked:true}],['DELETE',`/${privateNote.id}`]])assert.equal((await call(method,path,body)).status,404,`${method} ${path}`);
  assert.equal((await call('PUT',`/${selectedNote.id}`,{visibility:'all',expected_revision:selectedNote.revision})).status,403);
  assert.equal((await call('POST','/',{content:'attack',created_by:1,visibility:'private'})).status,400);
});
test('strict audience validation and same-household recipients; content update preserves omitted audience',async()=>{
  actor=1;
  for(const body of [{visibility:null},{access_user_ids:null},{visibility:'public'},{visibility:'selected',access_user_ids:[]},{visibility:'selected',access_user_ids:[999]},{visibility:'selected',access_user_ids:[2,2]}])assert.equal((await call('POST','/',{content:'bad',...body})).status,400);
  const updated=await call('PUT',`/${privateNote.id}`,{content:'private revised',expected_revision:privateNote.revision});
  assert.equal(updated.status,200);assert.equal(updated.body.data.visibility,'private');
  assert.equal((await call('PUT',`/${privateNote.id}`,{content:'stale',expected_revision:privateNote.revision})).status,409);
  assert.equal((await call('PUT',`/${privateNote.id}`,{content:'legacy no revision'})).status,409);
});
test('layout CAS is separate from content and unauthorized/stale batches roll back completely',async()=>{
  actor=1;const before=d.prepare('SELECT * FROM notes WHERE id=?').get(sharedNote.id);
  const shape={x:0,y:0,width:4,height:6};
  assert.equal((await call('PATCH',`/${sharedNote.id}/layout`,{note_id:privateNote.id,expected_layout_revision:0,layout:shape})).status,400);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM note_board_note_layouts WHERE owner_key=\'human:1\'').get().n,0);
  const r=await call('PATCH',`/${sharedNote.id}/layout`,{expected_layout_revision:0,layout:shape});assert.equal(r.status,200);
  assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(sharedNote.id),before);
  assert.equal((await call('PATCH',`/${sharedNote.id}/layout`,{expected_layout_revision:0,layout:shape})).status,409);
  const items=[{note_id:sharedNote.id,expected_layout_revision:1,layout:{...shape,x:4}},{note_id:privateNote.id,expected_layout_revision:999,layout:shape}];
  assert.equal((await call('PATCH','/layout',{items})).status,409);
  assert.equal(d.prepare('SELECT x FROM note_board_note_layouts WHERE owner_key=\'human:1\' AND note_id=?').get(sharedNote.id).x,0);
  actor=2;items[0].expected_layout_revision=0;items[1].expected_layout_revision=0;const beforeDenied=arrangementState();
  assert.equal((await call('PATCH','/layout',{items})).status,404);assert.deepEqual(arrangementState(),beforeDenied,'denied batch rolls back owner initialization and every arrangement table');
  assert.equal(d.prepare('SELECT x FROM note_board_note_layouts WHERE owner_key=\'human:1\' AND note_id=?').get(sharedNote.id).x,0);
  actor=1;for(const shape of [{x:-1,y:0,width:4,height:6},{x:10001,y:0,width:4,height:6},{x:0,y:0,width:2,height:6},{x:0,y:Infinity,width:4,height:6}])assert.equal((await call('PATCH',`/${sharedNote.id}/layout`,{expected_layout_revision:1,layout:shape})).status,400);
});
test('single and bulk HTTP layouts persist strict flags, lock movement and preserve the dashboard pin',async()=>{
  actor=1;const note=(await call('POST','/',{content:'HTTP layout flags',pinned:true})).body.data;
  const first=await call('PATCH',`/${note.id}/layout`,{expected_layout_revision:0,position_locked:true,always_on_top:true});assert.equal(first.status,200);assert.equal(first.body.data.position_locked,true);assert.equal(first.body.data.always_on_top,true);
  const {x,y,width,height}=first.body.data,items=[{note_id:note.id,expected_layout_revision:1,layout:{x:x+30,y,width,height}}];
  assert.equal((await call('PATCH','/layout',{items})).status,409);assert.equal((await call('PATCH','/layout',{items,include_locked:1})).status,400);
  const moved=await call('PATCH','/layout',{items,include_locked:true});assert.equal(moved.status,200);assert.equal(moved.body.data[0].position_locked,true);assert.equal(moved.body.data[0].always_on_top,true);assert.equal(moved.body.data[0].revision,2);
  assert.equal((await call('PATCH',`/${note.id}/layout`,{expected_layout_revision:2,position_locked:null})).status,400);assert.equal((await call('PATCH',`/${note.id}/layout`,{expected_layout_revision:2})).status,400);
  const read=(await call('GET',`/${note.id}`)).body.data;assert.equal(read.pinned,1);assert.equal(read.revision,note.revision);assert.equal(read.layout.x,x+30);
});
test('paired devices retain all independent grants but never see or mutate restricted notes',()=>{
  d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Synthetic display','{}','{}','{}')").run();
  for(let mask=0;mask<16;mask++){
    const permissions=devicePreset();['view','create','edit','delete'].forEach((key,i)=>permissions.capabilities[`device_notes.${key}`]=mask&(1<<i)?'allow':'none');
    const p={kind:'device',id:99,status:'active',permissions:normalizeDevicePermissions(permissions),scope:{}};
    if(mask&1){const result=deviceNotesRequest(d,p,'GET',null,null);assert.ok(result.body.data.every(n=>n.visibility==='all'));assert.ok(!JSON.stringify(result).includes('secret'));}
    else assert.throws(()=>deviceNotesRequest(d,p,'GET',null,null),e=>e.status===403);
    if(mask&2){const made=deviceNotesRequest(d,p,'POST',null,null,{content:'device'});assert.equal(made.status,201);assert.equal(made.body.data===null,!(mask&1));const id=Number(d.prepare('SELECT MAX(id) id FROM notes').get().id);if(!(mask&4))assert.throws(()=>deviceNotesRequest(d,p,'PUT',id,null,{content:'cannot edit'}),e=>e.status===403);if(!(mask&8))assert.throws(()=>deviceNotesRequest(d,p,'DELETE',id,null),e=>e.status===403);}
    if(mask&4)assert.throws(()=>deviceNotesRequest(d,p,'PUT',privateNote.id,null,{content:'attack'}),e=>e.status===404);
    if(mask&8)assert.throws(()=>deviceNotesRequest(d,p,'DELETE',selectedNote.id,null),e=>e.status===404);
    if(mask&2)assert.throws(()=>deviceNotesRequest(d,p,'POST',null,null,{content:'attack',visibility:'private'}),e=>e.status===403);
  }
});
