import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import puppeteer from 'puppeteer';
import {rewardRequest,pendingPointAdjustment} from '../public/utils/reward-request.js';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='adjustment-focused-tests';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {createPointAdjustment,postLedger,getBalance}=await import('../server/services/rewards.js');
const {default:router}=await import('../server/routes/rewards.js');
const {default:idempotency}=await import('../server/middleware/idempotency.js');
const directory=mkdtempSync(join(tmpdir(),'vidamia-point-adjustments-')),path=join(directory,'household.db');
const d=new Database(path);d.pragma('foreign_keys=ON');d.pragma('journal_mode=WAL');d.pragma('busy_timeout=10000');
for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
_setTestDatabase(d);
let seq=0;
function member(role='member'){const id=Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(`adjust-${++seq}`,`Member ${seq}`,role).lastInsertRowid);d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);return id;}
const admin=member('admin');
const task=()=>Number(d.prepare("INSERT INTO tasks(title,created_by,visibility) VALUES('Laundry',?,'private')").run(admin).lastInsertRowid);
const intent=(userId,delta=-5)=>({actorId:admin,userId,delta,reason:'Correction of early Laundry occurrence',requestKey:randomUUID()});
const app=express();app.use(express.json());
let browser,dropAdjustmentResponse=false;const adjustmentKeys=[];
const publicDir=fileURLToPath(new URL('../public/',import.meta.url));
const styles=[...readFileSync(join(publicDir,'index.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(m=>m[0]).join('\n');
app.use(express.static(publicDir));
app.get('/adjustment-browser',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/rewards.css"><script src="/lucide.min.js"></script></head><body><main id="main-content" style="height:100vh;overflow:auto"></main></body></html>`));
app.use((req,res,next)=>{
  if(req.method==='POST'&&req.path==='/api/v1/rewards/adjustments'){
    adjustmentKeys.push(req.get('Idempotency-Key'));
    const json=res.json.bind(res);res.json=payload=>{
      if(dropAdjustmentResponse&&res.statusCode<300){dropAdjustmentResponse=false;res.status(503);return json({error:'The response was interrupted after saving. Retry safely.'});}
      return json(payload);
    };
  }next();
});
app.use((req,_res,next)=>{req.authUserId=Number(req.get('x-user')||admin);req.authRole=d.prepare('SELECT role FROM users WHERE id=?').get(req.authUserId)?.role;req.session={userId:req.authUserId};next();});
app.use('/api/v1',idempotency);app.use('/api/v1/rewards',router);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/v1/rewards`;
test.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));d.close();rmSync(directory,{recursive:true,force:true});});
async function call(method,route,body,{actor=admin,key}={}){const res=await fetch(base+route,{method,headers:{'content-type':'application/json','x-user':String(actor),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,body:await res.json().catch(()=>null)};}
const body=args=>({user_id:args.userId,delta:args.delta,reason:args.reason,related_task_id:args.taskId,related_reward_id:args.catalogId,related_ledger_id:args.ledgerId});
async function workers(args,count=3){const gate=new SharedArrayBuffer(4),list=[],handles=[];
  for(let i=0;i<count;i++)list.push(new Promise((resolve,reject)=>{const worker=new Worker(new URL('./reward-adjustment-worker.mjs',import.meta.url),{workerData:{path,args,gate}});handles.push(worker);worker.on('error',reject);worker.on('message',message=>{if(message.ready){list.ready=(list.ready||0)+1;if(list.ready===count){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,count);}}else resolve(message);});}));
  try{return await Promise.all(list);}finally{await Promise.all(handles.map(worker=>worker.terminate()));}
}

test('client adjustment retry keys survive reload and distinguish amount, reason, references and redemption intents',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const intent={operation:'adjustment',user_id:2,delta:-5,reason:'Correction',related_task_id:121,related_ledger_id:6};
  const first=rewardRequest(admin,intent,storage);
  const reloaded=await import(`../public/utils/reward-request.js?adjustment-reload=${randomUUID()}`);
  assert.equal(reloaded.rewardRequest(admin,intent,storage).key,first.key);
  assert.deepEqual(reloaded.pendingPointAdjustment(admin,storage),{key:first.key,body:{user_id:2,delta:-5,reason:'Correction',related_task_id:121,related_reward_id:null,related_ledger_id:6}});
  assert.equal(pendingPointAdjustment(9999,storage),null,'pending adjustments are actor scoped');
  for(const change of [{delta:5},{reason:'Different'},{related_task_id:130},{related_ledger_id:7}])assert.notEqual(rewardRequest(admin,{...intent,...change},storage).key,first.key);
  assert.notEqual(rewardRequest(admin,{catalog_id:1,user_id:2},storage).key,first.key);
  assert.equal(pendingPointAdjustment(admin,storage).key,first.key,'the original unresolved adjustment must be restored first');
  first.finish();assert.notEqual(pendingPointAdjustment(admin,storage).key,first.key);
});

test('positive and negative adjustments append actor/time/provenance without rewriting the original award',()=>{
  const user=member(),taskId=task(),rewardId=Number(d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Movie',5)").run().lastInsertRowid);
  const originalId=Number(postLedger(d,{userId:user,delta:5,type:'earn',taskId,reason:'Original award',createdBy:admin}).lastInsertRowid);
  const original=d.prepare('SELECT * FROM reward_ledger WHERE id=?').get(originalId);
  const minus=createPointAdjustment(d,{...intent(user),taskId,catalogId:rewardId,ledgerId:originalId});
  const plus=createPointAdjustment(d,intent(user,3));
  assert.equal(minus.row.type,'adjust');assert.equal(plus.row.type,'adjust');assert.equal(getBalance(d,user),3);
  assert.equal(minus.row.created_by,admin);assert.ok(minus.row.created_at);assert.deepEqual(d.prepare('SELECT * FROM reward_ledger WHERE id=?').get(originalId),original);
  const provenance=d.prepare('SELECT * FROM reward_adjustment_requests WHERE ledger_id=?').get(minus.row.id);
  assert.equal(provenance.related_task_id,taskId);assert.equal(provenance.related_catalog_id,rewardId);assert.equal(provenance.related_ledger_id,originalId);
});

test('required reason, whole signed amount and reference/member validation reject without ledger changes',()=>{
  const user=member(),other=member(),taskId=task(),originalId=Number(postLedger(d,{userId:other,delta:5,type:'earn',taskId}).lastInsertRowid);
  for(const change of [{reason:''},{reason:' '},{reason:'x'.repeat(201)},{delta:0},{delta:1.9},{delta:1000001},{delta:true},{taskId:999999},{catalogId:999999},{ledgerId:999999},{ledgerId:originalId},{taskId:{}},{userId:null}]){
    assert.throws(()=>createPointAdjustment(d,{...intent(user),...change}));assert.equal(getBalance(d,user),0);
  }
  const ownId=Number(postLedger(d,{userId:user,delta:5,type:'earn',taskId}).lastInsertRowid);
  assert.throws(()=>createPointAdjustment(d,{...intent(user),taskId:task(),ledgerId:ownId}),/does not match/);
});

test('missing request IDs are refused; matching retry replays once and changed intent conflicts',async()=>{
  const args=intent(member());const noKey=await call('POST','/adjustments',body(args));assert.equal(noKey.status,428);
  const first=await call('POST','/adjustments',body(args),{key:args.requestKey});assert.equal(first.status,201);
  const retry=await call('POST','/adjustments',body(args),{key:args.requestKey});assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.equal(retry.body.data.id,first.body.data.id);
  for(const changes of [{delta:5},{reason:'Different reason'},{user_id:member()}])assert.equal((await call('POST','/adjustments',{...body(args),...changes},{key:args.requestKey})).status,409);
  assert.equal(getBalance(d,args.userId),-5);
});

test('concurrent writers and a fresh process replay one durable adjustment forever',async()=>{
  const args=intent(member(),7),results=await workers(args);
  assert.ok(results.every(result=>result.result),JSON.stringify(results));assert.equal(new Set(results.map(r=>r.result.row.id)).size,1);
  assert.equal(results.filter(r=>!r.result.replayed).length,1);assert.equal(getBalance(d,args.userId),7);
  d.prepare("UPDATE reward_adjustment_requests SET created_at='2000-01-01' WHERE request_key=?").run(args.requestKey);
  const restarted=await workers(args,1);assert.equal(restarted[0].result.replayed,true);assert.equal(getBalance(d,args.userId),7);
});

test('current server admin permission is required for new requests, compatibility routes, and cached retries',async()=>{
  const args=intent(member()),child=member();
  for(const route of ['/adjustments','/bonus'])assert.equal((await call('POST',route,body(args),{actor:child,key:randomUUID()})).status,403);
  assert.equal((await call('GET','/adjustment-options',undefined,{actor:child})).status,403);
  assert.throws(()=>createPointAdjustment(d,{...args,actorId:child}),e=>e.status===403);
  const first=await call('POST','/adjustments',body(args),{key:args.requestKey});assert.equal(first.status,201);
  d.prepare("UPDATE users SET role='member' WHERE id=?").run(admin);
  try{assert.equal((await call('POST','/adjustments',body(args),{key:args.requestKey})).status,403);assert.throws(()=>createPointAdjustment(d,args),e=>e.status===403);}finally{d.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin);}
  assert.equal(getBalance(d,args.userId),-5);
});

test('mixed-case adjustment and bonus routes cannot replay an admin result after demotion',async()=>{
  for(const route of ['/ADJUSTMENTS','/BoNuS/']){
    const args=intent(member(),5),first=await call('POST',route,body(args),{key:args.requestKey});
    assert.equal(first.status,201);assert.equal(first.body.data.type,route.toLowerCase().startsWith('/bonus')?'bonus':'adjust');
    d.prepare("UPDATE users SET role='member' WHERE id=?").run(admin);
    try{assert.equal((await call('POST',route,body(args),{key:args.requestKey})).status,403);}
    finally{d.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin);}
    assert.equal(getBalance(d,args.userId),5);
  }
});

test('compatibility bonus keeps its old sign categorization while requiring the same safeguards',async()=>{
  const args=intent(member(),8);const plus=await call('POST','/bonus',body(args),{key:args.requestKey});assert.equal(plus.status,201);assert.equal(plus.body.data.type,'bonus');
  const minus=await call('POST','/bonus',{...body(args),delta:-3},{key:randomUUID()});assert.equal(minus.body.data.type,'adjust');assert.equal(getBalance(d,args.userId),5);
  assert.equal((await call('POST','/bonus',{...body(args),reason:''},{key:randomUUID()})).status,400);
});

test('ledger history distinguishes adjustments and never leaks linked private Task descriptions',async()=>{
  const user=member(),taskId=task(),args={...intent(user),taskId,reason:'PRIVATE laundry details'};
  const created=createPointAdjustment(d,args);const adminRows=(await call('GET',`/ledger?user_id=${user}`)).body.data;
  assert.equal(adminRows[0].related_task_id,taskId);assert.equal(adminRows[0].actor_name,'Member 1');assert.equal(adminRows[0].id,created.row.id);
  const childRows=(await call('GET',`/ledger?user_id=${user}`,undefined,{actor:user})).body.data;
  assert.equal(childRows[0].reason,null);assert.equal(childRows[0].related_task_id,null);assert.equal(childRows[0].task_id,null);assert.equal(childRows[0].delta,-5);
  for(const method of ['PATCH','DELETE'])assert.equal((await call(method,`/adjustments/${created.row.id}`,{delta:9})).status,404);
});

test('deleting a private Task does not declassify its copied earn or adjustment reason',async()=>{
  const user=member(),taskId=task();
  const earnId=Number(postLedger(d,{userId:user,delta:5,type:'earn',taskId,reason:'PRIVATE deleted Laundry title',createdBy:admin}).lastInsertRowid);
  const adjusted=createPointAdjustment(d,{...intent(user),taskId,ledgerId:earnId,reason:'PRIVATE correction of deleted Laundry'});
  d.prepare('DELETE FROM tasks WHERE id=?').run(taskId);
  for(const actor of [user,admin]){
    const rows=(await call('GET',`/ledger?user_id=${user}`,undefined,{actor})).body.data;
    const earned=rows.find(row=>row.id===earnId),adjustment=rows.find(row=>row.id===adjusted.row.id);
    assert.equal(earned.reason,null);assert.equal(earned.task_id,null);assert.equal(earned.delta,5);
    assert.equal(adjustment.reason,null);assert.equal(adjustment.related_task_id,null);assert.equal(adjustment.related_ledger_id,null);assert.equal(adjustment.delta,-5);
  }
  assert.equal(d.prepare('SELECT reason FROM reward_ledger WHERE id=?').get(earnId).reason,'PRIVATE deleted Laundry title','history remains unchanged in storage');
  assert.equal(d.prepare('SELECT reason FROM reward_ledger WHERE id=?').get(adjusted.row.id).reason,'PRIVATE correction of deleted Laundry');
  assert.equal(getBalance(d,user),0);
});

async function mountRewards(page,role='admin') {
  await page.evaluate(async({id,role})=>{localStorage.setItem('yuvomi-locale','en');window.yuvomi={showToast(){}};
    await(await import('/i18n.js')).initI18n();
    window.stopRewards=await(await import('/pages/rewards.js')).render(document.querySelector('main'),{user:{id,role}});
  },{id:admin,role});
  await page.click('[data-tab-id="ledger"]');await page.waitForSelector('.rw-ledger');
}
async function pageFor(role='admin') {
  if(!browser){const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(existsSync(edge)?edge:undefined),args:['--no-sandbox','--disable-dev-shm-usage']});}
  const page=await browser.newPage();await page.setViewport({width:900,height:1200,hasTouch:true});
  await page.goto(base.replace('/api/v1/rewards','/adjustment-browser'));
  await mountRewards(page,role);return page;
}

test('browser adjustment form validates reason, previews balance, and retries a lost committed response only once',async()=>{
  const user=member(),taskId=task();postLedger(d,{userId:user,delta:10,type:'earn',taskId,reason:'Keep original award',createdBy:admin});
  const page=await pageFor();
  try{
    await page.click('.page-fab');await page.waitForSelector('#rw-adjustment-form');
    assert.equal(await page.$eval('#rw-adjust-points',el=>el.inputMode),'text','Android must expose a minus-capable keyboard');
    await page.select('#rw-adjust-member',String(user));await page.type('#rw-adjust-points','5');
    await page.click('#rw-adjust-submit');await page.waitForFunction(()=>!document.querySelector('#rw-adjust-error').hidden);
    assert.match(await page.$eval('#rw-adjust-error',el=>el.textContent),/reason is required/);assert.equal(getBalance(d,user),10);
    await page.type('#rw-adjust-reason','Browser correction with a lost response');
    assert.match(await page.$eval('#rw-adjust-preview',el=>el.textContent),/10 → 15/);
    await page.waitForFunction(id=>document.querySelector(`#rw-adjust-task option[value="${id}"]`),{},taskId);
    await page.select('#rw-adjust-task',String(taskId));dropAdjustmentResponse=true;const keyStart=adjustmentKeys.length;
    await page.evaluate(()=>{const form=document.querySelector('#rw-adjustment-form');form.requestSubmit();form.requestSubmit();});
    await page.waitForFunction(()=>!document.querySelector('#rw-adjust-error').hidden&&!document.querySelector('#rw-adjust-submit').disabled);
    assert.equal(getBalance(d,user),15);assert.equal(adjustmentKeys.length,keyStart+1,'duplicate submit does not dispatch twice');
    assert.equal(await page.$$eval('#rw-adjustment-form input,#rw-adjustment-form select',inputs=>inputs.every(input=>input.disabled)),true,'uncertain committed intent remains frozen');
    await page.evaluate(async()=>{await(await import('/components/modal.js')).closeModal({force:true});});
    await page.click('.page-fab');await page.waitForSelector('#rw-adjustment-form');
    assert.equal(await page.$eval('#rw-adjust-points',input=>[input.value,input.disabled].join(':')),'5:true','closing and reopening resumes the submitted intent');
    await page.reload();await mountRewards(page);await page.click('.page-fab');await page.waitForSelector('#rw-adjustment-form');
    assert.equal(await page.$eval('#rw-adjust-points',input=>[input.value,input.disabled].join(':')),'5:true','a document reload resumes the original intent');
    assert.equal(await page.$eval('#rw-adjust-task',input=>input.value),String(taskId));
    assert.match(await page.$eval('#rw-adjust-submit',el=>el.textContent),/Confirm pending/);
    await page.click('#rw-adjust-submit');await page.waitForFunction(()=>!document.querySelector('#rw-adjustment-form'));
    assert.equal(adjustmentKeys.at(-1),adjustmentKeys[keyStart]);assert.equal(getBalance(d,user),15);
    await page.waitForFunction(()=>document.querySelector('.rw-ledger')?.textContent.includes('Browser correction with a lost response'));
    const text=await page.$eval('.rw-ledger',el=>el.textContent);assert.match(text,/Points adjustment/);assert.match(text,/Keep original award/);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE user_id=? AND type='adjust'").get(user).n,1);
  }finally{await page.close();}
});

test('browser linked negative adjustment preserves its reference, and restricted UI exposes no adjustment controls',async()=>{
  const user=member(),taskId=task(),ledgerId=Number(postLedger(d,{userId:user,delta:5,type:'earn',taskId,reason:'Linked correction target',createdBy:admin}).lastInsertRowid);
  const page=await pageFor();
  try{
    await page.click(`[data-adjust-ledger="${ledgerId}"]`);await page.waitForSelector('#rw-adjustment-form');
    assert.equal(await page.$eval('#rw-adjust-member',el=>el.value),String(user));
    await page.type('#rw-adjust-points','-5');await page.type('#rw-adjust-reason','Correction of early occurrence');
    await page.waitForFunction(id=>document.querySelector('#rw-adjust-ledger')?.value===String(id),{},ledgerId);
    await page.click('#rw-adjust-submit');await page.waitForFunction(()=>!document.querySelector('#rw-adjustment-form'));
    assert.equal(getBalance(d,user),0);assert.equal(d.prepare('SELECT delta FROM reward_ledger WHERE id=?').get(ledgerId).delta,5);
    assert.equal(d.prepare('SELECT related_ledger_id FROM reward_adjustment_requests WHERE related_ledger_id=?').get(ledgerId).related_ledger_id,ledgerId);
  }finally{await page.close();}
  const restricted=await pageFor('member');
  try{assert.equal(await restricted.$$eval('[data-adjust-ledger]',rows=>rows.length),0);assert.equal(await restricted.$eval('.page-fab',el=>el.hidden||getComputedStyle(el).display==='none'),true);}finally{await restricted.close();}
});
