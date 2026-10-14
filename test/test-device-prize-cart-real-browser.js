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
app.use('/api/v1',(await import('../server/services/device-app.js')).deviceAppMiddleware);
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

import{readFileSync,existsSync}from'node:fs';import{resolve}from'node:path';import{fileURLToPath}from'node:url';
import puppeteer from './helpers/device-prize-document-guards-harness.mjs';
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url)),styles=[...readFileSync(resolve(publicRoot,'index.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>m[0]).join('');
app.get('/fixture',(_req,res)=>res.type('html').send('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+'<link rel="stylesheet" href="/styles/rewards.css"></head><body><main id="main-content"></main></body></html>'));
app.use(express.static(publicRoot));
let browser;
test.before(async()=>{const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--disable-background-networking']});});
test.after(async()=>{await browser?.close();});
async function mount(f,width=390){
 const context=await browser.createBrowserContext();await context.setCookie(...[...f.display.cookies].map(([name,value])=>({name,value,url:base})));
 const page=await context.newPage();page.setDefaultTimeout(7000);await page.setViewport({width,height:900});page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));await page.goto(base+'/fixture');
 await page.evaluate(async()=>{
 localStorage.clear();localStorage.setItem('yuvomi-locale','en');window.yuvomi={showToast(){},navigate(){},isModuleDisabled(){return false;}};
 await(await import('/i18n.js')).initI18n();const api=(await import('/api.js')).api,me=await api.get('/auth/me');
 (await import('/utils/device-context.js')).acceptAuthentication(me);(await import('/permissions.js')).setPermissions(me.permissions);
 window.dispose=await(await import('/pages/rewards.js')).render(document.querySelector('main'),{user:me.user});
 });
 const content=await page.$eval('main',n=>n.textContent);assert.ok(await page.$('[data-device-prize-profile]'),'Real fixture Rewards content: '+content);
 return{page,context};
}
async function buildCart(page,f){
 await page.waitForSelector('[data-device-prize-profile="2"]');await page.click('[data-device-prize-profile="2"]');
 await page.click('[data-device-prize-buy="'+f.catalog+'"]');await page.click('[data-device-prize-add="'+f.catalog+'"]');await page.click('[data-device-prize-buy="'+f.body.items[1].catalog_id+'"]');
 assert.equal(await page.$eval('[data-device-prize-total]',n=>n.textContent),'25 points');assert.equal(spent(f.catalog),0);
 await page.click('[data-device-prize-checkout]');await page.waitForFunction(()=>document.querySelector('[data-device-prize-submit]')?.closest('.modal-panel').getAnimations().every(a=>a.playState==='finished'));
 await page.click('[data-device-prize-submit]');
}
function onlyCatalog(f){d.prepare('UPDATE reward_catalog SET is_active=0 WHERE id NOT IN (?,?)').run(...f.body.items.map(i=>i.catalog_id));}
test('real server trusted-display cart creates three private unit Tasks then per-unit Undo replays safely',async()=>{
 const f=await cartFixture();onlyCatalog(f);const permissions=JSON.parse(d.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(f.device.id).permissions_json);permissions.prize_redemption_mode='trusted_display';d.prepare('UPDATE household_devices SET permissions_json=? WHERE id=?').run(JSON.stringify(permissions),f.device.id);
 const{page,context}=await mount(f,320);try{
 const requests=[];page.on('request',r=>{if(r.url()===base+'/api/v1/rewards/redemptions'&&r.method()==='POST')requests.push({key:r.headers()['idempotency-key'],body:JSON.parse(r.postData())});});
 await buildCart(page,f);await page.waitForSelector('[data-device-prize-receipt]');assert.equal(spent(f.catalog),2);assert.equal(requests.length,1);assert.deepEqual(requests[0].body,f.body);
 const rows=d.prepare('SELECT * FROM reward_redemptions WHERE catalog_id IN (?,?) ORDER BY id').all(...f.body.items.map(i=>i.catalog_id));assert.equal(rows.length,3);
 const links=d.prepare('SELECT t.* FROM reward_fulfillment_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.redemption_id IN (?,?,?)').all(...rows.map(r=>r.id));assert.equal(links.length,3);assert.ok(links.every(t=>t.points===0&&t.visibility==='assignees'));
 const{undoPrizeRedemption}=await import('../server/services/reward-fulfillment.js');undoPrizeRedemption(d,{actorId:1,redemptionId:rows[0].id,requestKey:crypto.randomUUID(),expectedStatus:'pending'});
 const replay=await page.evaluate(async({body,key})=>(await import('/api.js')).api.post('/rewards/redemptions',body,{headers:{'Idempotency-Key':key}}),requests[0]);
 assert.equal(replay.replayed,true);assert.deepEqual(replay.data.items.flatMap(i=>i.units.map(u=>u.status)),['cancelled','pending','pending']);assert.equal(spent(f.catalog),2);assert.deepEqual(page.errors,[]);
 }finally{await context.close();}
});
test('real server exact-member password authorizes all cart units without a personal session',async()=>{
 const f=await cartFixture();onlyCatalog(f);const{page,context}=await mount(f);try{await buildCart(page,f);await page.waitForFunction(()=>document.querySelector('[data-approval-submit]')?.disabled===false&&document.querySelector('[data-approval-submit]').closest('.modal-panel').getAnimations().every(a=>a.playState==='finished'));
 await page.type('#approval-username','recipient');await page.type('#approval-password',password);await page.click('[data-approval-submit]');await page.waitForSelector('[data-device-prize-receipt]');assert.equal(spent(f.catalog),2);
 const me=await page.evaluate(async()=>(await import('/api.js')).api.get('/auth/me'));assert.equal(me.principal.kind,'device');assert.equal(me.user.id,null);await staysDevice(f);assert.deepEqual(page.errors,[]);
 }finally{await context.close();}
});
