import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {arrangeNotesFixture} from './helpers/note-group-http-fixture.js';
const app=express();let browser,server,base;
app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
app.get('/group-fixture',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/notes.css"><style>html,body{height:100%;margin:0}.notes-page{height:100vh;--page-inline-pad:12px}.notes-scroll{padding-bottom:12px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div class="notes-page"><div class="notes-reveal-strip" hidden></div><div class="notes-scroll"><div class="notes-canvas-space"><div class="notes-grid"></div></div></div></div></body></html>`));
const pageLinks='<link rel="stylesheet" href="/styles/notes.css">'+[...readFileSync(new URL('../public/index.html',import.meta.url),'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match=>`<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-page-fixture',(_req,res)=>res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${pageLinks}<style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});});
test.after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});
async function mount({width=1280,rtl=false,locked=true,offscreen=false,responsivePage=false}={}) {
  const page=await browser.newPage();await page.setViewport({width,height:760});await page.goto(base+'/group-fixture');
  await page.evaluate(async({rtl,locked,offscreen,responsivePage})=>{
    localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();
    if(rtl)document.documentElement.dir='rtl';
    const layout=await import('/utils/note-board-layout.js'),canvas=await import('/components/note-board.js');
    window.featureAvailable=typeof layout.projectNoteGroupItems==='function'&&typeof canvas.renderNoteGroupFrame==='function';
    if(!window.featureAvailable)return;
    window.data={notes:[1,2,3].map(id=>({id,title:`Note ${id}`,revision:1,layout:{x:0,y:0,width:4,height:6,revision:2,position_locked:true}})),groups:[{id:1,revision:3,member_ids:[2,1],can_manage:true,layout:{x:offscreen?80:0,y:offscreen?90:0,width:4,height:6,position_locked:locked,always_on_top:true}}]};
    window.pages=new Map();window.writes=[];window.actions=[];window.view={};window.compact=false;window.filtered=false;
    const grid=document.querySelector('.notes-grid');
    window.items=()=>layout.projectNoteGroupItems(window.data,{activePages:window.pages,filtered:window.filtered});
    window.draw=()=>{window.board?.dispose();grid.innerHTML=window.items().map(item=>canvas.renderNoteGroupFrame(item,`<div class="note-card" data-id="${item.note.id}"><button data-action="open">${item.note.title}</button><div class="note-card__content"><p>Drag this text</p></div><button data-board-action="lock">Pin</button><button data-board-action="top">Top</button><button data-group-action="remove">Remove from group</button></div>`)).join('');
      window.board=canvas.wireNoteBoard(grid,{getNotes:()=>window.data.notes,getBoardItems:window.items,activePages:window.pages,canEdit:()=>true,compact:window.compact,filtered:window.filtered,viewState:window.view,getResponsiveWidth:responsivePage?()=>document.querySelector('.notes-page').clientWidth:undefined,groupDragBridge:window.bridge,onViewChange:window.draw,onGroupAction:(action,item)=>window.actions.push({action,key:item.key}),saveLayout:()=>{throw Error('group used note writer');},saveBoardCommand:async command=>{window.writes.push(command);for(const item of command.items){const owner=item.kind==='group'?window.data.groups.find(g=>g.id===item.id):window.data.notes.find(n=>n.id===item.id);owner.layout={...owner.layout,...item.layout};}window.draw();}});};window.draw();
  },{rtl,locked,offscreen,responsivePage});
  return page;
}
async function requireFeature(page){assert.equal(await page.evaluate(()=>window.featureAvailable),true,'group projection and group card renderer exist');}

test('sidebar width preserves Canvas until the responsive page crosses the phone boundary', async () => {
  const page = await mount({ width: 752, responsivePage: true }); try {
    await requireFeature(page); const canonical = await page.evaluate(() => structuredClone(window.data));
    await page.evaluate(() => { document.querySelector('.notes-scroll').style.width = '440px'; window.draw(); });
    assert.equal(await page.$eval('.notes-grid', element => element.dataset.boardView), 'canvas', 'a right rail must not turn a tablet workspace into List');
    assert.ok(await page.$eval('[data-board-key="group:1"]', element => element.getBoundingClientRect().width) >= 200, 'the canvas retains a readable world basis beside the rail');
    assert.ok(Math.abs(await page.evaluate(() => { const rect = document.querySelector('.notes-grid').getBoundingClientRect(); return window.board.clientToWorld(rect.left + 640 / 12, rect.top).x; }) - 1) < .000001);
    await page.setViewport({ width: 390, height: 760 });
    await page.waitForFunction(() => document.querySelector('.notes-grid').dataset.boardView === 'list');
    await page.setViewport({ width: 752, height: 760 });
    await page.waitForFunction(() => document.querySelector('.notes-grid').dataset.boardView === 'canvas');
    assert.deepEqual(await page.evaluate(() => window.data), canonical); assert.equal(await page.evaluate(() => window.writes.length), 0);
  } finally { await page.close(); }
});

test('sidebar zoom out fits the visible scrollport without artificial blank horizontal overflow', async () => {
  const page = await mount({ width: 752, responsivePage: true }); try {
    await page.evaluate(() => { document.querySelector('.notes-scroll').style.width = '440px'; window.draw(); });
    const canonical = await page.evaluate(() => structuredClone(window.data));
    assert.ok(await page.$eval('[data-board-key="group:1"]', element => element.getBoundingClientRect().width) >= 200);
    await page.evaluate(() => window.board.zoomBy(-.5));
    const geometry = await page.$eval('.notes-scroll', element => ({ visible: element.clientWidth, total: element.scrollWidth }));
    assert.ok(geometry.total <= geometry.visible + 1, `a fitting zoomed-out world should not add empty horizontal scrolling: ${JSON.stringify(geometry)}`);
    assert.equal(await page.evaluate(() => window.view.zoom), .5);
    assert.deepEqual(await page.evaluate(() => window.data), canonical); assert.equal(await page.evaluate(() => window.writes.length), 0);
  } finally { await page.close(); }
});

test('freeform stationary touch hold with Snap enabled preserves existing fractional placement', async () => {
  const page = await mount({ locked: false }), input = await page.createCDPSession(); try {
    await page.evaluate(() => { Object.assign(window.data.groups[0].layout, { x: .375, y: .125 }); window.draw(); window.board.setSnapToGrid(true); });
    const canonical = await page.evaluate(() => structuredClone(window.data));
    const point = await page.$eval('[data-board-key="group:1"] p', element => { const r = element.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...point }] });
    await page.waitForSelector('.note-card--moving');
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.writes.length), 0, 'stationary hold/release is not a request to snap existing positions');
    assert.deepEqual(await page.evaluate(() => window.data), canonical);
  } finally { await input.detach(); await page.close(); }
});

for (const axis of ['left', 'top']) test(`freeform ${axis} resize keeps the opposite edge at the fractional origin boundary`, async () => {
  const page = await mount({ locked: false }); try {
    await page.evaluate(() => { Object.assign(window.data.groups[0].layout, { x: 1.375, y: 1.125 }); window.draw(); });
    const before = await page.evaluate(() => structuredClone(window.data.groups[0].layout));
    const point = await page.$eval('[data-board-key="group:1"]', (element, axis) => { const r = element.getBoundingClientRect(); return { x: axis === 'left' ? r.left + 3 : r.left + r.width / 2, y: axis === 'top' ? r.top + 3 : r.top + r.height / 2 }; }, axis);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.waitForSelector('.note-card--resizing');
    await page.mouse.move(point.x - (axis === 'left' ? 300 : 0), point.y - (axis === 'top' ? 144 : 0), { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(() => window.writes.length === 1);
    const after = await page.evaluate(() => window.data.groups[0].layout);
    assert.equal(after.x + after.width, before.x + before.width); assert.equal(after.y + after.height, before.y + before.height);
    assert.ok(Number.isInteger(after.width) && Number.isInteger(after.height)); assert.ok(after.x >= 0 && after.y >= 0);
    assert.equal(axis === 'left' ? after.x : after.y, axis === 'left' ? .375 : .125);
  } finally { await page.close(); }
});

for (const snap of [false, true]) for (const scale of [1, 1.5]) test(`freeform group preview stays fluid at zoom ${scale}, final snap=${snap}`, async () => {
  const page = await mount({ locked: false }); try {
    await requireFeature(page);
    const canonical = await page.evaluate(() => structuredClone(window.data));
    assert.equal(await page.evaluate(() => window.view.snapToGrid), false, 'free movement is the default view preference');
    if (snap) await page.evaluate(() => window.board.setSnapToGrid(true));
    await page.evaluate(scale => { window.board.zoomBy(scale - 1); window.draw(); document.querySelector('.notes-scroll').scrollTo(0, 0); }, scale);
    assert.equal(await page.evaluate(() => window.view.snapToGrid), snap, 'preference survives a board rerender');
    assert.deepEqual(await page.evaluate(() => window.data), canonical, 'changing view preferences cannot rewrite existing positions');
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    const geometry = await page.$eval('[data-board-key="group:1"] p', element => {
      const r = element.getBoundingClientRect(), port = document.querySelector('.notes-scroll'), style = getComputedStyle(port);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, pitch: (port.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 12 };
    });
    const dx = 143, dy = 73, expected = { x: dx / (geometry.pitch * scale), y: dy / (48 * scale) };
    assert.ok(geometry.x > 0 && geometry.y > 0 && geometry.x + dx < 1280 && geometry.y + dy < 760, 'drag stays inside the visible canvas after zoom');
    await page.mouse.move(geometry.x, geometry.y); await page.mouse.down(); await page.mouse.move(geometry.x + dx, geometry.y + dy, { steps: 7 });
    const preview = await page.$eval('[data-board-key="group:1"]', element => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top) }));
    assert.ok(Math.abs(preview.left - dx / scale) < .1 && Math.abs(preview.top - dy / scale) < .1, 'preview follows physical pointer movement without grid jumps');
    assert.equal(await page.evaluate(() => window.writes.length), 0, 'preview is not a write');
    await page.mouse.up(); await page.waitForFunction(() => window.writes.length === 1);
    const saved = await page.evaluate(() => window.writes[0].items[0].layout);
    assert.ok(Math.abs(saved.x - (snap ? Math.round(expected.x) : expected.x)) < .00001);
    assert.ok(Math.abs(saved.y - (snap ? Math.round(expected.y) : expected.y)) < .00001);
    assert.equal(saved.width, 4); assert.equal(saved.height, 6);
    assert.deepEqual(await page.evaluate(() => window.data.groups[0].member_ids), [2, 1]);
  } finally { await page.close(); }
});
test('paging is local, stops at both ends and retains group geometry and note identity',async()=>{
 const page=await mount();try{await requireFeature(page);const group='[data-board-key="group:1"]';
  assert.equal(await page.$$eval('.note-card',n=>n.length),2);
  assert.equal(await page.$eval(`${group} [data-group-page="previous"]`,n=>n.disabled),true);
  const before=await page.$eval(group,n=>[n.style.left,n.style.top,n.style.width,n.style.height]);
  await page.focus(`${group} [data-group-page="next"]`);await page.keyboard.press('Enter');
  assert.equal(await page.$eval(group,n=>n.dataset.id),'1');
  assert.equal(await page.$eval(`${group} [data-group-page="next"]`,n=>n.disabled),true);
  assert.deepEqual(await page.$eval(group,n=>[n.style.left,n.style.top,n.style.width,n.style.height]),before);
  await page.focus(`${group} [data-group-page="overview"]`);await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>window.actions),[{action:'overview',key:'group:1'}]);
  assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});
for(const width of [320,360,1280])for(const rtl of [false,true])test(`group pager is reachable at canvas origin, ${width}px rtl=${rtl}`,async()=>{
 const page=await mount({width,rtl});try{await requireFeature(page);
  const bounds=await page.$$eval('[data-group-page]',nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
  for(const r of bounds)assert.ok(r.width>=44&&r.height>=44&&r.left>=0&&r.right<=width&&r.top>=0,JSON.stringify(r));
  assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});
test('offscreen group is reachable in List and resize/reflow never writes canonical positions',async()=>{
 const page=await mount({offscreen:true});try{await requireFeature(page);const before=await page.evaluate(()=>JSON.stringify(window.data));
  await page.setViewport({width:320,height:640});await page.waitForFunction(()=>document.querySelector('.notes-grid').dataset.boardView==='list');
  await page.focus('[data-group-page="next"]');await page.keyboard.press('Enter');
  assert.equal(await page.$eval('[data-board-key="group:1"]',n=>n.dataset.id),'1');
  await page.setViewport({width:1280,height:760});await page.waitForFunction(()=>document.querySelector('.notes-grid').dataset.boardView==='canvas');
  assert.equal(await page.evaluate(()=>JSON.stringify(window.data)),before);assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});
test('pin and top controls arrange the group, preserving membership and dashboard pins',async()=>{
 const page=await mount();try{await requireFeature(page);
  await page.click('[data-board-key="group:1"] [data-board-action="lock"]');
  await page.waitForFunction(()=>window.writes.length===1);
  const command=await page.evaluate(()=>window.writes[0]);assert.equal(command.kind,'arrange');assert.equal(command.items[0].kind,'group');assert.equal(command.items[0].layout.position_locked,false);
  await page.click('[data-board-key="group:1"] [data-board-action="top"]');await page.waitForFunction(()=>window.writes.length===2);
  assert.deepEqual(await page.evaluate(()=>window.data.groups[0].member_ids),[2,1]);
  assert.equal(await page.evaluate(()=>window.data.notes.every(n=>!n.pinned)),true);
 }finally{await page.close();}
});
test('standalone overlap access survives group paging, and controller exposes cancellable world transforms',async()=>{
 const page=await mount();try{await requireFeature(page);
  assert.equal(await page.$eval('[data-note-reveal="3"]',n=>n.textContent),'Note 3');
  assert.deepEqual(await page.evaluate(()=>['cancel','dispose','clientToWorld','adoptGroupDrag'].map(k=>typeof window.board[k])),['function','function','function','function']);
  assert.deepEqual(await page.evaluate(()=>{const r=document.querySelector('.notes-grid').getBoundingClientRect();return window.board.clientToWorld(r.left,r.top);}),{x:0,y:0});
  await page.evaluate(()=>window.board.cancel());assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});

test('unpin, move, pin keeps the whole group and locked resize preserves its anchor',async()=>{
 const page=await mount();try{await requireFeature(page);
  const group='[data-board-key="group:1"]';
  await page.click(`${group} [data-board-action="lock"]`);await page.waitForFunction(()=>window.writes.length===1);
  const point=await page.$eval(`${group} p`,n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+120,point.y+96,{steps:6});await page.mouse.up();await page.waitForFunction(()=>window.writes.length===2);
  const moved=await page.evaluate(()=>window.data.groups[0].layout);assert.ok(moved.x>0&&moved.y>0);
  await page.click(`${group} [data-board-action="lock"]`);await page.waitForFunction(()=>window.writes.length===3);
  const edge=await page.$eval(group,n=>{const r=n.getBoundingClientRect();return{x:r.left+3,y:r.top+r.height/2};});
  await page.mouse.move(edge.x,edge.y);await page.mouse.down();await new Promise(r=>setTimeout(r,500));await page.mouse.move(edge.x-110,edge.y,{steps:4});await page.mouse.up();await page.waitForFunction(()=>window.writes.length===4);
  const after=await page.evaluate(()=>window.data.groups[0]);assert.equal(after.layout.x,moved.x);assert.equal(after.layout.y,moved.y);assert.ok(after.layout.width>moved.width);assert.equal(after.layout.position_locked,true);assert.deepEqual(after.member_ids,[2,1]);
  assert.equal(await page.evaluate(()=>window.writes.every(w=>w.items.length===1&&w.items[0].kind==='group')),true);
 }finally{await page.close();}
});

test('partial group browsing never displays an unavailable member or writes from its controls',async()=>{
 const page=await mount();try{await requireFeature(page);
  await page.evaluate(()=>{window.data.notes=window.data.notes.filter(n=>n.id!==1);window.data.groups[0].can_manage=false;window.draw();});
  assert.equal(await page.$$eval('[data-group-page]',nodes=>nodes.length),0);
  assert.equal(await page.$eval('[data-board-key="group:1"]',node=>node.dataset.id),'2');
  await page.click('[data-board-key="group:1"] [data-board-action="lock"]');
  assert.equal(await page.evaluate(()=>window.writes.length),0);
  assert.deepEqual(await page.evaluate(()=>window.data.groups[0].member_ids),[2,1],'projection cannot dissolve a canonical group');
 }finally{await page.close();}
});

test('zoom retains 44px group controls and fractional world coordinates',async()=>{
 const page=await mount();try{await requireFeature(page);
  for(const amount of [-.75,1.75]) {
    await page.evaluate(amount=>window.board.zoomBy(amount),amount);
    const sizes=await page.$$eval('[data-group-page]',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{width:r.width,height:r.height};}));
    assert.ok(sizes.every(r=>r.width>=43.99&&r.height>=43.99),JSON.stringify(sizes));
    const point=await page.evaluate(()=>{const grid=document.querySelector('.notes-grid'),r=grid.getBoundingClientRect(),port=document.querySelector('.notes-scroll'),s=getComputedStyle(port),pitch=(port.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight))/12;return window.board.clientToWorld(r.left+pitch*window.view.zoom*2.5,r.top+48*window.view.zoom*3.5);});
    assert.deepEqual(point,{x:2.5,y:3.5});
  }
  assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});

test('viewport or permission changes cancel active group moves without a write',async()=>{
 for(const reason of ['viewport','height','permission']) {
  const page=await mount({locked:false});try{await requireFeature(page);
   const point=await page.$eval('[data-board-key="group:1"] p',n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
   await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+80,point.y+48,{steps:4});
   if(reason==='viewport')await page.setViewport({width:1200,height:700});
   else if(reason==='height')await page.setViewport({width:1280,height:700});
   else await page.evaluate(()=>{window.data.groups[0].can_manage=false;window.board.refresh();});
   await page.waitForFunction(()=>window.board.busy()===false,{timeout:1000});
   await page.mouse.up();assert.equal(await page.evaluate(()=>window.writes.length),0);
  }finally{await page.close();}
 }
});

test('cancel releases background pointer capture and stops subsequent panning',async()=>{
 const page=await mount();try{await requireFeature(page);
  await page.evaluate(()=>{window.data.notes[2].layout.y=40;window.draw();});
  await page.mouse.move(950,250);await page.mouse.down();await page.mouse.move(900,200,{steps:4});
  await page.evaluate(()=>window.board.cancel());
  const before=await page.$eval('.notes-scroll',n=>({x:n.scrollLeft,y:n.scrollTop}));
  await page.mouse.move(800,100,{steps:4});await page.mouse.up();
  assert.deepEqual(await page.$eval('.notes-scroll',n=>({x:n.scrollLeft,y:n.scrollTop})),before);
  assert.equal(await page.evaluate(()=>window.board.busy()),false);
 }finally{await page.close();}
});

test('adopted overview drag cancels on another pointer or Escape and drops through one bridge callback',async()=>{
 const page=await mount();try{await requireFeature(page);
  await page.evaluate(()=>{window.bridgeEvents=[];window.bridge={hoverTarget:(item,session)=>window.bridgeEvents.push(['hover',item.key,session.world]),leaveTarget:()=>{},dropTarget:(item,session)=>{window.bridgeEvents.push(['drop',item?.key||null,session.world]);return true;}};window.draw();});
  for(const reason of ['pointer','escape']) {
   await page.evaluate(()=>window.board.adoptGroupDrag({pointerId:10,selected_ids:[2],source_group_id:1}));
   if(reason==='pointer')await page.evaluate(()=>document.querySelector('.notes-scroll').dispatchEvent(new PointerEvent('pointerdown',{pointerId:11,pointerType:'touch',button:0,bubbles:true})));
   else await page.keyboard.press('Escape');
   await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointerup',{pointerId:10,clientX:600,clientY:500})));
  }
  assert.equal(await page.evaluate(()=>window.bridgeEvents.length),0);
  await page.evaluate(()=>{window.board.adoptGroupDrag({pointerId:10,selected_ids:[2],source_group_id:1});window.dispatchEvent(new PointerEvent('pointerup',{pointerId:10,clientX:600,clientY:500}));});
  assert.equal(await page.evaluate(()=>window.bridgeEvents.filter(e=>e[0]==='drop').length),1);
  assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});

test('a delayed bridge result cannot save a layout after the board is disposed',async()=>{
 const page=await mount({locked:false});try{await requireFeature(page);
  await page.evaluate(()=>{window.bridge={hoverTarget:()=>{},leaveTarget:()=>{},dropTarget:()=>new Promise(resolve=>{window.finishBridge=resolve;})};window.draw();});
  const point=await page.$eval('[data-board-key="group:1"] p',n=>{const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+100,point.y+48,{steps:4});await page.mouse.up();
  await page.waitForFunction(()=>typeof window.finishBridge==='function');
  await page.evaluate(async()=>{window.board.dispose();window.finishBridge(false);await new Promise(resolve=>setTimeout(resolve,20));});
  assert.equal(await page.evaluate(()=>window.writes.length),0);
 }finally{await page.close();}
});

test('filtered group controls cannot write the packed projection while local paging stays available',async()=>{
 const page=await mount({offscreen:true});try{await requireFeature(page);
  await page.evaluate(()=>{window.filtered=true;window.draw();});
  for(const action of ['lock','top'])await page.click(`[data-board-key="group:1"] [data-board-action="${action}"]`);
  await page.click('[data-board-key="group:1"] [data-group-action="remove"]');
  assert.equal(await page.evaluate(()=>window.writes.length),0);
  assert.equal(await page.evaluate(()=>window.actions.length),0);
  await page.click('[data-board-key="group:1"] [data-group-page="next"]');
  assert.equal(await page.$eval('[data-board-key="group:1"]',node=>node.dataset.id),'1');
  assert.deepEqual(await page.evaluate(()=>({x:window.data.groups[0].layout.x,y:window.data.groups[0].layout.y})),{x:80,y:90});
 }finally{await page.close();}
});

async function mountPage({arrange=false,width=1280}={}) {
 const notes=[1,2].map(id=>({id,title:id===1?'Keep visible':'Other note',content:'- [ ] Keep content editable\n\nA body paragraph.',color:'#C7DED9',revision:2,created_by:1,creator_name:'Parent',permissions:{view:true,edit:true,delete:true,manage_visibility:true,...(id===1&&arrange===false?{arrange:false}:{})},layout:{x:id===1?0:8,y:id===1?0:10,width:4,height:6,revision:1}}));
 const writes=[],page=await browser.newPage();page.setDefaultTimeout(4000);await page.setViewport({width,height:760});
 await page.setRequestInterception(true);page.on('request',request=>{
  const path=new URL(request.url()).pathname;if(!path.startsWith('/api/v1/'))return request.continue();
  if(request.method()!=='GET')writes.push({path,body:JSON.parse(request.postData()||'{}')});
  const note=notes.find(note=>note.id===Number(path.split('/')[4]));
  let value={data:[]};
  if(path==='/api/v1/auth/me')value={csrfToken:'fixture'};
  if(path==='/api/v1/notes/board')value={data:{notes,groups:[]}};
  if(path==='/api/v1/notes/group-operations'){
   const result=arrangeNotesFixture(notes,JSON.parse(request.postData()));
   return request.respond({status:result.status,contentType:'application/json',body:JSON.stringify(result.body)});
  }
  if(path.endsWith('/pin')&&note){note.pinned=1;note.revision++;value={data:note};}
  if(path.endsWith('/check')&&note){note.content=note.content.replace('- [ ]','- [x]');note.revision++;value={data:note};}
  request.respond({status:path.endsWith('/changes')?204:200,contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto(base+'/group-page-fixture');await page.evaluate(async()=>{localStorage.setItem('yuvomi-locale','en');await(await import('/i18n.js')).initI18n();window.yuvomi={showToast(){}};(await import('/permissions.js')).setPermissions({admin:true});window.stopPage=await(await import('/pages/notes.js')).render(document.querySelector('#main-content'),{user:{id:1}});});
 return {page,writes};
}
for(const width of [360,1280])test(`singleton arrange denial hides structural controls but retains note content actions at ${width}px`,async()=>{
 const {page,writes}=await mountPage({width});try{
  const card='.note-card[data-id="1"]';
  assert.equal(await page.$$eval(`${card} [data-board-action],${card} [data-group-action]`,nodes=>nodes.length),0);
  assert.equal(await page.$$eval(`${card} [data-action="pin"],${card} [data-action="delete"],${card} [data-action="open"]`,nodes=>nodes.length),3);
  await page.click(`${card} .note-md-box`);await page.waitForFunction(()=>document.querySelector('.note-card[data-id="1"] .note-md-box').getAttribute('aria-checked')==='true');
  await page.click(`${card} .note-card__menu summary`);await page.click(`${card} [data-action="pin"]`);
  await page.waitForFunction(()=>document.querySelector('.note-card[data-id="1"]').classList.contains('note-card--pinned'));
  assert.ok(writes.some(write=>write.path==='/api/v1/notes/1/check'));
  assert.ok(writes.some(write=>write.path==='/api/v1/notes/1/pin'));
  assert.ok(!writes.some(write=>write.path.endsWith('/layout')));
 }finally{await page.close();}
});
test('singleton arrange denial blocks injected numeric/flag controls, dragging and Organize membership',async()=>{
 const {page,writes}=await mountPage();try{
  const card='.note-card[data-id="1"]';
  await page.$eval(card,node=>node.insertAdjacentHTML('beforeend','<button data-board-action="adjust">Injected adjust</button><button data-board-action="top">Injected top</button>'));
  await page.click(`${card} [data-board-action="adjust"]`);assert.equal(await page.$$eval('[data-layout-editor]',nodes=>nodes.length),0);
  await page.click(`${card} [data-board-action="top"]`);
  const point=await page.$eval(`${card} .note-card__content .note-md-p`,node=>{const r=node.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+100,point.y+80,{steps:4});await page.mouse.up();
  await page.keyboard.press('Escape');await page.click('#notes-organize');
  await page.waitForFunction(()=>document.querySelector('#notes-organize').disabled===false);
  assert.ok(!writes.some(write=>write.path==='/api/v1/notes/1/layout'));
  const organize=writes.find(write=>write.path==='/api/v1/notes/group-operations');assert.ok(organize);
  assert.deepEqual(organize.body.items.map(item=>item.id),[2]);
  assert.deepEqual(organize.body.expected,{groups:[],notes:[{id:2,revision:2,layout_revision:1}]});
 }finally{await page.close();}
});
test('filtered production cards are browse-only while content edit and dashboard pin stay present',async()=>{
 const {page,writes}=await mountPage({arrange:true});try{
  await page.type('#notes-search','Keep visible');
  await page.waitForFunction(()=>document.querySelectorAll('.note-card').length===1);
  assert.equal(await page.$$eval('.note-card [data-board-action],.note-card [data-group-action]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('.note-card [data-action="pin"],.note-card [data-action="open"]',nodes=>nodes.length),2);
  await page.$eval('.note-card',node=>node.insertAdjacentHTML('beforeend','<button data-board-action="adjust">Injected adjust</button><button data-board-action="top">Injected top</button>'));
  await page.click('.note-card [data-board-action="adjust"]');assert.equal(await page.$$eval('[data-layout-editor]',nodes=>nodes.length),0);
  await page.click('.note-card [data-board-action="top"]');assert.equal(writes.length,0);
 }finally{await page.close();}
});
