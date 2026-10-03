import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-note-defaults-audit';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {updateNote,readNote,readNoteBoard,setNoteLayout}=await import('../server/services/note-board.js');
const {deviceNotesRequest}=await import('../server/services/device-notes.js');
const {devicePreset,normalizeDevicePermissions,auditDevice}=await import('../server/services/devices.js');
const d=get();
for(const id of [1,2])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic','member')").run(id,`member${id}`,`Member ${id}`);
d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Synthetic display','{}','{}','{}')").run();
test.beforeEach(()=>d.prepare('DELETE FROM notes').run());
const create=(name,visibility='all',owner=1)=>updateNote(d,owner,null,{title:name,content:name,visibility});
const separate=(a,b)=>a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y;
const layouts=actor=>readNoteBoard(d,actor).notes.map(n=>({id:n.id,layout:n.layout}));

test('defaults use off-grid free corridors and signal compact recovery when canonical space is saturated',()=>{
  const insert=d.prepare("INSERT INTO notes(content,created_by) VALUES('Saved obstacle',1)");
  const geometry=d.prepare('INSERT INTO note_layouts(note_id,x,y,width,height) VALUES(?,?,?,?,100)');
  for(let y=0;y<=10000;y+=100)for(const [x,width] of [[0,3],[7,5]]){
    geometry.run(Number(insert.run().lastInsertRowid),x,y,width);
  }
  const free=create('Fits corridor');assert.equal(free.layout.x,3);assert.equal(free.layout.y,0);
  d.prepare('DELETE FROM notes WHERE id=?').run(free.id);
  d.prepare('UPDATE note_layouts SET x=0,width=12').run();
  const crowded=create('Still reachable');assert.equal(crowded.layout.overflow,true);
  assert.ok(crowded.layout.y<=10000);assert.equal(readNoteBoard(d,1).notes.find(n=>n.id===crowded.id).layout.overflow,true);
});

test('new note avoids a saved rectangle and POST/direct/list defaults agree',()=>{
  const first=create('Already arranged');setNoteLayout(d,1,first.id,{expected_layout_revision:0,layout:{x:0,y:0,width:8,height:10}});
  const added=create('New card');const board=readNoteBoard(d,1).notes;
  assert.ok(separate(board.find(n=>n.id===first.id).layout,board.find(n=>n.id===added.id).layout));
  assert.deepEqual(added.layout,board.find(n=>n.id===added.id).layout);
  assert.deepEqual(readNote(d,1,added.id).layout,added.layout);
});
test('all missing layouts occupy distinct free space around saved card sizes without view writes',()=>{
  const first=create('Saved');setNoteLayout(d,1,first.id,{expected_layout_revision:0,layout:{x:0,y:0,width:12,height:9}});
  for(let i=0;i<8;i++)create(`Legacy ${i}`);
  const before={changes:d.prepare('SELECT total_changes() n').get().n,clock:d.prepare('SELECT version FROM note_change_clock').get().version};
  const rows=readNoteBoard(d,1).notes;
  for(let a=0;a<rows.length;a++){
    assert.deepEqual(readNote(d,1,rows[a].id).layout,rows[a].layout);
    for(let b=a+1;b<rows.length;b++)assert.ok(separate(rows[a].layout,rows[b].layout),`${rows[a].id}/${rows[b].id}`);
  }
  assert.equal(d.prepare('SELECT COUNT(*) n FROM note_layouts').get().n,1);
  assert.deepEqual({changes:d.prepare('SELECT total_changes() n').get().n,clock:d.prepare('SELECT version FROM note_change_clock').get().version},before);
});
test('hidden saved and missing note rectangles cannot influence another viewer default positions',()=>{
  create('Visible');create('Also visible');const before=layouts(2);
  const hidden=create('SECRET','private');setNoteLayout(d,1,hidden.id,{expected_layout_revision:0,layout:{x:0,y:0,width:12,height:100}});
  create('SECRET missing','private');assert.deepEqual(layouts(2),before);
  assert.ok(!JSON.stringify(readNoteBoard(d,2)).includes('SECRET'));
});
test('new missing cards do not move earlier missing defaults when their list order changes',()=>{
  create('First');create('Second');const before=layouts(1);
  create('Third');const after=layouts(1);
  for(const previous of before)assert.deepEqual(after.find(n=>n.id===previous.id).layout,previous.layout);
});
test('pinned legacy notes receive the first free default slot without moving stored layouts',()=>{
  const first=create('Unpinned');const pinned=updateNote(d,1,null,{content:'Pinned first',pinned:true});
  assert.deepEqual(pinned.layout,{x:0,y:0,width:4,height:6,revision:0});
  assert.ok(separate(readNote(d,1,first.id).layout,pinned.layout));
});
test('create-only devices audit the actual inserted note ID while returning no note projection',()=>{
  const permissions=devicePreset();permissions.capabilities['device_notes.create']='allow';
  const device={kind:'device',id:99,status:'active',permissions:normalizeDevicePermissions(permissions),scope:{}};
  for(let i=0;i<20;i++)auditDevice(d,99,null,'synthetic_before_create',{});
  const response=deviceNotesRequest(d,device,'POST',null,null,{content:'Create-only audit identity'});
  assert.deepEqual(response,{status:201,body:{data:null}});
  const created=d.prepare("SELECT id FROM notes WHERE content='Create-only audit identity'").get();
  const audit=d.prepare("SELECT * FROM device_audit_events WHERE device_id=99 AND event_type='note_created' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.details_json).note_id,created.id);assert.equal(audit.actor_user_id,null);
});
