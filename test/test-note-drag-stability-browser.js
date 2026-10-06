import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {arrangeNotesFixture} from './helpers/note-group-http-fixture.js';
import {toggleChecklistLine} from '../public/utils/markdown-checklist.js';

const app=express();app.use(express.json());app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
const links='<link rel="stylesheet" href="/styles/notes.css">'+[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/drag-test',(_req,res)=>res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}</style></head><body><main id="main-content"></main></body></html>`));
let notes,writes,mode,releaseSave,checkWrites,checkMode,holdCheck,releaseCheck,browser,server,base;
app.use('/api/v1',async(req,res)=>{
  if(req.path==='/auth/me')return res.json({csrfToken:'synthetic'});
  if(req.path==='/notes/members')return res.json({data:[{id:1,display_name:'Synthetic Parent'}]});
  if(req.path==='/notes/changes')return res.status(204).end();
  if(req.path==='/notes/board')return res.json({data:{notes,groups:[]}});
  if(req.path==='/notes/1/check'&&req.method==='PATCH'){
    checkWrites.push(structuredClone(req.body));
    if(holdCheck)await new Promise(resolve=>{releaseCheck=resolve;});
    if(checkMode==='failed')return res.status(403).json({error:'Checklist no longer allowed'});
    const result=toggleChecklistLine(notes[0].content,req.body.line,req.body.checked,req.body.expect);
    if(!result.ok)return res.status(409).json({error:'Changed elsewhere'});
    notes[0].content=result.content;notes[0].revision++;
    return res.json({data:notes[0]});
  }
  if(req.path==='/notes/group-operations'){
    writes.push(structuredClone(req.body));await new Promise(resolve=>{releaseSave=resolve;});
    if(mode==='conflict'){notes[0].layout={...notes[0].layout,x:notes[0].layout.x+1,revision:notes[0].layout.revision+1};return res.status(409).json({error:'Changed elsewhere',code:409});}
    if(mode==='failed')return res.status(403).json({error:'Layout no longer allowed',code:403});
    if(mode==='unknown'){mode='success';return res.type('json').send('{"data":');}
    const result=arrangeNotesFixture(notes,req.body);return res.status(result.status).json(result.body);
  }
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--disable-dev-shm-usage']});});
test.after(async()=>{releaseSave?.();releaseCheck?.();await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
const card='.note-card[data-id="1"]';
async function mount({reduced=false,touch=false,checklist=false}={}){
  writes=[];checkWrites=[];mode='success';checkMode='success';releaseSave=null;holdCheck=false;releaseCheck=null;
  notes=Array.from({length:5},(_,i)=>({id:i+1,title:`Synthetic ${i+1}`,content:'A plain paragraph to drag.\n\n'+Array.from({length:20},(_,j)=>`Preview line ${j}`).join('\n\n'),color:'#C7DED9',created_by:1,creator_name:'Synthetic Parent',visibility:'all',revision:4,permissions:{view:true,edit:true,arrange:true,delete:true,manage_visibility:true},layout:{x:i?8:2,y:i?20+i*8:2,width:4,height:6,revision:2}}));
  if(checklist)notes[0].content='- [ ] Synthetic checklist\n\n'+notes[0].content;
  const page=await browser.newPage();page.setDefaultTimeout(5000);await page.setViewport({width:1280,height:1000,hasTouch:touch});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]);
  await page.evaluateOnNewDocument(()=>Object.defineProperty(navigator,'onLine',{get:()=>true}));await page.goto(base+'/drag-test');
  await page.evaluate(async()=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();window.yuvomi={showToast(){}};(await import('/permissions.js')).setPermissions({admin:true});(await import('/utils/device-context.js')).acceptAuthentication({authContext:'synthetic-drag'});window.stopNotes=await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{id:1}});});
  await page.waitForSelector(card);await page.evaluate(()=>{window.originalCard=document.querySelector('.note-card[data-id="1"]');window.originalPreview=originalCard.querySelector('.note-card__content');originalPreview.scrollTop=30;originalCard.querySelector('.note-card__title').focus({preventScroll:true});});return page;
}
async function snapshot(page){return page.evaluate(()=>{const c=document.querySelector('.note-card[data-id="1"]'),r=c.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,toolbar:document.querySelector('.notes-board-toolbar').getBoundingClientRect().height,sameCard:c===originalCard,preview:c.querySelector('.note-card__content').scrollTop,focus:document.activeElement===c.querySelector('.note-card__title'),zoom:document.querySelector('#notes-zoom-value').textContent};});}
async function drag(page,dx=80,dy=50){const p=await page.$eval(card,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-55};});await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+dx,p.y+dy,{steps:8});await page.mouse.up();await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Saving layout...');return p;}
async function finish(page){releaseSave();await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');}
test('slow saves preserve the dropped rectangle, card, focus, preview scroll and toolbar across repeated drags',async()=>{
  const page=await mount();try{
    for(let i=0;i<3;i++){
      const before=await snapshot(page);await drag(page);const pending=await snapshot(page);
      assert.ok(Math.abs(pending.x-before.x-80)<1,'pending position never snaps back');assert.ok(Math.abs(pending.y-before.y-50)<1,'feedback never shifts canvas');assert.equal(pending.toolbar,before.toolbar);
      await page.evaluate(()=>{document.querySelector('.notes-scroll').style.height='500px';window.dispatchEvent(new Event('resize'));});await new Promise(r=>setTimeout(r,50));
      const resized=await snapshot(page);assert.ok(Math.abs(resized.x-pending.x)<1,'pending geometry survives viewport refresh');
      await finish(page);const saved=await snapshot(page);assert.equal(saved.sameCard,true);assert.equal(saved.toolbar,before.toolbar);assert.equal(saved.preview,before.preview);assert.equal(saved.focus,true);assert.equal(saved.zoom,before.zoom);assert.ok(Math.abs(saved.x-pending.x)<1);assert.ok(Math.abs(saved.y-pending.y)<1);assert.equal(writes.length,i+1);
    }
    assert.deepEqual(writes.map(w=>w.expected.notes[0].layout_revision),[2,3,4],'each drag uses the acknowledged layout revision');
  }finally{releaseSave?.();await page.close();}
});
for(const failure of ['conflict','failed','unknown'])test(`${failure} save retains existing rollback/retry rules`,async()=>{
  const page=await mount();try{
    for(let iteration=0;iteration<3;iteration++){
      const before=await snapshot(page),startWrites=writes.length;mode=failure;await drag(page,35,20);const pending=await snapshot(page);releaseSave();
      if(failure==='unknown'){
        await page.waitForSelector('[data-group-retry]');assertRetained(await snapshot(page),before);
        const body=structuredClone(writes[startWrites]);await page.click('[data-group-retry]');
        await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Saving layout...');
        await page.$eval(card+' .note-card__title',e=>e.focus({preventScroll:true}));
        await finish(page);assert.deepEqual(writes[startWrites+1],body,'retry reuses the frozen operation');
        const after=await snapshot(page);assert.ok(Math.abs(after.x-pending.x)<1);assert.ok(Math.abs(after.y-pending.y)<1);assert.equal(writes.length,startWrites+2);
      }else{
        await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]')&&document.querySelector('#notes-board-status').textContent!=='Saving layout...');
        const after=await snapshot(page);if(failure==='failed')assert.ok(Math.abs(after.x-before.x)<1,'denied save rolls back');else assert.ok(after.x>before.x,'conflict reloads the newer canonical placement');assert.equal(writes.length,startWrites+1);
      }
      assertRetained(await snapshot(page),before);
      mode='success';await drag(page,20,10);const nextPending=await snapshot(page);await finish(page);
      const saved=await snapshot(page);assertRetained(saved,before);assert.ok(Math.abs(saved.x-nextPending.x)<1);assert.ok(Math.abs(saved.y-nextPending.y)<1,'a successful save after recovery stays at the dropped position');
    }
  }finally{releaseSave?.();await page.close();}
});
function assertRetained(after,before){
  assert.equal(after.sameCard,true,'retain the connected card');assert.equal(after.focus,true,'retain note title focus');
  assert.equal(after.preview,before.preview,'retain preview scroll');assert.equal(after.toolbar,before.toolbar,'keep toolbar height stable');assert.equal(after.zoom,before.zoom);
}

for(const saveBeforeRefresh of [false,true])test(`a local checklist update reflects a remote reversal (layout acknowledgment first: ${saveBeforeRefresh})`,async()=>{
  const page=await mount({checklist:true});try{
    const box=card+' .note-md-box';await page.click(box);
    await page.waitForNetworkIdle({idleTime:50});
    assert.equal(checkWrites.length,1);assert.equal(notes[0].content.startsWith('- [x]'),true);
    await page.$eval(box,e=>e.focus({preventScroll:true}));
    const before=await page.$eval(card,e=>({scroll:e.querySelector('.note-card__content').scrollTop}));
    if(saveBeforeRefresh){await drag(page);await finish(page);}
    assert.equal(await page.$eval(card,e=>e===originalCard),true,'the first layout save after a checklist toggle retains the card');
    assert.equal(await page.$eval(box,e=>e===document.activeElement),true,'retain checkbox focus');
    assert.equal(await page.$eval(card,e=>e.querySelector('.note-card__content').scrollTop),before.scroll);
    assert.equal(await page.$eval(box,e=>e.getAttribute('aria-checked')),'true');
    notes[0].content=notes[0].content.replace('- [x]','- [ ]');notes[0].revision++;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.note-md-box').getAttribute('aria-checked')==='false');
    assert.equal(await page.$eval(box,e=>e.dataset.mdChecked),'0');
    assert.equal(await page.$eval(box,e=>e.closest('.note-md-check').classList.contains('is-checked')),false);
    assert.equal(await page.$eval(box,e=>e===document.activeElement),true,'restore checkbox focus after remote content replacement');
  }finally{releaseSave?.();await page.close();}
});

test('a rejected checklist update restores both its display and retained card on the next layout save',async()=>{
  const page=await mount({checklist:true});try{
    checkMode='failed';const box=card+' .note-md-box';await page.click(box);
    await page.waitForNetworkIdle({idleTime:50});
    await page.waitForFunction(()=>document.querySelector('.note-md-box').getAttribute('aria-checked')==='false');
    assert.equal(checkWrites.length,1);await page.$eval(box,e=>e.focus({preventScroll:true}));
    await drag(page);await finish(page);
    assert.equal(await page.$eval(card,e=>e===originalCard),true);assert.equal(await page.$eval(box,e=>e===document.activeElement),true);
    assert.equal(await page.$eval(box,e=>e.getAttribute('aria-checked')),'false');
  }finally{releaseSave?.();await page.close();}
});

for(const outcome of ['success','failed'])test(`a canonical refresh during a pending checklist ${outcome} keeps the new content and command revision`,async()=>{
  const page=await mount({checklist:true});try{
    holdCheck=true;checkMode=outcome;
    const response=page.waitForResponse(r=>r.url().endsWith('/notes/1/check')&&r.request().method()==='PATCH');
    await page.click(card+' .note-md-box');
    notes[0].title='Remote title during checkbox request';notes[0].revision++;
    if(outcome==='failed')notes[0].content=notes[0].content.replace('- [ ]','- [x]');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.note-card[data-id="1"] .note-card__title').textContent==='Remote title during checkbox request');
    assert.equal(typeof releaseCheck,'function');releaseCheck();await response;await page.waitForNetworkIdle({idleTime:50});
    assert.equal(await page.$eval(card+' .note-md-box',e=>e.getAttribute('aria-checked')),'true','a stale denial must not undo a newer canonical check');
    assert.equal(await page.$eval(card+' .note-card__title',e=>e.textContent),'Remote title during checkbox request');
    await drag(page);await finish(page);
    assert.equal(writes[0].expected.notes[0].revision,notes[0].revision,'the next drag uses the current content revision');
  }finally{releaseCheck?.();releaseSave?.();await page.close();}
});
for(const reduced of [false,true])test(`drag-only tilt and pointer cancellation preserve geometry (reduced motion ${reduced})`,async()=>{
  const page=await mount({reduced});try{const before=await snapshot(page);const p=await page.$eval(card,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-55};});await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+40,p.y+30,{steps:4});await new Promise(r=>setTimeout(r,35));
    const active=await snapshot(page);assert.equal(active.width,before.width);assert.equal(active.height,before.height);
    const angle=await page.$eval(card,e=>getComputedStyle(e.querySelector('.note-card__surface')).rotate);assert.equal(angle==='none'||parseFloat(angle)===0,reduced,'motion preference governs visual tilt');
    await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1})));await page.mouse.up();const cancelled=await snapshot(page);assert.ok(Math.abs(cancelled.x-before.x)<1);assert.ok(Math.abs(cancelled.y-before.y)<1);assert.equal(writes.length,0);assert.equal(await page.$('.note-card--moving'),null);
  }finally{await page.close();}
});

test('horizontal speed tilts the complete card surface and release leaves logical geometry unchanged',async()=>{
  const page=await mount();try{
    const p=await page.$eval(card,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-55};});
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const result=await page.evaluate(async point=>{
      const card=document.querySelector('.note-card[data-id="1"]'),content=card.querySelector('.note-card__content');
      const surface=card.querySelector('.note-card__surface'),visual=surface||content;
      let x=point.x,y=point.y;
      async function travel(vx,vy,duration=240){
        let previous=await new Promise(requestAnimationFrame),elapsed=0;
        while(elapsed<duration){
          const time=await new Promise(requestAnimationFrame),dt=time-previous;previous=time;elapsed+=dt;
          x+=vx*dt;y+=vy*dt;
          window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,pointerType:'mouse',buttons:1,clientX:x,clientY:y}));
        }
        await new Promise(requestAnimationFrame);
        return parseFloat(card.style.getPropertyValue('--note-drag-tilt'));
      }
      const slow=await travel(.1,0),fast=await travel(.8,0),left=await travel(-.8,0);
      const vertical=await travel(0,.2,400);
      await travel(.8,0);
      const before=card.getBoundingClientRect().toJSON(),angle=getComputedStyle(visual).rotate;
      const frame={backgroundRotation:getComputedStyle(surface||card).rotate,background:getComputedStyle(surface||card).backgroundColor,
        shadow:getComputedStyle(surface||card).boxShadow,outerBackground:getComputedStyle(card).backgroundColor,outerShadow:getComputedStyle(card).boxShadow,
        contentRotation:getComputedStyle(content).rotate,unified:!!surface&&['.note-card__title','.note-card__content','.note-card__footer','.note-card__menu','.note-card__lock'].every(selector=>surface.contains(card.querySelector(selector)))};
      const outerRotate=getComputedStyle(card).rotate;
      // Sample an interior point of the visible corner outside the logical
      // rectangle, including controls with explicit pointer-events:auto.
      const radians=parseFloat(angle)*Math.PI/180,cx=before.x+before.width/2,cy=before.y+before.height/2;
      const dx=before.width/2-2,dy=-before.height/2+25;
      const corner={x:cx+dx*Math.cos(radians)-dy*Math.sin(radians),y:cy+dx*Math.sin(radians)+dy*Math.cos(radians)};
      const hitsCard=()=>document.elementFromPoint(corner.x,corner.y)?.closest('.note-card')===card;
      const hit={outside:corner.x>before.right,moving:hitsCard(),controlsDisabled:[...card.querySelectorAll('button,summary')].every(node=>getComputedStyle(node).pointerEvents==='none')};
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',clientX:x,clientY:y}));
      const after=card.getBoundingClientRect().toJSON(),releasing=getComputedStyle(visual).rotate;
      hit.settling=hitsCard();
      return{slow,fast,left,vertical,before,after,angle,releasing,outerRotate,frame,hit,settling:visual.getAnimations().some(animation=>animation.transitionProperty==='rotate')};
    },p);
    assert.ok(result.slow>0&&result.slow<.2&&result.fast>2,JSON.stringify(result));
    assert.ok(result.left< -2&&Math.abs(result.fast)<=4&&Math.abs(result.left)<=4);
    assert.ok(Math.abs(result.vertical)<.02,'vertical-only motion does not sustain a sideways lean');
    assert.ok(result.outerRotate==='none'||parseFloat(result.outerRotate)===0);
    assert.equal(result.frame.backgroundRotation,result.angle,'the background must tilt with the card contents');
    assert.equal(result.frame.unified,true,'title, preview, footer and controls share one visual surface');
    assert.equal(result.frame.contentRotation,'none','content does not rotate a second time');
    assert.notEqual(result.frame.background,'rgba(0, 0, 0, 0)');assert.notEqual(result.frame.shadow,'none');
    assert.match(result.frame.shadow,/12px 24px/,'the lifted shadow stays on the rotating surface even while hovered');
    assert.equal(result.frame.outerBackground,'rgba(0, 0, 0, 0)');assert.equal(result.frame.outerShadow,'none','no stationary frame shadow remains');
    assert.deepEqual(result.hit,{outside:true,moving:false,controlsDisabled:true,settling:false},'visual protrusions never change the logical hit target');
    for(const field of ['x','y','width','height'])assert.ok(Math.abs(result.before[field]-result.after[field])<1,field);
    assert.ok(result.settling&&parseFloat(result.releasing)>0,'release starts a visual transition rather than snapping');
    await page.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('.note-card__surface')).rotate)||0)<.001);
    await page.waitForFunction(()=>!document.querySelector('.note-card--settling'));
    assert.notEqual(await page.$eval(card+' .note-card__title',node=>getComputedStyle(node).pointerEvents),'none','controls recover after settling');
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Saving layout...');
    await finish(page);assert.equal(writes.length,1);
  }finally{releaseSave?.();await page.mouse.up();await page.close();}
});

test('a zoomed card menu remains reachable after dragging and settling near the viewport edge',async()=>{
  const page=await mount();try{
    await page.click('#notes-zoom-in');await page.click(card+' summary');
    const p=await page.$eval(card,e=>{
      const r=e.getBoundingClientRect(),point={x:r.x+30,y:r.bottom-55};
      const target=document.elementFromPoint(point.x,point.y);
      return{...point,body:e.contains(target)&&!target.closest('button,a,summary,details,[role="checkbox"]')};
    });
    assert.equal(p.body,true,'start on exposed note body beside the open menu');
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const angle=await page.evaluate(async p=>{
      let x=p.x,time=await new Promise(requestAnimationFrame),elapsed=0;
      while(elapsed<320){const now=await new Promise(requestAnimationFrame),dt=now-time;time=now;elapsed+=dt;x+=dt*.8;
        window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,pointerType:'mouse',buttons:1,clientX:x,clientY:p.y}));}
      await new Promise(requestAnimationFrame);
      const angle=parseFloat(getComputedStyle(document.querySelector('.note-card__surface')).rotate);
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',clientX:x,clientY:p.y}));return angle;
    },p);
    assert.ok(angle>2,`expected active tilt, got ${angle}`);await page.waitForFunction(()=>!document.querySelector('.note-card--settling'));
    const menu=await page.$eval(card,e=>{
      const menu=e.querySelector('.note-card__menu-items'),r=menu.getBoundingClientRect(),v=e.closest('.notes-scroll').getBoundingClientRect();
      const action=menu.querySelector('button'),a=action.getBoundingClientRect();
      return{open:e.querySelector('details').open,overflow:getComputedStyle(e.querySelector('.note-card__surface')).overflow,
        left:r.left,right:r.right,top:r.top,bottom:r.bottom,viewport:v.toJSON(),hit:action.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2))};
    });
    assert.equal(menu.open,true);assert.equal(menu.overflow,'visible');assert.equal(menu.hit,true);
    assert.ok(menu.left>=menu.viewport.left+3&&menu.right<=menu.viewport.right-3,JSON.stringify(menu));
    assert.ok(menu.top>=menu.viewport.top+3&&menu.bottom<=menu.viewport.bottom-3,JSON.stringify(menu));
    await finish(page);assert.equal(writes.length,1);
  }finally{releaseSave?.();await page.mouse.up();await page.close();}
});

test('a fast save acknowledgment retains settling protection across controller replacement',async()=>{
  const page=await mount();try{
    // Stretch only release timing to reliably sample both sides of the HTTP
    // acknowledgment, including under a slow CI browser. Drag motion is real.
    await page.addStyleTag({content:'.note-card:not(.note-card--moving) > .note-card__surface {transition-duration:800ms}'});
    const p=await page.$eval(card,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-55};});
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    await page.evaluate(async p=>{
      let x=p.x,time=await new Promise(requestAnimationFrame),elapsed=0;
      while(elapsed<240){const now=await new Promise(requestAnimationFrame),dt=now-time;time=now;elapsed+=dt;x+=dt*.8;
        window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,pointerType:'mouse',buttons:1,clientX:x,clientY:p.y}));}
      await new Promise(requestAnimationFrame);
      const card=document.querySelector('.note-card[data-id="1"]'),surface=card.querySelector('.note-card__surface');
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',clientX:x,clientY:p.y}));
      window.settleSamples=[];window.settleDone=false;
      function sample(){
        const angle=parseFloat(getComputedStyle(surface).rotate)||0;
        settleSamples.push({angle,saved:document.querySelector('#notes-board-status').textContent==='Layout saved',
          protected:card.classList.contains('note-card--settling')&&[...card.querySelectorAll('button,summary')].every(node=>getComputedStyle(node).pointerEvents==='none'),same:card===document.querySelector('.note-card[data-id="1"]')});
        if(angle>.001)requestAnimationFrame(sample);else window.settleDone=true;
      }
      requestAnimationFrame(sample);
    },p);
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Saving layout...');
    await finish(page);await page.waitForFunction(()=>window.settleDone);
    const samples=await page.evaluate(()=>settleSamples);
    assert.ok(samples.some(sample=>sample.saved&&sample.angle>.2),'save response arrives before leveling finishes');
    assert.ok(samples.every(sample=>sample.same&&(sample.angle<=.001||sample.protected)),JSON.stringify(samples));
    assert.equal(await page.$('.note-card--settling'),null);assert.equal(writes.length,1);
  }finally{releaseSave?.();await page.mouse.up();await page.close();}
});

test('a burst of pointer moves paints once per frame and pointerup commits the final unpainted position',async()=>{
  const page=await mount();try{
    const before=await snapshot(page),p=await page.$eval(card,e=>{const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-55};});
    await page.mouse.move(p.x,p.y);await page.mouse.down();
    const burst=await page.evaluate(({x,y})=>{
      const card=document.querySelector('.note-card[data-id="1"]'),left=card.style.left;
      for(let i=1;i<=30;i++)window.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:x+i*2,clientY:y+20,pointerType:'mouse',buttons:1}));
      const unpainted=card.style.left===left;
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:x+80,clientY:y+50,pointerType:'mouse'}));
      return unpainted;
    },p);
    assert.equal(burst,true,'move events only record the newest pointer');
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Saving layout...');
    const pending=await snapshot(page);assert.ok(Math.abs(pending.x-before.x-80)<1);assert.ok(Math.abs(pending.y-before.y-50)<1);
    await finish(page);assert.equal(writes.length,1);
  }finally{releaseSave?.();await page.mouse.up();await page.close();}
});

test('pending placement survives a responsive controller replacement and rolls back after denial',async()=>{
  const page=await mount();try{
    const before=await snapshot(page);mode='failed';await drag(page);const pending=await snapshot(page);
    await page.setViewport({width:390,height:1000});await page.waitForSelector('#notes-grid[data-board-view="list"]');
    await page.setViewport({width:1280,height:1000});await page.waitForSelector('#notes-grid[data-board-view="canvas"]');
    const returned=await snapshot(page);assert.ok(Math.abs(returned.x-pending.x)<1);assert.ok(Math.abs(returned.y-pending.y)<1);
    releaseSave();await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent!=='Saving layout...');
    const denied=await snapshot(page);assert.ok(Math.abs(denied.x-before.x)<1);assert.ok(Math.abs(denied.y-before.y)<1);
  }finally{releaseSave?.();await page.close();}
});

test('content refresh retains neighboring focus and renders icons for every inserted card',async()=>{
  const page=await mount();try{
    assert.equal(await page.$$eval('.note-card',cards=>cards.every(card=>card.querySelector('summary svg')&&card.querySelector('.note-card__lock svg'))),true);
    await page.evaluate(()=>{window.neighbor=document.querySelector('.note-card[data-id="2"]');window.neighborFocus=neighbor.querySelector('summary');neighborFocus.focus({preventScroll:true});});
    notes[0].title='Changed content';notes[0].revision++;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.note-card[data-id="1"] .note-card__title').textContent==='Changed content');
    assert.equal(await page.evaluate(()=>neighbor===document.querySelector('.note-card[data-id="2"]')&&document.activeElement===neighborFocus),true);
    assert.equal(await page.$$eval('.note-card',cards=>cards.every(card=>card.querySelector('summary svg')&&card.querySelector('.note-card__lock svg'))),true);
    notes.shift();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>!document.querySelector('.note-card[data-id="1"]'));
    assert.equal(await page.evaluate(()=>document.activeElement===neighborFocus),true,'deleting another card does not move the focused neighbor');
  }finally{await page.close();}
});
