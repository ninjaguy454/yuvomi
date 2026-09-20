/** Real app/session/OIDC protocol processing with a synthetic HTTPS provider.
 * Only IdP transport is stubbed; nonce, state, PKCE, signed ID-token claims,
 * fresh authentication, second factor and canonical Task execution are exercised.
 * This is not evidence for the household's externally configured provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
process.env.DB_PATH=':memory:';process.env.LOG_LEVEL='error';process.env.SESSION_SECRET='synthetic-device-oidc-approval-fixture';
process.env.SESSION_SECURE='false';process.env.AUTH_ALLOW_PASSWORD_LOGIN='true';process.env.OIDC_ALLOW_SIGNUP='true';
const issuer='https://synthetic-approval-idp.example';process.env.OIDC_ISSUER=issuer;
process.env.OIDC_CLIENT_ID='device-approval-fixture';process.env.OIDC_CLIENT_SECRET='synthetic-client-secret';
const originalFetch=globalThis.fetch,grants=new Map(),access=new Map();
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});jwk.kid='fixture-key';jwk.alg='RS256';jwk.use='sig';
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function token(claims) {
 const input=[{alg:'RS256',kid:'fixture-key',typ:'JWT'},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
 return `${input}.${crypto.sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;
}
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url||String(input));
 if(url.origin!==issuer)return originalFetch(input,options);
 if(url.pathname==='/.well-known/openid-configuration')return json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,userinfo_endpoint:`${issuer}/userinfo`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256']});
 if(url.pathname==='/jwks')return json({keys:[jwk]});
 if(url.pathname==='/token') {
  const body=new URLSearchParams(options.body),grant=grants.get(body.get('code'));assert.ok(grant,'known one-use authorization code');grants.delete(body.get('code'));
  assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'),grant.challenge,'PKCE is verified by fixture provider');
  assert.equal(body.get('redirect_uri'),process.env.OIDC_REDIRECT_URI);
  if(grant.gate){grant.entered();await grant.gate;}
  const now=Math.floor(Date.now()/1000),accessToken=crypto.randomBytes(20).toString('hex');access.set(accessToken,grant.sub);
  return json({access_token:accessToken,token_type:'Bearer',expires_in:300,id_token:token({iss:issuer,aud:process.env.OIDC_CLIENT_ID,sub:grant.sub,nonce:grant.nonce,iat:now,exp:now+300,auth_time:now-(grant.age||0)})});
 }
 if(url.pathname==='/userinfo') {
  const headers=new Headers(options.headers),sub=access.get(headers.get('authorization')?.replace(/^Bearer /i,''));assert.ok(sub);
  return json({sub,name:'Synthetic provider identity',preferred_username:'provider-identity',email:'synthetic@example.test',email_verified:true});
 }
 throw new Error(`Unexpected fixture provider endpoint ${url.pathname}`);
};
const db=await import('../server/db.js'),d=db.get();
const {sessionMiddleware,router:authRouter,requireAuth}=await import('../server/auth.js');
const {deviceRouter,devicesRouter}=await import('../server/routes/devices.js');
const {deviceBoundary,deviceHash,DEVICE_COOKIE}=await import('../server/services/devices.js');
const {deviceAppMiddleware}=await import('../server/services/device-app.js');
const {csrfMiddleware}=await import('../server/middleware/csrf.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
await import('../server/routes/tasks.js');
const password='synthetic-only-password',hash=await hashPassword(password,4);
for(const [id,name,role,family,sub] of [[1,'admin','admin','parent',null],[2,'learner','member','child',null],[3,'qualified','member','parent','linked-qualified']])
 d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,oidc_sub,oidc_provider) VALUES(?,?,?,?,?,?,?,?)').run(id,name,name,hash,role,family,sub,sub?issuer:null);
const app=express();app.use(express.json());app.use(sessionMiddleware);app.use((req,res,next)=>deviceBoundary(d,req,res,next));
app.use('/api/v1/auth',authRouter);app.use('/api/v1/device',deviceRouter);app.use('/api/v1/devices',devicesRouter);
app.use('/api/v1',requireAuth,csrfMiddleware,deviceAppMiddleware);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;process.env.OIDC_REDIRECT_URI=`${base}/api/v1/auth/oidc/callback`;
test.after(()=>{server.close();globalThis.fetch=originalFetch;delete process.env.OIDC_ISSUER;delete process.env.OIDC_CLIENT_ID;delete process.env.OIDC_CLIENT_SECRET;delete process.env.OIDC_REDIRECT_URI;});
class Client {
 constructor(){this.cookies=new Map();}
 async call(method,path,body){
  const response=await fetch(base+path,{method,redirect:'manual',headers:{'content-type':'application/json',cookie:[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; '),...(this.context?{'x-auth-context':this.context}:{}),...(this.csrf?{'x-csrf-token':this.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const value of response.headers.getSetCookie()){const part=value.split(';')[0],i=part.indexOf('=');this.cookies.set(part.slice(0,i),part.slice(i+1));}
  let bodyValue;const raw=await response.text();try{bodyValue=JSON.parse(raw);}catch{bodyValue=raw;}
  this.context=response.headers.get('x-auth-context')||bodyValue?.authContext||this.context;
  this.csrf=response.headers.get('x-csrf-token')||bodyValue?.csrfToken||this.cookies.get('csrf-token')||this.csrf;
  return {status:response.status,body:bodyValue,headers:response.headers};
 }
}
async function ok(client,method,path,body,status=200){const result=await client.call(method,path,body);assert.equal(result.status,status,`${path}: ${JSON.stringify(result.body)}`);return result;}
const admin=new Client();await ok(admin,'POST','/api/v1/auth/login',{username:'admin',password});
async function paired(){const display=new Client(),start=await ok(display,'POST','/api/v1/device/pair',{});await ok(admin,'POST','/api/v1/devices/pairing-approve',{code:start.body.code,name:'OIDC Fixture Wall'},201);await ok(display,'POST','/api/v1/device/pair/claim',{confirm_transition:true});await ok(display,'POST','/api/v1/device/launch',{});return display;}
function fixture(){
 const root=Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points) VALUES('OIDC routine',1,2,'all',2)").run().lastInsertRowid);
 const step=Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,visibility) VALUES('OIDC supervised step',1,?,'all')").run(root).lastInsertRowid);
 d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2)').run(root);
 d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1').run();
 const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',1)").run(`OIDC ${step}`).lastInsertRowid);
 for(const [id,proficiency] of [[1,'excluded'],[2,'supervised'],[3,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
 setTaskSkills(d,step,[skill]);assert.equal(reconcileTaskSupervision(d,root).supervisor_user_id,3);return {root,step};
}
async function begin(display,step){const row=d.prepare('SELECT * FROM tasks WHERE id=?').get(step);return (await ok(display,'POST',`/api/v1/device/tasks/${step}/approval/begin`,{expected_revision:row.revision,expected_parent_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id).revision},201)).body.approval.id;}
async function authorize(display,approvalId,options={}) {
 const started=await ok(display,'GET',`/api/v1/auth/oidc/start?approval_id=${approvalId}`,undefined,302),location=new URL(started.headers.get('location'));
 assert.equal(location.searchParams.get('prompt'),'login');assert.equal(location.searchParams.get('max_age'),'0');assert.equal(location.searchParams.get('code_challenge_method'),'S256');
 const code=crypto.randomBytes(18).toString('hex');grants.set(code,{sub:'linked-qualified',nonce:location.searchParams.get('nonce'),challenge:location.searchParams.get('code_challenge'),...options});
 return `/api/v1/auth/oidc/callback?code=${code}&state=${location.searchParams.get('state')}`;
}
const row=id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const credential=display=>d.prepare('SELECT * FROM device_credentials WHERE token_hash=?').get(deviceHash(display.cookies.get(DEVICE_COOKIE)));

test('signed provider result approves existing qualified non-admin through OIDC without a personal session or signup',async()=>{
 const display=await paired(),{root,step}=fixture(),approvalId=await begin(display,step),before=d.prepare('SELECT COUNT(*) n FROM users').get().n;
 const callback=await authorize(display,approvalId),result=await ok(display,'GET',callback,undefined,302);assert.equal(result.headers.get('location'),'/device-approval-return.html');
 const receipt=await ok(display,'GET','/api/v1/device/approval');assert.equal(receipt.body.approval.approved,true);assert.equal(receipt.body.approval.actorName,'qualified');
 assert.equal(row(step).status,'done');assert.equal(row(root).status,'done');assert.equal(credential(display).temporary_sid,null);
 assert.equal((await ok(display,'GET','/api/v1/auth/me')).body.principal.kind,'device');assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,before);
 assert.deepEqual(d.prepare('SELECT user_id,delta,created_by FROM reward_ledger WHERE task_id=?').all(root),[{user_id:2,delta:2,created_by:3}]);
});

test('OIDC approval rejects unlinked identities and stale auth_time without changing progress or creating accounts',async()=>{
 for(const options of [{sub:'unknown-provider-user'},{age:3600}]) {
  const display=await paired(),{step}=fixture(),approvalId=await begin(display,step),before=d.prepare('SELECT COUNT(*) n FROM users').get().n;
  const callback=await authorize(display,approvalId,options);await ok(display,'GET',callback,undefined,302);
  const result=await ok(display,'GET','/api/v1/device/approval');assert.equal(result.body.approval.approved,undefined);assert.equal(result.body.approval.error,'Authentication could not be completed. Try again.');
  assert.ok(!JSON.stringify(result.body).includes('unknown-provider-user'));assert.equal(row(step).status,'open');assert.equal(credential(display).temporary_sid,null);assert.equal(d.prepare('SELECT COUNT(*) n FROM users').get().n,before);
 }
});

test('OIDC provider result still requires the configured local second factor for this exact action',async()=>{
 const human=new Client();await ok(human,'POST','/api/v1/auth/login',{username:'qualified',password});
 const setup=await ok(human,'POST','/api/v1/auth/2fa/setup',{}),secret=setup.body.secret||setup.body.data?.secret;
 const enabled=await ok(human,'POST','/api/v1/auth/2fa/enable',{code:generateCode(secret)}),recovery=enabled.body.recovery_codes||enabled.body.data?.recovery_codes;
 const display=await paired(),{step}=fixture(),approvalId=await begin(display,step),callback=await authorize(display,approvalId);await ok(display,'GET',callback,undefined,302);
 const pending=await ok(display,'GET','/api/v1/device/approval');assert.equal(pending.body.approval.twoFactorRequired,true);assert.equal(row(step).status,'open');assert.equal(credential(display).temporary_sid,null);
 assert.equal((await display.call('POST','/api/v1/auth/2fa/verify',{approval_id:'different-action',code:recovery[0]})).status,409);
 const result=await ok(display,'POST','/api/v1/auth/2fa/verify',{approval_id:approvalId,code:recovery[0]});assert.equal(result.body.approval.approved,true);assert.equal(row(step).status,'done');assert.equal(credential(display).temporary_sid,null);
});

test('an OIDC exchange held while another action supersedes it cannot approve either action',async()=>{
 const display=await paired(),a=fixture(),b=fixture(),approvalId=await begin(display,a.step);
 let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const callback=await authorize(display,approvalId,{entered,gate});const pending=display.call('GET',callback);await waiting;
 await begin(display,b.step);release();const result=await pending;assert.equal(result.status,302);
 assert.equal(row(a.step).status,'open');assert.equal(row(b.step).status,'open');assert.equal(credential(display).temporary_sid,null);
 assert.equal(d.prepare('SELECT status FROM device_task_approvals WHERE id=?').get(approvalId).status,'cancelled');
});
