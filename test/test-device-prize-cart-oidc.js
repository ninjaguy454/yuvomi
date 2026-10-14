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


async function cartFixture(){const f=await fixture();const second=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic OIDC second',5)").run().lastInsertRowid);f.body={user_id:2,items:[{catalog_id:f.catalog,quantity:2,expected_cost:10},{catalog_id:second,quantity:1,expected_cost:5}],expected_cost:25};f.approval=await begin(f);return f;}
test('signed OIDC identity atomically purchases the exact three-unit cart once',async()=>{
 const f=await cartFixture(),users=d.prepare('SELECT COUNT(*) n FROM users').get().n,callback=await authorize(f);await ok(f.display,'GET',callback,undefined,302);
 const receipt=(await ok(f.display,'GET','/api/v1/device/approval')).body;assert.equal(receipt.approval.approved,true);assert.equal(receipt.data.unit_count,3);assert.equal(receipt.data.cost,25);assert.equal(spent(f),2);
 assert.equal(d.prepare('SELECT actor_user_id FROM device_prize_approvals WHERE id=?').get(f.approval).actor_user_id,2);assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,users);await staysDevice(f);
 assert.equal((await ok(f.display,'GET','/api/v1/device/approval')).body.replayed,true);assert.equal(spent(f),2);
});
test('signed OIDC cart revalidates later line availability and aggregate funds with no partial purchase',async()=>{
 for(const reason of ['reward_unavailable','insufficient_points']){
 const f=await cartFixture(),callback=await authorize(f);
 if(reason==='reward_unavailable')d.prepare('UPDATE reward_catalog SET is_active=0 WHERE id=?').run(f.body.items[1].catalog_id);else d.prepare('DELETE FROM reward_ledger WHERE user_id=2').run();
 // An unavailable line is rejected by the existing device boundary before
 // reaching OIDC exchange; the display's proof poll reports the same safe reason.
 await ok(f.display,'GET',callback,undefined,reason==='reward_unavailable'?404:302);const result=await f.display.call('GET','/api/v1/device/approval');assert.equal(result.body.reason,reason);assert.equal(result.body.data,undefined);assert.equal(spent(f),0);await staysDevice(f);
 }
});
test('wrong or unlinked signed OIDC subject cannot purchase a cart or create an account',async()=>{
 for(const sub of ['linked-other','not-linked']){const f=await cartFixture(),users=d.prepare('SELECT COUNT(*) n FROM users').get().n,callback=await authorize(f,{sub});await ok(f.display,'GET',callback,undefined,302);
 const poll=(await ok(f.display,'GET','/api/v1/device/approval')).body;assert.equal(poll.data,undefined);assert.equal(spent(f),0);assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,users);await staysDevice(f);}
});
