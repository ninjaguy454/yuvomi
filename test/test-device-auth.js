/** HTTP identity boundary tests use real password/2FA authentication, session
 * cookies, SQLite session persistence, pairing endpoints and canonical guards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='device-auth-synthetic-isolated-session-key';
process.env.SESSION_SECURE='false';process.env.LOG_LEVEL='error';process.env.AUTH_ALLOW_PASSWORD_LOGIN='true';
process.env.RATE_LIMIT_MAX_ATTEMPTS='100';
const db=await import('../server/db.js');
const {sessionMiddleware,router:authRouter,requireAuth}=await import('../server/auth.js');
const {deviceRouter,devicesRouter}=await import('../server/routes/devices.js');
const {deviceBoundary,deviceHash,DEVICE_COOKIE}=await import('../server/services/devices.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
const {default:readerRouter}=await import('../server/routes/reader.js');
const {csrfMiddleware}=await import('../server/middleware/csrf.js');
const {createChangesStream}=await import('../server/services/change-stream.js');
const {default:documentsRouter}=await import('../server/routes/documents.js');
const {default:tasksRouter}=await import('../server/routes/tasks.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const d=db.get(),password='device-test-password';
const hash=await hashPassword(password,4);
for(const [id,name,role] of [[1,'parent','admin'],[2,'child','member'],[3,'second-factor-parent','admin']])d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)').run(id,name,name,hash,role);
const app=express();app.set('trust proxy','loopback');app.use(compression());app.use(express.json());app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/device',deviceRouter);app.use('/api/v1/devices',devicesRouter);app.use('/api/v1/auth',authRouter);app.use('/reader',readerRouter);
app.use('/api/v1',requireAuth,csrfMiddleware);
app.get('/api/v1/tasks/changes',createChangesStream({table:'task_change_clock',canRead:()=>true,deniedMessage:'Sign-in required.'}));
app.use('/api/v1/tasks',tasksRouter);
app.use('/api/v1/documents',documentsRouter);
// A real authenticated route isolates the canonical post-await DB boundary from
// route-local checks. Production mutation routes use the same installed handle.
d.exec('CREATE TABLE device_lease_probe(id INTEGER PRIMARY KEY,value TEXT)');
let leaseProbe;
app.post('/api/v1/device-lease-probe',async(req,res)=>{
 try{
  leaseProbe.entered();await leaseProbe.gate;
  const statement=d.prepare('INSERT INTO device_lease_probe(value) VALUES (?) RETURNING id');
  const value=statement[req.body.method]('forbidden late write');
  res.json({value});
 }catch(error){res.status(error.status||500).json({error:error.message,reason:error.reason});}
});
// These handlers deliberately expose private content if the real central guard
// ever lets a device through; endpoint denial is inspected before any handler.
app.use('/api/v1', (req,res)=>res.json({privateMarker:'PRIVATE PERSONAL RESPONSE',actor:req.authUserId,role:req.authRole}));
app.use('/mcp',requireAuth,(_req,res)=>res.json({privateMarker:'PRIVATE MCP RESPONSE'}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>server.close());
let nextClientIp=10;
class Client {
 constructor(copy){this.cookies=new Map(copy?.cookies);this.context=copy?.context;this.csrf=copy?.csrf;this.ip=copy?.ip||`192.0.2.${nextClientIp++}`;}
 async call(method,path,body,{headers={},context=this.context,csrf=this.csrf,keepContext=false}={}){
  const response=await fetch(base+path,{method,redirect:'manual',headers:{'content-type':'application/json','x-forwarded-for':this.ip,cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(context?{'x-auth-context':context}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const setCookies=response.headers.getSetCookie();for(const cookie of setCookies){const part=cookie.split(';')[0],index=part.indexOf('=');this.cookies.set(part.slice(0,index),part.slice(index+1));}
  const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}
  const nextContext=response.headers.get('x-auth-context')||data?.authContext;
  if(nextContext&&!keepContext)this.context=nextContext;
  this.csrf=response.headers.get('x-csrf-token')||data?.csrfToken||this.cookies.get('csrf-token')||this.csrf;
  return {status:response.status,body:data,headers:response.headers,setCookies};
 }
}
async function ok(client,method,path,body,status=200,options){const result=await client.call(method,path,body,options);assert.equal(result.status,status,`${method} ${path}: ${JSON.stringify(result.body)}`);return result;}
async function login(client,username='parent'){return ok(client,'POST','/api/v1/auth/login',{username,password});}
const administrator=new Client();await login(administrator);
const otherSession=new Client();await login(otherSession);
const child=new Client();await login(child,'child');
async function pair(name,{display=new Client(),confirm=true}={}){
 const code=await ok(display,'POST','/api/v1/device/pair',confirm?{confirm_transition:true}:{});
 const approved=await ok(administrator,'POST','/api/v1/devices/pairing-approve',{code:code.body.code,name},201);
 assert.deepEqual(Object.keys((await ok(display,'GET','/api/v1/device/pair')).body).sort(),['approved','expiresAt']);
 const claimed=await ok(display,'POST','/api/v1/device/pair/claim',{confirm_transition:true});
 const cookie=claimed.setCookies.find(value=>value.startsWith(`${DEVICE_COOKIE}=`));assert.ok(/HttpOnly/i.test(cookie));assert.ok(/SameSite=Lax/i.test(cookie),'Lax supports the existing authenticated SSO callback; mutations retain origin/CSRF checks');
 assert.ok(!JSON.stringify(claimed.body).includes(display.cookies.get(DEVICE_COOKIE)),'credential is cookie-only');
 await ok(display,'POST','/api/v1/device/launch',{});
 return {client:display,id:approved.body.data.id};
}
const credential=client=>d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(client.cookies.get(DEVICE_COOKIE)));
async function temporary(client,username='parent'){
 await ok(client,'POST','/api/v1/device/temporary/begin',{});const result=await login(client,username);return result;
}

test('pairing is approved by a real administrator, single use, restricted and explicitly removes only this browser personal session',async()=>{
 const display=new Client();await login(display);const oldSession=display.cookies.get('yuvomi.sid');
 assert.equal((await display.call('POST','/api/v1/device/pair',{})).status,400);
 const start=await ok(display,'POST','/api/v1/device/pair',{confirm_transition:true});
 assert.equal((await child.call('POST','/api/v1/devices/pairing-approve',{code:start.body.code,name:'Unauthorized'})).status,403);
 assert.equal((await administrator.call('POST','/api/v1/devices/pairing-approve',{code:'0000-0000-0000',name:'Guess'})).status,404);
 assert.equal((await display.call('POST','/api/v1/device/pair/claim',{confirm_transition:true})).status,409);
 const approved=await ok(administrator,'POST','/api/v1/devices/pairing-approve',{code:start.body.code,name:'Kitchen Wall'},201);
 assert.equal((await administrator.call('POST','/api/v1/devices/pairing-approve',{code:start.body.code,name:'Duplicate'})).status,404);
 assert.equal((await display.call('POST','/api/v1/device/pair/claim',{})).status,400);
 await ok(display,'POST','/api/v1/device/pair/claim',{confirm_transition:true});
 assert.notEqual(display.cookies.get('yuvomi.sid'),oldSession);
 assert.equal((await display.call('POST','/api/v1/device/pair/claim',{confirm_transition:true})).status,409);
 const identity=await ok(display,'POST','/api/v1/device/launch',{});
 assert.equal(identity.body.principal.kind,'device');assert.equal(identity.body.user,undefined);assert.equal(identity.body.permissions.admin,false);
 assert.equal(identity.body.permissions.capabilities['tasks.create'],'none');assert.equal(identity.body.permissions.capabilities['device_tasks.complete'],'allow');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,3,'no fake member added');
 const stored=credential(display);assert.notEqual(stored.token_hash,display.cookies.get(DEVICE_COOKIE));
 const tombstoneSid=decodeURIComponent(oldSession).slice(2).split('.')[0];assert.ok(d.prepare('SELECT 1 FROM device_session_tombstones WHERE sid=?').get(tombstoneSid));
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
 assert.equal(approved.body.data.id,stored.device_id);
});

test('unapproved and expired pairing reveal no household data or credential',async()=>{
 const display=new Client();await ok(display,'POST','/api/v1/device/pair',{});
 const state=await ok(display,'GET','/api/v1/device/pair');assert.equal(state.body.approved,false);assert.ok(!JSON.stringify(state.body).includes('parent'));
 d.prepare('UPDATE device_pairings SET expires_at=? WHERE consumed_at IS NULL AND device_id IS NULL').run(Date.now()-1);
 assert.equal((await display.call('GET','/api/v1/device/pair')).status,410);
 assert.equal((await display.call('POST','/api/v1/device/pair/claim',{confirm_transition:true})).status,409);
});

test('device context rejects direct private and reward-manufacturing paths including cached keys, Reader, MCP and administrator bearer tokens',async()=>{
 const {client:display}=await pair('Boundary display');
 const paths=['tasks','tasks/1/duplicate','automation/tasks','automation/admin/activity-templates','automation/workflow-instances','rewards/adjustments','rewards/bonus','rewards/catalog','rewards/redemptions','permissions','auth/api-tokens','auth/users','documents/1/download','search','dashboard','notifications','automation/rotation-tracks/1','automation/rotation-occurrences/1/history'];
 for(const path of paths)for(const method of ['GET','POST']){
  const result=await display.call(method,`/api/v1/${path}`,method==='POST'?{points:999,assigned_to:2}:undefined,{headers:{'Idempotency-Key':'repeat-privileged-request'}});
  assert.equal(result.status,403,`${method} ${path}`);assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
 }
 for(const path of ['/reader','/reader?view=tasks','/mcp'])assert.equal((await display.call('GET',path)).status,403,path);
 const raw='yuvomi_device_test_admin_token';d.prepare('INSERT INTO api_tokens(name,token_hash,token_prefix,created_by,subject_user_id) VALUES(?,?,?,?,?)').run('Boundary fixture token',crypto.createHash('sha256').update(raw).digest('hex'),'yuvomi_test',1,1);
 for(const headers of [{Authorization:`Bearer ${raw}`},{'X-API-Key':raw},{'api-key':raw}])assert.equal((await display.call('POST','/api/v1/tasks',{title:'Rejected',points:999},{headers})).status,403);
 const mixed=new Client(display);mixed.cookies.set('yuvomi.sid',otherSession.cookies.get('yuvomi.sid'));
 assert.equal((await mixed.call('GET','/api/v1/dashboard')).status,403,'ambient personal cookie is not device authority');
 assert.equal((await ok(mixed,'GET','/api/v1/auth/me')).body.principal.kind,'device');
 assert.equal((await display.call('POST','/api/v1/auth/login',{username:'parent',password})).status,403,'real login still requires explicit temporary intent');
});

test('temporary real sign-in uses personal identity, rotates context, rejects queued device operations, and returns without affecting another session',async()=>{
 const {client:display}=await pair('Temporary display');
 const deviceContext=display.context;const signed=await temporary(display);
 assert.equal(signed.body.user.id,1);assert.ok(signed.body.temporary);assert.notEqual(display.context,deviceContext);
 const personal=await ok(display,'GET','/api/v1/dashboard');assert.equal(personal.body.actor,1);assert.equal(personal.body.role,'admin');
 assert.equal((await display.call('PATCH','/api/v1/device/tasks/999/status',{status:'done',expected_revision:1},{context:deviceContext,keepContext:true})).status,409);
 const stalePersonal=new Client(display);await ok(display,'POST','/api/v1/device/return',{});
 assert.equal((await ok(display,'GET','/api/v1/auth/me')).body.principal.kind,'device');
 assert.equal((await stalePersonal.call('GET','/api/v1/dashboard')).status,409);
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
 assert.equal(d.prepare("SELECT COUNT(*) n FROM device_audit_events WHERE device_id=? AND event_type='temporary_sign_in'").get(credential(display).device_id).n,1);
 assert.equal(d.prepare("SELECT COUNT(*) n FROM device_audit_events WHERE device_id=? AND event_type='temporary_return'").get(credential(display).device_id).n,1);
});

test('qualified administrator completes protected learner and delegated helper work through real temporary password login and canonical Task HTTP routes',async()=>{
 const {client:display}=await pair('Supervised routine display');
 const create=(title,parent=null)=>Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,points,visibility) VALUES(?,1,?,?,?,'all')")
  .run(title,parent?null:2,parent,parent?0:2).lastInsertRowid);
 const root=create('Protected routine'),supervised=create('Supervised learner step',root),delegated=create('Delegated helper step',root);
 d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);
 d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1').run();
 for(const [action,mode] of [[supervised,'supervised'],[delegated,'excluded']]) {
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',1)").run(`HTTP skill ${action}`).lastInsertRowid);
  for(const [member,proficiency] of [[1,'normal'],[2,mode],[3,'excluded']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(member,skill,proficiency);
  setTaskSkills(d,action,[skill]);
 }
 const view=reconcileTaskSupervision(d,root),mapping=view.actions.find(action=>action.action_task_id===delegated);
 assert.equal(view.supervisor_user_id,1);assert.equal(mapping.execution_mode,'delegated');
 assert.equal(view.actions.find(action=>action.action_task_id===supervised).execution_mode,'supervised');
 const revision=id=>{
  const row=d.prepare('SELECT revision,parent_task_id FROM tasks WHERE id=?').get(id);
  return {expected_revision:row.revision,...(row.parent_task_id?{expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id).revision}:{})};
 };
 for(const id of [supervised,delegated,mapping.counterpart_task_id,view.support_task_id,root]) {
  const rejected=await display.call('PATCH',`/api/v1/device/tasks/${id}/status`,{status:'done',complete_remaining:true,...revision(id)});
  assert.equal(rejected.status,403,JSON.stringify(rejected.body));
  assert.match(rejected.body.error,/qualified|supervised|helper/i);
 }
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'open');
 assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(root).n,0);
 const signed=await temporary(display);assert.equal(signed.body.user.id,1);assert.ok(signed.body.temporary);
 await ok(display,'PATCH',`/api/v1/tasks/${supervised}/status`,{status:'done',...revision(supervised)});
 await ok(display,'PATCH',`/api/v1/tasks/${mapping.counterpart_task_id}/status`,{status:'done',...revision(mapping.counterpart_task_id)});
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'done');
 for(const id of [supervised,delegated,mapping.counterpart_task_id])assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
 assert.deepEqual(d.prepare('SELECT user_id,delta,created_by FROM reward_ledger WHERE task_id=?').all(root),[{user_id:2,delta:2,created_by:1}]);
 const events=d.prepare("SELECT actor_user_id,details_json FROM task_activity_events WHERE event_type='completed' AND action_task_id IN (?,?,?)").all(root,supervised,delegated);
 assert.equal(events.length,3);assert.ok(events.every(event=>event.actor_user_id===1&&!JSON.parse(event.details_json).source_device));
 await ok(display,'PATCH',`/api/v1/tasks/${supervised}/status`,{status:'done',...revision(supervised)});
 assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(root).n,1);
 await ok(display,'POST','/api/v1/device/return',{});
 assert.equal((await ok(display,'GET','/api/v1/auth/me')).body.principal.kind,'device');
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('idle and absolute expiration are server authoritative; activity cannot extend the fixed maximum and a fresh launch returns to device',async()=>{
 const {client:display}=await pair('Timeout display');
 for(const column of ['temporary_idle_at','temporary_started_at']){
  await temporary(display);const row=credential(display);
  if(column==='temporary_idle_at')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-121000,row.id);
  else {d.prepare('UPDATE device_credentials SET temporary_started_at=?,temporary_idle_at=? WHERE id=?').run(Date.now()-601000,Date.now(),row.id);}
  const result=await display.call('GET','/api/v1/dashboard');assert.equal(result.status,409,column);assert.equal(result.body.reason,'device_context_changed');
  const restored=await ok(display,'GET','/api/v1/device/context');assert.equal(restored.body.principal.kind,'device');assert.equal(restored.body.temporary,undefined);
  assert.equal(credential(display).temporary_sid,null);
 }
 await temporary(display);const began=credential(display).temporary_started_at;
 await ok(display,'POST','/api/v1/device/activity',{});assert.equal(credential(display).temporary_started_at,began);
 const fresh=await ok(display,'POST','/api/v1/device/launch',{});assert.equal(fresh.body.principal.kind,'device');assert.equal(fresh.body.temporary,undefined);
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('device configuration reduction invalidates already-open contexts and revocation terminates bound temporary access only',async()=>{
 const {client:display,id}=await pair('Revocation display');
 const sameTab=new Client(display);let row=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id);
 await ok(administrator,'PATCH',`/api/v1/devices/${id}`,{revision:row.revision,scope:{member_ids:[2],show_points:false}});
 assert.equal((await sameTab.call('GET','/api/v1/device/dashboard')).status,409);
 await ok(display,'GET','/api/v1/device/context');await temporary(display);
 row=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id);
 await ok(administrator,'POST',`/api/v1/devices/${id}/revoke`,{revision:row.revision});
 assert.equal((await display.call('GET','/api/v1/dashboard')).status,401);
 assert.equal((await display.call('GET','/api/v1/device/context')).status,401);
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('temporary authentication retains the existing second-factor verification flow',async()=>{
 const human=new Client();await login(human,'second-factor-parent');
 const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{});
 const secret=setup.body.secret??setup.body.data?.secret;assert.ok(secret,'the real setup flow provides the enrolled secret');
 const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)});
 const recovery=enabled.body.recovery_codes??enabled.body.data?.recovery_codes;assert.ok(recovery?.length);
 const {client:display}=await pair('Second-factor display');await ok(display,'POST','/api/v1/device/temporary/begin',{});
 const pending=await login(display,'second-factor-parent');assert.equal(pending.body.twoFactorRequired,true);assert.equal(credential(display).temporary_sid,null);
 assert.equal((await display.call('GET','/api/v1/dashboard')).status,403);
 assert.equal((await display.call('POST','/api/v1/auth/2fa/verify',{code:'000000'})).status,401);
 const signed=await ok(display,'POST','/api/v1/auth/2fa/verify',{code:recovery[0]});assert.equal(signed.body.user.id,3);assert.ok(signed.body.temporary);
 await ok(display,'POST','/api/v1/device/return',{});assert.equal((await ok(display,'GET','/api/v1/auth/me')).body.principal.kind,'device');
});

test('origin and CSRF protections reject device transitions, and missing or forged credentials never fall back to a personal cookie',async()=>{
 const {client:display}=await pair('Origin display');
 for(const headers of [{Origin:'https://untrusted.example'},{Origin:'not a valid origin'},{'Sec-Fetch-Site':'cross-site'}])
  assert.equal((await display.call('POST','/api/v1/device/temporary/begin',{}, {headers})).status,403);
 assert.equal((await display.call('POST','/api/v1/device/temporary/begin',{}, {csrf:null})).status,403);
 const forged=new Client(otherSession);forged.cookies.set(DEVICE_COOKIE,'invalid-device-credential');
 assert.equal((await forged.call('GET','/api/v1/auth/me')).status,401);
 await ok(display,'POST','/api/v1/device/temporary/begin',{});
 assert.equal((await display.call('POST','/api/v1/auth/login',{username:'parent',password},{headers:{Origin:'https://untrusted.example'}})).status,403);
 assert.equal((await display.call('POST','/api/v1/auth/login',{username:'child',password})).status,403);
 const signed=await login(display);assert.equal(signed.body.user.id,1);
 const missing=new Client(display);missing.cookies.delete(DEVICE_COOKIE);
 assert.equal((await missing.call('GET','/api/v1/dashboard')).status,401);
 await ok(display,'POST','/api/v1/device/return',{});
});

async function stream(client,path){
 const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),6000);
 const response=await fetch(base+path,{signal:abort.signal,headers:{cookie:[...client.cookies].map(([k,v])=>`${k}=${v}`).join('; '),'x-auth-context':client.context,'x-forwarded-for':client.ip}});
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-transform/,'live invalidation must not be buffered by production compression');const reader=response.body.getReader(),decoder=new TextDecoder();
 const first=await reader.read();const initial=decoder.decode(first.value);assert.match(initial,/event: change/);assert.ok(!initial.includes('PRIVATE'));
 return {async closed(){let text='';for(;;){const value=await reader.read();if(value.done)break;text+=decoder.decode(value.value);}clearTimeout(timeout);return text;},close(){clearTimeout(timeout);abort.abort();}};
}
test('already-open payload-free device and temporary personal event streams close when canonical context is invalidated',async()=>{
 const {client:display,id}=await pair('Live display');let feed=await stream(display,'/api/v1/device/changes');
 try{
  const row=d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id);
  await ok(administrator,'PATCH',`/api/v1/devices/${id}`,{revision:row.revision,scope:{show_points:false}});
  const end=await feed.closed();assert.match(end,/event: context/);assert.ok(!end.includes('PRIVATE'));
 }finally{feed.close();}
 await ok(display,'GET','/api/v1/device/context');await temporary(display);feed=await stream(display,'/api/v1/tasks/changes');
 try{await ok(display,'POST','/api/v1/device/return',{});assert.ok(!(await feed.closed()).includes('PRIVATE'));}finally{feed.close();}
});

test('simultaneous pairing claims create exactly one device credential and reject the replay',async()=>{
 const display=new Client(),start=await ok(display,'POST','/api/v1/device/pair',{});
 const approved=await ok(administrator,'POST','/api/v1/devices/pairing-approve',{code:start.body.code,name:'Concurrent pair'},201);
 const otherTab=new Client(display);
 const results=await Promise.all([display.call('POST','/api/v1/device/pair/claim',{confirm_transition:true}),otherTab.call('POST','/api/v1/device/pair/claim',{confirm_transition:true})]);
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM device_credentials WHERE device_id=?').get(approved.body.data.id).n,1);
 assert.equal(d.prepare('SELECT COUNT(*) n FROM device_pairings WHERE device_id=? AND consumed_at IS NOT NULL').get(approved.body.data.id).n,1);
 assert.deepEqual(d.pragma('foreign_key_check'),[]);
});

test('real asynchronous account creation, password reset and own-password writes reject authority returned during hashing',async()=>{
 const {client:display}=await pair('Awaited mutation display');
 const initial=d.prepare('SELECT id,username,display_name,password_hash FROM users ORDER BY id').all();
 const cases=[
  ['POST','/api/v1/auth/users',{username:'stale-device-created',display_name:'Should not exist',password:'held-creation-password'}],
  ['PATCH','/api/v1/auth/users/2',{display_name:'Should not change',password:'held-reset-password'}],
  ['PATCH','/api/v1/auth/me/password',{current_password:password,new_password:'held-own-password'}],
 ];
 for(const [method,path,body] of cases){
  await temporary(display);const sid=credential(display).temporary_sid,pendingClient=new Client(display);
  let prepared,release;const began=new Promise(resolve=>prepared=resolve),gate=new Promise(resolve=>release=resolve);
  const original=bcrypt.hash;
  bcrypt.hash=function(value,...args){if(value===body.password||value===body.new_password){prepared();return gate.then(()=>original.call(this,value,...args));}return original.call(this,value,...args);};
  try{
   const pending=pendingClient.call(method,path,body);await began;
   const returned=await ok(display,'POST','/api/v1/device/return',{});
   assert.equal(returned.headers.get('x-csrf-token'),returned.body.csrfToken);
   assert.equal(display.cookies.get('csrf-token'),returned.body.csrfToken);
   release();
   const result=await pending;assert.equal(result.status,409,path);assert.equal(result.body.reason,'device_context_changed');
   assert.deepEqual(d.prepare('SELECT id,username,display_name,password_hash FROM users ORDER BY id').all(),initial);
   assert.equal(d.prepare('SELECT 1 FROM sessions WHERE sid=?').get(sid),undefined,'late session save cannot resurrect temporary authority');
  }finally{release();bcrypt.hash=original;}
 }
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('canonical database lease rejects held HTTP writes after return, idle expiry and revocation without relying on route-local checks',async()=>{
 for(const [method,invalidate] of [['run','return'],['get','idle'],['all','revoke']]){
  const {client:display,id}=await pair(`Lease ${invalidate}`);await temporary(display);
  let entered,release;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  leaseProbe={entered,gate};const pendingClient=new Client(display),pending=pendingClient.call('POST','/api/v1/device-lease-probe',{method});
  try{
   await started;
   if(invalidate==='return')await ok(display,'POST','/api/v1/device/return',{});
   if(invalidate==='idle')d.prepare('UPDATE device_credentials SET temporary_idle_at=? WHERE id=?').run(Date.now()-121000,credential(display).id);
   if(invalidate==='revoke')await ok(administrator,'POST',`/api/v1/devices/${id}/revoke`,{revision:d.prepare('SELECT revision FROM household_devices WHERE id=?').get(id).revision});
   release();const result=await pending;
   assert.equal(result.status,409,`${method} after ${invalidate}`);assert.equal(result.body.reason,'device_context_changed');
   assert.equal(d.prepare('SELECT count(*) n FROM device_lease_probe').get().n,0);
  }finally{release();}
 }
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('normal account Logout returns a temporary administrator to the paired device without revoking unrelated sessions',async()=>{
 const {client:display}=await pair('Logout display');await temporary(display);
 const old=new Client(display),sid=credential(display).temporary_sid;
 await ok(display,'POST','/api/v1/auth/logout',{});
 assert.equal(credential(display).temporary_sid,null);
 assert.equal(d.prepare('SELECT 1 FROM sessions WHERE sid=?').get(sid),undefined);
 assert.ok(d.prepare('SELECT 1 FROM device_session_tombstones WHERE sid=?').get(sid));
 assert.equal((await old.call('GET','/api/v1/dashboard')).status,409);
 assert.equal((await ok(display,'GET','/api/v1/device/context')).body.principal.kind,'device');
 assert.equal((await ok(otherSession,'GET','/api/v1/auth/me')).body.user.id,1);
});

test('an external document deletion already admitted before return finishes only exact metadata cleanup',async()=>{
 const {client:display}=await pair('Document deletion display');await temporary(display);
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'vidamia-device-delete-'));
 const target=path.join(folder,'authorized.txt');await fs.writeFile(target,'synthetic document');
 const oldPath=process.env.DOCUMENT_STORAGE_LOCAL_PATH;process.env.DOCUMENT_STORAGE_LOCAL_PATH=folder;
 const doc=d.prepare(`INSERT INTO family_documents(name,category,visibility,original_name,mime_type,file_size,content_data,storage_backend,storage_key,created_by)
   VALUES('Authorized delete','other','private','authorized.txt','text/plain',18,'','local','authorized.txt',1)`).run().lastInsertRowid;
 const other=d.prepare(`INSERT INTO family_documents(name,category,visibility,original_name,mime_type,file_size,content_data,created_by)
   VALUES('Unrelated document','other','private','other.txt','text/plain',1,'eA==',1)`).run().lastInsertRowid;
 let began,release;const entered=new Promise(resolve=>began=resolve),gate=new Promise(resolve=>release=resolve),original=fs.unlink;
 fs.unlink=async function(filename,...args){if(path.resolve(filename)===path.resolve(target)){began();await gate;}return original.call(this,filename,...args);};
 try{
  const pendingClient=new Client(display),pending=pendingClient.call('DELETE',`/api/v1/documents/${doc}`);await entered;
  await ok(display,'POST','/api/v1/device/return',{});release();assert.equal((await pending).status,204);
  assert.equal(d.prepare('SELECT 1 FROM family_documents WHERE id=?').get(doc),undefined);
  assert.ok(d.prepare('SELECT 1 FROM family_documents WHERE id=?').get(other));
  await assert.rejects(fs.stat(target),{code:'ENOENT'});
  assert.equal((await display.call('DELETE',`/api/v1/documents/${other}`)).status,403);
 }finally{release();fs.unlink=original;if(oldPath===undefined)delete process.env.DOCUMENT_STORAGE_LOCAL_PATH;else process.env.DOCUMENT_STORAGE_LOCAL_PATH=oldPath;await fs.rm(folder,{recursive:true,force:true});}
});
