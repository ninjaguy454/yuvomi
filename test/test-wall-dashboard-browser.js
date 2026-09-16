import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import Database from 'better-sqlite3-multiple-ciphers';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='wall-browser-isolated';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const {default:wallRouter}=await import('../server/routes/wall.js');
const {requireAuth}=await import('../server/auth.js');
const {saveWallConfig,WALL_DEFAULTS}=await import('../server/services/wall.js');
const {todayKey}=await import('../server/utils/timezone.js');
const {setTaskSkills}=await import('../server/services/task-skills.js');
const {reconcileTaskSupervision}=await import('../server/services/task-supervision.js');
const {taskChangesStream}=await import('../server/services/task-changes.js');
const {resolvePermissions}=await import('../server/permissions.js');
const d=new Database(':memory:');d.pragma('foreign_keys=ON');
for(const m of ALL_MIGRATIONS){typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);}
_setTestDatabase(d);
const password=await hashPassword('wall-browser-password',4);
const addUser=(name,role)=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,?,?,'parent')").run(name,name,password,role).lastInsertRowid);
const admin=addUser('Wall Administrator','admin'),learner=addUser('Grace Learner','member');
d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
const task=(title,parent=null,visibility='all')=>{
 const id=Number(d.prepare("INSERT INTO tasks(title,description,created_by,assigned_to,parent_task_id,visibility,points) VALUES(?,'Read the instructions, then complete your steps.',?,?,?,?,?)").run(title,admin,learner,parent,visibility,parent?0:5).lastInsertRowid);
 if(!parent)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,learner);return id;
};
const root=task('Shared Laundry'),step1=task('Gather clothes',root),step2=task('Fold clean clothes',root);
const privateTask=task('SECRET PRIVATE TASK',null,'private');
const future=task('Next weekly Laundry');d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',start_date='2099-12-01' WHERE id=?").run(future);
const mixed=task('Mixed learner and helper work'),own=task('Gather towels',mixed),supervised=task('Sort towels',mixed),delegated=task('Run washer',mixed);
for(const [name,step,level]of [['Sorting',supervised,'supervised'],['Washer',delegated,'excluded']]){
 const skill=Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid);
 for(const [id,value]of [[learner,level],[admin,'normal']])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(id,skill,value,admin);
 setTaskSkills(d,step,[skill]);
}
const mixedScope=reconcileTaskSupervision(d,mixed);
for(let i=0;i<28;i++)task(`Household chore ${i+1}`);
const reward=Number(d.prepare("INSERT INTO reward_catalog(name,cost,icon,created_by) VALUES('Family movie',5,'🎬',?)").run(admin).lastInsertRowid);
d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
const today=todayKey(d);
d.prepare("INSERT INTO meals(title,date,meal_type,notes,created_by,scope,selection_status) VALUES('Pasta and vegetables',?,'dinner','Dinner together at 6:30.',?,'household','selected')").run(today,admin);
const shopping=Number(d.prepare("INSERT INTO shopping_lists(name,created_by) VALUES('Groceries',?)").run(admin).lastInsertRowid);
for(const [name,qty]of [['Milk','1 gallon'],['Bananas','6'],['Pasta','2 boxes']])d.prepare('INSERT INTO shopping_items(list_id,name,quantity) VALUES(?,?,?)').run(shopping,name,qty);
for(const [title,hour]of [['Family dinner','18:30'],['Movie night','20:00']])d.prepare("INSERT INTO calendar_events(title,start_datetime,visibility,created_by) VALUES(?,?,'all',?)").run(title,`${today}T${hour}`,admin);
d.prepare("INSERT INTO notes(title,content,pinned,created_by) VALUES('Family announcement','A shared note for the wall.',1,?)").run(admin);
const publicDir=fileURLToPath(new URL('../public',import.meta.url));
const styles=[...readFileSync(path.join(publicDir,'index.html'),'utf8').matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(m=>m[0]).join('\n');
const app=express();app.use(express.json());
app.use(express.static(publicDir));
const host={userId:admin,role:'admin',save:cb=>cb()};
d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY,sess TEXT NOT NULL,expired_at INTEGER NOT NULL)');
d.prepare('INSERT OR REPLACE INTO sessions(sid,sess,expired_at) VALUES(?,?,?)').run('wall-browser-host',JSON.stringify({userId:admin}),Date.now()+3_600_000);
app.use((req,_res,next)=>{req.sessionID='wall-browser-host';req.session=host;next();});
app.get('/wall-browser-test',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/dashboard.css"><script src="/lucide.min.js"></script></head><body><main id="main-content" style="height:100dvh;overflow:auto"></main></body></html>`));
app.get('/api/v1/auth/me',(_req,res)=>res.json({user:{id:admin,role:'admin'},permissions:resolvePermissions(d,d.prepare('SELECT * FROM users WHERE id=?').get(admin)),csrfToken:'fixture',wallMode:!!host.wallMode}));
app.get('/api/v1/version',(_req,res)=>res.json({version:'wall-test',setup_required:false}));
app.use('/api/v1',requireAuth);app.use('/api/v1/wall',wallRouter);
app.get('/api/v1/tasks/changes',taskChangesStream);
let browser,server,base;
test.before(async()=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));base=`http://127.0.0.1:${server.address().port}`;
 const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(edge)?edge:undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(r=>server?.close(r)||r());d.close();});
const config=(palette='warm',theme='dark')=>({...structuredClone(WALL_DEFAULTS),
 widgets:WALL_DEFAULTS.widgets.map(w=>({...w,visible:w.id!=='weather'&&w.id!=='presence'})),
 appearance:{theme,palette,font:'serif',density:'comfortable',clock:true},
 privacy:{notifications:'hidden',showPoints:true,showPresence:false},interaction:{mode:'interactive',actions:['task_complete','task_claim','reward_redeem']}});
async function pageAt(width=1920,height=1080,palette='warm',theme='dark',realStream=false){
 saveWallConfig(d,config(palette,theme));const page=await browser.newPage();page.setDefaultTimeout(7000);
 await page.setViewport({width,height,hasTouch:true,isMobile:false,deviceScaleFactor:1});
 await page.setUserAgent('Mozilla/5.0 (Linux; Android 16; Wall QA Build; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Safari/537.36 FullyKiosk');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.qaErrors=errors;
 await page.goto(`${base}/wall-browser-test`);
 await page.evaluate(async realStream=>{
  localStorage.setItem('yuvomi-locale','en');localStorage.setItem('yuvomi-wall-mode','1');document.documentElement.setAttribute('data-wall-mode','');
  window.liveStreams=[];window.toasts=[];window.yuvomi={showToast:message=>window.toasts.push(message)};
  if(!realStream)window.EventSource=class{constructor(url){this.url=url;this.listeners=new Map();this.readyState=1;window.liveStreams.push(this);}addEventListener(n,f){this.listeners.set(n,f);}close(){this.readyState=2;}};
  const overlays=await import('/utils/overlay-history.js');window.addEventListener('popstate',()=>overlays.handleBackNavigation());
  await(await import('/i18n.js')).initI18n();window.disposeWall=await(await import('/pages/dashboard.js')).render(document.getElementById('main-content'),{user:{id:1,role:'admin'}});
 },realStream);
 await page.waitForSelector('[data-wall-grid]');return page;
}
async function identify(page,id=learner){
 await page.waitForSelector('[data-wall-identify-form]');await page.select('[name=user_id]',String(id));await page.type('[name=password]','wall-browser-password');await page.click('[data-wall-identify-form] [type=submit]');
 await page.waitForFunction(()=>!document.querySelector('[data-wall-identify-form]'));
}
async function screenshot(page,name){const dir=process.env.WALL_QA_OUTPUT;if(dir){mkdirSync(dir,{recursive:true});await new Promise(r=>setTimeout(r,350));await page.screenshot({path:path.join(dir,name+'.png'),fullPage:true});}}

test('large wall, tablet landscape/portrait, and mobile fit with usable touch controls and themes',async()=>{
 for(const [width,height,palette,theme]of [[1920,1080,'warm','dark'],[2560,1440,'cool','light'],[1280,800,'neutral','light'],[800,1280,'cool','dark'],[412,915,'warm','light']]){
  const page=await pageAt(width,height,palette,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${width} overflow`);
  const size=await page.$eval('[data-wall-identify]',el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));assert.ok(size.height>=44);
  assert.equal(await page.$eval('main',el=>el.innerText.includes('SECRET')),false);
  assert.equal(await page.evaluate(async()=> (await import('/utils/timezone.js')).displayTimeZone()),'America/New_York');
  await screenshot(page,`wall-${width}-${palette}-${theme}`);assert.deepEqual(page.qaErrors,[]);await page.close();
 }
});
test('safe details use actual actor, canonical child/parent revisions and parent completion; private detail denied',async()=>{
 const page=await pageAt();await page.click(`[data-wall-kind="tasks"][data-wall-open="${root}"]`);await page.waitForSelector('[data-wall-detail-body]');
 assert.equal(await page.$eval('.wall-dialog',el=>getComputedStyle(el).animationName),'none');
 await page.click(`[data-wall-step="${step1}"]`);await identify(page);
 await page.waitForFunction(()=>document.querySelector('[data-wall-detail-body]')?.innerText.includes('1 of 2 steps'));
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'in_progress');
 assert.equal(d.prepare("SELECT actor_user_id FROM task_activity_events WHERE action_task_id=? AND event_type='completed' ORDER BY id DESC").get(step1).actor_user_id,learner);
 await page.click(`[data-wall-step="${step2}"]`);await page.waitForFunction(()=>document.querySelector('[data-wall-detail-body]')?.innerText.includes('Completed'));
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'done');assert.equal(d.prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE task_id=? AND type='earn'").get(root).n,1);
 const status=await page.evaluate(async id=>(await fetch(`/api/v1/wall/tasks/${id}`)).status,privateTask);assert.equal(status,404);
 assert.deepEqual(page.qaErrors,[]);await screenshot(page,'wall-completed-detail');await page.close();
});
test('admin verification required for layout; reorder/size save does not write personal Dashboard preferences',async()=>{
 const page=await pageAt();await page.click('[data-wall-settings]');await identify(page,admin);await page.waitForSelector('[data-wall-settings-form]');
 await page.click('[data-id=tasks] [data-move="-1"]');await page.select('[data-id=tasks] [data-size]','small');await page.select('[name=palette]','neutral');await page.click('[data-wall-settings-form] [type=submit]');
 await page.waitForFunction(()=>!document.querySelector('[data-wall-settings-form]'));
 await page.waitForSelector('[data-widget=tasks][data-size=small]');
 const saved=JSON.parse(d.prepare("SELECT value FROM sync_config WHERE key='wall_dashboard_v1'").get().value);assert.equal(saved.widgets[0].id,'tasks');assert.equal(saved.widgets[0].size,'small');assert.equal(saved.appearance.palette,'neutral');
 assert.deepEqual(page.qaErrors,[]);await page.close();
});
test('rapid touch scroll on a card does not activate/select; live refresh preserves scroll and open detail',async()=>{
 const page=await pageAt(800,1280);const cdp=await page.createCDPSession();
 const box=await page.$eval('[data-widget=tasks] .task-item',el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:Math.min(r.bottom-10,1100)};});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x,y:box.y}]});
 for(let n=1;n<=5;n++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x,y:box.y-n*70}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await new Promise(r=>setTimeout(r,350));assert.equal(await page.$('.modal-overlay'),null);
 const scroll=await page.$eval('[data-widget=tasks] .widget__body',el=>{el.scrollTop=210;return el.scrollTop;});
 await page.evaluate(()=>window.liveStreams.find(x=>x.url.includes('/tasks/')).listeners.get('change')({data:'{"version":999999}'}));
 await new Promise(r=>setTimeout(r,300));assert.equal(await page.$eval('[data-widget=tasks] .widget__body',el=>el.scrollTop),scroll);
 assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('supervised/delegated controls retain ownership; helper completion updates the same source action',async()=>{
 const page=await pageAt();await page.click('[data-wall-identify]');await identify(page);
 await page.click(`[data-wall-kind=tasks][data-wall-open="${mixed}"]`);await page.waitForSelector(`[data-wall-step="${delegated}"]`);
 assert.equal(await page.$eval(`[data-wall-step="${delegated}"]`,el=>el.disabled),true);
 assert.equal(await page.$eval(`[data-wall-step="${supervised}"]`,el=>el.disabled),true);
 assert.equal(await page.$eval(`[data-wall-step="${own}"]`,el=>el.disabled),false);
 await screenshot(page,'wall-mixed-learner-detail');await page.click('[data-action=close-modal]');await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));
 await page.click('[data-wall-forget]');await page.click('[data-wall-identify]');await identify(page,admin);
 const counterpart=mixedScope.actions.find(a=>a.action_task_id===delegated).counterpart_task_id;
 const helper=d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(counterpart).parent_task_id;
 await page.evaluate(async id=>{const el=document.querySelector('[data-wall-grid]');const button=document.createElement('button');button.dataset.wallOpen=id;button.dataset.wallKind='tasks';el.append(button);button.click();},helper);
 await page.waitForSelector(`[data-wall-step="${counterpart}"]`);assert.equal(await page.$eval(`[data-wall-step="${counterpart}"]`,el=>el.disabled),false);
 await page.click(`[data-wall-step="${counterpart}"]`);await page.waitForFunction(id=>document.querySelector(`[data-wall-step="${id}"]`)?.getAttribute('aria-label')?.startsWith('Completed:'),{},counterpart);
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(delegated).status,'done');assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(mixed).status,'in_progress');
 assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('future recurring completion returns the actual reason and leaves the Task unchanged',async()=>{
 const page=await pageAt();await page.click('[data-wall-identify]');await identify(page);
 await page.evaluate(id=>{const el=document.querySelector('[data-wall-grid]');const button=document.createElement('button');button.dataset.wallOpen=id;button.dataset.wallKind='tasks';el.append(button);button.click();},future);
 await page.waitForSelector('[data-wall-complete]');await page.click('[data-wall-complete]');
 await page.waitForFunction(()=>window.toasts.some(x=>x.includes('2099-12-01')));
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(future).status,'open');assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_ledger WHERE task_id=?').get(future).n,0);
 assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('Wall redemption attributes the member, confirms once, and closes the successful dialog',async()=>{
 const page=await pageAt();await page.click('[data-wall-identify]');await identify(page);
 await page.click(`[data-wall-kind=rewards][data-wall-open="${reward}"]`);await page.waitForSelector('[data-wall-redeem]');await page.click('[data-wall-redeem]');
 await page.waitForSelector('#confirm-modal-ok');await page.click('#confirm-modal-ok');await page.waitForFunction(()=>window.toasts.includes('Reward requested.'));
 await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));
 const rows=d.prepare("SELECT user_id,delta FROM reward_ledger WHERE type='redeem'").all();assert.deepEqual(rows,[{user_id:learner,delta:-5}]);
 assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('two Wall clients converge through actual Task SSE and reconnect after network loss',async()=>{
 const first=await pageAt(1280,800,'warm','light',true),second=await pageAt(1280,800,'warm','light',true);
 const liveId=task('Live assignment before');d.prepare("UPDATE tasks SET due_date=? WHERE id=?").run(today,liveId);
 await second.waitForFunction(()=>document.querySelector('[data-widget=tasks]')?.textContent.includes('Live assignment before'));
 await second.setOfflineMode(true);d.prepare("UPDATE tasks SET title='Live assignment after reconnect' WHERE id=?").run(liveId);
 await first.waitForFunction(()=>document.querySelector('[data-widget=tasks]')?.textContent.includes('Live assignment after reconnect'));
 await second.setOfflineMode(false);await second.evaluate(()=>window.dispatchEvent(new Event('online')));
 await second.waitForFunction(()=>document.querySelector('[data-widget=tasks]')?.textContent.includes('Live assignment after reconnect'));
 assert.deepEqual(first.qaErrors,[]);assert.deepEqual(second.qaErrors,[]);await first.close();await second.close();
});

test('a step with nested work requires confirmation; cancelling preserves all progress',async()=>{
 const parent=task('Nested household work'),group=task('Kitchen steps',parent),child=task('Put dishes away',group);
 d.prepare('UPDATE tasks SET due_date=? WHERE id=?').run(today,parent);
 const page=await pageAt();await page.click('[data-wall-identify]');await identify(page);
 await page.click(`[data-wall-kind=tasks][data-wall-open="${parent}"]`);await page.waitForSelector(`[data-wall-step="${group}"]`);
 await page.click(`[data-wall-step="${group}"]`);await page.waitForSelector('#confirm-modal-cancel');
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');
 await page.click('#confirm-modal-cancel');await page.waitForFunction(id=>document.querySelector(`[data-wall-step="${id}"]`)?.disabled===false,{},group);
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(group).status,'open');
 await page.click(`[data-wall-step="${group}"]`);await page.waitForSelector('#confirm-modal-ok');await page.click('#confirm-modal-ok');
 await page.waitForFunction(id=>document.querySelector(`[data-wall-step="${id}"]`)?.getAttribute('aria-label')?.startsWith('Completed:'),{},group);
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'done');assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('a delayed action cannot acquire another member’s identity after Done and reidentification',async()=>{
 const parent=task('Identity-bound work'),child=task('Identity-bound step',parent);d.prepare('UPDATE tasks SET due_date=? WHERE id=?').run(today,parent);
 const page=await pageAt();await page.click('[data-wall-identify]');await identify(page);
 await page.click(`[data-wall-kind=tasks][data-wall-open="${parent}"]`);await page.waitForSelector(`[data-wall-step="${child}"]`);
 await page.setRequestInterception(true);let release,heldRequest,heldBody;const held=new Promise(resolve=>release=resolve);
 page.on('request',async request=>{if(!heldRequest&&request.method()==='GET'&&request.url().endsWith(`/wall/tasks/${child}`)){heldRequest=request;heldBody=await(await fetch(request.url(),{headers:request.headers()})).text();release();}else request.continue();});
 await page.click(`[data-wall-step="${child}"]`);await held;
 await page.click('[data-action=close-modal]');await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));
 await page.click('[data-wall-forget]');await page.click('[data-wall-identify]');await identify(page,admin);
 await heldRequest.respond({status:200,contentType:'application/json',body:heldBody});await page.waitForFunction(()=>window.toasts.some(text=>text.includes('identity changed or expired')));
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');assert.deepEqual(page.qaErrors,[]);await page.close();
});

test('real app router clears a private modal on cross-tab Wall entry and does not reload again on live auth',async()=>{
 host.wallMode=false;const context=await browser.createBrowserContext();const page=await context.newPage();page.setDefaultTimeout(10000);
 await page.goto(base+'/');await page.waitForFunction(()=>window.yuvomi?.navigate&&document.querySelector('#main-content'));
 await page.evaluate(async()=>{const modal=await import('/components/modal.js');modal.openModal({title:'Private fixture',content:'PRIVATE BEFORE WALL'});});
 await page.waitForSelector('.modal-overlay');const other=await context.newPage();await other.goto(base+'/wall-browser-test');
 await other.evaluate(async()=>{await fetch('/api/v1/wall/enter',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});localStorage.setItem('yuvomi-wall-mode','1');});
 await page.waitForSelector('[data-wall-grid]');assert.equal(await page.evaluate(()=>document.body.textContent.includes('PRIVATE BEFORE WALL')),false);
 const time=await page.evaluate(()=>performance.timeOrigin);await page.evaluate(async()=>{await(await import('/api.js')).auth.me();window.dispatchEvent(new CustomEvent('yuvomi:wall-lock'));});
 await new Promise(r=>setTimeout(r,250));assert.equal(await page.evaluate(()=>performance.timeOrigin),time);assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).visibility),'visible');
 await screenshot(page,'wall-real-app');await context.close();
});
