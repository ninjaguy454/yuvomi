import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express(); app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-page-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<style>html,body{height:100%;margin:0}#main-content{height:100vh;padding:16px}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><main id="main-content"></main></body></html>`));
let snapshot, writes, truncate, browser, server, base;
const rect = { x: 6, y: 0, width: 4, height: 6, position_locked: true, always_on_top: true };
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'synthetic' });
  if (req.path === '/notes/board') return res.json({ data: snapshot });
  if (req.path === '/notes/group-operations' && req.method === 'POST') {
    writes.push(structuredClone(req.body));
    if (truncate) { truncate = false; return res.type('json').send('{"data":'); }
    const command = req.body, group = snapshot.groups[0];
    if (command.kind === 'reorder') {
      const remaining = group.member_ids.filter(id => !command.selected_ids.includes(id));
      remaining.splice(command.before_note_id == null ? remaining.length : remaining.indexOf(command.before_note_id), 0, ...command.selected_ids);
      group.member_ids = remaining; group.revision++;
    }
    return res.json({ data: { operation_id: command.operation_id, replayed: writes.length > 1, board: snapshot, undo_available: true } });
  }
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
async function mount({ width = 1280, height = 900, touch = false, compact = false, overflow = false, largeText = false, rtl = false, appShell = false } = {}) {
  writes = []; truncate = false;
  snapshot = { notes: [1,2,3].map(id => ({ id, title: `Page ${id}`, content: `Authorized body ${id}`, color: '#C7DED9', created_by: 1, revision: 1, permissions: { view: true, edit: true, arrange: true, delete: true }, layout: { ...rect, x: 0, position_locked: false, revision: 1 } })), groups: [{ id: 11, revision: 7, member_ids: [1,2], can_manage: true, layout: { ...rect } }] };
  if (overflow) snapshot.notes[2].layout.overflow = true;
  const page = await browser.newPage(); page.setDefaultTimeout(4000); await page.setViewport({ width, height, isMobile: touch, hasTouch: touch }); await page.goto(base + '/group-page-test');
  await page.evaluate(async ({ largeText, rtl, appShell }) => {
    class Stream extends EventTarget { constructor() { super(); window.noteStream = this; } close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', rtl ? 'ar' : 'en'); await (await import('/i18n.js')).initI18n();
    if (largeText) document.documentElement.style.fontSize = '200%';
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    if (appShell) { document.getElementById('main-content').className = 'app-content'; document.getElementById('main-content').style.padding = '0'; }
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'group-page-human' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js'); window.addEventListener('popstate', () => handleBackNavigation());
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
  }, { largeText, rtl, appShell });
  if (compact) await page.click('#notes-compact-view');
  return page;
}
const card = '[data-board-key="group:11"]';
async function open(page) { await page.click(`${card} [data-group-page="overview"]`); await page.waitForSelector('.note-group-overview'); }
async function select(page, id) { if (await page.$eval('[data-group-selection-mode]', element => element.getAttribute('aria-pressed') === 'false')) await page.click('[data-group-selection-mode]'); await page.click(`[data-group-select="${id}"]`); }
async function actions(page) {
  if (!await page.$eval('[data-group-menu]', element => element.open)) await page.click('[data-group-menu] summary');
  await page.waitForSelector('[data-group-menu][open] [data-group-action]', { visible:true });
}
async function action(page, name) { await actions(page); await page.click(`.note-group-overview [data-group-action="${name}"]`); }
async function order(page) { await open(page); await select(page, 2); await action(page, 'order'); await page.select('[data-group-before]', '1'); await page.click('[data-group-confirm]'); }
const center = async (page, selector) => page.$eval(selector, element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });

for (const width of [390,1280]) test(`actual app shell overview keeps modal blur and removes its body portal on disposal at ${width}px`, async () => {
  const page = await mount({ width, appShell:true }); try {
    await open(page);
    const style=await page.$eval('.note-group-overview', element => ({ blur:getComputedStyle(element).backdropFilter, body:element.parentElement===document.body }));
    assert.match(style.blur,/blur\(/); assert.equal(style.body,true);
    await page.evaluate(() => window.stopNotes());
    assert.equal(await page.$('.note-group-overview'),null);
    assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('portaled touch overview releases host capture and private content when authentication expires', async () => {
  const page = await mount({ width:390, touch:true, appShell:true }); try {
    await open(page); const cdp=await page.createCDPSession();
    await page.evaluate(() => { window.groupCaptureHost=document.querySelector('.notes-page'); window.addEventListener('pointerdown', event => { window.activeGroupPointer=event.pointerId; }, { once:true }); });
    const start=await center(page,'[data-group-activate="2"]');
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...start,id:0}]});
    await page.waitForFunction(()=>document.querySelector('.note-group-overview').dataset.gestureState==='dragging');
    assert.equal(await page.evaluate(()=>window.groupCaptureHost.hasPointerCapture(window.activeGroupPointer)),true);
    await page.evaluate(()=>window.dispatchEvent(new Event('auth:expired')));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await page.$('.note-group-overview'),null);
    assert.equal(await page.evaluate(()=>window.groupCaptureHost.hasPointerCapture(window.activeGroupPointer)),false);
    assert.equal(await page.evaluate(()=>document.body.textContent.includes('Authorized body')),false); assert.equal(writes.length,0);
  } finally { await page.close(); }
});

test('phone keyboard Add to group creates the first group on an authorized pinned note', async () => {
  const page = await mount({ width:390, height:844, appShell:true }); try {
    snapshot.groups = [];
    snapshot.notes[0].layout = { ...snapshot.notes[0].layout, x:6, position_locked:true };
    snapshot.notes[1].layout = { ...snapshot.notes[1].layout, x:12 };
    snapshot.notes.push({ ...snapshot.notes[0], id:4, title:'Unavailable target', permissions:{...snapshot.notes[0].permissions,edit:false,arrange:false} });
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change'))); await page.waitForSelector('[data-board-key="note:1"]');
    assert.equal(await page.$eval('#notes-grid', element => element.dataset.boardView), 'list');
    await page.focus('[data-board-key="note:3"] .note-card__menu summary'); await page.keyboard.press('Enter');
    await page.focus('[data-board-key="note:3"] [data-group-action="add"]'); await page.keyboard.press('Enter');
    await page.waitForSelector('.note-group-overview');
    assert.deepEqual(await page.$$eval('[data-group-destination] option', elements => elements.map(element => element.value)), ['note:1']);
    assert.equal(await page.$('[data-group-before]'), null, 'the pinned target is always the first page');
    assert.equal(writes.length,0); await page.focus('[data-group-confirm]'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-group-undo]'); assert.equal(writes.length,1);
    assert.equal(writes[0].kind,'create'); assert.equal(writes[0].source_note_id,3); assert.equal(writes[0].target_note_id,1);
    assert.deepEqual(writes[0].expected.groups,[]); assert.deepEqual(writes[0].expected.notes.map(note=>note.id),[1,3]);
  } finally { await page.close(); }
});

test('single extraction preserves the fractional pointer drop despite a nearby obstacle', async () => {
  const page = await mount({ appShell:true }); try {
    snapshot.notes[2].layout={...snapshot.notes[2].layout,x:4,y:10};
    await page.evaluate(()=>window.noteStream.dispatchEvent(new Event('change')));
    await page.waitForFunction(()=>parseFloat(document.querySelector('[data-board-key="note:3"]').style.top)===480);
    await open(page); const start=await center(page,'[data-group-activate="2"]');
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.waitForFunction(()=>document.querySelector('.note-group-overview').dataset.gestureState==='dragging');
    const exit=await center(page,'[data-group-exit]'); await page.mouse.move(exit.x,exit.y);
    await page.waitForFunction(()=>document.querySelector('.note-group-overview').hidden);
    const point=await page.$eval('#notes-grid', element=>{const r=element.getBoundingClientRect(),pitch=parseFloat(document.querySelector('[data-board-key="note:3"]').style.left)/4;return {x:r.left+pitch*1.25,y:r.top+8.125*48};});
    await page.mouse.move(point.x,point.y); assert.equal(writes.length,0); await page.mouse.up(); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length,1); assert.equal(writes[0].kind,'extract');
    assert.ok(Math.abs(writes[0].placements[0].x-1.25)<.001); assert.equal(writes[0].placements[0].y,8.125);
    assert.equal(writes[0].placements[0].width,4); assert.equal(writes[0].placements[0].height,6);
    assert.equal(writes[0].placements[0].position_locked,false); assert.deepEqual(writes[0].selected_ids,[2]);
  } finally { await page.close(); }
});

test('actual Notes page opens overview and restores the chosen active page without a write', async () => {
  const page = await mount(); try {
    await open(page); await page.click('[data-group-activate="2"]');
    assert.equal(await page.$eval(card, element => element.dataset.id), '2');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.groupPage), 'overview'); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('overview order uses the single page request owner and rendered canonical response', async () => {
  const page = await mount(); try {
    await order(page); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'reorder'); assert.deepEqual(writes[0].selected_ids, [2]);
    assert.deepEqual(writes[0].expected.groups, [{ id: 11, revision: 7 }]);
    await open(page); assert.deepEqual(await page.$$eval('[data-group-page].note-group-overview__page', elements => elements.map(element => Number(element.dataset.groupPage))), [2,1]);
  } finally { await page.close(); }
});

test('overview uncertain result retries the identical frozen command through page recovery', async () => {
  const page = await mount(); try {
    truncate = true; await order(page); await page.waitForSelector('[data-group-retry]');
    assert.equal(await page.$('.note-group-overview'), null); const first = structuredClone(writes[0]);
    await page.click('[data-group-retry]'); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], first);
  } finally { await page.close(); }
});

test('remote revision invalidates an open overview extraction preview before Place', async () => {
  const page = await mount(); try {
    await open(page); await select(page, 2); await action(page, 'remove'); await page.waitForSelector('[data-group-confirm]');
    snapshot.groups[0].revision++; snapshot.groups[0].can_manage = false;
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change')));
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('authentication expiry removes private overview content and any pending gesture', async () => {
  const page = await mount(); try {
    await open(page); const start = await center(page, '[data-group-activate="2"]'); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    await page.evaluate(() => window.dispatchEvent(new Event('auth:expired'))); await page.mouse.up();
    assert.equal(await page.$eval('#main-content', element => element.textContent), ''); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('continuous overview extraction reaches the actual canvas and submits one unpinned rectangle', async () => {
  const page = await mount(); try {
    await open(page); const start = await center(page, '[data-group-activate="2"]'); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    const exit = await center(page, '[data-group-exit]'); await page.mouse.move(exit.x, exit.y);
    await page.waitForFunction(() => document.querySelector('.note-group-overview').hidden);
    await page.mouse.move(200, 700); assert.equal(writes.length, 0); await page.mouse.up(); await page.waitForSelector('[data-group-undo]');
    assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'extract'); assert.deepEqual(writes[0].selected_ids, [2]);
    assert.equal(writes[0].placements[0].position_locked, false); assert.equal(writes[0].placements[0].always_on_top, true);
  } finally { await page.close(); }
});

test('actual canvas Escape after overview exit consumes release without a command', async () => {
  const page = await mount(); try {
    await open(page); const start = await center(page, '[data-group-activate="2"]'); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    const exit = await center(page, '[data-group-exit]'); await page.mouse.move(exit.x, exit.y); await page.waitForFunction(() => document.querySelector('.note-group-overview').hidden);
    await page.mouse.move(200, 700); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(writes.length, 0); assert.equal(await page.$eval('.note-group-overview', element => element.hidden), false);
  } finally { await page.close(); }
});

test('changing a page filter discards an open placement draft and keeps filtered browsing read-only', async () => {
  const page = await mount(); try {
    await open(page); await select(page, 2); await action(page, 'remove');
    await page.evaluate(() => { const search = document.querySelector('#notes-search'); search.value = 'Page'; search.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    await open(page); assert.equal(await page.$('.note-group-overview [data-group-select]'), null); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('overview-owned canvas extraction autoscrolls both axes within canvas bounds without an early write', async () => {
  const page = await mount(); try {
    snapshot.notes[2].layout.x = 35; snapshot.notes[2].layout.y = 35;
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change')));
    await page.waitForFunction(() => document.querySelector('.notes-scroll').scrollWidth > document.querySelector('.notes-scroll').clientWidth);
    await open(page); const start = await center(page, '[data-group-activate="2"]'); await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
    const exit = await center(page, '[data-group-exit]'); await page.mouse.move(exit.x, exit.y); await page.waitForFunction(() => document.querySelector('.note-group-overview').hidden);
    const edge = await page.$eval('.notes-scroll', element => { const rect = element.getBoundingClientRect(); return { x: Math.min(innerWidth, rect.right) - 12, y: Math.min(innerHeight, rect.bottom) - 12 }; });
    await page.mouse.move(edge.x, edge.y);
    await page.waitForFunction(() => { const scroll = document.querySelector('.notes-scroll'); return scroll.scrollLeft > 0 && scroll.scrollTop > 0; });
    assert.equal(writes.length, 0); await page.keyboard.press('Escape'); await page.mouse.up();
    const position = await page.$eval('.notes-scroll', element => [element.scrollLeft, element.scrollTop]);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 60)));
    assert.deepEqual(await page.$eval('.notes-scroll', element => [element.scrollLeft, element.scrollTop]), position); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('actual canvas native drag opens destination overview and inserts once through shared lifecycle', async () => {
  const page = await mount(); try {
    const start = await center(page, '[data-board-key="note:3"] .note-card__content'); const destination = await center(page, card);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 8 });
    await page.waitForSelector('.note-group-overview [data-group-page="2"]');
    const insert = await center(page, '.note-group-overview [data-group-page="2"]'); await page.mouse.move(insert.x, insert.y); await page.mouse.up();
    await page.waitForSelector('[data-group-undo]'); assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'join');
    assert.deepEqual(writes[0].note_ids, [3]); assert.equal(writes[0].before_note_id, 2);
  } finally { await page.close(); }
});

for (const [name, options] of [['narrow touch', { width: 360, touch: true }], ['explicit List', { compact: true }], ['overflow List', { overflow: true }]]) {
  test(`${name} rejects blank List drop coordinates while explicit extraction preview still works`, async () => {
    const page = await mount(options); try {
      assert.equal(await page.$eval('#notes-grid', element => element.dataset.boardView), 'list');
      await open(page); const start = await center(page, '[data-group-activate="2"]');
      const cdp = options.touch ? await page.createCDPSession() : null;
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
      else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
      await page.waitForFunction(() => document.querySelector('.note-group-overview').dataset.gestureState === 'dragging');
      const exit = await center(page, '[data-group-exit]');
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...exit, id: 0 }] });
      else await page.mouse.move(exit.x, exit.y);
      await page.waitForFunction(() => document.querySelector('.note-group-overview').hidden);
      const point = await page.$eval('.notes-scroll', element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: Math.min(innerHeight, rect.bottom) - 30 }; });
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 0 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else { await page.mouse.move(point.x, point.y); await page.mouse.up(); }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(writes.length, 0, 'List pixels must not become saved world coordinates');
      await actions(page); await page.focus('.note-group-overview [data-group-action="remove"]');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.groupAction),'remove'); await page.keyboard.press('Enter');
      const placements = await page.$$eval('[data-group-placement]', elements => elements.map(element => JSON.parse(element.dataset.groupPlacement)));
      assert.equal(placements.length, 1); await page.focus('[data-group-confirm]'); await page.keyboard.press('Enter');
      await page.waitForSelector('[data-group-undo]'); assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'extract'); assert.deepEqual(writes[0].placements, placements);
    } finally { await page.close(); }
  });
}

for (const [width, height] of [[320, 720], [844, 390]]) {
  test(`responsive RTL 200% overview keeps readable titles and a usable grid at ${width}x${height}`, async () => {
    const page = await mount({ width, height, largeText: true, rtl: true, appShell: true }); try {
      snapshot.notes[0].title = 'Planning and errands'; snapshot.notes[1].title = 'Household appointments'; snapshot.groups[0].revision++;
      await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change')));
      await page.waitForFunction(() => document.querySelector('[data-board-key="group:11"] .note-card__title')?.textContent.includes('Planning'));
      await open(page);
      const geometry = await page.evaluate(() => {
        const grid = document.querySelector('.note-group-overview__grid'), heading = document.querySelector('.note-group-overview__activate strong'), button = heading.closest('button');
        const text = heading.getBoundingClientRect(), bounds = button.getBoundingClientRect();
        return { gridHeight: grid.getBoundingClientRect().height, textWidth: text.width, textLeft: text.left, textRight: text.right, buttonLeft: bounds.left, buttonRight: bounds.right, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
      });
      assert.ok(geometry.textWidth >= 160, `title has a readable measure: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.textLeft >= geometry.buttonLeft && geometry.textRight <= geometry.buttonRight, 'title fits the page preview horizontally');
      assert.ok(geometry.gridHeight >= Math.min(160, height * .35), `usable grid height: ${geometry.gridHeight}`);
      assert.ok(geometry.documentWidth <= geometry.viewportWidth + 1);
      if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/overview-${width}x${height}-rtl-200.png` });
      await page.focus('[data-group-selection-mode]'); await page.keyboard.press('Enter');
      await page.focus('[data-group-select="2"]'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.groupSelect), '2');
      await actions(page);
      assert.equal(await page.$eval('.note-group-overview [data-group-action="order"]', element => !element.disabled && element.getClientRects().length > 0), true);
      assert.equal(writes.length, 0);
    } finally { await page.close(); }
  });
}

test('responsive short RTL canvas retains its physical origin inside the actual shell', async () => {
  const page = await mount({ width: 844, height: 390, largeText: true, rtl: true, appShell: true }); try {
    snapshot.groups[0].layout.x = 0; snapshot.notes[2].layout.x = 14; snapshot.groups[0].revision++;
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change')));
    await page.waitForFunction(() => document.querySelector('[data-board-key="group:11"]').style.left === '0px');
    const geometry = await page.$eval(`${card} [data-group-page="overview"]`, element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, direction: getComputedStyle(element.closest('.note-card')).direction }; });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width, JSON.stringify(geometry)); assert.equal(geometry.direction, 'rtl'); assert.equal(writes.length, 0);
    if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/board-landscape-rtl-200.png` });
  } finally { await page.close(); }
});

test('responsive short landscape reveal scrolls the actual page owner to its card', async () => {
  const page = await mount({ width: 844, height: 390, largeText: true, rtl: true, appShell: true }); try {
    snapshot.groups[0].layout.x = 0; snapshot.groups[0].layout.height = 20; snapshot.groups[0].revision++;
    snapshot.notes[2].layout = { ...snapshot.notes[2].layout, x: 0, y: 8, position_locked: true };
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change'))); await page.waitForSelector('[data-note-reveal="3"]');
    await page.focus('[data-note-reveal="3"]'); await page.keyboard.press('Enter');
    const bounds = await page.$eval('[data-board-key="note:3"]', element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
    assert.ok(bounds.top >= 0 && bounds.top < bounds.height - 44, `revealed content enters the visible viewport: ${JSON.stringify(bounds)}`); assert.equal(writes.length, 0);
    if (process.env.QA_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.QA_SCREENSHOT_DIR}/reveal-landscape-rtl-200.png` });
  } finally { await page.close(); }
});

test('responsive RTL canvas drag to the physical right saves positive world coordinates', async () => {
  const page = await mount({ largeText: true, rtl: true, appShell: true }); try {
    const start = await center(page, '[data-board-key="note:3"] .note-card__content');
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 200, start.y, { steps: 5 }); await page.mouse.up();
    await page.waitForSelector('[data-group-undo]'); assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'arrange');
    assert.ok(writes[0].items[0].layout.x > 0); assert.equal(writes[0].items[0].layout.y, 0);
  } finally { await page.close(); }
});

for (const cancel of [true, false]) {
  test(`native landscape drag uses separate horizontal and vertical scroll owners before ${cancel ? 'cancel' : 'drop'}`, async () => {
    const page = await mount({ width: 844, height: 390, appShell: true }); try {
      snapshot.groups[0].layout = { ...snapshot.groups[0].layout, x: 0, height: 20 }; snapshot.groups[0].revision++;
      snapshot.notes[2].layout = { ...snapshot.notes[2].layout, x: 5, y: 0 };
      snapshot.notes.push({ ...snapshot.notes[2], id: 4, title: 'Far note', layout: { ...snapshot.notes[2].layout, x: 50 } });
      await page.evaluate(() => window.noteStream.dispatchEvent(new Event('change'))); await page.waitForSelector('[data-board-key="note:4"]');
      await page.$eval('[data-board-key="note:3"]', element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
      const before = await page.$eval('.notes-scroll', element => ({ left: element.scrollLeft, width: element.clientWidth, world: element.scrollWidth, height: element.clientHeight, content: element.scrollHeight }));
      assert.ok(before.world > before.width); assert.equal(before.height, before.content, 'vertical scrolling belongs to the page shell');
      const start = await center(page, '[data-board-key="note:3"] .note-card__content');
      const end = { x: before.width - 8, y: start.y };
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 });
      await page.waitForFunction(() => document.querySelector('.notes-scroll').scrollLeft > 20, { timeout: 1000 });
      const dropX = before.width * .7;
      await page.mouse.move(dropX, start.y);
      const position = await page.$eval('[data-board-key="note:3"]', element => ({ x: parseFloat(element.style.left), pitch: parseFloat(element.style.width) / 4 + 3 }));
      const after = await page.$eval('.notes-scroll', element => ({ left: element.scrollLeft, height: element.clientHeight }));
      assert.equal(after.height, before.height, 'horizontal dragging preserves the page-flow height');
      const expectedX = 5 + (dropX - start.x + after.left - before.left) / position.pitch;
      assert.ok(Math.abs(position.x / position.pitch - expectedX) < .00001, 'world X includes horizontal viewport scrolling');
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
      if (cancel) assert.equal(writes.length, 0);
      else {
        await page.waitForSelector('[data-group-undo]'); assert.equal(writes.length, 1); assert.equal(writes[0].kind, 'arrange');
        assert.ok(Math.abs(writes[0].items[0].layout.x - expectedX) < .00001); assert.equal(writes[0].items[0].layout.y, 0);
      }
    } finally { await page.close(); }
  });
}
