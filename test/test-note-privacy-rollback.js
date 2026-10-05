/** Privacy-preserving presentation rollback contract: older clients use the
 * Phase 2 server. This suite must never be interpreted as approval to run an
 * older server image against a database containing restricted notes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-privacy-rollback';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');
const {default:notesRouter}=await import('../server/routes/notes.js');
const {default:dashboardRouter}=await import('../server/routes/dashboard.js');
const {default:searchRouter}=await import('../server/routes/search.js');
const {deviceNotesRequest}=await import('../server/services/device-notes.js');
const {devicePreset,normalizeDevicePermissions}=await import('../server/services/devices.js');
const {wallDashboard,saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js');
const d=get();
for(const [id,name,role] of [[1,'owner','member'],[2,'recipient','member'],[3,'administrator','admin']])d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic',?)").run(id,name,name,role);
let actor=1;
const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=actor;req.authRole=actor===3?'admin':'member';req.session={userId:actor};next();});
app.use('/notes',notesRouter);app.use('/dashboard',dashboardRouter);app.use('/search',searchRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.closeAllConnections();server.close();});
async function call(method,path,body){const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:response.status===204?null:await response.json(),headers:response.headers};}
const create=async(body)=>{const result=await call('POST','/notes',body);assert.equal(result.status,201);return result.body.data;};
const privateNote=await create({title:'Rollback PRIVATE',content:'- [ ] Secret private step',visibility:'private'});
const selectedNote=await create({title:'Rollback SELECTED',content:'- [ ] Secret selected step',visibility:'selected',access_user_ids:[2]});
const sharedNote=await create({title:'Rollback EVERYONE',content:'Shared legacy content'});
const snapshot=id=>({note:d.prepare('SELECT * FROM notes WHERE id=?').get(id),access:d.prepare('SELECT * FROM note_access WHERE note_id=?').all(id),layouts:d.prepare('SELECT * FROM note_board_note_layouts WHERE note_id=? ORDER BY owner_key').all(id),owners:d.prepare('SELECT * FROM note_board_owners ORDER BY owner_key').all(),seedLayout:d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(id)});
function noRestricted(value){const text=JSON.stringify(value);for(const marker of ['Rollback PRIVATE','Rollback SELECTED','Secret private step','Secret selected step'])assert.ok(!text.includes(marker),marker);}

test('pre-canvas clients can list authorized legacy note content but cannot reset audience by blind PUT',async()=>{
  actor=1;
  const listed=await call('GET','/notes');assert.equal(listed.status,200);assert.equal(listed.body.data.length,3);
  for(const note of [privateNote,selectedNote]){
    const before=snapshot(note.id);
    const response=await call('PUT',`/notes/${note.id}`,{title:note.title,content:'legacy replacement',color:note.color,pinned:0});
    assert.equal(response.status,409);assert.deepEqual(snapshot(note.id),before);
  }
});
test('revision-aware clients that omit audience preserve Private and exact Selected recipients',async()=>{
  actor=1;
  for(const note of [privateNote,selectedNote]){
    const before=snapshot(note.id),result=await call('PUT',`/notes/${note.id}`,{title:note.title,content:note.content,expected_revision:before.note.revision});
    assert.equal(result.status,200);assert.equal(result.body.data.visibility,note.visibility);assert.deepEqual(snapshot(note.id).access,before.access);
  }
});
test('old client audience field omission does not let a recipient change the sharing audience',async()=>{
  actor=2;let before=snapshot(selectedNote.id);
  const edited=await call('PUT',`/notes/${selectedNote.id}`,{content:selectedNote.content,expected_revision:before.note.revision});
  assert.equal(edited.status,200);assert.equal(edited.body.data.visibility,'selected');assert.ok(!('access_user_ids' in edited.body.data));
  for(const patch of [{visibility:'all'},{access_user_ids:[3]},{visibility:null}]){
    before=snapshot(selectedNote.id);
    const rejected=await call('PUT',`/notes/${selectedNote.id}`,{content:'attempted widening',expected_revision:before.note.revision,...patch});
    assert.equal(rejected.status,403);assert.deepEqual(snapshot(selectedNote.id),before);
  }
});
test('unknown legacy fields and stale revisions fail without content, ACL, or layout partial writes',async()=>{
  actor=1;const before=snapshot(selectedNote.id);
  for(const body of [
    {content:'unknown author',created_by:3,visibility:'all',expected_revision:before.note.revision},
    {content:'stale widening',visibility:'all',expected_revision:before.note.revision-1},
    {content:'invalid audience',visibility:'public',expected_revision:before.note.revision},
  ]){
    const rejected=await call('PUT',`/notes/${selectedNote.id}`,body);assert.ok([400,409].includes(rejected.status));assert.deepEqual(snapshot(selectedNote.id),before);
  }
});
test('presentation rollback retains privacy across direct, dashboard, search, and shared Wall responses',async()=>{
  actor=3;
  const board=await call('GET','/notes?visibility=all&created_by=1'),dashboard=await call('GET','/dashboard'),search=await call('GET','/search?q=Rollback');
  assert.deepEqual(board.body.data.map(n=>n.id),[sharedNote.id]);assert.deepEqual(dashboard.body.pinnedNotes.map(n=>n.id),[sharedNote.id]);assert.deepEqual(search.body.notes.map(n=>n.id),[sharedNote.id]);
  for(const note of [privateNote,selectedNote])for(const [method,suffix,body] of [['GET',''],['PUT','',{content:'stale client'}],['PATCH','/check',{line:0,checked:true}],['PATCH','/pin',{}],['DELETE','']]){
    const rejected=await call(method,`/notes/${note.id}${suffix}`,body);assert.equal(rejected.status,404);noRestricted(rejected);
  }
  saveWallConfig(d,{widgets:WALL_DEFAULTS.widgets.map(w=>({...w,visible:w.id==='notes'}))});
  noRestricted({board,dashboard,search,wall:wallDashboard(d,1,row=>row)});
  assert.match(board.headers.get('cache-control'),/private.*no-store/);
});
test('a shared display with every Notes grant still cannot inherit restricted notes through an old client',()=>{
  d.prepare("INSERT INTO household_devices(id,name,permissions_json,scope_json,preferences_json) VALUES(99,'Synthetic rollback display','{}','{}','{}')").run();
  const permissions=devicePreset();for(const action of ['view','create','edit','delete'])permissions.capabilities[`device_notes.${action}`]='allow';
  const principal={kind:'device',id:99,status:'active',permissions:normalizeDevicePermissions(permissions),scope:{member_ids:[1,2]}};
  const list=deviceNotesRequest(d,principal,'GET');assert.deepEqual(list.body.data.map(n=>n.id),[sharedNote.id]);noRestricted(list);
  for(const note of [privateNote,selectedNote]){
    const before=snapshot(note.id);
    for(const method of ['GET','PUT','DELETE'])assert.throws(()=>deviceNotesRequest(d,principal,method,note.id,null,{content:'legacy request',expected_revision:before.note.revision}),error=>error.status===404);
    assert.deepEqual(snapshot(note.id),before);
  }
});
test('an explicitly invalid null audience fails closed instead of publishing a new note to Everyone',async()=>{
  actor=1;const before=d.prepare('SELECT COUNT(*) n FROM notes').get().n;
  const result=await call('POST','/notes',{content:'Invalid audience must not publish',visibility:null});
  try{assert.equal(result.status,400);assert.equal(d.prepare('SELECT COUNT(*) n FROM notes').get().n,before);}
  finally{d.prepare("DELETE FROM notes WHERE content='Invalid audience must not publish'").run();}
});
