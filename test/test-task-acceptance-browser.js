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
app.use(express.json());app.get('/acceptance-test',(_q,r)=>r.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/tasks.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><button id="start">Start</button></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.use('/api/v1',(req,res)=>{
  requests.push({method:req.method,path:req.path,context:req.get('X-Auth-Context')||null});
  if(req.path==='/auth/me')return res.json(authResponse||{csrfToken:'fixture'});
  if(req.path==='/tasks')return res.json({data:[projection.task]});
  if(req.method==='GET'&&req.path.endsWith('/acceptance')){reads++;return res.json({data:{...projection,primary_user_id:Number(req.query.primary_user_id)||projection.primary_user_id}});}
  if(req.path.endsWith('/accept')){writes.push(structuredClone(req.body));if(failure){const code=failure;failure=null;return res.status(code).json({error:'Changed elsewhere'});}return res.json({data:{...projection.task,assigned_to:req.body.primary_user_id},replayed:writes.length>1});}
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount({device=false,children=true,helpers=true,phone=false,extraStep=false,scopedDevice=false,stress=false,width,long=false,theme='light',duplicateNames=false,photos=false}={}){
  projection=structuredClone(original);writes=[];failure=null;reads=0;requests=[];authResponse=null;
  if(device){projection.primary_mode='choose';projection.primary_user_id=null;projection.primary_candidates=structuredClone(members);}
  if(!children){projection.subtasks=[];projection.subtask_snapshot=[];}
  if(extraStep){projection.subtasks.push({id:12,title:'Plant the herbs',revision:3,allocatable:true,eligible_assignee_ids:[1,2,3]});projection.subtask_snapshot.push({id:12,revision:3});}
  if(scopedDevice){projection.primary_candidates=structuredClone(members.slice(1));authResponse={csrfToken:'fixture',authContext:'scoped-display',principal:{kind:'device',id:91},device:{id:91},temporary:false,permissions:{principal_kind:'device',modules:{tasks:'read',notes:'none'},capabilities:{'device_tasks.accept_with_helpers':'allow'}}};}
  projection.can_add_helpers=helpers;
  if(photos){projection.primary_candidates[0].avatar_data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=';projection.coassignee_candidates[0].avatar_data='https://forbidden.invalid/avatar';}
  if(duplicateNames){
    for(const list of [projection.primary_candidates,projection.coassignee_candidates])for(const member of list)if(member.id<3)member.display_name='Alex';
  }
  if(long){
    projection.task.title='Prepare our shared garden and organize the InternationalHouseholdCommunityGardenVolunteerPreparationChecklist '.repeat(3).trim();
    projection.coassignee_candidates[0].display_name='Grace Elizabeth VeryLongFamilyNameWithoutBreaksToExerciseNarrowLayouts';
    projection.coassignee_candidates[1].display_name='Samuel Christopher De La Cruz';
    projection.primary_candidates=projection.primary_candidates.map(member=>({...member,display_name:projection.coassignee_candidates.find(helper=>helper.id===member.id)?.display_name||member.display_name}));
  }
  if(stress){
    projection.coassignee_candidates=Array.from({length:9},(_,i)=>({id:i+2,display_name:`Household helper ${i+2}`}));
    projection.subtasks=Array.from({length:12},(_,i)=>({id:20+i,title:`${i+1}. Prepare supplies and check the long household project checklist`,revision:1,allocatable:true,eligible_assignee_ids:Array.from({length:10},(_,j)=>j+1)}));
    projection.subtask_snapshot=projection.subtasks.map(({id,revision})=>({id,revision}));
  }
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width:width||(phone?390:1280),height:900,isMobile:phone,hasTouch:phone});await page.goto(base+'/acceptance-test');await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.evaluate(async(authResponse)=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();if(authResponse){(await import('/utils/device-context.js')).acceptAuthentication(authResponse);(await import('/permissions.js')).setPermissions(authResponse.permissions);}const {acceptOpenTask}=await import('/components/task-acceptance.js');document.querySelector('#start').onclick=()=>{window.resultPromise=acceptOpenTask({id:7,is_offer:true});};},authResponse);
  if(duplicateNames)await page.evaluate(async()=>{(await import('/utils/member-label.js')).setMemberLabels([{id:1,display_name:'Alex',age:null,username:'alex.parent'},{id:2,display_name:'Alex',age:12,username:'alex.child'},{id:3,display_name:'Sam',age:null,username:'sam'}]);});
  await page.click('#start');await page.waitForSelector('[data-task-acceptance][data-stage="people"]');return page;
}
async function choosePrimary(page,id){await page.click(`[data-acceptance-primary="${id}"]`);await page.waitForSelector('.task-acceptance__helpers');}
async function chooseAllocation(page,id,userId) {
  await page.click(`[data-acceptance-target="${id}"]`);
  await page.click(`[data-acceptance-choice="${userId}"]`);
}

test('paired avatar radios reveal helper checkboxes beneath them without a separate step or identity change',async()=>{
  const page=await mount({device:true,scopedDevice:true});try{
    assert.equal(await page.$('select[data-acceptance-primary]'),null);
    assert.equal(await page.$('.task-acceptance__helpers'),null);
    assert.equal(await page.$eval('[data-acceptance-confirm]',e=>e.disabled),true);
    assert.deepEqual(await page.$$eval('[data-acceptance-primary]',els=>els.map(e=>[e.type,e.value])),[['radio','2'],['radio','3']]);
    await page.focus('[data-acceptance-primary="2"]');await page.keyboard.press('Space');await page.waitForSelector('[data-acceptance-helper="3"]');
    assert.equal(await page.$eval('[data-task-acceptance]',e=>e.dataset.stage),'people');
    assert.equal(await page.$eval('[data-acceptance-primary="2"]',e=>e.checked&&e===document.activeElement),true);
    assert.equal(await page.$('[data-acceptance-helper="2"]'),null);
    assert.equal(await page.evaluate(()=>document.querySelector('.task-acceptance__helpers').getBoundingClientRect().top>=document.querySelector('.task-acceptance__primaries').getBoundingClientRect().bottom),true);
    await page.focus('[data-acceptance-helper="3"]');await page.keyboard.press('Space');
    assert.equal(await page.$eval('[data-acceptance-helper="3"]',e=>e.type==='checkbox'&&e.checked&&e===document.activeElement),true);
    assert.equal(await page.$eval('[data-acceptance-helper="3"]',e=>getComputedStyle(e.closest('label').querySelector('.task-acceptance__check')).display!=='none'),true);
    await page.click('[data-acceptance-next]');await chooseAllocation(page,10,'3');await page.click('[data-acceptance-back]');
    await choosePrimary(page,3);assert.equal(await page.$('[data-acceptance-helper="3"]'),null);
    assert.equal(await page.$$eval('[data-acceptance-helper]:checked',els=>els.length),0,'changing the acceptor clears helper choices');
    await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});
    assert.equal(writes.length,1);assert.equal(writes[0].primary_user_id,3);assert.deepEqual(writes[0].coassignee_ids,[]);assert.ok(writes[0].subtask_assignments.every(row=>row.user_id===null));
  }finally{await page.close();}
});

test('authorized data photos render in the grid; remote URLs and richer cached profiles use initials',async()=>{
  const page=await mount({photos:true});try{
    await page.evaluate(()=>{window.yuvomi={users:[{id:3,avatar_data:'data:image/png;base64,c2VjcmV0'}]};});
    assert.ok(await page.$('[data-acceptance-primary="1"] + .task-acceptance__avatar-wrap img'));
    assert.equal(await page.$('[data-acceptance-helper="2"] + .task-acceptance__avatar-wrap img'),null);
    assert.equal(await page.$('[data-acceptance-helper="3"] + .task-acceptance__avatar-wrap img'),null);
    assert.equal(await page.$eval('[data-acceptance-primary="1"]',e=>e.checked&&e.disabled),true,'personal identity cannot be reassigned');
    assert.ok(!requests.some(r=>/profile|users|avatar/.test(r.path)));
    await page.click('[data-acceptance-cancel]');assert.equal(writes.length,0);
  }finally{await page.close();}
});

for(const allocation of [false,true])test(`Enter from a selected helper invokes the visible action (allocation ${allocation})`,async()=>{
  const page=await mount({children:allocation});try{
    await page.focus('[data-acceptance-helper="2"]');await page.keyboard.press('Space');await page.keyboard.press('Enter');
    if(allocation){await page.waitForSelector('[data-acceptance-allocation]');assert.equal(writes.length,0);await page.click('[data-acceptance-cancel]');}
    else{await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.equal(writes.length,1);assert.deepEqual(writes[0].coassignee_ids,[2]);}
  }finally{await page.close();}
});

test('duplicate member labels remain distinct through paired acceptance without changing initials or IDs',async()=>{
  const page=await mount({device:true,duplicateNames:true});try{
    assert.deepEqual(await page.$$eval('[data-acceptance-primary]',els=>els.map(el=>[el.value,el.closest('label').querySelector('.task-acceptance__member-name').textContent])),[['1','Alex (alex.parent)'],['2','Alex (12)'],['3','Sam']]);
    await page.click('[data-acceptance-primary="1"]');await page.waitForSelector('.task-acceptance__helpers');
    await page.waitForSelector('[data-acceptance-helper="2"]');
    assert.equal(await page.$eval('[data-acceptance-helper="2"]',el=>el.closest('label').querySelector('.task-acceptance__member-name').textContent),'Alex (12)');
    assert.equal(await page.$eval('[data-acceptance-helper="2"]',el=>el.closest('label').querySelector('.task-acceptance__avatar').textContent),'A');
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    assert.equal(await page.$eval('[data-acceptance-participant="1"] .task-allocation__name',el=>el.textContent),'Alex (alex.parent)');
    assert.equal(await page.$eval('[data-acceptance-participant="2"] .task-allocation__name',el=>el.textContent),'Alex (12)');
    await chooseAllocation(page,10,'2');await page.click('[data-acceptance-next]');
    assert.equal(await page.$eval('[data-acceptance-identity]',el=>el.textContent),'Alex (alex.parent)');
    assert.equal(await page.$eval('[data-acceptance-summary-helper="2"] .task-acceptance__member-name',el=>el.textContent),'Alex (12)');
    assert.deepEqual(await page.$$eval('.task-acceptance__identity .task-acceptance__avatar',els=>els.map(el=>el.textContent)),['A','A']);
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.equal(writes.length,1);assert.equal(writes[0].primary_user_id,1);assert.deepEqual(writes[0].coassignee_ids,[2]);assert.equal(writes[0].subtask_assignments.find(row=>row.id===10).user_id,2);
    assert.ok(!requests.some(request=>request.path.includes('birth')||request.path==='/auth/users'));
  }finally{await page.close();}
});
for(const children of [false,true])for(const helpers of [false,true])test(`helpers question always; allocation only for helpers=${helpers}, children=${children}`,async()=>{
  const page=await mount({children});try{
    assert.ok(await page.$('[data-acceptance-helper="2"]'));
    assert.ok(!(await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('Accepted by:'));
    if(helpers)await page.click('[data-acceptance-helper="2"]');
    assert.equal(await page.$eval('[data-acceptance-next]',el=>!el.hidden),helpers&&children);
    if(helpers&&children)await page.click('[data-acceptance-next]');
    assert.equal(Boolean(await page.$('[data-acceptance-allocation]')),helpers&&children);
    if(helpers&&children){assert.equal(await page.$$eval('[data-acceptance-person]',els=>els.length),2);await page.click('[data-acceptance-next]');}
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.equal(writes.length,1);assert.ok(writes[0].subtask_assignments.every(row=>row.user_id===null));
  }finally{await page.close();}
});

for(const width of [320,390,1280])test(`offscreen avatar drag ${width}: scroll, cancel, retry and keyboard assignment`,async()=>{
  const touch=width<500,page=await mount({phone:touch,width,stress:true});
  let cdp;
  const output=process.env.OPEN_TASK_DRAG_EVIDENCE;
  const scrollTop=()=>page.$eval('.modal-panel__body',el=>el.scrollTop);
  const press=async selector=>{await page.focus(selector);await page.keyboard.press('Enter');};
  try{
    for(let id=2;id<=10;id++)await page.click(`[data-acceptance-helper="${id}"]`);
    await press('[data-acceptance-next]');
    assert.equal(await page.$$eval('[data-acceptance-person]',els=>els.length),10);
    const initial=await page.evaluate(()=>({body:document.querySelector('.modal-panel__body').getBoundingClientRect().toJSON(),target:document.querySelector('[data-acceptance-target="31"]').getBoundingClientRect().toJSON()}));
    assert.ok(initial.target.top>initial.body.bottom,'last step must begin offscreen');
    if(touch)cdp=await page.createCDPSession();
    async function gesture(type,x,y){
      if(touch)await cdp.send('Input.dispatchTouchEvent',{type:{down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[type],touchPoints:['up','cancel'].includes(type)?[]:[{x,y}]});
      else if(type==='down'){await page.mouse.move(x,y);await page.mouse.down();}
      else if(type==='move')await page.mouse.move(x,y,{steps:6});
      else await page.mouse.up();
    }
    async function start(){
      await page.$eval('.modal-panel__body',el=>el.scrollTop=0);
      await page.$eval('[data-acceptance-person="10"]',el=>el.scrollIntoView({block:'center'}));
      await page.$eval('[data-acceptance-person="10"]',el=>el.addEventListener('pointerdown',event=>{window.activeAcceptancePointer=event.pointerId;},{once:true}));
      const box=await(await page.$('[data-acceptance-person="10"]')).boundingBox();
      await gesture('down',box.x+box.width/2,box.y+box.height/2);
      const edge=await page.$eval('.modal-panel__body',el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.bottom-8};});
      const before=await scrollTop();await gesture('move',edge.x,edge.y);
      await page.waitForFunction(before=>document.querySelector('.modal-panel__body').scrollTop>before+80,{timeout:2500},before);
      return edge;
    }
    // Cancellation must stop a held edge-scroll and leave the local draft unchanged.
    await start();
    if(touch)await gesture('cancel');else{await page.keyboard.press('Escape');await gesture('up');}
    const stopped=await scrollTop();await new Promise(r=>setTimeout(r,250));
    assert.equal(await scrollTop(),stopped,'cancel stops scrolling');
    assert.ok(await page.$('[data-acceptance-target="31"][data-assignee=""]'));
    await start();
    assert.equal(await page.$eval('[data-acceptance-allocation]',el=>{el.releasePointerCapture(window.activeAcceptancePointer);return el.hasPointerCapture(window.activeAcceptancePointer);}),false,'the stable host no longer owns capture');
    await gesture('move',initial.body.left+initial.body.width/2,initial.body.bottom-8);
    const captureLost=await scrollTop();await new Promise(r=>setTimeout(r,250));
    assert.equal(await scrollTop(),captureLost,'capture loss stops scrolling');await gesture('up');
    assert.ok(await page.$('[data-acceptance-target="31"][data-assignee=""]'));
    // A fresh avatar gesture reaches a distant stationary step without wheel/script scrolling.
    await start();
    await page.waitForFunction(()=>{const body=document.querySelector('.modal-panel__body').getBoundingClientRect(),target=document.querySelector('[data-acceptance-target="31"]').getBoundingClientRect();return target.top>body.top+12&&target.bottom<body.bottom-8;},{timeout:20000});
    const target=await page.$eval('[data-acceptance-target="31"]',el=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
    await gesture('move',target.x,target.y);await gesture('up');
    assert.ok(await page.$('[data-acceptance-target="31"][data-assignee="10"]'),'drop assigns exactly to formerly offscreen step');
    assert.equal(await page.$$eval('[data-acceptance-child="31"]',els=>els.length),1);
    const released=await scrollTop();await new Promise(r=>setTimeout(r,250));assert.equal(await scrollTop(),released,'release stops scrolling');
    assert.equal(writes.length,0);
    if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:`${output}/offscreen-drag-${width}.png`});}
    // Use the labelled target and nested chooser with actual keyboard activation.
    await page.focus('[data-acceptance-target="21"]');await page.keyboard.press('Space');
    await page.focus('[data-acceptance-choice="10"]');await page.keyboard.press('Enter');
    await page.waitForSelector('[data-acceptance-target="21"][data-assignee="10"]');
    assert.equal(await page.$eval('[data-acceptance-target="21"]',el=>!!el.getAttribute('aria-label')&&el===document.activeElement),true);
    if(output)await page.screenshot({path:`${output}/keyboard-assign-${width}.png`});
    await press('[data-acceptance-next]');await press('[data-acceptance-confirm]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});
    assert.equal(writes.length,1);assert.equal(writes[0].subtask_assignments.length,12);
    assert.deepEqual(writes[0].subtask_assignments.filter(row=>row.user_id!==null),[{id:21,user_id:10},{id:31,user_id:10}]);
    await page.click('#start');await page.waitForSelector('[data-acceptance-next]');
    for(let id=2;id<=10;id++)await page.click(`[data-acceptance-helper="${id}"]`);
    await press('[data-acceptance-next]');await start();
    await page.evaluate(()=>{window.endingDragBody=document.querySelector('.modal-panel__body');window.dispatchEvent(new Event('auth:context-ending'));});
    await page.waitForSelector('[data-task-acceptance]',{hidden:true});
    const ended=await page.evaluate(()=>window.endingDragBody.scrollTop);await new Promise(r=>setTimeout(r,250));
    assert.equal(await page.evaluate(()=>window.endingDragBody.scrollTop),ended,'context ending stops active edge scroll');
    await gesture('up');assert.equal(writes.length,1,'context ending sends no additional assignment');
    if(output)writeFileSync(`${output}/offscreen-drag-${width}.json`,JSON.stringify({width,touch,subtasks:12,recipients:10,targets:12,initialTarget:initial.target,initialBody:initial.body,cancelledWithoutAssignment:true,captureLossStopsScroll:true,scrollStoppedAfterRelease:true,contextEndingStopsScroll:true,keyboardAssigned:true,writes:writes.length,payload:writes[0]},null,2));
  }finally{await cdp?.detach();await page.close();}
});

for(const allocation of ['zero','partial','all'])test(`helpers and multiple subtasks confirm ${allocation} allocation, preserving protected steps`,async()=>{
  const page=await mount({extraStep:true});try{
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="3"]');await page.click('[data-acceptance-next]');
    assert.equal(await page.$$eval('[data-acceptance-person]',els=>els.length),3,'primary and two helpers');
    assert.equal(await page.$eval('[data-acceptance-target="11"]',el=>el.disabled),true,'protected step cannot be assigned');
    if(allocation!=='zero')await chooseAllocation(page,10,allocation==='partial'?'1':'2');
    if(allocation==='all')await chooseAllocation(page,12,'3');
    assert.equal(writes.length,0,'allocation is only a local draft');
    await page.click('[data-acceptance-next]');assert.equal(writes.length,0,'review is not confirmation');
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.equal(writes.length,1);assert.deepEqual(writes[0].coassignee_ids,[2,3]);
    assert.deepEqual(writes[0].subtask_assignments,[{id:10,user_id:allocation==='zero'?null:allocation==='partial'?1:2},{id:12,user_id:allocation==='all'?3:null}]);
    assert.deepEqual(writes[0].subtask_snapshot,[{id:10,revision:2},{id:11,revision:1},{id:12,revision:3}]);
  }finally{await page.close();}
});

test('back removing every helper skips allocation and clears both primary and helper draft assignments',async()=>{
  const page=await mount({extraStep:true});try{
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    await chooseAllocation(page,10,'1');await chooseAllocation(page,12,'2');
    await page.click('[data-acceptance-back]');await page.click('[data-acceptance-helper="2"]');
    assert.equal(await page.$('[data-acceptance-pool]'),null);assert.ok(await page.$('[data-acceptance-confirm]'));assert.equal(writes.length,0);
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.deepEqual(writes[0].coassignee_ids,[]);assert.deepEqual(writes[0].subtask_assignments,[{id:10,user_id:null},{id:12,user_id:null}]);
  }finally{await page.close();}
});

test('scoped paired picker keeps device identity and rights through recipient changes and acceptance',async()=>{
  const page=await mount({device:true,scopedDevice:true,phone:true});try{
    const identity=()=>page.evaluate(async()=>{const d=await import('/utils/device-context.js'),p=await import('/permissions.js');return {snapshot:d.authenticationSnapshot(),bootstrap:d.deviceBootstrap(),isDevice:d.isDevicePrincipal(),permissions:p.getPermissions(),notes:p.moduleAccess('notes')};});
    const initial=await identity();assert.equal(initial.isDevice,true);assert.equal(initial.notes,'none');
    assert.deepEqual(await page.$$eval('[data-acceptance-primary]',els=>els.map(el=>el.value)),['2','3']);
    assert.equal(await page.$eval('[data-acceptance-confirm]',el=>el.disabled),true,'recipient is required');assert.equal(reads,1);
    await page.click('[data-acceptance-primary="2"]');await page.waitForSelector('.task-acceptance__helpers');await page.waitForSelector('[data-acceptance-helper="3"]');assert.deepEqual(await identity(),initial);
    await page.click('[data-acceptance-helper="3"]');await page.click('[data-acceptance-next]');await page.click('[data-acceptance-back]');
    assert.equal(await page.$eval('[data-acceptance-helper="3"]',el=>el.checked),true,'back to the same primary retains helper choices');
    await page.click('[data-acceptance-next]');await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.deepEqual(await identity(),initial);assert.equal(writes[0].primary_user_id,2);assert.deepEqual(writes[0].coassignee_ids,[3]);
    assert.ok(requests.every(req=>req.context==='scoped-display'),'all reads and writes keep the device context');
    assert.deepEqual(requests.filter(req=>req.method!=='GET').map(req=>req.path),['/tasks/7/accept'],'selection never invokes login, identification, or permission writes');
  }finally{await page.close();}
});
test('paired phone recipient, chooser allocation, back removes helper assignments, cancel writes nothing',async()=>{
  const page=await mount({device:true,phone:true});try{
    assert.ok(!(await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('does not sign'),'no extra instructional paragraph');
    await page.click('[data-acceptance-primary="1"]');await page.waitForSelector('.task-acceptance__helpers');await page.waitForSelector('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    await chooseAllocation(page,10,'2');
    assert.ok(await page.$('[data-acceptance-target="10"][data-assignee="2"]'));
    if(process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.OPEN_TASK_SCREENSHOTS+'/acceptance-phone.png'});}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.click('[data-acceptance-back]');await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="3"]');await page.click('[data-acceptance-next]');
    assert.ok(await page.$('[data-acceptance-target="10"][data-assignee=""]'));
    await page.click('[data-acceptance-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,0);
  }finally{await page.close();}
});
test('helper denial still asks question and permits self acceptance',async()=>{
  const page=await mount({helpers:false});try{
    assert.ok(await page.$('[data-acceptance-helper-unavailable]'));assert.equal(await page.$('[data-acceptance-helper]'),null);
    assert.equal(await page.$eval('[data-acceptance-next]',el=>el.hidden),true);await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[0].coassignee_ids,[]);
  }finally{await page.close();}
});
test('uncertain retry reuses exact operation, while conflict requires reload and fresh confirmation',async()=>{
  const page=await mount();try{
    failure=503;await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-retry]');await page.click('[data-acceptance-retry]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[1],writes[0]);
    await page.click('#start');await page.waitForSelector('[data-acceptance-confirm]');failure=409;await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-reload]');const previous=writes.at(-1).operation_id;projection.expected_revision=8;await page.click('[data-acceptance-reload]');await page.waitForSelector('[data-acceptance-confirm]');assert.equal(writes.length,3);await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.at(-1).expected_revision,8);assert.notEqual(writes.at(-1).operation_id,previous);
  }finally{await page.close();}
});
test('context ending discards local allocation without a request',async()=>{
  const page=await mount();try{await page.click('[data-acceptance-helper="2"]');await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,0);}finally{await page.close();}
});

for(const width of [320,360,752,1280])for(const theme of ['light','dark'])test(`compact acceptance feedback ${width} ${theme}`,async()=>{
  const page=await mount({width,phone:width<500,long:true,theme});
  const output=process.env.ACCEPTANCE_REFINEMENT_EVIDENCE;
  try{
    const text=await page.$eval('[data-task-acceptance]',el=>el.textContent);
    assert.ok(!text.includes('Accepted by:'),'helper stage omits repeated accepting identity');
    assert.ok(!text.includes('Choose co-assignees, or continue without helpers.'),'helper stage omits redundant explanation');
    const title=await page.$eval('[data-task-acceptance] h3',el=>({text:el.textContent,height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),full:el.scrollHeight}));
    assert.equal(title.text,projection.task.title,'accessible title keeps the complete text');
    assert.ok(title.height<=title.lineHeight*2+1,'heading uses at most two visible lines');
    assert.ok(title.full>title.height,'long title is visibly truncated');
    assert.equal(await page.$$eval('.task-acceptance__helpers .task-acceptance__avatar',els=>els.map(el=>el.textContent).join(',')),'GV,SC','helpers have distinct initials');
    const helper='[data-acceptance-helper="2"]';
    assert.equal(await page.$eval(helper,el=>el.type),'checkbox');
    assert.ok(await page.$(`::-p-aria(${projection.coassignee_candidates[0].display_name})`),'native checkbox accessible name contains only the complete member name');
    const measure=()=>page.$eval(helper,el=>{const card=el.closest('label'),r=card.getBoundingClientRect(),style=getComputedStyle(card.querySelector('.task-acceptance__avatar-wrap'));return{x:r.x,y:r.y,width:r.width,height:r.height,shadow:style.boxShadow,check:getComputedStyle(card.querySelector('.task-acceptance__check')).display};});
    const before=await measure();assert.ok(before.height>=44,'whole helper card is a touch target');
    await page.focus(helper);await page.keyboard.press('Space');assert.equal(await page.$eval(helper,el=>el.checked),true);
    const after=await measure();assert.deepEqual([after.x,after.y,after.width,after.height],[before.x,before.y,before.width,before.height],'selection does not shift the card');
    assert.notEqual(after.shadow,before.shadow,'selected portrait has a ring');assert.equal(after.check,'grid','selected portrait has a corner check badge');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.equal(await page.$eval('.modal-panel__body',el=>el.scrollWidth>el.clientWidth+1),false);
    if(output){mkdirSync(output,{recursive:true});await page.screenshot({path:`${output}/helpers-${width}-${theme}.png`});writeFileSync(`${output}/helpers-${width}-${theme}.json`,JSON.stringify({width,theme,title,before,after},null,2));}
    await page.click('[data-acceptance-next]');await page.click('[data-acceptance-next]');
    const confirm=await page.$eval('[data-task-acceptance]',el=>el.textContent);
    assert.ok(!confirm.includes('Accepted by:'),'confirmation removes redundant prose');
    assert.equal(await page.$eval('[data-acceptance-identity]',el=>el.textContent.trim()),'Alex','confirmation retains accepting person');
    assert.equal(writes.length,0);await page.click('[data-acceptance-cancel]');
  }finally{await page.close();}
});

test('paired confirmation preserves chosen accepting identity without repeated prose',async()=>{
  const page=await mount({device:true,children:false});try{
    await page.click('[data-acceptance-primary="2"]');await page.waitForSelector('.task-acceptance__helpers');await page.waitForSelector('[data-acceptance-helper="3"]');
    assert.equal(await page.$eval('[data-acceptance-next]',el=>el.hidden),true);
    assert.equal(await page.$eval('[data-acceptance-primary]:checked',el=>el.closest('label').querySelector('.task-acceptance__member-name').textContent.trim()),'Grace');
    assert.equal(await page.$$eval('[data-acceptance-helper]:checked',els=>els.length),0);
    assert.ok(!(await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('Confirm to accept the task'));
    assert.ok(!(await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('Accepted by:'));
    await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.equal(writes[0].primary_user_id,2);
  }finally{await page.close();}
});

for(const width of [320,752])for(const theme of ['light','dark'])test(`confirmation helpers stay readable and preserve allocation ${width} ${theme}`,async()=>{
  const page=await mount({width,phone:width<500,long:true,theme});try{
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="3"]');await page.click('[data-acceptance-next]');
    await chooseAllocation(page,10,'2');await page.click('[data-acceptance-next]');
    const summary=await page.$eval('[data-task-acceptance]',el=>({text:el.textContent,title:el.querySelector('.task-acceptance__title').textContent,primary:el.querySelector('[data-acceptance-identity]').textContent,helpers:[...el.querySelectorAll('[data-acceptance-summary-helper]')].map(row=>{const avatar=row.querySelector('.task-acceptance__avatar');return {id:Number(row.dataset.acceptanceSummaryHelper),name:row.querySelector('.task-acceptance__member-name').textContent,avatarWidth:avatar.getBoundingClientRect().width,avatarHeight:avatar.getBoundingClientRect().height};}),label:document.getElementById(el.querySelector('.task-acceptance__summary-helpers').getAttribute('aria-labelledby')).textContent}));
    assert.equal(summary.primary,'Alex');assert.equal(summary.title,projection.task.title);assert.equal(summary.label,'Helpers');
    assert.deepEqual(summary.helpers.map(({id,name})=>({id,name})),projection.coassignee_candidates.map(({id,display_name})=>({id,name:display_name})));
    assert.ok(summary.helpers.every(row=>row.avatarWidth===36&&row.avatarHeight===36),'summary initials remain round beside long wrapping names');
    assert.ok(!summary.text.includes('Confirm to accept the task'),'confirmation keeps its explicit action without redundant instruction');assert.ok(summary.text.includes('Water seedlings: '+projection.coassignee_candidates[0].display_name));assert.ok(summary.text.includes('Reserved step: Unchanged'));
    const geometry=await page.evaluate(()=>{const body=document.querySelector('.modal-panel__body'),footer=document.querySelector('.modal-panel__footer').getBoundingClientRect();return {overflow:body.scrollWidth>body.clientWidth+1,footer:footer.bottom,height:innerHeight};});assert.equal(geometry.overflow,false);assert.ok(geometry.footer<=geometry.height+1);
    if(process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.OPEN_TASK_SCREENSHOTS}/summary-${width}-${theme}.png`});}
    await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-task-acceptance]',{hidden:true});assert.equal(writes.length,1);assert.equal(writes[0].primary_user_id,1);assert.deepEqual(writes[0].coassignee_ids,[2,3]);assert.deepEqual(writes[0].subtask_assignments,[{id:10,user_id:2}]);
  }finally{await page.close();}
});

test('paired confirmation preserves long identity avatar size at 320px',async()=>{
  const page=await mount({device:true,children:false,width:320,phone:true,long:true});try{
    await page.click('[data-acceptance-primary="2"]');await page.waitForSelector('.task-acceptance__helpers');await page.waitForSelector('[data-acceptance-helper="3"]');
    assert.equal(await page.$eval('[data-acceptance-primary]:checked',el=>el.closest('label').querySelector('.task-acceptance__avatar').getBoundingClientRect().width),64,'avatar does not shrink or wrap initials beside a long name');
    assert.equal(await page.$eval('[data-acceptance-primary]:checked',el=>el.closest('label').querySelector('.task-acceptance__member-name').textContent.trim()),projection.coassignee_candidates[0].display_name);
    assert.equal(await page.$eval('.modal-panel__body',el=>el.scrollWidth>el.clientWidth+1),false);await page.click('[data-acceptance-cancel]');
  }finally{await page.close();}
});

test('open-task card clamps its visible title while retaining complete accessible text',async()=>{
  const page=await mount({width:320,phone:true,long:true});try{
    await page.click('[data-acceptance-cancel]');
    await page.evaluate(async title=>{(await import('/permissions.js')).setPermissions({admin:true});window.EventSource=class{addEventListener(){}close(){}};document.body.insertAdjacentHTML('beforeend','<div id="board"></div>');window.stopBoard=(await import('/components/open-task-board.js')).mountOpenTaskBoard(document.querySelector('#board'));},projection.task.title);
    // The board endpoint shares the authorized synthetic projection for this fixture.
    await page.waitForSelector('[data-open-task="7"]');
    const title=await page.$eval('[data-open-task="7"] strong',el=>({text:el.textContent,height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight),full:el.scrollHeight}));
    assert.equal(title.text,projection.task.title);assert.ok(title.height<=title.lineHeight*2+1);assert.ok(title.full>title.height);
    await page.evaluate(()=>window.stopBoard());
  }finally{await page.close();}
});

for(const touch of [false,true])test(`${touch?'touch':'mouse'} drag allocates a step to a helper without saving until confirmation`,async()=>{
  const page=await mount();try{
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    const source=await(await page.$('[data-acceptance-person="2"]')).boundingBox(),target=await(await page.$('[data-acceptance-target="10"]')).boundingBox();
    const x=source.x+source.width/2,y=source.y+source.height/2,tx=target.x+target.width/2,ty=target.y+target.height/2;
    if(touch){const cdp=await page.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let step=1;step<=6;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+(tx-x)*step/6,y:y+(ty-y)*step/6}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
    else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:6});await page.mouse.up();}
    assert.ok(await page.$('[data-acceptance-target="10"][data-assignee="2"]'));assert.equal(writes.length,0);
    if(!touch&&process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.OPEN_TASK_SCREENSHOTS+'/acceptance-desktop.png'});}
    await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[0].subtask_assignments,[{id:10,user_id:2}]);
  }finally{await page.close();}
});
