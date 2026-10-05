/** Notes identity boundaries exercised with real cookies, password login and pairing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import compression from 'compression';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='synthetic-notes-context-session';
process.env.SESSION_SECURE='false';process.env.LOG_LEVEL='error';process.env.AUTH_ALLOW_PASSWORD_LOGIN='true';
process.env.RATE_LIMIT_MAX_ATTEMPTS='100';
const {get}=await import('../server/db.js');
const {sessionMiddleware,router:authRouter,requireAuth}=await import('../server/auth.js');
const {deviceRouter,devicesRouter}=await import('../server/routes/devices.js');
const {deviceBoundary,deviceHash,DEVICE_COOKIE}=await import('../server/services/devices.js');
const {deviceAppMiddleware}=await import('../server/services/device-app.js');
const {hashPassword}=await import('../server/utils/password.js');
const {csrfMiddleware}=await import('../server/middleware/csrf.js');
const {default:notesRouter}=await import('../server/routes/notes.js');
const {default:idempotency}=await import('../server/middleware/idempotency.js');
const {createNoteGroupDraft,freezeNoteGroupCommand}=await import('../public/utils/note-group-draft.js');
const {deviceAppRouteSupported}=await import('../server/services/device-app-paths.js');
const d=get(),password='synthetic-notes-context-password',hash=await hashPassword(password,4);
for(const [id,name,role] of [[1,'owner','admin'],[2,'recipient','member'],[3,'other','admin']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,name,hash,role);
const seed=(title,visibility)=>Number(d.prepare('INSERT INTO notes(title,content,visibility,created_by) VALUES(?,?,?,1)').run(title,`Body ${title}`,visibility).lastInsertRowid);
const shared=seed('HOUSEHOLD NOTE','all'),privateId=seed('SECRET PRIVATE NOTE','private'),selected=seed('SECRET SELECTED NOTE','selected');
d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,2)').run(selected);
const app=express();app.set('trust proxy','loopback');app.use(compression());app.use(express.json());
app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/device',deviceRouter);app.use('/api/v1/devices',devicesRouter);app.use('/api/v1/auth',authRouter);
app.use('/api/v1',requireAuth,csrfMiddleware,deviceAppMiddleware,idempotency);
// A controlled await between the real auth boundary and real Notes route tests
// the installed database write lease, not a hand-constructed principal.
let held;
app.use('/api/v1/notes',async(req,_res,next)=>{
  if(req.get('x-test-hold')==='yes'){held.entered();await held.gate;}next();
});
app.use('/api/v1/notes',notesRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.closeAllConnections();server.close();});
let nextIp=20;
class Client {
  constructor(copy){this.cookies=new Map(copy?.cookies);this.context=copy?.context;this.csrf=copy?.csrf;this.ip=copy?.ip||`192.0.2.${nextIp++}`;}
  headers(extra={}){return {'content-type':'application/json','x-forwarded-for':this.ip,cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(this.context?{'x-auth-context':this.context}:{}),...(this.csrf?{'x-csrf-token':this.csrf}:{}),...extra};}
  async call(method,path,body,headers={}){
    const response=await fetch(base+path,{method,headers:this.headers(headers),...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const cookie of response.headers.getSetCookie()){const part=cookie.split(';')[0],index=part.indexOf('=');this.cookies.set(part.slice(0,index),part.slice(index+1));}
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}
    this.context=response.headers.get('x-auth-context')||value?.authContext||this.context;
    this.csrf=response.headers.get('x-csrf-token')||value?.csrfToken||this.cookies.get('csrf-token')||this.csrf;
    return {status:response.status,body:value,headers:response.headers};
  }
}
async function ok(client,method,path,body,status=200){const value=await client.call(method,path,body);assert.equal(value.status,status,JSON.stringify(value.body));return value;}
const admin=new Client();await ok(admin,'POST','/api/v1/auth/login',{username:'owner',password});
const user=new Client();await ok(user,'POST','/api/v1/auth/login',{username:'recipient',password});
async function pair(){
  const display=new Client(),code=await ok(display,'POST','/api/v1/device/pair',{});
  const approved=await ok(admin,'POST','/api/v1/devices/pairing-approve',{code:code.body.code,name:`Synthetic Notes ${nextIp}`},201),id=approved.body.data.id;
  await ok(display,'POST','/api/v1/device/pair/claim',{confirm_transition:true});await ok(display,'POST','/api/v1/device/launch',{});
  await ok(admin,'PATCH',`/api/v1/devices/${id}`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision,permissions:{capabilities:{'device_notes.view':'allow','device_notes.create':'allow','device_notes.edit':'none','device_notes.delete':'none'}}});
  await ok(display,'GET','/api/v1/device/context');return {display,id};
}
async function temporary(display){await ok(display,'POST','/api/v1/device/temporary/begin',{});await ok(display,'POST','/api/v1/auth/login',{username:'owner',password});}
const credential=display=>d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(display.cookies.get(DEVICE_COOKIE)));
let operation = 0;
async function board(client = admin) { return (await ok(client, 'GET', '/api/v1/notes/board')).body.data; }
async function command(client, kind, fields) { return freezeNoteGroupCommand(createNoteGroupDraft(await board(client), `route-operation-${++operation}`), kind, fields); }
async function createPair(client = admin, visibility = 'all') {
  const target = (await ok(admin, 'POST', '/api/v1/notes', { title: `Target ${operation}`, content: 'group target', visibility }, 201)).body.data;
  const source = (await ok(admin, 'POST', '/api/v1/notes', { title: `Source ${operation}`, content: 'group source', visibility }, 201)).body.data;
  await ok(admin, 'PATCH', `/api/v1/notes/${target.id}/layout`, { expected_layout_revision: 0, position_locked: true });
  const body = await command(client, 'create', { source_note_id: source.id, target_note_id: target.id });
  const result = (await ok(client, 'POST', '/api/v1/notes/group-operations', body)).body.data;
  return { source, target, command: body, result, group: result.board.groups.find(group => group.member_ids.includes(target.id)) };
}

test('fixed board route preserves the old list contract and returns a private no-store board', async () => {
  const response = await ok(admin, 'GET', '/api/v1/notes/board');
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.ok(Array.isArray(response.body.data.notes)); assert.deepEqual(response.body.data.groups, []);
  const legacy = await ok(admin, 'GET', '/api/v1/notes');
  assert.deepEqual(legacy.body.data, response.body.data.notes);
});
test('OpenAPI describes strict command variants and operation receipts without generic response replay', async () => {
  const { buildOpenApiSpec } = await import('../server/openapi.js');
  const spec = buildOpenApiSpec({protocol:'http',get:()=> 'synthetic.test'}, 'synthetic');
  const post = spec.paths['/api/v1/notes/group-operations'].post;
  assert.ok(!post.parameters.some(parameter=>parameter.name==='Idempotency-Key'));
  const variants = post.requestBody.content['application/json'].schema.oneOf;
  assert.equal(variants.length,8); assert.ok(variants.every(schema=>schema.additionalProperties===false));
  assert.equal(variants.find(schema=>schema.properties.kind.enum[0]==='undo').properties.expected.properties.notes.maxItems,0);
  assert.ok(post.responses[409]); assert.ok(post.responses[503]);
});
test('only the explicit device board and group-operation paths are admitted', () => {
  for (const path of ['/notes/board', '/api/v1/notes/board?user_id=1']) assert.equal(deviceAppRouteSupported('GET', path), true);
  assert.equal(deviceAppRouteSupported('POST', '/api/v1/notes/group-operations'), true);
  for (const [method, path] of [['PUT', '/notes/group-operations'], ['GET', '/notes/group-operations'], ['POST', '/notes/board'], ['POST', '/notes/groups/1']]) assert.equal(deviceAppRouteSupported(method, path), false);
});
test('canonical operations enforce revisions, variant fields and same-operation replay', async () => {
  const made = await createPair();
  assert.deepEqual(made.group.member_ids, [made.target.id, made.source.id]);
  assert.equal(made.result.undo_available, true);
  const repeat = await ok(admin, 'POST', '/api/v1/notes/group-operations', made.command);
  assert.equal(repeat.body.data.replayed, true); assert.match(repeat.headers.get('cache-control'), /no-store/);
  assert.equal((await admin.call('POST', '/api/v1/notes/group-operations', { ...made.command, typo: true })).status, 400);
  assert.equal((await admin.call('POST', '/api/v1/notes/group-operations', { ...made.command, source_note_id: shared })).status, 409);
  const stale = await command(admin, 'reorder', { group_id: made.group.id, selected_ids: [made.source.id], before_note_id: made.target.id });
  await ok(admin, 'PATCH', `/api/v1/notes/${made.source.id}/pin`, { expected_revision: made.source.revision });
  assert.equal((await admin.call('POST', '/api/v1/notes/group-operations', stale)).status, 409);
});
test('recovery mode denies mutations and receipt replay with no-store error envelopes', async () => {
  const made = await createPair();
  process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS='0';
  try {
    const response=await admin.call('POST','/api/v1/notes/group-operations',made.command);
    assert.equal(response.status,503); assert.equal(response.body.code,503); assert.match(response.headers.get('cache-control'),/no-store/);
    const edited=await ok(admin,'PUT',`/api/v1/notes/${made.source.id}`,{title:'Recovery content remains editable',expected_revision:made.source.revision});
    assert.equal(edited.body.data.title,'Recovery content remains editable');
    assert.ok((await board()).groups.some(group=>group.id===made.group.id));
  } finally { delete process.env.VIDAMIA_NOTE_GROUPS_MUTATIONS; }
});
test('the HTTP command limit rejects oversized snapshots with an actionable error and no write', async () => {
  const made=await createPair();
  const body=await command(admin,'reorder',{group_id:made.group.id,selected_ids:[made.source.id],before_note_id:null});
  const oversized={...body,expected:{...body.expected,notes:Array.from({length:501},(_,index)=>({id:index+1,revision:1,layout_revision:0}))}};
  const response=await admin.call('POST','/api/v1/notes/group-operations',oversized);
  assert.equal(response.status,400); assert.match(response.body.error,/500.*fewer|fewer.*500/i);
  assert.deepEqual((await board()).groups.find(group=>group.id===made.group.id),made.group);
});
test('invisible and unknown groups are concealed, while visible read-only members deny editing', async () => {
  const hidden = await createPair(admin, 'private');
  for (const id of [hidden.group.id, 999999]) {
    const response = await user.call('POST', '/api/v1/notes/group-operations', { operation_id: `invisible-${id}`, kind: 'reorder', expected: { groups: [], notes: [] }, group_id: id, selected_ids: [hidden.source.id], before_note_id: null });
    assert.equal(response.status, 404); assert.ok(!JSON.stringify(response.body).includes('group source'));
  }
  const made = await createPair(); const body = await command(user, 'reorder', { group_id: made.group.id, selected_ids: [made.source.id], before_note_id: null });
  d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','notes','read')").run();
  try { assert.equal((await user.call('POST', '/api/v1/notes/group-operations', body)).status, 403); }
  finally { d.prepare("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id='2' AND resource_key='notes'").run(); }
});
test('partial group projection has dense authorized members and does not dissolve storage', async () => {
  const made = await createPair();
  await ok(admin, 'PUT', `/api/v1/notes/${made.source.id}`, { visibility: 'private', expected_revision: made.source.revision });
  const visible = await board(user);
  assert.ok(!visible.notes.some(note => note.id === made.source.id));
  assert.ok(!visible.groups.some(group => group.id === made.group.id), 'a sole visible page looks like a standalone note');
  assert.deepEqual((await board()).groups.find(group => group.id === made.group.id).member_ids, [made.target.id, made.source.id]);
});
test('generic HTTP idempotency cannot replay an old group board after access is lost', async () => {
  const made = await createPair();
  const body = await command(user, 'reorder', { group_id: made.group.id, selected_ids: [made.source.id], before_note_id: made.target.id });
  const headers = { 'Idempotency-Key': 'group-access-check' };
  assert.equal((await user.call('POST', '/api/v1/notes/group-operations/?test=1', body, headers)).status, 200);
  await ok(admin, 'PUT', `/api/v1/notes/${made.source.id}`, { visibility: 'private', expected_revision: made.source.revision });
  const retry = await user.call('POST', '/api/v1/notes/group-operations/?test=1', body, headers);
  assert.equal(retry.status, 404); assert.ok(!JSON.stringify(retry.body).includes('group source'));
  assert.equal(d.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE key='group-access-check'").get().n, 0);
});
test('devices need both view and edit, retain member scope, and audit as the device', async () => {
  const { display, id } = await pair();
  const made = await createPair();
  const snapshot = await board(display);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  const denied = { operation_id: 'device-denied', kind: 'reorder', expected: { groups: [], notes: [] }, group_id: made.group.id, selected_ids: [made.source.id], before_note_id: null };
  assert.equal((await display.call('POST', '/api/v1/notes/group-operations', denied)).status, 403);
  for (const grants of [{ view: 'none', create: 'allow', edit: 'none' }, { view: 'none', create: 'none', edit: 'allow' }]) {
    await ok(admin, 'PATCH', `/api/v1/devices/${id}`, { revision: d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision, permissions: { capabilities: Object.fromEntries(Object.entries(grants).map(([key, value]) => [`device_notes.${key}`, value])) } });
    await ok(display, 'GET', '/api/v1/device/context');
    const response = await display.call('GET', '/api/v1/notes/board?selected_member_id=1');
    assert.equal(response.status, 403); assert.ok(!JSON.stringify(response.body).includes('SECRET'));
  }
  await ok(admin, 'PATCH', `/api/v1/devices/${id}`, { revision: d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision, permissions: { capabilities: { 'device_notes.view': 'allow', 'device_notes.edit': 'allow' } }, scope: { member_ids: [2] } });
  await ok(display, 'GET', '/api/v1/device/context');
  const scoped = await board(display); assert.ok(scoped.notes.every(note => !('created_by' in note) && !note.creator_name));
  const body = await command(display, 'reorder', { group_id: made.group.id, selected_ids: [made.source.id], before_note_id: made.target.id });
  const response = await ok(display, 'POST', '/api/v1/notes/group-operations', body);
  assert.ok(!JSON.stringify(response.body).includes('SECRET'));
  const audit = d.prepare('SELECT * FROM device_audit_events WHERE device_id=? ORDER BY id DESC LIMIT 1').get(id);
  assert.equal(audit.actor_user_id, null); assert.equal(audit.event_type, 'note_group_operation');
});
test('temporary human context cannot replay group commands after return or commit a held command', async () => {
  const { display } = await pair(); await temporary(display);
  const made = await createPair(display, 'private'); const old = new Client(display);
  const body = await command(display, 'reorder', { group_id: made.group.id, selected_ids: [made.source.id], before_note_id: made.target.id });
  let entered, release;
  const started = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve); held = { entered, gate };
  const pending = old.call('POST', '/api/v1/notes/group-operations', body, { 'x-test-hold': 'yes' });
  try {
    await started; await ok(display, 'POST', '/api/v1/device/return', {}); release();
    const response = await pending; assert.equal(response.status, 409); assert.ok(!JSON.stringify(response.body).includes('group source'));
    assert.equal((await old.call('POST', '/api/v1/notes/group-operations', made.command)).status, 409);
    assert.ok(!(await board(display)).notes.some(note => note.id === made.source.id));
    assert.deepEqual((await board()).groups.find(group => group.id === made.group.id).member_ids, [made.target.id, made.source.id]);
  } finally { release(); }
});
