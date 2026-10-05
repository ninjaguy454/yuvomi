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
async function mount() {
  writes = []; truncate = false;
  snapshot = { notes: [1,2,3].map(id => ({ id, title: `Page ${id}`, content: `Authorized body ${id}`, color: '#C7DED9', created_by: 1, revision: 1, permissions: { view: true, edit: true, arrange: true, delete: true }, layout: { ...rect, x: 0, position_locked: false, revision: 1 } })), groups: [{ id: 11, revision: 7, member_ids: [1,2], can_manage: true, layout: { ...rect } }] };
  const page = await browser.newPage(); page.setDefaultTimeout(4000); await page.setViewport({ width: 1280, height: 900 }); await page.goto(base + '/group-page-test');
  await page.evaluate(async () => {
    class Stream extends EventTarget { constructor() { super(); window.noteStream = this; } close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'group-page-human' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js'); window.addEventListener('popstate', () => handleBackNavigation());
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
  }); return page;
}
const card = '[data-board-key="group:11"]';
async function open(page) { await page.click(`${card} [data-group-page="overview"]`); await page.waitForSelector('.note-group-overview'); }
async function order(page) { await open(page); await page.click('[data-group-select="2"]'); await page.click('.note-group-overview [data-group-action="order"]'); await page.select('[data-group-before]', '1'); await page.click('[data-group-confirm]'); }
const center = async (page, selector) => page.$eval(selector, element => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });

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
    await open(page); await page.click('[data-group-select="2"]'); await page.click('.note-group-overview [data-group-action="remove"]'); await page.waitForSelector('[data-group-confirm]');
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
    await open(page); await page.click('[data-group-select="2"]'); await page.click('.note-group-overview [data-group-action="remove"]');
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
