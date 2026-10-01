import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';
let model,saves,submits,interruptSave,server,browser,base,setupWrites=[];
const setup={revision:1,enabled:false,admin:true,timezone:'Europe/Berlin',cadence:'weekly',first_period_start:'2034-03-06',coordinator_id:1,shopping_assignee_id:2,shopping_list_id:1,finalization_mode:'manual',creation:{day_offset:-3,time:'17:00'},response:{day_offset:-3,time:'18:00'},confirmation:{day_offset:-2,time:'18:00'},shopping:{day_offset:-1,time:'10:00'},members:[{id:1,display_name:'Ada'},{id:2,display_name:'Ben'}],lists:[{id:1,name:'Family groceries'}],execution_settings:{enabled:false}};
function reset(){saves=[];submits=[];interruptSave=true;model={cycle:{id:7,revision:1,state:'open',period_start:'2034-03-06',period_end:'2034-03-12',timezone:'Europe/Berlin',response_at:'2034-03-03T23:30:00Z',confirmation_at:'2034-03-04T19:00Z',shopping_at:'2034-03-05T09:00Z',finalization_mode:'manual'},revision:1,permissions:{write:true,review:false,submit:true,tasks:true,shopping:false},personal:{beneficiary_id:2,beneficiary_name:'Ada',submitted:false,requirements:[{meal_id:9,kind:'main',complete:true},{meal_id:9,kind:'decision',complete:true}]},occurrences:[{id:9,date:'2034-03-06',meal_type:'dinner',title:'Rice',recipe_id:4,planned_portions:1.1,cook_portions:2,menu_items:[{id:11,item_type:'entree',title:'Rice',recipe_id:4}],participants:[{user_id:2,display_name:'Ada',roles:['chooser','participant']}],choosers:[{user_id:2}],my_decision:{participation:'participating',choice_kind:'household',confirmed:true,portion_amount:1.1,menu_item_ids:[11]}}],tasks:[],destinations:[],adjustments:[],blockers:[]};}
const app=express();app.use(express.json());
app.use('/api/v1',(req,res)=>{
  if(req.path==='/kitchen/cycles/settings'){if(req.method==='GET')return res.json({data:setup});setupWrites.push(req.body);if(setupWrites.length===1)return res.status(503).json({error:'Interrupted settings acknowledgment'});return res.json({data:{...setup,...req.body.settings,revision:2}});}
  if(req.path==='/kitchen/cycles/preview')return res.json({data:{schedule:{period:{start:'2034-03-06',end:'2034-03-12'},creation:'2034-03-03T16:00:00Z',response:'2034-03-03T17:00:00Z',confirmation:'2034-03-04T17:00:00Z',shopping:'2034-03-05T09:00:00Z'},adoption_note:'Preview only'}});
  if(req.path==='/preferences')return res.json({data:{language:'en',date_format:'ymd'}});
  if(req.path==='/recipes')return res.json({data:[{id:4,title:'Rice'}]});
  if(req.path==='/kitchen/cycles/7'&&req.method==='GET')return res.json({data:model});
  if(req.path==='/kitchen/cycles/7/save'){
    saves.push(req.body);if(interruptSave){interruptSave=false;return res.status(503).json({error:'Interrupted acknowledgment'});}
    for(const c of req.body.changes){if(c.kind==='main')Object.assign(model.occurrences[0],{title:c.title,recipe_id:c.recipe_id});if(c.kind==='decision')Object.assign(model.occurrences[0].my_decision,c.decision);}
    model.revision++;return res.json({data:model});
  }
  if(req.path==='/kitchen/cycles/7/submit'){submits.push(req.body);model.personal.submitted=true;model.revision++;return res.json({data:model});}
  return res.json({data:[]});
});
test('setup draft and uncertain settings identity survive leaving and returning',async()=>{
  reset();setupWrites=[];const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)?r.continue():r.abort());
  try{await page.goto(`${base}/cycle-fixture?cycle=7`);await page.waitForFunction(()=>window.ready);const mount=()=>page.evaluate(async()=>{await(await import('/settings/pages/kitchen-cycle.js')).render(document.querySelector('#fixture'));});await mount();
    await page.$eval('[name="response_time"]',e=>{e.value='19:45';e.dispatchEvent(new Event('input',{bubbles:true}));});await mount();assert.equal(await page.$eval('[name="response_time"]',e=>e.value),'19:45');
    await page.click('[data-cycle-preview]');await page.waitForSelector('[data-preview] .cycle-card');await page.click('button[type="submit"]');await page.waitForSelector('[data-cycle-retry]:not([hidden])');assert.equal(setupWrites.length,1);
    await mount();await page.click('[data-cycle-retry]');await page.waitForFunction(()=>document.querySelector('[data-cycle-status]').textContent.length>0);assert.equal(setupWrites.length,2);assert.deepEqual(setupWrites[0],setupWrites[1]);
  }finally{await page.close();}
});
test('preserved Shopping discrepancy remains actionable after confirmation',async()=>{
  reset();model.cycle.state='finalized';model.permissions.shopping=true;model.result={requires_manual_review:true,preserved:[{reason:'manually_edited',shopping_item_id:42,name:'Rice',actual_quantity:7,coverage_quantity:0,demand_quantity:3,unit:'kg',additions_deferred:true}],grocery_runs:[],execution_task_ids:[]};const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)?r.continue():r.abort());
  try{await page.goto(`${base}/cycle-fixture?cycle=7&purpose=shopping`);await page.waitForFunction(()=>window.ready);const text=await page.$eval('#fixture',e=>e.textContent);assert.match(text,/Current Shopping quantity: 7/);assert.match(text,/Current demand: 3/);assert.match(text,/Additional demand is deferred/);assert.equal(await page.$eval('a[href*="highlight=42"]',e=>new URL(e.href).searchParams.get('cycle_return')),'7');}finally{await page.close();}
});
app.get('/cycle-fixture.js',(_req,res)=>res.type('text/javascript').send(`import {initI18n,setLocale} from '/i18n.js';await initI18n();await setLocale('en');(await import('/utils/timezone.js')).setDisplayTimeZone('America/Los_Angeles');window.yuvomi={navigate(){},isModuleDisabled:()=>false,user:{id:2,role:'member'}};window.mountCycle=async()=>{await(await import('/pages/meal-cycle.js')).render(document.querySelector('#fixture'),{user:window.yuvomi.user});};await window.mountCycle();window.ready=true;`));
app.get('/cycle-fixture',(_req,res)=>res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/meal-cycle.css"></head><body><main id="fixture"></main><script type="module" src="/cycle-fixture.js"></script></body></html>'));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(existsSync(edge)?edge:undefined),args:['--no-sandbox','--disable-background-networking']});});
test.after(async()=>{server?.closeAllConnections();await new Promise(r=>server?.close(r)||r());await browser?.close();});
for(const width of [390,1440])test(`visible draft, legacy amount, phase/back, uncertain retry and submit at ${width}px`,async()=>{
  reset();const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',req=>req.url().startsWith(base)?req.continue():req.abort());
  try{await page.setViewport({width,height:900});await page.goto(`${base}/cycle-fixture?cycle=7`);await page.waitForFunction(()=>window.ready);
    assert.ok(await page.$('.kitchen-tabs-bar'));const header=await page.$eval('.meal-cycle header',e=>e.textContent);assert.match(header,/04.*00:30/);assert.ok(!header.includes('15:30'));
    const preview=await page.evaluate(async()=>{const {schedulePreview}=await import('/settings/pages/kitchen-cycle.js');const {formatTime}=await import('/i18n.js');const instant='2034-03-03T23:30:00Z';return {html:schedulePreview({period:{start:'2034-03-06',end:'2034-03-12'},creation:instant,response:instant,confirmation:instant,shopping:instant},'Europe/Berlin'),old:formatTime(instant),zone:(await import('/utils/timezone.js')).displayTimeZone()};});assert.match(preview.html,/04.*00:30/);assert.ok(!preview.html.includes('15:30'));assert.equal(preview.old,'15:30');assert.equal(preview.zone,'America/Los_Angeles');
    assert.equal(await page.$$eval('[name="portion_amount"] option',options=>options.filter(o=>o.value).length),20);assert.equal(await page.$eval('[name="portion_amount"]',s=>s.value),'');
    await page.select('[name="choice"]','other');await page.type('[name="alternative_title"]','Toast');assert.equal(await page.$eval('[data-action="submit"]',b=>b.disabled),true);
    await page.click('[data-phase="shopping"]');await page.click('[data-phase="choices"]');assert.equal(await page.$eval('[name="alternative_title"]',i=>i.value),'Toast');
    await page.click('[data-action="save"]');await page.waitForSelector('[data-action="retry"]');assert.equal(saves.length,1);assert.ok(!('portion_amount' in saves[0].changes[0].decision));assert.equal(submits.length,0);
    await page.evaluate(()=>window.mountCycle());await page.click('[data-action="retry"]');await page.waitForFunction(()=>!document.querySelector('[data-action="retry"]'));
    assert.equal(saves.length,2);assert.deepEqual(saves[1],saves[0]);
    await page.$eval('[data-action="submit"]',b=>{b.click();b.click();});await page.waitForFunction(()=>document.querySelector('#fixture').textContent.includes('Submitted.'));assert.equal(submits.length,1);assert.deepEqual(errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  }finally{await page.close();}
});
