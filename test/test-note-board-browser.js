import { arrangeNotesFixture } from './helpers/note-group-http-fixture.js';
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
  if(req.path==='/notes/board'&&req.method==='GET'){const snapshot=structuredClone(notes);if(delayRead)await new Promise(r=>setTimeout(r,250));return res.json({data:{notes:snapshot,groups:[]}});}
  if(req.method!=='GET')writes.push({path:req.path,method:req.method,body:req.body});
  if(req.path==='/notes/group-operations'){const result=arrangeNotesFixture(notes,req.body,{conflict:conflictLayout});return res.status(result.status).json(result.body);}
  const id=Number(req.path.split('/')[2]),note=notes.find(n=>n.id===id);
  if(req.method==='PUT')return res.status(409).json({error:'Changed elsewhere'});
  if(req.path.endsWith('/check')&&note){note.content=note.content.replace('- [ ]','- [x]');note.revision++;return res.json({data:note});}
  if(req.path.endsWith('/layout')&&note){if(conflictLayout)return res.status(409).json({error:'Changed elsewhere'});note.layout={...req.body.layout,revision:note.layout.revision+1};return res.json({data:note.layout});}
  if(req.path==='/notes/layout'){for(const item of req.body.items){const n=notes.find(n=>n.id===item.note_id);n.layout={...item.layout,revision:n.layout.revision+1};}return res.json({data:req.body.items.map(i=>({note_id:i.note_id,layout:notes.find(n=>n.id===i.note_id).layout}))});}
  return res.json({data:[]});
});
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount(width=1280,device=false,height=900){
  writes=[];notes=structuredClone(original);delayRead=false;conflictLayout=false;const page=await browser.newPage();page.setDefaultTimeout(5000);await page.setViewport({width,height});await page.goto(base+'/board-test');
  await page.evaluate(async(device)=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();window.yuvomi={showToast:(_message,_kind,_duration,undo)=>{if(undo)window.undoNoteDelete=undo;}};(await import('/permissions.js')).setPermissions(device?{principal_kind:'device',modules:{notes:'read'},capabilities:{'device_notes.view':'allow','device_notes.create':'allow'}}:{admin:true});window.stopNotes=await(await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{id:1}});},device);return page;
}
async function screenshot(page,name) {
  if (!process.env.NOTES_SCREENSHOTS) return;
  mkdirSync(process.env.NOTES_SCREENSHOTS,{recursive:true});
  await page.screenshot({path:`${process.env.NOTES_SCREENSHOTS}/${name}.png`});
}
async function openAdjustment(page) {
  await page.focus('[data-id="1"] [data-board-action="adjust"]');
  await page.keyboard.press('Enter');
}
test('wide Notes controls share the canvas edge gutter',async()=>{
  const page=await mount(1920);try{
    const geometry=await page.evaluate(()=>{
      const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
      return {page:rect('.notes-page'),heading:rect('.page-toolbar__title'),toolbar:rect('#notes-compact-view'),card:rect('[data-id="1"]')};
    });
    assert.ok(geometry.heading.left-geometry.page.left<=40,JSON.stringify(geometry));
    assert.ok(geometry.toolbar.left>=geometry.heading.right&&geometry.toolbar.top<geometry.card.top,JSON.stringify(geometry));
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [360,1280])test(`Notes menu aligns action labels and stays inside the visible viewport at ${width}px`,async()=>{
  const page=await mount(width,false,620);try{
    const summary='[data-id="2"] .note-card__menu summary';
    await page.$eval(summary,el=>el.scrollIntoView({block:'end'}));
    await page.focus(summary);await page.keyboard.press('Enter');
    await page.waitForSelector('[data-id="2"] .note-card__menu[open]');
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const metrics=await page.$eval('[data-id="2"] .note-card__menu-items',menu=>{
      const rect=menu.getBoundingClientRect(),viewport=document.querySelector('.notes-scroll').getBoundingClientRect();
      const starts=[...menu.querySelectorAll('button')].map(button=>{
        const walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);let node;
        while((node=walker.nextNode()))if(/[A-Za-z]/.test(node.textContent)){const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().left;}
      });
      return {rect:rect.toJSON(),viewport:viewport.toJSON(),starts,height:innerHeight,width:innerWidth};
    });
    assert.ok(Math.max(...metrics.starts)-Math.min(...metrics.starts)<=1,`menu labels align: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.rect.left>=0&&metrics.rect.right<=metrics.width&&metrics.rect.top>=Math.max(0,metrics.viewport.top)&&metrics.rect.bottom<=Math.min(metrics.height,metrics.viewport.bottom),`menu is not clipped: ${JSON.stringify(metrics)}`);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'pin');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
test('Notes reader close keeps a full keyboard target without a circular surround',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-action="open"]');
    await page.keyboard.press('Tab');
    await page.focus('.modal-panel__close');
    const style=await page.$eval('.modal-panel__close',el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {radius:parseFloat(s.borderRadius),width:r.width,height:r.height,outline:s.outlineStyle,label:el.getAttribute('aria-label')};});
    assert.ok(style.radius<Math.min(style.width,style.height)/2,JSON.stringify(style));
    assert.ok(style.width>=44&&style.height>=44&&style.label&&style.outline!=='none',JSON.stringify(style));
    await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('.modal-overlay'));
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [360,752,1920])test(`Notes header reserves separate notification, search and creation targets at ${width}px`,async()=>{
  const page=await mount(width);try{
    await page.evaluate(async()=>{
      await new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/styles/reminders.css';link.onload=resolve;document.head.append(link);});
      const header=document.querySelector('.notes-toolbar');header.classList.add('notification-header-host');
      const seal=document.createElement('span');seal.className='module-seal module-seal--head';header.prepend(seal);
      const button=document.createElement('button');button.className='btn btn--ghost btn--icon notification-header-button';button.textContent='Bell';header.append(button);
    });
    const geometry=await page.evaluate(()=>{
      const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
      return {bell:rect('.notification-header-button'),search:rect('.notes-toolbar__search'),create:rect('#notes-add-btn'),list:rect('#notes-compact-view'),organize:rect('#notes-organize'),locked:rect('#notes-include-locked')};
    });
    for(const name of ['search','create','list','organize','locked']){
      const a=geometry.bell,b=geometry[name];if(!b.width||!b.height)continue;
      assert.ok(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom,`${name} and bell must not overlap: ${JSON.stringify(geometry)}`);
    }
    assert.ok(geometry.search.width>=44,'unfocused phone search keeps its existing icon-size target');
    await page.click('#notes-search');await page.type('#notes-search','Household');
    await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    const focused=await page.$eval('#notes-search',el=>{const r=el.getBoundingClientRect(),bell=document.querySelector('.notification-header-button').getBoundingClientRect();return{width:r.width,right:r.right,bellLeft:bell.left,active:el===document.activeElement};});
    assert.ok(focused.active&&focused.width>=80&&focused.right<=focused.bellLeft,`focused search expands and remains separate: ${JSON.stringify(focused)}`);
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [320,360])for(const direction of ['ltr','rtl'])test(`enlarged Notes header keeps search reachable at ${width}px ${direction}`,async()=>{
  const page=await mount(width);try{
    await page.evaluate(async(direction)=>{
      document.documentElement.dir=direction;
      await new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/styles/notes.css';link.onload=resolve;document.head.append(link);});
      await new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/styles/reminders.css';link.onload=resolve;document.head.append(link);});
      const header=document.querySelector('.notes-toolbar');header.classList.add('notification-header-host');
      const seal=document.createElement('span');seal.className='module-seal module-seal--head';header.prepend(seal);
      const button=document.createElement('button');button.className='btn btn--ghost btn--icon notification-header-button';button.textContent='Bell';header.append(button);
      const enlarged=[...header.querySelectorAll('h1,input,button')].map(el=>[el,parseFloat(getComputedStyle(el).fontSize)*2]);
      for(const [el,size] of enlarged)el.style.fontSize=`${size}px`;
    },direction);
    async function check(stage,minWidth){
      const geometry=await page.evaluate(()=>{
        const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
        const input=document.querySelector('#notes-search'),r=input.getBoundingClientRect();
        return {title:rect('.page-toolbar__title'),search:r.toJSON(),container:rect('.notes-toolbar__search'),bell:rect('.notification-header-button'),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input,width:innerWidth,documentWidth:document.documentElement.scrollWidth};
      });
      const {title,search,container,bell}=geometry;
      assert.ok(search.width>=minWidth&&search.left>=0&&search.right<=width,`${stage}: usable search ${JSON.stringify(geometry)}`);
      assert.ok(search.left>=container.left-1&&search.right<=container.right+1,`${stage}: search fits its container ${JSON.stringify(geometry)}`);
      assert.ok(search.right<=bell.left||search.left>=bell.right,`${stage}: no bell overlap ${JSON.stringify(geometry)}`);
      assert.ok(search.right<=title.left||search.left>=title.right,`${stage}: no title overlap ${JSON.stringify(geometry)}`);
      assert.ok(geometry.hit&&geometry.documentWidth<=width,`${stage}: target receives input ${JSON.stringify(geometry)}`);
      await screenshot(page,`notes-header-enlarged-${width}-${direction}-${stage}`);
    }
    await check('empty',44);
    await page.click('#notes-search');await check('focused',120);
    await page.keyboard.type('Household');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    await page.$eval('#notes-search',el=>el.blur());await check('filled',120);
    await page.click('[data-page-search-clear]');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===2);
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [360,752,1920])test(`Notes header icon controls retain names, targets and states at ${width}px`,async()=>{
  const page=await mount(width);try{
    // The router loads page CSS after the shell; reproduce that cascade order.
    await page.evaluate(()=>document.head.append(document.querySelector('link[href="/styles/notes.css"]')));
    const controls=await page.evaluate(()=>['#notes-compact-view','#notes-organize','#notes-include-locked'].map(selector=>{
      const el=document.querySelector(selector),r=el.getBoundingClientRect(),input=el.querySelector('input');
      return {selector,header:!!el.closest('.notes-toolbar'),label:(input||el).getAttribute('aria-label'),title:el.title,text:el.textContent.trim(),icon:!!el.querySelector('svg'),width:r.width,height:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right};
    }));
    for(const c of controls){assert.ok(c.header&&c.label&&c.title&&c.icon&&!c.text,JSON.stringify(c));if(width===360)assert.equal(c.width,0);else assert.ok(c.width>=44&&c.height>=44&&c.right<=width,JSON.stringify(c));}
    if(width!==360){
      for(let i=1;i<controls.length;i++)assert.ok(controls[i].left>=controls[i-1].right,JSON.stringify(controls));
      await page.focus('#notes-organize-locked');await page.keyboard.press('Space');
      assert.equal(await page.$eval('#notes-organize-locked',el=>el.checked),true);
      await page.focus('#notes-compact-view');await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#notes-compact-view',el=>el.getAttribute('aria-pressed')),'true');
      assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'list');
      assert.equal(await page.$eval('#notes-organize',el=>el.getBoundingClientRect().width),0);
      assert.equal(await page.$eval('#notes-include-locked',el=>el.getBoundingClientRect().width),0);
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'canvas');
      assert.equal(await page.$eval('#notes-organize-locked',el=>el.checked),true);
    }
    assert.equal(writes.length,0);
  }finally{await page.close();}
});
for(const width of [780,840])test(`short landscape ${width}x360 scrolls the full Notes page`,async()=>{
  const page=await mount(width,false,360);try{
    await page.$eval('#main-content',el=>{el.classList.add('app-content');el.style.height='calc(100dvh - 64px)';});
    const geometry=await page.evaluate(()=>{const notes=document.querySelector('.notes-scroll'),main=document.querySelector('#main-content');return {notes:notes.clientHeight,content:notes.scrollHeight,page:main.clientHeight,pageContent:main.scrollHeight};});
    assert.ok(geometry.notes>=geometry.content-1,'Notes must not be squeezed into a nested scroll area: '+JSON.stringify(geometry));
    assert.ok(geometry.pageContent>geometry.page,'the page must carry overflow');
    const button='.note-card[data-id="2"] [data-action="open"]';
    await page.$eval(button,el=>el.scrollIntoView({block:'center'}));
    const box=await page.$eval(button,el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};});
    assert.ok(box.top>=0&&box.bottom<=360,'the final note control is reachable');
    await page.click(button);await page.waitForSelector('.note-modal');assert.equal(writes.length,0);
  }finally{await page.close();}
});

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
    await openAdjustment(page);await page.waitForSelector('#note-layout-width');
    await page.$eval('#note-layout-width',el=>{el.value='6';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#note-layout-save');
    await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    assert.equal(writes[0].path,'/notes/group-operations');assert.equal(writes[0].body.expected.notes[0].layout_revision,2);assert.equal(writes[0].body.items[0].layout.width,6);
    assert.equal(notes[0].content,original[0].content);
  }finally{await page.close();}
});
test('phone keeps distant notes reachable in a list and never saves a viewport reflow',async()=>{
  const page=await mount(320);try{
    assert.ok(await page.$('#notes-list-density'),'list density is available');
    assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'list');
    assert.equal(await page.$$eval('.note-card',els=>els.length),2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const positions=await page.$$eval('.note-card',els=>els.map(el=>el.getBoundingClientRect().top));assert.ok(positions[1]-positions[0]<600);
    await page.setViewport({width:1280,height:900});await page.setViewport({width:390,height:900});assert.equal(writes.length,0);
    assert.equal(await page.$('[data-board-handle]'),null);
    assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'list');
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
    const move=await page.$('[data-id="1"] .note-card__content .note-md-p');const box=await move.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+110,box.y+box.height/2+96,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,1);assert.ok(writes[0].body.items[0].layout.x>0);assert.equal(await page.$('.note-modal'),null);
    const resize=await page.$('.note-card[data-id="1"]');const rb=await resize.boundingBox();
    await page.mouse.move(rb.x+rb.width-3,rb.y+rb.height-3);await page.mouse.down();await new Promise(r=>setTimeout(r,520));await page.mouse.move(rb.x+rb.width+110,rb.y+rb.height+80,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,2);assert.ok(writes[1].body.items[0].layout.width>writes[0].body.items[0].layout.width);assert.equal(writes[1].body.expected.notes[0].layout_revision,3);
    const currentMove=await page.$('[data-id="1"] .note-card__content .note-md-p');const mb=await currentMove.boundingBox();await page.mouse.move(mb.x+mb.width/2,mb.y+mb.height/2);await page.mouse.down();await page.mouse.move(mb.x+mb.width/2+110,mb.y+mb.height/2+96);await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(writes.length,2);assert.equal(await page.$('.note-modal'),null);
  }finally{await page.close();}
});
test('Organize is browse-only while filtered, then arranges the full board with complete revisions',async()=>{
  const page=await mount();try{
    await page.type('#notes-search','Private');await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
    assert.equal(writes.length,0);assert.equal(await page.$eval('#notes-organize',node=>node.hidden||node.disabled),true);
    await page.evaluate(()=>document.querySelector('#notes-organize').click());assert.equal(writes.length,0);
    await page.$eval('#notes-search',node=>{node.value='';node.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>!document.querySelector('#notes-organize').hidden);
    await page.click('#notes-organize');await page.waitForFunction(()=>document.querySelector('#notes-board-status').textContent==='Layout saved');
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/notes/group-operations');assert.equal(writes[0].body.items.length,2);assert.equal(writes[0].body.items[0].id,1);assert.equal(writes[0].body.items[0].layout.height,6);
    assert.deepEqual(writes[0].body.expected,{groups:[],notes:[{id:1,revision:4,layout_revision:2},{id:2,revision:1,layout_revision:0}]});
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
    await openAdjustment(page);await page.waitForSelector('#note-layout-width');
    notes[0].layout={...notes[0].layout,width:5,revision:9};conflictLayout=true;
    await page.$eval('#note-layout-width',el=>el.value='6');await page.click('#note-layout-save');await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    conflictLayout=false;await openAdjustment(page);await page.waitForSelector('#note-layout-width');
    assert.equal(await page.$eval('#note-layout-width',el=>el.value),'5','a deliberate new draft starts from reauthorized geometry');
    await page.$eval('#note-layout-width',el=>el.value='6');await page.click('#note-layout-save');await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    assert.equal(writes[1].body.expected.notes[0].layout_revision,9);assert.equal(notes[0].layout.width,6);
  }finally{await page.close();}
});
test('live refresh does not resurrect a pending delete, and undo rechecks access',async()=>{
  const page=await mount();try{
    await page.click('[data-id="1"] [data-board-menu] summary');await page.click('[data-id="1"] [data-action="delete"]');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$('.note-card[data-id="1"]'),null,'pending deletion stays hidden while undo is available');
    notes=notes.filter(n=>n.id!==1);await page.evaluate(()=>window.undoNoteDelete());await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$('.note-card[data-id="1"]'),null,'undo never paints a revoked cached note');
  }finally{await page.close();}
});
test('touch movement on empty board scrolls; a deliberate held body drop saves without opening the note',async()=>{
  let page=await mount();try{
    let cdp=await page.createCDPSession();
    const swipe=async(x,y,dx,dy,holdForMove=false)=>{
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      if(holdForMove){
        // A stationary native touch must reach the 450ms hold and visible lift
        // before movement expresses placement intent instead of scrolling.
        await page.waitForSelector('[data-id="1"].note-card--moving');
        assert.equal(writes.length,0,'arming the card does not save a layout');
      }
      for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*step/8,y:y+dy*step/8}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    await swipe(550,600,0,-200);
    assert.ok(await page.$eval('.notes-scroll',el=>el.scrollTop)>0);assert.equal(writes.length,0);
    // Native momentum from the scroll is unrelated to a fresh card gesture.
    // Use a new view rather than race its compositor with an immediate reset.
    await cdp.detach();await page.close();page=await mount();cdp=await page.createCDPSession();
    const handle=await page.$('[data-id="1"] .note-card__content .note-md-p');const box=await handle.boundingBox();
    await swipe(box.x+box.width/2,box.y+box.height/2,110,96,true);
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
test('a saturated canonical board forces a reachable list without any writes',async()=>{
  const page=await mount();try{
    notes[1].layout.overflow=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(r=>setTimeout(r,150));
    assert.equal(await page.$eval('#notes-grid',el=>el.dataset.boardView),'list');
    assert.ok(await page.$('#notes-list-density'));assert.equal(await page.$$eval('.note-card',els=>els.length),2);assert.equal(writes.length,0);
  }finally{await page.close();}
});
