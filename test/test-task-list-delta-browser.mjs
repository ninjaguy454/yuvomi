import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

test('mounted Tasks page discards a delayed delta after a newer edit',{timeout:60000},async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Before concurrent edits',assigned_to:[2],points:0});
  assert.equal(created.status,201);const targetId=created.data.id;
  let holdNext=false,releaseFirst=null,firstPending=null;
  const deltaRequests=[];
  const app=express();app.use(express.json());
  app.use('/api/v1',async(req,res)=>{
    if(req.path==='/automation/activity-options')return res.json({data:{activities:[],rotation_groups:[],skills:[]}});
    if(req.path==='/planning/place-search/status')return res.json({data:{configured:false}});
    if(req.path==='/planning/places')return res.json({data:[]});
    if(req.path==='/preferences')return res.json({data:{}});
    if(req.path==='/automation/obligations')return res.json({data:[]});
    const answer=await f.call(req.method,req.url,['GET','HEAD'].includes(req.method)?undefined:req.body);
    if(req.path==='/tasks'&&req.query.delta){
      deltaRequests.push(req.originalUrl);
      if(holdNext){holdNext=false;firstPending?.();await new Promise(resolve=>{releaseFirst=resolve;});}
    }
    res.status(answer.status).json(answer);
  });
  const root=join(import.meta.dirname,'..');app.use(express.static(join(root,'public')));
  const links=[...readFileSync(join(root,'public/index.html'),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(match=>match[0]).join('');
  app.get('/delta-browser',(_req,res)=>res.send(`<!doctype html><html lang="en" data-theme="light"><head>${links}<link rel="stylesheet" href="/styles/tasks.css"><link rel="stylesheet" href="/styles/settings.css"><script src="/lucide.min.js" defer></script></head><body><main id="fixture"></main></body></html>`));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(async()=>browser.close());
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/delta-browser`);
  await page.evaluate(async()=>{
    localStorage.setItem('yuvomi-lang','en');window.yuvomi={showToast(){},user:{id:1,role:'admin'}};
    window.EventSource=class{addEventListener(){}close(){}};
    const {initI18n,setLocale}=await import('/i18n.js');await initI18n();await setLocale('en');
    await import('/components/datepicker.js');
    const {setPermissions}=await import('/permissions.js');setPermissions({admin:true,capabilities:{'tasks.create':'allow'}});
    const {render}=await import('/pages/tasks.js');await render(document.querySelector('#fixture'),{user:{id:1,role:'admin'}});
  });
  const title=()=>page.$eval(`[data-action="open-task"][data-id="${targetId}"]`,button=>button.closest('article')?.innerText||'');
  assert.match(await title(),/Before concurrent edits/);
  const pending=new Promise(resolve=>{firstPending=resolve;});holdNext=true;
  const first=await f.edit(targetId,{title:'First remote edit'});assert.equal(first.status,200);
  await page.evaluate(()=>window.dispatchEvent(new Event('task-data-changed')));
  await pending;
  const second=await f.edit(targetId,{title:'Second remote edit'});assert.equal(second.status,200);
  await page.evaluate(()=>window.dispatchEvent(new Event('task-data-changed')));
  releaseFirst();
  await page.waitForFunction(id=>document.querySelector(`[data-action="open-task"][data-id="${id}"]`)?.closest('article')?.innerText.includes('Second remote edit'),{},targetId);
  assert.ok(deltaRequests.length>=2,'the mounted page must use the signed delta after its first full render');
  assert.ok(!(await title()).includes('First remote edit'));
  await page.$eval(`[data-action="open-task"][data-id="${targetId}"]`,button=>button.click());
  await page.waitForSelector('#detail-view-edit');
  await page.click('#detail-view-edit');await page.waitForSelector('#task-title');
  await page.$eval('#task-title',input=>{input.value='Local unsaved draft';input.dispatchEvent(new Event('input',{bubbles:true}));});
  const third=await f.edit(targetId,{title:'Third remote edit'});assert.equal(third.status,200);
  await page.evaluate(()=>window.dispatchEvent(new Event('task-data-changed')));
  await page.waitForFunction(id=>document.querySelector(`[data-action="open-task"][data-id="${id}"]`)?.closest('article')?.innerText.includes('Third remote edit'),{},targetId);
  assert.equal(await page.$eval('#task-title',input=>input.value),'Local unsaved draft');
  assert.deepEqual(errors,[]);
});
