import { arrangeNotesFixture } from './helpers/note-group-http-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Render the production page and intercept only its API boundary. No live services.
const app = express();
let browser, server, base, writes, notes;
const original = [
  { id: 1, title: 'Direct manipulation', content: '- [ ] Feed pets\n\nA plain paragraph to drag.\n\n[Household help](https://example.test/household-help)', color: '#C7DED9', created_by: 1, creator_name: 'Parent', visibility: 'all', revision: 4, permissions: { view: true, edit: true, delete: true, manage_visibility: true }, layout: { x: 2, y: 2, width: 4, height: 6, revision: 2 } },
  { id: 2, title: 'Farther down the board', content: 'A distant note makes the scroll region real.', color: '#EFE3BE', creator_name: 'Parent', visibility: 'all', revision: 1, permissions: { view: true, edit: true, delete: true, manage_visibility: false }, layout: { x: 8, y: 30, width: 4, height: 6, revision: 0 } },
];
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(m => `<link rel="stylesheet" href="${m[1]}">`).join('');
app.get('/direct-board-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'fixture' });
  if (req.path === '/notes/members') return res.json({ data: [{ id: 1, display_name: 'Parent' }] });
  if (req.path === '/notes/changes') return res.status(204).end();
  if (req.path === '/notes/board' && req.method === 'GET') return res.json({ data: {notes,groups:[]} });
  if (req.method !== 'GET') writes.push({ path: req.path, method: req.method, body: req.body });
  if(req.path==='/notes/group-operations'){const result=arrangeNotesFixture(notes,req.body);return res.status(result.status).json(result.body);}
  const note = notes.find(n => n.id === Number(req.path.split('/')[2]));
  if (req.path.endsWith('/check') && note) {
    note.content = note.content.replace('- [ ]', '- [x]'); note.revision++;
    return res.json({ data: note });
  }
  if (req.path.endsWith('/layout') && note) {
    if (req.body.expected_layout_revision !== note.layout.revision) return res.status(409).json({ error: 'Stale layout' });
    note.layout = { ...req.body.layout, revision: note.layout.revision + 1 };
    return res.json({ data: note.layout });
  }
  return res.json({ data: [] });
});

test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const card = '.note-card[data-id="1"]';
const layoutWrites = () => writes.filter(write => write.path === '/notes/group-operations' && write.body.kind === 'arrange');
async function mount({ width = 1280, height = 900, permission = 'edit', fixture, mobile = false, appShell = false } = {}) {
  writes = []; notes = structuredClone(original);
  if (fixture === 'fitting') notes = [notes[0]];
  if (fixture === 'locked') notes[0].layout.position_locked = true;
  if (fixture === 'fractional') Object.assign(notes[0].layout, { x: 2.375, y: 3.125 });
  if (fixture === 'layers') { notes[1].layout = { x:6,y:2,width:4,height:6,revision:1,always_on_top:true }; }
  if (fixture === 'menu-overlap') { notes[1].layout = { x:5,y:3,width:4,height:6,revision:1,always_on_top:true }; }
  if (fixture === 'reveal' || fixture === 'reveal-distant') {
    notes=Array.from({length:fixture==='reveal-distant'?30:3},(_,i)=>({...structuredClone(original[0]),id:i+1,title:i===2?'Locked <b>third</b>':`Locked note ${i+1}`,layout:{x:fixture==='reveal-distant'?80:2,y:fixture==='reveal-distant'?90:2,width:4,height:6,revision:2,position_locked:true,always_on_top:i===1}}));
  }
  if (fixture === 'tall-top') { notes = [notes[0]]; notes[0].layout.y = 105; }
  if (fixture === 'long-content' || fixture === 'long-content-locked') notes[0].content = 'A plain paragraph to drag.\n\n' + Array.from({ length: 35 }, (_, i) => `Scrollable preview paragraph ${i}.`).join('\n\n') + '\n\n' + notes[0].content;
  if (fixture === 'long-content-locked') notes[0].layout.position_locked = true;
  if (permission !== 'edit') for (const note of notes) note.permissions = { view: true, edit: false, delete: false, manage_visibility: false };
  const page = await browser.newPage(); page.setDefaultTimeout(2500);
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2.625 : 1 }); await page.goto(base + '/direct-board-test');
  await page.evaluate(async ({ permission, appShell }) => {
    if (appShell) { document.getElementById('main-content').className = 'app-content'; document.getElementById('main-content').style.padding = '0'; }
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    window.yuvomi = { showToast() {} };
    (await import('/permissions.js')).setPermissions(permission === 'edit' ? { admin: true } : { principal_kind: 'device', modules: { notes: 'read' }, capabilities: { 'device_notes.view': 'allow', 'device_notes.create': permission === 'create' ? 'allow' : 'deny' } });
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
  }, { permission, appShell });
  return page;
}
async function box(page, selector = card) {
  return page.$eval(selector, element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
}
async function bodyPoint(page) {
  // A real noninteractive descendant catches implementations that only accept card backgrounds.
  const rect = await box(page, `${card} .note-card__content .note-md-p`);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
async function mouseDrag(page, point, dx = 110, dy = 96) {
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 6 }); await page.mouse.up();
}
async function touch(page) {
  const cdp = await page.createCDPSession();
  return {
    start: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 1, radiusY: 1 }] }),
    move: (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 1, radiusY: 1 }] }),
    end: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    cancel: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }),
    close: () => cdp.detach(),
  };
}
async function saved(page, count = 1) {
  await page.waitForFunction(() => document.querySelector('#notes-board-status')?.textContent === 'Layout saved');
  assert.equal(layoutWrites().length, count, 'one CAS write per completed gesture');
  assert.equal(await page.$('.note-modal'), null, 'dropping a card must not open its reader');
}
async function unchanged(page, before, checkReader = true) {
  await sleep(100);
  assert.equal(layoutWrites().length, 0, 'cancelled or noneditable gestures must not write geometry');
  const after = await box(page);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(after[key] - before[key]) < 1, `${key} restored after cancellation`);
  if (checkReader) assert.equal(await page.$('.note-modal'), null);
}

for (const pinned of [false, true]) test(`touch intent: ordinary swipe scrolls ${pinned ? 'pinned' : 'movable'} note content without moving its card`, async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, appShell: true, fixture: pinned ? 'long-content-locked' : 'long-content' });
  const input = await touch(page);
  try {
    const canonical = structuredClone(notes), content = `${card} .note-card__content`;
    const before = await page.$eval(content, element => ({ height: element.clientHeight, content: element.scrollHeight, top: element.scrollTop, action: getComputedStyle(element).touchAction }));
    assert.ok(before.content > before.height + 150, 'the actual styled preview must overflow');
    const area = await box(page, content), start = { x: area.x + area.width / 2, y: area.y + area.height - 25 };
    await input.start(start.x, start.y);
    for (let step = 1; step <= 8; step++) { await input.move(start.x, start.y - step * 15); await sleep(16); }
    await input.end(); await sleep(100);
    const after = await page.$eval(content, element => ({ top: element.scrollTop, moving: !!element.closest('.note-card--moving') }));
    console.log('TOUCH_CONTENT_INTENT', JSON.stringify({ pinned, before, after, writes: layoutWrites().length }));
    assert.ok(after.top > before.top + 50, 'an ordinary swipe scrolls the note preview');
    assert.equal(after.moving, false); assert.equal(layoutWrites().length, 0); assert.deepEqual(notes, canonical);
    assert.equal(await page.$('.note-modal'), null, 'a swipe must not open the reader');
  } finally { await input.close(); await page.close(); }
});

test('touch intent: ordinary swipe on a short note pans the canvas and cancels hold arming', async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, appShell: true }); const input = await touch(page);
  try {
    const canonical = structuredClone(notes), point = await bodyPoint(page), before = await page.$eval('.notes-scroll', element => element.scrollTop);
    await input.start(point.x, point.y);
    for (let step = 1; step <= 8; step++) { await input.move(point.x, point.y - step * 12); await sleep(16); }
    await sleep(520);
    assert.equal(await page.$('.note-card--moving'), null, 'movement before the hold must never arm a later move');
    await input.end(); await sleep(100);
    assert.ok(await page.$eval('.notes-scroll', element => element.scrollTop) > before + 50, 'short-note swipe pans the canvas');
    assert.equal(layoutWrites().length, 0); assert.deepEqual(notes, canonical); assert.equal(await page.$('.note-modal'), null);
  } finally { await input.close(); await page.close(); }
});

test('touch intent: deliberate body hold visibly lifts before moving and submits one placement', async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, appShell: true, fixture: 'long-content' }); const input = await touch(page);
  try {
    const point = await bodyPoint(page), before = await box(page);
    await input.start(point.x, point.y); await sleep(100);
    assert.equal(await page.$('.note-card--moving'), null, 'a new touch is not a move yet');
    await page.waitForSelector('.note-card--moving');
    assert.notEqual(await page.$eval(card, element => getComputedStyle(element).boxShadow), 'none');
    assert.deepEqual(await box(page), before, 'arming lifts without changing placement');
    for (let step = 1; step <= 8; step++) await input.move(point.x + step * 12, point.y + step * 10);
    await input.end(); await saved(page);
    assert.ok(notes[0].layout.x > 2); assert.ok(notes[0].layout.y > 2);
    assert.equal(await page.$eval(`${card} .note-card__content`, element => element.scrollTop), 0, 'armed movement does not scroll the preview');
  } finally { await input.close(); await page.close(); }
});

test('touch intent: quick body tap opens the reader without arming or writing placement', async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, appShell: true }); const input = await touch(page);
  try {
    const point = await bodyPoint(page); await input.start(point.x, point.y); await input.end();
    await page.waitForSelector('.note-modal'); await sleep(500);
    assert.equal(await page.$('.note-card--moving'), null); assert.equal(layoutWrites().length, 0);
  } finally { await input.close(); await page.close(); }
});

for (const armed of [false, true]) test(`touch intent: pointer cancellation ${armed ? 'after' : 'before'} hold clears lift and timers`, async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, appShell: true }); const input = await touch(page);
  try {
    const before = await box(page), point = await bodyPoint(page); await input.start(point.x, point.y);
    if (armed) await page.waitForSelector('.note-card--moving');
    await input.cancel(); await sleep(520);
    assert.equal(await page.$('.note-card--moving'), null); await unchanged(page, before);
  } finally { await input.close(); await page.close(); }
});

for (const width of [1280, 752]) test(`body mouse drag saves CAS at canvas width ${width}`, async () => {
  const page = await mount({ width, height: width === 752 ? 835 : 900 });
  try {
    const point = await bodyPoint(page); await mouseDrag(page, point, width === 752 ? 70 : 110, 96); await saved(page);
    const write = layoutWrites()[0];
    assert.equal(write.path, '/notes/group-operations'); assert.equal(write.body.expected.notes[0].layout_revision, 2);
    assert.equal(write.method,'POST'); assert.deepEqual(write.body.expected,{groups:[],notes:[{id:1,revision:4,layout_revision:2}]});
    assert.ok(write.body.items[0].layout.x > 2); assert.ok(write.body.items[0].layout.y > 2);
    assert.equal(write.body.items[0].layout.width, 4); assert.equal(write.body.items[0].layout.height, 6);
    assert.equal(notes[0].content, original[0].content);
  } finally { await page.close(); }
});

for (const scale of [1, 1.25]) test(`freeform actual Notes drag persists non-grid coordinates at zoom ${scale}`, async () => {
  const page = await mount({ appShell: true }); try {
    if (scale > 1) await page.click('#notes-zoom-in');
    const point = await bodyPoint(page), pitch = await page.$eval('.notes-scroll', element => { const style = getComputedStyle(element); return (element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 12; });
    const expected = { x: 2 + 73 / (pitch * scale), y: 2 + 37 / (48 * scale) };
    await mouseDrag(page, point, 73, 37); await saved(page);
    assert.ok(Math.abs(notes[0].layout.x - expected.x) < .00001); assert.ok(Math.abs(notes[0].layout.y - expected.y) < .00001);
    assert.equal(notes[0].layout.width, 4); assert.equal(notes[0].layout.height, 6);
  } finally { await page.close(); }
});

test('freeform numeric layout editor preserves a no-op save and accepts keyboard fractional positions', async () => {
  const page = await mount({ appShell: true, fixture: 'fractional' }); try {
    await page.focus(`${card} [data-board-action="adjust"]`); await page.keyboard.press('Enter'); await page.waitForSelector('#note-layout-x');
    for (const [axis, expected] of [['x', '2.375'], ['y', '3.125']]) {
      const field = await page.$eval(`#note-layout-${axis}`, element => ({ value: element.value, step: element.step, valid: element.checkValidity() }));
      assert.deepEqual(field, { value: expected, step: 'any', valid: true });
    }
    assert.equal(await page.$eval('#note-layout-height', element => element.step), '1');
    await page.click('#note-layout-save'); await page.waitForFunction(() => !document.querySelector('.note-modal'));
    assert.equal(layoutWrites().length, 1); assert.equal(notes[0].layout.x, 2.375); assert.equal(notes[0].layout.y, 3.125);
    await page.focus(`${card} [data-board-action="adjust"]`); await page.keyboard.press('Enter'); await page.waitForSelector('#note-layout-x');
    for (const [axis, value] of [['x', '2.625'], ['y', '3.875']]) {
      await page.focus(`#note-layout-${axis}`); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.type(value);
    }
    await page.$eval('#note-layout-height', element => { element.value = '7'; element.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#note-layout-save'); await page.waitForFunction(() => !document.querySelector('.note-modal'));
    assert.equal(layoutWrites().length, 2); assert.equal(notes[0].layout.x, 2.625); assert.equal(notes[0].layout.y, 3.875); assert.equal(notes[0].layout.height, 7);
  } finally { await page.close(); }
});

test('zoom controls change only the view, survive refresh, and Reset restores origin', async () => {
  const page = await mount();
  try {
    const before = await box(page), canonical = structuredClone(notes);
    await page.click('#notes-zoom-in');
    const zoomed = await box(page);
    assert.ok(zoomed.width > before.width * 1.2);
    assert.equal(await page.$eval('#notes-zoom-value', n => n.textContent), '125%');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(100);
    assert.equal(await page.$eval('#notes-zoom-value', n => n.textContent), '125%');
    await page.click('#notes-reset-view');
    assert.equal(await page.$eval('#notes-zoom-value', n => n.textContent), '100%');
    assert.equal(await page.$eval('.notes-scroll', n => n.scrollLeft + n.scrollTop), 0);
    assert.deepEqual(notes, canonical); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('zoomed drag uses world units and right-edge autoscroll grows beyond twelve columns', async () => {
  const page=await mount();
  try {
    await page.click('#notes-zoom-in');
    const pitch=await page.$eval('.notes-scroll',n=>(n.clientWidth-parseFloat(getComputedStyle(n).paddingLeft)-parseFloat(getComputedStyle(n).paddingRight))/12);
    await mouseDrag(page,await bodyPoint(page),pitch*1.25,60); await saved(page);
    assert.ok(Math.abs(notes[0].layout.x - 3) < .01); assert.ok(Math.abs(notes[0].layout.y - 3) < .01);
    const start=await bodyPoint(page), bounds=await box(page,'.notes-scroll');
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width-5,start.y,{steps:8}); await sleep(700);
    assert.ok(await page.$eval('.notes-scroll',n=>n.scrollLeft)>0,'right edge scrolls horizontally');
    await page.mouse.up(); await saved(page,2);
    assert.ok(notes[0].layout.x>12,'saved world position is beyond the old board edge');
    const extent=await page.$eval('.notes-canvas-space',n=>n.getBoundingClientRect().width);
    assert.ok(extent >= ((notes[0].layout.x+notes[0].layout.width)*pitch+192)*1.25-1);
  } finally { await page.close(); }
});

test('reveal tabs expose every overlapping locked card without moving or saving it', async () => {
  const page=await mount({fixture:'reveal'});
  try {
    const before=structuredClone(notes);
    await page.waitForSelector('[data-note-reveal="1"]');
    assert.equal(await page.$$eval('[data-note-reveal]',nodes=>nodes.length),3);
    const label=await page.$eval('[data-note-reveal="3"]',n=>({text:n.textContent,markup:!!n.querySelector('b')}));
    assert.ok(label.text.includes('<b>third</b>'));assert.equal(label.markup,false);
    await page.focus('[data-note-reveal="1"]');await page.keyboard.press('Enter');
    assert.equal(await page.$eval('[data-note-reveal="1"]',n=>n.getAttribute('aria-pressed')),'true');
    assert.equal(await page.$eval(`${card} .note-card__title`,n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true);
    await page.keyboard.press('Escape');
    const tiers=await page.$$eval('.note-card',nodes=>nodes.map(n=>Number(getComputedStyle(n).zIndex)));
    assert.ok(tiers[0]<tiers[1]);
    assert.deepEqual(notes,before);assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('reveal tabs have 24px visuals with separate 44px touch targets and work on touch canvas',async()=>{
  const page=await mount({fixture:'reveal',width:752,mobile:true});
  try {
    await page.waitForSelector('[data-note-reveal="1"]');
    const targets=await page.$$eval('[data-note-reveal]',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),v=n.querySelector('.notes-reveal-tab__label').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,visualHeight:v.height};}));
    for(const target of targets){assert.ok(target.width>=44&&target.height>=44);assert.equal(target.visualHeight,24);}
    for(let i=1;i<targets.length;i++)assert.ok(targets[i].x>=targets[i-1].x+targets[i-1].width);
    const area=await box(page,'.notes-scroll');assert.ok(targets.every(t=>t.y+t.height<=area.y));
    await page.touchscreen.tap(targets[0].x+targets[0].width/2,targets[0].y+targets[0].height/2);
    assert.equal(await page.$eval('[data-note-reveal="1"]',n=>n.getAttribute('aria-pressed')),'true');assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('reveal tabs follow authorized revalidation and clear at authentication teardown',async()=>{
  const page=await mount({fixture:'reveal'});
  try {
    await page.focus('[data-note-reveal="1"]');await page.keyboard.press('Space');
    notes=notes.filter(n=>n.id!==1);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>!document.querySelector('[data-note-reveal="1"]'));
    assert.equal(await page.$eval('.notes-reveal-strip',n=>n.textContent.includes('Locked note 1')),false);
    assert.equal(await page.$$eval('[data-note-reveal]',nodes=>nodes.length),2);
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:context-ending')));
    assert.equal(await page.$('[data-note-reveal]'),null);assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('reveal survives authorized refresh with keyboard focus and clears when another card is selected',async()=>{
  const page=await mount({fixture:'reveal'});
  try{
    await page.focus('[data-note-reveal="1"]');await page.keyboard.press('Enter');
    notes[0].title='Updated visible note';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('[data-note-reveal="1"]')?.textContent==='Updated visible note');
    // Refresh may replace the strip between $eval's handle lookup and evaluation.
    // Read the current target and both focus/selection conditions atomically.
    assert.equal(await page.evaluate(()=>{const n=document.querySelector('[data-note-reveal="1"]');return n===document.activeElement&&n.getAttribute('aria-pressed')==='true';}),true);
    await page.focus('.note-card[data-id="2"] [data-action="open"]');
    assert.equal(await page.$eval('[data-note-reveal="1"]',n=>n.getAttribute('aria-pressed')),'false');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('dense reveal strip reaches every authorized locked note by keyboard and pans only its viewport for read-only devices',async()=>{
  const page=await mount({fixture:'reveal-distant',permission:'read',width:752});
  try{
    const before=structuredClone(notes);
    assert.equal(await page.$$eval('[data-note-reveal]',nodes=>nodes.length),30);
    await page.focus('[data-note-reveal="1"]');
    for(let i=1;i<30;i++)await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.noteReveal),'30');
    const tab=await box(page,'[data-note-reveal="30"]'),strip=await box(page,'.notes-reveal-strip');
    assert.ok(tab.x>=strip.x&&tab.x+tab.width<=strip.x+strip.width+1,`keyboard scrolling keeps the last tab visible: ${JSON.stringify({tab,strip})}`);
    const documentScroll=await page.evaluate(()=>[scrollX,scrollY]);
    await page.keyboard.press('Enter');
    const target=await box(page,'.note-card[data-id="30"]'),viewport=await box(page,'.notes-scroll');
    assert.ok(target.x>=viewport.x&&target.x+target.width<=viewport.x+viewport.width&&target.y>=viewport.y&&target.y+target.height<=viewport.y+viewport.height,`distant card is fully visible within bounded canvas extent: ${JSON.stringify({target,viewport})}`);
    assert.deepEqual(await page.evaluate(()=>[scrollX,scrollY]),documentScroll);
    assert.equal(await page.$('.note-card[data-id="30"] [data-board-action="lock"]'),null);
    assert.deepEqual(notes,before);assert.equal(writes.length,0);
  }finally{await page.close();}
});

test('phone transition hides reveal controls while retaining all locked note positions',async()=>{
  const page=await mount({fixture:'reveal'});
  try {
    const before=structuredClone(notes);
    await page.click('[data-note-reveal="1"]');
    await page.setViewport({width:360,height:800});
    await page.waitForSelector('#notes-grid[data-board-view="list"]');
    assert.equal(await page.$eval('.notes-reveal-strip',n=>n.hidden),true);
    assert.equal(await page.$$eval('.note-card',nodes=>nodes.length),3);
    await page.setViewport({width:1280,height:900});await page.waitForSelector('[data-note-reveal="1"]');
    assert.deepEqual(notes,before);assert.equal(writes.length,0);
  }finally{await page.close();}
});

for (const input of ['pointer', 'keyboard']) test(`open note menu stays reachable above overlapping cards and restores its tier on close (${input})`, async () => {
  const page = await mount({ fixture: 'menu-overlap' });
  try {
    const tiers = () => page.$$eval('.note-card', nodes => nodes.map(n => Number(getComputedStyle(n).zIndex)));
    const initial = await tiers(); assert.ok(initial[0] < initial[1]);
    if (input === 'keyboard') { await page.focus(`${card} summary`); await page.keyboard.press('Enter'); }
    else await page.click(`${card} summary`);
    await page.waitForSelector(`${card} details[open]`);
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.note-card')];
      return Number(getComputedStyle(cards[0]).zIndex) > Number(getComputedStyle(cards[1]).zIndex);
    });
    assert.equal(await page.$eval(`${card} [data-board-action="top"]`, el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.right - 10, r.top + r.height / 2));
    }), true, 'the menu action itself receives the click above the overlapping top card');
    await page.click(`${card} summary`);
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.note-card')];
      return !cards[0].querySelector('details').open && Number(getComputedStyle(cards[0]).zIndex) < Number(getComputedStyle(cards[1]).zIndex);
    });
    const restored = await tiers(); assert.ok(restored[0] < restored[1]);
    assert.equal(writes.length, 0, 'opening a menu does not change persistent layers');
  } finally { await page.close(); }
});

test('viewport capture loss ends background pan before subsequent movement', async () => {
  const page = await mount();
  try {
    const area = await box(page, '.notes-scroll'), start = { x: area.x + 20, y: area.y + area.height - 100 };
    await page.evaluate(() => document.addEventListener('pointerdown', e => { window.panPointer = e.pointerId; }, { capture: true, once: true }));
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x, start.y - 80);
    const stopped = await page.$eval('.notes-scroll', el => {
      if (!el.hasPointerCapture(window.panPointer)) throw new Error('viewport must own pan capture');
      el.releasePointerCapture(window.panPointer); return el.scrollTop;
    });
    assert.ok(stopped > 0);
    await page.mouse.move(start.x, start.y - 180);
    assert.equal(await page.$eval('.notes-scroll', el => el.scrollTop), stopped);
    await page.mouse.up(); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('drop restores the persistent tier while its layout request is pending', async () => {
  const page = await mount({ fixture: 'layers' }); let held;
  try {
    await page.setRequestInterception(true);
    const intercepted = new Promise(resolve => page.on('request', request => {
      if (request.url().endsWith('/group-operations')) { held = request; resolve(); }
      else request.continue();
    }));
    await mouseDrag(page, await bodyPoint(page), -100, 100); await intercepted;
    assert.equal(await page.$('.note-card--moving'), null);
    const tiers = await page.$$eval('.note-card', nodes => nodes.map(n => Number(getComputedStyle(n).zIndex)));
    assert.ok(tiers[0] < tiers[1], 'pending network save must not retain active drag elevation');
  } finally { if (held) await held.continue(); await page.close(); }
});

test('held-edge resizing exposes corner and edge markers only during the gesture', async () => {
  const page = await mount();
  try {
    const markers = () => page.$eval(card, n => getComputedStyle(n, '::after').backgroundImage);
    const before = await markers(), b = await box(page);
    await page.mouse.move(b.x + 3, b.y + 40); await page.mouse.down();
    await page.waitForSelector('.note-card--resizing');
    const active = await markers(); assert.notEqual(active, 'none'); assert.notEqual(active, before);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await markers(), before); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('background pan and keyboard pan move only the viewport', async () => {
  const page=await mount();
  try {
    const originalNotes=structuredClone(notes);
    const area=await box(page,'.notes-scroll'), start={x:area.x+area.width-100,y:area.y+400};
    await mouseDrag(page,start,-120,-120);
    assert.ok(await page.$eval('.notes-scroll',n=>n.scrollTop)>0);
    assert.ok(await page.$eval('.notes-scroll',n=>n.scrollLeft)>0);
    await page.click('#notes-reset-view'); await page.focus('#notes-grid'); await page.keyboard.press('ArrowDown');
    await page.waitForFunction(()=>document.querySelector('.notes-scroll').scrollTop>0);
    assert.deepEqual(notes,originalNotes); assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('locked cards cannot move, resize stays anchored, and active resize has an outline', async () => {
  const page = await mount({fixture:'locked'});
  try {
    const before = await box(page);
    await mouseDrag(page, await bodyPoint(page)); await unchanged(page, before, false);
    const point={x:before.x+before.width-3,y:before.y+before.height-3};
    await page.mouse.move(point.x,point.y); await page.mouse.down(); await sleep(520);
    assert.ok(await page.$eval(card,n=>parseFloat(getComputedStyle(n).outlineWidth)>=2));
    await page.mouse.move(point.x+110,point.y+48); await page.mouse.up(); await saved(page);
    assert.equal(notes[0].layout.x,2); assert.equal(notes[0].layout.y,2);
    assert.ok(notes[0].layout.width>4);
  } finally { await page.close(); }
});

test('ordinary selection stays below always-on-top and drag elevation is temporary', async () => {
  const page=await mount({fixture:'layers'});
  try {
    const tiers=()=>page.$$eval('.note-card',nodes=>nodes.map(n=>Number(getComputedStyle(n).zIndex)));
    const initial=await tiers(); assert.ok(initial[0]<initial[1]);
    const point=await bodyPoint(page); await page.mouse.move(point.x,point.y); await page.mouse.down();
    await page.mouse.move(point.x+30,point.y+48);
    const during=await tiers(); assert.ok(during[0]>during[1]);
    await page.keyboard.press('Escape'); await page.mouse.up();
    const after=await tiers(); assert.ok(after[0]<after[1]);
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('pinch takes over an active touch drag without saving and changes viewport scale', async () => {
  const page=await mount({width:954,height:859,mobile:true}); const cdp=await page.createCDPSession();
  try {
    const canonical=structuredClone(notes), p=await bodyPoint(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...p}]});
    await page.waitForSelector('.note-card--moving');
    const first={id:1,x:p.x+50,y:p.y+48};
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[first]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,{id:2,x:first.x+100,y:first.y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...first,x:first.x-30},{id:2,x:first.x+140,y:first.y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.ok(Number.parseInt(await page.$eval('#notes-zoom-value',n=>n.textContent))>100);
    assert.deepEqual(notes,canonical); assert.equal(writes.length,0);
    assert.equal(await page.$('.note-card--moving'),null);
  } finally { await cdp.detach(); await page.close(); }
});

test('real touch body hold then drag moves a card and advances the layout revision', async () => {
  const page = await mount(); const input = await touch(page);
  try {
    const point = await bodyPoint(page); await input.start(point.x, point.y);
    await page.waitForSelector('.note-card--moving');
    for (let i = 1; i <= 8; i++) await input.move(point.x + 110 * i / 8, point.y + 96 * i / 8);
    await input.end(); await saved(page);
    assert.equal(layoutWrites()[0].body.expected.notes[0].layout_revision, 2);
    assert.ok(notes[0].layout.x > 2); assert.ok(notes[0].layout.y > 2);
    await mouseDrag(page, await bodyPoint(page), 110, 48); await saved(page, 2);
    assert.equal(layoutWrites()[1].body.expected.notes[0].layout_revision, 3);
  } finally { await input.close(); await page.close(); }
});

test('coarse mobile touch hold then drag moves a paragraph inside a scrollable card preview', async () => {
  const page = await mount({ width: 954, height: 859, mobile: true, fixture: 'long-content' });
  const input = await touch(page);
  try {
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    assert.equal(await page.evaluate(() => devicePixelRatio), 2.625);
    assert.equal(await page.$eval('#notes-grid', el => el.dataset.boardView), 'canvas');
    const preview = await page.$eval(`${card} .note-card__content`, el => ({ height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
    assert.ok(preview.content > preview.height, 'the body preview must really overflow');
    assert.match(preview.overflow, /auto|scroll/, 'exercise the inner scrollport that intercepts native touch panning');
    const paragraph = await box(page, `${card} .note-card__content .note-md-p`);
    const point = { x: paragraph.x + paragraph.width / 2, y: paragraph.y + paragraph.height / 2 };
    await page.evaluate(() => {
      window.fixtureBodyTouch = { paragraph: false, cancelled: false };
      window.addEventListener('pointerdown', event => { window.fixtureBodyTouch.paragraph = !!event.target.closest('.note-card__content .note-md-p'); }, { once: true, capture: true });
      window.addEventListener('pointercancel', () => { window.fixtureBodyTouch.cancelled = true; }, { once: true });
    });
    const content = notes[0].content;
    await input.start(point.x, point.y);
    await page.waitForSelector('.note-card--moving');
    for (let i = 1; i <= 10; i++) await input.move(point.x + 90 * i / 10, point.y + 96 * i / 10);
    await input.end();
    assert.equal(await page.evaluate(() => window.fixtureBodyTouch.paragraph), true, 'touch must begin on a paragraph, not the title or border');
    assert.equal(await page.evaluate(() => window.fixtureBodyTouch.cancelled), false, 'native preview panning must not cancel an editable canvas body drag');
    await saved(page);
    assert.equal(layoutWrites()[0].body.expected.notes[0].layout_revision, 2);
    assert.ok(notes[0].layout.x > 2); assert.ok(notes[0].layout.y > 2);
    assert.equal(notes[0].layout.width, 4); assert.equal(notes[0].layout.height, 6);
    assert.equal(notes[0].content, content, 'moving retains all long preview content');
  } finally { await input.close(); await page.close(); }
});

test('checklist and links keep their normal interaction without starting a drag', async () => {
  const page = await mount();
  try {
    await page.click(`${card} .note-md-box`);
    await page.waitForFunction(() => document.querySelector('.note-card[data-id="1"] .note-md-box')?.getAttribute('aria-checked') === 'true');
    assert.equal(writes.filter(write => write.path.endsWith('/check')).length, 1);
    const link = `${card} .note-card__content a`;
    await page.$eval(link, element => { element.addEventListener('click', event => { event.preventDefault(); window.fixtureLinkClicked = true; }); });
    await page.click(link); assert.equal(await page.evaluate(() => window.fixtureLinkClicked), true);
    const before = await box(page), lb = await box(page, link);
    await mouseDrag(page, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 });
    await unchanged(page, before);
  } finally { await page.close(); }
});

for (const edge of ['left', 'top', 'bottom-right']) test(`450ms hold then ${edge} resize keeps the opposite edge anchored`, async () => {
  const page = await mount();
  try {
    const before = await box(page);
    const point = edge === 'left' ? { x: before.x + 3, y: before.y + before.height / 2 } : edge === 'top' ? { x: before.x + before.width / 2, y: before.y + 3 } : { x: before.x + before.width - 3, y: before.y + before.height - 3 };
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await sleep(520);
    await page.mouse.move(point.x + (edge === 'left' ? -105 : edge === 'top' ? 0 : 105), point.y + (edge === 'top' ? -48 : edge === 'left' ? 0 : 96), { steps: 6 });
    await page.mouse.up(); await saved(page);
    const next = layoutWrites()[0].body.items[0].layout;
    assert.equal(layoutWrites()[0].body.expected.notes[0].layout_revision, 2);
    if (edge === 'left') { assert.ok(next.x < 2); assert.equal(next.x + next.width, 6); assert.equal(next.y, 2); assert.equal(next.height, 6); }
    if (edge === 'top') { assert.ok(next.y < 2); assert.equal(next.y + next.height, 8); assert.equal(next.x, 2); assert.equal(next.width, 4); }
    if (edge === 'bottom-right') { assert.equal(next.x, 2); assert.equal(next.y, 2); assert.ok(next.width > 4); assert.ok(next.height > 6); }
  } finally { await page.close(); }
});

test('real touch long press on an edge resizes', async () => {
  const page = await mount(); const input = await touch(page);
  try {
    // Keep the contact away from links/checklists that Chromium may prioritize for touch hit testing.
    const b = await box(page), x = b.x + 3, y = b.y + 40;
    await page.evaluate(() => window.addEventListener('pointerdown', event => { window.edgeTarget = event.target.closest('button')?.outerHTML || event.target.tagName; }, { once: true }));
    await input.start(x, y); await sleep(520);
    assert.equal(await page.$('.note-card--resizing') !== null, true, `held edge should resize; hit target: ${await page.evaluate(() => window.edgeTarget)}`);
    for (let i = 1; i <= 6; i++) await input.move(x - 105 * i / 6, y);
    await input.end(); await saved(page);
    assert.equal(notes[0].layout.x + notes[0].layout.width, 6);
  } finally { await input.close(); await page.close(); }
});

test('a short touch edge pan cancels before the resize hold can arm', async () => {
  const page = await mount(); const input = await touch(page);
  try {
    const b = await box(page), x = b.x + 3, y = b.y + 40;
    await input.start(x, y); await input.move(x, y - 60); await sleep(550); await input.move(x - 105, y - 100); await input.end();
    await sleep(100); assert.equal(layoutWrites().length, 0, 'movement before hold threshold must cancel resize');
    assert.deepEqual(notes[0].layout, original[0].layout);
  } finally { await input.close(); await page.close(); }
});

for (const reason of ['Escape', 'pointercancel', 'lostpointercapture', 'auth:context-ending']) test(`${reason} cancels an active body gesture without saving`, async () => {
  const page = await mount();
  try {
    const before = await box(page), point = await bodyPoint(page);
    await page.evaluate(() => document.addEventListener('pointerdown', event => { window.fixturePointerId = event.pointerId; }, { capture: true, once: true }));
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 110, point.y + 96, { steps: 6 });
    const during = await box(page); assert.ok(Math.abs(during.x - before.x) > 20 || Math.abs(during.y - before.y) > 20, 'gesture must first visibly move to make cancellation meaningful');
    if (reason === 'Escape') await page.keyboard.press('Escape');
    else if (reason === 'auth:context-ending') await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    else await page.evaluate(reason => {
      const id = window.fixturePointerId;
      const owner = [...document.querySelectorAll('*')].find(element => element.hasPointerCapture?.(id));
      if (reason === 'lostpointercapture' && owner) owner.releasePointerCapture(id);
      else (owner || document.querySelector('.note-card[data-id="1"]')).dispatchEvent(new PointerEvent(reason, { pointerId: id, bubbles: true }));
    }, reason);
    await page.mouse.up();
    if (reason === 'auth:context-ending') { await sleep(100); assert.equal(layoutWrites().length, 0); assert.equal(await page.$eval('#main-content', el => el.textContent), ''); }
    else {
      await unchanged(page, before);
      await page.click(`${card} [data-action="open"]`);
      await page.waitForSelector('.note-modal');
      assert.equal(layoutWrites().length, 0, 'the independent Open click remains usable after cancellation');
    }
  } finally { await page.close(); }
});

test('holding a body drag near the scroll edge advances the board and stops after release', async () => {
  const page = await mount({ height: 700 });
  try {
    const point = await bodyPoint(page);
    const scroller = await page.$eval('.notes-scroll', el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, top: el.scrollTop }; });
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 110, Math.min(scroller.bottom, 700) - 12, { steps: 8 }); await sleep(350);
    const during = await page.$eval('.notes-scroll', el => el.scrollTop);
    assert.ok(during > scroller.top, 'a stationary pointer near the lower edge must auto-scroll');
    await page.mouse.up(); await saved(page);
    const stopped = await page.$eval('.notes-scroll', el => el.scrollTop); await sleep(150);
    assert.equal(await page.$eval('.notes-scroll', el => el.scrollTop), stopped, 'release stops auto-scroll');
  } finally { await page.close(); }
});

for (const permission of ['read', 'create']) test(`${permission}-only permission never starts a geometry gesture`, async () => {
  let page = await mount({ permission });
  try {
    let before = await box(page); await mouseDrag(page, await bodyPoint(page)); await unchanged(page, before, false);
    await page.close(); page = await mount({ permission }); before = await box(page);
    await page.mouse.move(before.x + 3, before.y + before.height / 2); await page.mouse.down(); await sleep(520);
    await page.mouse.move(before.x - 105, before.y + before.height / 2); await page.mouse.up(); await unchanged(page, before, false);
    assert.equal(await page.$(`${card}.note-card--editable`), null);
  } finally { await page.close(); }
});

test('a second real touch outside the board cancels the active card gesture', async () => {
  const page = await mount(); const cdp = await page.createCDPSession();
  try {
    const before = await box(page), point = await bodyPoint(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...point }] });
    await page.waitForSelector('.note-card--moving');
    const moved = { id: 1, x: point.x + 110, y: point.y + 96 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
    assert.ok((await box(page)).y > before.y + 20, 'first touch must activate the gesture');
    assert.equal(await page.evaluate(() => !!document.elementFromPoint(1100, 24)?.closest('#notes-grid')), false, 'second pointer starts outside the grid');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, { id: 2, x: 1100, y: 24 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await unchanged(page, before);
  } finally { await cdp.detach(); await page.close(); }
});

test('a board that initially fits grows and auto-scrolls its Notes scroll region during drag', async () => {
  const page = await mount({ fixture: 'fitting' });
  try {
    const initial = await page.$eval('.notes-scroll', el => ({ height: el.clientHeight, content: el.scrollHeight, top: el.scrollTop, bottom: el.getBoundingClientRect().bottom }));
    assert.ok(initial.content <= initial.height + 1, 'fixture starts without scroll overflow');
    const point = await bodyPoint(page);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 110, Math.min(initial.bottom, 900) - 12, { steps: 8 });
    await sleep(300);
    assert.ok(await page.$eval('.notes-scroll', el => el.scrollTop) > 0, 'newly overflowing Notes region must auto-scroll');
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, 'the document must not take over Notes scrolling');
    await page.mouse.up(); await saved(page);
  } finally { await page.close(); }
});

test('stationary pointer capture loss stops auto-scroll before another pointer event', async () => {
  const page = await mount({ height: 700 });
  try {
    const point = await bodyPoint(page);
    await page.evaluate(() => document.addEventListener('pointerdown', event => { window.fixturePointerId = event.pointerId; }, { capture: true, once: true }));
    const bottom = await page.$eval('.notes-scroll', el => el.getBoundingClientRect().bottom);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 110, Math.min(bottom, 700) - 12, { steps: 8 }); await sleep(200);
    const stopped = await page.evaluate(() => {
      const id = window.fixturePointerId;
      const owner = [...document.querySelectorAll('*')].find(element => element.hasPointerCapture?.(id));
      if (!owner) throw new Error('active gesture must own pointer capture');
      owner.releasePointerCapture(id);
      return document.querySelector('.notes-scroll').scrollTop;
    });
    assert.ok(stopped > 0, 'auto-scroll must have started before capture loss');
    await sleep(200);
    assert.equal(await page.$eval('.notes-scroll', el => el.scrollTop), stopped, 'no pointer update is needed to stop scrolling');
    await page.mouse.up(); await sleep(100); assert.equal(layoutWrites().length, 0);
  } finally { await page.close(); }
});

for (const reason of ['Escape', 'pointercancel']) test(`${reason} clears a pending edge hold before it can arm`, async () => {
  const page = await mount();
  try {
    const before = await box(page), point = { x: before.x + 3, y: before.y + before.height / 2 };
    await page.evaluate(() => document.addEventListener('pointerdown', event => { window.fixturePointerId = event.pointerId; }, { capture: true, once: true }));
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await sleep(100);
    if (reason === 'Escape') await page.keyboard.press('Escape');
    else await page.evaluate(() => document.querySelector('.note-card[data-id="1"]').dispatchEvent(new PointerEvent('pointercancel', { pointerId: window.fixturePointerId, bubbles: true })));
    await sleep(520); await page.mouse.move(point.x - 105, point.y + 96, { steps: 6 }); await page.mouse.up();
    await unchanged(page, before);
    assert.equal(await page.$('.note-card--resizing'), null);
    await page.click(`${card} [data-action="open"]`); await page.waitForSelector('.note-modal');
  } finally { await page.close(); }
});

test('top-edge resizing at the 100-row limit preserves its original bottom edge', async () => {
  const page = await mount({ fixture: 'tall-top' });
  try {
    await page.$eval('.notes-scroll', el => { el.scrollTop = 4800; });
    const before = await box(page), point = { x: before.x + before.width / 2, y: before.y + 3 };
    assert.ok(point.y > 0 && point.y < 850, 'the top edge is in the viewport');
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await sleep(520);
    await page.mouse.wheel({ deltaY: -6000 });
    await page.waitForFunction(() => document.querySelector('.notes-scroll').scrollTop === 0);
    await page.mouse.move(point.x, Math.max(180, point.y - 250), { steps: 6 }); await page.mouse.up();
    await saved(page);
    const next = layoutWrites()[0].body.items[0].layout;
    assert.equal(next.height, 100); assert.equal(next.y + next.height, 111, 'maximum size keeps the opposite edge anchored');
    assert.equal(next.x, 2); assert.equal(next.width, 4);
  } finally { await page.close(); }
});
