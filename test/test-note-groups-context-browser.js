import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express(); app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/groups-context-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
const rect = { x:2, y:2, width:4, height:6, position_locked:false, always_on_top:false };
const fixture = () => ({ notes:[1,2,3].map(id => ({ id, title:`PRIVATE CONTEXT NOTE ${id}`, content:`Private body ${id}`, color:'#C7DED9', created_by:1, visibility:'private', revision:id+10, permissions:{view:true,edit:true,delete:true,manage_visibility:true}, layout:{...rect,x:id*2,revision:id+20} })),
  groups:[{id:11,revision:7,layout:{...rect},member_ids:[1,2],can_manage:true}] });
let snapshot, requests, writes, mode, heldRead, heldWrite, browser, server, base;
function apply(command) {
  if (command.kind === 'arrange') for (const item of command.items) {
    const target = item.kind === 'group' ? snapshot.groups.find(g => g.id === item.id) : snapshot.notes.find(n => n.id === item.id);
    target.layout = { ...target.layout, ...item.layout }; if (item.kind === 'group') target.revision++;
  }
  return { operation_id:command.operation_id, replayed:writes.filter(write => write.operation_id === command.operation_id).length > 1, board:structuredClone(snapshot), undo_available:command.kind !== 'undo' };
}
app.use('/api/v1', (req, res) => {
  requests.push(req.path);
  if (req.path === '/auth/me') return res.json({csrfToken:'synthetic'});
  if (req.path === '/notes/members') return res.json({data:[]});
  if (req.method === 'GET' && req.path === '/notes/board') {
    const value = structuredClone(snapshot);
    if (mode === 'hold-read' || mode === 'hold-denied-read') {
      const denied=mode==='hold-denied-read'; mode=null;
      heldRead=()=>{heldRead=null;if(!res.destroyed && !res.writableEnded)denied?res.status(403).json({error:'Obsolete access denial'}):res.json({data:value});}; return;
    }
    return res.json({data:value});
  }
  if (req.method === 'GET' && req.path === '/notes') return res.json({data:snapshot.notes});
  if (req.path === '/notes/group-operations' && req.method === 'POST') {
    writes.push(structuredClone(req.body));
    // A truncated response yields an unknown outcome without Chromium silently
    // repeating the transport, which a socket reset can trigger automatically.
    if (mode === 'truncate-write') { mode = null; res.type('json').send('{"data":'); return; }
    const result = apply(req.body);
    if (mode === 'hold-write') { mode = null; heldWrite = () => { heldWrite=null; if(!res.destroyed && !res.writableEnded)res.json({data:result}); }; return; }
    return res.json({data:result});
  }
  return res.json({data:[]});
});
test.before(async () => {
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); base=`http://127.0.0.1:${server.address().port}`;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
async function mount({recovery=false,httpCrypto=false}={}) {
  snapshot=fixture(); requests=[]; writes=[]; mode=null; heldRead=null; heldWrite=null;
  const page=await browser.newPage(); page.setDefaultTimeout(3000); await page.setViewport({width:1280,height:900});
  if (recovery) {
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/pages/notes.js') return request.respond({status:200,contentType:'text/javascript',body:readFileSync(new URL('../public/pages/notes.js',import.meta.url),'utf8').replace('const NOTE_GROUPS_INTERFACE_ENABLED = true;','const NOTE_GROUPS_INTERFACE_ENABLED = false;')});
      request.continue();
    });
  }
  await page.goto(base+'/groups-context-test');
  await page.evaluate(async httpCrypto => {
    if (httpCrypto) Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});
    // This is an online loopback fixture; socket loss is exercised at the HTTP boundary.
    Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});
    class Stream extends EventTarget { constructor(){super();window.noteStream=this;} close(){this.closed=true;} }
    window.EventSource=Stream; window.yuvomi={showToast(){}};
    localStorage.setItem('yuvomi-locale','en'); await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({admin:true});
    (await import('/utils/device-context.js')).acceptAuthentication({authContext:'human-test'});
    window.stopNotes=await (await import('/pages/notes.js')).render(document.getElementById('main-content'),{user:{id:1}});
  },httpCrypto);
  return page;
}
const groupCard='.note-card[data-group-id="11"]';
async function toggleTop(page) {
  await page.click(`${groupCard} summary`);
  await page.click(`${groupCard} [data-board-action="top"]`);
}
async function refresh(page) { await page.evaluate(()=>window.noteStream.dispatchEvent(new Event('change'))); }
const until=async predicate=>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for fixture request');await new Promise(resolve=>setTimeout(resolve,10));}};

test('Notes can arrange on supported local HTTP without crypto.randomUUID', async () => {
  const page=await mount({httpCrypto:true});
  try {
    await toggleTop(page); await page.waitForSelector('[data-group-undo]');
    assert.match(writes[0].operation_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { await page.close(); }
});

test('Notes loads only the grouped authorized board and keeps snapshots out of browser storage', async () => {
  const page=await mount();
  try {
    assert.equal(await page.$eval(groupCard,node=>node.dataset.id),'1');
    assert.ok(requests.includes('/notes/board')); assert.ok(!requests.includes('/notes'));
    const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
    assert.ok(!storage.includes('PRIVATE CONTEXT')); assert.equal(writes.length,0);
  } finally { await page.close(); }
});
test('an uncertain group write retries the identical frozen body and exposes revision-checked Undo', async () => {
  const page=await mount();
  try {
    mode='truncate-write'; await toggleTop(page);
    await page.waitForSelector('[data-group-retry]').catch(async error=>assert.fail(`${error.message}: ${JSON.stringify({writes,status:await page.$eval('#notes-board-status',node=>node.textContent),actions:await page.$$eval('#notes-group-actions',nodes=>nodes.map(node=>node.textContent))})}`));
    assert.equal(writes.length,1); const first=structuredClone(writes[0]);
    assert.deepEqual(first.expected.notes.map(n=>n.id),[1,2]); assert.deepEqual(first.expected.groups,[{id:11,revision:7}]);
    await page.click('[data-group-retry]'); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length,2); assert.deepEqual(writes[1],first);
    await page.click('[data-group-undo]'); await until(()=>writes.length===3);
    assert.equal(writes[2].kind,'undo'); assert.equal(writes[2].undo_operation_id,first.operation_id);
    assert.deepEqual(writes[2].expected,{groups:[],notes:[]});
  } finally { await page.close(); }
});
test('delayed mutation responses cannot repopulate notes after auth context teardown', async () => {
  const page=await mount();
  try {
    mode='hold-write'; await toggleTop(page); await until(()=>heldWrite);
    await page.evaluate(async()=>{(await import('/utils/device-context.js')).invalidateAuthentication();window.dispatchEvent(new Event('auth:context-ending'));});
    heldWrite(); await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await page.$eval('#main-content',node=>node.textContent),'');
    assert.equal(await page.$('[data-group-retry]'),null);
  } finally { heldWrite?.(); await page.close(); }
});
test('a remote revision change cancels an open geometry draft before confirmation', async () => {
  const page=await mount();
  try {
    await page.click(`${groupCard} summary`); await page.click(`${groupCard} [data-board-action="adjust"]`);
    await page.waitForSelector('#note-layout-save');
    snapshot.groups[0].revision++; snapshot.groups[0].layout.x=7;
    await refresh(page); await page.waitForFunction(()=>!document.querySelector('#note-layout-save'));
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});
test('a read started before a successful command cannot overwrite its returned board', async () => {
  const page=await mount();
  try {
    mode='hold-read'; await refresh(page); await until(()=>heldRead);
    await toggleTop(page); await page.waitForSelector('[data-group-undo]');
    heldRead(); await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await page.$eval(`${groupCard} [data-board-action="top"]`,node=>node.getAttribute('aria-pressed')),'true');
  } finally { heldRead?.(); await page.close(); }
});
test('filtering disables Organize and cannot submit structural changes from its packed preview', async () => {
  const page=await mount();
  try {
    await page.type('#notes-search','PRIVATE CONTEXT NOTE 1');
    await page.waitForFunction(()=>{const button=document.querySelector('#notes-organize');return button.hidden||button.disabled;});
    await page.evaluate(()=>document.querySelector('#notes-organize').click());
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});
test('an obsolete read denial cannot clear a newer successful authorized board', async () => {
  const page=await mount();
  try {
    mode='hold-denied-read'; await refresh(page); await until(()=>heldRead);
    await toggleTop(page); await page.waitForSelector('[data-group-undo]');
    heldRead(); await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await page.$$eval('.note-card',nodes=>nodes.length),2);
    assert.equal(await page.$eval(`${groupCard} [data-board-action="top"]`,node=>node.getAttribute('aria-pressed')),'true');
  } finally { heldRead?.(); await page.close(); }
});
test('Organize sends one complete mixed board snapshot and preserves every item size', async () => {
  const page=await mount();
  try {
    await page.click('#notes-organize'); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length,1);
    assert.equal(writes[0].kind,'arrange');
    assert.deepEqual(writes[0].items.map(item=>[item.kind,item.id]).sort(),[['group',11],['note',3]]);
    assert.deepEqual(writes[0].expected,{groups:[{id:11,revision:7}],notes:[1,2,3].map(id=>({id,revision:id+10,layout_revision:id+20}))});
    assert.ok(writes[0].items.every(item=>item.layout.width===4 && item.layout.height===6));
  } finally { await page.close(); }
});
test('a held mutation response cannot restore a note removed by same-context access refresh', async () => {
  const page=await mount();
  try {
    mode='hold-write'; await toggleTop(page); await until(()=>heldWrite);
    snapshot.notes=snapshot.notes.filter(note=>note.id!==2); snapshot.groups=[];
    await refresh(page); await page.waitForFunction(()=>!document.querySelector('[data-group-id="11"]'));
    heldWrite(); await new Promise(resolve=>setTimeout(resolve,80));
    assert.equal(await page.$('[data-id="2"]'),null); assert.equal(await page.$('[data-group-id="11"]'),null);
    assert.ok(!(await page.$eval('#main-content',node=>node.textContent)).includes('PRIVATE CONTEXT NOTE 2'));
  } finally { heldWrite?.(); await page.close(); }
});
test('recovery interface shows flat authorized notes and disables only structural controls', async () => {
  const page=await mount({recovery:true});
  try {
    assert.equal(await page.$$eval('.note-card',nodes=>nodes.length),3);
    assert.equal(await page.$('[data-group-id]'),null);
    assert.equal(await page.$('[data-board-action="top"]'),null);
    assert.equal(await page.$('[data-board-action="lock"]'),null);
    assert.equal(await page.$$eval('[data-action="pin"]',nodes=>nodes.length),3);
    assert.equal(await page.$eval('#notes-organize',node=>node.hidden||node.disabled),true);
    await page.evaluate(()=>document.querySelector('#notes-organize').click()); assert.equal(writes.length,0);
  } finally { await page.close(); }
});
