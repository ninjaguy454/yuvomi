/** Acceptance identity boundaries exercised with real cookies, login and pairing. */
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
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const d=get(),password='synthetic-notes-context-password',hash=await hashPassword(password,4);
for(const [id,name,role] of [[1,'owner','admin'],[2,'recipient','member'],[3,'other','admin']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,name,hash,role);
const app=express();app.set('trust proxy','loopback');app.use(compression());app.use(express.json());
app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/device',deviceRouter);app.use('/api/v1/devices',devicesRouter);app.use('/api/v1/auth',authRouter);
app.use('/api/v1',requireAuth,csrfMiddleware);
// A controlled await between the real auth boundary and real acceptance route tests
// the installed database write lease, not a hand-constructed principal.
let held;
app.use('/api/v1/tasks',async(req,_res,next)=>{
  if(req.get('x-test-hold')==='yes'){held.entered();await held.gate;}next();
});
app.use('/api/v1',deviceAppMiddleware);
app.use('/api/v1/tasks',tasksRouter);
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
const seed=()=>Number(d.prepare("INSERT INTO tasks(title,created_by) VALUES('Context offer',1)").run().lastInsertRowid);
async function pair(){
  const display=new Client(),code=await ok(display,'POST','/api/v1/device/pair',{});
  const approved=await ok(admin,'POST','/api/v1/devices/pairing-approve',{code:code.body.code,name:`Synthetic acceptance ${nextIp}`},201),id=approved.body.data.id;
  await ok(display,'POST','/api/v1/device/pair/claim',{confirm_transition:true});await ok(display,'POST','/api/v1/device/launch',{});
  await ok(admin,'PATCH',`/api/v1/devices/${id}`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision,permissions:{capabilities:{'device_tasks.claim':'allow','device_tasks.accept_with_helpers':'allow'}}});
  await ok(display,'GET','/api/v1/device/context');return {display,id};
}
async function temporary(display){await ok(display,'POST','/api/v1/device/temporary/begin',{});await ok(display,'POST','/api/v1/auth/login',{username:'owner',password});}
const credential=display=>d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(display.cookies.get(DEVICE_COOKIE)));
async function draft(client,id,primary){const detail=(await ok(client,'GET',`/api/v1/tasks/${id}/acceptance${primary?`?primary_user_id=${primary}`:''}`)).body.data;return {operation_id:`context-${id}`,expected_revision:detail.expected_revision,...(primary?{primary_user_id:primary}:{}),coassignee_ids:[],subtask_snapshot:detail.subtask_snapshot,subtask_assignments:[]};}
test('real paired receipt is credential-context bound and never authenticates its selected recipient',async()=>{
  const {display}=await pair(),id=seed(),request=await draft(display,id,2);
  const accepted=await ok(display,'POST',`/api/v1/tasks/${id}/accept`,request);assert.equal(accepted.body.data.assigned_to,2);
  assert.equal((await ok(display,'POST',`/api/v1/tasks/${id}/accept`,request)).body.replayed,true);
  const event=d.prepare("SELECT actor_user_id FROM task_activity_events WHERE task_id=? AND event_type='claimed'").get(id);assert.equal(event.actor_user_id,null);
  const old=new Client(display);await temporary(display);await ok(display,'POST','/api/v1/device/return',{});
  assert.equal((await old.call('POST',`/api/v1/tasks/${id}/accept`,request)).status,409);
  assert.equal((await display.call('POST',`/api/v1/tasks/${id}/accept`,request)).status,409);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts WHERE task_id=?').get(id).n,1);
});
test('real delayed confirmations cannot commit after temporary return, expiry, revocation or device permission change',async()=>{
  for(const invalidation of ['return','expiry','revoke','permission']){
    const {display,id:deviceId}=await pair();if(invalidation!=='permission')await temporary(display);
    const id=seed(),request=await draft(display,id,invalidation==='permission'?2:undefined),before=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);held={entered,gate};
    const pending=new Client(display).call('POST',`/api/v1/tasks/${id}/accept`,request,{'x-test-hold':'yes'});
    try{
      await started;
      if(invalidation==='return')await ok(display,'POST','/api/v1/device/return',{});
      if(invalidation==='expiry')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-301000,credential(display).id);
      if(invalidation==='revoke')await ok(admin,'POST',`/api/v1/devices/${deviceId}/revoke`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(deviceId).revision});
      if(invalidation==='permission')await ok(admin,'PATCH',`/api/v1/devices/${deviceId}`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(deviceId).revision,permissions:{capabilities:{'device_tasks.claim':'none'}}});
      release();const result=await pending;assert.ok([403,409].includes(result.status),JSON.stringify(result.body));
      assert.deepEqual(d.prepare('SELECT * FROM tasks WHERE id=?').get(id),before);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts WHERE task_id=?').get(id).n,0);
    }finally{release();}
  }
});
