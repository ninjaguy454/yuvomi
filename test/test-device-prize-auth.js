/** Synthetic HTTP/session proof tests. No household data or external provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';
process.env.SESSION_SECRET='isolated-device-prize-auth-fixture';process.env.SESSION_SECURE='false';
process.env.AUTH_ALLOW_PASSWORD_LOGIN='true';process.env.RATE_LIMIT_MAX_ATTEMPTS='100';
const db=await import('../server/db.js'),d=db.get();
const {sessionMiddleware,router:authRouter,requireAuth}=await import('../server/auth.js');
const {deviceRouter}=await import('../server/routes/devices.js');
const {deviceBoundary,createDevice,deviceHash,DEVICE_COOKIE}=await import('../server/services/devices.js');
const {hashPassword}=await import('../server/utils/password.js');
const {postLedger}=await import('../server/services/rewards.js');
const {generateCode}=await import('../server/utils/totp.js');
const {csrfMiddleware}=await import('../server/middleware/csrf.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const password='synthetic-prize-password',hash=await hashPassword(password,4);
for(const [id,name,role,family] of [[1,'parent','admin','parent'],[2,'recipient','member','child'],[3,'other','member','child']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,?,?,?)').run(id,name,name,hash,role,family);
const app=express();app.set('trust proxy','loopback');app.use(express.json());app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/auth',authRouter);app.use('/api/v1/device',deviceRouter);
app.use('/api/v1',requireAuth,csrfMiddleware);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.closeAllConnections();server.close();});
let clientSequence=0;
class Client {
  constructor(){this.cookies=new Map();this.fixtureIp=`192.0.2.${++clientSequence}`;}
  async call(method,path,body,key){
    const response=await fetch(base+path,{method,redirect:'manual',headers:{'content-type':'application/json','x-forwarded-for':this.fixtureIp,
      cookie:[...this.cookies].map(([name,value])=>`${name}=${value}`).join('; '),
      ...(this.context?{'x-auth-context':this.context}:{}),...(this.csrf?{'x-csrf-token':this.csrf}:{}),
      ...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const part=value.split(';')[0],i=part.indexOf('=');this.cookies.set(part.slice(0,i),part.slice(i+1));}
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}
    this.context=response.headers.get('x-auth-context')||value?.authContext||this.context;
    this.csrf=response.headers.get('x-csrf-token')||value?.csrfToken||this.cookies.get('csrf-token')||this.csrf;
    return {status:response.status,body:value,headers:response.headers};
  }
}
async function ok(client,method,path,body,status=200,key){const result=await client.call(method,path,body,key);assert.equal(result.status,status,`${path}: ${JSON.stringify(result.body)}`);return result.body;}
async function fixture(){
  d.prepare("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id='2'").run();
  const device=createDevice(d,{name:'Synthetic sign-in display'},1),token=crypto.randomUUID(),context=crypto.randomUUID();
  const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json);
  permissions.capabilities['device_rewards.redeem']='allow';permissions.prize_redemption_mode='member_signin';
  d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),device.id);
  d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),context);
  for(const id of [2,3])d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1').run(id);
  postLedger(d,{userId:2,delta:30,type:'bonus'});
  const catalog=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic book',10)").run().lastInsertRowid);
  const display=new Client();display.cookies.set(DEVICE_COOKIE,token);await ok(display,'POST','/api/v1/device/launch',{});
  return {display,device,catalog,body:{catalog_id:catalog,user_id:2,expected_cost:10},key:crypto.randomUUID()};
}
const start=async(f,body=f.body,key=f.key)=>(await ok(f.display,'POST','/api/v1/device/rewards/approval/begin',body,201,key)).approval;
const approve=(f,id,username='recipient',value=password)=>f.display.call('POST','/api/v1/auth/login',{username,password:value,approval_id:id});
const spent=catalog=>d.prepare("SELECT COUNT(*) n FROM reward_redemptions WHERE catalog_id=?").get(catalog).n;
const proof=id=>d.prepare('SELECT * FROM device_prize_approvals WHERE id=?').get(id);
async function staysDevice(f){
  const me=await ok(f.display,'GET','/api/v1/auth/me');assert.equal(me.principal.kind,'device');assert.equal(me.user.id,null);
  const credential=d.prepare('SELECT * FROM device_credentials WHERE device_id=?').get(f.device.id);
  assert.equal(credential.temporary_sid,null);assert.equal(credential.temporary_user_id,null);
  const sessions=d.prepare('SELECT sess FROM sessions').all().map(row=>JSON.parse(row.sess));
  assert.ok(sessions.filter(row=>row.deviceApprovalIntent?.kind==='prize').every(row=>row.userId===undefined&&row.role===undefined));
}

test('member sign-in begins one purchase and password approval records the exact recipient without a personal session',async()=>{
  const f=await fixture(),approval=await start(f);assert.equal(approval.kind,'prize');assert.equal(approval.state,'pending');assert.equal(approval.userId,2);assert.equal(spent(f.catalog),0);
  assert.equal((await approve(f,approval.id,'recipient','wrong')).status,401);
  assert.equal((await approve(f,approval.id,'other')).status,403);assert.equal(spent(f.catalog),0);
  const result=await approve(f,approval.id);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.approval.approved,true);
  assert.deepEqual(Object.keys(result.body.data).sort(),['cost','id','requires_delivery','reward_name','status','user_id']);assert.equal(result.body.user,undefined);assert.equal(result.body.permissions,undefined);
  assert.equal(proof(approval.id).actor_user_id,2);assert.equal(spent(f.catalog),1);await staysDevice(f);
  const retry=await approve(f,approval.id);assert.equal(retry.status,200,JSON.stringify(retry.body));assert.equal(retry.body.data.id,result.body.data.id);assert.equal(spent(f.catalog),1);
  const receipt=await ok(f.display,'GET','/api/v1/device/approval');assert.equal(receipt.data.id,result.body.data.id);await staysDevice(f);
});

test('begin rejects missing or conflicting purchase intent, disabled grants and trusted mode',async()=>{
  const f=await fixture(),missing=await f.display.call('POST','/api/v1/device/rewards/approval/begin',f.body);assert.equal(missing.status,428);assert.equal(missing.body.reason,'request_id_required');
  for(const change of [{authenticatedUserId:2},{expected_cost:11},{user_id:999}])assert.ok((await f.display.call('POST','/api/v1/device/rewards/approval/begin',{...f.body,...change},f.key)).status>=400);
  const row=d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(f.device.id),permissions=JSON.parse(row.permissions_json);
  permissions.capabilities['device_rewards.redeem']='none';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);
  assert.equal((await f.display.call('POST','/api/v1/device/rewards/approval/begin',f.body,f.key)).status,403);
  permissions.capabilities['device_rewards.redeem']='allow';permissions.prize_redemption_mode='trusted_display';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);
  assert.ok((await f.display.call('POST','/api/v1/device/rewards/approval/begin',f.body,f.key)).status>=400);assert.equal(spent(f.catalog),0);
});

test('late cancellation and late password authentication cannot complete a superseding purchase',async()=>{
  const f=await fixture(),first=await start(f),second=await start(f,f.body,crypto.randomUUID());assert.notEqual(first.id,second.id);assert.equal(proof(first.id).status,'cancelled');
  await ok(f.display,'POST','/api/v1/device/approval/cancel',{approval_id:first.id});assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).approval.id,second.id);
  assert.equal((await approve(f,first.id)).status,409);assert.equal(spent(f.catalog),0);
  await ok(f.display,'POST','/api/v1/device/approval/cancel',{approval_id:second.id});assert.equal(proof(second.id).status,'cancelled');assert.deepEqual(await ok(f.display,'GET','/api/v1/device/approval'),{approval:null});
  assert.ok((await approve(f,second.id)).status>=400);await staysDevice(f);
});

test('price, funds, enrollment and device revision changes reject pending approval without a purchase',async()=>{
  for(const mutate of [f=>d.prepare('UPDATE reward_catalog SET cost=11 WHERE id=?').run(f.catalog),
    ()=>d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=2').run(),
    f=>d.prepare('UPDATE household_devices SET revision=revision+1 WHERE id=?').run(f.device.id),
    ()=>d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run()]) {
    const f=await fixture(),approval=await start(f);mutate(f);const result=await approve(f,approval.id);assert.ok(result.status>=400,JSON.stringify(result.body));assert.equal(spent(f.catalog),0);assert.equal(proof(approval.id).status,'pending');await staysDevice(f);
  }
});

test('expiry, launch and temporary sign-in invalidate the scoped prize proof',async()=>{
  for(const transition of ['expiry','launch','temporary']) {
    const f=await fixture(),approval=await start(f);
    if(transition==='expiry')d.prepare('UPDATE device_prize_approvals SET expires_at=? WHERE id=?').run(Date.now()-1,approval.id);
    else await ok(f.display,'POST',`/api/v1/device/${transition==='launch'?'launch':'temporary/begin'}`,{});
    assert.ok((await approve(f,approval.id)).status>=400);assert.equal(spent(f.catalog),0);
    if(transition==='temporary'){assert.equal((await f.display.call('POST','/api/v1/auth/login',{username:'recipient',password})).status,403);await ok(f.display,'POST','/api/v1/device/return',{});}
    await staysDevice(f);
  }
});

test('password verification held across proof replacement cannot transfer authentication to the new purchase',async()=>{
  const f=await fixture(),first=await start(f);let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),original=bcrypt.compare;
  bcrypt.compare=async(...args)=>{entered();await gate;return original(...args);};
  try{const pending=approve(f,first.id);await waiting;const second=await start(f,f.body,crypto.randomUUID());release();assert.equal((await pending).status,409);assert.equal(spent(f.catalog),0);assert.equal(proof(second.id).status,'pending');await staysDevice(f);}
  finally{release();bcrypt.compare=original;}
});

test('configured second factor must authenticate the selected member for the original purchase',async()=>{
  const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'recipient',password});
  const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{}),secret=setup.secret||setup.data?.secret;
  const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.recovery_codes||enabled.data?.recovery_codes;
  try{
    const f=await fixture(),approval=await start(f),pending=await approve(f,approval.id);assert.equal(pending.status,200);assert.equal(pending.body.twoFactorRequired,true);assert.equal(spent(f.catalog),0);await staysDevice(f);
    assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).approval.twoFactorRequired,true);
    assert.equal((await f.display.call('POST','/api/v1/auth/2fa/verify',{code:recovery[0]})).status,409);
    assert.equal((await f.display.call('POST','/api/v1/auth/2fa/verify',{approval_id:approval.id,code:'invalid'})).status,401);
    const next=await start(f,f.body,crypto.randomUUID());assert.equal((await f.display.call('POST','/api/v1/auth/2fa/verify',{approval_id:approval.id,code:recovery[0]})).status,409);assert.equal(spent(f.catalog),0);
    await approve(f,next.id);const result=await ok(f.display,'POST','/api/v1/auth/2fa/verify',{approval_id:next.id,code:recovery[0]});assert.equal(result.approval.approved,true);assert.equal(spent(f.catalog),1);await staysDevice(f);
  }finally{d.prepare('DELETE FROM user_totp WHERE user_id=2').run();d.prepare('DELETE FROM user_recovery_codes WHERE user_id=2').run();}
});

test('cached prize receipts recheck mode, scoped enrollment, actor Rewards authority and credential context',async()=>{
  const changes=[f=>{const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(f.device.id).permissions_json);permissions.prize_redemption_mode='trusted_display';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);},
    f=>{const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(f.device.id).permissions_json);permissions.capabilities['device_rewards.redeem']='none';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);},
    ()=>d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','rewards','none')").run(),
    ()=>d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=2').run(),
    f=>d.prepare('UPDATE household_devices SET scope_json=? WHERE id=?').run(JSON.stringify({member_ids:[3]}),f.device.id),
    f=>d.prepare('UPDATE device_credentials SET context_key=? WHERE device_id=?').run(crypto.randomUUID(),f.device.id)];
  for(const mutate of changes){const f=await fixture(),approval=await start(f);assert.equal((await approve(f,approval.id)).status,200);mutate(f);const response=await f.display.call('GET','/api/v1/device/approval');assert.ok(response.status>=400,JSON.stringify(response.body));assert.equal(response.body.data,undefined);assert.equal(spent(f.catalog),1);}
});

test('completed proof replays the original minimal receipt after catalog repricing or deletion',async()=>{
  const f=await fixture(),approval=await start(f),purchased=await approve(f,approval.id);assert.equal(purchased.status,200);
  const redemption=purchased.body.data.id;
  d.prepare("UPDATE reward_catalog SET cost=99,name='Changed later' WHERE id=?").run(f.catalog);
  const repriced=await ok(f.display,'GET','/api/v1/device/approval');assert.equal(repriced.data.id,redemption);assert.equal(repriced.data.cost,10);assert.equal(repriced.approval.rewardName,'Synthetic book');
  d.prepare('DELETE FROM reward_catalog WHERE id=?').run(f.catalog);
  const deleted=await ok(f.display,'GET','/api/v1/device/approval');assert.equal(deleted.data.id,redemption);assert.equal(deleted.data.cost,10);assert.equal(deleted.approval.catalogId,f.catalog);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemptions WHERE id=?').get(redemption).n,1);await staysDevice(f);
});

test('Task and prize approvals supersede each other without transferring authentication',async()=>{
  const f=await fixture(),first=await start(f);
  const root=Number(d.prepare("INSERT INTO tasks(title,assigned_to,created_by,visibility) VALUES('Synthetic routine',2,1,'all')").run().lastInsertRowid);
  const step=Number(d.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility) VALUES('Synthetic supervised step',?,1,'all')").run(root).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);
  const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Synthetic approval skill',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'normal'],[2,'supervised'],[3,'excluded']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
  setTaskSkills(d,step,[skill]);reconcileTaskSupervision(d,root);
  const task=d.prepare('SELECT revision FROM tasks WHERE id=?').get(step),parent=d.prepare('SELECT revision FROM tasks WHERE id=?').get(root);
  const taskApproval=(await ok(f.display,'POST',`/api/v1/device/tasks/${step}/approval/begin`,{expected_revision:task.revision,expected_parent_revision:parent.revision},201)).approval;
  assert.equal(taskApproval.kind,undefined);assert.equal(proof(first.id).status,'cancelled');
  const next=await start(f);assert.equal(d.prepare('SELECT status FROM device_task_approvals WHERE id=?').get(taskApproval.id).status,'cancelled');
  assert.equal((await approve(f,taskApproval.id,'parent')).status,409);assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).approval.id,next.id);assert.equal(spent(f.catalog),0);await staysDevice(f);
});

test('password prize completion exposes the definitive insufficient-points reason without personal authority',async()=>{
  const f=await fixture(),approval=await start(f);d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run();
  const result=await approve(f,approval.id);assert.equal(result.status,400);assert.equal(result.body.reason,'insufficient_points');
  assert.equal(result.body.data,undefined);assert.equal(result.body.user,undefined);assert.equal(spent(f.catalog),0);assert.equal(proof(approval.id).status,'pending');await staysDevice(f);
});

test('second-factor prize completion exposes the definitive insufficient-points reason without a receipt',async()=>{
  const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'recipient',password});
  const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{}),secret=setup.secret||setup.data?.secret;
  const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.recovery_codes||enabled.data?.recovery_codes;
  try{
    const f=await fixture(),approval=await start(f);assert.equal((await approve(f,approval.id)).body.twoFactorRequired,true);
    d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run();
    const result=await f.display.call('POST','/api/v1/auth/2fa/verify',{approval_id:approval.id,code:recovery[0]});
    assert.equal(result.status,400);assert.equal(result.body.reason,'insufficient_points');assert.equal(result.body.data,undefined);assert.equal(result.body.user,undefined);assert.equal(spent(f.catalog),0);await staysDevice(f);
  }finally{d.prepare('DELETE FROM user_totp WHERE user_id=2').run();d.prepare('DELETE FROM user_recovery_codes WHERE user_id=2').run();}
});
