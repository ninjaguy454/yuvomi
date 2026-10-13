import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-trip-places-'));
Object.assign(process.env, { DB_PATH:join(folder,'synthetic.db'), SESSION_SECRET:'synthetic-trip-places-only', SESSION_SECURE:'false', BACKUP_ENABLED:'false', NODE_ENV:'development', LOG_LEVEL:'error' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), password = 'Synthetic-Places-Only-2031!';
const output = process.env.TRIP_PLACE_EVIDENCE || join(folder,'evidence');
mkdirSync(output,{recursive:true});
const evidence = {scope:'Disposable synthetic DB, real auth/Trip/Place routes; Google status/results/failures stubbed; loopback only; sandboxed Chrome',results:[],errors:[]};
let server, browser, origin, log='';
test.before(async()=>{
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'placeqa','Synthetic Parent',?,'admin','parent',1)").run(await hashPassword(password,4));
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(2,'placechild','Synthetic Child',?,'member','child',1)").run(await hashPassword(password,4));
  db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,args:['--disable-background-networking','--disable-component-update']});
  assert.ok(!browser.process().spawnargs.includes('--no-sandbox'));
  server=fork(new URL('./helpers/task-card-full-app-server.mjs',import.meta.url),[],{env:{...process.env,PORT:'0',TASK_CARD_BROWSER_SERVER_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>log=(log+chunk).slice(-18000));
  origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),50000);server.once('message',m=>{clearTimeout(timer);resolve(m.origin);});server.once('exit',code=>{clearTimeout(timer);reject(Error('Server exit '+code+' '+log));});});
});
test.after(async()=>{
  await browser?.close(); if(server?.exitCode===null){server.kill();await new Promise(resolve=>server.once('exit',resolve));}
  db.close(); writeFileSync(join(output,'results.json'),JSON.stringify(evidence,null,2)); writeFileSync(join(output,'server.log'),log);
});
const set=(page,selector,value)=>page.$eval(selector,(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
const press=async(page,selector)=>{await page.waitForSelector(selector,{visible:true});await page.focus(selector);await page.keyboard.press('Enter');};
async function session(width,{configured=true,username='placeqa'}={}) {
  const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(12000);
  await page.setViewport({width,height:width<500?844:1000,isMobile:width<500,hasTouch:width<500});
  const controls={mode:'result',searches:0,saves:0,posts:0,placeFailure:false,tripFailure:false,placeDelay:0,externalId:'synthetic-place-'+width};
  await page.setRequestInterception(true);
  page.on('request',async request=>{
    if(request.isInterceptResolutionHandled())return;
    const url=new URL(request.url()),path=url.pathname;
    if(url.origin!==origin||path==='/sw.js')return void request.abort();
    if(path==='/api/v1/planning/place-search/status')return void request.respond({status:200,contentType:'application/json',body:JSON.stringify({data:{configured,usage:{household_today:0},limits:{household_per_day:100}}})});
    if(path==='/api/v1/planning/place-search'&&request.method()==='POST'){
      controls.searches++; await new Promise(resolve=>setTimeout(resolve,120));
      return void request.respond({status:controls.mode==='error'?503:200,contentType:'application/json',body:JSON.stringify(controls.mode==='error'?{error:'Synthetic search unavailable'}:{data:controls.mode==='empty'?[]:[{external_place_id:controls.externalId,display_name:'Synthetic Hotel '+width,formatted_address:'123 Synthetic Lane',primary_type:'lodging',latitude:35,longitude:-78,attributions:[]}]})});
    }
    if(path.startsWith('/api/v1/planning/admin/places')&&request.method()==='POST'){
      controls.saves++;
      controls.onWrite?.(request);
      if(controls.holdWrites)await new Promise(resolve=>{controls.releaseWrite=resolve;});
      if(controls.placeDelay)await new Promise(resolve=>setTimeout(resolve,controls.placeDelay));
      if(controls.placeFailure)return void request.respond({status:403,contentType:'application/json',body:JSON.stringify({error:'Synthetic place permission denied'})});
    }
    if(path==='/api/v1/planning/admin/trips'&&request.method()==='POST'){
      controls.posts++;
      if(controls.tripFailure)return void request.respond({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic Trip validation failure'})});
    }
    return void request.continue();
  });
  page.on('pageerror',error=>evidence.errors.push(error.message));
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{delete Navigator.prototype.serviceWorker;localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-locale','en');});
  await page.goto(origin+'/login');
  assert.equal(await page.evaluate(async({username,password})=>(await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).status,{username,password}),200);
  await page.goto(origin+'/calendar?section=trips');
  return {context,page,controls};
}
async function startTrip(page,width) {
  await press(page,'#automation-add-trip');await page.waitForSelector('#automation-trip-form',{visible:true});
  await set(page,'[name="name"]','Synthetic Trip '+width);
  await set(page,'[name="starts_at"]','2031-07-10T09:00');await set(page,'[name="ends_at"]','2031-07-14T18:00');
  await page.click('[name="participant_id"][value="1"]');
}
async function search(page,field='destination_place_id') {
  await press(page,`[data-trip-find-place="${field}"]`);
  await page.waitForSelector('#trip-place-query',{visible:true});
  // Allow the shared modal's initial dirty snapshot to settle before editing.
  await new Promise(resolve=>setTimeout(resolve,200));
  await set(page,'#trip-place-query','Synthetic hotel');await set(page,'#trip-place-origin-mode','anywhere');
  await press(page,'#trip-place-search');
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'No page overflow');
  assert.equal(await page.$eval('.modal-overlay:not([inert]) .modal-panel',el=>el.scrollWidth>el.clientWidth+1),false,'No modal overflow');
}

for(const width of [1280,390,320])test('Trip searches, adds and persists linked Places at '+width,{timeout:120000},async()=>{
  const {context,page,controls}=await session(width);
  try{
    await startTrip(page,width);await noOverflow(page);
    await page.screenshot({path:join(output,'trip-'+width+'.png')});
    await search(page);await page.waitForSelector('#trip-place-results [data-use-place]');
    await noOverflow(page);await page.screenshot({path:join(output,'search-'+width+'.png')});
    await page.$eval('#trip-place-results [data-use-place]',button=>button.scrollIntoView({block:'center'}));
    await page.screenshot({path:join(output,'search-result-'+width+'.png')});
    await page.$eval('#trip-place-results [data-use-place]',button=>{button.click();button.click();});
    await page.waitForSelector('#trip-place-query',{hidden:true});
    const destination=await page.$eval('[name="destination_place_id"]',el=>Number(el.value));assert.ok(destination>0);
    assert.equal(await page.$eval('[name="name"]',el=>el.value),'Synthetic Trip '+width);
    assert.equal(controls.posts,0,'Selecting Place does not save Trip');
    await press(page,'[data-trip-add-place="lodging_place_id"]');await page.waitForSelector('#automation-place-form',{visible:true});
    await set(page,'#automation-place-form [name="name"]','Synthetic Cabin '+width);
    await set(page,'#automation-place-form [name="street_address"]','456 Synthetic Street');
    await noOverflow(page);await page.screenshot({path:join(output,'add-'+width+'.png')});
    // Submit synchronously twice: the real route must receive one write.
    await page.$eval('#automation-place-form',form=>{form.requestSubmit();form.requestSubmit();});
    await page.waitForSelector('#automation-place-form',{hidden:true});assert.equal(controls.saves,2,'One search save and one manual save');
    const lodging=await page.$eval('[name="lodging_place_id"]',el=>Number(el.value));assert.ok(lodging>0&&lodging!==destination);
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/planning/admin/trips'&&r.request().method()==='POST');
    await press(page,'[form="automation-trip-form"][type="submit"]');const saved=await response;assert.equal(saved.status(),201,await saved.text());const trip=(await saved.json()).data;
    assert.equal(trip.destination_place_id,destination);assert.equal(trip.lodging_place_id,lodging);
    assert.equal(db.prepare('SELECT destination_place_id FROM trip_plans WHERE id=?').get(trip.id).destination_place_id,destination);
    assert.ok(db.prepare('SELECT * FROM places WHERE id=?').get(lodging));
    await page.waitForSelector('#automation-trip-form',{hidden:true});await press(page,`[data-edit-trip="${trip.id}"]`);
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>Number(el.value)),destination);
    assert.equal(await page.$eval('[name="lodging_place_id"]',el=>Number(el.value)),lodging);
    evidence.results.push({width,search:true,manualAdd:true,draftPreserved:true,singleWrites:true,linkedPersistence:true,reopen:true,noOverflow:true});
  }catch(error){await page.screenshot({path:join(output,'failure-'+width+'.png')});throw error;}finally{await context.close();}
});

test('Trip picker empty/error/cancel/back/permission/validation and New Task reuse',{timeout:120000},async()=>{
  const {context,page,controls}=await session(390);
  try{
    controls.externalId='synthetic-edge-place';
    await startTrip(page,'edges');controls.mode='empty';await search(page);
    await page.waitForFunction(()=>document.querySelector('#trip-place-search-status')?.textContent.includes('No matching'));
    await page.screenshot({path:join(output,'empty-390.png')});
    assert.equal(controls.saves,0);assert.equal(controls.posts,0);
    await press(page,'[data-trip-search-add-place]');await page.waitForSelector('#automation-place-form',{visible:true});
    await press(page,'#shared-modal-overlay:not([inert]) [data-action="close-modal"]');await page.waitForSelector('#automation-place-form',{hidden:true});
    assert.equal(await page.$eval('[name="name"]',el=>el.value),'Synthetic Trip edges');
    controls.mode='error';await search(page);
    await page.waitForFunction(()=>document.querySelector('#trip-place-search-status')?.textContent.includes('Synthetic search unavailable'));
    assert.equal(await page.$eval('#trip-place-search',el=>el.disabled),false);
    await page.screenshot({path:join(output,'search-error-390.png')});
    // Browser Back closes the search child, preserving the Trip draft.
    await page.evaluate(()=>history.back());
    await page.waitForSelector('#confirm-modal-ok');await press(page,'#confirm-modal-ok');
    await page.waitForSelector('#trip-place-query',{hidden:true});
    assert.equal(await page.$eval('[name="name"]',el=>el.value),'Synthetic Trip edges');
    await press(page,'[data-trip-add-place="destination_place_id"]');await page.waitForSelector('#automation-place-form',{visible:true});
    await press(page,'#shared-modal-overlay:not([inert]) [data-action="close-modal"]');await page.waitForSelector('#automation-place-form',{hidden:true});
    assert.equal(controls.saves,0,'Cancel does not create Place');
    controls.mode='result';await search(page);
    await page.waitForSelector('#trip-place-results [data-use-place]');controls.placeFailure=true;
    await press(page,'#trip-place-results [data-use-place]');
    await page.waitForFunction(()=>document.querySelector('#trip-place-search-status')?.textContent.includes('Synthetic place permission denied'));
    assert.equal(await page.$eval('#trip-place-results [data-use-place]',el=>el.disabled),false);
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>el.value),'');
    controls.placeFailure=false;await press(page,'#trip-place-results [data-use-place]');await page.waitForSelector('#trip-place-query',{hidden:true});
    controls.tripFailure=true;await press(page,'[form="automation-trip-form"][type="submit"]');
    await page.waitForFunction(()=>document.body.textContent.includes('Synthetic Trip validation failure'));
    assert.equal(await page.$eval('[name="name"]',el=>el.value),'Synthetic Trip edges');
    assert.equal(await page.$eval('[form="automation-trip-form"][type="submit"]',el=>el.disabled),false);
    await page.goto(origin+'/tasks');await page.waitForSelector('#fab-new-task',{visible:true});await page.waitForNetworkIdle({idleTime:400,concurrency:2});await page.click('#fab-new-task');await page.waitForSelector('#task-form');await set(page,'#task-location-kind','google_place');
    await set(page,'#task-place-query','Synthetic hotel');await set(page,'#task-place-origin-mode','anywhere');await press(page,'#task-place-search');
    await page.waitForSelector('#task-place-results [data-use-place]');await press(page,'#task-place-results [data-use-place]');
    assert.equal(await page.$eval('#task-location-external-id',el=>el.value),controls.externalId);
    assert.match(await page.$eval('#task-place-selected',el=>el.textContent),/Synthetic Hotel/);
    evidence.results.push({empty:true,errorRetry:true,childBack:true,childCancel:true,permissionFailure:true,tripFailure:true,newTaskSharedPicker:true});
  }catch(error){await page.screenshot({path:join(output,'edge-failure.png')});writeFileSync(join(output,'edge-failure.json'),JSON.stringify(await page.evaluate(()=>({url:location.href,title:document.querySelector('.modal-overlay:not([inert]) .modal-panel__title')?.textContent,text:document.body.innerText.slice(-4500)})),null,2));throw error;}finally{await context.close();}
});

test('Search off still permits manual add; non-admin Trip access remains blocked',{timeout:45000},async()=>{
  const admin=await session(1280,{configured:false});
  try{await startTrip(admin.page,'off');await press(admin.page,'[data-trip-find-place="destination_place_id"]');await admin.page.waitForSelector('#trip-place-search');assert.equal(await admin.page.$eval('#trip-place-search',el=>el.disabled),true);assert.match(await admin.page.$eval('#trip-place-search-status',el=>el.textContent),/search is off/);}finally{await admin.context.close();}
  const member=await session(1280,{username:'placechild'});
  try{await member.page.waitForFunction(()=>document.body.textContent.includes('Household administrators'));assert.equal(await member.page.$('#automation-add-trip'),null);assert.equal(member.controls.posts,0);evidence.results.push({searchOff:true,tripAdminBoundary:true});}finally{await member.context.close();}
  assert.deepEqual(evidence.errors,[]);
});

test('Pending search/manual saves cannot select after Cancel or during discard; inactive manual Place rejected',{timeout:60000},async()=>{
  const {context,page,controls}=await session(390);
  let stage='start';
  try{
    await startTrip(page,'pending');controls.externalId='synthetic-pending-place';controls.holdWrites=true;
    await search(page);await page.waitForSelector('#trip-place-results [data-use-place]');
    stage='Google request';
    let requested=new Promise(resolve=>{controls.onWrite=resolve;});
    let responded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/planning/admin/places/from-google');
    await page.$eval('#trip-place-results [data-use-place]',button=>button.click());await requested;
    stage='Google Cancel';
    await page.click('.modal-overlay:not([inert]) .modal-panel__footer [data-action="close-modal"]');
    await page.waitForFunction(()=>document.querySelector('#confirm-modal-ok')||document.querySelector('.modal-panel--closing')||!document.querySelector('#trip-place-query'));
    controls.releaseWrite();await responded;
    stage='Google response';
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>el.value),'','Pending Google save does not change the Trip while discard is open');
    if(await page.$('#confirm-modal-ok'))await press(page,'#confirm-modal-ok');
    await page.waitForSelector('#trip-place-query',{hidden:true});
    await page.waitForSelector('.modal-overlay:not([inert]) #automation-trip-form',{visible:true});
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>el.value),'','Cancel preserves selection after pending Google save');
    await press(page,'[data-trip-add-place="destination_place_id"]');await page.waitForSelector('#automation-place-form',{visible:true});
    await new Promise(resolve=>setTimeout(resolve,200));
    stage='manual request';
    await set(page,'#automation-place-form [name="name"]','Synthetic pending manual');
    requested=new Promise(resolve=>{controls.onWrite=resolve;});
    responded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/planning/admin/places'&&r.request().method()==='POST');
    await page.$eval('#automation-place-form',form=>form.requestSubmit());await requested;
    stage='manual Cancel';
    await page.click('.modal-overlay:not([inert]) .modal-panel__footer [data-action="close-modal"]');await page.waitForSelector('#confirm-modal-ok');controls.releaseWrite();await responded;
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>el.value),'','Discard prompt does not mutate Trip selection');
    await press(page,'#confirm-modal-ok');await page.waitForSelector('#automation-place-form',{hidden:true});
    await page.waitForSelector('.modal-overlay:not([inert]) #automation-trip-form',{visible:true});
    controls.holdWrites=false;
    stage='inactive validation';
    await press(page,'[data-trip-add-place="destination_place_id"]');await page.waitForSelector('#automation-place-form',{visible:true});
    await set(page,'#automation-place-form [name="name"]','Synthetic inactive');await page.$eval('#automation-place-form [name="active"]',el=>{el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
    const saves=controls.saves;await press(page,'[form="automation-place-form"][type="submit"]');
    await page.waitForFunction(()=>document.body.textContent.includes('Choose an active Place for this Trip.'));
    assert.equal(controls.saves,saves,'Inactive Place rejected before saving');
    assert.equal(await page.$eval('[name="destination_place_id"]',el=>el.value),'');
    evidence.results.push({pendingGoogleCancel:true,pendingManualDiscard:true,inactiveManualValidation:true});
  }catch(error){writeFileSync(join(output,'race-failure.json'),JSON.stringify({stage,saves:controls.saves,state:await page.evaluate(()=>({text:document.body.innerText.slice(-4500)}))},null,2));throw error;}finally{controls.releaseWrite?.();await context.close();}
});

test('Keep Editing completes one pending manual save and stale Google results reuse the existing Place',{timeout:60000},async()=>{
  const {context,page,controls}=await session(390);
  try{
    await startTrip(page,'keep');controls.holdWrites=true;
    await press(page,'[data-trip-add-place="destination_place_id"]');await page.waitForSelector('#automation-place-form',{visible:true});await new Promise(resolve=>setTimeout(resolve,200));
    await set(page,'#automation-place-form [name="name"]','Synthetic keep once');
    const requested=new Promise(resolve=>{controls.onWrite=resolve;});
    const responded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/planning/admin/places'&&r.request().method()==='POST');
    await page.$eval('#automation-place-form',form=>{form.requestSubmit();form.requestSubmit();});await requested;
    await page.click('.modal-overlay:not([inert]) .modal-panel__footer [data-action="close-modal"]');await page.waitForSelector('#confirm-modal-cancel');
    controls.releaseWrite();await responded;
    assert.equal(await page.$eval('[form="automation-place-form"][type="submit"]',el=>el.disabled),true,'Completed save stays pending beneath discard prompt');
    await page.$eval('#automation-place-form',form=>form.requestSubmit());
    await press(page,'#confirm-modal-cancel');await page.waitForSelector('.modal-overlay:not([inert]) #automation-trip-form',{visible:true});
    assert.equal(controls.saves,1);assert.equal(db.prepare("SELECT count(*) AS count FROM places WHERE name='Synthetic keep once'").get().count,1);
    assert.ok(await page.$eval('[name="destination_place_id"]',el=>Number(el.value)));
    controls.holdWrites=false;controls.externalId='synthetic-stale-result';
    const existing=await page.evaluate(async externalId=>{const {api}=await import('/api.js');return (await api.post('/planning/admin/places/from-google',{external_place_id:externalId,name:'Synthetic duplicate existing',type:'custom'})).data;},controls.externalId);
    await search(page,'lodging_place_id');await page.waitForSelector('#trip-place-results [data-use-place]');
    await page.$eval('#trip-place-results [data-use-place]',button=>button.click());await page.waitForSelector('.modal-overlay:not([inert]) #automation-trip-form',{visible:true});
    assert.equal(await page.$eval('[name="lodging_place_id"]',el=>Number(el.value)),existing.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM places WHERE external_place_id=?').get(controls.externalId).count,1);
    evidence.results.push({keepEditing:true,oneManualWrite:true,googleConflictReused:true});
  }finally{controls.releaseWrite?.();await context.close();}
});
