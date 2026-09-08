import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Actual module renderers, shell styles, header adoption and collapse wiring.
// API responses are synthetic; this fixture never uses a household database.
const members = [{ id: 1, display_name: 'Taylor Household', role: 'admin' }, { id: 2, display_name: 'Another household member' }];
const dishes = ['Breakfast with fresh fruit', 'Soup and freshly baked bread', 'Roasted vegetables with pasta', 'A snack for later'];
const occurrences = Array.from({ length: 28 }, (_, index) => ({
  id: index + 1, date: `2026-08-${String(3 + Math.floor(index / 4)).padStart(2, '0')}`,
  meal_type: ['breakfast', 'lunch', 'dinner', 'snack'][index % 4],
  title: dishes[index % 4], chooser: members[0], chooser_status: 'selected',
  context: { name: 'Home', type: 'home' }, participants: [],
}));
const recipes = Array.from({ length: 18 }, (_, index) => ({ id: index + 1, title: `Recipe ${index + 1} with roasted vegetables`, notes: 'Prepare and serve.', ingredients: [{ name: 'Vegetables', quantity: '1 cup' }], source: 'native', meal_types: ['dinner'] }));
const items = Array.from({ length: 28 }, (_, index) => ({ id: index + 1, name: `Vegetables ${index + 1}`, quantity: 2, unit: 'kg', category: 'Other', is_checked: false }));
const list = { id: 1, name: 'Household shopping', item_count: items.length, unchecked_count: items.length };
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const adoption = router.slice(router.indexOf('function notificationHeaderButton()'), router.indexOf('// System-/Utility-Zeilen'));
assert.ok(adoption.includes('function adoptNotificationHeader()'));
const app = express();
app.use('/api/v1', (req, res) => {
  if (req.path === '/preferences') return res.json({ data: { language: 'en', date_format: 'mdy' } });
  if (req.path === '/meals/planning') return res.json({ data: { members, timing_defaults: [], slots: [] } });
  if (['/meals/week-model', '/meals/status'].includes(req.path)) return res.json({ data: { members, selected_member_id: 1, contexts: [{ id: 1, name: 'Sam and Jamie family vacation', type: 'travel' }], occurrences } });
  if (req.path === '/meals') return res.json({ data: occurrences });
  if (req.path === '/recipes') return res.json({ data: recipes });
  if (req.path === '/shopping') return res.json({ data: [list] });
  if (req.path === '/shopping/1/items') return res.json({ data: items, list });
  if (req.path === '/pantry') return res.json({ data: items, locations: [], categories: [] });
  return res.json({ data: [] });
});
app.get('/mobile-kitchen-fixture.js', (_req, res) => res.type('text/javascript').send(`
  import { t, initI18n, setLocale } from '/i18n.js';
  import { wireCollapsingHeader } from '/utils/ux.js';
  import { rememberScrollPosition, scrollPositionFor } from '/utils/scroll-restore.js';
  import { openNotificationCenter, paintNotificationBadges } from '/notification-center.js';
  const currentUser = { id: 1, role: 'admin' };
  ${adoption}
  await initI18n(); await setLocale('en');
  window.yuvomi = { user: currentUser, navigate() {}, showToast() {}, isModuleDisabled() { return false; } };
  const params = new URLSearchParams(location.search);
  if (params.has('wall')) document.documentElement.dataset.wallMode = 'true';
  let currentModule = null;
  async function mountModule(module, restore = false) {
    const main = document.querySelector('#main-content');
    if (currentModule) rememberScrollPosition('/' + currentModule, main.scrollTop);
    const target = scrollPositionFor('/' + module, { restore });
    const wrapper = document.createElement('div');
    wrapper.id = 'fixture-container'; wrapper.className = 'page-transition page-transition--in-right';
    main.replaceChildren(wrapper); main.scrollTop = 0;
    await (await import('/pages/' + module + '.js')).render(wrapper, { user: currentUser });
    adoptNotificationHeader();
    // Inbox visibility is independent of layout; use the real shell button.
    document.querySelector('[data-notification-center]').hidden = false;
    document.querySelectorAll('.page-toolbar').forEach(toolbar => wireCollapsingHeader(toolbar));
    if (target > 0) main.scrollTop = target;
    currentModule = module; window.fixtureModule = module;
  }
  await mountModule(params.get('module') || 'meals');
  // Reuse the router's existing scroll-position helper and render boundary;
  // no special Kitchen restoration implementation is under test or added.
  window.fixtureNavigate = async module => {
    const url = new URL(location.href); url.searchParams.set('module', module);
    history.pushState({}, '', url); await mountModule(module);
  };
  addEventListener('popstate', () => mountModule(new URLSearchParams(location.search).get('module') || 'meals', true));
  window.fixtureReady = true;
`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/mobile-kitchen-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  ${['meals', 'recipes', 'shopping', 'pantry', 'reminders'].map(name => `<link rel="stylesheet" href="/styles/${name}.css">`).join('')}
  <script src="/lucide.min.js"></script></head><body><div class="app-shell">
  <main class="app-content" id="main-content"><div class="page-transition page-transition--in-right" id="fixture-container"></div></main>
  <nav class="nav-bottom" aria-label="Navigation"><div class="nav-bottom__items"></div></nav>
  <div id="fab-layer"></div></div><script type="module" src="/mobile-kitchen-fixture.js"></script></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });

async function openPage(width, extra = '') {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width, height: 844, hasTouch: width < 1024 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/mobile-kitchen-fixture?week=2026-08-03${extra}`);
  await page.waitForFunction(() => window.fixtureReady);
  return { page, errors };
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function capture(page, name) {
  const requested = process.env.MEALS_LAYOUT_SCREENSHOTS;
  if (!requested || (requested !== '1' && requested !== name)) return;
  const directory = new URL('../artifacts/mobile-kitchen-layout/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, directory)) });
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector), r = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop, overflow: style.overflowY, position: style.position };
    };
    return { main: rect('main'), rail: rect('.kitchen-tabs-bar'), toolbar: rect('.page-toolbar'), filters: rect('.meal-view-bar'), grid: rect('.week-grid'), firstHeader: rect('.meal-experience-day__header'), lastDay: rect('.meal-experience-day:last-child'), bell: rect('[data-notification-center]'), pageOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}

for (const width of [320, 390, 768]) test(`Meals at ${width}px scrolls secondary controls with the page and keeps only Kitchen pinned`, async () => {
  const { page, errors } = await openPage(width);
  try {
    const initial = await geometry(page);
    assert.equal(initial.pageOverflow, false);
    assert.equal(initial.grid.overflow, 'visible');
    assert.ok(initial.main.scrollHeight > initial.main.clientHeight + 500, 'the shell sees the entire week');
    assert.ok(initial.bell.top >= initial.toolbar.top && initial.bell.bottom <= initial.toolbar.bottom, 'bell is anchored to the secondary toolbar');
    const controls = await page.$$eval('#week-prev,#week-next,#week-today,#meal-view-toggle,#meal-plan-manage,#meal-prepare-week', nodes => nodes.map(node => ({ id: node.id, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    controls.forEach(control => assert.ok(control.height >= 48 && control.width >= 48, `${control.id} retains a 48px touch target`));
    const actions = await page.$$eval('.page-toolbar__actions > .btn:not([hidden])', nodes => nodes.filter(node => node.getClientRects().length).map(node => ({ id: node.id, left: node.getBoundingClientRect().left, top: node.getBoundingClientRect().top, width: node.getBoundingClientRect().width })));
    assert.deepEqual(actions.map(action => action.id), ['week-today', 'meal-view-toggle', 'meal-plan-manage', 'meal-prepare-week']);
    if (width >= 768) {
      assert.ok(actions.every(action => Math.abs(action.top - actions[0].top) < 1), `tablet actions share one row: ${JSON.stringify(actions)}`);
    } else {
      assert.ok(Math.abs(actions[0].top - actions[1].top) < 1 && Math.abs(actions[2].top - actions[3].top) < 1, `actions form two balanced rows: ${JSON.stringify(actions)}`);
    }
    assert.ok(Math.abs(actions[0].width - actions[1].width) < 1);
    await capture(page, `meals-${width}-top`);
    for (const offset of [initial.toolbar.top + 20, initial.firstHeader.top + 20, 700]) {
      await page.evaluate(top => document.querySelector('main').scrollTop = top, offset); await settle(page);
      const railIsOnTop = await page.evaluate(() => {
        const rail = document.querySelector('.kitchen-tabs-bar'), r = rail.getBoundingClientRect();
        return [0.2, 0.5, 0.8].every(fraction => rail.contains(document.elementFromPoint(r.left + r.width * fraction, r.top + r.height / 2)));
      });
      assert.equal(railIsOnTop, true, `Kitchen tabs remain clickable above crossing toolbar/day headers at scroll ${offset}`);
    }
    await page.evaluate(() => document.querySelector('main').scrollTop = 700); await settle(page);
    const scrolled = await geometry(page);
    assert.ok(Math.abs(scrolled.rail.top - initial.rail.top) < 1, 'Kitchen banner stays pinned');
    assert.ok(scrolled.toolbar.bottom < scrolled.rail.bottom && scrolled.filters.bottom < scrolled.rail.bottom, 'filters, week navigation and actions scroll away');
    assert.ok(scrolled.firstHeader.bottom < scrolled.rail.bottom, 'individual day headings scroll away');
    assert.ok(scrolled.bell.bottom < scrolled.rail.bottom, 'notification bell travels with its header');
    if (width === 390) await capture(page, 'meals-390-scrolled');
    await page.evaluate(() => document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight); await settle(page);
    const bottom = await geometry(page);
    assert.ok(bottom.lastDay.bottom <= bottom.main.bottom + 1, 'last day clears the navigation and safe zone');
    assert.ok(Math.abs(bottom.rail.top - initial.rail.top) < 1, 'banner remains pinned at the end of the week');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('Meals action grid, filters and selected states fit all six palettes with Serif', async () => {
  const { page, errors } = await openPage(390);
  try {
    for (const colorTheme of ['warm', 'neutral', 'cool']) for (const theme of ['light', 'dark']) {
      await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { colorTheme, theme, typography: 'serif' });
      await settle(page);
      const sizes = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
        return { member: rect('#meal-member-select'), context: rect('#meal-context-select'), week: rect('#week-label'), bell: rect('[data-notification-center]'), overflow: document.documentElement.scrollWidth > innerWidth, background: getComputedStyle(document.querySelector('.meal-experience-day')).backgroundColor };
      });
      assert.equal(sizes.overflow, false, `${colorTheme}/${theme}`);
      assert.ok(Math.abs(sizes.member.top - sizes.context.top) < 1 && Math.abs(sizes.member.height - sizes.context.height) < 1, 'side-by-side selectors align');
      assert.ok(Math.abs((sizes.member.right - sizes.member.left) - (sizes.context.right - sizes.context.left)) < 1, 'selectors share the available width evenly');
      assert.ok(sizes.week.right <= sizes.bell.left, 'full week range does not overlap the bell');
      assert.notEqual(sizes.background, 'rgba(0, 0, 0, 0)');
      await capture(page, `meals-390-${colorTheme}-${theme}-serif`);
    }
    await page.evaluate(() => document.querySelector('#meal-choice-requests').hidden = false); await settle(page);
    const pending = await page.$eval('#meal-choice-requests', node => ({ width: node.getBoundingClientRect().width, rowWidth: node.parentElement.getBoundingClientRect().width }));
    assert.ok(Math.abs(pending.width - pending.rowWidth) < 1, 'pending requests get a full row without overflowing');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [1024, 1366]) test(`desktop Meals at ${width}px retains the inner week board`, async () => {
  const { page, errors } = await openPage(width);
  try {
    const before = await geometry(page);
    assert.equal(before.pageOverflow, false);
    assert.equal(before.grid.overflow, 'auto');
    assert.ok(before.grid.scrollHeight > before.grid.clientHeight, 'populated desktop board has its own vertical scroll');
    await page.evaluate(() => document.querySelector('.week-grid').scrollTop = 400); await settle(page);
    const after = await geometry(page);
    assert.ok(after.grid.scrollTop > 0);
    assert.equal(after.main.scrollTop, 0);
    assert.ok(Math.abs(before.toolbar.top - after.toolbar.top) < 1);
    await capture(page, `meals-${width}-desktop`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('wall Meals retains its established inner board and header layout', async () => {
  const { page, errors } = await openPage(768, '&wall');
  try { assert.equal((await geometry(page)).grid.overflow, 'auto'); assert.deepEqual(errors, []); }
  finally { await page.close(); }
});

test('changing viewport size preserves Meals scroll roles without remounting', async () => {
  const { page, errors } = await openPage(1366);
  try {
    for (const width of [390, 768, 1366]) {
      // Keep input modality fixed: Puppeteer reloads the document when hasTouch
      // changes, which would not exercise an actual viewport-only resize.
      await page.setViewport({ width, height: 844, hasTouch: false }); await settle(page);
      const sizes = await geometry(page);
      assert.equal(sizes.pageOverflow, false);
      assert.equal(sizes.grid.overflow, width < 1024 ? 'visible' : 'auto');
      assert.equal(await page.$$eval('.meal-experience-day', days => days.length), 7);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('mobile Timeline remains accessible through the compact action grid', async () => {
  const { page, errors } = await openPage(390);
  try {
    await page.click('#meal-view-toggle');
    await page.waitForSelector('.week-grid.meal-timeline');
    const before = await page.$eval('.week-grid', node => ({ overflow: getComputedStyle(node).overflowY, count: node.querySelectorAll('.meal-timeline__day').length }));
    assert.equal(before.overflow, 'visible'); assert.equal(before.count, 7);
    assert.match(page.url(), /layout=timeline/);
    await page.evaluate(() => document.querySelector('main').scrollTop = 500); await settle(page);
    const scrolled = await page.evaluate(() => ({ rail: document.querySelector('.kitchen-tabs-bar').getBoundingClientRect().top, toolbar: document.querySelector('.page-toolbar').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(scrolled.rail) < 1 && scrolled.toolbar < 56);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('mobile Kitchen page scroll is restored by the existing back-navigation helper', async () => {
  const { page, errors } = await openPage(390);
  try {
    await page.evaluate(() => document.querySelector('main').scrollTop = 720); await settle(page);
    const remembered = await page.$eval('main', node => node.scrollTop);
    await page.evaluate(() => window.fixtureNavigate('recipes'));
    assert.equal(await page.$eval('main', node => node.scrollTop), 0, 'forward navigation starts at the top');
    await page.goBack(); await page.waitForFunction(() => window.fixtureModule === 'meals'); await settle(page);
    assert.ok(Math.abs(await page.$eval('main', node => node.scrollTop) - remembered) < 1, 'Back restores the actual Meals page position');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const module of ['recipes', 'shopping', 'pantry']) test(`mobile ${module} uses the same Kitchen banner and page scroll`, async () => {
  const { page, errors } = await openPage(390, `&module=${module}`);
  try {
    const measure = () => page.evaluate(() => {
      const main = document.querySelector('main'), rail = document.querySelector('.kitchen-tabs-bar'), list = document.querySelector('.list-scroller');
      return { mainBottom: main.getBoundingClientRect().bottom, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, top: main.scrollTop, railTop: rail.getBoundingClientRect().top, listBottom: list.getBoundingClientRect().bottom, listOverflow: getComputedStyle(list).overflowY, pageOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    const before = await measure();
    assert.equal(before.pageOverflow, false);
    assert.equal(before.listOverflow, 'visible');
    assert.ok(before.scrollHeight > before.clientHeight + 500);
    await page.evaluate(() => document.querySelector('main').scrollTop = 600); await settle(page);
    const during = await measure();
    assert.ok(during.top >= 600);
    assert.ok(Math.abs(during.railTop - before.railTop) < 1);
    await page.evaluate(() => document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight); await settle(page);
    const bottom = await measure();
    assert.ok(bottom.listBottom <= bottom.mainBottom + 1, 'last row and padding remain reachable');
    await capture(page, `${module}-390-last-row`);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
