import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app=express();let browser,server,base,writes,notes,delayRead,conflictLayout;
const original=[{id:1,title:'Private instructions',content:'- [ ] Feed pets\n\nKeep this draft safe.',color:'#C7DED9',pinned:1,created_by:1,creator_name:'Parent',visibility:'private',access_user_ids:[],revision:4,permissions:{view:true,edit:true,delete:true,manage_visibility:true},layout:{x:0,y:0,width:4,height:6,revision:2}}, {id:2,title:'Household plan',content:'Ready for dinner.',color:'#EFE3BE',creator_name:'Parent',visibility:'all',revision:1,permissions:{view:true,edit:true,delete:true,manage_visibility:false},layout:{x:8,y:30,width:4,height:6,revision:0}}];
app.use(express.json());app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
const links='<link rel="stylesheet" href="/styles/notes.css">'+[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/board-test',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1',async(req,res)=>{
  if(req.path==='/auth/me')return res.json({csrfToken:'fixture'});
  if(req.path==='/notes/members')return res.json({data:[{id:1,display_name:'Parent'},{id:2,display_name:'Grace'}]});
  if(req.path==='/notes/changes')return res.status(204).end();
  if(req.path==='/notes'&&req.method==='GET'){const snapshot=structuredClone(notes);if(delayRead)await new Promise(r=>setTimeout(r,250));return res.json({data:snapshot});}
  if(req.method!=='GET')writes.push({path:req.path,method:req.method,body:req.body});
  const id=Number(req.path.split('/')[2]),note=notes.find(n=>n.id===id);
  if(req.method==='PUT')return res.status(409).json({error:'Changed elsewhere'});
  if(req.path.endsWith('/check')&&note){note.content=note.content.replace('- [ ]','- [x]');note.revision++;return res.json({data:note});}
  if(req.path.endsWith('/layout')&&note){if(conflictLayout)return res.status(409).json({error:'Changed elsewhere'});note.layout={...req.body.layout,revision:note.layout.revision+1};return res.json({data:note.layout});}
  if(req.path==='/notes/layout'){for(const item of req.body.items){const n=notes.find(n=>n.id===item.note_id);n.layout={...item.layout,revision:n.layout.revision+1};}return res.json({data:req.body.items.map(i=>({note_id:i.note_id,layout:notes.find(n=>n.id===i.note_id).layout}))});}
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount(width=1280,device=false){
  writes=[];notes=structuredClone(original);delayRead=false;conflictLayout=false;const page=await browser.newPage();page.setDefaultTimeout(5000);await page.setViewport({width,height:900});await page.goto(base+'/board-test');
  await page.evaluate(async(device)=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();window.yuvomi={showToast:(_message,_kind,_duration,undo)=>{if(undo)window.undoNoteDelete=undo;}};(await import('/permissions.js')).setPermissions(device?{principal_kind:'device',modules:{notes:'read'},capabilities:{'device_notes.view':'allow','device_notes.create':'allow'}}:{admin:true});window.stopNotes=await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{id:1}});},device);return page;
}
async function screenshot(page,name) {
  if (!process.env.NOTES_SCREENSHOTS) return;
  mkdirSync(process.env.NOTES_SCREENSHOTS,{recursive:true});
  await page.screenshot({path:`${process.env.NOTES_SCREENSHOTS}/${name}.png`});
}

test('minimum cards truncate long titles on whole lines while the reader keeps the full title',async()=>{
  const page=await mount();try{
    const full='Weekend plans and everything to remember before we head outside with the family';
    notes[0].title=full;notes[0].layout={x:0,y:0,width:3,height:4,revision:3};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(title=>document.querySelector('.note-card[data-id="1"] .note-card__title')?.textContent===title,{},full);
    const metrics=await page.$eval('.note-card[data-id="1"] .note-card__title',el=>({height:el.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));
    assert.ok(metrics.height<=metrics.lineHeight*2+1,JSON.stringify(metrics));
    await page.click('[data-id="1"] [data-action="open"]');
    assert.equal(await page.$eval('#note-title',el=>el.value),full,'the full title remains available in the note');
  }finally{await page.close();}
});
test('wide board persists a keyboard-accessible per-card size change with its layout revision',async()=>{
  const page=await mount();try{
    assert.ok(await page.$('[data-board-action="adjust"]'),'card offers non-drag geometry controls');
    await screenshot(page,'notes-board-desktop');
    await page.click('[data-id="1"] [data-board-action="adjust"]');await page.waitForSelector('#note-layout-width');
    await page.$eval('#note-layout-width',el=>{el.value='6';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#note-layout-save');
    await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    assert.equal(writes[0].path,'/notes/1/layout');assert.equal(writes[0].body.expected_layout_revision,2);assert.equal(writes[0].body.layout.width,6);
    assert.equal(notes[0].content,original[0].content);
  }finally{await page.close();}
});
test('phone keeps distant notes reachable, supports size controls, and never saves a viewport reflow',async()=>{
  const page=await mount(320);try{
    assert.ok(await page.$('#notes-compact-view'),'compact view is available');
    assert.equal(await page.$$eval('.note-card',els=>els.length),2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const positions=await page.$$eval('.note-card',els=>els.map(el=>el.getBoundingClientRect().top));assert.ok(positions[1]-positions[0]<600);
    await page.setViewport({width:1280,height:900});await page.setViewport({width:390,height:900});assert.equal(writes.length,0);
    assert.ok(await page.$('[data-board-action="adjust"]'));
    await screenshot(page,'notes-board-phone');
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');await screenshot(page,'notes-board-phone-dark');
  }finally{await page.close();}
});
test('device View+Create has no layout editing and only Everyone in the composer',async()=>{
  const page=await mount(1280,true);try{
    assert.equal(await page.$('[data-board-action="adjust"]'),null);assert.equal(await page.$('#notes-organize'),null);
    await page.click('#fab-new-note');await page.waitForSelector('#note-content');
    assert.equal(await page.$('#note-visibility'),null);assert.ok((await page.$eval('.note-modal',el=>el.textContent)).includes('Everyone'));
  }finally{await page.close();}
});
test('audience remains explicit and a stale content save retains the draft',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-action="open"]');await page.click('#note-tab-edit');await page.waitForSelector('#note-visibility');
    assert.equal(await page.$eval('#note-visibility',el=>el.value),'private');await page.select('#note-visibility','selected');await page.waitForSelector('[data-note-member="2"]');await page.click('[data-note-member="2"]');
    await screenshot(page,'notes-audience-editor');
    await page.$eval('#note-content',el=>{el.value+=' unsaved';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#note-modal-save');await page.waitForFunction(()=>!document.querySelector('#note-modal-save').disabled);
    assert.equal(writes[0].body.expected_revision,4);assert.equal(writes[0].body.visibility,'selected');assert.deepEqual(writes[0].body.access_user_ids,[2]);assert.ok((await page.$eval('#note-content',el=>el.value)).endsWith(' unsaved'));
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));assert.equal(await page.$('.note-modal'),null);assert.equal(await page.$eval('#main-content',el=>el.textContent),'');
  }finally{await page.close();}
});
test('an old page read cannot repaint after its authentication context ends',async()=>{
  const page=await mount();try{
    delayRead=true;
    await page.evaluate(()=>{import('/pages/notes.js').then(m=>{window.pendingRender=m.render(document.getElementById('main-content'),{user:{id:1}});});});
    await new Promise(r=>setTimeout(r,60));await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));await new Promise(r=>setTimeout(r,350));
    assert.equal(await page.$eval('#main-content',el=>el.textContent),'');
  }finally{await page.close();}
});
test('drag and resize commit separate geometry; Escape cancels without opening the note',async()=>{
  const page=await mount();try{
    const move=await page.$('[data-id="1"] [data-board-handle="move"]');const box=await move.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+160,box.y+70,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,1);assert.ok(writes[0].body.layout.x>0);assert.equal(await page.$('.note-modal'),null);
    const resize=await page.$('[data-id="1"] [data-board-handle="resize"]');const rb=await resize.boundingBox();
    await page.mouse.move(rb.x+rb.width/2,rb.y+rb.height/2);await page.mouse.down();await page.mouse.move(rb.x+130,rb.y+80,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,2);assert.ok(writes[1].body.layout.width>writes[0].body.layout.width);assert.equal(writes[1].body.expected_layout_revision,3);
    const mb=await move.boundingBox();await page.mouse.move(mb.x+mb.width/2,mb.y+mb.height/2);await page.mouse.down();await page.mouse.move(mb.x+110,mb.y+70);await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(writes.length,2);assert.equal(await page.$('.note-modal'),null);
  }finally{await page.close();}
});
test('organize applies only the filtered visible notes and preserves individual dimensions',async()=>{
  const page=await mount();try{
    await page.type('#notes-search','Private');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    assert.equal(writes.length,0);await page.click('#notes-organize');await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/notes/layout');assert.equal(writes[0].body.items.length,1);assert.equal(writes[0].body.items[0].note_id,1);assert.equal(writes[0].body.items[0].layout.height,6);
  }finally{await page.close();}
});
test('revalidation removes revoked note content and an open draft',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-action="open"]');await page.click('#note-tab-edit');
    notes=notes.filter(n=>n.id!==1);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>!document.querySelector('.note-modal')&&!document.querySelector('.note-card[data-id="1"]'));
    assert.ok(!(await page.$eval('#main-content',el=>el.textContent)).includes('Private instructions'));
  }finally{await page.close();}
});
test('failed layout save restores latest geometry and permits an explicit retry',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-board-action="adjust"]');await page.waitForSelector('#note-layout-width');
    notes[0].layout={...notes[0].layout,width:5,revision:9};conflictLayout=true;
    await page.$eval('#note-layout-width',el=>el.value='6');await page.click('#note-layout-save');await page.waitForFunction(()=>!document.querySelector('#note-layout-save').disabled);
    assert.equal(await page.$eval('#note-layout-width',el=>el.value),'5','conflict reloads canonical geometry into the controls');
    conflictLayout=false;await page.$eval('#note-layout-width',el=>el.value='6');await page.click('#note-layout-save');await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    assert.equal(writes[1].body.expected_layout_revision,9);assert.equal(notes[0].layout.width,6);
  }finally{await page.close();}
});
test('live refresh does not resurrect a pending delete, and undo rechecks access',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-action="delete"]');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$('.note-card[data-id="1"]'),null,'pending deletion stays hidden while undo is available');
    notes=notes.filter(n=>n.id!==1);await page.evaluate(()=>window.undoNoteDelete());await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$('.note-card[data-id="1"]'),null,'undo never paints a revoked cached note');
  }finally{await page.close();}
});
test('touch movement outside a handle scrolls; a handle drop saves without opening the note',async()=>{
  let page=await mount();try{
    let cdp=await page.createCDPSession();
    const swipe=async(x,y,dx,dy)=>{
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/8,y:y+dy*step/8}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    await swipe(550,600,0,-200);
    assert.ok(await page.$eval('.notes-scroll',el=>el.scrollTop)>0);assert.equal(writes.length,0);
    // Native momentum from the scroll is unrelated to a fresh handle gesture.
    // Use a new view rather than race its compositor with an immediate reset.
    await cdp.detach();await page.close();page=await mount();cdp=await page.createCDPSession();
    const handle=await page.$('[data-id="1"] [data-board-handle="move"]');const box=await handle.boundingBox();
    await swipe(box.x+box.width/2,box.y+box.height/2,110,96);
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');assert.equal(writes.length,1);assert.equal(await page.$('.note-modal'),null);
    await cdp.detach();
  }finally{await page.close();}
});
test('reader checklist revision becomes the first edit baseline but later drafts keep their original revision',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-action="open"]');await page.click('.note-read__body .note-md-box');
    await page.waitForFunction(()=>document.querySelector('#note-content').value.includes('- [x]'));
    await page.click('#note-tab-edit');await page.$eval('#note-content',el=>el.value+=' Draft');await page.click('#note-modal-save');await page.waitForFunction(()=>!document.querySelector('#note-modal-save').disabled);
    assert.equal(writes.find(w=>w.method==='PUT').body.expected_revision,5);
    notes[0].revision=9;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,100));
    await page.click('#note-tab-read');await page.click('#note-tab-edit');await page.click('#note-modal-save');await page.waitForFunction(()=>!document.querySelector('#note-modal-save').disabled);
    assert.equal(writes.filter(w=>w.method==='PUT')[1].body.expected_revision,5,'returning to read cannot silently rebase an existing draft');
  }finally{await page.close();}
});
test('live repaint preserves focused checklist line and card preview scroll',async()=>{
  const page=await mount();try{
    notes[0].content+='\n\n'+Array.from({length:35},(_,i)=>`Paragraph ${i}`).join('\n\n');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    await page.focus('[data-id="1"] .note-md-box');await page.$eval('[data-id="1"] .note-card__content',el=>el.scrollTop=80);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.mdLine),'0');assert.equal(await page.$eval('[data-id="1"] .note-card__content',el=>el.scrollTop),80);
  }finally{await page.close();}
});
test('a saturated canonical board forces compact projection without any writes',async()=>{
  const page=await mount();try{
    notes[1].layout.overflow=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$eval('#notes-compact-view',el=>el.disabled),true);
    assert.ok(await page.$('.notes-board--compact'));assert.equal(await page.$$eval('.note-card',els=>els.length),2);assert.equal(writes.length,0);
  }finally{await page.close();}
});
