import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Production Notes page against a revision-checking, receipt-backed synthetic
// HTTP fixture. It has no live credentials, user content, or external requests.
const app = express();
app.use(express.json());
const publicRoot = process.env.NOTES_GROUP_PERSISTENCE_PUBLIC_ROOT || fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(publicRoot));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(join(publicRoot, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-persistence-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}</style></head><body><main id="main-content" class="app-content"></main></body></html>`));
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
  if (req.path === '/auth/me') return res.json({ csrfToken: 'synthetic-persistence' });
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
    if (mode === 'hold') await new Promise(resolve => { releaseSave = resolve; });
    if (mode === 'conflict') { snapshot.groups[0].revision++; return res.status(409).json({ error: 'Synthetic changed elsewhere', code: 409 }); }
    try {
      const result = apply(req.body);
      if (mode === 'unknown') return res.json({ data: { operation_id: req.body.operation_id } });
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
const evidence = process.env.NOTES_GROUP_PERSISTENCE_SCREENSHOTS || fileURLToPath(new URL('../../evidence/persistent-groups', import.meta.url));
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
  await page.goto(base + '/group-persistence-test');
  await page.evaluate(async ({ rtl, theme }) => {
    class Stream extends EventTarget { constructor() { super(); window.noteStream = this; } close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    document.documentElement.dir = rtl ? 'rtl' : 'ltr'; document.documentElement.dataset.theme = theme;
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'synthetic-persistence' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js'); window.addEventListener('popstate', handleBackNavigation);
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

test('persistence repeated reorders retain the dialog and click-order selection with fresh revision evidence', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [5, 2]);
    await order(page, ''); await saved(page); assert.equal(writes.length, 1); assert.deepEqual(await selectedOrder(page), [5, 2]);
    assert.deepEqual(await visibleOrder(page), [1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 5, 2]);
    await order(page, 1); await saved(page); assert.equal(writes.length, 2);
    assert.deepEqual(snapshot.groups[0].member_ids.slice(0, 3), [5, 2, 1]);
    assert.equal(writes[1].body.expected.groups[0].revision, 8); assert.notEqual(writes[1].body.operation_id, writes[0].body.operation_id);
    await screenshot(page, 'repeated-reorder-saved');
  } finally { await page.close(); }
});
test('persistence saving retains keyed cards, body scroll, grid scroll, focused control and active member', async () => {
  const page = await mount({ count: 24, height: 900 });
  try {
    await remember(page); await select(page, [2]); behavior = 'hold'; await order(page, ''); await waitPending(page); await sameView(page);
    await page.evaluate(() => {
      const grid = document.querySelector('.note-group-overview__grid'); grid.scrollTop = 340;
      window.keptCard = document.querySelector('[data-group-page="5"]'); window.keptBody = window.keptCard.querySelector('.note-card__content'); window.keptBody.scrollTop = 90;
      document.querySelector('[data-group-close]').focus({ preventScroll: true }); window.beforeGridScroll = grid.scrollTop;
      // Card4 is the leading visible note at this 3-column scroll position.
      // Card5 retains its body independently, but can wrap within that row.
      window.scrollAnchor = document.querySelector('[data-group-page="4"]');
      window.beforeReadingOffset = window.scrollAnchor.getBoundingClientRect().top - grid.getBoundingClientRect().top;
    });
    assert.equal(await page.$eval(panel, element => element.getAttribute('aria-busy')), 'true');
    releaseSave(); await saved(page);
    const result = await page.evaluate(() => ({ card: window.keptCard === document.querySelector('[data-group-page="5"]'), body: window.keptBody === document.querySelector('[data-group-page="5"] .note-card__content'), bodyScroll: window.keptBody.scrollTop, gridScroll: document.querySelector('.note-group-overview__grid').scrollTop, previous: window.beforeGridScroll, readingOffset: window.scrollAnchor.getBoundingClientRect().top - document.querySelector('.note-group-overview__grid').getBoundingClientRect().top, previousReadingOffset: window.beforeReadingOffset, focus: document.activeElement?.hasAttribute('data-group-close'), active: document.querySelector('[data-group-activate][aria-current="page"]')?.dataset.groupActivate }));
    assert.equal(result.card, true); assert.equal(result.body, true); assert.equal(result.bodyScroll, 90); assert.ok(result.previous > 0 && Math.abs(result.readingOffset - result.previousReadingOffset) < 2, `reading position survives row reflow: ${JSON.stringify(result)}`); assert.equal(result.focus, true); assert.equal(result.active, '1');
  } finally { releaseSave?.(); await page.close(); }
});
test('persistence a slow save gates extra mutations while browsing and explicit Close remain available', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [2]); behavior = 'hold'; await order(page, ''); await waitPending(page); await sameView(page);
    const before = await point(page, '[data-group-activate="4"]'); await page.mouse.move(before.x, before.y); await page.mouse.down(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    assert.equal(await page.$(proxy), null, 'saving prevents another drag from starting'); await page.mouse.up(); assert.equal(writes.length, 1);
    assert.equal(await page.$eval('[data-group-close]', element => element.disabled), false);
    releaseSave(); await saved(page);
  } finally { releaseSave?.(); await page.close(); }
});
test('persistence Close before a delayed acknowledgement never reopens the session', async () => {
  const page = await mount();
  try {
    await select(page, [2]); behavior = 'hold'; await order(page, ''); await waitPending(page);
    assert.ok(await page.$(overview), 'saving leaves an explicit Close control'); await page.click('[data-group-close]');
    assert.equal(await page.$(overview), null); releaseSave(); await page.waitForFunction(() => !document.querySelector('#notes-grid')?.dataset.layoutWrite); await frame(page);
    assert.equal(await page.$(overview), null); assert.equal(writes.length, 1);
  } finally { releaseSave?.(); await page.close(); }
});
test('persistence unknown save exposes Retry in the same panel and reuses the identical frozen command', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [3, 2]); behavior = 'unknown'; await order(page, '');
    await page.waitForSelector(`${panel} [data-group-retry]`); await sameView(page); assert.equal(writes.length, 1);
    assert.equal(await page.$eval('#notes-grid', element => element.dataset.layoutWrite), 'retry');
    const target = await point(page, '[data-group-activate="4"]'); await page.mouse.move(target.x, target.y); await page.mouse.down(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
    assert.equal(await page.$(proxy), null, 'unknown outcome prevents another drag from starting'); await page.mouse.up(); assert.equal(writes.length, 1, 'unknown outcome gates additional independent mutations');
    await page.click(`${panel} [data-group-retry]`); await saved(page); assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].body, writes[0].body); assert.equal(snapshot.groups[0].revision, 8);
    await screenshot(page, 'retry-acknowledged');
  } finally { await page.close(); }
});
test('persistence unknown save Reload reconciles canonical state in the retained panel without another write', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [2]); behavior = 'unknown'; await order(page, ''); await page.waitForSelector(`${panel} [data-group-reload]`);
    await page.click(`${panel} [data-group-reload]`); await saved(page); assert.equal(writes.length, 1); assert.equal((await visibleOrder(page)).at(-1), 2);
    await order(page, 1); await saved(page); assert.equal(writes[1].body.expected.groups[0].revision, 8);
  } finally { await page.close(); }
});
test('persistence conflict reloads authorized revisions and permits the next reorder without reopening', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [2]); behavior = 'conflict'; await order(page, ''); await saved(page); assert.equal(writes.length, 1);
    assert.deepEqual(await visibleOrder(page), Array.from({ length: 12 }, (_, index) => index + 1));
    await order(page, ''); await saved(page); assert.equal(writes.length, 2); assert.equal(writes[1].body.expected.groups[0].revision, 8);
  } finally { await page.close(); }
});
test('persistence Undo is reachable inside the panel and refreshes the next command context', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [2]); await order(page, ''); await saved(page); await page.waitForSelector(`${panel} [data-group-undo]`);
    await page.click(`${panel} [data-group-undo]`); await saved(page); assert.equal(writes[1].body.kind, 'undo'); assert.equal(writes[1].body.undo_operation_id, writes[0].body.operation_id);
    assert.deepEqual(await visibleOrder(page), Array.from({ length: 12 }, (_, index) => index + 1));
    await order(page, ''); await saved(page); assert.equal(writes[2].body.expected.groups[0].revision, 9);
  } finally { await page.close(); }
});
for (const scenario of [{ name: 'mouse', touch: false }, { name: 'touch', touch: true }, { name: 'mouse-small-half-zoom', touch: false, zoom: .5, size: { width: 3, height: 4 } }]) test(`persistence native ${scenario.name} add promotes the existing preview and permits subsequent reordering`, async () => {
  const page = await mount({ canvas: true, ...scenario, count: 4, width: 1802, height: 1178 }), cdp = scenario.touch ? await page.createCDPSession() : null;
  try {
    await nativeEntry(page, 7, cdp); assert.equal(writes.length, 0); await release(page, cdp); await saved(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'join'); assert.ok((await visibleOrder(page)).includes(7));
    await select(page, [7]); await order(page, ''); await saved(page); assert.equal(writes.length, 2); assert.equal(writes[1].body.expected.groups[0].revision, 8);
    await screenshot(page, `native-${scenario.name}-add-retained`);
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence authority loss during a held drag purges inaccessible content and cancels the gesture', async () => {
  const page = await mount();
  try {
    await hold(page, 2); assert.ok(await page.$(proxy));
    snapshot.notes = snapshot.notes.filter(note => note.id !== 2); snapshot.groups[0].member_ids = snapshot.groups[0].member_ids.filter(id => id !== 2); snapshot.groups[0].can_manage = false; snapshot.groups[0].revision++;
    await refresh(page); await page.waitForFunction(() => !document.querySelector('[data-group-drag-proxy]'));
    assert.equal(await page.$('[data-group-page="2"]'), null); assert.equal(await page.$('[data-group-activate="2"]'), null);
    await release(page); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});
test('persistence a removed group closes on authorized refresh without retaining its preview', async () => {
  const page = await mount();
  try {
    snapshot.notes = snapshot.notes.filter(note => note.id > 12); snapshot.groups = snapshot.groups.filter(group => group.id !== 41);
    await refresh(page); await page.waitForFunction(() => !document.querySelector('.note-group-overview')); assert.equal(writes.length, 0);
    assert.equal(await page.$('[data-board-key="group:41"]'), null);
  } finally { await page.close(); }
});
test('persistence management revocation keeps authorized content browseable but removes mutation controls', async () => {
  const page = await mount();
  try {
    snapshot.groups[0].can_manage = false; snapshot.groups[0].revision++;
    snapshot.notes.slice(0, 12).forEach(note => { note.permissions = { ...note.permissions, arrange: false, move: false, group: false, ungroup: false }; });
    await refresh(page); assert.ok(await page.$(`${overview} [data-group-page="1"]`));
    assert.equal(await page.$(`${overview} [data-group-action="order"]`), null); assert.equal(await page.$('[data-group-select]'), null); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});
test('persistence authentication ending while saving clears the panel and a delayed acknowledgement cannot restore it', async () => {
  const page = await mount();
  try {
    await select(page, [2]); behavior = 'hold'; await order(page, ''); await waitPending(page);
    await page.evaluate(() => window.dispatchEvent(new Event('auth:context-ending')));
    await page.waitForFunction(() => !document.querySelector('.note-group-overview')); releaseSave(); await frame(page); await frame(page);
    assert.equal(await page.$(overview), null); assert.equal(writes.length, 1);
  } finally { releaseSave?.(); await page.close(); }
});
test('persistence newer access loss wins over a delayed successful mutation response', async () => {
  const page = await mount();
  try {
    await select(page, [2]); behavior = 'hold-applied'; await order(page, ''); await waitPending(page);
    snapshot.notes = snapshot.notes.filter(note => note.id !== 2); snapshot.groups[0].member_ids = snapshot.groups[0].member_ids.filter(id => id !== 2); snapshot.groups[0].can_manage = false; snapshot.groups[0].revision++;
    const before = reads; await page.evaluate(() => window.noteStream.dispatchEvent(new Event('notes')));
    await page.waitForFunction(() => !document.querySelector('[data-group-page="2"]')); assert.ok(reads > before);
    releaseSave(); await page.waitForFunction(() => !document.querySelector('#notes-grid')?.dataset.layoutWrite); await frame(page);
    assert.equal(await page.$('[data-group-page="2"]'), null); assert.equal(await page.$('[data-group-activate="2"]'), null); assert.equal(writes.length, 1);
    assert.equal(await page.$(`${panel} [data-group-undo]`), null, 'stale receipt must not restore an Undo grant after access loss');
  } finally { releaseSave?.(); await page.close(); }
});
test('persistence a chosen active member remains active after reorder acknowledgement', async () => {
  const page = await mount();
  try {
    await point(page, '[data-group-activate="4"]'); await page.click('[data-group-activate="4"]');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    await page.click('[data-board-key="group:41"] [data-group-page="overview"]'); await remember(page);
    assert.equal(await page.$eval('[aria-current="page"][data-group-activate]', element => element.dataset.groupActivate), '4');
    await select(page, [2]); await order(page, ''); await saved(page);
    assert.equal(await page.$eval('[aria-current="page"][data-group-activate]', element => element.dataset.groupActivate), '4');
  } finally { await page.close(); }
});
for (const scenario of [
  { name: 'mouse-wide', width: 1440, height: 1000 },
  { name: 'touch-narrow', width: 390, height: 844, touch: true },
  { name: 'reduced-dark', width: 844, height: 700, reduced: true, theme: 'dark' },
  { name: 'rtl-medium', width: 1040, height: 900, rtl: true },
]) test(`persistence insertion gap shifts full cards across rows with stable hit testing: ${scenario.name}`, async () => {
  const page = await mount({ ...scenario, count: 18 }), cdp = scenario.touch ? await page.createCDPSession() : null;
  try {
    await remember(page); await hold(page, 2, cdp); const target = await point(page, '[data-group-page="3"]', scenario.rtl ? 'after' : 'before');
    await move(page, target, cdp); await page.waitForSelector(gap); await frame(page);
    const initial = await page.$$eval(`${grid} > *`, elements => elements.map(element => ({ id: element.dataset.groupPage || 'gap', x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight })).filter(value => value.width));
    assert.ok(initial.some(value => value.id === 'gap')); assert.ok(initial.filter(value => value.id !== 'gap').every(value => value.width <= 320 && value.height === 276));
    for (let step = 0; step < 6; step++) { await move(page, { x: target.x + step % 2, y: target.y }, cdp); await frame(page); }
    const after = await page.$$eval(`${grid} > *`, elements => elements.map(element => ({ id: element.dataset.groupPage || 'gap', x: element.offsetLeft, y: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight })).filter(value => value.width));
    assert.deepEqual(after, initial, 'stationary pointer does not oscillate the insertion slot as neighbors animate'); assert.equal(writes.length, 0);
    if (scenario.reduced) assert.equal(await page.$eval(grid, element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length), 0);
    await screenshot(page, `insertion-${scenario.name}`);
    await page.keyboard.press('Escape'); await release(page, cdp); await frame(page); await sameView(page);
    assert.equal(await page.$(gap), null); assert.equal(await page.$(proxy), null); assert.equal(writes.length, 0);
    assert.deepEqual(await visibleOrder(page), Array.from({ length: 18 }, (_, index) => index + 1));
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence changed drag submits once and backdrop release cannot dismiss the retained session', async () => {
  const page = await mount();
  try {
    await remember(page); const target = await point(page, '[data-group-page="6"]', 'before'); await hold(page, 2); await move(page, target); await release(page); await saved(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'reorder'); assert.equal(await page.$(gap), null);
    await hold(page, 3); await move(page, { x: 5, y: 400 }); await release(page); await frame(page); await sameView(page); assert.equal(writes.length, 1);
  } finally { await page.close(); }
});
test('persistence releasing an unchanged insertion is a local no-op and keeps the same panel open', async () => {
  const page = await mount();
  try {
    await remember(page); const start = await hold(page, 2); await move(page, { x: start.x + 1, y: start.y }); await release(page); await frame(page); await sameView(page);
    assert.equal(writes.length, 0); assert.equal(await page.$(gap), null); assert.equal(await page.$(proxy), null);
  } finally { await page.close(); }
});
test('persistence multiple selected notes reserve full insertion slots in click order and send one command', async () => {
  const page = await mount({ count: 18 });
  try {
    await remember(page); await select(page, [5, 2, 4]); await hold(page, 5);
    const target = await point(page, '[data-group-page="9"]', 'before'); await move(page, target); await page.waitForFunction(() => document.querySelectorAll('[data-group-insertion-gap]').length === 3);
    assert.equal(writes.length, 0); assert.deepEqual(await page.$eval(proxy, element => JSON.parse(element.dataset.selectedIds)), [5, 2, 4]);
    const gaps = await page.$$eval(gap, elements => elements.map(element => ({ width: element.offsetWidth, height: element.offsetHeight })));
    assert.ok(gaps.every(value => value.width === 320 && value.height === 276));
    await screenshot(page, 'multiple-full-card-insertion-moving');
    await page.waitForFunction(() => document.querySelector('.note-group-overview__grid').getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'));
    await screenshot(page, 'multiple-full-card-insertion'); await release(page); await saved(page);
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].body.selected_ids, [5, 2, 4]);
    const order = snapshot.groups[0].member_ids, first = order.indexOf(5); assert.deepEqual(order.slice(first, first + 3), [5, 2, 4]);
    assert.equal(await page.$(gap), null);
  } finally { await page.close(); }
});
for (const touch of [false, true]) test(`persistence native held drag crosses the backdrop and returns without dismissing: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ canvas: true, touch, count: 4, width: 1802, height: 1178 }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await nativeEntry(page, 7, cdp); await move(page, { x: 8, y: 400 }, cdp);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350))); await sameView(page);
    assert.equal(await page.$eval(overview, element => element.hidden), false); assert.ok(await page.$(proxy)); assert.equal(writes.length, 0);
    await move(page, await point(page, '[data-group-page="2"]', 'before'), cdp); await release(page, cdp); await saved(page); assert.equal(writes.length, 1);
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence native Escape cancels only the held gesture and a later Escape explicitly closes', async () => {
  const page = await mount({ canvas: true, count: 4, width: 1802, height: 1178 });
  try {
    await nativeEntry(page, 7); await page.keyboard.press('Escape'); await release(page); await frame(page); await sameView(page);
    assert.equal(await page.$(proxy), null); assert.equal(await page.$(gap), null); assert.equal(writes.length, 0);
    await page.keyboard.press('Escape'); assert.equal(await page.$(overview), null);
  } finally { await page.close(); }
});
test('persistence native removal dwell yields to canvas and Escape restores the same group session', async () => {
  const page = await mount({ canvas: true, count: 4, width: 1802, height: 1178 });
  try {
    await nativeEntry(page, 7);
    const target = await page.$eval(panel, element => { const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: Math.max(3, bounds.top / 2) }; });
    await move(page, target); await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
    assert.equal(writes.length, 0); await page.keyboard.press('Escape'); await release(page); await frame(page); await sameView(page);
    assert.equal(await page.$eval(overview, element => element.hidden), false); assert.equal(await page.$(proxy), null); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});
for (const touch of [false, true]) test(`persistence internal cross-group transfer retains destination and supports a fresh reorder: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ touch, count: 4, width: 1802, height: 1178 }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await remember(page); await select(page, [3, 2]); await hold(page, 3, cdp);
    const exit = await page.$eval(panel, element => { const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: Math.max(3, bounds.top / 2) }; });
    await move(page, exit, cdp); await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
    await move(page, await point(page, '[data-board-key="group:42"]'), cdp);
    await page.waitForSelector(`${overview} [data-group-page="5"]`); await sameView(page); assert.equal(writes.length, 0);
    await move(page, await point(page, '[data-group-page="6"]', 'before'), cdp); await release(page, cdp); await saved(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'transfer'); assert.deepEqual(writes[0].body.selected_ids, [3, 2]);
    assert.deepEqual(await visibleOrder(page), snapshot.groups.find(group => group.id === 42).member_ids); assert.deepEqual(await selectedOrder(page), [3, 2]);
    await order(page, ''); await saved(page); assert.equal(writes.length, 2); assert.equal(writes[1].body.group_id, 42); assert.equal(writes[1].body.expected.groups[0].revision, 4);
    await screenshot(page, `cross-group-${touch ? 'touch' : 'mouse'}-retained`);
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence refresh retains a surviving focused card control and selection click order', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [5, 2]); await point(page, '[data-group-select="5"]'); await page.focus('[data-group-select="5"]');
    await page.evaluate(() => { window.keptFocusedControl = document.activeElement; });
    snapshot.notes[2].title = 'Refreshed synthetic note'; snapshot.notes[2].revision++; snapshot.groups[0].revision++;
    await refresh(page); await page.waitForFunction(() => document.querySelector('[data-group-page="3"] .note-card__title')?.textContent === 'Refreshed synthetic note'); await sameView(page);
    assert.equal(await page.evaluate(() => window.keptFocusedControl === document.activeElement && window.keptFocusedControl.isConnected), true);
    assert.deepEqual(await selectedOrder(page), [5, 2]); assert.equal(writes.length, 0);
    await order(page, ''); await saved(page); assert.equal(writes[0].body.expected.groups[0].revision, 8);
  } finally { await page.close(); }
});
for (const touch of [false, true]) test(`persistence native capture loss after exit dwell restores the session without a later write: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ canvas: true, touch, count: 4, width: 1802, height: 1178 }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await nativeEntry(page, 7, cdp);
    const target = await page.$eval(panel, element => { const bounds = element.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: Math.max(3, bounds.top / 2) }; });
    await move(page, target, cdp); await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
    await page.evaluate(() => {
      const source = document.querySelector('[data-board-key="note:7"]');
      if (!source.hasPointerCapture(window.latestPointerId)) throw new Error('Native source must still own capture before the deliberate interruption');
      source.releasePointerCapture(window.latestPointerId);
    });
    await move(page, { x: target.x + 1, y: target.y }, cdp);
    await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === false && !document.querySelector('[data-group-drag-proxy]'));
    await sameView(page); assert.equal(await page.$(gap), null);
    assert.equal(await page.$('[data-board-key="note:7"].note-card--drag-source'), null); assert.equal(writes.length, 0);
    await release(page, cdp); await frame(page); await sameView(page); assert.equal(writes.length, 0);
  } finally { await cdp?.detach(); await page.close(); }
});
for (const touch of [false, true]) test(`persistence unchanged live refresh preserves an internal drag and its capture: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ touch }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await remember(page); await hold(page, 2, cdp); await move(page, await point(page, '[data-group-page="6"]', 'before'), cdp); await page.waitForSelector(gap);
    await page.evaluate(() => { window.keptCapture = [...document.querySelectorAll('*')].find(element => element.hasPointerCapture(window.latestPointerId)); window.keptProxy = document.querySelector('[data-group-drag-proxy]'); window.keptGap = document.querySelector('[data-group-insertion-gap]'); });
    await refresh(page); await sameView(page);
    assert.equal(await page.$eval(overview, element => element.dataset.gestureState), 'dragging');
    assert.equal(await page.evaluate(() => !!window.keptCapture?.hasPointerCapture(window.latestPointerId) && window.keptProxy === document.querySelector('[data-group-drag-proxy]') && window.keptGap === document.querySelector('[data-group-insertion-gap]')), true, 'unchanged authority leaves the current pointer owner and insertion preview intact');
    await page.keyboard.press('Escape'); await release(page, cdp); await frame(page); await sameView(page);
    assert.equal(await page.$(proxy), null); assert.equal(await page.$(gap), null); assert.equal(writes.length, 0);
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence unchanged live refresh preserves open keyboard Order tools and focused choice', async () => {
  const page = await mount();
  try {
    await remember(page); await select(page, [5, 2]);
    await page.$eval('[data-group-menu]', element => { element.open = true; }); await page.click(`${overview} [data-group-action="order"]`);
    await page.select('[data-group-before]', '7'); await page.focus('[data-group-before]');
    await page.evaluate(() => { window.keptOrderChoice = document.activeElement; });
    await refresh(page); await sameView(page);
    assert.equal(await page.evaluate(() => window.keptOrderChoice?.isConnected && window.keptOrderChoice === document.activeElement && window.keptOrderChoice.value === '7'), true);
    assert.deepEqual(await selectedOrder(page), [5, 2]); assert.equal(writes.length, 0);
    await page.click('[data-group-confirm]'); await saved(page); assert.equal(writes.length, 1); assert.equal(writes[0].body.before_note_id, 7);
  } finally { await page.close(); }
});
for (const touch of [false, true]) test(`persistence stationary noncontiguous selection hold never commits a reorder: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ touch }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await remember(page); await select(page, [5, 2, 4]); const before = clone(snapshot.groups[0].member_ids);
    await hold(page, 5, cdp); await release(page, cdp); await frame(page); await frame(page); await sameView(page);
    assert.equal(writes.length, 0, 'long press without intentional movement does not compact or reorder a noncontiguous selection');
    assert.deepEqual(snapshot.groups[0].member_ids, before); assert.deepEqual(await visibleOrder(page), before); assert.deepEqual(await selectedOrder(page), [5, 2, 4]);
    assert.equal(await page.$(proxy), null); assert.equal(await page.$(gap), null);
  } finally { await cdp?.detach(); await page.close(); }
});
test('persistence accessible Add to a pinned note promotes the same window to the canonical new group', async () => {
  const page = await mount({ canvas: true, count: 4, width: 1802, height: 1178, fixture(board) { board.notes.find(note => note.id === 8).layout.position_locked = true; } });
  try {
    await page.focus('[data-board-key="note:7"] .note-card__menu summary'); await page.keyboard.press('Enter');
    await page.focus('[data-board-key="note:7"] [data-group-action="add"]'); await page.keyboard.press('Enter');
    await page.waitForSelector(overview); await remember(page); await page.select('[data-group-destination]', 'note:8');
    await page.focus('[data-group-confirm]'); await page.keyboard.press('Enter'); await saved(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'create'); assert.equal(writes[0].body.source_note_id, 7); assert.equal(writes[0].body.target_note_id, 8);
    assert.deepEqual(await visibleOrder(page), [8, 7]); assert.equal(await page.$eval('[data-group-selection-mode]', element => element.hidden), false);
    const created = snapshot.groups.find(group => group.member_ids.includes(7)); assert.deepEqual(created.member_ids, [8, 7]);
    await screenshot(page, 'accessible-create-retained');
  } finally { await page.close(); }
});
