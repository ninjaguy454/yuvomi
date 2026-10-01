// Candidate's actual server/auth/session/CSRF/static modules; synthetic memory DB.
// Repetitive 20-slot answers use canonical services. Representative meal uses UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import puppeteer from 'puppeteer';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {weeklyFixture,weekSettings,seedWeekAnswers,readWeek,saveWeek,submitWeek,weekStart} from './meal-cycle-week-fixture.js';
import {registerMealCycleTaskLifecycle} from '../server/services/meal-cycles.js';
import {runMealCycleScheduler} from '../server/services/meal-cycle-scheduler.js';
import {_setTestDatabase} from '../server/db.js';
import {hashPassword} from '../server/utils/password.js';

process.env.PORT='0';process.env.LOG_LEVEL='error';
let server,browser,origin,d,passwordHash,interruptNextSave=false;
let lastJourneyStarted=0;
const retiredDatabases=[];
const password='Synthetic-Week-Only-2034!';
const output=new URL('../.superpowers/sdd/2026-10-01-kitchen-meal-cycle/task8-browser/',import.meta.url);
mkdirSync(output,{recursive:true});
const evidence=[];
test.before(async()=>{
  passwordHash=await hashPassword(password);d=weeklyFixture({settings:false,passwordHash});_setTestDatabase(d);
  registerMealCycleTaskLifecycle(); // index listen callback is intentionally suppressed.
  const listen=express.application.listen;
  express.application.listen=function(){const app=this;server=http.createServer((req,res)=>{if(req.url==='/sw.js'){res.writeHead(404);res.end();return;}app(req,res);});server.listen(0,'127.0.0.1');return server;};
  try{await import('../server/index.js');}finally{express.application.listen=listen;}
  if(!server.listening)await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({headless:true,protocolTimeout:30000,args:['--disable-background-networking']});
});
test.after(async()=>{
  writeFileSync(new URL('results.json',output),JSON.stringify(evidence,null,2));
  await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));d?.close();for(const database of retiredDatabases)database.close();
});
async function click(page,selector){
  // Chrome suspends animation frames in a background tab. Real pointer work
  // must activate the tab before the hit-target readiness frames.
  await page.bringToFront();
  await page.waitForSelector(selector,{visible:true});await page.$eval(selector,e=>e.scrollIntoView({block:'center',behavior:'instant'}));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const target=await page.$eval(selector,e=>{const b=e.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2,hit=document.elementFromPoint(x,y),scroll=document.querySelector('.app-content');return {hit:e===hit||e.contains(hit),x,y,rect:{top:b.top,bottom:b.bottom,left:b.left,right:b.right},hitElement:hit?{tag:hit.tagName,class:hit.className}:null,scroll:scroll?{top:scroll.scrollTop,height:scroll.clientHeight,content:scroll.scrollHeight}:null};});
  assert.ok(target.hit,`pointer target is covered or offscreen: ${selector} ${JSON.stringify(target)}`);await page.mouse.click(target.x,target.y);
}
async function set(page,selector,value){await page.waitForSelector(selector);await page.$eval(selector,(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function until(check,message){const deadline=Date.now()+20000;while(Date.now()<deadline){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error(message);}
async function navigate(page,path,ready){await page.evaluate(path=>window.yuvomi.navigate(path),path);await page.waitForSelector(ready,{visible:true});}
async function capture(page,name){await page.screenshot({path:fileURLToPath(new URL(name+'.png',output)),fullPage:true});}
async function openPlate(page,card){if(!await page.$eval(`${card} [data-personal-plate]`,e=>e.open))await click(page,`${card} [data-personal-plate] > summary`);}
async function visitWholeWeek(page,id){
  const dates=await page.$$eval('[data-cycle-day]',es=>es.map(e=>e.dataset.cycleDay));assert.equal(dates.length,7);const seen=[];
  for(const date of dates){await click(page,`[data-cycle-day="${date}"]`);assert.equal(await page.$eval(`[data-cycle-day="${date}"]`,e=>e.getAttribute('aria-pressed')),'true');assert.equal(await page.$$eval('.cycle-day',es=>es.length),1);assert.equal(await page.$$eval('.cycle-slot',es=>es.length),3);seen.push(...await page.$$eval('[data-meal]',es=>es.map(e=>Number(e.dataset.meal))));}
  assert.deepEqual(seen.sort((a,b)=>a-b),readWeek(d,id,2).occurrences.map(m=>m.id).sort((a,b)=>a-b));await click(page,`[data-cycle-day="${weekStart}"]`);
}
async function rateWindow(){
  // All synthetic households share one loopback IP and the actual app's
  // 300/minute API bucket. Keep accelerated independent journeys apart.
  while(lastJourneyStarted&&Date.now()-lastJourneyStarted<61000){
    const remaining=61000-(Date.now()-lastJourneyStarted);
    console.info('HOUSEHOLD_RATE_WINDOW',Math.ceil(remaining/1000),'seconds');
    await new Promise(resolve=>setTimeout(resolve,Math.min(remaining,30000)));
  }
  lastJourneyStarted=Date.now();
}
async function observedPage(context,width,record){
  const page=await context.newPage();page.setDefaultTimeout(20000);await page.setViewport({width,height:1000});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{localStorage.setItem('yuvomi-lang','en');localStorage.setItem('yuvomi-tasks-view','list');});
  const started=new Map();page.on('pageerror',e=>record.errors.push(e.message));
  page.on('request',r=>{started.set(r,performance.now());if(r.method()!=='GET'&&r.url().includes('/kitchen/cycles/'))record.writes.push({path:new URL(r.url()).pathname,body:JSON.parse(r.postData()||'{}')});});
  page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.includes('/kitchen/cycles')&&r.request().method()==='GET'||path.endsWith('/kitchen/cycles/preview'))record.timings.push({path,status:r.status(),ms:Math.round((performance.now()-started.get(r.request()))*10)/10});if(r.status()>=400)record.httpErrors.push({path,status:r.status()});});
  await page.setRequestInterception(true);page.on('request',async r=>{
    const url=new URL(r.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin)return r.abort();if(url.pathname==='/sw.js')return r.abort();
    if(interruptNextSave&&r.method()==='POST'&&url.pathname.endsWith('/save')){
      interruptNextSave=false;
      try{
        // Proxy the exact authenticated request to the real route, then lose
        // its successful acknowledgment. Cookies/CSRF stay private in memory.
        const cookies=await page.cookies();const response=await fetch(r.url(),{method:r.method(),body:r.postData(),headers:{...r.headers(),cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
        assert.equal(response.status,200,'proxied save must commit before dropping its acknowledgment');await response.arrayBuffer();record.lostAcknowledgment={committedStatus:200,path:url.pathname};
      }catch(error){record.errors.push(error.message);}return r.abort('failed');
    }
    return r.continue();
  });
  return page;
}
async function session(name,width,record){
  const context=await browser.createBrowserContext(),page=await observedPage(context,width,record);
  await page.goto(origin+'/login');await set(page,'#username',name);await set(page,'#password',password);await click(page,'#auth-btn');await page.waitForFunction(()=>location.pathname!=='/login'&&typeof window.yuvomi?.navigate==='function');await page.waitForSelector('a.nav-item[href="/meals"]');await page.waitForNetworkIdle({idleTime:500});
  return {page,context};
}
async function setup(page,mode){
  await navigate(page,'/settings/modules/kitchen','[data-cycle-settings]');
  assert.equal(await page.$eval('[name="enabled"]',e=>e.checked),false);assert.equal(await page.$eval('[name="finalization_mode"]',e=>e.value),'manual');
  await page.select('[name="cadence"]','weekly');await set(page,'[name="first_period_start"]',weekStart);
  for(const key of ['coordinator_id','shopping_assignee_id','shopping_list_id'])await page.select(`[name="${key}"]`,'1');
  for(const key of ['creation','response','confirmation','shopping']){await page.select(`[name="${key}_day_offset"]`,String(weekSettings()[key].day_offset));await set(page,`[name="${key}_time"]`,weekSettings()[key].time);}
  await page.select('[name="finalization_mode"]',mode);await click(page,'[name="enabled"]');await click(page,'[data-cycle-preview]');await page.waitForSelector('[data-preview] .cycle-card');
  await click(page,'[data-cycle-settings] button[type="submit"]');await until(()=>d.prepare('SELECT enabled FROM meal_cycle_settings').get()?.enabled===1,'setup not saved');
  await page.waitForFunction(()=>document.querySelector('[data-cycle-status]')?.textContent.length>0);
  await click(page,'details:has([data-cycle-ensure]) > summary');await click(page,'[data-cycle-ensure]');await page.waitForSelector('[data-meal]');
  // Cycle creation launches navigation from an event handler. Cards appear
  // before the router's final render work releases its navigation guard.
  await page.waitForNetworkIdle({idleTime:500});
  return d.prepare('SELECT id FROM meal_cycles').get().id;
}
async function submitUI(page,id,person){await click(page,'[data-action="submit"]');await until(()=>d.prepare("SELECT t.status FROM meal_cycle_task_links l JOIN tasks t ON t.id=l.task_id WHERE l.cycle_id=? AND l.purpose='personal' AND l.beneficiary_id=?").get(id,person)?.status==='done','personal submission not completed');await page.waitForFunction(()=>document.querySelector('[data-choice-actions] [role="status"]')?.textContent.includes('Submitted'));}

for(const width of [1440,390])test(`authenticated 21-slot household journey, two tabs, lost acknowledgment, Shopping/Pantry and cooking at ${width}px`,{timeout:240000},async()=>{
  await rateWindow();
  if(d){retiredDatabases.push(d);d=weeklyFixture({settings:false,passwordHash});_setTestDatabase(d);}
  const record={width,mode:'manual',scope:'Windows Chrome responsive emulation; synthetic in-memory DB; actual auth and routes',errors:[],httpErrors:[],writes:[],timings:[],steps:[]};evidence.push(record);
  let coordinator,member,second,phase='login';
  try{
    coordinator=await session('Week Coordinator',width,record);member=await session('Week Member',width,record);
    const principal=await member.page.evaluate(async()=>{const r=await fetch('/api/v1/auth/me');const {user}=await r.json();return {role:user.role,family_role:user.family_role};});
    assert.deepEqual(principal,{role:'member',family_role:'child'});record.principal=principal;
    phase='setup';const id=await setup(coordinator.page,'manual');record.steps.push('actual setup preview/save/create');
    const meal=seedWeekAnswers(d,id,{skipRepresentative:true});record.canonicalSeed={savedSlots:20,representativeMealId:meal};
    phase='populated list/preview';await navigate(coordinator.page,'/meals','a[href*="/meals?cycle="]');
    await navigate(coordinator.page,'/settings/modules/kitchen','[data-cycle-settings]');await click(coordinator.page,'[data-cycle-preview]');await coordinator.page.waitForSelector('[data-preview] .cycle-card');record.steps.push('real list and setup preview requests against populated 21-slot week');
    // Other diners' representative answers are canonical; member's main/personal UI is tested.
    await navigate(member.page,`/tasks?open=${readWeek(d,id,2).personal.task_id}` ,'.task-detail__linked-action');
    phase='generic completion guard';await member.page.select('[aria-label="Task status"]','done');
    await until(()=>record.httpErrors.some(r=>r.status===409),'generic Task completion must be rejected before submission');assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(readWeek(d,id,2).personal.task_id).status,'open');
    await member.page.waitForSelector('.toast',{visible:true});await member.page.waitForSelector('.toast',{hidden:true});
    await click(member.page,'.task-detail__linked-action');await member.page.waitForSelector('[data-meal]');
    await visitWholeWeek(member.page,id);record.steps.push('ordinary member Task opens all 21 slots through seven day buttons; generic completion guarded');
    await member.page.bringToFront();await member.page.$eval('.meal-cycle',e=>e.scrollIntoView({block:'start'}));await capture(member.page,`${width}-choices-overview`);
    const card=`[data-meal="${meal}"]`;phase='main/personal draft';assert.match(await member.page.$eval('[data-chooser-banner]',e=>e.textContent),/your turn to pick|dinner/i);await click(member.page,`[data-chooser-banner] [data-pick-meal="${meal}"]`);
    await member.page.keyboard.press('Tab');assert.equal(await member.page.evaluate(()=>document.activeElement.dataset.pickRecipe),'901');await member.page.keyboard.press('Space');assert.equal(await member.page.$eval('[data-pick-recipe="901"]',e=>e.getAttribute('aria-pressed')),'true');await member.page.keyboard.press('Tab');assert.equal(await member.page.evaluate(()=>document.activeElement.dataset.pickRecipe),'902');await member.page.keyboard.down('Shift');await member.page.keyboard.press('Tab');await member.page.keyboard.up('Shift');assert.equal(await member.page.evaluate(()=>document.activeElement.dataset.pickRecipe),'901');await capture(member.page,`${width}-shared-picker`);await member.page.focus('[data-action="back-from-pick"]');await member.page.keyboard.press('Enter');
    await click(member.page,`${card} [data-pick-meal="${meal}"]`);await click(member.page,'[data-shared-picker] details > summary');await member.page.select('[name="main_recipe"]','');await member.page.type('[name="main_title"]','Canceled shared custom draft');await member.page.focus('[data-action="close-picker"]');await member.page.keyboard.press('Enter');assert.equal(await member.page.$eval(`${card} h4`,e=>e.textContent),'Week rice');record.steps.push('actual Tab/Shift+Tab/Space recipe selection and Enter back/cancel preserve prior shared pick');
    await openPlate(member.page,card);await member.page.select(`${card} [name="portion_amount"]`,'1.50');
    await member.page.$eval(card,e=>e.scrollIntoView({block:'start'}));await capture(member.page,`${width}-choices-main`);
    assert.equal(await member.page.$$eval(`${card} [name="portion_amount"] option`,es=>es.filter(e=>e.value).length),20);
    assert.equal(await member.page.$eval('[data-action="submit"]',e=>e.disabled),true);
    await click(member.page,'[data-phase="shopping"]');await click(member.page,'[data-phase="choices"]');assert.equal(await member.page.$eval(`${card} [name="portion_amount"]`,e=>e.value),'1.50');
    phase='interrupted save';interruptNextSave=true;await click(member.page,'[data-action="save"]');await member.page.waitForSelector('[data-action="retry"]:not([disabled])');
    const writesBefore=record.writes.filter(w=>w.path.endsWith('/save'));assert.equal(writesBefore.length,1);
    const identity=()=>member.page.evaluate(async()=>({auth:(await import('/utils/device-context.js')).authenticationSnapshot(),revision:(await import('/utils/session-lifecycle.js')).sessionRevision(),url:location.href}));
    record.beforeReturn=await identity();
    await navigate(member.page,'/pantry','.pantry-page');record.atPantry=await identity();await navigate(member.page,`/meals?cycle=${id}&beneficiary=2`,'[data-meal]');record.afterReturn=await identity();assert.deepEqual(record.afterReturn.auth,record.beforeReturn.auth);assert.equal(record.afterReturn.revision,record.beforeReturn.revision);await member.page.waitForSelector('[data-action="retry"]');await click(member.page,'[data-action="retry"]');await member.page.waitForFunction(()=>!document.querySelector('[data-action="retry"]')&&document.querySelector('[data-meal]'));
    const saves=record.writes.filter(w=>w.path.endsWith('/save'));assert.equal(saves.length,2);assert.deepEqual(saves[0].body,saves[1].body);assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_requests WHERE operation='person.save' AND request_key=?").get(saves[0].body.request_key).n,1);assert.equal(record.lostAcknowledgment?.committedStatus,200);record.steps.push('committed save loses acknowledgment; SPA return retries exact identity once');
    for(const person of [1,3])saveWeek(d,id,person,[{meal_id:meal,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true,portion_amount:1}}],`representative-other-${person}`);
    // Refresh after canonical other-person answers, then real own Submit.
    await navigate(member.page,'/pantry','.pantry-page');await navigate(member.page,`/meals?cycle=${id}&beneficiary=2`,'[data-meal]');phase='submit';await submitUI(member.page,id,2);
    phase='post-submit edit/two tabs';second=await observedPage(member.context,width,record);await second.goto(`${origin}/meals?cycle=${id}&beneficiary=2`);await second.waitForSelector('[data-meal]');
    await openPlate(member.page,card);await member.page.select(`${card} [name="choice"]`,'other');await member.page.select(`${card} [name="alternative_recipe"]`,'902');await member.page.select(`${card} [name="portion_amount"]`,'0.75');await click(member.page,'[data-action="save"]');await until(()=>readWeek(d,id,2).occurrences.find(m=>m.id===meal).my_decision?.portion_amount===0.75,'edited backup missing');
    await openPlate(second,card);await second.select(`${card} [name="portion_amount"]`,'0.50');await click(second,'[data-action="save"]');await second.waitForSelector('[role="alert"]');assert.match(await second.$eval('[role="alert"]',e=>e.textContent),/changed|stale|revision/i);assert.equal(readWeek(d,id,2).occurrences.find(m=>m.id===meal).my_decision.portion_amount,0.75);await click(second,'[data-action="reload"]');await second.waitForFunction(()=>!document.querySelector('[role="alert"]'));assert.equal(await second.$eval(`${card} [name="portion_amount"]`,e=>e.value),'0.50');await second.close();second=null;
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(readWeek(d,id,2).personal.task_id).status,'done');record.steps.push('submitted own backup edit stays complete; stale second tab rejected and draft retained');
    submitWeek(d,id,[3]);phase='coordinator submit/review';await navigate(coordinator.page,`/meals?cycle=${id}`,'[data-meal]');await submitUI(coordinator.page,id,1);await click(coordinator.page,'[data-phase="review"]');await coordinator.page.waitForSelector('[data-action="confirm"]:not([disabled])');
    const beforeBadge=await coordinator.page.evaluate(()=>{const scroll=document.querySelector('.app-content');scroll.scrollTop=1800;return scroll.scrollTop;});assert.ok(beforeBadge>800,'review must be scrolled below the toolbar');const badgeResponse=coordinator.page.waitForResponse(r=>r.url().includes('/kitchen/summary')&&r.status()===200);await coordinator.page.evaluate(async()=>{(await import('/utils/kitchen-tabs.js')).refreshKitchenBadges();});await badgeResponse;await coordinator.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await coordinator.page.$eval('.app-content',e=>e.scrollTop),beforeBadge,'delayed Kitchen badge refresh must retain vertical review position');
    assert.equal(await coordinator.page.$$eval('.cycle-review-meals .cycle-day',es=>es.length),7);const reviewDays=await coordinator.page.$$('.cycle-review-meals .cycle-day');let reviewedCount=0;
    for(let i=0;i<reviewDays.length;i++){const selector=`.cycle-review-meals .cycle-day:nth-child(${i+1})`;if(!await coordinator.page.$eval(selector,e=>e.open))await click(coordinator.page,`${selector} > summary`);reviewedCount+=await coordinator.page.$$eval(`${selector} .cycle-card`,es=>es.length);if(i>0)await click(coordinator.page,`${selector} > summary`);}assert.equal(reviewedCount,21);assert.match(await coordinator.page.$eval('.cycle-review-meals',e=>e.textContent),/Week toast/);await coordinator.page.$eval('.meal-cycle',e=>e.scrollIntoView({block:'start'}));await capture(coordinator.page,`${width}-household-review`);
    phase='confirmation';await click(coordinator.page,'[data-action="confirm"]');await coordinator.page.waitForSelector('a[href*="/shopping?list="]');assert.equal(d.prepare('SELECT state FROM meal_cycles WHERE id=?').get(id).state,'finalized');
    assert.deepEqual(d.prepare('SELECT name,quantity FROM shopping_items ORDER BY name').all(),[{name:'Week bread',quantity:'1 pcs'},{name:'Week rice packs',quantity:'62 pcs'}]);record.steps.push('review latest 21-slot responses and confirm exact groceries');
    phase='adjustment/cancel/back';await click(member.page,'[data-phase="shopping"]');await click(member.page,'[data-phase="choices"]');
    // Remount to current finalized state, create and cancel a reviewed proposal via member/coordinator UI.
    await navigate(member.page,'/pantry','.pantry-page');await navigate(member.page,`/meals?cycle=${id}&beneficiary=2`,'[data-meal]');await openPlate(member.page,card);await member.page.select(`${card} [name="portion_amount"]`,'1.25');await click(member.page,'[data-action="save"]');await member.page.waitForSelector('[data-proposal]');
    const proposal=d.prepare("SELECT id FROM meal_cycle_adjustments WHERE cycle_id=? AND status='pending' ORDER BY id DESC").get(id).id;
    await navigate(coordinator.page,`/meals?cycle=${id}&proposal=${proposal}&purpose=review`,'[data-action="cancel"]');await click(coordinator.page,'[data-action="cancel"]');await until(()=>d.prepare('SELECT status FROM meal_cycle_adjustments WHERE id=?').get(proposal).status==='canceled','proposal cancellation missing');assert.equal(readWeek(d,id,2).occurrences.find(m=>m.id===meal).my_decision.portion_amount,0.75);record.steps.push('reviewed adjustment cancelled; confirmed portion and outputs retained');
    phase='Shopping purchase';await click(coordinator.page,'[data-phase="shopping"]');await click(coordinator.page,'a[href*="/shopping?list="]');await coordinator.page.waitForSelector('[data-action="toggle-item"]');
    for(const item of d.prepare('SELECT id FROM shopping_items ORDER BY id').all()){await click(coordinator.page,`[data-action="toggle-item"][data-id="${item.id}"]`);await until(()=>d.prepare('SELECT is_checked FROM shopping_items WHERE id=?').get(item.id).is_checked,'purchase not checked');}
    assert.equal(d.prepare("SELECT t.status FROM meal_cycle_task_links l JOIN tasks t ON t.id=l.task_id WHERE cycle_id=? AND purpose='shopping'").get(id).status,'open');
    phase='Pantry';const buttons=await coordinator.page.$$('button');let pantryButton;for(const button of buttons)if(/to pantry/i.test(await button.evaluate(e=>e.textContent)))pantryButton=button;assert.ok(pantryButton);await pantryButton.evaluate(e=>e.scrollIntoView({block:'center'}));await pantryButton.click();await click(coordinator.page,'#pantry-transfer-confirm');await until(()=>d.prepare('SELECT count(*) n FROM pantry_items').get().n===2,'Pantry transfer missing');assert.deepEqual(d.prepare('SELECT name,quantity,unit FROM pantry_items ORDER BY name').all(),[{name:'Week bread',quantity:1,unit:'pcs'},{name:'Week rice packs',quantity:62,unit:'pcs'}]);await navigate(coordinator.page,'/pantry','.pantry-page');await capture(coordinator.page,`${width}-pantry`);record.steps.push('purchase check separate from Shopping Task; exact purchased quantities reach Pantry');
    phase='cooking Task';const cooking=d.prepare("SELECT e.task_id FROM meal_execution_tasks e JOIN tasks t ON t.id=e.task_id WHERE e.meal_id=? AND e.role='cooking' AND t.assigned_to=1").get(meal).task_id;
    await navigate(coordinator.page,`/tasks?open=${cooking}&cycle_return=${id}`,'[aria-label="Task status"]');await coordinator.page.select('[aria-label="Task status"]','in_progress');await until(()=>d.prepare('SELECT status FROM tasks WHERE id=?').get(cooking).status==='in_progress','cooking not started');await coordinator.page.waitForSelector('[aria-label="Task status"]:not([disabled])');await coordinator.page.select('[aria-label="Task status"]','done');await until(()=>d.prepare('SELECT status FROM tasks WHERE id=?').get(cooking).status==='done','cooking not completed');await capture(coordinator.page,`${width}-cooking`);assert.equal(d.prepare('SELECT count(*) n FROM task_completions WHERE task_id=?').get(cooking).n,1);record.steps.push('actual assigned cooking Task started and completed once');
    assert.deepEqual(record.errors,[]);assert.ok(record.httpErrors.every(r=>r.status===409&&(/\/tasks\//.test(r.path)||r.path.endsWith('/save'))),JSON.stringify(record.httpErrors));record.status='passed';
  }catch(error){record.status='failed';record.failure={phase,message:error.message};console.error('HOUSEHOLD_FAILURE',width,record.failure);if(coordinator?.page)await capture(coordinator.page,`${width}-failure-coordinator`).catch(()=>{});if(member?.page)await capture(member.page,`${width}-failure-member`).catch(()=>{});throw error;
  }finally{writeFileSync(new URL('results.json',output),JSON.stringify(evidence,null,2));await second?.close();await member?.context.close();await coordinator?.context.close();}
});

test('authenticated automatic blocked week recovers through actual choices and review UI',{timeout:180000},async()=>{
  await rateWindow();
  retiredDatabases.push(d);d=weeklyFixture({settings:false,passwordHash});_setTestDatabase(d);const record={width:390,mode:'automatic',errors:[],httpErrors:[],writes:[],timings:[],steps:[]};evidence.push(record);let coordinator,member;
  try{coordinator=await session('Week Coordinator',390,record);member=await session('Week Member',390,record);const id=await setup(coordinator.page,'automatic');runMealCycleScheduler(d,{now:'2034-03-04T19:00:00Z'});runMealCycleScheduler(d,{now:'2034-03-04T19:01:00Z'});
    await navigate(coordinator.page,'/pantry','.pantry-page');await navigate(coordinator.page,`/meals?cycle=${id}&purpose=review`,'[data-action="confirm"]');assert.match(await coordinator.page.$eval('.meal-cycle header',e=>e.textContent),/blocked/i);assert.equal(d.prepare('SELECT count(*) n FROM shopping_items').get().n,0);assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='automatic_followup'").get().n,1);
    const meal=seedWeekAnswers(d,id,{skipRepresentative:true});await navigate(member.page,`/meals?cycle=${id}`,'[data-meal]');const card=`[data-meal="${meal}"]`;await click(member.page,`[data-chooser-banner] [data-pick-meal="${meal}"]`);await click(member.page,'[data-pick-recipe="901"]');await click(member.page,'[data-action="back-from-pick"]');await openPlate(member.page,card);await member.page.select(`${card} [name="portion_amount"]`,'1.00');await click(member.page,'[data-action="save"]');await until(()=>readWeek(d,id,2).occurrences.find(m=>m.id===meal).shared_choice_active,'main missing');
    for(const person of [1,3])saveWeek(d,id,person,[{meal_id:meal,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,select_shared_main:true,portion_amount:1}}],`automatic-other-${person}`);
    await navigate(member.page,'/pantry','.pantry-page');await navigate(member.page,`/meals?cycle=${id}`,'[data-action="submit"]');await submitUI(member.page,id,2);submitWeek(d,id,[3]);await navigate(coordinator.page,'/pantry','.pantry-page');await navigate(coordinator.page,`/meals?cycle=${id}`,'[data-action="submit"]');await submitUI(coordinator.page,id,1);await click(coordinator.page,'[data-phase="review"]');await coordinator.page.waitForSelector('[data-action="confirm"]:not([disabled])');
    assert.equal(runMealCycleScheduler(d,{now:'2034-03-05T08:00:00Z'}).finalized.length,1);assert.equal(runMealCycleScheduler(d,{now:'2034-03-05T08:01:00Z'}).finalized.length,0);await navigate(coordinator.page,'/pantry','.pantry-page');await navigate(coordinator.page,`/meals?cycle=${id}&purpose=shopping`,'a[href*="/shopping?list="]');assert.match(await coordinator.page.$eval('.meal-cycle header',e=>e.textContent),/confirmed/i);assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_results WHERE kind='finalization'").get().n,1);assert.equal(d.prepare('SELECT count(*) n FROM meal_execution_tasks').get().n,21);assert.deepEqual(d.prepare('SELECT name,quantity FROM shopping_items').all(),[{name:'Week rice packs',quantity:'63 pcs'}]);await capture(coordinator.page,'390-automatic-recovered');assert.deepEqual(record.errors,[]);assert.deepEqual(record.httpErrors,[]);record.status='passed';record.steps=['automatic blocked attempt shown; no partial groceries; one follow-up','representative main/portions/save/submit through member UI','coordinator reviews actual populated week; deterministic scheduler recovers once'];
  }catch(error){record.status='failed';record.failure=error.message;console.error('AUTOMATIC_FAILURE',error.message);await capture(coordinator.page,'automatic-failure').catch(()=>{});throw error;}finally{writeFileSync(new URL('results.json',output),JSON.stringify(evidence,null,2));await member?.context.close();await coordinator?.context.close();}
});
