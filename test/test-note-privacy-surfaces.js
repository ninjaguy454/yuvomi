/** Notes privacy through real aggregate HTTP responses and the shared Wall projection. */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'synthetic-note-privacy-surfaces';
const { ALL_MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { resolvePermissions, buildSessionModuleAccess } = await import('../server/permissions.js');
const { default: dashboardRouter } = await import('../server/routes/dashboard.js');
const { default: searchRouter } = await import('../server/routes/search.js');
const { wallDashboard, saveWallConfig, WALL_DEFAULTS } = await import('../server/services/wall.js');
const initial = get();
const d = new Database(':memory:');
d.pragma('foreign_keys = ON');
d.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT 'test')");
for (const m of ALL_MIGRATIONS) {
  if (typeof m.up === 'function') m.up(d); else d.exec(m.up);
  m.afterUp?.(d);
  d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(m.version,m.description);
}
_setTestDatabase(d);
initial.close();
const member = (name, role='member') => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'synthetic',?,'parent')").run(name,name,role).lastInsertRowid);
const creator = member('Creator'), recipient = member('Recipient'), outsider = member('Outsider'), admin = member('Admin','admin');
const note = (key, visibility, owner=creator, pinned=1) => Number(d.prepare('INSERT INTO notes(title,content,visibility,created_by,pinned) VALUES(?,?,?,?,?)').run(`Beacon ${key}`,`Body ${key}`,visibility,owner,pinned).lastInsertRowid);
const shared = note('SHARED', 'all');
const selected = note('SELECTED', 'selected');
d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,?)').run(selected,recipient);
const privateNote = note('PRIVATE', 'private');
// Stale recipient rows must never turn a Private note into Selected visibility.
d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,?)').run(privateNote,recipient);
const ownPrivate = note('OWNPRIVATE', 'private', recipient);
const adminPrivate = note('ADMINPRIVATE', 'private',admin);
// Newest hidden notes must never starve a permitted preview/search before LIMIT.
const hidden = Array.from({length:9}, (_,i) => note(`HIDDEN${i}`,'private'));
let actor = recipient;
const app = express();
app.use((req,_res,next) => {
  const user=d.prepare('SELECT * FROM users WHERE id=?').get(actor);
  req.authUserId=user.id; req.authRole=user.role; req.session={userId:user.id,role:user.role};
  req.sessionModuleAccess=user.role==='admin'?null:buildSessionModuleAccess(resolvePermissions(d,user));
  next();
});
app.use('/dashboard',dashboardRouter);
app.use('/search',searchRouter);
const server=http.createServer(app);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.close();d.close();});
async function response(path,userId) {
  actor=userId;
  const res=await fetch(`${base}${path}`);
  assert.equal(res.status,200);
  if(path==='/dashboard')assert.match(res.headers.get('cache-control'),/private.*no-store/);
  return res.json();
}
function noHidden(payload, forbidden) {
  const wire=JSON.stringify(payload);
  for(const id of forbidden) {
    const row=d.prepare('SELECT title,content FROM notes WHERE id=?').get(id);
    assert.ok(!wire.includes(row.title),`Hidden title leaked: ${row.title}`);
    assert.ok(!wire.includes(row.content),`Hidden content leaked: ${row.content}`);
  }
}
const ids = rows => rows.map(row=>row.id).sort((a,b)=>a-b);

test('dashboard applies creator/recipient privacy before previews and exact pinned counts', async()=>{
  const payload=await response('/dashboard',recipient);
  assert.deepEqual(ids(payload.pinnedNotes),[shared,selected,ownPrivate]);
  assert.equal(payload.pinnedNotesCount,3);
  noHidden(payload,[privateNote,adminPrivate,...hidden]);
  assert.ok(payload.pinnedNotes.every(n=>!('recipients' in n)&&!('access_user_ids' in n)));
});
test('administrator has no implicit private or selected Notes bypass', async()=>{
  const payload=await response('/dashboard',admin);
  assert.deepEqual(ids(payload.pinnedNotes),[shared,adminPrivate]);
  assert.equal(payload.pinnedNotesCount,2);
  noHidden(payload,[selected,privateNote,ownPrivate,...hidden]);
});
test('creator retains selected/private access and pinned count is not capped to the preview limit',async()=>{
  const payload=await response('/dashboard',creator);
  assert.equal(payload.pinnedNotes.length,5);
  assert.equal(payload.pinnedNotesCount,12);
  noHidden(payload,[ownPrivate,adminPrivate]);
  assert.deepEqual(ids((await response('/search?q=SELECTED',creator)).notes),[selected]);
  assert.deepEqual(ids((await response('/search?q=PRIVATE',creator)).notes),[privateNote]);
});
test('global search finds household and selected notes from other authors without leaking other audiences', async()=>{
  const payload=await response('/search?q=Beacon',recipient);
  assert.deepEqual(ids(payload.notes),[shared,selected,ownPrivate]);
  noHidden(payload,[privateNote,adminPrivate,...hidden]);
  const other=await response('/search?q=Beacon',outsider);
  assert.deepEqual(ids(other.notes),[shared]);
  noHidden(other,[selected,privateNote,ownPrivate,adminPrivate,...hidden]);
});
test('revoking a selected recipient removes previews, counts, and search on the next request',async()=>{
  d.prepare('DELETE FROM note_access WHERE note_id=? AND user_id=?').run(selected,recipient);
  try {
    const dashboard=await response('/dashboard',recipient),search=await response('/search?q=Beacon',recipient);
    assert.deepEqual(ids(dashboard.pinnedNotes),[shared,ownPrivate]);
    assert.equal(dashboard.pinnedNotesCount,2);
    assert.deepEqual(ids(search.notes),[shared,ownPrivate]);
    noHidden({dashboard,search},[selected,privateNote,adminPrivate,...hidden]);
  } finally {d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,?)').run(selected,recipient);}
});
test('module denial remains enforced for otherwise visible notes on every consumer',async()=>{
  d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user',?,'module','notes','none')").run(String(recipient));
  try {
    const dashboard=await response('/dashboard',recipient),search=await response('/search?q=Beacon',recipient);
    assert.deepEqual(dashboard.pinnedNotes,[]);assert.equal(dashboard.pinnedNotesCount,0);assert.deepEqual(search.notes,[]);
    saveWallConfig(d,{widgets:WALL_DEFAULTS.widgets.map(w=>({...w,visible:w.id==='notes'}))});
    assert.deepEqual(wallDashboard(d,recipient,row=>row).pinnedNotes,[]);
  } finally {d.prepare("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id=? AND resource_key='notes'").run(String(recipient));}
});
test('legacy Wall never exposes private/selected notes, even for creator, selected recipient, or administrator hosts',()=>{
  saveWallConfig(d,{widgets:WALL_DEFAULTS.widgets.map(w=>({...w,visible:w.id==='notes'}))});
  for(const host of [creator,recipient,admin]) {
    const payload=wallDashboard(d,host,row=>row);
    assert.deepEqual(ids(payload.pinnedNotes),[shared]);
    noHidden(payload,[selected,privateNote,ownPrivate,adminPrivate,...hidden]);
    assert.deepEqual(Object.keys(payload.pinnedNotes[0]).sort(),['content','id','title']);
  }
});
test('tightening an Everyone note to Private removes it from other members and the shared Wall immediately',async()=>{
  d.prepare("UPDATE notes SET visibility='private' WHERE id=?").run(shared);
  try {
    const dashboard=await response('/dashboard',outsider),search=await response('/search?q=Beacon',outsider);
    const wall=wallDashboard(d,creator,row=>row);
    assert.deepEqual(dashboard.pinnedNotes,[]);assert.equal(dashboard.pinnedNotesCount,0);
    assert.deepEqual(search.notes,[]);assert.deepEqual(wall.pinnedNotes,[]);
    noHidden({dashboard,search,wall},[shared,selected,privateNote,ownPrivate,adminPrivate,...hidden]);
  } finally {d.prepare("UPDATE notes SET visibility='all' WHERE id=?").run(shared);}
});
