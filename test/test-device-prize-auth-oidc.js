/** Real sessions/state/nonce/PKCE/signed tokens against a synthetic provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import {issuer,installProvider,authorizationCallback,restoreProvider} from './helpers/device-prize-oidc-provider.mjs';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='isolated-prize-oidc-fixture';
process.env.SESSION_SECURE='false';process.env.AUTH_ALLOW_PASSWORD_LOGIN='true';process.env.OIDC_ALLOW_SIGNUP='true';
process.env.OIDC_ISSUER=issuer;process.env.OIDC_CLIENT_ID='synthetic-prize-client';process.env.OIDC_CLIENT_SECRET='synthetic-prize-secret';
installProvider();
const db=await import('../server/db.js'),d=db.get();
const {sessionMiddleware,router:authRouter}=await import('../server/auth.js');
const {deviceRouter}=await import('../server/routes/devices.js');
const {deviceBoundary,createDevice,deviceHash,DEVICE_COOKIE}=await import('../server/services/devices.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
const {postLedger}=await import('../server/services/rewards.js');
const password='synthetic-prize-oidc-password',hash=await hashPassword(password,4);
for(const [id,name,role,family,sub] of [[1,'parent','admin','parent',null],[2,'recipient','member','child','linked-recipient'],[3,'other','member','child','linked-other']])
  d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,oidc_sub,oidc_provider) VALUES(?,?,?,?,?,?,?,?)').run(id,name,name,hash,role,family,sub,sub?issuer:null);
const app=express();app.use(express.json());app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/auth',authRouter);app.use('/api/v1/device',deviceRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;process.env.OIDC_REDIRECT_URI=`${base}/api/v1/auth/oidc/callback`;
test.after(()=>{server.closeAllConnections();server.close();restoreProvider();});
class Client{
  constructor(){this.cookies=new Map();}
  async call(method,path,body,key){
    const navigation=path.startsWith('/api/v1/auth/oidc/');
    const response=await fetch(base+path,{method,redirect:'manual',headers:{'content-type':'application/json',cookie:[...this.cookies].map(([name,value])=>`${name}=${value}`).join('; '),...(this.context&&!navigation?{'x-auth-context':this.context}:{}),...(this.csrf?{'x-csrf-token':this.csrf}:{}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const value of response.headers.getSetCookie()){const part=value.split(';')[0],i=part.indexOf('=');this.cookies.set(part.slice(0,i),part.slice(i+1));}
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}
    this.context=response.headers.get('x-auth-context')||value?.authContext||this.context;this.csrf=response.headers.get('x-csrf-token')||value?.csrfToken||this.cookies.get('csrf-token')||this.csrf;
    return {status:response.status,body:value,headers:response.headers};
  }
}
async function ok(client,method,path,body,status=200,key){const result=await client.call(method,path,body,key);assert.equal(result.status,status,`${path}: ${JSON.stringify(result.body)}`);return result;}
async function fixture(){
  const device=createDevice(d,{name:'Synthetic OIDC prize display'},1),token=crypto.randomUUID(),context=crypto.randomUUID();
  const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json);
  permissions.capabilities['device_rewards.redeem']='allow';permissions.prize_redemption_mode='member_signin';
  d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),device.id);
  d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id,deviceHash(token),context);
  d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1').run();postLedger(d,{userId:2,delta:30,type:'bonus'});
  const catalog=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic OIDC book',10)").run().lastInsertRowid);
  const display=new Client();display.cookies.set(DEVICE_COOKIE,token);await ok(display,'POST','/api/v1/device/launch',{});
  const f={display,device,catalog,body:{catalog_id:catalog,user_id:2,expected_cost:10},key:crypto.randomUUID()};f.approval=await begin(f);return f;
}
async function begin(f,key=f.key){return (await ok(f.display,'POST','/api/v1/device/rewards/approval/begin',f.body,201,key)).body.approval.id;}
async function authorize(f,options={}){
  const result=await ok(f.display,'GET',`/api/v1/auth/oidc/start?approval_id=${f.approval}`,undefined,302),location=result.headers.get('location'),url=new URL(location);
  assert.equal(url.searchParams.get('prompt'),'login');assert.equal(url.searchParams.get('max_age'),'0');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  return authorizationCallback(location,options);
}
const spent=f=>d.prepare('SELECT COUNT(*) n FROM reward_redemptions WHERE catalog_id=?').get(f.catalog).n;
async function staysDevice(f){assert.equal((await ok(f.display,'GET','/api/v1/auth/me')).body.principal.kind,'device');assert.equal(d.prepare('SELECT temporary_sid FROM device_credentials WHERE device_id=?').get(f.device.id).temporary_sid,null);}

test('signed OIDC result purchases for the exact linked member and preserves shared-device identity',async()=>{
  const f=await fixture(),before=d.prepare('SELECT COUNT(*) n FROM users').get().n,callback=await authorize(f);
  const result=await ok(f.display,'GET',callback,undefined,302);assert.equal(result.headers.get('location'),'/device-approval-return.html');
  const receipt=(await ok(f.display,'GET','/api/v1/device/approval')).body;assert.equal(receipt.approval.approved,true);assert.equal(receipt.data.user_id,2);assert.equal(spent(f),1);
  assert.equal(d.prepare('SELECT actor_user_id FROM device_prize_approvals WHERE id=?').get(f.approval).actor_user_id,2);assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,before);await staysDevice(f);
});

test('wrong member, unlinked subject, stale authentication and wrong nonce cannot purchase or provision a member',async()=>{
  for(const options of [{sub:'linked-other'},{sub:'not-linked'},{age:3600},{nonce:'wrong-nonce'}]){
    const f=await fixture(),before=d.prepare('SELECT COUNT(*) n FROM users').get().n,callback=await authorize(f,options);await ok(f.display,'GET',callback,undefined,302);
    const receipt=(await ok(f.display,'GET','/api/v1/device/approval')).body;assert.equal(receipt.approval.approved,undefined);assert.equal(receipt.approval.error,'Authentication could not be completed. Try again.');assert.equal(receipt.data,undefined);
    assert.equal(spent(f),0);assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,before);await staysDevice(f);
  }
});

test('OIDC exchange held across supersession cannot complete the old or newer purchase',async()=>{
  const f=await fixture();let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const callback=await authorize(f,{entered,gate}),pending=f.display.call('GET',callback);await waiting;const next=await begin(f,crypto.randomUUID());release();assert.equal((await pending).status,302);
  assert.equal(spent(f),0);assert.equal(d.prepare('SELECT status FROM device_prize_approvals WHERE id=?').get(f.approval).status,'cancelled');assert.equal(d.prepare('SELECT status FROM device_prize_approvals WHERE id=?').get(next).status,'pending');await staysDevice(f);
});

test('a signed OIDC identity still requires its configured local second factor for the purchase',async()=>{
  const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'recipient',password});
  const setup=(await ok(human,'POST','/api/v1/auth/2fa/setup',{})).body,secret=setup.secret||setup.data?.secret;
  const enabled=(await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)})).body,recovery=enabled.recovery_codes||enabled.data?.recovery_codes;
  try{const f=await fixture(),callback=await authorize(f);await ok(f.display,'GET',callback,undefined,302);
    assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).body.approval.twoFactorRequired,true);assert.equal(spent(f),0);await staysDevice(f);
    const result=(await ok(f.display,'POST','/api/v1/auth/2fa/verify',{approval_id:f.approval,code:recovery[0]})).body;assert.equal(result.approval.approved,true);assert.equal(spent(f),1);await staysDevice(f);
  }finally{d.prepare('DELETE FROM user_totp WHERE user_id=2').run();d.prepare('DELETE FROM user_recovery_codes WHERE user_id=2').run();}
});

test('signed OIDC low-funds failure exposes the definitive purchase reason through the current proof poll',async()=>{
  const f=await fixture(),callback=await authorize(f);d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run();
  const returned=await ok(f.display,'GET',callback,undefined,302);assert.equal(returned.headers.get('location'),'/device-approval-return.html');
  const result=await f.display.call('GET','/api/v1/device/approval');assert.equal(result.status,400);assert.equal(result.body.reason,'insufficient_points');
  assert.equal(result.body.data,undefined);assert.equal(result.body.user,undefined);assert.ok(!JSON.stringify(result.body).includes('linked-recipient'));assert.equal(spent(f),0);await staysDevice(f);
  const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(f.device.id).permissions_json);
  permissions.capabilities['device_rewards.redeem']='none';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);
  const denied=await f.display.call('GET','/api/v1/device/approval');assert.equal(denied.status,403);assert.notEqual(denied.body.reason,'insufficient_points');assert.equal(denied.body.data,undefined);
});

test('a definitive error saved for an old proof cannot poison a newer purchase poll',async()=>{
  const f=await fixture(),old=f.approval;f.approval=await begin(f,crypto.randomUUID());
  const session=d.prepare('SELECT sid,sess FROM sessions').all().find(row=>JSON.parse(row.sess).deviceApprovalIntent?.id===f.approval);assert.ok(session);
  const value=JSON.parse(session.sess);value.deviceApprovalError={id:old,reason:'insufficient_points',message:'PRIVATE PROVIDER DETAIL'};
  d.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(value),session.sid);
  const result=await ok(f.display,'GET','/api/v1/device/approval');assert.equal(result.body.approval.id,f.approval);assert.equal(result.body.approval.error,undefined);assert.equal(result.body.reason,undefined);assert.equal(result.body.data,undefined);assert.equal(spent(f),0);await staysDevice(f);
});
