import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer';

const folder=mkdtempSync(join(tmpdir(),'vidamia-trip-checklist-'));
Object.assign(process.env,{DB_PATH:join(folder,'synthetic.db'),SESSION_SECRET:'synthetic-trip-browser-only',SESSION_SECURE:'false',BACKUP_ENABLED:'false',NODE_ENV:'development',LOG_LEVEL:'error'});
delete process.env.DB_ENCRYPTION_KEY;
const {get}=await import('../server/db.js');
const {hashPassword}=await import('../server/utils/password.js');
const d=get(),password='Synthetic-Trip-Only-2031!',output=process.env.TRIP_EVIDENCE||join(folder,'evidence');
mkdirSync(output,{recursive:true});
let server,browser,origin,log='';
const evidence={scope:'Real app/auth/routes, disposable synthetic data, sandboxed Chrome, loopback only',results:[],errors:[]};
test.before(async()=>{
 d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'tripqa','Synthetic Parent',?,'admin','parent',1)").run(await hashPassword(password,4));
 d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(2,'tripchild','Synthetic Traveler','x','member','child',1)").run();
 d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--disable-background-networking','--disable-component-update']});
 assert.ok(!browser.process().spawnargs.includes('--no-sandbox'));
});
test.beforeEach(async()=>{
 server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [server.stdout,server.stderr])stream.on('data',c=>log=(log+c).slice(-12000));
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),50000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin)});server.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+' '+log))});});
});
test.afterEach(async()=>{if(server?.exitCode===null){server.kill();await new Promise(r=>server.once('exit',r));}});
test.after(async()=>{writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2));writeFileSync(join(output,'server.log'),log);await browser?.close();d.close();for(const suffix of ['','-wal','-shm'])try{unlinkSync(join(folder,'synthetic.db'+suffix));}catch{}try{rmdirSync(folder)}catch{}});
const set=(page,selector,value)=>page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
const press=async(page,selector)=>{await page.waitForSelector(selector);await page.focus(selector);await page.keyboard.press('Enter');};
async function save(page,method,path){const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method);await press(page,'[form="automation-trip-form"][type="submit"]');const response=await pending;assert.equal(response.status(),method==='POST'?201:200,await response.text());const result=await response.json();await page.waitForSelector('#automation-trip-form',{hidden:true});return result.data;}
async function edit(page,id){await page.waitForNetworkIdle({idleTime:400,concurrency:2});await press(page,`[data-edit-trip="${id}"]`);await page.waitForSelector('#automation-trip-form',{visible:true});await page.waitForSelector('[data-trip-step="pack-clothing"]');}

for(const width of [1280,390,320])test('new Trip checklist create/edit/cancel in real app at '+width,{timeout:120000},async()=>{
 const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(18000);
 await page.setViewport({width,height:width<500?844:1000,isMobile:width<500,hasTouch:width<500});
 await page.setRequestInterception(true);page.on('request',r=>{if(r.isInterceptResolutionHandled())return;const url=new URL(r.url());return void(url.pathname==='/sw.js'?r.abort():r.continue());});
 page.on('pageerror',e=>evidence.errors.push(e.message));
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});
 try{
  await page.goto(origin+'/login');assert.equal(await page.evaluate(async password=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'tripqa',password})})).status,password),200);
  await page.goto(origin+'/calendar?section=trips');await page.waitForSelector('#automation-add-trip');await press(page,'#automation-add-trip');await page.waitForSelector('#automation-trip-form');
  await set(page,'[name="name"]','Synthetic beach '+width);await set(page,'[name="starts_at"]','2031-07-10T09:00');await set(page,'[name="ends_at"]','2031-07-14T18:00');
  await page.click('[name="participant_id"][value="1"]');await page.click('[name="participant_id"][value="2"]');
  const pack='[data-trip-step="pack-clothing"]',unpack='[data-trip-step="unpack"]';
  await page.click(pack+' [data-step-enabled]');await set(page,pack+' [data-step-owners]','2');await set(page,pack+' [data-step-reminder]','60');
  await page.click(unpack+' [data-step-enabled]');await set(page,unpack+' [data-step-owners]','1');await set(page,unpack+' [data-step-mode]','fixed');await set(page,unpack+' [data-step-date]','2031-07-16');
  await page.$eval(pack,el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:join(output,'create-'+width+'.png')});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No page overflow');
  for(const rect of await page.$$eval(pack+' .input',els=>els.map(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height};})))assert.ok(rect.width>=44&&rect.height>=44,JSON.stringify(rect));
  let trip=await save(page,'POST','/api/v1/planning/admin/trips');assert.equal(trip.tasks.length,2);assert.ok(trip.tasks.every(t=>t.parent_task_id===trip.parent_task.id&&t.points===0));
  const ids=trip.tasks.map(t=>t.id);assert.equal(trip.tasks.find(t=>t.step_key==='pack-clothing').assigned_to,2);
  assert.notEqual(trip.parent_task.id,trip.travel_meal_plan_task.id);
  const root=await page.evaluate(async id=>{const {api}=await import('/api.js');return (await api.get('/tasks/'+id)).data;},trip.parent_task.id);
  assert.equal(root.display_due_date,'2031-07-09');assert.equal(root.next_trip_step.title,'Pack clothing');
  await edit(page,trip.id);await set(page,'[name="starts_at"]','2031-07-12T09:00');trip=await save(page,'PUT','/api/v1/planning/admin/trips/'+trip.id);
  assert.deepEqual(trip.tasks.map(t=>t.id),ids);assert.equal(trip.tasks.find(t=>t.step_key==='pack-clothing').due_date,'2031-07-11');assert.equal(trip.tasks.find(t=>t.step_key==='unpack').due_date,'2031-07-16');
  await edit(page,trip.id);await page.$eval('[data-trip-step="pack-clothing"]',el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:join(output,'edit-'+width+'.png')});
  await set(page,'[name="status"]','cancelled');trip=await save(page,'PUT','/api/v1/planning/admin/trips/'+trip.id);
  assert.equal(trip.task_group_state,'cancelled');assert.ok(trip.tasks.every(t=>t.archived_at));
  await edit(page,trip.id);await set(page,'[name="status"]','active');await page.focus('[name="restore_remaining"]');await page.keyboard.press('Space');assert.equal(await page.$eval('[name="restore_remaining"]',el=>el.checked),true);trip=await save(page,'PUT','/api/v1/planning/admin/trips/'+trip.id);assert.ok(trip.tasks.every(t=>!t.archived_at));
  evidence.results.push({width,created:true,stableIds:true,independentOwners:true,fixedAndRelativeDates:true,separateMealTask:true,cancelRestore:true,noOverflow:true});assert.deepEqual(evidence.errors,[]);
 }catch(error){await page.screenshot({path:join(output,'failure-'+width+'.png')});throw error;}finally{await context.close();}
});
