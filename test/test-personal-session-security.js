import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:'; process.env.SESSION_SECRET='synthetic-personal-session-security';
process.env.SESSION_SECURE='false';process.env.LOG_LEVEL='error';process.env.RATE_LIMIT_MAX_ATTEMPTS='1000';
const db=await import('../server/db.js');
const {sessionMiddleware,router,requireAuth}=await import('../server/auth.js');
const {hashPassword}=await import('../server/utils/password.js');
const {generateCode}=await import('../server/utils/totp.js');
const d=db.get(), password='synthetic-password-long', secret='JBSWY3DPEHPK3PXP';
d.prepare('INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,?,?,?,?)').run('personal','Synthetic',await hashPassword(password,4),'admin');
d.prepare('INSERT INTO user_totp(user_id,secret,confirmed_at) VALUES(1,?,?)').run(secret,new Date().toISOString());
const app=express();app.use(express.json());app.use(sessionMiddleware);app.use('/auth',router);
app.get('/identity',requireAuth,(req,res)=>res.json({id:req.authUserId,policy:req.session.personalSession}));
app.get('/delayed',requireAuth,async(req,res)=>{await new Promise(r=>setTimeout(r,1100));res.json({ok:true});});
let enter,release;
app.post('/held',requireAuth,async(req,res)=>{enter();await new Promise(r=>release=r);req.session.held=true;req.session.save(e=>res.sendStatus(e?500:200));});
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));test.after(()=>server.close());
const base=`http://127.0.0.1:${server.address().port}`,day=86400000;
class Client{
 constructor(){this.jar=new Map();this.csrf='';}
 async call(method,path,body){const r=await fetch(base+path,{method,headers:{cookie:[...this.jar].map(([k,v])=>`${k}=${v}`).join('; '),'content-type':'application/json','x-csrf-token':this.csrf},...(body?{body:JSON.stringify(body)}:{})});const set=r.headers.getSetCookie();for(const c of set){const [k,...v]=c.split(';')[0].split('=');this.jar.set(k,v.join('='));}let data;try{data=await r.json();}catch{}this.csrf=r.headers.get('x-csrf-token')||data?.csrfToken||this.jar.get('csrf-token')||this.csrf;return {status:r.status,data,set};}
 sid(){return decodeURIComponent(this.jar.get('yuvomi.sid')).slice(2).split('.')[0];}
}
async function login(c,remember=false){d.prepare('UPDATE user_totp SET last_step=NULL WHERE user_id=1').run();assert.equal((await c.call('POST','/auth/login',{username:'personal',password})).data.twoFactorRequired,true);return c.call('POST','/auth/2fa/verify',{code:generateCode(secret),remember_browser:remember});}
test('read-only personal activity renews cookie and store with an absolute 30-day ceiling',async()=>{
 const c=new Client();assert.equal((await login(c)).status,200);const r=await c.call('GET','/identity');assert.ok(r.set.some(x=>x.startsWith('yuvomi.sid=')));assert.ok(r.data.policy.absoluteExpiresAt<=Date.now()+30*day);
 const row=d.prepare('SELECT sess FROM sessions WHERE sid=?').get(c.sid());const s=JSON.parse(row.sess);s.personalSession.absoluteExpiresAt=Date.now()+60000;d.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s),c.sid());
 await c.call('GET','/identity');assert.ok(d.prepare('SELECT expired_at FROM sessions WHERE sid=?').get(c.sid()).expired_at<=Date.now()+61000);
 s.personalSession.absoluteExpiresAt=Date.now()-1;d.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s),c.sid());assert.equal((await c.call('GET','/identity')).status,401);
});
test('optional trust needs fresh password and factor; it skips only the repeated factor and expires without extension',async()=>{
 const c=new Client();const completed=await login(c,true);assert.equal(completed.status,200);assert.ok(c.jar.get('vidamia.remember'));assert.ok(completed.set.find(x=>x.startsWith('vidamia.remember=')).includes('HttpOnly'));
 const before=d.prepare('SELECT expires_at FROM remembered_browsers WHERE user_id=1 AND revoked_at IS NULL').get().expires_at;
 c.jar.delete('yuvomi.sid');const bad=await c.call('POST','/auth/login',{username:'personal',password:'wrong'});assert.equal(bad.status,401);
 const next=await c.call('POST','/auth/login',{username:'personal',password});assert.ok(next.data.user);assert.equal(next.data.twoFactorRequired,undefined);
 assert.equal(d.prepare('SELECT expires_at FROM remembered_browsers WHERE user_id=1 AND revoked_at IS NULL').get().expires_at,before);
 assert.equal((await c.call('PUT','/auth/2fa/require',{required:true})).status,403);
 d.prepare('UPDATE remembered_browsers SET expires_at=? WHERE user_id=1').run(Date.now()-1);assert.equal((await c.call('GET','/identity')).status,401);
 assert.equal((await c.call('POST','/auth/login',{username:'personal',password})).data.twoFactorRequired,true);
});
test('logout revokes the current browser trust and blocks a held stale save',async()=>{
 const c=new Client();await login(c,true);const old=c.jar.get('yuvomi.sid'),sid=c.sid();const entered=new Promise(r=>enter=r);const held=c.call('POST','/held',{});await entered;
 assert.equal((await c.call('POST','/auth/logout',{})).status,200);release();await held;assert.equal(d.prepare('SELECT 1 FROM sessions WHERE sid=?').get(sid),undefined);
 c.jar.set('yuvomi.sid',old);assert.equal((await c.call('GET','/identity')).status,401);assert.equal((await c.call('POST','/auth/login',{username:'personal',password})).data.twoFactorRequired,true);
});
test('password changes revoke trust and stale account sessions without depending on best-effort deletion',async()=>{
 const c=new Client();await login(c,true);const entered=new Promise(r=>enter=r);const held=c.call('POST','/held',{});await entered;
 d.prepare('UPDATE users SET password_hash=? WHERE id=1').run(await hashPassword(password,4));release();await held;
 assert.equal((await c.call('GET','/identity')).status,401);assert.equal(d.prepare('SELECT COUNT(*) n FROM remembered_browsers WHERE user_id=1 AND revoked_at IS NULL').get().n,0);
});
test('fresh factor step-up permits security actions after remembered login without extending trust',async()=>{
 const c=new Client();await login(c,true);c.jar.delete('yuvomi.sid');await c.call('POST','/auth/login',{username:'personal',password});
 const before=d.prepare('SELECT MAX(expires_at) n FROM remembered_browsers WHERE user_id=1 AND revoked_at IS NULL').get().n;
 assert.equal((await c.call('POST','/auth/2fa/reauthenticate',{code:'000000'})).status,403);
 d.prepare('UPDATE user_totp SET last_step=NULL WHERE user_id=1').run();assert.equal((await c.call('POST','/auth/2fa/reauthenticate',{code:generateCode(secret)})).status,200);
 assert.equal((await c.call('PUT','/auth/2fa/require',{required:false})).status,200);
 assert.equal(d.prepare('SELECT MAX(expires_at) n FROM remembered_browsers WHERE user_id=1 AND revoked_at IS NULL').get().n,before);
});
test('explicit revocation and sign-out-everywhere revoke linked authority and cannot enroll trust without a pending proof',async()=>{
 const one=new Client(),two=new Client();await login(one,true);await login(two,true);
 const list=await one.call('GET','/auth/remembered-browsers');assert.equal(list.status,200);assert.equal(JSON.stringify(list.data).includes('token_hash'),false);
 const id=list.data.data.find(x=>!x.current).id;assert.equal((await one.call('DELETE',`/auth/remembered-browsers/${id}`,{})).status,200);assert.equal((await two.call('GET','/identity')).status,401);
 assert.equal((await one.call('POST','/auth/sign-out-everywhere',{})).status,200);assert.equal((await one.call('GET','/identity')).status,401);
 assert.equal((await one.call('POST','/auth/2fa/verify',{code:generateCode(secret),remember_browser:true})).status,401);
});
test('legacy session adoption has a fixed rollout deadline; restart cannot extend it',async()=>{
 const c=new Client();await login(c);const s=JSON.parse(d.prepare('SELECT sess FROM sessions WHERE sid=?').get(c.sid()).sess);delete s.personalSession;
 d.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s),c.sid());
 const {epoch}=await import('../server/services/personal-sessions.js');
 // A legacy session from before an account security change must fail closed.
 assert.ok(epoch(d,1)>0);assert.equal((await c.call('GET','/identity')).status,401);
 const start=d.prepare('SELECT started_at FROM personal_session_policy WHERE id=1').get().started_at;
 const {ensurePersonalSessionSchema}=await import('../server/services/personal-sessions.js');ensurePersonalSessionSchema(d,start+day);assert.equal(d.prepare('SELECT started_at FROM personal_session_policy WHERE id=1').get().started_at,start);
});
test('changing two-factor state invalidates remembered browsers and pending password proof',async()=>{
 const trusted=new Client(),pending=new Client();await login(trusted,true);await pending.call('POST','/auth/login',{username:'personal',password});
 d.prepare('UPDATE user_totp SET secret=? WHERE user_id=1').run('GEZDGNBVGY3TQOJQ');
 assert.equal((await trusted.call('GET','/identity')).status,401);
 assert.equal((await pending.call('POST','/auth/2fa/verify',{code:generateCode('GEZDGNBVGY3TQOJQ'),remember_browser:true})).status,401);
 d.prepare('UPDATE user_totp SET secret=?,last_step=NULL WHERE user_id=1').run(secret);
});
test('entering Wall view cannot exempt an existing personal session from expiry or revocation',async()=>{
 const c=new Client();await login(c,true);const sid=c.sid(),s=JSON.parse(d.prepare('SELECT sess FROM sessions WHERE sid=?').get(sid).sess);
 s.wallMode=true;s.personalSession.absoluteExpiresAt=Date.now()-1;d.prepare('UPDATE sessions SET sess=? WHERE sid=?').run(JSON.stringify(s),sid);
 assert.equal((await c.call('GET','/identity')).status,401);
});
test('explicit logout after the session expires still forgets the exact remembered credential',async()=>{
 const c=new Client();await login(c,true);d.prepare('UPDATE sessions SET expired_at=? WHERE sid=?').run(Date.now()-1,c.sid());
 assert.equal((await c.call('POST','/auth/logout',{})).status,200);
 assert.equal((await c.call('POST','/auth/login',{username:'personal',password})).data.twoFactorRequired,true);
});
test('first issuance near trust expiry and delayed response cookies cannot pass the absolute deadline',async()=>{
 const c=new Client();await login(c,true);const deadline=Date.now()+10000;
 d.prepare('UPDATE remembered_browsers SET expires_at=? WHERE user_id=1 AND revoked_at IS NULL').run(deadline);
 c.jar.delete('yuvomi.sid');const issued=await c.call('POST','/auth/login',{username:'personal',password});
 const expires=r=>Date.parse(r.set.find(x=>x.startsWith('yuvomi.sid=')).match(/Expires=([^;]+)/)[1]);
 assert.ok(expires(issued)<=deadline);const response=await c.call('GET','/delayed');assert.equal(response.status,200);assert.ok(expires(response)<=deadline);
});
test('legacy adoption is bounded and excludes sessions invalidated by an account epoch',async()=>{
 const {validPersonalSession,MAXIMUM}=await import('../server/services/personal-sessions.js');
 d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(2,'legacy','Legacy','no-login','member')").run();
 const start=d.prepare('SELECT started_at FROM personal_session_policy WHERE id=1').get().started_at;
 const s={userId:2,cookie:{}};assert.equal(validPersonalSession(d,s,start+1),true);assert.equal(s.personalSession.absoluteExpiresAt,start+MAXIMUM);
 assert.equal(validPersonalSession(d,{userId:2,cookie:{}},start+MAXIMUM),false);
});
