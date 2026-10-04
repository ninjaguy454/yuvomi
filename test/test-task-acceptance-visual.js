import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app=express();let browser,server,base,projection,writes,failure,reads,requests,authResponse;
const members=[{id:1,display_name:'Alex'},{id:2,display_name:'Grace'},{id:3,display_name:'Sam'}];
const original={task:{id:7,title:'Prepare the garden',is_offer:true},expected_revision:4,primary_mode:'self',primary_user_id:1,primary_candidates:[members[0]],can_add_helpers:true,coassignee_candidates:members.slice(1),subtask_snapshot:[{id:10,revision:2},{id:11,revision:1}],subtasks:[{id:10,title:'Water seedlings',revision:2,allocatable:true,eligible_assignee_ids:[1,2,3]},{id:11,title:'Reserved step',revision:1,allocatable:false,reason:'Already assigned',eligible_assignee_ids:[]}]};
const links=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
app.use(express.json());app.get('/acceptance-test',(_q,r)=>r.send(`<!doctype html><html lang="en"><head><script src="/lucide.min.js" defer></script><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/tasks.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><button id="start">Start</button></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.use('/api/v1',(req,res)=>{
  requests.push({method:req.method,path:req.path,context:req.get('X-Auth-Context')||null});
  if(req.path==='/auth/me')return res.json(authResponse||{csrfToken:'fixture'});
  if(req.method==='GET'&&req.path.endsWith('/acceptance')){reads++;return res.json({data:{...projection,primary_user_id:Number(req.query.primary_user_id)||projection.primary_user_id}});}
  if(req.path.endsWith('/accept')){writes.push(structuredClone(req.body));if(failure){const code=failure;failure=null;return res.status(code).json({error:'Changed elsewhere'});}return res.json({data:{...projection.task,assigned_to:req.body.primary_user_id},replayed:writes.length>1});}
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount({device=false,children=true,helpers=true,phone=false,extraStep=false,scopedDevice=false,width=1280,theme='light',long=false}={}){
  projection=structuredClone(original);writes=[];failure=null;reads=0;requests=[];authResponse=null;
  if(device){projection.primary_mode='choose';projection.primary_user_id=null;projection.primary_candidates=structuredClone(members);}
  if(!children){projection.subtasks=[];projection.subtask_snapshot=[];}
  if(extraStep){projection.subtasks.push({id:12,title:'Plant the herbs',revision:3,allocatable:true,eligible_assignee_ids:[1,2,3]});projection.subtask_snapshot.push({id:12,revision:3});}
  if(scopedDevice){projection.primary_candidates=structuredClone(members.slice(1));authResponse={csrfToken:'fixture',authContext:'scoped-display',principal:{kind:'device',id:91},device:{id:91},temporary:false,permissions:{principal_kind:'device',modules:{tasks:'read',notes:'none'},capabilities:{'device_tasks.accept_with_helpers':'allow'}}};}
  if(long){
    projection.task.title='Prepare our shared garden and organize the InternationalHouseholdCommunityGardenVolunteerPreparationChecklist';
    for(const list of [projection.primary_candidates,projection.coassignee_candidates])for(const member of list)member.display_name=member.id===1?'Alexandria Montgomery-Richardson':member.id===2?'Grace Elizabeth VeryLongFamilyNameWithoutBreaksToExerciseNarrowLayouts':'Samuel Christopher De La Cruz';
    projection.subtasks=Array.from({length:8},(_,i)=>({id:20+i,title:`${i+1}. Sort and label the seedlings for the neighborhood community planting weekend`,revision:1,allocatable:true,eligible_assignee_ids:[1,2,3]}));
    projection.subtask_snapshot=projection.subtasks.map(({id,revision})=>({id,revision}));
  }
  projection.can_add_helpers=helpers;
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width,height:width<500?844:960,isMobile:width<500,hasTouch:width<800});await page.goto(base+'/acceptance-test');await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.evaluate(async(authResponse)=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();if(authResponse){(await import('/utils/device-context.js')).acceptAuthentication(authResponse);(await import('/permissions.js')).setPermissions(authResponse.permissions);}const {acceptOpenTask}=await import('/components/task-acceptance.js');document.querySelector('#start').onclick=()=>{window.resultPromise=acceptOpenTask({id:7,is_offer:true});};},authResponse);
  await page.click('#start');await page.waitForSelector('[data-acceptance-next]');return page;
}
const output=process.env.PHASE3_VISUAL_OUTPUT||'/tmp/phase3-visual';mkdirSync(output,{recursive:true});
const evidence=[];
test.after(()=>writeFileSync(`${output}/matrix.json`,JSON.stringify(evidence,null,2)));
async function shot(page,name,{cleared=false}={}){
  await page.evaluate(()=>document.querySelectorAll('.toast,[role="status"].toast').forEach(el=>el.remove()));
  await page.screenshot({path:`${output}/${name}.png`});
  const geometry=await page.evaluate(()=>{const body=document.querySelector('.modal-panel__body'),panel=document.querySelector('.modal-panel');return {viewport:innerWidth,document:document.documentElement.scrollWidth,bodyWidth:body?.clientWidth,bodyContentWidth:body?.scrollWidth,panel:panel?.getBoundingClientRect().toJSON(),theme:document.documentElement.dataset.theme,stage:document.querySelector('[data-task-acceptance]')?.dataset.stage};});
  evidence.push({name,...geometry});
  assert.ok(geometry.document<=geometry.viewport+1,`${name}: document overflow`);
  if(cleared)assert.equal(await page.$('[data-task-acceptance]'),null,`${name}: authentication transition clears the wizard`);
  else assert.ok(geometry.bodyContentWidth<=geometry.bodyWidth+1,`${name}: dialog content overflow ${geometry.bodyContentWidth}/${geometry.bodyWidth}`);
  assert.equal(await page.$$eval('.modal-panel__footer button',els=>els.some(el=>{const r=el.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||r.bottom>innerHeight+1;})),false,`${name}: footer controls remain on screen`);
}
async function press(page,selector){await page.focus(selector);await page.keyboard.press('Enter');}
for(const width of [320,390,768,1280,1440])for(const theme of ['light','dark'])test(`visual wizard ${width} ${theme}`,async()=>{
  const name=`${width}-${theme}`,page=await mount({width,theme,device:true,scopedDevice:true,long:true});
  try{
    await shot(page,`${name}-01-recipient`);await press(page,'[data-acceptance-next]');assert.equal(await page.$eval('[data-task-acceptance]',el=>el.dataset.stage),'primary');
    assert.equal(await page.$eval('[data-acceptance-primary]',el=>el===document.activeElement),true);
    if(width===320&&theme==='light')await shot(page,'320-light-validation-empty-recipient');
    await page.select('[data-acceptance-primary]','2');await press(page,'[data-acceptance-next]');await page.waitForSelector('[data-acceptance-helper="3"]');
    await shot(page,`${name}-02-helpers`);await page.click('[data-acceptance-helper="3"]');await press(page,'[data-acceptance-next]');
    await shot(page,`${name}-03-zero-allocation`);
    assert.ok(await page.$eval('.modal-panel__body',el=>el.scrollHeight>el.clientHeight),'long pool must scroll inside dialog');
    await page.$eval('.modal-panel__body',el=>el.scrollTop=el.scrollHeight);await shot(page,`${name}-04-pool-scroll`);
    await page.select('[data-acceptance-assignment="20"]','3');await page.$eval('.modal-panel__body',el=>el.scrollTop=0);await shot(page,`${name}-05-partial-allocation`);
    for(let id=21;id<28;id++)await page.select(`[data-acceptance-assignment="${id}"]`,id%2?'2':'3');
    await page.$eval('.modal-panel__body',el=>el.scrollTop=0);await shot(page,`${name}-06-all-allocation`);
    await press(page,'[data-acceptance-next]');await shot(page,`${name}-07-confirm`);assert.equal(writes.length,0);
    await press(page,'[data-acceptance-back]');assert.ok(await page.$('[data-acceptance-pool="3"] [data-acceptance-child="20"]'));
    await press(page,'[data-acceptance-next]');failure=409;await press(page,'[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-reload]');await shot(page,`${name}-08-conflict`);
    await press(page,'[data-acceptance-reload]');await page.waitForSelector('[data-acceptance-next]');await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.equal(writes.length,1);
    if(width===320&&theme==='light')await shot(page,'320-light-context-ending-cleared',{cleared:true});
  }finally{await page.close();}
});
test('visual branch evidence: no helpers, helpers without children, permission hint, cancellation and unknown retry',async()=>{
  for(const branch of ['solo','helpers-no-children','helper-denied','unknown-retry']){
    const page=await mount({width:390,theme:'dark',children:branch!=='helpers-no-children',helpers:branch!=='helper-denied'});
    try{
      await shot(page,`branch-${branch}-question`);
      if(branch==='helpers-no-children')await page.click('[data-acceptance-helper="2"]');
      await press(page,'[data-acceptance-next]');assert.equal(await page.$('[data-acceptance-pool]'),null);
      if(branch==='unknown-retry'){failure=503;await press(page,'[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-retry]');await shot(page,`branch-${branch}-uncertain`);await press(page,'[data-acceptance-retry]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.deepEqual(writes[0],writes[1]);}
      else{await shot(page,`branch-${branch}-confirm`);await press(page,'[data-acceptance-cancel]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.equal(writes.length,0);}
    }finally{await page.close();}
  }
});
