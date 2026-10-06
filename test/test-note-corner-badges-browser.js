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
const publicRoot = process.env.NOTES_CORNER_BADGES_PUBLIC_ROOT || fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(publicRoot));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(join(publicRoot, 'index.html'), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/corner-badges-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}</style></head><body><main id="main-content" class="app-content"></main></body></html>`));
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
  if (command.kind === 'arrange') {
    for (const item of command.items) {
      const target = item.kind === 'note' ? snapshot.notes.find(note => note.id === item.id) : group(item.id);
      assert.ok(target, 'arrange names a fixture item');
      Object.assign(target.layout, clone(item.layout));
      target.layout.revision++;
    }
  }
  else if (command.kind === 'reorder') insert(group(command.group_id), command.selected_ids, command.before_note_id);
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
  if (req.method === 'PATCH' && /^\/notes\/\d+\/layout$/.test(req.path)) {
    const note = snapshot.notes.find(note => note.id === Number(req.path.split('/')[2]));
    assert.ok(note, 'layout write names a fixture note');
    assert.equal(req.body.expected_layout_revision, note.layout.revision, 'layout write uses current revision');
    Object.assign(note.layout, req.body.layout || {}, Object.hasOwn(req.body, 'position_locked') ? { position_locked: req.body.position_locked } : {});
    note.layout.revision++;
    return res.json({ data: { layout: clone(note.layout) } });
  }
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
const evidence = process.env.NOTES_CORNER_BADGES_SCREENSHOTS || fileURLToPath(new URL('../../evidence/corner-badges', import.meta.url));
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
  await page.goto(base + '/corner-badges-test');
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
  await frame(page);
  return page;
}

// Removing the badge edge attachment, scaling the glyph inversely, restoring
// title reservations, or shrinking independent hit targets must fail these tests.
async function geometry(page, selector, artSelector) {
  return page.$eval(selector, (button, artSelector) => {
    const card = button.closest('.note-card'), art = button.querySelector(artSelector) || button.querySelector('svg') || button;
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const title = card.querySelector('.note-card__title'), style = getComputedStyle(button), titleStyle = getComputedStyle(title);
    return { card: rect(card), button: rect(button), art: rect(art), background: style.backgroundColor,
      titleMargins: [parseFloat(titleStyle.marginLeft), parseFloat(titleStyle.marginRight)], title: rect(title) };
  }, artSelector);
}
const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1.25, `${message}: expected ${expected}, got ${actual}`);
for (const zoom of [.25, .5, 1, 1.5, 2]) {
  test(`pin geometry scales with the card at zoom ${zoom}`, async () => {
    const page = await mount({ canvas: true, zoom });
    try {
      const g = await geometry(page, '[data-board-key="note:15"] .note-card__lock', '.note-card__badge-art');
      await screenshot(page, `pin-zoom-${zoom}`);
      closeTo(g.art.width, 16 * zoom, 'pin glyph width follows card zoom');
      closeTo(g.art.x + g.art.width / 2, g.card.x + 22 * zoom, 'pin center is 22 world pixels inward from physical left');
      closeTo(g.art.y + g.art.height / 2, g.card.y, 'pin center lies on top card edge');
      assert.ok(g.button.width >= 43.5 && g.button.height >= 43.5, 'pin has independent minimum 44 CSS pixel hit target');
      assert.equal(g.background, 'rgba(0, 0, 0, 0)', 'pin hit target is transparent');
      const pagerClear = await page.$eval('[data-board-key="group:41"]', card => {
        const pin = card.querySelector('.note-card__lock').getBoundingClientRect();
        return [...card.querySelectorAll('[data-group-page]')].every(control => {
          const p = control.getBoundingClientRect();
          return p.right <= pin.left || p.left >= pin.right || p.bottom <= pin.top || p.top >= pin.bottom;
        });
      });
      assert.ok(pagerClear, 'group pager controls clear the pin hit target');
    } finally { await page.close(); }
  });
}
test('canvas titles reserve no horizontal space for badges', async () => {
  const page = await mount({ canvas: true });
  try {
    const g = await geometry(page, '[data-board-key="note:15"] .note-card__lock', '.note-card__badge-art');
    assert.deepEqual(g.titleMargins, [0, 0], 'title has no badge reservation margins');
  } finally { await page.close(); }
});
for (const rtl of [false, true]) {
  test(`overview selection badge is on physical right (${rtl ? 'RTL' : 'LTR'})`, async () => {
    const page = await mount({ rtl });
    try {
      await page.click('[data-group-selection-mode]');
      const g = await geometry(page, '[data-group-select="1"]', '.note-card__badge-art');
      await screenshot(page, `selection-${rtl ? 'rtl' : 'ltr'}`);
      closeTo(g.art.width, 24, 'selection circle width');
      closeTo(g.art.x + g.art.width / 2, g.card.right - 22, 'selection center physical right offset');
      closeTo(g.art.y + g.art.height / 2, g.card.y, 'selection center top edge');
      assert.ok(g.button.width >= 43.5 && g.button.height >= 43.5, 'selection independent hit target');
      const rowGap = await page.$$eval('.note-group-overview__grid > [data-group-page]', cards => {
        const rows = [];
        for (const card of cards) { const r = card.getBoundingClientRect(); if (!rows.some(row => Math.abs(row.top-r.top)<1)) rows.push({ top:r.top,bottom:r.bottom }); }
        rows.sort((a,b) => a.top-b.top);
        return Math.min(...rows.slice(1).map((row,i) => row.top-rows[i].bottom));
      });
      assert.ok(rowGap >= 24, 'row gaps keep the protruding 24 pixel selection art clear');
    } finally { await page.close(); }
  });
}

for (const size of [{ width: 2, height: 3 }, { width: 4, height: 6 }, { width: 8, height: 10 }]) {
  test(`pin remains attached for ${size.width} by ${size.height} card`, async () => {
    const page = await mount({ canvas: true, size, fixture: board => { board.notes.find(n => n.id === 15).layout.position_locked = true; } });
    try {
      const g = await geometry(page, '[data-board-key="note:15"] .note-card__lock', '.note-card__badge-art');
      closeTo(g.art.x + g.art.width / 2, g.card.x + 22, 'pin physical left offset');
      closeTo(g.art.y + g.art.height / 2, g.card.y, 'pin edge attachment');
      assert.equal(await page.$eval('[data-board-key="note:15"] .note-card__lock svg', svg => getComputedStyle(svg).fill), await page.$eval('[data-board-key="note:15"] .note-card__lock', el => getComputedStyle(el).color), 'locked pin glyph is filled');
    } finally { await page.close(); }
  });
}
for (const zoom of [.25, 1, 2]) {
  test(`origin card pin outward art is visible and hittable at ${zoom}`, async () => {
    const page = await mount({ canvas: true, zoom, fixture: board => { Object.assign(board.notes.find(n => n.id === 15).layout, { x: 0, y: 0, position_locked: true }); } });
    try {
      await page.$eval('.notes-scroll', element => { element.scrollLeft = 0; element.scrollTop = 0; });
      await frame(page);
      const result = await page.$eval('[data-board-key="note:15"] .note-card__lock', button => {
        const art = button.querySelector('.note-card__badge-art') || button.querySelector('svg'), r = art.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 4);
        return { visible: r.top >= 0, hit: button.contains(hit), x: r.x, y: r.y, hitElement: hit?.outerHTML.slice(0,300) };
      });
      assert.ok(result.visible && result.hit, `outward half of origin pin is painted and receives its own hit: ${JSON.stringify(result)}`);
      if (zoom === 2) await screenshot(page, 'origin-pin-zoom-2');
    } finally { await page.close(); }
  });
}
for (const options of [{ theme: 'dark' }, { rtl: true }, { reduced: true }, { touch: true }]) {
  test(`selection ordering remains stable with ${JSON.stringify(options)}`, async () => {
    const page = await mount(options);
    try {
      await page.click('[data-group-selection-mode]');
      for (const id of [3, 1, 2]) {
        const selector = `[data-group-select="${id}"]`;
        await page.$eval(selector, el => el.scrollIntoView({ block: 'nearest' }));
        if (options.touch) { const p = await page.$eval(selector, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.touchscreen.tap(p.x, p.y); }
        else await page.click(selector);
      }
      const order = await page.$$eval('[data-group-select][aria-pressed="true"]', els => els.map(el => ({ id: +el.dataset.groupSelect, rank: +el.textContent })).sort((a,b) => a.rank-b.rank).map(x => x.id));
      assert.deepEqual(order, [3, 1, 2], 'selection numbers record click order');
      await screenshot(page, `selection-order-${Object.keys(options)[0]}`);
      assert.equal(writes.length, 0, 'selection alone does not persist changes');
    } finally { await page.close(); }
  });
}
test('keyboard selection preserves focus and toggles with Space', async () => {
  const page = await mount();
  try {
    await page.click('[data-group-selection-mode]');
    await page.focus('[data-group-select="2"]'); await page.keyboard.press('Space');
    assert.equal(await page.$eval('[data-group-select="2"]', el => el.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.groupSelect), '2', 'same control retains focus');
    await page.keyboard.press('Space');
    assert.equal(await page.$eval('[data-group-select="2"]', el => el.getAttribute('aria-pressed')), 'false');
  } finally { await page.close(); }
});
test('pin permission denial removes the control', async () => {
  const page = await mount({ canvas: true, fixture: board => { board.notes.find(n => n.id === 15).permissions.pin = false; } });
  try { assert.equal(await page.$('[data-board-key="note:15"] .note-card__lock'), null); }
  finally { await page.close(); }
});
for (const id of [1, 12]) {
  test(`overview ${id === 1 ? 'first' : 'last'} row badge art remains inside scrolling clearance`, async () => {
    const page = await mount();
    try {
      await page.click('[data-group-selection-mode]');
      await page.$eval('.note-group-overview__grid', (el, id) => { el.scrollTop = id === 1 ? 0 : el.scrollHeight; }, id);
      await frame(page);
      const result = await page.$eval(`[data-group-select="${id}"]`, button => {
        const art = button.querySelector('.note-card__badge-art') || button, a = art.getBoundingClientRect(), g = button.closest('.note-group-overview__grid').getBoundingClientRect();
        return { top: a.top, bottom: a.bottom, clipTop: g.top, clipBottom: g.bottom, hit: button.contains(document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 4)) };
      });
      assert.ok(result.top >= result.clipTop - 1 && result.bottom <= result.clipBottom + 1 && result.hit, `badge art is visible and hittable at scrolling boundary: ${JSON.stringify(result)}`);
      if (id === 1) {
        await page.$eval('[data-group-select="1"]', el => el.closest('.note-card').scrollIntoView({ block: 'start' }));
        await frame(page);
        const aligned = await page.$eval('[data-group-select="1"]', button => {
          const a = button.querySelector('.note-card__badge-art').getBoundingClientRect(), g = button.closest('.note-group-overview__grid').getBoundingClientRect();
          return { top: a.top, clipTop: g.top, hit: button.contains(document.elementFromPoint(a.x+a.width/2,a.y+a.height/4)) };
        });
        assert.ok(aligned.top >= aligned.clipTop - 1 && aligned.hit, `programmatic start alignment preserves badge clearance: ${JSON.stringify(aligned)}`);
      }
    } finally { await page.close(); }
  });
}

for (const touch of [false, true]) {
  test(`pin artwork tap changes only lock state (${touch ? 'touch' : 'mouse'})`, async () => {
    const page = await mount({ canvas: true, touch });
    try {
      const selector = '[data-board-key="note:15"] .note-card__lock';
      const p = await page.$eval(selector, button => { const r = (button.querySelector('.note-card__badge-art') || button.querySelector('svg')).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      if (touch) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
      await page.waitForFunction(() => document.querySelector('[data-board-key="note:15"] .note-card__lock')?.getAttribute('aria-pressed') === 'true').catch(async error => { console.log('PIN_TAP_TRACE', JSON.stringify({ touch, p, writes, hit: await page.evaluate(p => document.elementFromPoint(p.x,p.y)?.outerHTML, p) })); throw error; });
      assert.equal(writes.length, 1, 'art tap makes exactly one mutation');
      assert.equal(writes[0].body.kind, 'arrange');
      const layout = writes[0].body.items[0].layout;
      assert.equal(layout.position_locked, true);
      assert.deepEqual([layout.x, layout.y, layout.width, layout.height], [0, 0, 4, 6], 'tap does not move or resize card');
    } finally { await page.close(); }
  });
}
for (const touch of [false, true]) for (const edge of [false, true]) {
  test(`low zoom transparent pin halo hands movement to ${edge ? 'edge resize' : 'body drag'} (${touch ? 'touch' : 'mouse'})`, async () => {
    const page = await mount({ canvas: true, zoom: .25, touch });
    try {
      const p = await page.$eval('[data-board-key="note:15"]', (card, edge) => {
        const r = card.getBoundingClientRect(); return { x: edge ? r.left + 1 : r.left + 14, y: r.top + 18 };
      }, edge);
      const hits = await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest('.note-card__lock') !== null, p);
      assert.ok(hits, 'test movement starts inside the transparent pin button halo');
      const cdp = touch ? await page.createCDPSession() : null;
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...p, id: 0 }] });
      else { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
      if (edge || touch) await page.waitForSelector(`[data-board-key="note:15"].note-card--${edge ? 'resizing' : 'moving'}`);
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 35, y: p.y + 20, id: 0 }] });
      else await page.mouse.move(p.x + 35, p.y + 20, { steps: 5 });
      await page.waitForSelector(`[data-board-key="note:15"].note-card--${edge ? 'resizing' : 'moving'}`);
      await screenshot(page, `halo-${edge ? 'resize' : 'drag'}`);
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector('[data-board-key="note:15"]')?.classList.contains('note-card--moving'));
      for (let n = 0; n < 30 && writes.length === 0; n++) await frame(page);
      assert.equal(writes.some(write => write.body.items?.some(item => item.layout.position_locked)), false, 'movement suppresses pin click');
      assert.ok(writes.some(write => write.body.kind === 'arrange' && write.body.items?.some(item => item.id === 15)), 'movement persists card geometry');
    } finally { await page.close(); }
  });
}


test('drag proxy preserves selection artwork ratio and stays inert', async () => {
  const page = await mount();
  try {
    await page.click('[data-group-selection-mode]');
    for (const id of [2, 3]) await page.click(`[data-group-select="${id}"]`);
    const original = await geometry(page, '[data-group-select="2"]', '.note-card__badge-art');
    const p = await page.$eval('[data-group-activate="2"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(p.x, p.y); await page.mouse.down();
    await page.waitForSelector('[data-group-drag-proxy]');
    const proxyGeometry = await geometry(page, '[data-group-drag-proxy] > .note-card:first-child .note-group-overview__select', '.note-card__badge-art');
    closeTo(proxyGeometry.art.width / proxyGeometry.card.width * original.card.width, original.art.width, 'proxy scales artwork with the entire card');
    const totalHeight = await page.$eval('[data-group-drag-proxy] .note-group-drag-proxy__count', element => element.getBoundingClientRect().height);
    closeTo(totalHeight / proxyGeometry.card.width * original.card.width, 24, 'stack total scales with the source card');
    assert.equal(await page.$eval('[data-group-drag-proxy]', el => el.inert), true, 'proxy controls are inert');
    await screenshot(page, 'selected-stack-proxy'); await page.mouse.up();
  } finally { await page.close(); }
});
