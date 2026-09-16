import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const styles = [...readFileSync(`${publicDir}/index.html`, 'utf8').matchAll(/<link rel="stylesheet" href="([^\"]+)"\s*\/>/g)].map(match => match[0]).join('\n');
const app = express(); app.use(express.json()); app.use(express.static(publicDir));
let server, browser, base, catalog, balance, writes, failRedeem, sequence, version;
const streams = new Set();
function reset() { catalog = []; balance = 50; writes = []; failRedeem = false; sequence = 0; version = 1; }
function publish() { version++; for (const stream of streams) stream.write(`event: change\ndata: ${JSON.stringify({ version })}\n\n`); }
app.get('/rewards-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<link rel="stylesheet" href="/styles/rewards.css"><script src="/lucide.min.js"></script><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}html,body{margin:0}#main-content{height:100vh;overflow:auto}</style></head><body><main id="main-content"></main></body></html>`));
app.get('/api/v1/rewards/changes', (req,res) => { res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.flushHeaders(); streams.add(res); res.write(`event: change\ndata: ${JSON.stringify({ version })}\n\n`); req.on('close', () => streams.delete(res)); });
app.use('/api/v1', (req,res) => {
  res.set('X-CSRF-Token', 'fixture');
  if (req.path === '/auth/me') return res.json({ user: { id:1, role:'admin' }, csrfToken:'fixture' });
  if (req.path === '/rewards/overview') return res.json({ data: { me:1, isAdmin:true, balances:[{ id:1, display_name:'Grace', balance }], catalog:catalog.filter(item => item.is_active !== 0), setup:{ participantCount:1, pointedTaskCount:1, catalogCount:catalog.length } } });
  if (req.path === '/rewards/redemptions' && req.method === 'GET') return res.json({ data:[] });
  if (req.path === '/rewards/ledger') return res.json({ data:[] });
  if (req.path === '/rewards/catalog' && req.method === 'GET') return res.json({ data:req.query.all ? catalog : catalog.filter(item => item.is_active !== 0) });
  if (req.path === '/rewards/catalog' && req.method === 'POST') { const item = { id:++sequence, is_active:1, ...req.body }; catalog.push(item); writes.push({ method:req.method, path:req.path, body:req.body }); publish(); return res.status(201).json({ data:item }); }
  if (/^\/rewards\/catalog\/\d+$/.test(req.path)) { const item = catalog.find(item => item.id === Number(req.path.split('/').at(-1))); writes.push({ method:req.method, path:req.path, body:req.body }); if (req.method === 'DELETE') item.is_active = 0; else Object.assign(item, req.body, { is_active:req.body.is_active === false ? 0 : 1 }); publish(); return res.json({ data:item }); }
  if (req.path === '/rewards/redemptions' && req.method === 'POST') {
    writes.push({ method:req.method, path:req.path, body:req.body, key:req.get('Idempotency-Key') });
    if (failRedeem) { failRedeem = false; return res.status(503).json({ error:'Connection interrupted. Retry safely.' }); }
    balance -= catalog.find(item => item.id === req.body.catalog_id).cost; publish(); return res.json({ data:{ id:1 } });
  }
  res.json({ data:[] });
});
test.before(async () => {
  server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.on('listening',resolve)); base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless:true, executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args:['--no-sandbox','--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); for (const stream of streams) stream.end(); await new Promise(resolve => server?.close(resolve) || resolve()); });
test.beforeEach(reset);
async function mount({ width=1280,height=900,user={id:1,role:'admin'},query='',theme='light',palette='warm',mobile=false }={}) {
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setViewport({width,height,isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});
  if(mobile) await page.setUserAgent('Mozilla/5.0 (Linux; Android 16; Apolosign Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.155 Safari/537.36 FullyKiosk/1.59');
  await page.goto(`${base}/rewards-test${query}`);
  await page.evaluate(async ({user,theme,palette}) => {
    localStorage.clear(); localStorage.setItem('yuvomi-locale','en'); window.yuvomi={showToast(){}};
    document.documentElement.dataset.theme=theme; document.documentElement.dataset.colorTheme=palette; document.documentElement.dataset.typography='serif';
    await (await import('/i18n.js')).initI18n();
    window.stopRewards=await(await import('/pages/rewards.js')).render(document.querySelector('main'),{user});
  },{user,theme,palette});
  return page;
}
async function openPicker(page, current=null, userId=1) {
  await page.evaluate(async ({current,userId}) => { window.pickerResult='pending'; (await import('/components/emoji-picker.js')).openEmojiPicker({current,userId,locale:'en'}).then(value=>window.pickerResult=value); },{current,userId});
  await page.waitForSelector('.emoji-picker__tile');
}
async function search(page, query) { await page.$eval('.emoji-picker input', (input,value) => {input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},query); }
const wait = ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('overview setup Create Reward opens the real editor, picker preserves fields, and CRUD keeps full sequences',async()=>{
  const page=await mount();
  try {
    await page.click('[data-setup=catalog]'); await page.waitForSelector('#rw-reward-form');
    await page.type('#rw-reward-name','Family movie'); await page.type('#rw-reward-cost','10');
    await page.click('#rw-choose-icon'); await page.waitForSelector('.emoji-picker__tile'); await search(page,'family');
    await page.evaluate(()=>document.querySelector('.emoji-picker [data-emoji="👨‍👩‍👧‍👦"]').click());
    assert.equal(await page.$eval('#rw-reward-name',e=>e.value),'Family movie');
    assert.equal(await page.$eval('#rw-reward-icon',e=>e.value),'👨‍👩‍👧‍👦');
    await page.click('#rw-reward-submit'); await page.waitForFunction(()=>!document.querySelector('#rw-reward-form'));
    assert.equal(catalog[0].icon,'👨‍👩‍👧‍👦');
    await page.click('[data-tab-id=catalog]'); await page.waitForSelector('[data-edit="1"]'); await page.click('[data-edit="1"]');
    await page.$eval('#rw-reward-name',e=>e.value='Movie night'); await page.click('#rw-reward-active'); await page.click('#rw-reward-submit');
    await page.waitForFunction(()=>!document.querySelector('#rw-reward-form')); await page.waitForSelector('[data-edit="1"]');
    assert.equal(catalog[0].name,'Movie night'); assert.equal(catalog[0].is_active,0);
    await page.click('[data-edit="1"]'); await page.click('#rw-reward-delete'); await page.waitForSelector('#confirm-modal-ok'); await page.click('#confirm-modal-ok');
    await page.waitForFunction(()=>!document.querySelector('#confirm-modal-ok')); assert.ok(writes.some(row=>row.method==='DELETE'));
  } finally { await page.close(); }
});
test('direct create navigation is consumed once and restricted members cannot open create or edit',async()=>{
  const admin=await mount({query:'?new=1'});
  try{await admin.waitForSelector('#rw-reward-form');assert.equal(await admin.evaluate(()=>location.search),'');}finally{await admin.close();}
  const child=await mount({query:'?new=1',user:{id:1,role:'member'}});
  try{assert.equal(await child.$('#rw-reward-form'),null);await child.click('[data-tab-id=catalog]');assert.equal(await child.$('[data-edit]'),null);assert.equal(await child.$('.rw-add-reward'),null);}finally{await child.close();}
});
test('duplicate clicks and uncertain redemption retries keep one request key; live update reaches another open client',async()=>{
  catalog=[{id:1,name:'Movie',icon:'🍿',cost:10,is_active:1}];
  const page=await mount(), other=await mount();
  try{
    failRedeem=true;await page.click('.rw-redeem-open');await page.waitForSelector('#rw-redeem-submit');
    await page.evaluate(()=>{const form=document.querySelector('#rw-redeem-form');form.requestSubmit();form.requestSubmit();});
    await page.waitForSelector('#rw-redeem-error:not([hidden])');assert.equal(writes.length,1);
    await page.click('#rw-redeem-submit');await page.waitForFunction(()=>!document.querySelector('#rw-redeem-form'));
    assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);assert.equal(writes[0].key,writes[0].body.request_id);
    await other.waitForFunction(()=>document.querySelector('[data-countup="40"]')); assert.equal(balance,40);
  }finally{await page.close();await other.close();}
});
test('insufficient balance disables request and does not dispatch a deduction',async()=>{
  catalog=[{id:1,name:'Movie',cost:100,is_active:1}];
  const page=await mount({user:{id:1,role:'member'}});
  try{assert.equal(await page.$eval('.rw-redeem-open',e=>e.disabled),true);assert.equal(writes.length,0);}finally{await page.close();}
});

for(const viewport of [{width:390,height:844,mobile:true,theme:'dark',palette:'warm'},{width:1024,height:768,mobile:true,theme:'light',palette:'neutral'},{width:1920,height:1080,mobile:true,theme:'dark',palette:'cool'},{width:2560,height:1440,theme:'light',palette:'warm'}])test(`picker ${viewport.width}×${viewport.height}: local search, bounded grid, touch scrolling, selection and focus`,async t=>{
  const page=await mount(viewport);
  try{
    await openPicker(page);await wait(80);
    const geometry=await page.$eval('.emoji-picker',e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,top:r.top,bottom:r.bottom,viewport:innerHeight,tiles:e.querySelectorAll('.emoji-picker__tile').length,focus:document.activeElement.tagName};});
    assert.ok(geometry.left>=0&&geometry.top>=0&&geometry.bottom<=geometry.viewport+1);assert.ok(Math.abs(geometry.left-(viewport.width-geometry.width)/2)<2);assert.ok(geometry.tiles<=196);assert.equal(geometry.focus,'BUTTON');
    const measurements=await page.evaluate(()=>{const times=[];const input=document.querySelector('.emoji-picker input');for(const query of ['movie','money','ice cream','birthday']){const start=performance.now();input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));times.push(performance.now()-start);}return times;});
    t.diagnostic(`input-to-DOM search ${measurements.map(n=>n.toFixed(2)).join('/')} ms; ${geometry.tiles} live tiles`);assert.ok(Math.max(...measurements)<100);
    const requests=[];page.on('request',req=>requests.push(req.url()));await page.setOfflineMode(true);await search(page,'ice cream');assert.equal(await page.$$eval('.emoji-picker__tile',es=>es.map(e=>e.dataset.emoji).join(',')),'🍨,🍦');assert.equal(requests.length,0);await page.setOfflineMode(false);
    await page.click('[data-category="1"]');
    if(process.env.REWARDS_QA_SCREENSHOTS){mkdirSync(process.env.REWARDS_QA_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.REWARDS_QA_SCREENSHOTS}/picker-${viewport.width}-${viewport.theme}-${viewport.palette}.png`});}
    const before=await page.$eval('.emoji-picker__viewport',e=>e.scrollTop);
    const rect=await page.$eval('.emoji-picker__viewport',e=>{const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height*.8,toY:r.top+r.height*.2};});
    if(viewport.mobile){const cdp=await page.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y,id:1}]});for(let step=1;step<=5;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y+(rect.toY-rect.y)*step/5,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else{await page.$eval('.emoji-picker__viewport',e=>e.scrollTop=480);}
    await wait(150);assert.ok(await page.$eval('.emoji-picker__viewport',e=>e.scrollTop)>before);assert.equal(await page.evaluate(()=>window.pickerResult),'pending');assert.equal(await page.$eval('.emoji-picker__variants',e=>e.hidden),true);
    await search(page,'birthday');await page.click('[data-emoji="🎂"]');assert.equal(await page.evaluate(()=>window.pickerResult),'🎂');
    await openPicker(page,'🎂');assert.equal(await page.$eval('[data-emoji="🎂"]',e=>e.getAttribute('aria-pressed')),'true');
    await page.click('[data-cancel]');
  }finally{await page.close();}
});
test('skin variations keep full sequences, keyboard browsing works and Recent does not leak between users',async()=>{
  const page=await mount();try{
    await openPicker(page);await search(page,'thumbs up');await page.focus('[data-emoji="👍"]');await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');
    await page.waitForSelector('.emoji-picker__variants:not([hidden])');await page.click('[data-emoji="👍🏽"]');assert.equal(await page.evaluate(()=>window.pickerResult),'👍🏽');
    await openPicker(page,null,2);assert.equal(await page.$('[data-emoji="👍🏽"]'),null);await page.click('[data-category="1"]');await page.focus('.emoji-picker__tile');await page.keyboard.press('ArrowDown');assert.ok(Number(await page.evaluate(()=>document.activeElement.dataset.index))>0);await page.click('[data-cancel]');
  }finally{await page.close();}
});

test('Android-compatible hold opens variants without selection; keyboard-height viewport keeps controls reachable',async()=>{
  const page=await mount({width:960,height:600,mobile:true});try{
    await openPicker(page);await search(page,'thumbs up');
    const p=await page.$eval('[data-emoji="👍"]',e=>{const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
    const cdp=await page.createCDPSession();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await wait(600);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
    assert.equal(await page.evaluate(()=>window.pickerResult),'pending');assert.equal(await page.$eval('.emoji-picker__variants',e=>e.hidden),false);
    await page.click('[data-close-variants]');await page.setViewport({width:960,height:360,isMobile:true,hasTouch:true});await wait(50);
    const box=await page.$eval('.emoji-picker',e=>{const r=e.getBoundingClientRect(),f=e.querySelector('footer').getBoundingClientRect(),s=e.querySelector('input').getBoundingClientRect();return{bottom:r.bottom,footer:f.bottom,search:s.top,height:innerHeight};});
    assert.ok(box.bottom<=box.height+1&&box.footer<=box.height+1&&box.search>=0,JSON.stringify(box));
    await search(page,'ice cream');await page.click('[data-emoji="🍨"]');assert.equal(await page.evaluate(()=>window.pickerResult),'🍨');
  }finally{await page.close();}
});

test('cold categories reveal at most 48 initial glyphs, progressively fill visible rows, and cancel stale search work',async()=>{
  const page=await mount({width:1920,height:1080,mobile:true});try{
    await openPicker(page);
    const initial=await page.evaluate(()=>{
      document.querySelector('[data-category="1"]').click();
      const buttons=[...document.querySelectorAll('.emoji-picker__grid button')];
      return {glyphs:buttons.filter(button=>button.textContent).length,dom:buttons.length,pending:buttons.filter(button=>button.disabled&&button.hasAttribute('data-pending-glyph')).length};
    });
    assert.equal(initial.glyphs,48);assert.ok(initial.dom<=144);assert.equal(initial.pending,initial.dom-48);
    await page.waitForFunction(()=>document.querySelector('.emoji-picker__grid').getAttribute('aria-busy')==='false');
    assert.equal(await page.$eval('.emoji-picker__grid [data-index="119"]',el=>el.disabled),false);
    assert.equal(await page.$eval('.emoji-picker__grid [data-index="120"]',el=>el.disabled),true);
    await page.$eval('.emoji-picker__viewport',el=>el.scrollTop=50);
    await page.waitForFunction(()=>!document.querySelector('.emoji-picker__grid [data-index="120"]').disabled);
    await page.evaluate(()=>{
      const grid=document.querySelector('.emoji-picker__grid');window.retainedTile=grid.querySelector('[data-index="36"]');window.rowChanges=[];
      window.rowObserver=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes])if(node.dataset?.index)window.rowChanges.push(Number(node.dataset.index));});
      window.rowObserver.observe(grid,{childList:true});document.querySelector('.emoji-picker__viewport').scrollTop=120;
    });
    await page.waitForSelector('.emoji-picker__grid [data-index="144"]');
    const rowChanges=await page.evaluate(()=>{window.rowObserver.disconnect();return {same:window.retainedTile===document.querySelector('.emoji-picker__grid [data-index="36"]'),indexes:window.rowChanges};});
    assert.equal(rowChanges.same,true);assert.ok(rowChanges.indexes.every(index=>index<12||index>=144),JSON.stringify(rowChanges));
    await page.evaluate(()=>{
      const input=document.querySelector('.emoji-picker input');
      for(const value of ['b','birth','money','ice cream']){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
    });
    await wait(150);
    assert.deepEqual(await page.$$eval('.emoji-picker__grid button',buttons=>buttons.map(button=>button.textContent)),['🍨','🍦']);
    await page.click('[data-category="1"]');await page.focus('.emoji-picker__grid [data-index="36"]');await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.index),'48');assert.equal(await page.evaluate(()=>document.activeElement.disabled),false);
    await page.click('[data-category="8"]');await page.$eval('.emoji-picker__viewport',el=>el.scrollTop=el.scrollHeight);
    await page.waitForFunction(()=>document.querySelector('.emoji-picker__grid').getAttribute('aria-busy')==='false');
    const last=await page.$$eval('.emoji-picker__grid button',buttons=>buttons.at(-1).textContent);assert.ok(last);
    await page.click('[data-category="1"]');await page.click('[data-cancel]');await wait(100);assert.equal(await page.$('.emoji-picker'),null);
  }finally{await page.close();}
});

test('WebView-compatible target records cold and warm rendering costs under four-times CPU throttling',async t=>{
  const page=await mount({width:1920,height:1080,mobile:true});try{
    const cdp=await page.createCDPSession();await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await openPicker(page);await wait(60);
    const timing=await page.evaluate(async()=>{
      const input=document.querySelector('.emoji-picker input'),results=[];
      for(const query of ['movie','money','ice cream','birthday','party','film','cake','gift','thumb','family']){
        const start=performance.now();input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));results.push(performance.now()-start);
      }
      const viewport=document.querySelector('.emoji-picker__viewport');document.querySelector('[data-category="1"]').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      while(document.querySelector('.emoji-picker__grid').getAttribute('aria-busy')==='true')await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const start=performance.now();viewport.scrollTop=120;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const coldScroll=performance.now()-start;
      while(document.querySelector('.emoji-picker__grid').getAttribute('aria-busy')==='true')await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      viewport.scrollTop=0;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const warm=performance.now();viewport.scrollTop=120;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return{search:results,scroll:coldScroll,warmScroll:performance.now()-warm,tiles:document.querySelectorAll('.emoji-picker__grid button').length};
    });
    const ordered=[...timing.search].sort((a,b)=>a-b);t.diagnostic(`4x CPU search-to-next-painted-frame p50=${ordered[5].toFixed(1)}ms worst=${ordered[9].toFixed(1)}ms; cold scroll=${timing.scroll.toFixed(1)}ms; warm scroll=${timing.warmScroll.toFixed(1)}ms; ${timing.tiles} tiles`);
    assert.ok(Math.max(...timing.search)<200);assert.ok(timing.tiles<=196);await cdp.detach();
  }finally{await page.close();}
});
