import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Exercise the production page, CSS and gesture owners with synthetic household
// data. The server and request allowlist prevent access to any live Notes API.
const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-refinement-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}</style></head><body><main id="main-content" class="app-content"></main></body></html>`));
let browser, server, base, snapshot, writes, holdSave = false, releaseSave;
app.use('/api/v1', async (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'synthetic-refinement' });
  if (req.path === '/notes/board') return res.json({ data: snapshot });
  if (req.path === '/notes/members') return res.json({ data: [{ id: 1, display_name: 'Synthetic Parent' }] });
  if (req.path === '/notes/changes') return res.status(204).end();
  if (req.method !== 'GET') writes.push({ path: req.path, body: structuredClone(req.body) });
  if (req.path === '/notes/group-operations') {
    if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
    return res.json({ data: { operation_id: req.body.operation_id, replayed: false, board: snapshot, undo_available: false } });
  }
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}), args: ['--disable-dev-shm-usage'] });
});
test.after(async () => {
  releaseSave?.();
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

const overview = '.note-group-overview';
const panel = '.note-group-overview__panel';
const grid = '.note-group-overview__grid';
const proxy = '[data-group-drag-proxy]';
const sourceGroup = '[data-board-key="group:41"]';
const selectionOrder = [9, 2, 7, 5];
const evidence = process.env.NOTES_GROUP_REFINEMENT_SCREENSHOTS || fileURLToPath(new URL('../../evidence/group-refinement', import.meta.url));
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
  mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) });
}
async function mount({ width = 1440, height = 1000, theme = 'light', touch = false, reduced = false, rtl = false, count = 10, zoom = 1, canvas = false, sourceSize = { width: 4, height: 6 } } = {}) {
  writes = []; holdSave = false; releaseSave = null;
  snapshot = {
    notes: Array.from({ length: count + 3 }, (_, index) => ({ id: index + 1,
      title: `Synthetic note ${index + 1}`,
      // The native-drag source has no link near its body hit area: mobile
      // Chrome otherwise adjusts a half-zoom touch onto that nearby link.
      content: `# Garden plan ${index + 1}\n\n**Water mint** and _basil_.\n\n- Gather seeds\n- Read ${index === count + 2 ? 'planting guide' : '[planting guide](https://example.test/guide)'}\n\n` + Array.from({ length: 8 }, (_, line) => `Preview paragraph ${line + 1} stays readable.`).join('\n\n'),
      color: index % 2 ? '#C7DED9' : '#EFE3BE', created_by: 1, creator_name: 'Synthetic Parent', revision: 1,
      permissions: { view: true, edit: true, arrange: true, delete: true, manage_visibility: true },
      layout: { x: 0, y: 0, width: 4, height: 6, ...(index === count + 2 ? sourceSize : {}), revision: 1, position_locked: index !== count + 2 } })),
    groups: [
      { id: 41, revision: 7, member_ids: Array.from({ length: count }, (_, index) => index + 1), can_manage: true, layout: { x: 5, y: 0, width: 4, height: 6, position_locked: true, always_on_top: true } },
      { id: 42, revision: 3, member_ids: [count + 1, count + 2], can_manage: true, layout: { x: 5, y: 8, width: 4, height: 6, position_locked: true } },
    ],
  };
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setViewport({ width, height, hasTouch: touch, isMobile: touch });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isInterceptResolutionHandled()) return;
    const url = new URL(request.url());
    if (url.origin === base || url.protocol === 'data:' || url.protocol === 'blob:') request.continue();
    else request.abort('blockedbyclient');
  });
  await page.goto(base + '/group-refinement-test');
  await page.evaluate(async ({ theme, rtl }) => {
    class Stream extends EventTarget { close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'synthetic-refinement' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js');
    window.addEventListener('popstate', () => handleBackNavigation());
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
    window.pointerStarts = []; window.pointerTargets = [];
    window.addEventListener('pointerdown', event => { window.pointerStarts.push(event.pointerId); window.pointerTargets.push(event.target.outerHTML.slice(0, 500)); }, true);
    window.addEventListener('gotpointercapture', event => { window.captureOwner = event.target; }, true);
    window.gestureEvents = [];
    for (const type of ['pointercancel', 'lostpointercapture', 'resize', 'blur', 'touchmove']) window.addEventListener(type, event => window.gestureEvents.push({ type, target: event.target?.className || event.target?.nodeName, prevented: event.defaultPrevented, state: document.querySelector('.note-group-overview')?.dataset.gestureState }), { passive: true });
  }, { theme, rtl });
  for (let step = 0; step < Math.round(Math.abs(zoom - 1) / .25); step++) await page.click(zoom < 1 ? '#notes-zoom-out' : '#notes-zoom-in');
  if (!canvas) {
    await page.click(`${sourceGroup} [data-group-page="overview"]`);
    await page.waitForSelector(overview);
  }
  return page;
}
async function point(page, selector) {
  await page.$eval(selector, element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return page.$eval(selector, element => {
    const rect = element.getBoundingClientRect(), scroller = element.closest('.note-group-overview__grid')?.getBoundingClientRect();
    const left = Math.max(0, rect.left, scroller?.left || 0), right = Math.min(innerWidth, rect.right, scroller?.right || innerWidth);
    const top = Math.max(0, rect.top, scroller?.top || 0), bottom = Math.min(innerHeight, rect.bottom, scroller?.bottom || innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  });
}
async function select(page, ids) {
  if (await page.$eval('[data-group-selection-mode]', element => element.getAttribute('aria-pressed')) !== 'true') await page.click('[data-group-selection-mode]');
  for (const id of ids) { await point(page, `[data-group-select="${id}"]`); await page.click(`[data-group-select="${id}"]`); }
}
async function action(page, name) {
  await page.$eval('[data-group-menu]', element => { element.open = true; });
  await page.click(`${overview} [data-group-action="${name}"]`);
}
async function move(page, target, cdp) {
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...target, id: 0 }] });
  else await page.mouse.move(target.x, target.y);
}
async function release(page, cdp) {
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
}
async function hold(page, id = 2, cdp) {
  const start = await point(page, `[data-group-activate="${id}"]`);
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
  else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'dragging');
  await frame(page);
  const pointer = await page.evaluate(() => {
    const pointer = window.pointerStarts.at(-1);
    // gotpointercapture is dispatched on the next pointer event, whereas
    // hasPointerCapture already reports the pending owner after the hold.
    window.captureOwner = [...document.querySelectorAll('*')].find(element => element.hasPointerCapture(pointer)) || window.captureOwner;
    return pointer;
  });
  return { ...start, pointer };
}
async function assertCapture(page, pointer, retained = true) {
  assert.equal(await page.evaluate(pointer => !!window.captureOwner?.hasPointerCapture(pointer), pointer), retained, 'the original pointer capture owner survives the visual transition');
}
async function exitToCanvas(page, cdp) {
  const target = await page.$eval(panel, element => { const rect = element.getBoundingClientRect(); return { x: innerWidth / 2, y: Math.max(2, rect.top / 2) }; });
  const start = await page.evaluate(() => performance.now());
  await move(page, target, cdp);
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'exit-dwell');
  await page.waitForFunction(start => performance.now() - start >= 750, {}, start);
  assert.equal(await page.$eval(overview, element => element.hidden), false, '750ms is too early to remove a note');
  assert.equal(writes.length, 0, 'dwell remains a local preview');
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
  const elapsed = await page.evaluate(start => performance.now() - start, start);
  assert.ok(elapsed >= 980 && elapsed < 1700, `exit retains the 1000ms dwell, observed ${elapsed}ms`);
  assert.equal(writes.length, 0);
}
async function assertFullProxy(page, ids, { width = 320, height = 276, exact = false } = {}) {
  assert.ok(await page.$(proxy), 'a visible full-card drag preview exists above the overview');
  const result = await page.$eval(proxy, element => {
    const surface = element.querySelector('.note-card__surface') || element.querySelector('.note-card') || element;
    const rect = element.getBoundingClientRect(), visual = getComputedStyle(surface);
    const overlay = document.querySelector('.note-group-overview');
    const controls = [...element.querySelectorAll('button,a,input,select,textarea,summary,[tabindex]')];
    const inactive = node => node.disabled || node.closest('[inert]') || (node.tabIndex < 0 && getComputedStyle(node).pointerEvents === 'none');
    // Temporarily admit the decorative proxy to hit testing to measure painted
    // stacking; restore its style immediately without changing the gesture.
    const prior = element.style.pointerEvents, priority = element.style.getPropertyPriority('pointer-events'), priorInert = element.inert;
    element.inert = false; element.style.setProperty('pointer-events', 'auto', 'important');
    const x = Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y); const above = element === hit || element.contains(hit);
    element.style.setProperty('pointer-events', prior, priority); element.inert = priorInert;
    return { ids: JSON.parse(element.dataset.selectedIds), width: rect.width, height: rect.height,
      text: element.textContent, body: !!element.querySelector('.note-card__content'),
      hiddenFromAT: element.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(element).pointerEvents,
      controlsInactive: controls.every(inactive), shadow: visual.boxShadow, background: visual.backgroundColor,
      above: !overlay || overlay.hidden || above, duplicateIds: [...element.querySelectorAll('[id]')].map(node => node.id),
    };
  });
  assert.deepEqual(result.ids, ids);
  assert.ok(result.width >= width - 3 && result.height >= height - 3, `full card, not a title pill: ${JSON.stringify(result)}`);
  if (exact) assert.ok(Math.abs(result.width - width) <= 3 && Math.abs(result.height - height) <= 3, `native preview preserves the source's physical dimensions: ${JSON.stringify(result)}`);
  assert.equal(result.body, true, 'the dragged card includes rendered note content');
  assert.match(result.text, /Water mint/); assert.match(result.text, /Synthetic note/);
  assert.equal(result.hiddenFromAT, 'true'); assert.equal(result.pointerEvents, 'none');
  assert.equal(result.controlsInactive, true, 'clones never add active controls'); assert.deepEqual(result.duplicateIds, []);
  assert.notEqual(result.shadow, 'none', 'the whole card has a lifted shadow');
  assert.notEqual(result.background, 'rgba(0, 0, 0, 0)');
  assert.equal(result.above, true, 'the painted preview is above the modal backdrop and panel');
}

for (const scenario of [
  { name: 'wide-light', width: 1440, height: 1000 },
  { name: 'middle-dark', width: 752, height: 835, theme: 'dark' },
  { name: 'narrow-touch', width: 320, height: 720, touch: true },
  { name: 'short-reduced', width: 844, height: 390, reduced: true },
]) test(`refinement overview keeps full 320x276 previews with vertical-only scrolling: ${scenario.name}`, async () => {
  const page = await mount({ ...scenario, count: 30 });
  try {
    await screenshot(page, `${scenario.name}-overview`);
    const result = await page.$eval(grid, element => ({
      width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight,
      padding: parseFloat(getComputedStyle(element).paddingLeft) + parseFloat(getComputedStyle(element).paddingRight),
      cards: [...element.querySelectorAll('[data-group-page]')].map(card => ({ id: Number(card.dataset.groupPage), ...card.getBoundingClientRect().toJSON() })),
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    }));
    assert.equal(await page.$eval(`${panel} h2`, element => element.textContent.trim()), 'Notes');
    const expectedWidth = Math.min(320, result.width - result.padding);
    for (const card of result.cards) {
      assert.ok(Math.abs(card.width - expectedWidth) <= 1, `preview width should be ${expectedWidth}px: ${JSON.stringify(card)}`);
      assert.ok(Math.abs(card.height - 276) <= 1, `preview height stays 276px: ${JSON.stringify(card)}`);
    }
    assert.ok(new Set(result.cards.map(card => Math.round(card.top))).size >= 3, 'notes wrap through many rows');
    assert.ok(result.scrollHeight > result.height, 'the overview scrolls vertically');
    assert.ok(result.scrollWidth <= result.width + 1 && result.documentWidth <= result.viewportWidth + 1, 'no horizontal overflow');
    await page.$eval(grid, element => { element.scrollTop = element.scrollHeight; element.scrollLeft = 10000; });
    const end = await page.$eval(grid, element => ({ left: element.scrollLeft, top: element.scrollTop, last: element.lastElementChild.getBoundingClientRect().toJSON(), viewport: element.getBoundingClientRect().toJSON() }));
    assert.equal(end.left, 0); assert.ok(end.top > 0); assert.ok(end.last.bottom <= end.viewport.bottom + 1);
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('refinement selection badges show click order at top-right and append deselected/reselected notes', async () => {
  const page = await mount();
  try {
    await select(page, selectionOrder); await screenshot(page, 'selection-click-order');
    async function badges() {
      return page.$$eval('[data-group-select][aria-pressed="true"]', elements => elements.map(element => {
        const card = element.closest('[data-group-page]').getBoundingClientRect(), rect = element.getBoundingClientRect();
        return { id: Number(element.dataset.groupSelect), number: element.textContent.trim(), top: rect.top - card.top, right: card.right - rect.right, width: rect.width, height: rect.height };
      }).sort((a, b) => Number(a.number) - Number(b.number)));
    }
    let actual = await badges();
    assert.deepEqual(actual.map(item => [item.id, item.number]), selectionOrder.map((id, index) => [id, String(index + 1)]));
    assert.ok(actual.every(item => item.top >= -1 && item.top <= 12 && item.right >= -1 && item.right <= 12 && item.width >= 44 && item.height >= 44), JSON.stringify(actual));
    await page.click('[data-group-select="2"]');
    assert.deepEqual((await badges()).map(item => [item.id, item.number]), [[9, '1'], [7, '2'], [5, '3']]);
    await page.click('[data-group-select="2"]');
    assert.deepEqual((await badges()).map(item => [item.id, item.number]), [[9, '1'], [7, '2'], [5, '3'], [2, '4']]);
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const operation of ['order', 'move', 'remove']) test(`refinement ${operation} payload preserves [9,2,7,5] until intentional confirmation`, async () => {
  const page = await mount();
  try {
    await select(page, selectionOrder); await action(page, operation);
    if (operation === 'move') await page.select('[data-group-destination]', '42');
    if (operation !== 'remove') await page.select('[data-group-before]', operation === 'order' ? '4' : '12');
    else await page.click('[data-group-extract-choice="individual"]');
    assert.equal(writes.length, 0);
    await page.click('[data-group-confirm]');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].body.selected_ids, selectionOrder);
    assert.equal(writes[0].body.kind, { order: 'reorder', move: 'transfer', remove: 'extract' }[operation]);
  } finally { await page.close(); }
});

test('refinement transfer to the final insertion position preserves the selected block order', async () => {
  const page = await mount();
  try {
    await select(page, selectionOrder); await action(page, 'move'); await page.select('[data-group-destination]', '42');
    const options = await page.$$eval('[data-group-before] option', elements => elements.map(element => ({ value: element.value, text: element.textContent.trim() })));
    assert.ok(options.length >= 2, 'transfer offers before-note and final positions');
    await page.select('[data-group-before]', options.at(-1).value); await page.click('[data-group-confirm]');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.equal(writes[0].body.before_note_id, null);
    assert.deepEqual(writes[0].body.selected_ids, selectionOrder);
  } finally { await page.close(); }
});

for (const placement of ['beginning', 'end']) test(`refinement standalone Add to ${placement} uses the visible keyboard choice`, async () => {
  const page = await mount({ canvas: true });
  try {
    await page.focus('[data-board-key="note:13"] .note-card__menu summary'); await page.keyboard.press('Enter');
    await page.focus('[data-board-key="note:13"] [data-group-action="add"]'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-group-destination]'); await page.select('[data-group-destination]', '41');
    const options = await page.$$eval('[data-group-before] option', elements => elements.map(element => ({ value: element.value, text: element.textContent.trim() })));
    const selected = placement === 'beginning' ? options[0] : options.at(-1);
    assert.equal(selected.text, `Add to ${placement}`);
    await page.select('[data-group-before]', selected.value); assert.equal(writes.length, 0);
    await page.focus('[data-group-confirm]'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'join');
    assert.deepEqual(writes[0].body.note_ids, [13]); assert.equal(writes[0].body.before_note_id, placement === 'beginning' ? 1 : null);
  } finally { await page.close(); }
});

test('refinement removal cue is concise and centered above the panel while preserving a 1000ms dwell', async () => {
  const page = await mount();
  try {
    const start = await hold(page); await screenshot(page, 'removal-cue');
    const cue = await page.$eval('[data-group-exit]', element => ({ text: element.textContent.trim(), rect: element.getBoundingClientRect().toJSON(), panel: document.querySelector('.note-group-overview__panel').getBoundingClientRect().toJSON() }));
    assert.equal(cue.text, 'Hold here to remove');
    assert.ok(cue.rect.width <= 300 && cue.rect.height <= 56, JSON.stringify(cue));
    assert.ok(cue.rect.bottom <= cue.panel.top + 1 && cue.rect.top >= 0, 'the cue is above the panel');
    assert.ok(Math.abs(cue.rect.left + cue.rect.width / 2 - (cue.panel.left + cue.panel.width / 2)) <= 1, 'cue and panel are centered together');
    await exitToCanvas(page); await assertCapture(page, start.pointer);
    await page.keyboard.press('Escape'); await release(page); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const ids of [[2], selectionOrder]) test(`refinement internal drag carries one inert full-card visual for ${ids.length} selected notes`, async () => {
  const page = await mount();
  try {
    if (ids.length > 1) await select(page, ids);
    const start = await hold(page, ids[0]); await screenshot(page, `internal-${ids.length}-full-card`);
    await assertFullProxy(page, ids); await assertCapture(page, start.pointer);
    assert.equal(await page.$$eval(proxy, elements => elements.length), 1);
    assert.equal(writes.length, 0);
    await exitToCanvas(page); await screenshot(page, `exit-${ids.length}-full-card`);
    await assertFullProxy(page, ids); await assertCapture(page, start.pointer);
    await page.keyboard.press('Escape'); await release(page); await frame(page);
    assert.equal(writes.length, 0); assert.equal(await page.$(proxy), null);
    await assertCapture(page, start.pointer, false);
  } finally { await page.close(); }
});

test('refinement picking up an overview card preserves its surface, title and body geometry', async () => {
  const page = await mount();
  try {
    await point(page, '[data-group-activate="2"]');
    const geometry = selector => page.$eval(selector, element => {
      const outer = element.getBoundingClientRect();
      return Object.fromEntries(['.note-card__surface', '.note-card__title', '.note-card__content'].map(selector => {
        const node = element.querySelector(selector), rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return [selector, { left: rect.left - outer.left, top: rect.top - outer.top, width: rect.width, height: rect.height, marginLeft: style.marginLeft, marginRight: style.marginRight }];
      }));
    });
    const before = await geometry('[data-group-page="2"]');
    await hold(page, 2); const after = await geometry('[data-group-drag-proxy] > .note-card');
    await screenshot(page, 'overview-pickup-geometry');
    for (const selector of Object.keys(before)) {
      for (const field of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(before[selector][field] - after[selector][field]) <= 1, `pickup must not reflow ${selector} ${field}: ${JSON.stringify({ before, after })}`);
      assert.equal(after[selector].marginLeft, before[selector].marginLeft, `${selector} left margin`);
      assert.equal(after[selector].marginRight, before[selector].marginRight, `${selector} right margin`);
    }
    await page.keyboard.press('Escape'); await release(page); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const theme of ['light', 'dark']) for (const { zoom, rtl = false } of [{ zoom: .5 }, { zoom: 1 }, { zoom: 1.5 }, { zoom: .5, rtl: true }]) test(`refinement locked pin is filled with a clear 44px hit target and no background overlay: ${theme} zoom ${zoom}${rtl ? ' rtl' : ''}`, async () => {
  const page = await mount({ canvas: true, theme, zoom, rtl });
  try {
    await screenshot(page, `pin-${theme}-${zoom}${rtl ? '-rtl' : ''}`);
    const pin = await page.$eval(`${sourceGroup} [data-board-action="lock"]`, element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element), icon = element.querySelector('svg');
      const title = element.closest('.note-card').querySelector('.note-card__title').getBoundingClientRect();
      const glyph = icon?.getBoundingClientRect(), body = element.closest('.note-card').querySelector('.note-card__content').getBoundingClientRect();
      return { pressed: element.getAttribute('aria-pressed'), width: rect.width, height: rect.height, background: style.backgroundColor, shadow: style.boxShadow,
        overlap: Math.max(0, Math.min(rect.right, title.right) - Math.max(rect.left, title.left)) * Math.max(0, Math.min(rect.bottom, title.bottom) - Math.max(rect.top, title.top)),
        bodyOverlap: glyph ? Math.max(0, Math.min(glyph.right, body.right) - Math.max(glyph.left, body.left)) * Math.max(0, Math.min(glyph.bottom, body.bottom) - Math.max(glyph.top, body.top)) : null,
        beforeBackground: getComputedStyle(element, '::before').backgroundColor, afterBackground: getComputedStyle(element, '::after').backgroundColor,
        fill: icon ? getComputedStyle(icon).fill : null, pathFills: [...element.querySelectorAll('svg path')].map(path => getComputedStyle(path).fill) };
    });
    assert.equal(pin.pressed, 'true'); assert.ok(pin.width >= 43.9 && pin.height >= 43.9, JSON.stringify(pin));
    assert.ok(pin.overlap <= 1, `pin hit target must not overlap the title hit target: ${JSON.stringify(pin)}`);
    assert.ok(pin.bodyOverlap != null && pin.bodyOverlap <= 1, `pin glyph must not overlap the readable note body: ${JSON.stringify(pin)}`);
    assert.ok(pin.fill && pin.fill !== 'none' || pin.pathFills.some(fill => fill !== 'none' && fill !== 'rgba(0, 0, 0, 0)'), `locked pin visibly filled: ${JSON.stringify(pin)}`);
    assert.equal(pin.background, 'rgba(0, 0, 0, 0)'); assert.equal(pin.shadow, 'none');
    assert.equal(pin.beforeBackground, 'rgba(0, 0, 0, 0)'); assert.equal(pin.afterBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('refinement overview renders readable Markdown and lets a long note scroll within its full preview', async () => {
  const page = await mount();
  try {
    const body = '[data-group-page="1"] .note-card__content';
    assert.ok(await page.$(body), 'overview contains the same rendered body as a note card');
    const result = await page.$eval(body, element => {
      const before = element.scrollTop; element.scrollTop = element.scrollHeight;
      return { strong: element.querySelector('strong')?.textContent, strongDisplay: getComputedStyle(element.querySelector('strong')).display,
        text: element.textContent, before, after: element.scrollTop, height: element.clientHeight, width: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    assert.equal(result.strong, 'Water mint'); assert.match(result.text, /planting guide/);
    assert.equal(result.strongDisplay, 'inline', 'inline Markdown emphasis must not acquire the note title layout');
    assert.doesNotMatch(result.text, /\*\*Water|\]\(https:/); assert.ok(result.height >= 120);
    assert.ok(result.after > result.before, 'long content is reachable by vertical preview scrolling');
    assert.ok(result.scrollWidth <= result.width + 1);
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('refinement a native touch swipe scrolls a long preview body without replacing it or starting a drag', async () => {
  const page = await mount({ width: 390, height: 844, touch: true }), cdp = await page.createCDPSession();
  try {
    const selector = '[data-group-page="2"] .note-card__content';
    await point(page, selector);
    const start = await page.$eval(selector, element => {
      window.swipedBody = element;
      const rect = element.getBoundingClientRect(), grid = element.closest('.note-group-overview__grid').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: Math.min(rect.bottom, grid.bottom) - 24 };
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
    for (let step = 1; step <= 6; step++) await move(page, { x: start.x, y: start.y - step * 16 }, cdp);
    await release(page, cdp);
    await page.waitForFunction(() => window.swipedBody.scrollTop > 20);
    assert.equal(await page.$eval(selector, element => element === window.swipedBody), true, 'scroll cancellation retains the browser native touch target');
    assert.equal(await page.$(proxy), null); assert.equal(await page.$('.note-modal'), null); assert.equal(writes.length, 0);
    await screenshot(page, 'narrow-native-preview-swipe');
  } finally { await cdp.detach(); await page.close(); }
});

async function beginNative(page, cdp) {
  const start = await page.$eval('[data-board-key="note:13"]', element => {
    window.originalSource = element;
    const rect = element.getBoundingClientRect();
    for (const fy of [.7, .6, .5, .4]) for (const fx of [.3, .5, .7]) {
      const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
      const target = document.elementFromPoint(x, y);
      if (element.contains(target) && !target?.closest('a,button,input,select,textarea,summary,details,[role="checkbox"],[contenteditable="true"]')) return { x, y, grabX: x - rect.left, grabY: y - rect.top, width: rect.width, height: rect.height, draggable: true };
    }
    return { width: rect.width, height: rect.height, draggable: false };
  });
  assert.equal(start.draggable, true, `fixture starts on a noninteractive note body: ${JSON.stringify(start)}`);
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 0 }] });
    try { await page.waitForSelector('[data-board-key="note:13"].note-card--moving'); }
    catch (error) { error.message += `; actual pointer target: ${await page.evaluate(() => window.pointerTargets.at(-1))}`; throw error; }
  } else {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
  }
  await move(page, { x: start.x + 15, y: start.y }, cdp);
  await page.waitForSelector('[data-board-key="note:13"].note-card--moving'); await frame(page);
  return { ...start, pointer: await page.evaluate(() => window.pointerStarts.at(-1)) };
}
async function enterNativeOverview(page, cdp) {
  const start = await beginNative(page, cdp);
  await assertCapture(page, start.pointer);
  const target = await point(page, sourceGroup);
  await move(page, target, cdp);
  await page.waitForSelector(`${overview} [data-group-page="1"]`); await frame(page);
  return start;
}
async function sampleTilt(page, start, reduced = false) {
  return page.evaluate(async ({ start, reduced }) => {
    let x = start.x, y = start.y;
    const visual = () => document.querySelector('[data-group-drag-proxy] .note-card__surface') || document.querySelector('[data-group-drag-proxy] .note-card') || document.querySelector('[data-group-drag-proxy]');
    const angle = () => {
      const style = getComputedStyle(visual());
      if (style.rotate !== 'none') return parseFloat(style.rotate) || 0;
      const matrix = new DOMMatrixReadOnly(style.transform);
      return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI;
    };
    const travel = async (vx, vy, duration = 180) => {
      let time = await new Promise(requestAnimationFrame), elapsed = 0;
      while (elapsed < duration) {
        const now = await new Promise(requestAnimationFrame), dt = now - time; time = now; elapsed += dt;
        x += dt * vx; y += dt * vy;
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: start.pointer, pointerType: 'mouse', buttons: 1, clientX: x, clientY: y }));
      }
      await new Promise(requestAnimationFrame); return angle();
    };
    const slow = await travel(.08, 0), fast = await travel(.65, 0), left = await travel(-.65, 0);
    const vertical = await travel(0, .04, 400);
    const style = getComputedStyle(visual());
    return { slow, fast, left, vertical, reduced, shadow: style.boxShadow, animation: style.animationDuration, transition: style.transitionDuration };
  }, { start, reduced });
}
function assertTilt(result) {
  assert.notEqual(result.shadow, 'none', 'lifted shadow remains visible');
  if (result.reduced) {
    assert.ok([result.slow, result.fast, result.left, result.vertical].every(angle => Math.abs(angle) < .01), JSON.stringify(result));
    assert.ok(result.animation.split(',').every(value => parseFloat(value) === 0));
    assert.ok(result.transition.split(',').every(value => parseFloat(value) === 0));
  } else {
    assert.ok(result.fast > result.slow + .3 && result.fast > .5, `faster rightward motion leans farther: ${JSON.stringify(result)}`);
    assert.ok(result.left < -.5 && Math.abs(result.left) <= 4.1 && result.fast <= 4.1, `leftward lean reverses within the canvas tilt bound: ${JSON.stringify(result)}`);
    assert.ok(Math.abs(result.vertical) < .15, `vertical movement releases lateral tilt: ${JSON.stringify(result)}`);
  }
}

for (const touch of [false, true]) for (const zoom of [.5, 1, 1.5]) test(`refinement standalone entry retains a full-card foreground preview and source capture: ${touch ? 'touch' : 'mouse'} zoom ${zoom}`, async () => {
  const page = await mount({ canvas: true, touch, zoom }), cdp = touch ? await page.createCDPSession() : null;
  try {
    const start = await enterNativeOverview(page, cdp);
    await screenshot(page, `standalone-${touch ? 'touch' : 'mouse'}-${zoom}`);
    await assertFullProxy(page, [13], { ...start, exact: true }); await assertCapture(page, start.pointer);
    assert.equal(await page.evaluate(() => originalSource === document.querySelector('[data-board-key="note:13"]') && originalSource.isConnected && captureOwner === originalSource), true, 'the original source owns capture while its visual clone floats above the overview');
    assert.equal(await page.$$eval('[data-board-key="note:13"]', elements => elements.length), 1, 'the decorative preview duplicates no actionable board identity');
    const insert = await point(page, `${overview} [data-group-page="4"]`);
    await move(page, insert, cdp); await frame(page);
    await assertFullProxy(page, [13], { ...start, exact: true }); assert.equal(writes.length, 0);
    await release(page, cdp);
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'join');
    assert.deepEqual(writes[0].body.note_ids, [13]); assert.equal(writes[0].body.before_note_id, 4);
    assert.equal(await page.$(proxy), null); await assertCapture(page, start.pointer, false);
  } finally { await cdp?.detach(); await page.close(); }
});

test('refinement moving within a native destination dwell preserves the grabbed offset on the next move', async () => {
  const page = await mount({ canvas: true });
  try {
    const start = await beginNative(page);
    await point(page, sourceGroup);
    // Stay below the source grab point so its canonical y=0 boundary does not
    // clamp the native card while testing the separate portal handoff.
    const target = await page.$eval(sourceGroup, element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.bottom - 60 }; });
    await move(page, target); await frame(page);
    const latest = { x: target.x + 40, y: target.y + 10 };
    await move(page, latest); await frame(page);
    assert.equal(await page.$(overview), null, 'the pointer moves while the 400ms destination dwell is still pending');
    await page.waitForSelector(`${overview} [data-group-page="1"]`); await frame(page);
    const before = await page.$eval(proxy, element => element.getBoundingClientRect().toJSON());
    await assertCapture(page, start.pointer);
    const next = { x: latest.x + 8, y: latest.y + 4 };
    await move(page, next); await frame(page);
    const after = await page.$eval(proxy, element => element.getBoundingClientRect().toJSON());
    await screenshot(page, 'native-moving-dwell-offset');
    assert.ok(Math.abs(after.left - before.left - 8) <= 1 && Math.abs(after.top - before.top - 4) <= 1, `the first move after opening must follow only its physical delta: ${JSON.stringify({ before, after, start, latest, next })}`);
    assert.ok(Math.abs(latest.x - before.left - start.grabX) <= 1 && Math.abs(latest.y - before.top - start.grabY) <= 1, `opening the overview preserves the original physical grab offset: ${JSON.stringify({ before, start, latest })}`);
    assert.ok(Math.abs(next.x - after.left - start.grabX) <= 1 && Math.abs(next.y - after.top - start.grabY) <= 1, 'the same source point remains under the pointer after opening');
    await assertCapture(page, start.pointer); assert.equal(writes.length, 0);
    await page.keyboard.press('Escape'); await release(page); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const scenario of [
  { width: 3, height: 4, zoom: .5 },
  { width: 6, height: 8, zoom: 1.5 },
]) test(`refinement native saved ${scenario.width}x${scenario.height} card keeps its own dimensions at zoom ${scenario.zoom}`, async () => {
  const page = await mount({ canvas: true, zoom: scenario.zoom, sourceSize: { width: scenario.width, height: scenario.height } });
  try {
    const start = await enterNativeOverview(page); await screenshot(page, `native-saved-${scenario.width}x${scenario.height}-${scenario.zoom}`);
    await assertFullProxy(page, [13], { ...start, exact: true }); await assertCapture(page, start.pointer);
    const preview = await page.$eval(`${overview} [data-group-page="1"]`, element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    assert.ok(Math.abs(preview.width - 320) <= 1 && Math.abs(preview.height - 276) <= 1, 'overview previews remain 320x276 regardless of native card size');
    await page.keyboard.press('Escape'); await release(page); await frame(page);
    assert.equal(writes.length, 0); assert.equal(await page.$(proxy), null); await assertCapture(page, start.pointer, false);
  } finally { await page.close(); }
});

for (const reduced of [false, true]) for (const selected of [false, true]) test(`refinement ${selected ? 'multiselect' : 'single'} preview has canvas velocity tilt and reduced-motion parity: ${reduced}`, async () => {
  const page = await mount({ reduced });
  try {
    if (selected) await select(page, selectionOrder);
    const start = await hold(page, selected ? 9 : 2);
    await assertFullProxy(page, selected ? selectionOrder : [2]);
    // Keep the sample in the visible grid; the held note may be in a lower row.
    const center = await page.$eval(grid, element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2 - 70, y: rect.top + Math.min(rect.height / 2, 130) }; });
    await move(page, center); assertTilt(await sampleTilt(page, { ...center, pointer: start.pointer }, reduced));
    await page.keyboard.press('Escape'); await release(page);
    assert.equal(writes.length, 0); assert.equal(await page.$(proxy), null);
  } finally { await page.close(); }
});

for (const reduced of [false, true]) test(`refinement native entry uses the same bounded velocity tilt and reduced-motion treatment: ${reduced}`, async () => {
  const page = await mount({ canvas: true, reduced });
  try {
    const start = await enterNativeOverview(page); await assertFullProxy(page, [13], start);
    const center = await page.$eval(grid, element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2 - 70, y: rect.top + Math.min(rect.height / 2, 130) }; });
    await move(page, center); assertTilt(await sampleTilt(page, { ...center, pointer: start.pointer }, reduced));
    await page.keyboard.press('Escape'); await release(page); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const cancel of ['Escape', 'pointercancel', 'capture-loss']) test(`refinement native ${cancel} restores the connected source after repeated overview entry`, async () => {
  const page = await mount({ canvas: true, touch: true, theme: 'dark' }), cdp = await page.createCDPSession();
  try {
    const paint = () => page.$eval('[data-board-key="note:13"]', element => {
      const style = getComputedStyle(element), surface = getComputedStyle(element.querySelector('.note-card__surface'));
      return { opacity: style.opacity, visibility: style.visibility, surfaceOpacity: surface.opacity, surfaceVisibility: surface.visibility };
    });
    const before = await paint();
    for (let iteration = 0; iteration < 2; iteration++) {
      const start = await enterNativeOverview(page, cdp); await assertFullProxy(page, [13], start);
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else if (cancel === 'pointercancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      else await page.evaluate(pointer => window.captureOwner.releasePointerCapture(pointer), start.pointer);
      if (cancel !== 'pointercancel') await release(page, cdp);
      await page.waitForFunction(() => !document.querySelector('[data-group-drag-proxy]') && !document.querySelector('.note-card--moving'));
      assert.equal(await page.$(overview), null); assert.equal(await page.$('.note-modal'), null); assert.equal(writes.length, 0);
      assert.deepEqual(await paint(), before, 'cancellation restores every source paint property');
      assert.equal(await page.evaluate(() => originalSource.isConnected && originalSource === document.querySelector('[data-board-key="note:13"]') && !originalSource.classList.contains('note-card--drag-source')), true);
      await assertCapture(page, start.pointer, false);
    }
  } finally { await cdp.detach(); await page.close(); }
});

test('refinement narrow touch drag retains the narrowed full card and can cancel after exit', async () => {
  const page = await mount({ width: 320, height: 720, touch: true, theme: 'dark', reduced: true }), cdp = await page.createCDPSession();
  try {
    const size = await page.$eval('[data-group-page="2"]', element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
    const start = await hold(page, 2, cdp); await screenshot(page, 'narrow-touch-full-card');
    await assertFullProxy(page, [2], size); await assertCapture(page, start.pointer);
    await exitToCanvas(page, cdp); await assertFullProxy(page, [2], size); await assertCapture(page, start.pointer);
    await page.keyboard.press('Escape'); await release(page, cdp); await frame(page);
    assert.equal(writes.length, 0); assert.equal(await page.$(proxy), null);
  } finally { await cdp.detach(); await page.close(); }
});

for (const touch of [false, true]) test(`refinement selected block crosses groups with full-card continuity and click-order payload: ${touch ? 'touch' : 'mouse'}`, async () => {
  const page = await mount({ touch, theme: touch ? 'dark' : 'light' }), cdp = touch ? await page.createCDPSession() : null;
  try {
    await select(page, selectionOrder); const start = await hold(page, 9, cdp);
    await exitToCanvas(page, cdp); await assertFullProxy(page, selectionOrder); await assertCapture(page, start.pointer);
    const target = await point(page, '[data-board-key="group:42"]'); await move(page, target, cdp);
    await page.waitForSelector(`${overview}:not([hidden]) [data-group-page="11"]`);
    await screenshot(page, `cross-group-${touch ? 'touch' : 'mouse'}`);
    await assertFullProxy(page, selectionOrder); await assertCapture(page, start.pointer);
    const insertion = await point(page, `${overview} [data-group-page="12"]`);
    await move(page, insertion, cdp);
    const dropState = await page.evaluate(({ x, y }) => ({ gesture: document.querySelector('.note-group-overview')?.dataset.gestureState, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 400), owner: window.captureOwner?.className, pointer: window.pointerStarts.at(-1) }), insertion);
    assert.equal(writes.length, 0); await release(page, cdp);
    try { await page.waitForFunction(() => !document.querySelector('.note-group-overview')); }
    catch (error) { error.message += `; before release ${JSON.stringify(dropState)}; after ${JSON.stringify(await page.evaluate(() => ({ state: document.querySelector('.note-group-overview')?.dataset.gestureState, events: window.gestureEvents, pages: [...document.querySelectorAll('.note-group-overview [data-group-page]')].map(element => element.dataset.groupPage) })))}; writes ${JSON.stringify(writes)}`; throw error; }
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'transfer');
    assert.deepEqual(writes[0].body.selected_ids, selectionOrder); assert.equal(writes[0].body.target_group_id, 42); assert.equal(writes[0].body.before_note_id, 12);
    assert.equal(await page.$(proxy), null); await assertCapture(page, start.pointer, false);
  } finally { await cdp?.detach(); await page.close(); }
});

for (const cancel of ['Escape', 'pointercancel', 'capture-loss', 'resize']) test(`refinement ${cancel} clears full-card drag visuals and stale release cannot save`, async () => {
  const page = await mount({ touch: true }), cdp = await page.createCDPSession();
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      if (!await page.$(overview)) { await page.click(`${sourceGroup} [data-group-page="overview"]`); await page.waitForSelector(overview); }
      const start = await hold(page, 2, cdp);
      await assertFullProxy(page, [2]);
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else if (cancel === 'pointercancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      else if (cancel === 'capture-loss') await page.evaluate(pointer => window.captureOwner.releasePointerCapture(pointer), start.pointer);
      else await page.setViewport({ width: 1438 - iteration * 2, height: 998, hasTouch: true, isMobile: true });
      if (cancel !== 'pointercancel') await release(page, cdp);
      await frame(page);
      assert.equal(writes.length, 0); assert.equal(await page.$(proxy), null); assert.equal(await page.$('.note-modal'), null);
      await assertCapture(page, start.pointer, false);
    }
  } finally { await cdp.detach(); await page.close(); }
});

for (const touch of [false, true]) test(`refinement Escape during the initial hold cannot become a ${touch ? 'touch' : 'mouse'} activation on release`, async () => {
  const page = await mount({ touch }), cdp = touch ? await page.createCDPSession() : null;
  try {
    const start = await point(page, '[data-group-activate="2"]');
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
    else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
    assert.equal(await page.$eval(overview, element => element.dataset.gestureState), 'holding');
    await page.keyboard.press('Escape'); await release(page, cdp); await frame(page);
    assert.ok(await page.$(overview), 'Escape cancels the hold while the overview consumes its release');
    assert.equal(await page.$(proxy), null); assert.equal(await page.$('.note-modal'), null); assert.equal(writes.length, 0);
    await page.click('[data-group-activate="3"]');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(await page.$eval('[data-board-key="group:41"]', element => Number(element.dataset.id)), 3, 'a fresh activation is not swallowed by the canceled pointer');
    assert.equal(writes.length, 0);
  } finally { await cdp?.detach(); await page.close(); }
});

test('refinement pending structural save blocks another overview and drag until acknowledgement', async () => {
  const page = await mount();
  try {
    await select(page, selectionOrder); await action(page, 'order'); holdSave = true;
    await page.select('[data-group-before]', '4'); await page.click('[data-group-confirm]');
    await page.waitForFunction(() => document.querySelector('#notes-grid')?.getAttribute('aria-busy') === 'true');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body.selected_ids, selectionOrder);
    // A busy overview may remain mounted for feedback; dismissing it must not
    // turn the pending operation into permission for another command.
    await page.keyboard.press('Escape');
    if (await page.$(overview)) await page.$eval('[data-group-close]', element => element.click());
    await page.$eval(`${sourceGroup} [data-group-page="overview"]`, element => element.click());
    assert.equal(await page.$(overview), null);
    const before = await page.$eval('[data-board-key="note:13"]', element => ({ left: element.style.left, top: element.style.top }));
    const source = await point(page, '[data-board-key="note:13"]');
    await page.mouse.move(source.x, source.y); await page.mouse.down(); await page.mouse.move(source.x + 80, source.y + 20); await page.mouse.up();
    assert.deepEqual(await page.$eval('[data-board-key="note:13"]', element => ({ left: element.style.left, top: element.style.top })), before);
    assert.equal(writes.length, 1); assert.equal(await page.$(proxy), null);
    releaseSave(); holdSave = false;
    await page.waitForFunction(() => document.querySelector('#notes-grid')?.getAttribute('aria-busy') !== 'true');
    await page.click(`${sourceGroup} [data-group-page="overview"]`); await page.waitForSelector(overview);
    await page.keyboard.press('Escape'); assert.equal(writes.length, 1);
  } finally { releaseSave?.(); await page.close(); }
});
