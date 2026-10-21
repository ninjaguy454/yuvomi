import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import express from 'express';
import puppeteer from 'puppeteer';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';

test('Task card paints after confirmation, preserves pending across reads, and retries a rejected change from fresh state',{timeout:60000},async t=>{
  const fixture=await scoringFixture(t);
  const created=await fixture.create({title:'Immediate status',assigned_to:[1],points:0});
  assert.equal(created.status,201);
  const id=created.data.id;
  const second=await fixture.create({title:'Rejected status',assigned_to:[1],points:0});
  assert.equal(second.status,201);
  const secondId=second.data.id;
  const third=await fixture.create({title:'Concurrent status',assigned_to:[1],points:0});
  assert.equal(third.status,201);
  const thirdId=third.data.id;
  const fourth=await fixture.create({title:'Saved before list failure',assigned_to:[1],points:0});
  assert.equal(fourth.status,201);
  const fourthId=fourth.data.id;
  const fixtureSize=Number(process.env.VIDAMIA_STATUS_FEEDBACK_COUNT||4);
  assert.ok(Number.isInteger(fixtureSize)&&fixtureSize>=4&&fixtureSize<=800);
  fixture.d.transaction(()=>{for(let index=4;index<fixtureSize;index++){
    const taskId=Number(fixture.d.prepare("INSERT INTO tasks(title,created_by,assigned_to,points) VALUES('Synthetic feedback task',1,1,0)").run().lastInsertRowid);
    fixture.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(taskId);
  }})();
  let held=null,release=null,signal=null,rejectNext=false,rejectAtWrite=null,failNextList=false,denyNextWindow=false,writes=0,windowReads=0;
  let holdWindowOffset=null,heldWindowSignal=null,releaseWindow=null;
  let rejectContinuationOffset=null,rejectedContinuations=0;
  const windowReplies=[];
  const writeDurations=[];
  const app=express();app.use(express.json());
  app.use('/api/v1',async(req,res)=>{
    if(req.method==='GET'&&req.path==='/tasks/window')windowReads++;
    if(req.method==='GET'&&req.path==='/tasks/window'&&req.query.page_cursor&&rejectContinuationOffset!==null){
      const offset=JSON.parse(req.query.view||'{}').offset||0;
      if(offset===rejectContinuationOffset){rejectedContinuations++;return res.json({reset_required:true,reason:'synthetic_stale_continuation'});}
    }
    if(req.path==='/automation/activity-options')return res.json({data:{activities:[],rotation_groups:[],skills:[]}});
    if(req.path==='/planning/place-search/status')return res.json({data:{configured:false}});
    if(req.path==='/planning/places'||req.path==='/automation/obligations')return res.json({data:[]});
    if(req.path==='/preferences')return res.json({data:{}});
    if(req.path==='/tasks/window'&&denyNextWindow){denyNextWindow=false;return res.status(403).json({error:'Permission changed.'});}
    if(['/tasks','/tasks/window'].includes(req.path)&&req.method==='GET'&&failNextList){failNextList=false;return res.status(503).json({error:'Temporary list failure.'});}
    if(/^\/tasks\/\d+\/status$/.test(req.path)&&req.method==='PATCH'){
      writes++;
      if(rejectNext||rejectAtWrite===writes){rejectNext=false;rejectAtWrite=null;
        return res.status(409).json({error:'Changed on another device.'});}
      const writeStart=performance.now();
      const answer=await fixture.call(req.method,req.url,req.body);
      writeDurations.push(performance.now()-writeStart);
      if(!held){held=answer;signal?.();await new Promise(resolve=>{release=resolve;});}
      return res.status(answer.status).json(answer);
    }
    const answer=await fixture.call(req.method,req.url,['GET','HEAD'].includes(req.method)?undefined:req.body);
    if(req.method==='GET'&&req.path==='/tasks/window'&&holdWindowOffset!==null&&!req.query.window_delta){
      const offset=JSON.parse(req.query.view||'{}').offset||0;
      if(offset===holdWindowOffset){holdWindowOffset=null;heldWindowSignal?.();await new Promise(resolve=>{releaseWindow=resolve;});}
    }
    if(req.method==='GET'&&req.path==='/tasks/window')windowReplies.push({status:answer.status,error:answer.error,delta:answer.delta,reason:answer.reason,reset:answer.reset_required,no_change:answer.no_change,count:answer.data?.length});
    res.status(answer.status).json(answer);
  });
  const root=join(import.meta.dirname,'..');app.use(express.static(join(root,'public')));
  const links=[...readFileSync(join(root,'public/index.html'),'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(match=>match[0]).join('');
  app.get('/status-feedback',(_req,res)=>res.send(`<!doctype html><html lang="en" data-theme="light"><head>${links}<link rel="stylesheet" href="/styles/tasks.css"><script src="/lucide.min.js" defer></script></head><body><main id="fixture"></main></body></html>`));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{release?.();releaseWindow?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',args:['--no-sandbox','--disable-dev-shm-usage']});
  t.after(async()=>browser.close());
  const page=await browser.newPage();await page.setViewport({width:390,height:844});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/status-feedback`);
  await page.evaluate(async()=>{
    localStorage.setItem('yuvomi-lang','en');window.toasts=[];window.yuvomi={showToast:message=>window.toasts.push(message),user:{id:1,role:'admin'}};
    window.EventSource=class{addEventListener(){}close(){}};
    const {initI18n,setLocale}=await import('/i18n.js');await initI18n();await setLocale('en');
    await import('/components/datepicker.js');
    const {setPermissions}=await import('/permissions.js');setPermissions({admin:true,capabilities:{'tasks.create':'allow'}});
    const {render}=await import('/pages/tasks.js');await render(document.querySelector('#fixture'),{user:{id:1,role:'admin'}});
  });
  const button=`[data-action="toggle-status"][data-id="${id}"]`;
  const button2=`[data-action="toggle-status"][data-id="${secondId}"]`;
  await page.waitForSelector(button);
  if(fixtureSize>30){
    const first=await page.evaluate(async()=>{
      const {__test}=await import('/pages/tasks.js');
      return {loaded:__test.state.tasks.length,total:__test.state.taskWindow?.total};
    });
    assert.deepEqual(first,{loaded:30,total:fixtureSize});
    await page.click('#task-window-more');
    await page.waitForFunction(async()=>{
      const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===60;
    });
    if(fixtureSize<=60)assert.equal(await page.$('#task-window-more'),null);
    await page.click('#tasks-search-toggle');
    await page.$eval('#tasks-search',input=>{input.value='Synthetic feedback task';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(async count=>{
      const {__test}=await import('/pages/tasks.js');
      return __test.state.taskWindow?.total===count&&__test.state.tasks.length===30;
    },{},fixtureSize-4);
    await page.$eval('#tasks-search',input=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(async count=>{
      const {__test}=await import('/pages/tasks.js');return __test.state.taskWindow?.total===count;
    },{},fixtureSize);
    if(fixtureSize>=90){
      await page.$eval('#task-window-more',node=>node.click());
      await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===60;});
      rejectContinuationOffset=60;
      const toastsBefore=await page.evaluate(()=>window.toasts.length);
      await page.click('#task-window-more');
      await page.waitForFunction(before=>window.toasts.length>before,{timeout:10000},toastsBefore);
      assert.equal(rejectedContinuations,3,'a persistently rejected next page has bounded automatic retries');
      assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;}),60);
      rejectContinuationOffset=null;
      await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return !__test.state.taskWindow?.loading;});
      await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');await __test.loadTasks(document.querySelector('#fixture'));});
      assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;}),60);
      await page.$eval('#task-window-more',node=>{node.focus();node.click();});
      try{await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===90;},{timeout:5000});}
      catch(error){console.log('RESET_RECOVERY_DIAGNOSTIC',JSON.stringify(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return {length:__test.state.tasks.length,window:__test.state.taskWindow,loadError:__test.state.loadError?.message,toasts:window.toasts.slice(-3)};})),windowReplies.slice(-12));throw error;}
      if(fixtureSize===90){
        assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-window-status','keyboard focus moves to end-of-results status');
      }
      if(fixtureSize>90){
        if(fixtureSize>=120){
          // A refresh must not publish its older 90-card snapshot after an
          // explicit Load more has already extended the visible window.
          await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');__test.state.taskWindow.delta_cursor=null;});
          let heldWindow=new Promise(resolve=>{heldWindowSignal=resolve;});holdWindowOffset=0;
          await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');void __test.loadTasks(document.querySelector('#fixture'));});
          await heldWindow;
          await page.click('#task-window-more');
          await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===120;});
          releaseWindow();releaseWindow=null;
          await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===120&&!__test.state.taskWindow.loading;});
          // Inverse order: an old Load more response still represents a user
          // intent after a refresh has replaced the signed window object.
          if(fixtureSize>=150){
            await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');__test.state.taskWindow.delta_cursor=null;});
            heldWindow=new Promise(resolve=>{heldWindowSignal=resolve;});holdWindowOffset=120;
            await page.$eval('#task-window-more',node=>node.click());
            await heldWindow;
            await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');await __test.loadTasks(document.querySelector('#fixture'));});
            releaseWindow();releaseWindow=null;
            await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length===150;});
          }
        }
        await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
          __test.state.bulkSelectMode=true;__test.state.selectedTaskIds.add(__test.state.tasks[70].id);
          __test.renderTaskList(document.querySelector('#fixture'));
        });
        await page.click('#tasks-search-toggle');
        await page.$eval('#tasks-search',input=>{input.value='Synthetic feedback task';input.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return !__test.state.bulkSelectMode;});
        assert.equal(await page.evaluate(()=>window.toasts.some(message=>message.includes('Task selection changed'))),true);
        await page.$eval('#tasks-search',input=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));});
        await page.waitForFunction(async count=>{const {__test}=await import('/pages/tasks.js');return __test.state.taskWindow?.total===count;},{},fixtureSize);
      }
    }
    if(process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1'){
      for(let pageIndex=0;pageIndex<Math.ceil(fixtureSize/30);pageIndex++){
        if(!await page.$('#task-window-more'))break;
        const before=await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;});
        await page.click('#task-window-more');
        await page.waitForFunction(async previous=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length>previous;},{},before);
      }
      assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;}),fixtureSize);
    }
  }
  if(process.env.VIDAMIA_TEST_NETWORK_LATENCY_MS){
    const devtools=await page.createCDPSession();
    await devtools.send('Network.enable');
    await devtools.send('Network.emulateNetworkConditions',{offline:false,
      latency:Number(process.env.VIDAMIA_TEST_NETWORK_LATENCY_MS),
      downloadThroughput:300000,uploadThroughput:300000});
  }
  const heldPromise=new Promise(resolve=>{signal=resolve;});
  await page.$eval(button,node=>{window.statusInputAt=performance.now();node.click();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.statusPaintAt=performance.now();}));});
  await heldPromise;
  await page.waitForFunction(()=>window.statusPaintAt>0);
  const paintMs=await page.evaluate(()=>window.statusPaintAt-window.statusInputAt);
  if(fixtureSize<=600)assert.ok(paintMs<100,`visible frame after ${paintMs.toFixed(1)} ms`);
  else console.log('TASK_STRESS_FIRST_FRAME_MS',paintMs.toFixed(1));
  const pending=await page.$eval(button,node=>({done:node.classList.contains('task-status-btn--done'),busy:node.getAttribute('aria-busy'),disabled:node.disabled,feedback:node.nextElementSibling?.textContent}));
  assert.deepEqual(pending,{done:true,busy:'true',disabled:true,feedback:'Saving…'});
  await page.evaluate(id=>{for(let i=0;i<3;i++)document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`).click();window.dispatchEvent(new Event('task-data-changed'));},id);
  assert.equal(writes,1);
  await page.waitForFunction(id=>document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`)?.getAttribute('aria-busy')==='true',{},id);
  release();release=null;
  await page.waitForFunction(id=>!document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`),{timeout:5000},id);
  await page.click('#filter-toggle-btn');
  await page.click('[data-filter="status"][data-value="done"]');
  await page.waitForSelector(button);
  assert.equal(await page.$eval(button,node=>node.disabled),false,'reentering a completed filter has no stuck pending feedback');
  assert.equal(await page.$eval(button,node=>node.getAttribute('aria-busy')),null);
  rejectNext=true;
  await page.$eval(button2,node=>node.click());
  await page.waitForFunction(id=>document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`)?.nextElementSibling?.textContent.includes('Not saved'),{},secondId);
  assert.equal(await page.$eval(button2,node=>node.classList.contains('task-status-btn--open')),true,'rejected intent restores canonical status');
  assert.equal(await page.$eval(button2,node=>node.disabled),false);
  await page.$eval(button2,node=>node.click());
  await page.waitForFunction(id=>!document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`)?.nextElementSibling?.textContent.includes('Not saved'),{},secondId);
  assert.equal(writes,2,'refreshing a rejected intent does not issue a new write');
  await page.$eval(button2,node=>node.click());
  await page.waitForFunction(id=>{const button=document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`);return button?.classList.contains('task-status-btn--done')&&button.getAttribute('aria-busy')==='false';},{timeout:5000},secondId);
  assert.equal(writes,3,'one rejected request plus one deliberate retry');
  const otherClient=await fixture.call('PATCH',`/tasks/${thirdId}/status`,{status:'done',expected_revision:third.data.revision});
  assert.equal(otherClient.status,200);
  rejectNext=true;
  const button3=`[data-action="toggle-status"][data-id="${thirdId}"]`;
  await page.$eval(button3,node=>node.click());
  await page.waitForFunction(id=>document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`)?.nextElementSibling?.textContent.includes('Not saved'),{},thirdId);
  await page.$eval(button3,node=>node.click());
  await page.waitForFunction(id=>{const button=document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`);return button?.classList.contains('task-status-btn--done')&&button.getAttribute('aria-busy')==='false';}, {},thirdId);
  assert.equal(writes,4,'refresh after 409 never reverses another client completion');
  assert.equal(await page.$eval(button3,node=>node.classList.contains('task-status-btn--done')),true);
  const button4=`[data-action="toggle-status"][data-id="${fourthId}"]`;
  failNextList=true;
  await page.$eval(button4,node=>node.click());
  await page.waitForFunction(id=>document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`)?.nextElementSibling?.textContent.includes('Tap to refresh'),{},fourthId);
  assert.equal(await page.$eval(button4,node=>node.disabled),false,'saved write with failed list read exposes refresh action');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'feedback fits the mobile viewport');
  await page.$eval(button4,node=>node.click());
  await page.waitForFunction(id=>{const button=document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`);return button?.classList.contains('task-status-btn--done')&&button.getAttribute('aria-busy')==='false';},{timeout:5000},fourthId);
  assert.equal(writes,5,'refresh after acknowledged write does not write again');
  if(process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1'){
    await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      __test.state.filters={status:['open','in_progress','done'],priority:[],assigned_to:[],tags:[]};
      await __test.loadTasks(document.querySelector('#fixture'),{full:true});
    });
    for(let pageIndex=0;pageIndex<Math.ceil(fixtureSize/30);pageIndex++){
      if(!await page.$('#task-window-more'))break;
      const before=await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;});
      await page.$eval('#task-window-more',node=>node.click());
      try{await page.waitForFunction(async previous=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length>previous;},{timeout:3000},before);}
      catch(error){console.log('LOAD_ALL_DIAGNOSTIC',await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return {length:__test.state.tasks.length,total:__test.state.taskWindow?.total,next:__test.state.taskWindow?.next_offset,key:__test.state.taskWindow?.key,loadError:__test.state.loadError?.message,toasts:window.toasts.slice(-3)};}));throw error;}
    }
    assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;}),fixtureSize);
  }
  const paintSamples=[paintMs],saveSamples=[],readsBefore=windowReads;
  for(let sample=0;sample<19;sample++){
    const prior=await page.$eval(button4,node=>node.dataset.status);
    await page.$eval(button4,node=>{window.statusPaintAt=0;window.statusInputAt=performance.now();node.click();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.statusPaintAt=performance.now();}));});
    await page.waitForFunction(()=>window.statusPaintAt>0);
    paintSamples.push(await page.evaluate(()=>window.statusPaintAt-window.statusInputAt));
    await page.waitForFunction(({id,prior})=>{const node=document.querySelector(`[data-action="toggle-status"][data-id="${id}"]`);return node&&!node.disabled&&node.dataset.status!==prior&&node.getAttribute('aria-busy')==='false';},{timeout:5000},{id:fourthId,prior});
    saveSamples.push(await page.evaluate(()=>performance.now()-window.statusInputAt));
  }
  const summary=values=>{const sorted=[...values].sort((a,b)=>a-b),at=q=>Math.round(sorted[Math.ceil(q*sorted.length)-1]*10)/10;return {n:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99),max:at(1)};};
  const kinds=windowReplies.slice(-(windowReads-readsBefore)).reduce((counts,item)=>{
    const key=item.status!==200?`error:${item.status}:${item.error}`:item.reset?`reset:${item.reason}`:item.delta?`delta:${item.no_change?'quiet':item.count}`:`page:${item.count}`;
    counts[key]=(counts[key]||0)+1;return counts;
  },{});
  if(process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1'&&fixtureSize<=600)
    assert.deepEqual({reads:windowReads-readsBefore,changed:kinds['delta:1']},{reads:19,changed:19},
      'a fully loaded ordinary List uses one authorized changed-row window read per confirmed status');
  if(process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1'&&fixtureSize>600)
    assert.ok(windowReads-readsBefore>19&&Object.keys(kinds).every(key=>key.startsWith('page:')),
      'a window larger than the bounded receipt safely refills pages');
  console.log('TASK_STATUS_FEEDBACK_SAMPLES',JSON.stringify({fixture_tasks:fixtureSize,loaded_all:process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1',viewport:'390x844',paint_frame_ms:summary(paintSamples),confirmed_stable_ms:summary(saveSamples),server_write_ms:summary(writeDurations),window_reads_for_19_statuses:windowReads-readsBefore,window_reply_kinds:kinds}));
  if(process.env.VIDAMIA_STATUS_FEEDBACK_BULK==='1'){
    assert.equal(fixtureSize,250,'bulk stress uses the fully loaded cross-page fixture');
    const selected=await page.evaluate(async()=>{
      const {__test}=await import('/pages/tasks.js');
      const candidates=__test.state.tasks.filter(row=>row.status!=='done');
      const ids=Array.from({length:12},(_,index)=>candidates[Math.floor(index*(candidates.length-1)/11)].id);
      __test.state.bulkSelectMode=true;
      for(const id of ids)__test.state.selectedTaskIds.add(id);
      __test.renderTaskList(document.querySelector('#fixture'));
      return ids;
    });
    assert.equal(new Set(selected).size,12);
    const beforeWrites=writes,beforeReads=windowReads;
    await page.$eval('#bulk-mark-done',button=>{window.bulkInputAt=performance.now();button.click();
      requestAnimationFrame(()=>requestAnimationFrame(()=>{window.bulkFrameAt=performance.now();
        window.bulkFrameState={selected:document.querySelector('#bulk-count')?.textContent,
          busy:button.getAttribute('aria-busy'),disabled:button.disabled};}));});
    await page.waitForFunction(()=>window.bulkFrameAt>0);
    const first=await page.evaluate(()=>({ms:window.bulkFrameAt-window.bulkInputAt,state:window.bulkFrameState}));
    await page.waitForFunction(async ids=>{
      const {__test}=await import('/pages/tasks.js');
      return !__test.state.bulkActionBusy&&__test.state.selectedTaskIds.size===0
        &&ids.every(id=>__test.state.tasks.find(row=>row.id===id)?.status==='done');
    },{timeout:15000},selected);
    const confirmedMs=await page.evaluate(()=>performance.now()-window.bulkInputAt);
    assert.equal(first.state.busy,'true','bulk action exposes its pending state before confirmation');
    assert.equal(first.state.disabled,true,'a pending bulk action cannot be submitted twice');
    assert.match(first.state.selected,/saving/i);
    assert.equal(await page.$eval('#bulk-mark-done',button=>button.getAttribute('aria-busy')),'false');
    assert.equal(writes-beforeWrites,12,'bulk cross-page selection sends one authorized status write per selected Task');
    assert.equal(selected.filter(id=>fixture.d.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status==='done').length,12);
    console.log('TASK_BULK_STATUS_SAMPLE',JSON.stringify({fixture_tasks:fixtureSize,selected:12,
      first_frame_ms:first.ms,first_frame_state:first.state,confirmed_stable_ms:confirmedMs,
      patch_requests:writes-beforeWrites,window_reads:windowReads-beforeReads}));
    const retryIds=await page.evaluate(async()=>{
      const {__test}=await import('/pages/tasks.js');
      const ids=__test.state.tasks.filter(row=>row.status==='open').slice(0,2).map(row=>row.id);
      __test.state.bulkSelectMode=true;
      for(const id of ids)__test.state.selectedTaskIds.add(id);
      __test.renderTaskList(document.querySelector('#fixture'));
      return ids;
    });
    assert.equal(retryIds.length,2);
    await page.waitForFunction(()=>{const button=document.querySelector('#bulk-mark-done');
      return button&&!button.disabled&&button.getAttribute('aria-busy')==='false';},{timeout:5000});
    const retryWrites=writes,toasts=await page.evaluate(()=>window.toasts.length);
    rejectAtWrite=retryWrites+2;
    // Selection is injected across distant pages; dispatch this synthetic retry
    // on the control itself without relying on its offscreen scroll position.
    await page.$eval('#bulk-mark-done',button=>button.click());
    await page.waitForFunction(()=>document.querySelector('#bulk-mark-done')?.getAttribute('aria-busy')==='false',
      {timeout:5000});
    const failure=await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      return {toasts:window.toasts.length,selected:__test.state.selectedTaskIds.size,
        busy:__test.state.bulkActionBusy,disabled:document.querySelector('#bulk-mark-done')?.disabled,
        lastToast:window.toasts.at(-1)};});
    failure.writes=writes-retryWrites;
    assert.ok(failure.toasts>toasts,`failed bulk operation shows feedback: ${JSON.stringify(failure)}`);
    assert.equal(writes-retryWrites,2,'the second bulk item rejects without an automatic replay');
    assert.deepEqual(retryIds.map(id=>fixture.d.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status),
      ['done','open'],'only the first item committed before the conflict');
    assert.equal(await page.evaluate(async id=>{const {__test}=await import('/pages/tasks.js');
      return __test.state.tasks.find(row=>row.id===id)?.status;},retryIds[0]),'done',
      'failure refreshes the already committed item before retry');
    assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      return __test.state.selectedTaskIds.size;}),2,'failed bulk work stays selected for deliberate retry');
    assert.equal(await page.$eval('#bulk-mark-done',button=>button.disabled),false);
    await page.$eval('#bulk-mark-done',button=>button.click());
    await page.waitForFunction(async ids=>{const {__test}=await import('/pages/tasks.js');
      return !__test.state.bulkActionBusy&&__test.state.selectedTaskIds.size===0
        &&ids.every(id=>__test.state.tasks.find(row=>row.id===id)?.status==='done');
    },{},retryIds);
    assert.equal(writes-retryWrites,3,'deliberate retry writes only the unfinished item');
    assert.ok(retryIds.every(id=>fixture.d.prepare('SELECT status FROM tasks WHERE id=?').get(id)?.status==='done'));
  }
  if(fixtureSize===500&&process.env.VIDAMIA_STATUS_FEEDBACK_LOAD_ALL==='1'){
    const before=await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      const selected=__test.state.tasks[300],changed=__test.state.tasks[310];
      __test.state.bulkSelectMode=true;__test.state.selectedTaskIds.add(selected.id);
      __test.renderTaskList(document.querySelector('#fixture'));
      const prior=document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior='auto';
      scrollTo(0,Math.min(1800,document.documentElement.scrollHeight-innerHeight-100));
      document.documentElement.style.scrollBehavior=prior;
      return {selected:selected.id,changed:changed.id,revision:changed.revision,scrollY};});
    const outside=await fixture.call('PATCH',`/tasks/${before.changed}/status`,
      {status:'done',expected_revision:before.revision});
    assert.equal(outside.status,200);
    const reads=windowReads;
    await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      await __test.loadTasks(document.querySelector('#fixture'));});
    const after=await page.evaluate(async ids=>{const {__test}=await import('/pages/tasks.js');
      return {selected:__test.state.selectedTaskIds.has(ids.selected),count:__test.state.selectedTaskIds.size,
        scrollY,loaded:__test.state.tasks.length,changedStatus:__test.state.tasks.find(row=>row.id===ids.changed)?.status};},before);
    assert.equal(after.count,1,'an unrelated changed row keeps the cross-page bulk selection');
    assert.equal(after.selected,true);
    assert.equal(after.changedStatus,'done');
    assert.match(await page.$eval('#bulk-count',node=>node.textContent),/1/);
    assert.equal(after.loaded,500);
    assert.equal(windowReads-reads,1,'the external edit uses one loaded-window delta');
    assert.ok(Math.abs(after.scrollY-before.scrollY)<50,
      `delta keeps the mobile-size scroll position: ${JSON.stringify({before:before.scrollY,after:after.scrollY})}`);
    await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');
      __test.state.selectedTaskIds.clear();__test.state.bulkSelectMode=false;
      __test.renderTaskList(document.querySelector('#fixture'));});
  }
  if(fixtureSize>30){
    failNextList=true;
    await page.click('#task-view-btn');
    await page.click('[data-task-view="kanban"]');
    await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.loadError?.status===503;});
    assert.deepEqual(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return {cards:document.querySelectorAll('article[data-task-id]').length,rows:__test.state.tasks.length,window:__test.state.taskWindow};}),
      {cards:0,rows:0,window:null},'a failed full-view read cannot present a partial List page as Kanban');
    await page.click('#task-view-btn');
    await page.click('[data-task-view="list"]');
    await page.waitForFunction(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.taskWindow?.total>30&&__test.state.tasks.length===30;});
    denyNextWindow=true;
    await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');try{await __test.loadTasks(document.querySelector('#fixture'));}catch{}});
    assert.equal(await page.evaluate(async()=>{const {__test}=await import('/pages/tasks.js');return __test.state.tasks.length;}),0);
    assert.equal(await page.$('#task-window-more'),null,'permission loss removes old continuation');
  }
  assert.deepEqual(errors,[]);
});
