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

async function shot(page,name) {
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await capture(page,name);
  evidence.steps.push({image:name+'.png',viewport:page.viewport(),theme:await page.evaluate(()=>document.documentElement.dataset.theme),horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
}
async function theme(page,value){await page.evaluate(value=>window.yuvomi.applyTheme(value),value);}
async function savedLayout(page,id,layout){
  await page.evaluate(async({id,layout})=>{const {api}=await import('/api.js');const {data}=await api.get('/notes');const note=data.find(note=>note.id===id);await api.patch(`/notes/${id}/layout`,{expected_layout_revision:note.layout.revision,layout});},{id,layout});
}
async function closeNote(page){await page.evaluate(async()=>await(await import('/components/modal.js')).closeModal({force:true}));await page.waitForSelector('.note-modal',{hidden:true});}
async function openRead(page,id){
  // A fresh shell navigation/live projection may restore focus after the card
  // mounts. Retry only the read-only opener, then require the actual reader.
  for(let attempt=0;attempt<3;attempt++){
    await press(page,`.note-card[data-id="${id}"] [data-action="open"]`);
    try{await page.waitForSelector('.note-read__body',{visible:true,timeout:1200});return;}catch(error){if(attempt===2)throw error;}
  }
}

test('Phase 2 actual-app visual QA matrix and interaction states',{timeout:300000},async()=>{
  owner=await pageFor(1440);await owner.goto(origin+'/login');await login(owner,'Notes Parent');await notesPage(owner);
  const small=await create(owner,'Weekend plans and everything to remember before we head outside');
  const long=await create(owner,'Garden checklist');const normal=await create(owner,'Dinner together');
  const privateNote=await create(owner,'Private family conversation','private');const selected=await create(owner,'For Grace: weekend surprise','selected',2);
  const longContent='# Our weekend\n\n- [ ] Water the seedlings\n- [x] Pack a picnic blanket\n\n'+Array.from({length:18},(_,i)=>`## ${i+1}. A little reminder\nTake time to check the weather, bring enough water, and leave the garden tools clean for the next person.`).join('\n\n')+'\n\nLAST REMINDER: Have a lovely afternoon.';
  await owner.evaluate(async({id,content})=>{const {api}=await import('/api.js');const {data}=await api.get('/notes');const note=data.find(n=>n.id===id);await api.put(`/notes/${id}`,{title:note.title,content,color:note.color,pinned:note.pinned,expected_revision:note.revision});},{id:long.id,content:longContent});
  for(const [id,layout] of [[small.id,{x:0,y:0,width:3,height:4}],[long.id,{x:4,y:0,width:4,height:8}],[normal.id,{x:8,y:0,width:4,height:6}],[privateNote.id,{x:0,y:9,width:4,height:6}],[selected.id,{x:4,y:9,width:4,height:6}]])await savedLayout(owner,id,layout);
  display=await pageFor(1440);await display.goto(origin+'/device/pair');await press(display,'[data-pair-start]');await display.waitForSelector('[data-pair-code]');const code=await display.$eval('[data-pair-code]',el=>el.textContent);
  await owner.evaluate(async code=>{const {api}=await import('/api.js');await api.post('/devices/pairing-approve',{code,name:'Kitchen display',permissions:{capabilities:{'device_notes.view':'allow','device_notes.create':'allow','device_notes.edit':'allow','device_notes.delete':'allow'}}});},code);
  await display.waitForSelector('[data-pair-claim]');await press(display,'[data-pair-claim]');await display.waitForSelector('[data-device-login]');await display.waitForSelector('.dashboard');await notesPage(display);
  assert.ok(!(await titles(display)).some(title=>[privateNote.title,selected.title].includes(title)));
  for(const width of [320,390,768,1280,1440])for(const appearance of ['light','dark']){
    await display.setViewport({width,height:960});await theme(display,appearance);await display.evaluate(()=>document.querySelector('.notes-scroll').scrollTop=0);
    await shot(display,`paired-board-${width}-${appearance}`);
  }
  // Real pointer operations on paired display, with authoritative persisted geometry.
  await theme(display,'light');await display.setViewport({width:1440,height:960});
  await display.waitForFunction(()=>document.querySelector('#notes-grid')?.dataset.boardView==='canvas');
  const displayId=d.prepare("SELECT id FROM household_devices WHERE name='Kitchen display'").get().id;
  const displayLayout=id=>d.prepare('SELECT * FROM note_board_note_layouts WHERE owner_key=? AND note_id=?').get(`device:${displayId}`,id);
  const beforeMove=displayLayout(small.id)?.revision??0;
  let box=await display.$eval('.note-card[data-id="'+small.id+'"]',el=>el.getBoundingClientRect().toJSON());
  await display.mouse.move(box.x+box.width/2,box.y+85);await display.mouse.down();await display.mouse.move(box.x+box.width/2+90,box.y+335,{steps:10});await display.mouse.up();await display.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
  assert.ok(displayLayout(small.id).revision>beforeMove,'direct card drag persisted');await shot(display,'paired-move-after-1440-light');
  const beforeResize=displayLayout(small.id).revision;
  box=await display.$eval('.note-card[data-id="'+small.id+'"]',el=>el.getBoundingClientRect().toJSON());await display.mouse.move(box.right-5,box.bottom-5);await display.mouse.down();await new Promise(resolve=>setTimeout(resolve,500));await display.mouse.move(box.right+195,box.bottom+145,{steps:10});await display.mouse.up();await display.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
  assert.ok(displayLayout(small.id).revision>beforeResize,'held corner resize persisted');await shot(display,'paired-resize-after-1440-light');
  await press(display,'#notes-organize');await display.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');await shot(display,'paired-organize-after-1440-light');
  // Keyboard-only alternative on tablet, then apply the legal maximum size.
  await display.setViewport({width:768,height:960});await theme(display,'dark');await adjust(display,small.id);await shot(display,'keyboard-layout-768-dark');
  await field(display,'#note-layout-width','12');await field(display,'#note-layout-height','100');await field(display,'#note-layout-x','0');await field(display,'#note-layout-y','0');await press(display,'#note-layout-save');await display.waitForSelector('#note-layout-save',{hidden:true});
  await display.setViewport({width:1440,height:960});await display.evaluate(()=>document.querySelector('.notes-scroll').scrollTop=0);await shot(display,'maximum-card-top-1440-dark');
  await display.evaluate(id=>document.querySelector(`.note-card[data-id="${id}"] [data-action="open"]`).scrollIntoView({block:'center'}),small.id);await shot(display,'maximum-card-controls-1440-dark');
  await savedLayout(display,small.id,{x:0,y:8,width:3,height:4});await display.goto(origin+'/');await display.waitForSelector('.dashboard');await notesPage(display);
  // Long reader/editor with actual scroll and a selected audience picker.
  await owner.setViewport({width:390,height:960});await theme(owner,'dark');await notesPage(owner,{reload:true});await theme(owner,'dark');
  await openRead(owner,long.id);await shot(owner,'long-reader-top-390-dark');
  await owner.evaluate(()=>{const el=document.querySelector('.modal-panel__body');el.scrollTop=el.scrollHeight;});await shot(owner,'long-reader-bottom-390-dark');
  await press(owner,'#note-tab-edit');await owner.waitForSelector('#note-content',{visible:true});await shot(owner,'long-editor-390-dark');await closeNote(owner);
  await owner.setViewport({width:320,height:960});await theme(owner,'light');await openRead(owner,selected.id);await press(owner,'#note-tab-edit');await owner.waitForSelector('[data-note-member="2"]');await shot(owner,'audience-picker-320-light');
  await owner.evaluate(()=>{const el=document.querySelector('.modal-panel__body');el.scrollTop=el.scrollHeight;});await shot(owner,'editor-footer-320-light');await closeNote(owner);
  // Touch scroll a narrow compact board, keeping all distant notes reachable.
  await display.setViewport({width:320,height:960});await theme(display,'dark');const cdp=await display.createCDPSession();
  const area=await display.$eval('.notes-scroll',el=>{const r=el.getBoundingClientRect();return {x:r.right-8,y:r.bottom-90};});await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[area]});for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:area.x,y:area.y-i*42}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();await shot(display,'touch-scroll-320-dark');
  // Visual privacy evidence through real logout and temporary-device return.
  recipient=await pageFor(390);await recipient.goto(origin+'/login');await login(recipient,'Notes Grace');await notesPage(recipient);await openRead(recipient,selected.id);
  await owner.evaluate(async id=>{const {api}=await import('/api.js');const {data}=await api.get('/notes');const note=data.find(n=>n.id===id);await api.put(`/notes/${id}`,{title:note.title,content:note.content,color:note.color,pinned:note.pinned,visibility:'private',expected_revision:note.revision});},selected.id);
  await recipient.waitForFunction(id=>!document.querySelector(`.note-card[data-id="${id}"]`)&&!document.querySelector('.note-modal'),{},selected.id);await shot(recipient,'access-revoked-390-light');
  await recipient.evaluate(async()=>{const {auth}=await import('/api.js');await auth.logout();window.yuvomi.clearSession();await window.yuvomi.navigate('/login');});await recipient.waitForSelector('#username');await shot(recipient,'logout-cleared-390-light');
  await display.setViewport({width:1280,height:960});await press(display,'[data-device-login]');await login(display,'Notes Parent');await display.waitForSelector('[data-temporary-access]');await notesPage(display);await openRead(display,privateNote.id);
  await Promise.all([display.waitForNavigation({waitUntil:'domcontentloaded'}),display.evaluate(()=>document.querySelector('[data-temporary-access] button').click())]);await display.waitForFunction(()=>!!document.querySelector('[data-device-login]')&&!!document.querySelector('.dashboard'));await notesPage(display);await theme(display,'dark');
  // Move/resize legitimately permits overlapping free-canvas positions. End
  // the privacy demonstration with the app's Organize action for a clear view.
  await press(display,'#notes-organize');await display.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
  const finalCards=await display.$$eval('.note-card',cards=>cards.map(card=>{const rect=card.getBoundingClientRect();return {id:Number(card.dataset.id),x:rect.x,y:rect.y,width:rect.width,height:rect.height};}));
  assert.equal(new Set(finalCards.map(card=>card.id)).size,finalCards.length,'no duplicate note DOM after return');
  for(let i=0;i<finalCards.length;i++)for(let j=i+1;j<finalCards.length;j++){const a=finalCards[i],b=finalCards[j];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,'organized returned cards do not overlap');}
  evidence.returnedCards=finalCards;evidence.returnedLayouts=d.prepare('SELECT note_id,x,y,width,height FROM note_board_note_layouts WHERE owner_key=?').all(`device:${displayId}`);
  await shot(display,'returned-device-cleared-1280-dark');
  assert.equal(await display.$('.note-modal'),null);assert.ok(!(await titles(display)).some(title=>[privateNote.title,selected.title].includes(title)));assert.deepEqual(evidence.errors,[]);
});
