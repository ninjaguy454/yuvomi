/** Real server, encrypted disposable DB, cookies, CSRF, SSE and production UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';

const folder=mkdtempSync(join(tmpdir(),'vidamia-notes-full-app-'));
process.env.DB_PATH=join(folder,'notes.db');process.env.DB_ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.SESSION_SECRET='synthetic-notes-full-app-only';process.env.SESSION_SECURE='false';
process.env.BACKUP_ENABLED='false';process.env.NODE_ENV='development';process.env.LOG_LEVEL='error';
const {get}=await import('../server/db.js');const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-notes-household-2026!';
const evidence={scope:'Actual server and encrypted synthetic DB; Chromium desktop/phone emulation',steps:[],errors:[]};
const output=process.env.NOTES_FULL_APP_EVIDENCE||join(folder,'evidence');mkdirSync(output,{recursive:true});
let server,browser,origin,owner,recipient,other,display;
test.before(async()=>{
  const hash=await hashPassword(password,4);
  for(const [id,name,role] of [[1,'Notes Parent','admin'],[2,'Notes Grace','member'],[3,'Notes Other','member']])
    d.prepare('INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,?,?,?,1)').run(id,name,name,hash,role,role==='admin'?'parent':'child');
  server=fork(new URL('./helpers/note-board-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  let log='';for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>log=(log+chunk).slice(-6000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Server failed to start')),60000);server.once('message',message=>{clearTimeout(timer);resolve(message.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}: ${log}`));});});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  assert.notEqual(readFileSync(process.env.DB_PATH).subarray(0,16).toString(),'SQLite format 3\0','fixture file is encrypted');
});
test.after(async()=>{
  writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));
  await browser?.close();if(server&&server.exitCode===null){server.kill('SIGKILL');await new Promise(resolve=>server.once('exit',resolve));}
  d.close();rmSync(folder,{recursive:true,force:true});
});
test.afterEach(async context=>{if(context.error){for(const [name,page] of Object.entries({owner,recipient,other,display})){if(!page||page.isClosed())continue;console.log('NOTES_FULL_APP_FAILURE',name,page.url(),await page.$eval('body',el=>el.innerText.slice(-1400)).catch(()=>''));await page.screenshot({path:join(output,`failure-${name}.png`)}).catch(()=>{});}}});
async function pageFor(width=1280){
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(15000);await page.setViewport({width,height:960});
  // Docker has no external network, but this fixture's loopback origin is live.
  // Emulate online/focused tabs so Chromium does not suspend live invalidation.
  const cdp=await page.createCDPSession();await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');Object.defineProperty(navigator,'onLine',{get:()=>true});});
  await page.setRequestInterception(true);page.on('request',request=>{const url=new URL(request.url());if((['http:','https:'].includes(url.protocol)&&url.origin!==origin)||url.pathname==='/sw.js')return request.abort();return request.continue();});
  page.on('pageerror',error=>evidence.errors.push(error.message));page.on('response',response=>{if(response.url().includes('/notes/changes')&&response.status()===200)evidence.streamConnections=(evidence.streamConnections||0)+1;});return page;
}
async function field(page,selector,value){await page.waitForSelector(selector);await page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function press(page,selector){await page.bringToFront();await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Enter');}
async function login(page,name){await field(page,'#username',name);await field(page,'#password',password);const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')&&r.request().method()==='POST');await press(page,'#auth-btn');assert.equal((await response).status(),200);await page.waitForSelector('.dashboard');}
async function notesPage(page,{reload=false}={}){
  await page.bringToFront();
  if(reload)await page.goto(origin+'/notes');
  else{await page.waitForFunction(()=>typeof window.yuvomi?.navigate==='function');for(let attempt=0;attempt<30;attempt++){await page.evaluate(()=>window.yuvomi.navigate('/notes'));if(new URL(page.url()).pathname==='/notes')break;await new Promise(resolve=>setTimeout(resolve,100));}}
  await page.waitForSelector('.notes-page');await page.waitForFunction(()=>!document.querySelector('#notes-grid[aria-busy]'));
}
async function adjust(page,id){
  await press(page,`.note-card[data-id="${id}"] [data-board-menu] summary`);
  await press(page,`.note-card[data-id="${id}"] [data-board-action="adjust"]`);
}
async function create(page,title,visibility='all',member=null){
  await page.bringToFront();
  const createButton=await page.evaluate(()=>['#notes-add-btn','#fab-new-note'].find(selector=>{const el=document.querySelector(selector);return el&&el.getBoundingClientRect().width>0&&getComputedStyle(el).visibility!=='hidden';}));
  assert.ok(createButton,'a create control is visible in the real shell');
  await page.focus(createButton);assert.equal(await page.evaluate(()=>document.activeElement.id),createButton.slice(1));await page.keyboard.press('Enter');await field(page,'#note-title',title);await field(page,'#note-content',`Body ${title}\n- [ ] Preserve checklist`);
  if(await page.$('#note-visibility'))await page.select('#note-visibility',visibility);
  if(member){await page.waitForSelector(`[data-note-member="${member}"]`);await page.click(`[data-note-member="${member}"]`);}
  const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/notes')&&r.request().method()==='POST');await press(page,'#note-modal-save');const saved=await response;assert.equal(saved.status(),201,await saved.text());await page.waitForSelector('#note-modal-save',{hidden:true});
  return d.prepare('SELECT * FROM notes WHERE title=?').get(title);
}
const titles=page=>page.$$eval('.note-card__title',els=>els.map(el=>el.textContent));
async function capture(page,name){await page.screenshot({path:join(output,name+'.png')});}

test('real encrypted Notes creation, audience isolation, responsive saved sizing and paired return',{timeout:150000},async()=>{
  owner=await pageFor();await owner.goto(origin+'/login');await login(owner,'Notes Parent');await notesPage(owner);
  const all=await create(owner,'Everyone plan');const privateNote=await create(owner,'Private parent note','private');const selected=await create(owner,'Selected Grace note','selected',2);
  assert.equal(privateNote.visibility,'private');assert.deepEqual(d.prepare('SELECT user_id FROM note_access WHERE note_id=?').all(selected.id).map(row=>row.user_id),[2]);evidence.steps.push('Actual UI creates Everyone, Private and Selected members notes');
  await adjust(owner,privateNote.id);await field(owner,'#note-layout-width','5');await field(owner,'#note-layout-height','7');await field(owner,'#note-layout-x','4');await field(owner,'#note-layout-y','3');await press(owner,'#note-layout-save');await owner.waitForSelector('#note-layout-save',{hidden:true});
  assert.deepEqual(d.prepare('SELECT x,y,width,height FROM note_layouts WHERE note_id=?').get(privateNote.id),{x:4,y:3,width:5,height:7});await notesPage(owner,{reload:true});
  assert.equal(await owner.$eval('#notes-grid',g=>g.dataset.boardView),'canvas');await press(owner,'#notes-compact-view');await owner.select('#notes-list-density','compact');assert.equal(await owner.$('.note-card__content'),null,'Compact list hides body');await capture(owner,'notes-full-app-desktop');await owner.select('#notes-list-density','expanded');await press(owner,'#notes-compact-view');
  await owner.setViewport({width:390,height:960});await create(owner,'Phone-created note');await owner.waitForFunction(()=>document.querySelector('#notes-grid')?.dataset.boardView==='list');assert.ok((await owner.$$eval('.note-card__content',els=>els.map(el=>[...el.textContent].length))).every(n=>n<=200));await capture(owner,'notes-full-app-phone');assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.equal(d.prepare('SELECT width FROM note_layouts WHERE note_id=?').get(privateNote.id).width,5);evidence.steps.push('Desktop layout survives reload and phone reflow; phone creates normal note');
  recipient=await pageFor(390);await recipient.goto(origin+'/login');await login(recipient,'Notes Grace');await notesPage(recipient);assert.ok((await titles(recipient)).includes(selected.title));assert.ok(!(await titles(recipient)).includes(privateNote.title));
  other=await pageFor();await other.goto(origin+'/login');await login(other,'Notes Other');await notesPage(other);assert.ok(!(await titles(other)).some(title=>[privateNote.title,selected.title].includes(title)));evidence.steps.push('Real household accounts see exactly their permitted audiences');
  await owner.bringToFront();await press(owner,`.note-card[data-id="${selected.id}"] [data-action="open"]`);await press(owner,'#note-tab-edit');await owner.select('#note-visibility','private');await press(owner,'#note-modal-save');await owner.waitForSelector('#note-modal-save',{hidden:true});
  await recipient.bringToFront();await recipient.waitForFunction(id=>!document.querySelector(`.note-card[data-id="${id}"]`),{},selected.id);evidence.steps.push('Payload-free live update removes revoked selected note');
  await recipient.evaluate(async()=>{const {auth}=await import('/api.js');await auth.logout();window.yuvomi.clearSession();await window.yuvomi.navigate('/login');});await recipient.waitForFunction(()=>!document.querySelector('.note-card'));evidence.steps.push('Personal logout clears Notes DOM');
  display=await pageFor(1280);await display.goto(origin+'/device/pair');await press(display,'[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await owner.evaluate(async code=>{const {api}=await import('/api.js');await api.post('/devices/pairing-approve',{code,name:'Synthetic Notes Display',permissions:{capabilities:{'device_notes.view':'allow','device_notes.create':'allow','device_notes.edit':'none','device_notes.delete':'none'}}});},code);
  await display.waitForSelector('[data-pair-claim]');await press(display,'[data-pair-claim]');await display.waitForSelector('[data-device-login]');await display.waitForSelector('.dashboard');await notesPage(display);
  assert.ok((await titles(display)).includes(all.title));assert.ok(!(await titles(display)).some(title=>[privateNote.title,selected.title].includes(title)));assert.equal(await display.$('[data-board-action="adjust"]'),null);
  const deviceNote=await create(display,'Device-created note');assert.equal(deviceNote.visibility,'all');assert.equal(deviceNote.created_by,null);assert.ok(deviceNote.created_by_device);evidence.steps.push('Actual paired View+Create device sees Everyone only; creation confers no Edit');
  await press(display,'[data-device-login]');await login(display,'Notes Parent');await display.waitForSelector('[data-temporary-access]');await notesPage(display);
  assert.ok((await titles(display)).includes(privateNote.title));await press(display,`.note-card[data-id="${privateNote.id}"] [data-action="open"]`);assert.ok(await display.$('.note-modal'));
  await Promise.all([display.waitForNavigation({waitUntil:'domcontentloaded'}),display.evaluate(()=>document.querySelector('[data-temporary-access] button').click())]);await display.waitForFunction(()=>!!document.querySelector('[data-device-login]')&&!!document.querySelector('.dashboard'));assert.equal(await display.$('.note-modal'),null);await notesPage(display);
  assert.ok(!(await titles(display)).some(title=>[privateNote.title,selected.title].includes(title)));await capture(display,'notes-full-app-returned-device');evidence.steps.push('Real temporary login shows owner private notes; return removes private modal and cards');
  assert.deepEqual(evidence.errors,[]);assert.ok(evidence.streamConnections>=3,'real Notes change streams connected');assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
