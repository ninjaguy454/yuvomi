import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Real detail/API/icon modules with held HTTP writes. These checks distinguish
// an actual SVG/check path in the DOM from aria-only state and exercise the queue.
// rAF precedes paint; full-application raster evidence is collected separately.
let fixture, server, browser, base;
const app=express();app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/feedback-test',(_req,res)=>res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/lucide.min.js"></script>${['tokens','layout','typography','detail-view','tasks'].map(name=>`<link rel="stylesheet" href="/styles/${name}.css">`).join('')}</head><body></body></html>`));
app.use('/api/v1',(req,res)=>{
  fixture.requests.push({path:req.path,method:req.method});
  if(req.method==='PATCH'&&/\/tasks\/\d+\/status$/.test(req.path)){fixture.writes.push({path:req.path,body:req.body,res});return;}
  if(req.method==='POST'&&req.path.includes('/operations/')){fixture.writes.push({path:req.path,body:req.body,res});return;}
  if(req.path==='/auth/me')return res.json({user:{id:1},permissions:{},csrfToken:'fixture'});
  if(req.path==='/tasks/1'){fixture.reads++;return res.json({data:fixture.task});}
  res.json({data:[]});
});
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||(process.platform==='win32'&&existsSync(edge)?edge:undefined),args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise(resolve=>server?.close(resolve)||resolve());});
const selector=id=>`[data-subtask-id="${id}"] .detail-subtask__toggle`;
async function mounted({mobile=false,optional=false,count=8,finalRequired=false,rotations,workflowOperations}={}){
  fixture={writes:[],reads:0,requests:[],task:{id:1,revision:9,title:'Morning routine',status:'open',assigned_to:1,created_by:1,points:2,documents:[],
    permissions:{complete:true,edit:false,comment:false},subtasks:Array.from({length:count},(_,index)=>({id:index+2,revision:3,parent_revision:9,title:`Routine step ${index+1}`,
      status:'open',points:0,is_optional:optional&&index===0?1:0,skill_ids:[1],skills:[{id:1,name:'Independence'}],permissions:{complete:true}}))}};
  if(finalRequired){fixture.task.status='in_progress';fixture.task.subtasks.slice(0,-1).forEach(child=>child.status='done');}
  if(rotations)fixture.task.rotations=rotations;
  if(workflowOperations)fixture.task.workflow_rotation_operations=workflowOperations;
  const page=await browser.newPage();await page.setViewport(mobile?{width:390,height:844,isMobile:true,hasTouch:true}:{width:1024,height:800});
  await page.goto(`${base}/feedback-test`);
  await page.evaluate(async task=>{
    window.toasts=[];window.live=[];window.yuvomi={showToast:message=>window.toasts.push(message)};
    window.EventSource=class{constructor(){this.listeners=new Map();this.readyState=1;window.live.push(this);}addEventListener(name,cb){this.listeners.set(name,cb);}close(){}};
    const {openTaskDetail}=await import('/components/task-detail.js');window.fixtureTask=task;
    openTaskDetail({task,currentUserId:1,isAdmin:true,skills:[{id:1,name:'Independence'}],onChanged:()=>new Promise(()=>{})});
    window.initialRows=new Map([...document.querySelectorAll('[data-subtask-id]')].map(row=>[row.dataset.subtaskId,row]));
  },structuredClone(fixture.task));
  await page.waitForSelector(selector(2));return page;
}
async function writeAt(index=0){
  for(let retry=0;retry<100;retry++){if(fixture.writes[index])return fixture.writes[index];await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error(`Expected write ${index+1}; received ${fixture.writes.length}.`);
}
function acknowledge(write){
  const id=Number(write.path.split('/')[2]);fixture.task.revision++;
  fixture.task.subtasks=fixture.task.subtasks.map(child=>({...child,parent_revision:fixture.task.revision,...(child.id===id?{status:write.body.status,revision:child.revision+1}:{})}));
  fixture.task.status=fixture.task.subtasks.filter(child=>!child.is_optional).every(child=>child.status==='done')?'done':'in_progress';
  write.res.json({data:{...fixture.task.subtasks.find(child=>child.id===id),parent_task:fixture.task}});
}
async function settled(page,id){await page.waitForFunction(sel=>{const button=document.querySelector(sel);return button&&button.getAttribute('aria-busy')!=='true'&&!button.disabled;},{timeout:5000},selector(id));}

test('the optimistic checkbox is a real SVG in its first frame before any server response',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));await writeAt();
    const pending=await page.evaluate(async()=>{await new Promise(requestAnimationFrame);const b=document.querySelector('[data-subtask-id="2"] .detail-subtask__toggle');return{pressed:b.getAttribute('aria-pressed'),busy:b.getAttribute('aria-busy'),svg:!!b.querySelector('svg'),check:!!b.querySelector('svg path')?.getAttribute('d'),placeholder:!!b.querySelector('i[data-lucide]'),parent:fixtureTask.status,child:fixtureTask.subtasks[0].status};});
    assert.deepEqual(pending,{pressed:'true',busy:'true',svg:true,check:true,placeholder:false,parent:'open',child:'open'});
    acknowledge(fixture.writes[0]);await settled(page,2);
    assert.equal(await page.$eval(selector(2),button=>!!button.querySelector('svg')),true,'settling must retain the visible icon');
  }finally{await page.close();}
});

test('the first required step immediately shows In Progress while parent completion remains canonical',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));const first=await writeAt();
    assert.equal(await page.$eval('.task-detail-status select',select=>select.value),'in_progress');
    assert.equal(await page.evaluate(()=>fixtureTask.status),'open');
    acknowledge(first);await settled(page,2);
  }finally{await page.close();}
  const finalPage=await mounted({count:2,finalRequired:true});try{
    await finalPage.click(selector(3));const last=await writeAt();
    assert.equal(await finalPage.$eval('.task-detail-status select',select=>select.value),'in_progress','the read projection cannot prove all Workflow dependencies are complete');
    assert.equal(await finalPage.evaluate(()=>fixtureTask.status),'in_progress');
    acknowledge(last);await settled(finalPage,3);
    assert.equal(await finalPage.$eval('.task-detail-status select',select=>select.value),'done');
  }finally{await finalPage.close();}
});

test('keyboard reopening clears the SVG check immediately and preserves focused row identity',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));acknowledge(await writeAt());await settled(page,2);
    await page.focus(selector(2));await page.keyboard.press('Space');const reopening=await writeAt(1);
    assert.equal(reopening.body.status,'in_progress');
    assert.deepEqual(await page.$eval(selector(2),button=>({pressed:button.getAttribute('aria-pressed'),busy:button.getAttribute('aria-busy'),check:!!button.querySelector('svg path')?.getAttribute('d')})),{pressed:'false',busy:'true',check:false});
    acknowledge(reopening);await settled(page,2);
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.focusKey),'subtask-2');
    assert.equal(await page.evaluate(()=>initialRows.get('2')===document.querySelector('[data-subtask-id="2"]')),true);
  }finally{await page.close();}
});

test('different children paint immediately but write sequentially with fresh parent revisions; duplicate taps do not enqueue',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));await writeAt();await page.click(selector(3));
    await page.$eval(selector(2),button=>button.click());await page.$eval(selector(3),button=>button.click());
    assert.equal(fixture.writes.length,1,'only the first network write is in flight');
    assert.deepEqual(await page.evaluate(()=>[2,3].map(id=>{const b=document.querySelector(`[data-subtask-id="${id}"] .detail-subtask__toggle`);return[b.getAttribute('aria-pressed'),b.getAttribute('aria-busy'),!!b.querySelector('svg')];})),[['true','true',true],['true','true',true]]);
    acknowledge(fixture.writes[0]);const second=await writeAt(1);
    assert.deepEqual(second.body,{status:'done',expected_revision:3,expected_parent_revision:10});
    acknowledge(second);await settled(page,3);
    assert.equal(fixture.writes.length,2);assert.equal(await page.evaluate(()=>fixtureTask.subtasks.filter(row=>row.status==='done').length),2);
  }finally{await page.close();}
});

test('optional optimistic progress preserves the required denominator and canonical parent state',async()=>{
  const page=await mounted({optional:true});try{
    await page.click(selector(2));const write=await writeAt();
    assert.match(await page.$eval('.task-detail-progress',node=>node.textContent),/0 of 7 required complete.*1 of 1 optional/);
    assert.equal(await page.evaluate(()=>fixtureTask.status),'open');acknowledge(write);await settled(page,2);
  }finally{await page.close();}
});

test('pending and acknowledged updates preserve untouched row identity, scroll, and expanded requirements',async()=>{
  const page=await mounted({mobile:true,count:14});try{
    await page.evaluate(()=>{const row=document.querySelector('[data-subtask-id="8"]');row.querySelector('details').open=true;row.scrollIntoView({block:'center'});window.savedScroll=document.querySelector('.modal-panel__body').scrollTop;window.savedRow=row;window.savedDisclosure=row.querySelector('details');});
    await page.click(selector(8));const write=await writeAt();
    assert.equal(await page.evaluate(()=>savedRow===document.querySelector('[data-subtask-id="8"]')),true);
    acknowledge(write);await settled(page,8);
    assert.deepEqual(await page.evaluate(()=>({row:savedRow===document.querySelector('[data-subtask-id="8"]'),disclosure:savedDisclosure===document.querySelector('[data-subtask-id="8"] details'),open:savedDisclosure.open,scroll:document.querySelector('.modal-panel__body').scrollTop-savedScroll})),{row:true,disclosure:true,open:true,scroll:0});
  }finally{await page.close();}
});

test('Rotation completion evidence survives lean ACKs and refreshes without rebuilding Task rows or closing history',async()=>{
  const evidence=[{recorded_at:'2026-09-19T20:00:00Z',unordered:false,events:[{title:'First bedtime action'}]}];
  const page=await mounted({rotations:[{purpose_key:'shower',label:'Shower Order',position:1,occurrence:{id:4,revision:1,status:'resolved',order:[{id:1,name:'Grace'}]},recorded_completions:evidence}]});
  try {
    await page.$eval('[data-rotation-recorded-completions]',el=>{el.open=true});
    await page.click(selector(2));const write=await writeAt();
    delete fixture.task.rotations[0].recorded_completions;acknowledge(write);await settled(page,2);
    assert.equal(await page.$eval('[data-rotation-recorded-completions]',el=>el.open),true);
    assert.equal(await page.evaluate(()=>initialRows.get('3')===document.querySelector('[data-subtask-id="3"]')),true);
    fixture.task.rotations[0].recorded_completions=[...evidence,{recorded_at:'2026-09-19T20:01:00Z',unordered:false,events:[{title:'Second bedtime action'}]}];
    await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":11}'}));
    await page.waitForFunction(()=>document.querySelector('[data-rotation-recorded-completions]')?.textContent.includes('Second bedtime action'));
    assert.equal(await page.$eval('[data-rotation-recorded-completions]',el=>el.open),true);
    assert.equal(await page.evaluate(()=>initialRows.get('3')===document.querySelector('[data-subtask-id="3"]')),true);
    fixture.task.rotations=[];
    await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":12}'}));
    await page.waitForFunction(()=>!document.querySelector('[data-task-rotation-context]'));
    assert.equal(await page.evaluate(()=>fixtureTask.rotations.length),0,'an authoritative visibility removal discards cached evidence');
  } finally {await page.close();}
});

test('authored Rotation buttons use current live revisions and purpose/action identity after DOM reconciliation',async()=>{
  for(const changedPurpose of [false,true]) {
    const page=await mounted({rotations:[{purpose_key:'shower',label:'Shower Order',position:1,occurrence:{id:4,revision:1,status:'resolved',order:[{id:1,display_name:'Grace'}]}}],
      workflowOperations:{instance_id:7,purposes:[{purpose_key:'shower',label:'Shower Order',operations:['finalize']}]}});
    try {
      await page.evaluate(()=>{window.initialRotationButton=document.querySelector('[data-workflow-rotation-operation]')});
      fixture.task.revision=10;fixture.task.rotations[0].occurrence.revision=2;
      if(changedPurpose) {
        fixture.task.rotations[0].purpose_key='chores';fixture.task.rotations[0].label='Chores';
        fixture.task.workflow_rotation_operations.purposes=[{purpose_key:'chores',label:'Chores',operations:['skip']}];
      }
      await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":10}'}));
      await page.waitForFunction(()=>fixtureTask.rotations[0].occurrence.revision===2);
      assert.equal(await page.evaluate(()=>initialRotationButton===document.querySelector('[data-workflow-rotation-operation]')),true);
      await page.click('[data-workflow-rotation-operation]');const write=await writeAt();
      assert.equal(write.path,`/automation/workflow-instances/7/rotations/${changedPurpose?'chores/operations/skip':'shower/operations/finalize'}`);
      assert.deepEqual(write.body,{expected_revision:10,expected_occurrence_revision:2});write.res.json({data:[]});
    } finally {await page.close();}
  }
});

test('a stale revision rejection removes pending feedback and never dispatches a queued different child',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));const first=await writeAt();await page.click(selector(3));
    fixture.task.revision=15;fixture.task.assigned_to=7;fixture.task.subtasks.forEach(child=>child.parent_revision=15);
    first.res.status(409).json({error:'This Task was reassigned on another device.'});
    await page.waitForFunction(()=>fixtureTask.revision===15&&window.toasts.length>0);
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(fixture.writes.length,1);assert.equal(await page.evaluate(()=>fixtureTask.subtasks.filter(row=>row.status==='done').length),0);
    assert.match(await page.evaluate(()=>window.toasts.join(' ')),/reassigned/);
  }finally{await page.close();}
});

test('a live reset while the first write is pending cannot replay queued work against the newer occurrence state',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));const first=await writeAt();await page.click(selector(3));const old=structuredClone(fixture.task);
    fixture.task.revision=20;fixture.task.assigned_to=7;fixture.task.subtasks.forEach(child=>child.parent_revision=20);
    await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":20}'}));
    await page.waitForFunction(()=>fixtureTask.revision===20);
    first.res.json({data:{...old.subtasks[0],status:'done',revision:4,parent_revision:10,parent_task:{...old,revision:10,status:'in_progress',subtasks:old.subtasks.map((row,index)=>({...row,parent_revision:10,status:index===0?'done':'open'}))}}});
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(fixture.writes.length,1);assert.deepEqual(await page.evaluate(()=>[fixtureTask.revision,fixtureTask.assigned_to,fixtureTask.subtasks[0].status]),[20,7,'open']);
  }finally{await page.close();}
});

test('a same-revision live permission change survives the delayed own ACK and cancels queued intents',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));const first=await writeAt();await page.click(selector(3));
    const acknowledged=structuredClone(fixture.task);acknowledged.revision=10;acknowledged.status='in_progress';
    acknowledged.subtasks.forEach(child=>{child.parent_revision=10;if(child.id===2){child.status='done';child.revision=4;}});
    fixture.task=structuredClone(acknowledged);fixture.task.subtasks.find(child=>child.id===3).permissions.complete=false;
    await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":10}'}));
    await page.waitForFunction(()=>fixtureTask.revision===10&&fixtureTask.subtasks.find(child=>child.id===3).permissions.complete===false);
    first.res.json({data:{...acknowledged.subtasks[0],parent_task:acknowledged}});
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(fixture.writes.length,1);
    assert.equal(await page.evaluate(()=>fixtureTask.subtasks.find(child=>child.id===3).permissions.complete),false);
    assert.equal(await page.$eval(selector(3),button=>button.disabled),true);
  }finally{await page.close();}
});

test('a live comments refresh received during a pending write is deferred until the queue drains',async()=>{
  const page=await mounted();try{
    await page.click(selector(2));const first=await writeAt();
    const commentReads=()=>fixture.requests.filter(request=>request.method==='GET'&&request.path==='/tasks/1/comments').length;
    const before=commentReads();
    await page.evaluate(()=>window.live[0].listeners.get('change')({data:'{"version":9}'}));
    for(let retry=0;retry<50&&!fixture.reads;retry++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(fixture.reads>0,'the live detail snapshot was fetched');
    assert.equal(commentReads(),before,'the active child write must not trigger a comments fetch');
    acknowledge(first);await settled(page,2);
    for(let retry=0;retry<50&&commentReads()===before;retry++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(commentReads(),before+1,'the deferred live comments refresh happens once after the queue drains');
  }finally{await page.close();}
});

test('touch scrolling begun over a subtask does not activate a completion',async()=>{
  const page=await mounted({mobile:true,count:20});try{
    const point=await page.$eval(selector(8),button=>{button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
    const client=await page.createCDPSession();
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});
    for(let offset=15;offset<=100;offset+=15)await client.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-offset,id:1}]});
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(fixture.writes.length,0);
    await client.detach();
  }finally{await page.close();}
});
