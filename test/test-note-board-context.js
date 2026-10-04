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
const d=get(),password='synthetic-notes-context-password',hash=await hashPassword(password,4);
for(const [id,name,role] of [[1,'owner','admin'],[2,'recipient','member'],[3,'other','admin']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,name,hash,role);
const seed=(title,visibility)=>Number(d.prepare('INSERT INTO notes(title,content,visibility,created_by) VALUES(?,?,?,1)').run(title,`Body ${title}`,visibility).lastInsertRowid);
const shared=seed('HOUSEHOLD NOTE','all'),privateId=seed('SECRET PRIVATE NOTE','private'),selected=seed('SECRET SELECTED NOTE','selected');
d.prepare('INSERT INTO note_access(note_id,user_id) VALUES(?,2)').run(selected);
const app=express();app.set('trust proxy','loopback');app.use(compression());app.use(express.json());
app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/device',deviceRouter);app.use('/api/v1/devices',devicesRouter);app.use('/api/v1/auth',authRouter);
app.use('/api/v1',requireAuth,csrfMiddleware,deviceAppMiddleware);
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
function publicOnly(payload){assert.ok(!JSON.stringify(payload).includes('SECRET'));assert.deepEqual(payload.data.map(n=>n.id),[shared]);}
async function stream(client){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),8000);
  const response=await fetch(`${base}/api/v1/notes/changes`,{headers:client.headers(),signal:abort.signal});
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-transform/);
  const reader=response.body.getReader(),decoder=new TextDecoder();let text=decoder.decode((await reader.read()).value);
  assert.match(text,/event: change/);assert.ok(!text.includes('SECRET'));
  return {async closed(){for(;;){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value);}return text;},close(){clearTimeout(timer);abort.abort();}};
}

test('real temporary login reveals only its account, then return invalidates stale cookies and restores Everyone projection',async()=>{
  const {display}=await pair();publicOnly((await ok(display,'GET','/api/v1/notes?user_id=1&selected_member_id=1')).body);
  await temporary(display);
  const personal=await ok(display,'GET','/api/v1/notes');assert.deepEqual(personal.body.data.map(n=>n.id).sort(),[shared,privateId,selected].sort());assert.match(personal.headers.get('cache-control'),/private.*no-store/);
  const stale=new Client(display);await ok(display,'POST','/api/v1/device/return',{});
  for(const path of ['/api/v1/notes',`/api/v1/notes/${privateId}`]){const rejected=await stale.call('GET',path);assert.equal(rejected.status,409);assert.ok(!JSON.stringify(rejected.body).includes('SECRET'));}
  publicOnly((await ok(display,'GET','/api/v1/notes')).body);
  assert.equal((await ok(admin,'GET','/api/v1/auth/me')).body.user.id,1,'another personal session stays signed in');
});
test('idle and absolute expiry reject old Notes reads/writes before returning to device permissions',async()=>{
  for(const reason of ['idle','absolute']){
    const {display}=await pair();await temporary(display);const row=credential(display),before=d.prepare('SELECT * FROM notes WHERE id=?').get(privateId);
    if(reason==='idle')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-301000,row.id);
    else d.prepare('UPDATE device_credentials SET temporary_started_at=?,temporary_idle_at=? WHERE id=?').run(Date.now()-901000,Date.now(),row.id);
    const read=await display.call('GET',`/api/v1/notes/${privateId}`);assert.equal(read.status,409);assert.ok(!JSON.stringify(read.body).includes('SECRET'));
    const write=await display.call('PUT',`/api/v1/notes/${privateId}`,{content:'forbidden',expected_revision:before.revision});assert.ok([403,404,409].includes(write.status));
    assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(privateId),before);
    await ok(display,'GET','/api/v1/device/context');publicOnly((await ok(display,'GET','/api/v1/notes')).body);
  }
});
test('held real Notes writes cannot commit after return, expiry, or device revocation',async()=>{
  for(const invalidation of ['return','expiry','revoke']){
    const {display,id}=await pair();await temporary(display);const before=d.prepare('SELECT * FROM notes WHERE id=?').get(privateId);
    let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);held={entered,gate};
    const pending=new Client(display).call('PUT',`/api/v1/notes/${privateId}`,{content:'held unauthorized mutation',expected_revision:before.revision},{'x-test-hold':'yes'});
    try{
      await started;
      if(invalidation==='return')await ok(display,'POST','/api/v1/device/return',{});
      if(invalidation==='expiry')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-301000,credential(display).id);
      if(invalidation==='revoke')await ok(admin,'POST',`/api/v1/devices/${id}/revoke`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision});
      release();const result=await pending;assert.equal(result.status,409,JSON.stringify(result.body));assert.ok(!JSON.stringify(result.body).includes('SECRET'));
      assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(privateId),before);
    }finally{release();}
  }
});
test('held real layout flag writes cannot commit after return, expiry or device revocation',async()=>{
  for(const invalidation of ['return','expiry','revoke']){
    const {display,id}=await pair();await temporary(display);const before=d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(privateId),beforeNote=d.prepare('SELECT * FROM notes WHERE id=?').get(privateId);
    let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);held={entered,gate};
    const pending=new Client(display).call('PATCH',`/api/v1/notes/${privateId}/layout`,{expected_layout_revision:before?.revision??0,position_locked:true,always_on_top:true},{'x-test-hold':'yes'});
    try{await started;if(invalidation==='return')await ok(display,'POST','/api/v1/device/return',{});if(invalidation==='expiry')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-301000,credential(display).id);if(invalidation==='revoke')await ok(admin,'POST',`/api/v1/devices/${id}/revoke`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision});
      release();const result=await pending;assert.equal(result.status,409,JSON.stringify(result.body));assert.deepEqual(d.prepare('SELECT * FROM note_layouts WHERE note_id=?').get(privateId),before);assert.deepEqual(d.prepare('SELECT * FROM notes WHERE id=?').get(privateId),beforeNote);
    }finally{release();}
  }
});
test('personal Notes stream closes when actual persisted session logs out or Notes permission is revoked',async()=>{
  let feed=await stream(user);
  try{
    d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','notes','none')").run();
    assert.ok(!(await feed.closed()).includes('SECRET'));
    assert.equal((await user.call('GET','/api/v1/notes')).status,403);
  }finally{feed.close();d.prepare("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id='2' AND resource_key='notes'").run();}
  feed=await stream(user);try{await ok(user,'POST','/api/v1/auth/logout',{});assert.ok(!(await feed.closed()).includes('SECRET'));}finally{feed.close();}
});
test('Notes streams close on device permission revision, revocation, temporary return and temporary expiry',async()=>{
  for(const invalidation of ['permission','revoke','return','expiry']){
    const {display,id}=await pair();if(['return','expiry'].includes(invalidation))await temporary(display);
    const feed=await stream(display);
    try{
      if(invalidation==='permission')await ok(admin,'PATCH',`/api/v1/devices/${id}`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision,permissions:{capabilities:{'device_notes.view':'none'}}});
      if(invalidation==='revoke')await ok(admin,'POST',`/api/v1/devices/${id}/revoke`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision});
      if(invalidation==='return')await ok(display,'POST','/api/v1/device/return',{});
      if(invalidation==='expiry')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-301000,credential(display).id);
      const wire=await feed.closed();assert.ok(!wire.includes('SECRET'));assert.ok(!wire.includes('note_id'));
    }finally{feed.close();}
  }
});
