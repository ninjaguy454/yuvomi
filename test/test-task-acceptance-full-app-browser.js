/** Actual app, encrypted synthetic household, real auth and acceptance UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import puppeteer from 'puppeteer';
const folder=mkdtempSync(join(tmpdir(),'vidamia-acceptance-full-app-'));
process.env.DB_PATH=join(folder,'household.db');process.env.DB_ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.SESSION_SECRET='synthetic-acceptance-full-app';process.env.SESSION_SECURE='false';
process.env.BACKUP_ENABLED='false';process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-acceptance-household-2026!';
const evidence={scope:'Actual server, encrypted synthetic DB and production UI',steps:[],errors:[]};
const output=process.env.ACCEPTANCE_FULL_APP_EVIDENCE||join(folder,'evidence');mkdirSync(output,{recursive:true});
let server,browser,origin,owner,member,display;
const grant=(id,key,value)=>d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(id),key,value);
test.before(async()=>{
  const hash=await hashPassword(password,4);
  for(const [id,name,role] of [[1,'Accept Parent','admin'],[2,'Accept Grace','member'],[3,'Accept Helper','member']])d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,name,hash,role,role==='admin'?'parent':'child');
  for(const key of ['tasks.change_assignment','tasks.reassign','tasks.accept_with_helpers'])grant(2,key,'none');
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>log=(log+chunk).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Server startup failed')),60000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${log}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0,16).toString(),'SQLite format 3\0');
});
test.after(async()=>{
  writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));await browser?.close();
  if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
  d.close();rmSync(folder,{recursive:true,force:true});
});
test.afterEach(async context=>{if(context.error)for(const [name,page] of Object.entries({owner,member,display})){if(!page||page.isClosed())continue;console.log('ACCEPTANCE_FULL_APP_FAILURE',name,page.url(),await page.$eval('body',el=>el.innerText.slice(-1800)).catch(()=>''));await page.screenshot({path:join(output,`failure-${name}.png`)}).catch(()=>{});}});
async function pageFor(width=1280){
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);await page.setViewport({width,height:960});
  const cdp=await page.createCDPSession();await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');Object.defineProperty(navigator,'onLine',{get:()=>true});});
  await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin||url.pathname==='/sw.js')return request.abort();return request.continue();});
  page.on('pageerror',error=>evidence.errors.push(error.message));return page;
}
async function field(page,selector,value){await page.waitForSelector(selector);await page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function press(page,selector){await page.bringToFront();await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Enter');}
async function login(page,name){await page.goto(origin+'/login');await field(page,'#username',name);await field(page,'#password',password);const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')&&r.request().method()==='POST');await press(page,'#auth-btn');assert.equal((await response).status(),200);await page.waitForSelector('.dashboard');}
async function create(title,{children=0}={}){
  const created=await owner.evaluate(async title=>{const {api}=await import('/api.js');return api.post('/tasks',{title,assigned_to:[],points:5});},title);const id=created.data.id;
  const steps=[];for(let i=0;i<children;i++)steps.push(Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id) VALUES(?,1,?)").run(`${title} step ${i+1}`,id).lastInsertRowid));
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(id).assigned_to,null);return {id,steps};
}
async function open(page,id){
  await page.bringToFront();await page.waitForFunction(()=>typeof window.yuvomi?.navigate==='function');
  for(let attempt=0;attempt<30;attempt++){await page.evaluate(()=>window.yuvomi.navigate('/notes'));if(new URL(page.url()).pathname==='/notes')break;await new Promise(resolve=>setTimeout(resolve,100));}
  await page.waitForSelector('.notes-page');
  await press(page,`[data-open-task="${id}"]`);
  await page.waitForFunction(()=>document.querySelector('[data-task-acceptance]')||document.querySelector('#task-detail-claim'));
  if(!await page.$('[data-task-acceptance]'))await press(page,'#task-detail-claim');
  await page.waitForFunction(()=>['primary','helpers'].includes(document.querySelector('[data-task-acceptance]')?.dataset.stage));
}
async function confirm(page,id){
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/v1/tasks/${id}/accept`)&&r.request().method()==='POST');
  await press(page,'[data-acceptance-confirm]');const saved=await response;assert.equal(saved.status(),200,await saved.text());await page.waitForSelector('[data-task-acceptance]',{hidden:true});
}
const assigned=id=>d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(r=>r.user_id);
test('real open-task board accepts self, optional helper allocation, and paired recipients without changing identity or points',{timeout:180000},async()=>{
  owner=await pageFor();await login(owner,'Accept Parent');const solo=await create('Solo open task');
  member=await pageFor(390);await login(member,'Accept Grace');await open(member,solo.id);
  assert.ok(await member.$('[data-acceptance-helper-unavailable]'));await press(member,'[data-acceptance-next]');
  assert.equal(await member.$eval('[data-task-acceptance]',el=>el.dataset.stage),'confirm');await confirm(member,solo.id);
  assert.deepEqual(assigned(solo.id),[2]);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(solo.id).status,'open');evidence.steps.push('Regular unassigned task appears beside Notes; restricted member accepts self without extra rights');
  grant(2,'tasks.accept_with_helpers','allow');const shared=await create('Shared open task',{children:2});await open(member,shared.id);
  await member.click('[data-acceptance-helper="3"]');await press(member,'[data-acceptance-next]');assert.equal(await member.$eval('[data-task-acceptance]',el=>el.dataset.stage),'allocation');
  assert.equal(await member.$$eval('[data-acceptance-pool]',els=>els.length),3);await member.select(`[data-acceptance-assignment="${shared.steps[0]}"]`,'3');
  await member.screenshot({path:join(output,'acceptance-phone-pools.png')});await press(member,'[data-acceptance-next]');await confirm(member,shared.id);
  assert.deepEqual(assigned(shared.id),[2,3]);assert.deepEqual(assigned(shared.steps[0]),[3]);assert.deepEqual(assigned(shared.steps[1]),[]);evidence.steps.push('Narrow helper grant allows atomic optional allocation; an untouched subtask remains explicitly unassigned');
  const paired=await create('Paired open task',{children:2});display=await pageFor();await display.goto(origin+'/device/pair');await press(display,'[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await owner.evaluate(async code=>{const {api}=await import('/api.js');await api.post('/devices/pairing-approve',{code,name:'Synthetic Acceptance Display',scope:{member_ids:[2,3]},permissions:{capabilities:{'device_notes.view':'allow','device_tasks.claim':'allow','device_tasks.accept_with_helpers':'allow'}}});},code);
  await display.waitForSelector('[data-pair-claim]');await press(display,'[data-pair-claim]');await display.waitForFunction(()=>!!document.querySelector('[data-device-login]')&&!!document.querySelector('.dashboard'));
  await open(display,paired.id);assert.equal(await display.$eval('[data-task-acceptance]',el=>el.dataset.stage),'primary');await display.select('[data-acceptance-primary]','2');await press(display,'[data-acceptance-next]');await display.waitForSelector('[data-acceptance-helper="3"]');await display.click('[data-acceptance-helper="3"]');await press(display,'[data-acceptance-next]');
  await display.screenshot({path:join(output,'acceptance-paired-pools.png')});await press(display,'[data-acceptance-next]');await confirm(display,paired.id);
  assert.deepEqual(assigned(paired.id),[2,3]);for(const child of paired.steps)assert.deepEqual(assigned(child),[]);
  const identity=await display.evaluate(async()=>{const {getPermissions}=await import('/permissions.js');return getPermissions().principal_kind;});assert.equal(identity,'device');evidence.steps.push('Real scoped paired display selects recipients and confirms zero allocations while remaining a device');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n,0);assert.equal(d.prepare('SELECT COUNT(*) n FROM task_acceptance_receipts').get().n,3);
  assert.deepEqual(evidence.errors,[]);assert.equal(d.pragma('integrity_check',{simple:true}),'ok');evidence.steps.push('Three acceptance receipts, no awarded points, database integrity preserved');
});
