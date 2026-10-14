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


async function cartFixture(){const f=await fixture();const second=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic second reward',5)").run().lastInsertRowid);f.body={user_id:2,items:[{catalog_id:f.catalog,quantity:2,expected_cost:10},{catalog_id:second,quantity:1,expected_cost:5}],expected_cost:25};return f;}
test('one exact-member password proof commits the full cart once without a personal session',async()=>{
 const f=await cartFixture(),approval=await start(f);assert.equal(approval.cost,25);assert.match(approval.rewardName,/2.*Synthetic book/);assert.deepEqual(JSON.parse(proof(approval.id).request_fingerprint).items,f.body.items);
 assert.equal((await approve(f,approval.id,'other')).status,403);assert.equal(spent(f.catalog),0);const first=await approve(f,approval.id);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.unit_count,3);assert.equal(first.body.data.cost,25);assert.equal(spent(f.catalog),2);assert.equal(proof(approval.id).actor_user_id,2);await staysDevice(f);
 const second=await approve(f,approval.id);assert.equal(second.status,200);assert.equal(second.body.replayed,true);assert.equal(spent(f.catalog),2);assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).data.unit_count,3);
});
test('cart member proof revalidates every line price and availability at password commit',async()=>{
 for(const mutate of [f=>d.prepare('UPDATE reward_catalog SET cost=6 WHERE id=?').run(f.body.items[1].catalog_id),f=>d.prepare('UPDATE reward_catalog SET is_active=0 WHERE id=?').run(f.body.items[1].catalog_id)]){
  const f=await cartFixture(),approval=await start(f);mutate(f);const result=await approve(f,approval.id);assert.ok([404,409].includes(result.status));assert.ok(['reward_price_changed','reward_unavailable'].includes(result.body.reason));assert.equal(spent(f.catalog),0);assert.equal(proof(approval.id).status,'pending');await staysDevice(f);
 }
});
test('cart second factor authorizes one full immutable quantity body and no personal identity',async()=>{
 const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'recipient',password});const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{}),secret=setup.secret||setup.data?.secret;const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.recovery_codes||enabled.data?.recovery_codes;
 try{const f=await cartFixture(),approval=await start(f),pending=await approve(f,approval.id);assert.equal(pending.body.twoFactorRequired,true);assert.equal(spent(f.catalog),0);const result=await ok(f.display,'POST','/api/v1/auth/2fa/verify',{approval_id:approval.id,code:recovery[0]});assert.equal(result.data.unit_count,3);assert.equal(result.data.cost,25);assert.equal(spent(f.catalog),2);await staysDevice(f);}finally{d.prepare('DELETE FROM user_totp WHERE user_id=2').run();d.prepare('DELETE FROM user_recovery_codes WHERE user_id=2').run();}
});
test('cart second factor fails atomically if aggregate funds change before verification',async()=>{
 const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'recipient',password});const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{}),secret=setup.secret||setup.data?.secret;const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.recovery_codes||enabled.data?.recovery_codes;
 try{const f=await cartFixture(),approval=await start(f);assert.equal((await approve(f,approval.id)).body.twoFactorRequired,true);d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run();const result=await f.display.call('POST','/api/v1/auth/2fa/verify',{approval_id:approval.id,code:recovery[0]});assert.equal(result.status,400);assert.equal(result.body.reason,'insufficient_points');assert.equal(spent(f.catalog),0);assert.equal(proof(approval.id).status,'pending');await staysDevice(f);}finally{d.prepare('DELETE FROM user_totp WHERE user_id=2').run();d.prepare('DELETE FROM user_recovery_codes WHERE user_id=2').run();}
});
