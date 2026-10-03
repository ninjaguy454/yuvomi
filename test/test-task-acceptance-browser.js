import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const app=express();let browser,server,base,projection,writes,failure,reads;
const members=[{id:1,display_name:'Alex'},{id:2,display_name:'Grace'},{id:3,display_name:'Sam'}];
const original={task:{id:7,title:'Prepare the garden',is_offer:true},expected_revision:4,primary_mode:'self',primary_user_id:1,primary_candidates:[members[0]],can_add_helpers:true,coassignee_candidates:members.slice(1),subtask_snapshot:[{id:10,revision:2},{id:11,revision:1}],subtasks:[{id:10,title:'Water seedlings',revision:2,allocatable:true,eligible_assignee_ids:[1,2,3]},{id:11,title:'Reserved step',revision:1,allocatable:false,reason:'Already assigned',eligible_assignee_ids:[]}]};
const links=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
app.use(express.json());app.get('/acceptance-test',(_q,r)=>r.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/tasks.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><button id="start">Start</button></body></html>`));
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.use('/api/v1',(req,res)=>{
  if(req.path==='/auth/me')return res.json({csrfToken:'fixture'});
  if(req.method==='GET'&&req.path.endsWith('/acceptance')){reads++;return res.json({data:{...projection,primary_user_id:Number(req.query.primary_user_id)||projection.primary_user_id}});}
  if(req.path.endsWith('/accept')){writes.push(structuredClone(req.body));if(failure){const code=failure;failure=null;return res.status(code).json({error:'Changed elsewhere'});}return res.json({data:{...projection.task,assigned_to:req.body.primary_user_id},replayed:writes.length>1});}
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount({device=false,children=true,helpers=true,phone=false}={}){
  projection=structuredClone(original);writes=[];failure=null;reads=0;
  if(device){projection.primary_mode='choose';projection.primary_user_id=null;projection.primary_candidates=members;}
  if(!children){projection.subtasks=[];projection.subtask_snapshot=[];}
  projection.can_add_helpers=helpers;
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width:phone?390:1280,height:900,isMobile:phone,hasTouch:phone});await page.goto(base+'/acceptance-test');
  await page.evaluate(async()=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();const {acceptOpenTask}=await import('/components/task-acceptance.js');document.querySelector('#start').onclick=()=>{window.resultPromise=acceptOpenTask({id:7,is_offer:true});};});
  await page.click('#start');await page.waitForSelector('[data-acceptance-next]');return page;
}
for(const children of [false,true])for(const helpers of [false,true])test(`helpers question always; allocation only for helpers=${helpers}, children=${children}`,async()=>{
  const page=await mount({children});try{
    assert.ok(await page.$('[data-acceptance-helper="2"]'));
    assert.ok((await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('Accepted by: Alex'));
    if(helpers)await page.click('[data-acceptance-helper="2"]');
    await page.click('[data-acceptance-next]');
    assert.equal(Boolean(await page.$('[data-acceptance-pool]')),helpers&&children);
    if(helpers&&children){assert.equal(await page.$$eval('[data-acceptance-pool]',els=>els.length),3);await page.click('[data-acceptance-next]');}
    await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));
    assert.equal(writes.length,1);assert.ok(writes[0].subtask_assignments.every(row=>row.user_id===null));
  }finally{await page.close();}
});
test('paired phone recipient, select allocation, back removes helper assignments, cancel writes nothing',async()=>{
  const page=await mount({device:true,phone:true});try{
    assert.ok((await page.$eval('[data-task-acceptance]',el=>el.textContent)).includes('does not sign'));
    await page.select('[data-acceptance-primary]','1');await page.click('[data-acceptance-next]');await page.waitForSelector('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    await page.select('[data-acceptance-assignment="10"]','2');
    assert.ok(await page.$('[data-acceptance-pool="2"] [data-acceptance-child="10"]'));
    if(process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.OPEN_TASK_SCREENSHOTS+'/acceptance-phone.png'});}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.click('[data-acceptance-back]');await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-helper="3"]');await page.click('[data-acceptance-next]');
    assert.ok(await page.$('[data-acceptance-pool=""] [data-acceptance-child="10"]'));
    await page.click('[data-acceptance-cancel]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,0);
  }finally{await page.close();}
});
test('helper denial still asks question and permits self acceptance',async()=>{
  const page=await mount({helpers:false});try{
    assert.ok(await page.$('[data-acceptance-helper-unavailable]'));assert.equal(await page.$('[data-acceptance-helper]'),null);
    await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[0].coassignee_ids,[]);
  }finally{await page.close();}
});
test('uncertain retry reuses exact operation, while conflict requires reload and fresh confirmation',async()=>{
  const page=await mount();try{
    await page.click('[data-acceptance-next]');failure=503;await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-retry]');await page.click('[data-acceptance-retry]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[1],writes[0]);
    await page.click('#start');await page.waitForSelector('[data-acceptance-next]');await page.click('[data-acceptance-next]');failure=409;await page.click('[data-acceptance-confirm]');await page.waitForSelector('[data-acceptance-reload]');const previous=writes.at(-1).operation_id;projection.expected_revision=8;await page.click('[data-acceptance-reload]');await page.waitForSelector('[data-acceptance-next]');assert.equal(writes.length,3);await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.at(-1).expected_revision,8);assert.notEqual(writes.at(-1).operation_id,previous);
  }finally{await page.close();}
});
test('context ending discards local allocation without a request',async()=>{
  const page=await mount();try{await page.click('[data-acceptance-helper="2"]');await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,0);}finally{await page.close();}
});

for(const touch of [false,true])test(`${touch?'touch':'mouse'} drag allocates a step to a helper without saving until confirmation`,async()=>{
  const page=await mount();try{
    await page.click('[data-acceptance-helper="2"]');await page.click('[data-acceptance-next]');
    const source=await(await page.$('[data-acceptance-drag="10"]')).boundingBox(),target=await(await page.$('[data-acceptance-pool="2"]')).boundingBox();
    const x=source.x+source.width/2,y=source.y+source.height/2,tx=target.x+target.width/2,ty=target.y+70;
    if(touch){const cdp=await page.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let step=1;step<=6;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+(tx-x)*step/6,y:y+(ty-y)*step/6}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
    else{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:6});await page.mouse.up();}
    assert.ok(await page.$('[data-acceptance-pool="2"] [data-acceptance-child="10"]'));assert.equal(writes.length,0);
    if(!touch&&process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:process.env.OPEN_TASK_SCREENSHOTS+'/acceptance-desktop.png'});}
    await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.deepEqual(writes[0].subtask_assignments,[{id:10,user_id:2}]);
  }finally{await page.close();}
});
