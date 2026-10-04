import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const app=express();let browser,server,base,reads,writes,permissions,futureOffer;
const task={id:7,title:'Prepare the garden',description:'Choose this regular task to help outside.',category:'household',assigned_to:null,assigned_users:[],created_by:1,revision:4,visibility:'all',status:'open',priority:'none',points:5,tags:[],subtasks:[],is_offer:true,permissions:{view:true,accept:true,complete:false,edit:false,delete_archive:false}};
const note={id:1,title:'Family plans',content:'Dinner at six.',visibility:'all',revision:1,color:'#EFE3BE',permissions:{view:true,edit:true,delete:true},layout:{x:0,y:0,width:4,height:6,revision:0}};
const links=[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>m[0]).join('');
app.use(express.json());app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/open-board-test',(_q,r)=>r.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<link rel="stylesheet" href="/styles/notes.css"><script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1',(req,res)=>{
  reads.push(req.originalUrl);
  if(req.path==='/auth/me')return res.json({user:{id:1,role:'admin'},permissions,csrfToken:'fixture'});
  if(req.path==='/notes')return res.json({data:[note]});
  if(req.path==='/tasks') {
    if(futureOffer && req.query.offers==='1') {
      const waiting=futureOffer.reads++===0;
      return res.json({data:waiting?[]:[task],visibility:{server_now:1000,next_start_at:waiting?1300:null}});
    }
    return res.json({data:[task]});
  }
  if(req.path==='/tasks/7')return res.json({data:task});
  if(req.path==='/tasks/7/acceptance')return res.json({data:{task,expected_revision:4,primary_mode:'self',primary_user_id:1,primary_candidates:[{id:1,display_name:'Alex'}],can_add_helpers:false,coassignee_candidates:[],subtasks:[],subtask_snapshot:[]}});
  if(req.path==='/tasks/7/accept'){writes.push(req.body);return res.json({data:{...task,is_offer:false,assigned_to:1}});}
  if(req.path==='/tasks/meta/options')return res.json({users:[{id:1,display_name:'Alex'}],categories:[{key:'household',name:'Household'}],tags:[]});
  if(req.path==='/preferences')return res.json({data:{}});
  if(req.path==='/automation/activity-options')return res.json({data:{activities:[],skills:[]}});
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount(width=1280,{denied=false,tasks=false,future=false,height=900,touch=false}={}){
  reads=[];writes=[];futureOffer=future?{reads:0}:null;permissions=denied?{modules:{notes:'write',tasks:'none'}}:tasks?{modules:{notes:'none',tasks:'read'}}:{admin:true};
  const page=await browser.newPage();page.setDefaultTimeout(6000);await page.setViewport({width,height,isMobile:touch,hasTouch:touch});
  // Loopback server is reachable in this isolated network-none container.
  if(future)await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'onLine',{get:()=>true}));
  await page.goto(base+'/open-board-test'+(tasks?'?offers=1&view=list':''));
  await page.evaluate(async({permissions,tasks})=>{localStorage.clear();localStorage.setItem('yuvomi-locale','en');window.yuvomi={showToast(){}};window.EventSource=class{addEventListener(){}close(){}};await(await import('/i18n.js')).initI18n();(await import('/permissions.js')).setPermissions(permissions);window.stopPage=await(await import(tasks?'/pages/tasks.js':'/pages/notes.js')).render(document.querySelector('#main-content'),{user:{id:1,role:'admin'}});},{permissions,tasks});
  return page;
}
for(const width of [780,840])test(`short landscape ${width}x360 keeps full task cards in the page scroll`,async()=>{
  const page=await mount(width,{height:360,touch:true});try{
    await page.waitForSelector('[data-open-task="7"]');
    // Reserve the paired banner above the real module styles, as in the app shell.
    await page.$eval('#main-content',el=>{el.classList.add('app-content');el.style.height='calc(100dvh - 64px)';});
    const size=await page.evaluate(()=>{const panel=document.querySelector('.notes-open-tasks'),card=panel.querySelector('[data-open-task]'),notes=document.querySelector('.notes-scroll'),main=document.querySelector('#main-content');return {panel:panel.clientHeight,panelContent:panel.scrollHeight,card:card.getBoundingClientRect().height,notes:notes.clientHeight,note:notes.querySelector('.note-card').getBoundingClientRect().height,page:main.clientHeight,pageContent:main.scrollHeight};});
    assert.ok(size.panel>=size.panelContent-1,'task section must not become a nested scroll trap: '+JSON.stringify(size));
    assert.ok(size.panel>=size.card,'a whole task card fits in its section');
    assert.ok(size.notes>=size.note,'Notes grows with its cards instead of sharing a tiny remainder');
    assert.ok(size.pageContent>size.page,'the page carries the overflow');
    await page.$eval('[data-open-task="7"]',el=>el.scrollIntoView({block:'center'}));
    const target=await page.$eval('[data-open-task="7"]',el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,top:r.top,bottom:r.bottom};});
    assert.ok(target.top>=0&&target.bottom<=360,'whole card can be brought into view');
    await page.touchscreen.tap(target.x,target.y);await page.waitForSelector('#task-detail-claim');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [390,1440])test(`Notes and ordinary offers share the page at ${width}px without sharing layout`,async()=>{
  const page=await mount(width);try{
    await page.waitForSelector('[data-open-task="7"]');assert.ok(await page.$('.note-card'));
    const geometry=await page.evaluate(()=>{const n=document.querySelector('.notes-scroll').getBoundingClientRect(),o=document.querySelector('#notes-open-tasks').getBoundingClientRect();return {nt:n.top,nr:n.right,ot:o.top,ol:o.left,ob:o.bottom,scroll:document.documentElement.scrollWidth,width:innerWidth};});
    if(width<1400)assert.ok(geometry.ob<=geometry.nt+1);else assert.ok(geometry.nr<=geometry.ol+1);
    assert.ok(geometry.scroll<=geometry.width+1);
    if(process.env.OPEN_TASK_SCREENSHOTS){mkdirSync(process.env.OPEN_TASK_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.OPEN_TASK_SCREENSHOTS}/notes-open-tasks-${width}.png`});}
    await page.click('[data-open-task="7"]');await page.waitForSelector('#task-detail-claim');assert.ok(await page.$('.detail-view__pane'));
    await page.click('#task-detail-claim');await page.waitForSelector('[data-acceptance-helper-unavailable]');await page.click('[data-acceptance-next]');await page.click('[data-acceptance-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-task-acceptance]'));assert.equal(writes.length,1);
    assert.ok(!reads.some(path=>path.includes('/notes/')&&path.includes('layout')));
  }finally{await page.close();}
});
test('Notes does not request or expose Tasks when that module is denied',async()=>{
  const page=await mount(1280,{denied:true});try{assert.ok(await page.$('.note-card'));assert.equal(await page.$('[data-open-task]'),null);assert.equal(reads.some(path=>path.includes('/tasks')),false);}finally{await page.close();}
});
test('Tasks has an independent open filter and normal details without Notes access',async()=>{
  const page=await mount(1280,{tasks:true});try{
    await page.waitForSelector('.task-card');assert.ok(reads.some(path=>path.startsWith('/api/v1/tasks?')&&path.includes('offers=1')));assert.equal(reads.some(path=>path.includes('/notes')),false);
    await page.click('#filter-toggle-btn');await page.waitForSelector('#filter-open-tasks');assert.equal(await page.$eval('#filter-open-tasks',el=>el.getAttribute('aria-pressed')),'true');
    const previous=reads.length;await page.click('#filter-open-tasks');await page.waitForFunction(()=>document.querySelector('#filter-open-tasks').getAttribute('aria-pressed')==='false');await page.waitForNetworkIdle({idleTime:100});assert.ok(reads.slice(previous).some(path=>path.startsWith('/api/v1/tasks?')&&!path.includes('offers='))||reads.slice(previous).includes('/api/v1/tasks'));
  }finally{await page.close();}
});

test('Notes offers refresh at the server visibility boundary without an event or navigation',async()=>{
  const page=await mount(1280,{future:true});try{
    await page.waitForSelector('.open-task-board');
    assert.equal(await page.$('[data-open-task="7"]'),null,'future offer starts hidden');
    await page.waitForSelector('[data-open-task="7"]',{timeout:1500});
    assert.equal(futureOffer.reads,2,'visibility envelope arms one canonical re-read');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
