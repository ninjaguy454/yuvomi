import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';
const members=[{id:1,display_name:'Grace'},{id:2,display_name:'Eleanor'},{id:3,display_name:'Frankie'}];
const group={id:7,name:'Kids',members};
const plan={id:1,name:'Weeknight dinner',status:'active',current_revision:1,home_enabled:true,
 rules:[{id:9,rule_key:'dinner-monday',slot_group_key:'dinner',weekday:0,meal_type:'dinner',policy:'round_robin',
  rotation_group:'legacy-dinner',cook_rotation_group:'legacy-cooks',supervisor_rotation_group:'legacy-supervisors',
  cook_strategy:'round_robin',supervisor_strategy:'round_robin',chooser_rotation_group_id:7,cook_rotation_group_id:7,
  participant_ids:[],active:true}],revisions:[]};
const styles=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag])=>tag).join('');
const app=express();app.use(express.json());let payload;
app.use('/api/v1',(req,res)=>{
 if(req.path==='/preferences')return res.json({data:{language:'en',date_format:'mdy'}});
 if(req.path==='/meals/planning')return res.json({data:{members,timing_defaults:[],slots:[]}});
 if(['/meals/week-model','/meals/status'].includes(req.path))return res.json({data:{members,contexts:[],occurrences:[]}});
 if(req.path==='/automation/rotation-groups')return res.json({data:[group]});
 if(req.path==='/meals/plans/1'&&req.method==='PUT'){payload=req.body;return res.json({data:plan});}
 if(req.path==='/meals/plans/1')return res.json({data:plan});
 if(req.path==='/meals/plans')return res.json({data:[plan]});
 return res.json({data:[]});
});
app.get('/rotation-meals-fixture.js',(_req,res)=>res.type('text/javascript').send(`
 import { initI18n,setLocale } from '/i18n.js';
 import { setPermissions } from '/permissions.js';
 await initI18n();await setLocale('en');setPermissions({admin:true});
 window.yuvomi={user:{id:1,role:'admin'},navigate(){},showToast(){},isModuleDisabled(){return false;}};
 await(await import('/pages/meals.js')).render(document.querySelector('#fixture'),{user:window.yuvomi.user});
 window.fixtureReady=true;
`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/rotation-meals-fixture',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/meals.css"><script src="/lucide.min.js"></script></head><body><main id="main-content"><div id="fixture"></div></main><div id="fab-layer"></div><script type="module" src="/rotation-meals-fixture.js"></script></body></html>`));
let server,browser,base;
test.before(async()=>{
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server?.close(resolve)||resolve());});
for(const width of [1440,390])test(`Meal Rotation Group selectors persist independent roles and legacy aliases at ${width}px`,async()=>{
 payload=null;const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.setViewport({width,height:900,hasTouch:width<768});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${base}/rotation-meals-fixture`);await page.waitForFunction(()=>window.fixtureReady);
  await page.click('#meal-plan-manage');await page.waitForSelector('[data-plan-edit="1"]');await page.click('[data-plan-edit="1"]');
  await page.waitForSelector('#meal-plan-form');
  const chooser='[name="rule_chooser_rotation_group_id"]';
  assert.equal(await page.$eval(chooser,el=>el.value),'7');
  assert.equal(await page.$eval('[name="rule_rotation_group"]',el=>el.type),'hidden');
  assert.ok((await page.$eval(chooser,el=>el.innerText)).includes('Kids'));
  await page.select('[name="rule_cook_rotation_group_id"]','');
  await page.select('[name="rule_supervisor_rotation_group_id"]','7');
  await page.$eval('[type="submit"][form="meal-plan-form"]',el=>el.scrollIntoView({block:'center'}));
  await page.click('[type="submit"][form="meal-plan-form"]');
  await page.waitForFunction(()=>!document.querySelector('#meal-plan-form'));
  assert.ok(payload);const rule=(payload.slot_groups||payload.rules)[0];
  assert.equal(rule.chooser_rotation_group_id,7);assert.equal(rule.cook_rotation_group_id,null);assert.equal(rule.supervisor_rotation_group_id,7);
  assert.equal(rule.rotation_group,'legacy-dinner');assert.equal(rule.cook_rotation_group,'legacy-cooks');assert.equal(rule.supervisor_rotation_group,'legacy-supervisors');
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
