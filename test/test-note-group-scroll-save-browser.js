import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Production Notes page against a revision-checking, receipt-backed synthetic
// HTTP fixture. It has no live credentials, user content, or external requests.
const app = express();
app.use(express.json());
const publicRoot = process.env.NOTES_GROUP_SCROLL_SAVE_PUBLIC_ROOT || fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(publicRoot));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(join(publicRoot, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-scroll-save-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}</style></head><body><main id="main-content" class="app-content"></main></body></html>`));
let browser, server, base, snapshot, writes, receipts, behavior, releaseSave, reads;
const clone = value => structuredClone(value);
function apply(command) {
  const replay = receipts.get(command.operation_id);
  if (replay) {
    assert.deepEqual(command, replay.command, 'Retry must resend the frozen command');
    return { ...clone(replay.result), replayed: true, board: clone(snapshot) };
  }
  for (const expected of command.expected.groups) assert.equal(snapshot.groups.find(group => group.id === expected.id)?.revision, expected.revision, 'group command uses latest acknowledged revision');
  for (const expected of command.expected.notes) {
    const note = snapshot.notes.find(note => note.id === expected.id);
    assert.equal(note?.revision, expected.revision, 'note command uses latest revision');
    assert.equal(note?.layout.revision, expected.layout_revision, 'layout command uses latest revision');
  }
  const before = clone(snapshot), group = id => snapshot.groups.find(value => value.id === id);
  const insert = (target, ids, beforeId) => {
    const remaining = target.member_ids.filter(id => !ids.includes(id));
    const index = beforeId === null ? remaining.length : remaining.indexOf(beforeId);
    assert.ok(index >= 0, 'insertion refers to a remaining member');
    target.member_ids = [...remaining.slice(0, index), ...ids, ...remaining.slice(index)]; target.revision++;
  };
  if (command.kind === 'reorder') insert(group(command.group_id), command.selected_ids, command.before_note_id);
  else if (command.kind === 'join') insert(group(command.target_group_id), command.note_ids, command.before_note_id);
  else if (command.kind === 'create') {
    const anchor = snapshot.notes.find(note => note.id === command.target_note_id);
    assert.ok(anchor?.layout.position_locked, 'fixture create target is a pinned standalone note');
    assert.ok(command.source_note_id, 'fixture create starts from a standalone note');
    assert.equal(snapshot.groups.some(value => value.member_ids.includes(anchor.id) || value.member_ids.includes(command.source_note_id)), false);
    snapshot.groups.push({ id: Math.max(0, ...snapshot.groups.map(value => value.id)) + 1, revision: 1,
      member_ids: [anchor.id, command.source_note_id], can_manage: true, layout: clone(anchor.layout) });
  }
  else if (command.kind === 'transfer') {
    const source = group(command.source_group_id); source.member_ids = source.member_ids.filter(id => !command.selected_ids.includes(id)); source.revision++;
    insert(group(command.target_group_id), command.selected_ids, command.before_note_id);
    snapshot.groups = snapshot.groups.filter(value => value.member_ids.length >= 2);
  } else if (command.kind === 'undo') {
    const prior = receipts.get(command.undo_operation_id); assert.ok(prior, 'Undo names a known receipt');
    const revisions = new Map(snapshot.groups.map(value => [value.id, value.revision]));
    snapshot = clone(prior.before); snapshot.groups.forEach(value => { value.revision = (revisions.get(value.id) || value.revision) + 1; });
  } else throw new Error(`Unexpected fixture mutation: ${command.kind}`);
  const result = { operation_id: command.operation_id, replayed: false, board: clone(snapshot), undo_available: command.kind !== 'undo' };
  receipts.set(command.operation_id, { command: clone(command), before, result: clone(result) });
  return result;
}
app.use('/api/v1', async (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'synthetic-scroll-save' });
  if (req.path === '/notes/board') { reads++; return res.json({ data: clone(snapshot) }); }
  if (req.path === '/notes/members') return res.json({ data: [{ id: 1, display_name: 'Synthetic Parent' }] });
  if (req.path === '/notes/changes') return res.status(204).end();
  if (req.method !== 'GET') writes.push({ path: req.path, body: clone(req.body) });
  if (req.path === '/notes/group-operations') {
    const mode = behavior; behavior = null;
    if (mode === 'hold-applied') {
      const result = apply(req.body);
      await new Promise(resolve => { releaseSave = resolve; });
      return res.json({ data: result });
    }
    if (['hold', 'hold-unknown', 'hold-conflict'].includes(mode)) await new Promise(resolve => { releaseSave = resolve; });
    if (mode === 'conflict' || mode === 'hold-conflict') { snapshot.groups[0].revision++; return res.status(409).json({ error: 'Synthetic changed elsewhere', code: 409 }); }
    try {
      const result = apply(req.body);
      if (mode === 'unknown' || mode === 'hold-unknown') return res.json({ data: { operation_id: req.body.operation_id } });
      return res.json({ data: result });
    } catch (error) { return res.status(409).json({ error: error.message, code: 409 }); }
  }
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}), ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-dev-shm-usage'] });
});
test.after(async () => { releaseSave?.(); await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
const overview = '.note-group-overview', panel = '.note-group-overview__panel', grid = '.note-group-overview__grid';
const gap = '[data-group-insertion-gap]', proxy = '[data-group-drag-proxy]';
const evidence = process.env.NOTES_GROUP_SCROLL_SAVE_SCREENSHOTS || fileURLToPath(new URL('../../evidence/group-scroll-save', import.meta.url));
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${name}.png`) }); }
async function mount({ count = 12, width = 1440, height = 1000, touch = false, reduced = false, rtl = false, theme = 'light', canvas = false, zoom = 1, size = { width: 4, height: 6 }, fixture } = {}) {
  writes = []; receipts = new Map(); behavior = null; releaseSave = null; reads = 0;
  snapshot = {
    notes: Array.from({ length: count + 4 }, (_, index) => ({ id: index + 1, title: `Synthetic note ${index + 1}`,
      content: `# Garden plan ${index + 1}\n\n**Water mint** and basil.\n\n- Gather seeds\n- Plant next season\n\n` + Array.from({ length: 12 }, (_, line) => `Preview paragraph ${line + 1} stays readable.`).join('\n\n'),
      color: index % 2 ? '#C7DED9' : '#EFE3BE', created_by: 1, creator_name: 'Synthetic Parent', revision: 1,
      permissions: { view: true, edit: true, arrange: true, move: true, pin: true, group: true, ungroup: true, delete: true, manage_visibility: true },
      layout: { x: index > count + 1 ? (index - count - 2) * 5 : 0, y: 0, ...size, revision: 1, position_locked: index <= count + 1 } })),
    groups: [{ id: 41, revision: 7, member_ids: Array.from({ length: count }, (_, index) => index + 1), can_manage: true, layout: { x: 10, y: 0, width: 4, height: 6, position_locked: true } },
      { id: 42, revision: 3, member_ids: [count + 1, count + 2], can_manage: true, layout: { x: 10, y: 8, width: 4, height: 6, position_locked: true } }],
  };
  fixture?.(snapshot);
  const page = await browser.newPage(); page.setDefaultTimeout(4500);
  await page.setViewport({ width, height, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.setRequestInterception(true); page.on('request', request => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url()); if (url.origin === base || url.protocol === 'data:' || url.protocol === 'blob:') request.continue(); else request.abort('blockedbyclient');
  });
  await page.goto(base + '/group-scroll-save-test');
  await page.evaluate(async ({ rtl, theme }) => {
    class Stream extends EventTarget { constructor() { super(); window.noteStream = this; } close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    document.documentElement.dir = rtl ? 'rtl' : 'ltr'; document.documentElement.dataset.theme = theme;
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'synthetic-scroll-save' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js'); window.addEventListener('popstate', handleBackNavigation);
    // Observe the genuine release before the production listener clears its
    // insertion preview. This does not pause or alter running animations.
    window.addEventListener('pointerup', () => {
      if (!window.captureRapidDrop) return;
      const grid = document.querySelector('.note-group-overview__grid'), bounds = grid.getBoundingClientRect();
      window.rapidBefore = { scroll: grid.scrollTop, animations: grid.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length,
        gaps: [...grid.querySelectorAll('[data-group-insertion-gap]')].map(element => { const rect = element.getBoundingClientRect(); return { id: Number(element.dataset.groupInsertionGap), left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height }; }) };
    }, true);
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
    window.addEventListener('pointerdown', event => { window.latestPointerId = event.pointerId; }, true);
  }, { rtl, theme });
  for (let step = 0; step < Math.round(Math.abs(zoom - 1) / .25); step++) await page.click(zoom < 1 ? '#notes-zoom-out' : '#notes-zoom-in');
  if (!canvas) { await page.click('[data-board-key="group:41"] [data-group-page="overview"]'); await page.waitForSelector(overview); }
  return page;
}
async function remember(page) { await page.evaluate(() => { window.savedOverlay = document.querySelector('.note-group-overview'); window.savedPanel = document.querySelector('.note-group-overview__panel'); window.savedGrid = document.querySelector('.note-group-overview__grid'); window.savedHistoryLength = history.length; }); }
async function sameView(page) { assert.equal(await page.evaluate(() => !!window.savedOverlay?.isConnected && window.savedOverlay === document.querySelector('.note-group-overview') && window.savedPanel === document.querySelector('.note-group-overview__panel') && window.savedGrid === document.querySelector('.note-group-overview__grid') && window.savedHistoryLength === history.length), true, 'the same group overlay, panel, grid and history entry remain connected'); }
async function saved(page) { await page.waitForFunction(() => !document.querySelector('#notes-grid')?.dataset.layoutWrite); await sameView(page); }
async function point(page, selector, edge = 'center') {
  await page.$eval(selector, element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return page.$eval(selector, (element, edge) => {
    const rect = element.getBoundingClientRect(), bounds = element.closest('.note-group-overview__grid')?.getBoundingClientRect();
    const top = Math.max(0, rect.top, bounds?.top || 0), bottom = Math.min(innerHeight, rect.bottom, bounds?.bottom || innerHeight);
    return { x: edge === 'before' ? rect.left + 25 : edge === 'after' ? rect.right - 25 : rect.left + rect.width / 2, y: (top + bottom) / 2 };
  }, edge);
}
async function select(page, ids) {
  if (await page.$eval('[data-group-selection-mode]', element => element.getAttribute('aria-pressed')) !== 'true') await page.click('[data-group-selection-mode]');
  for (const id of ids) { await point(page, `[data-group-select="${id}"]`); await page.click(`[data-group-select="${id}"]`); }
}
async function order(page, before = '') {
  await page.$eval('[data-group-menu]', element => { element.open = true; }); await page.click(`${overview} [data-group-action="order"]`);
  await page.select('[data-group-before]', String(before)); await page.click('[data-group-confirm]');
}
async function waitPending(page) { await page.waitForFunction(() => document.querySelector('#notes-grid')?.dataset.layoutWrite === 'saving'); }
async function refresh(page) { const before = reads; await page.evaluate(() => window.noteStream.dispatchEvent(new Event('notes'))); await page.waitForFunction(() => !document.querySelector('#notes-grid')?.dataset.layoutWrite); for (let n = 0; n < 30 && reads === before; n++) await frame(page); assert.ok(reads > before); await frame(page); }
async function move(page, value, cdp) { if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...value, id: 0 }] }); else await page.mouse.move(value.x, value.y); }
async function release(page, cdp) { if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up(); }
async function hold(page, id = 2, cdp) {
  const start = await point(page, `[data-group-activate="${id}"]`);
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] }); else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'dragging'); await frame(page); return start;
}
async function selectedOrder(page) { return page.$$eval('[data-group-select][aria-pressed="true"]', elements => elements.map(element => ({ id: Number(element.dataset.groupSelect), position: Number(element.textContent) })).sort((a, b) => a.position - b.position).map(value => value.id)); }
async function visibleOrder(page) { return page.$$eval(`${grid} > [data-group-page]`, elements => elements.map(element => Number(element.dataset.groupPage))); }
async function nativeEntry(page, id, cdp) {
  const selector = `[data-board-key="note:${id}"]`;
  const start = await page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    for (const fy of [.7, .6, .5]) for (const fx of [.3, .5, .7]) {
      const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy, target = document.elementFromPoint(x, y);
      if (element.contains(target) && !target.closest('a,button,input,select,summary,details,[role="checkbox"]')) return { x, y };
    }
    throw new Error('Synthetic native source has no noninteractive body hit point');
  });
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] }); else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
  if (cdp) await page.waitForSelector(`${selector}.note-card--moving`);
  await move(page, { x: start.x + 15, y: start.y }, cdp); await page.waitForSelector(`${selector}.note-card--moving`);
  await move(page, await point(page, '[data-board-key="group:41"]'), cdp);
  await page.waitForSelector(`${overview} [data-group-page="1"]`); await remember(page);
  await move(page, await point(page, '[data-group-page="2"]', 'before'), cdp); await frame(page);
}

async function record(page, name, data) {
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify({ ...data, writes }, null, 2));
  await screenshot(page, name);
}
async function background(page, id) {
  return page.evaluate(id => {
    const card = document.querySelector(`[data-board-key="note:${id}"]`), world = document.querySelector('.notes-canvas-space');
    const scrolls = [...new Set([document.scrollingElement, ...document.querySelectorAll('.notes-scroll,.notes-page,.app-content')])].map(element => ({ name: element.id || element.className || element.tagName, x: element.scrollLeft, y: element.scrollTop }));
    return { scrolls, card: { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height }, world: { width: world.offsetWidth, height: world.offsetHeight }, gridScroll: document.querySelector('.note-group-overview__grid')?.scrollTop };
  }, id);
}
const backgroundOnly = value => ({ scrolls: value.scrolls, card: value.card, world: value.world });
async function paintedOrder(page) {
  return page.$eval(grid, element => [...element.querySelectorAll(':scope > [data-group-page]')].filter(card => !card.hidden && card.getClientRects().length).sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft).map(card => Number(card.dataset.groupPage)));
}
function expectedOrder(command, members) {
  const ids = command.selected_ids || command.note_ids, remaining = members.filter(id => !ids.includes(id));
  const index = command.before_note_id === null ? remaining.length : remaining.indexOf(command.before_note_id);
  assert.ok(index >= 0); return [...remaining.slice(0, index), ...ids, ...remaining.slice(index)];
}
async function traceOrder(page) {
  await page.evaluate(() => {
    window.orderFrames = []; window.collectOrderFrames = true; window.orderReleaseTime = null;
    window.addEventListener('pointerup', () => { window.orderReleaseTime = performance.now(); }, { once: true, capture: true });
    const sample = () => {
      const grid = document.querySelector('.note-group-overview__grid');
      if (grid) window.orderFrames.push({ time: performance.now(), phase: document.querySelector('#notes-grid')?.dataset.layoutWrite || 'idle', order: [...grid.querySelectorAll(':scope > [data-group-page]')].filter(card => !card.hidden && card.getClientRects().length).sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft).map(card => Number(card.dataset.groupPage)) });
      if (window.collectOrderFrames) requestAnimationFrame(sample);
    }; requestAnimationFrame(sample);
  });
}
async function reorderAndHold(page, cdp, { ids = [2], target = 6, mode = 'hold' } = {}) {
  await remember(page); if (ids.length > 1) await select(page, ids);
  await hold(page, ids[0], cdp); await move(page, await point(page, `[data-group-page="${target}"]`, 'before'), cdp);
  await page.waitForSelector(gap); await page.waitForFunction(() => document.querySelector('.note-group-overview__grid').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'));
  await page.evaluate(ids => {
    const cards = [...document.querySelectorAll('.note-group-overview__grid > [data-group-page]')];
    window.keptCards = new Map(cards.map(card => [card.dataset.groupPage, card]));
    window.chosenNeighbors = cards.filter(card => !ids.includes(Number(card.dataset.groupPage))).map(card => ({ id: card.dataset.groupPage, left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }));
    window.keptFocus = document.querySelector('[data-group-activate="3"]'); window.keptFocus.focus({ preventScroll: true });
    window.dropScrollTop = document.querySelector('.note-group-overview__grid').scrollTop;
  }, ids);
  behavior = mode; await traceOrder(page); await release(page, cdp); await waitPending(page); await frame(page);
  assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'reorder');
  return expectedOrder(writes[0].body, snapshot.groups[0].member_ids);
}

for (const touch of [false, true]) for (const zoom of [.5, 1, 1.5]) test(`scroll-save external group drag freezes background scroll and hidden canvas geometry: ${touch ? 'touch' : 'mouse'} zoom${zoom}`, async () => {
  const page = await mount({ canvas: true, touch, zoom, count: 30, width: 1057, height: 880 }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await nativeEntry(page, 33, cdp); const before = await background(page, 33);
    const edge = await page.evaluate(() => ({ x: innerWidth - 8, y: innerHeight - 8 }));
    for (let step = 0; step < 12; step++) { await move(page, edge, cdp); await frame(page); }
    const after = await background(page, 33); await record(page, `external-background-${touch ? 'touch' : 'mouse'}-${zoom}`, { before, after });
    await sameView(page); assert.equal(await page.$eval(overview, element => element.hidden), false); assert.equal(writes.length, 0);
    assert.deepEqual(backgroundOnly(after), backgroundOnly(before), 'the open group owns scrolling and preview; neither the background scroll nor source world rectangle may follow its pointer');
    assert.ok(after.gridScroll > before.gridScroll, 'the group grid remains the only active scroll owner');
    await move(page, await point(page, '[data-group-page="2"]', 'before'), cdp); await release(page, cdp); await saved(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'join'); assert.deepEqual(writes[0].body.note_ids, [33]);
    assert.equal(writes[0].body.before_note_id, 2, 'the bridge consumes a real insertion after edge scrolling even though the native world rectangle stayed frozen');
    assert.deepEqual(snapshot.groups[0].member_ids.slice(0, 3), [1, 33, 2]); assert.deepEqual(await paintedOrder(page), snapshot.groups[0].member_ids);
  } finally { await cdp?.detach(); await page.close(); }
});
for (const scenario of [{ name: 'mouse-single', ids: [2] }, { name: 'touch-single', ids: [2], touch: true }, { name: 'mouse-multiple-reduced', ids: [5, 2, 4], target: 9, reduced: true }]) test(`scroll-save reordered cards retain the chosen order continuously while the response is held: ${scenario.name}`, async () => {
  const page = await mount({ count: 12, ...scenario }), cdp = scenario.touch ? await page.createCDPSession() : null;
  try {
    const chosen = await reorderAndHold(page, cdp, scenario); const during = await paintedOrder(page);
    const frames = await page.evaluate(() => window.orderFrames); await record(page, `reorder-held-response-${scenario.name}`, { chosen, during, frames });
    await sameView(page); assert.deepEqual(during, chosen, 'dropping preserves the chosen order instead of flashing the previous canonical order during saving');
    assert.ok(frames.filter(value => value.phase === 'saving').every(value => JSON.stringify(value.order) === JSON.stringify(chosen)), 'every painted saving frame uses the chosen order');
    const retained = await page.evaluate(() => ({ cards: [...window.keptCards].every(([id, card]) => card === document.querySelector(`[data-group-page="${id}"]`)), neighbors: window.chosenNeighbors.map(value => { const card = document.querySelector(`[data-group-page="${value.id}"]`); return { id: card.dataset.groupPage, left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight }; }), before: window.chosenNeighbors, focus: document.activeElement === window.keptFocus, scroll: document.querySelector('.note-group-overview__grid').scrollTop, beforeScroll: window.dropScrollTop }));
    assert.equal(retained.cards, true); assert.deepEqual(retained.neighbors, retained.before, 'neighbor card slots remain where the insertion preview placed them'); assert.equal(retained.focus, true); assert.ok(Math.abs(retained.scroll - retained.beforeScroll) <= 1, 'release retains the insertion preview reading position');
    releaseSave(); await saved(page); assert.deepEqual(await paintedOrder(page), chosen); assert.equal(writes.length, 1); await frame(page);
    const throughAck = await page.evaluate(() => { window.collectOrderFrames = false; return { releasedAt: window.orderReleaseTime, frames: window.orderFrames }; });
    const releasedFrames = throughAck.frames.filter(value => value.time >= throughAck.releasedAt);
    assert.ok(releasedFrames.length >= 3 && releasedFrames.every(value => JSON.stringify(value.order) === JSON.stringify(chosen)), 'every painted frame from release through acknowledged state retains the chosen order');
    assert.equal(await page.evaluate(() => document.activeElement === window.keptFocus), true); await record(page, `reorder-acknowledged-${scenario.name}`, { chosen, throughAck });
  } finally { releaseSave?.(); await cdp?.detach(); await page.close(); }
});
for (const touch of [false, true]) test(`scroll-save explicit exit dwell restores exactly one canvas scroll owner and Escape cancels: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ canvas: true, touch, count: 30, width: 1057, height: 880 }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await nativeEntry(page, 33, cdp); const before = await background(page, 33);
    const exit = await page.$eval(panel, element => { const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: Math.max(3, bounds.top / 2) }; });
    await move(page, exit, cdp); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
    assert.equal(await page.$eval(overview, element => element.hidden), false); assert.deepEqual(backgroundOnly(await background(page, 33)), backgroundOnly(before), 'background stays frozen before the intentional one-second dwell completes');
    await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
    const hidden = await background(page, 33); const edge = await page.evaluate(() => ({ x: innerWidth - 8, y: innerHeight - 8 })); await move(page, edge, cdp);
    const samples = await page.evaluate(async () => {
      const scroller = document.querySelector('.notes-scroll'), result = [];
      for (let frame = 0; frame < 12; frame++) { await new Promise(requestAnimationFrame); result.push({ x: scroller.scrollLeft, y: scroller.scrollTop }); }
      return result;
    });
    const after = await background(page, 33); await record(page, `exit-resume-${touch ? 'touch' : 'mouse'}`, { before, hidden, after, samples });
    assert.notDeepEqual(backgroundOnly(after), backgroundOnly(hidden), 'canvas scrolling and dragged source geometry resume after the explicit exit');
    assert.equal(after.gridScroll, hidden.gridScroll, 'the hidden group does not scroll a second canvas owner');
    assert.ok(samples.slice(1).every((value, index) => Math.abs(value.x - samples[index].x) <= 19 && Math.abs(value.y - samples[index].y) <= 19), `one canvas loop has at most the existing18px/frame scroll speed: ${JSON.stringify(samples)}`);
    await page.keyboard.press('Escape'); await release(page, cdp); await frame(page); await sameView(page);
    assert.equal(await page.$eval(overview, element => element.hidden), false); assert.equal(await page.$(proxy), null); assert.equal(writes.length, 0);
  } finally { await cdp?.detach(); await page.close(); }
});
test('scroll-save uncertain outcome restores authorized display and Retry resends exactly the held reorder', async () => {
  const page = await mount();
  try {
    const canonical = clone(snapshot.groups[0].member_ids), chosen = await reorderAndHold(page, null, { mode: 'hold-unknown' });
    assert.deepEqual(await paintedOrder(page), chosen); releaseSave(); await page.waitForSelector(`${panel} [data-group-retry]`); await sameView(page);
    assert.deepEqual(await paintedOrder(page), canonical, 'unknown outcome restores the last authorized display while independent writes stay gated');
    assert.equal(await page.$eval('#notes-grid', element => element.dataset.layoutWrite), 'retry'); const command = clone(writes[0].body);
    await screenshot(page, 'unknown-outcome-canonical'); await page.click(`${panel} [data-group-retry]`); await saved(page);
    assert.deepEqual(writes[1].body, command); assert.equal(writes.length, 2); assert.deepEqual(await paintedOrder(page), chosen);
    assert.equal(snapshot.groups[0].revision, 8, 'receipt replay applies only once');
  } finally { releaseSave?.(); await page.close(); }
});
test('scroll-save a rejected reorder rolls back to freshly authorized canonical order', async () => {
  const page = await mount();
  try {
    const canonical = clone(snapshot.groups[0].member_ids), chosen = await reorderAndHold(page, null, { mode: 'hold-conflict' });
    assert.deepEqual(await paintedOrder(page), chosen); const readsBefore = reads; releaseSave(); await saved(page);
    assert.ok(reads > readsBefore, 'a conflict fetches fresh authorized state'); assert.deepEqual(await paintedOrder(page), canonical); assert.equal(writes.length, 1);
    assert.equal(await page.$(`${panel} [data-group-retry]`), null); assert.equal(await page.$(gap), null); await screenshot(page, 'conflict-canonical-rollback');
  } finally { releaseSave?.(); await page.close(); }
});
test('scroll-save newer access loss purges optimistic content before an older successful response', async () => {
  const page = await mount();
  try {
    await reorderAndHold(page, null, { mode: 'hold-applied' });
    snapshot.notes = snapshot.notes.filter(note => note.id !== 2); snapshot.groups[0].member_ids = snapshot.groups[0].member_ids.filter(id => id !== 2); snapshot.groups[0].can_manage = false; snapshot.groups[0].revision++;
    await page.evaluate(() => window.noteStream.dispatchEvent(new Event('notes'))); await page.waitForFunction(() => !document.querySelector('[data-group-page="2"]'));
    releaseSave(); await saved(page); assert.equal(await page.$('[data-group-page="2"]'), null); assert.equal(await page.$(proxy), null); assert.equal(await page.$(gap), null); assert.equal(writes.length, 1);
    assert.deepEqual(await paintedOrder(page), snapshot.groups[0].member_ids); assert.equal(await page.$(`${panel} [data-group-undo]`), null);
  } finally { releaseSave?.(); await page.close(); }
});
for (const scenario of [{ name: 'single', ids: [2], target: 15 }, { name: 'multiple', ids: [2, 3, 4], target: 18 }]) test(`scroll-save rapid release during moving neighbors preserves the insertion slot: ${scenario.name}`, async () => {
  const page = await mount({ count: 30, width: 1057, height: 880 });
  try {
    await remember(page); if (scenario.ids.length > 1) await select(page, scenario.ids); await hold(page, scenario.ids[0]);
    await page.evaluate(() => { window.captureRapidDrop = true; }); behavior = 'hold'; await traceOrder(page);
    const target = await point(page, `[data-group-page="${scenario.target}"]`, 'before');
    // Intentionally release immediately: no animation wait, screenshot or
    // evaluation is allowed between this physical move and physical release.
    await move(page, target); await release(page); await waitPending(page); await frame(page);
    const before = await page.evaluate(() => window.rapidBefore);
    assert.ok(before.animations > 0, 'this release actually interrupts running neighbor animations');
    assert.equal(before.gaps.length, scenario.ids.length); assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'reorder');
    const chosen = expectedOrder(writes[0].body, snapshot.groups[0].member_ids);
    const geometry = () => page.$eval(grid, (element, ids) => {
      const bounds = element.getBoundingClientRect();
      return { scroll: element.scrollTop, cards: ids.map(id => { const rect = element.querySelector(`[data-group-page="${id}"]`).getBoundingClientRect(); return { id, left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height }; }) };
    }, scenario.ids);
    const held = await geometry(); await record(page, `rapid-release-held-${scenario.name}`, { scenario, before, held, chosen });
    const assertSlot = state => {
      assert.ok(Math.abs(state.scroll - before.scroll) <= 1, `rapid release keeps the pre-clear scroll position: ${JSON.stringify({ before, state })}`);
      for (const slot of before.gaps) {
        const card = state.cards.find(value => value.id === slot.id);
        for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(card[key] - slot[key]) <= 1, `dropped note${slot.id} ${key} stays in its visible insertion slot: ${JSON.stringify({ slot, card })}`);
      }
    };
    assertSlot(held); await sameView(page); assert.deepEqual(await paintedOrder(page), chosen);
    releaseSave(); await saved(page); await frame(page); const acknowledged = await geometry(); assertSlot(acknowledged); assert.deepEqual(await paintedOrder(page), chosen);
    const trace = await page.evaluate(() => { window.collectOrderFrames = false; return { releasedAt: window.orderReleaseTime, frames: window.orderFrames }; });
    assert.ok(trace.frames.filter(value => value.time >= trace.releasedAt).every(value => JSON.stringify(value.order) === JSON.stringify(chosen)), 'rapid release and acknowledgement never paint the previous order');
    await record(page, `rapid-release-acknowledged-${scenario.name}`, { scenario, before, held, acknowledged, chosen, trace });
  } finally { releaseSave?.(); await page.close(); }
});

