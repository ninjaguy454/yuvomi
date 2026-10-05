import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Synthetic authorized household; the real Notes page, renderer and CSS own all UI.
const app = express(); app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const links = '<link rel="stylesheet" href="/styles/notes.css">' + [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => `<link rel="stylesheet" href="${match[1]}">`).join('');
app.get('/group-design-test', (_req, res) => res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}<script src="/lucide.min.js"></script><style>html,body{height:100%;margin:0}#main-content{height:100vh}</style></head><body><main id="main-content" class="app-content"></main></body></html>`));
let snapshot, writes, browser, server, base;
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ csrfToken: 'synthetic-design' });
  if (req.path === '/notes/board') return res.json({ data: snapshot });
  if (req.path === '/notes/members') return res.json({ data: [{ id: 1, display_name: 'Sample Parent' }] });
  if (req.method !== 'GET') writes.push({ path: req.path, body: structuredClone(req.body) });
  if (req.path === '/notes/group-operations') return res.json({ data: { operation_id: req.body.operation_id, replayed: false, board: snapshot, undo_available: false } });
  return res.json({ data: [] });
});
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });

const overview = '.note-group-overview';
const panel = '.note-group-overview__panel';
const group = '[data-board-key="group:41"]';
const visible = (page, selector) => page.$$eval(selector, elements => elements.filter(element => {
  const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}).length);
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
  if (!process.env.NOTES_GROUP_DESIGN_SCREENSHOTS) return;
  mkdirSync(process.env.NOTES_GROUP_DESIGN_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.NOTES_GROUP_DESIGN_SCREENSHOTS}/${name}.png` });
}
async function mount({ width = 1280, height = 800, rtl = false, textScale = 1, theme = 'light', touch = false, reduced = false, canManage = true, count = 10 } = {}) {
  writes = [];
  snapshot = {
    notes: Array.from({ length: count }, (_, index) => ({ id: index + 1,
      title: index === 9 ? 'Garden notebook: the very long authorized heading stays readable' : `Note ${index + 1}`,
      content: index === 0 ? '# Garden plan\n\n**Water mint** and _basil_.\n\n- Gather seeds\n- Read [planting guide](https://example.test/guide)' : index === 1 ? 'Seed list\n\n- [ ] Peas\n- [x] Beans' : index === 2 ? 'Identifier seed_list and code `_literal_` stay intact.' : `Authorized preview ${index + 1}`,
      color: index % 2 ? '#C7DED9' : '#EFE3BE', created_by: 1, creator_name: 'Sample Parent', revision: 1,
      permissions: { view: true, edit: true, arrange: true, delete: true },
      layout: { x: index * 4, y: 30, width: 4, height: 6, revision: 1, position_locked: true } })),
    groups: [{ id: 41, revision: 7, member_ids: Array.from({ length: count }, (_, index) => index + 1), can_manage: canManage,
      layout: { x: 0, y: 0, width: 4, height: 6, position_locked: true, always_on_top: true } }],
  };
  const page = await browser.newPage(); page.setDefaultTimeout(1800);
  await page.setViewport({ width, height, isMobile: touch, hasTouch: touch });
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(base + '/group-design-test');
  await page.evaluate(async ({ rtl, textScale, theme }) => {
    class Stream extends EventTarget { constructor() { super(); window.noteStream = this; } close() {} }
    window.EventSource = Stream; window.yuvomi = { showToast() {} };
    localStorage.setItem('yuvomi-locale', 'en'); await (await import('/i18n.js')).initI18n();
    document.documentElement.dir = rtl ? 'rtl' : 'ltr'; document.documentElement.dataset.theme = theme;
    document.documentElement.style.fontSize = `${textScale * 100}%`;
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/device-context.js')).acceptAuthentication({ authContext: 'group-design-human' });
    const { handleBackNavigation } = await import('/utils/overlay-history.js'); window.addEventListener('popstate', () => handleBackNavigation());
    window.stopNotes = await (await import('/pages/notes.js')).render(document.getElementById('main-content'), { user: { id: 1 } });
    window.pointerStarts = []; window.addEventListener('pointerdown', event => window.pointerStarts.push(event.pointerId), true);
  }, { rtl, textScale, theme });
  await page.click(`${group} [data-group-page="overview"]`); await page.waitForSelector(overview); return page;
}
async function select(page, ids) {
  // Older baseline has always-visible toggles; this fallback lets independent
  // downstream RED cases reach preview/exit behavior instead of one missing control.
  if (await page.$('[data-group-selection-mode]')) {
    if (await page.$eval('[data-group-selection-mode]', element => element.getAttribute('aria-pressed')) !== 'true') await page.click('[data-group-selection-mode]');
  }
  for (const id of ids) await page.click(`[data-group-select="${id}"]`);
}
async function action(page, name) {
  if (await page.$('[data-group-menu]')) await page.$eval('[data-group-menu]', element => { element.open = true; });
  await page.click(`${overview} [data-group-action="${name}"]`);
}
async function point(page, selector) {
  await page.$eval(selector, element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  return page.$eval(selector, element => {
    const rect = element.getBoundingClientRect(), grid = element.closest('.note-group-overview__grid')?.getBoundingClientRect();
    const left = Math.max(0, rect.left, grid?.left || 0), right = Math.min(innerWidth, rect.right, grid?.right || innerWidth);
    const top = Math.max(0, rect.top, grid?.top || 0), bottom = Math.min(innerHeight, rect.bottom, grid?.bottom || innerHeight);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  });
}
async function hold(page, id = 2, cdp = null) {
  const start = await point(page, `[data-group-activate="${id}"]`);
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
  else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'dragging');
  return page.evaluate(() => window.pointerStarts.at(-1));
}
async function move(page, target, cdp = null) {
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...target, id: 0 }] });
  else await page.mouse.move(target.x, target.y);
}
async function margin(page, edge) {
  return page.$eval(panel, (element, edge) => {
    const rect = element.getBoundingClientRect();
    if (edge === 'top-space') {
      const heading = element.querySelector('header').getBoundingClientRect(), grid = element.querySelector('.note-group-overview__grid').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: (heading.bottom + grid.top) / 2 };
    }
    return edge === 'top' ? { x: innerWidth / 2, y: Math.max(2, rect.top / 2) }
      : { x: Math.max(2, rect.left / 2), y: rect.top + rect.height / 2 };
  }, edge);
}
async function exitToCanvas(page, { edge = 'top', cdp = null, capture = false } = {}) {
  await move(page, await margin(page, edge), cdp);
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'exit-dwell');
  await page.evaluate(() => { window.dwellStarted = performance.now(); });
  if (capture) await screenshot(page, '752-dark-exit-dwell');
  await page.waitForFunction(() => performance.now() - window.dwellStarted >= 600);
  assert.equal(await page.$eval(overview, element => element.hidden), false, 'the exit requires a dwell, not merely crossing the margin');
  assert.equal(writes.length, 0, 'exit preview never writes');
  await page.waitForFunction(() => document.querySelector('.note-group-overview')?.hidden === true);
  assert.equal(writes.length, 0, 'completing the dwell still never writes');
}
async function dropPoint(page) {
  return page.$eval('.notes-scroll', element => { const rect = element.getBoundingClientRect(); return { x: Math.min(innerWidth - 24, rect.right - 24), y: Math.min(innerHeight - 30, rect.bottom - 30) }; });
}
async function assertControlsInside(page, selector) {
  const controls = await page.$$eval(selector, elements => elements.filter(element => element.getClientRects().length).map(element => {
    const rect = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent.trim(), ...rect.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight };
  }));
  assert.ok(controls.length > 0);
  for (const rect of controls) assert.ok(rect.width >= 43.9 && rect.height >= 43.9 && rect.left >= -.5 && rect.right <= rect.viewportWidth + .5 && rect.top >= -.5 && rect.bottom <= rect.viewportHeight + .5, JSON.stringify(rect));
}
async function assertProxy(page, ids) {
  const proxy = await page.$eval('[data-group-drag-proxy]', element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { ids: JSON.parse(element.dataset.selectedIds), text: element.textContent, hiddenFromAT: element.getAttribute('aria-hidden'), opacity: Number(style.opacity), visibility: style.visibility, pointerEvents: style.pointerEvents, ...rect.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  assert.deepEqual(proxy.ids, ids); assert.match(proxy.text, new RegExp(String(ids.length)));
  assert.equal(proxy.hiddenFromAT, 'true'); assert.equal(proxy.pointerEvents, 'none');
  assert.ok(proxy.opacity > 0 && proxy.visibility === 'visible' && proxy.width > 0 && proxy.height > 0 && proxy.left >= 0 && proxy.right <= proxy.viewportWidth + 1 && proxy.top >= 0 && proxy.bottom <= proxy.viewportHeight + 1, JSON.stringify(proxy));
}
async function contrast(page, selector) {
  return page.$eval(selector, element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const pixel = [...context.getImageData(0, 0, 1, 1).data]; return [...pixel.slice(0, 3), pixel[3] / 255]; };
    const composite = (front, back) => [...front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3])), 1];
    const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.push(node);
    const background = ancestors.reverse().reduce((back, node) => composite(rgba(getComputedStyle(node).backgroundColor), back), [255,255,255,1]);
    const style = getComputedStyle(element), foreground = composite(rgba(style.color), background);
    const luminance = channels => channels.slice(0, 3).map(channel => { const value = channel / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return { foreground: style.color, background: style.backgroundColor, ratio: (values[0] + .05) / (values[1] + .05) };
  });
}

test('scene2 has a sparse Notes header and explicit icon-only multiselect mode', async () => {
  const page = await mount(); try {
    assert.equal(await page.$eval(`${panel} h2`, element => element.textContent.trim()), 'Notes');
    assert.equal(await visible(page, '[data-group-select]'), 0, 'selection marks are absent until mode is enabled');
    assert.equal(await visible(page, '[data-group-exit]'), 0, 'the drag-only exit cue does not occupy the browsing header');
    const toggle = await page.$eval('[data-group-selection-mode]', element => ({ label: element.getAttribute('aria-label'), state: element.getAttribute('aria-pressed'), text: element.textContent.trim() }));
    assert.ok(toggle.label); assert.equal(toggle.state, 'false'); assert.ok(toggle.text.length <= 2, 'the mode control is an icon rather than a repeated text toolbar');
    await page.focus('[data-group-selection-mode]'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('[data-group-selection-mode]', element => element.getAttribute('aria-pressed')), 'true');
    assert.equal(await visible(page, '[data-group-select]'), 10);
    await page.click('[data-group-activate="2"]');
    assert.equal(await page.$eval('[data-group-select="2"]', element => element.getAttribute('aria-pressed')), 'true', 'card tap selects while selection mode is active');
    assert.match(await page.$eval('[data-group-selection-count]', element => element.textContent), /1/);
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('scene2 keyboard card selection preserves focus for repeated Enter and Space toggles', async () => {
  const page = await mount(); try {
    await page.focus('[data-group-selection-mode]'); await page.keyboard.press('Enter');
    await page.focus('[data-group-activate="5"]'); await page.keyboard.press('Enter');
    assert.equal(await page.$eval('[data-group-select="5"]', element => element.getAttribute('aria-pressed')), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.groupActivate), '5', 'selection rerender retains the activated card as keyboard focus');
    await page.keyboard.press('Space');
    assert.equal(await page.$eval('[data-group-select="5"]', element => element.getAttribute('aria-pressed')), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.groupActivate), '5');
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('scene2 puts structural actions in a secondary menu and preserves the exact ordered block', async () => {
  const page = await mount(); try {
    await select(page, [9,2,7,5]);
    assert.equal(await visible(page, `${overview} [data-group-action]`), 0, 'selected state does not add a permanent three-button toolbar');
    assert.match(await page.$eval('[data-group-selection-count]', element => element.textContent), /4/);
    await page.focus('[data-group-menu] summary'); await page.keyboard.press('Enter');
    assert.equal(await visible(page, `${overview} [data-group-action]`), 3);
    await page.focus(`${overview} [data-group-action="order"]`); await page.keyboard.press('Enter');
    await page.select('[data-group-before]', '4'); await page.click('[data-group-confirm]');
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); const command = writes[0].body;
    assert.equal(command.kind, 'reorder'); assert.deepEqual(command.selected_ids, [2,5,7,9]); assert.equal(command.before_note_id, 4);
    const ordered = [1,3,4,6,8,10]; ordered.splice(ordered.indexOf(command.before_note_id), 0, ...command.selected_ids);
    assert.deepEqual(ordered, [1,3,2,5,7,9,4,6,8,10]);
  } finally { await page.close(); }
});

test('scene2 previews retain authorized note colors and readable rendered Markdown', async () => {
  const page = await mount(); try {
    const previews = await page.$$eval(`${overview} [data-group-page]`, elements => elements.slice(0, 3).map(element => {
      const activate = element.querySelector('[data-group-activate]'), excerpt = element.querySelector('.note-group-overview__excerpt');
      return { background: getComputedStyle(activate).backgroundColor, cardBackground: getComputedStyle(element).backgroundColor, text: excerpt.textContent };
    }));
    assert.notDeepEqual([previews[0].background, previews[0].cardBackground], [previews[1].background, previews[1].cardBackground], 'yellow and sage notes keep their distinct color identity');
    assert.match(previews[0].text, /Water mint/); assert.match(previews[0].text, /planting guide/);
    assert.doesNotMatch(previews[0].text, /\*\*|_basil_|\]\(https:|^# /); assert.doesNotMatch(previews[1].text, /- \[[ x]\]/);
    assert.match(previews[2].text, /seed_list/); assert.match(previews[2].text, /_literal_/, 'code and identifier underscores remain content');
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('scene2/3 dark selected controls and moving-block labels retain readable contrast', async () => {
  const page = await mount({ theme: 'dark' }); try {
    await select(page, [2,5]); const samples = [{ name: 'selection icon', minimum: 3, ...await contrast(page, '[data-group-selection-mode]') }];
    await hold(page); samples.push({ name: 'moving block label', minimum: 4.5, ...await contrast(page, '[data-group-drag-proxy]') });
    await move(page, await margin(page, 'top')); await page.waitForFunction(() => document.querySelector('.note-group-overview')?.dataset.gestureState === 'exit-dwell');
    samples.push({ name: 'active exit cue', minimum: 4.5, ...await contrast(page, '[data-group-exit]') });
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.click(`${group} [data-group-page="overview"]`); await page.waitForSelector(overview);
    await select(page, [2,5]); await action(page, 'remove');
    samples.push({ name: 'selected result choice', minimum: 4.5, ...await contrast(page, '.note-group-overview__choices label:has(:checked)') });
    samples.push({ name: 'placement preview label', minimum: 4.5, ...await contrast(page, '[data-group-placement]') });
    assert.ok(samples.every(sample => sample.ratio >= sample.minimum), JSON.stringify(samples));
    assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const edge of ['top', 'side', 'top-space']) test(`scene3 ${edge} open margin dwell retains the same captured pointer until the intentional drop`, async () => {
  const page = await mount({ touch: edge === 'side' }), cdp = edge === 'side' ? await page.createCDPSession() : null; try {
    const pointer = await hold(page, 2, cdp);
    assert.equal(await page.evaluate(pointer => document.querySelector('.notes-page').hasPointerCapture(pointer), pointer), true);
    await exitToCanvas(page, { edge, cdp });
    assert.equal(await page.evaluate(pointer => document.querySelector('.notes-page').hasPointerCapture(pointer), pointer), true, 'the existing host retains capture after the portal hides');
    await move(page, await dropPoint(page), cdp); assert.equal(writes.length, 0);
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); else await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'extract'); assert.deepEqual(writes[0].body.selected_ids, [2]);
    assert.equal(writes[0].body.placements[0].position_locked, false);
    assert.equal(await page.evaluate(pointer => document.querySelector('.notes-page').hasPointerCapture(pointer), pointer), false);
  } finally { await cdp?.detach(); await page.close(); }
});

test('scene3 a gap inside the page grid remains a reorder target instead of an exit area', async () => {
  const page = await mount(); try {
    await hold(page);
    const gap = await page.$eval('.note-group-overview__grid', element => {
      const [a, b] = [...element.querySelectorAll('[data-group-page]')].slice(0, 2).map(card => card.getBoundingClientRect());
      return { x: (a.right + b.left) / 2, y: (a.top + a.bottom) / 2 };
    });
    await move(page, gap); await page.evaluate(() => { window.gapStarted = performance.now(); });
    await page.waitForFunction(() => performance.now() - window.gapStarted >= 1100);
    assert.equal(await page.$eval(overview, element => element.hidden), false);
    assert.notEqual(await page.$eval(overview, element => element.dataset.gestureState), 'exit-dwell');
    await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

test('scene3 selected block proxy remains visible after exit and Cancel restores selection without writes', async () => {
  const page = await mount({ width: 752, height: 835, theme: 'dark' }); try {
    await select(page, [9,2,7,5]); const pointer = await hold(page);
    assert.equal(await visible(page, '[data-group-drag-proxy]'), 1); await assertProxy(page, [2,5,7,9]);
    await exitToCanvas(page, { capture: true });
    assert.equal(await visible(page, '[data-group-drag-proxy]'), 1); await assertProxy(page, [2,5,7,9]); await screenshot(page, '752-dark-after-exit-proxy');
    assert.equal(await page.$eval('[data-group-drag-proxy]', element => getComputedStyle(element).pointerEvents), 'none');
    assert.equal(await page.evaluate(pointer => document.querySelector('.notes-page').hasPointerCapture(pointer), pointer), true);
    await move(page, await dropPoint(page)); await page.mouse.up();
    await page.waitForSelector('[data-group-place-dialog]');
    assert.equal(await visible(page, '[data-group-drag-proxy]'), 0); assert.equal(writes.length, 0);
    await page.click('[data-group-cancel]'); assert.equal(writes.length, 0);
    assert.deepEqual(await page.$$eval('[data-group-select][aria-pressed="true"]', elements => elements.map(element => Number(element.dataset.groupSelect))), [2,5,7,9]);
  } finally { await page.close(); }
});

for (const result of ['group', 'individual']) test(`scene3 compact ${result} choice confirms exactly its visible fractional placement preview`, async () => {
  const page = await mount(); try {
    await select(page, [5,2]); await action(page, 'remove');
    assert.equal(await visible(page, '[data-group-place-dialog]'), 1, 'extraction uses a compact placement surface');
    assert.equal(await visible(page, `${overview} [data-group-page]`), 0, 'the full overview grid is out of the placement decision');
    assert.equal(await visible(page, '[data-group-extract-choice="group"]'), 1); assert.equal(await visible(page, '[data-group-extract-choice="individual"]'), 1);
    assert.equal(await visible(page, '[data-group-x],[data-group-y]'), 0, 'coordinates are a secondary position control');
    await page.click(`[data-group-extract-choice="${result}"]`);
    await page.click('[data-group-position] summary');
    await page.evaluate(() => {
      for (const [selector, value] of [['[data-group-x]', '20.25'], ['[data-group-y]', '15.125']]) {
        const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const preview = await page.$$eval('[data-group-placement]', elements => elements.map(element => JSON.parse(element.dataset.groupPlacement)));
    assert.equal(preview.length, result === 'group' ? 1 : 2); assert.equal(writes.length, 0);
    assert.equal(preview[0].x, 20.25); assert.equal(preview[0].y, 15.125);
    assert.ok(preview.every(rect => !rect.position_locked && rect.always_on_top && rect.width === 4 && rect.height === 6 && rect.x >= 0 && rect.y >= 0 && rect.x <= 10000 && rect.y <= 10000));
    await assertControlsInside(page, '[data-group-confirm],[data-group-cancel]');
    await page.click('[data-group-confirm]'); await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(writes.length, 1); assert.equal(writes[0].body.kind, 'extract'); assert.equal(writes[0].body.result, result);
    assert.deepEqual(writes[0].body.selected_ids, [2,5]); assert.deepEqual(writes[0].body.placements, preview);
  } finally { await page.close(); }
});

for (const cancellation of ['capture-loss', 'pointercancel', 'authentication']) test(`scene3 ${cancellation} removes the drag preview and cannot submit on release`, async () => {
  const page = await mount({ width: 752, touch: true }), cdp = await page.createCDPSession(); try {
    await select(page, [2,5]); const pointer = await hold(page, 2, cdp);
    if (cancellation === 'capture-loss') await page.evaluate(pointer => document.querySelector('.notes-page').releasePointerCapture(pointer), pointer);
    else if (cancellation === 'pointercancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    else await page.evaluate(() => window.dispatchEvent(new Event('auth:expired')));
    if (cancellation !== 'pointercancel') await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await frame(page);
    assert.equal(writes.length, 0); assert.equal(await visible(page, '[data-group-drag-proxy]'), 0);
    assert.equal(await page.evaluate(pointer => !!document.querySelector('.notes-page')?.hasPointerCapture(pointer), pointer), false);
    if (cancellation === 'authentication') { assert.equal(await page.$(overview), null); assert.equal(await page.evaluate(() => document.body.textContent.includes('Water mint')), false); }
    else assert.equal(await page.$('.note-modal'), null, 'cancelled drag must not turn into a page activation');
  } finally { await cdp.detach(); await page.close(); }
});

test('scene3 reduced motion keeps a visible static proxy and Escape cancels after exit', async () => {
  const page = await mount({ reduced: true }); try {
    await select(page, [2,5]); await hold(page);
    assert.equal(await visible(page, '[data-group-drag-proxy]'), 1);
    const motion = await page.$$eval(`${overview},[data-group-drag-proxy]`, elements => elements.map(element => ({ animation: getComputedStyle(element).animationDuration, transition: getComputedStyle(element).transitionDuration })));
    assert.ok(motion.every(style => style.animation.split(',').every(value => parseFloat(value) === 0) && style.transition.split(',').every(value => parseFloat(value) === 0)));
    await exitToCanvas(page); await page.keyboard.press('Escape'); await page.mouse.up(); await frame(page);
    assert.equal(writes.length, 0); assert.equal(await visible(page, '[data-group-drag-proxy]'), 0);
  } finally { await page.close(); }
});

test('scene2 browse-only projection offers page activation without structural selection', async () => {
  const page = await mount({ canManage: false }); try {
    assert.equal(await visible(page, '[data-group-selection-mode],[data-group-select],[data-group-menu]'), 0);
    await page.click('[data-group-activate="2"]'); await page.waitForFunction(() => !document.querySelector('.note-group-overview'));
    assert.equal(await page.$eval(group, element => Number(element.dataset.id)), 2); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});

for (const scenario of [
  { name: '752-dark', width: 752, height: 835, theme: 'dark' },
  { name: '752-dark-two-notes', width: 752, height: 835, theme: 'dark', count: 2 },
  { name: '1280-light', width: 1280, height: 800 },
  { name: '390-phone', width: 390, height: 844 },
  { name: '320-rtl-200', width: 320, height: 720, rtl: true, textScale: 2 },
  { name: '844-short', width: 844, height: 390 },
]) test(`scene2/3 controls and preview remain reachable in ${scenario.name}`, async () => {
  const page = await mount(scenario); try {
    await screenshot(page, `${scenario.name}-initial`);
    await select(page, scenario.count === 2 ? [1,2] : [2,5]);
    await assertControlsInside(page, '[data-group-close],[data-group-selection-mode],[data-group-menu] summary');
    const bounds = await page.$eval(panel, element => { const rect = element.getBoundingClientRect(); return { ...rect.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth }; });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewportWidth + 1 && bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight + 1 && bounds.documentWidth <= bounds.viewportWidth + 1, JSON.stringify(bounds));
    await screenshot(page, `${scenario.name}-selected`);
    if (scenario.width === 320) {
      await page.$eval('[data-group-activate="10"]', element => element.scrollIntoView({ block: 'nearest' }));
      await screenshot(page, `${scenario.name}-long-title`);
    }
    await action(page, 'remove'); assert.equal(await visible(page, '[data-group-place-dialog]'), 1);
    await page.click('[data-group-extract-choice="individual"]');
    await assertControlsInside(page, '[data-group-confirm],[data-group-cancel]');
    assert.equal(await visible(page, '[data-group-placement]'), 2); await screenshot(page, `${scenario.name}-place`);
    await page.click('[data-group-cancel]'); assert.equal(writes.length, 0);
  } finally { await page.close(); }
});
