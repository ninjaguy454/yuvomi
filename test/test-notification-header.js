import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Exercise the actual shell adoption/observer functions with real inbox, modal,
// localization and privacy modules. Only unrelated toolbar setup and API data
// are fixture boundaries; no production account or notification is touched.
const router = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
const dashboardOverview = dashboardSource.slice(dashboardSource.indexOf('function renderDashboardOverview('), dashboardSource.indexOf('function widgetSizeClass('));
assert.ok(dashboardOverview.includes('dashboard-customize-scope'));
const adoption = router.slice(router.indexOf('function notificationHeaderButton()'), router.indexOf('// System-/Utility-Zeilen'));
const observer = router.slice(router.indexOf('function wirePageToolbars()'), router.indexOf('/** FAB der alten Seite'));
assert.ok(adoption.includes('function adoptNotificationHeader()') && observer.includes('new MutationObserver'));
const styles = [...readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').matchAll(/<link rel="stylesheet" href="[^"]+"\s*\/>/g)].map(([tag]) => tag).join('');
const mainMarkup = '<div class="page-transition"><header class="page-toolbar"><h1 class="page-toolbar__title">Tasks</h1><div class="page-toolbar__actions"><button class="btn btn--secondary">Filter</button></div></header></div>';
const item = (id = 1) => ({ id, title: `Personal Task ${id}`, body: 'Household test notice', category: 'tasks', url: `/tasks?open=${id}`, created_at: '2026-09-08 12:00:00', read_at: null });
let inbox, calls, holdNext, held = [];
const app = express();
app.use(express.json());
app.use('/api/v1', (req, res) => {
  calls.push({ method: req.method, path: req.path });
  if (req.path === '/notifications/inbox' && req.method === 'GET') {
    const response = structuredClone(inbox);
    if (holdNext) { holdNext = false; held.push(() => res.json({ data: response })); return; }
    return res.json({ data: response });
  }
  if (req.path.endsWith('/read-all')) {
    inbox = { items: inbox.items.map(entry => ({ ...entry, read_at: '2026-09-08 12:01:00' })), unreadCount: 0 };
    return res.json({ data: inbox });
  }
  return res.json({ data: [] });
});
app.get('/header-fixture.js', (_req, res) => res.type('text/javascript').send(`
  import * as inbox from '/notification-center.js';
  import { openNotificationCenter, paintNotificationBadges } from '/notification-center.js';
  import { t, initI18n, setLocale } from '/i18n.js';
  import { setWallModeEnabled } from '/utils/wall-mode.js';
  import { closeModal } from '/components/modal.js';
  let currentUser = { id: 1, role: 'admin' };
  let _toolbarObserverRoot = null;
  function wireToolbar() {}
  function unwireToolbar() {}
  const mastheadDateLabel = () => 'Tuesday, September 8';
  const greetingPeriod = () => 'evening';
  const greeting = name => 'Good evening, ' + name;
  const mastheadWeatherHtml = () => '';
  const formatTime = () => '19:30';
  const esc = value => String(value);
  ${dashboardOverview}
  ${adoption}
  ${observer}
  await initI18n(); await setLocale('en');
  window.visits = [];
  window.yuvomi = { user: currentUser, navigate: url => window.visits.push(url) };
  window.headerFixture = {
    inbox, setWallModeEnabled, closeModal,
    async setUser(user) {
      inbox.stop(); currentUser = user; window.yuvomi.user = user;
      if (user && user.access_scope !== 'split_guest') { inbox.init(); await inbox.refresh(); }
      adoptNotificationHeader();
    },
    replace(markup) { document.querySelector('#main-content').innerHTML = markup; },
    async locale(value) { await setLocale(value); adoptNotificationHeader(); paintNotificationBadges(); },
    adopt: adoptNotificationHeader,
    dashboard(scope) { return renderDashboardOverview({display_name:'Alexandra and Christopher'}, true, null, null, scope); },
  };
  wirePageToolbars(); inbox.init(); await inbox.refresh();
  window.initialBell = document.querySelector('[data-notification-center]');
  window.ready = true;
`));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/header-fixture', (_req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1">${styles}
  <link rel="stylesheet" href="/styles/settings.css">
  <link rel="stylesheet" href="/styles/dashboard.css">
  <link rel="stylesheet" href="/styles/reminders.css">
  </head><body><main id="main-content">${mainMarkup}</main>
  <script type="module" src="/header-fixture.js"></script></body></html>`));
let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox'] });
});
test.after(async () => {
  held.splice(0).forEach(release => release());
  await browser?.close();
  await new Promise(resolve => server?.close(resolve) || resolve());
});
async function mount(width = 1366) {
  inbox = { items: [item()], unreadCount: 3 }; calls = []; holdNext = false; held = [];
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.setViewport({ width, height: width === 390 ? 844 : 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${base}/header-fixture`);
  await page.waitForFunction(() => window.ready);
  return page;
}
async function replace(page, markup, selector) {
  await page.evaluate(value => window.headerFixture.replace(value), markup);
  await page.waitForFunction(value => document.querySelector(`${value} > [data-notification-center]`), {}, selector);
}
async function waitHeld(page) { await page.waitForFunction(() => document.querySelector('[data-inbox-refresh]')?.disabled); }

test('one canonical bell follows module, Settings and fallback replacements without extra inbox requests', async () => {
  const page = await mount();
  try {
    const requests = calls.length;
    await page.$eval('[data-notification-center]', el => { el.title = 'Previous locale'; });
    for (const name of ['dashboard-overview__header', 'settings-leaf-header', 'settings-shell-header', 'kitchen-tabs-bar', 'page__header']) {
      await replace(page, `<div class="page-transition"><header class="${name}"><h1>Module</h1></header></div>`, `.${name}`);
      assert.equal(await page.evaluate(() => document.querySelector('[data-notification-center]') === window.initialBell), true);
      assert.equal(await page.$$eval('[data-notification-center]', nodes => nodes.length), 1);
      assert.equal(await page.$eval('.reminder-bell-badge', el => el.textContent), '3');
      assert.equal(await page.$eval('[data-notification-center]', el => el.title), 'Notifications');
    }
    await replace(page, '<div class="page-transition"><p>Loading a module</p></div>', '.notification-header-fallback');
    await replace(page, `<header class="page-toolbar" hidden><h1>Hidden</h1></header><header class="page__header"><h1>Visible</h1></header>`, '.page__header');
    assert.equal(await page.$('.notification-header-fallback'), null);
    assert.equal(calls.length, requests, 'moving the same bell must not refetch notification history');
    await page.click('[data-notification-center]');
    await page.waitForSelector('.notification-center__item');
    assert.match(await page.$eval('.notification-center', el => el.innerText), /Personal Task 1/);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('guest and signed-out shells remove the bell and another user receives fresh history', async () => {
  const page = await mount();
  try {
    for (const user of [null, { id: 9, access_scope: 'split_guest' }]) {
      await page.evaluate(value => window.headerFixture.setUser(value), user);
      assert.equal(await page.$('[data-notification-center]'), null);
    }
    inbox = { items: [item(2)], unreadCount: 1 };
    await page.evaluate(() => window.headerFixture.setUser({ id: 2, role: 'member' }));
    assert.equal(await page.$eval('.reminder-bell-badge', el => el.textContent), '1');
    await page.click('[data-notification-center]');
    await page.waitForSelector('.notification-center__item');
    const content = await page.$eval('.notification-center', el => el.innerText);
    assert.match(content, /Personal Task 2/);
    assert.doesNotMatch(content, /Personal Task 1/);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('wall mode clears an open personal inbox, hides the bell and prevents background hydration', async () => {
  const page = await mount();
  try {
    await page.click('[data-notification-center]');
    await page.waitForSelector('.notification-center__item');
    await page.evaluate(() => window.headerFixture.setWallModeEnabled(true));
    await page.waitForFunction(() => !document.querySelector('.notification-center'));
    assert.equal(await page.$eval('[data-notification-center]', el => el.hidden), true);
    assert.equal(await page.$eval('.reminder-bell-badge', el => el.hidden), true);
    const requests = calls.length;
    await page.evaluate(async () => { await window.headerFixture.inbox.refresh(); await window.headerFixture.inbox.openNotificationCenter(); });
    assert.equal(calls.length, requests);
    assert.equal(await page.$('.notification-center'), null);
    inbox = { items: [item(4)], unreadCount: 2 };
    await page.evaluate(async () => { window.headerFixture.setWallModeEnabled(false); await window.headerFixture.inbox.refresh(); });
    assert.equal(await page.$eval('[data-notification-center]', el => el.hidden), false);
    assert.equal(await page.$eval('.reminder-bell-badge', el => el.textContent), '2');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('icon-only inbox Refresh stays labelled, disables pending clicks and preserves unread actions', async () => {
  const page = await mount();
  try {
    await page.click('[data-notification-center]');
    await page.waitForSelector('.notification-center__item');
    const button = '[data-inbox-refresh]';
    assert.deepEqual(await page.$eval(button, el => ({ label: el.getAttribute('aria-label'), title: el.title, text: el.textContent.trim(), icon: el.querySelector('[data-lucide]')?.dataset.lucide, iconButton: el.classList.contains('btn--icon') })),
      { label: 'Refresh', title: 'Refresh', text: '', icon: 'refresh-cw', iconButton: true });
    holdNext = true;
    const before = calls.length;
    await page.click(button); await waitHeld(page);
    await page.click(button);
    assert.equal(calls.length, before + 1);
    assert.equal(held.length, 1);
    held.splice(0).forEach(release => release());
    await page.waitForFunction(() => !document.querySelector('[data-inbox-refresh]').disabled);
    await page.click('[data-inbox-read-all]');
    await page.waitForFunction(() => document.querySelector('.reminder-bell-badge').hidden);
    assert.equal(await page.$eval('[data-inbox-read-all]', el => el.disabled), true);
    assert.equal(await page.$eval('[data-notification-center]', el => el.getAttribute('aria-label')), 'Notifications');
    assert.deepEqual(page.errors, []);
  } finally { held.splice(0).forEach(release => release()); await page.close(); }
});

for (const width of [1366, 768, 390]) {
  test(`Customize keeps its greeting, scope and every action separate at ${width}px`, async () => {
    const page = await mount(width);
    try {
      for (const followsDefault of [true, false]) {
        await page.evaluate(followsDefault => window.headerFixture.replace('<div class="dashboard">'+window.headerFixture.dashboard({followsDefault,canPublish:true})+'</div>'), followsDefault);
        await page.waitForSelector('.dashboard-overview__header > [data-notification-center]');
        const layout = await page.evaluate(() => {
          const rect = selector => { const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          return {heading:rect('.dashboard-overview__heading'),scope:rect('.dashboard-customize-scope'),toolbar:rect('.dashboard-customize-toolbar'),bell:rect('[data-notification-center]'),close:rect('#dashboard-customize-btn'),overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.dashboard-customize-toolbar button')].map(button=>{const r=button.getBoundingClientRect();return{id:button.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};
        });
        assert.equal(layout.overflow,false);
        assert.ok(layout.heading.width>width*0.65,'long greeting retains useful width');
        assert.ok(layout.heading.bottom<=layout.scope.top,'hint does not overlap greeting');
        assert.ok(layout.scope.bottom<=layout.toolbar.top,'scope is above actions');
        assert.ok(Math.abs(layout.heading.left-layout.scope.left)<1);
        assert.ok(layout.bell.left>=layout.heading.right,'bell has its own space');
        assert.equal(layout.buttons.length,followsDefault?3:4,'administrator and reset controls are preserved');
        for(const button of layout.buttons){assert.ok(button.left>=0&&button.right<=width);assert.ok(button.right<=layout.close.left,'close does not cover toolbar');}
        for(let i=0;i<layout.buttons.length;i++) for(let j=i+1;j<layout.buttons.length;j++){
          const a=layout.buttons[i],b=layout.buttons[j];
          assert.ok(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top,'buttons never overlap');
        }
        await page.click('[data-notification-center]');await page.waitForSelector('.notification-center__item');
        await page.evaluate(()=>window.headerFixture.closeModal({force:true}));
        await page.waitForFunction(()=>!document.querySelector('.notification-center'));
      }
      assert.deepEqual(page.errors,[]);
    } finally {await page.close();}
  });

  test(`module-header bell is a visible labelled target inside the viewport at ${width}px`, async () => {
    const page = await mount(width);
    try {
      const dimensions = await page.$eval('[data-notification-center]', el => {
        const box = el.getBoundingClientRect();
        return { hidden: el.hidden, width: box.width, height: box.height, right: box.right, left: box.left, label: el.getAttribute('aria-label'), popup: el.getAttribute('aria-haspopup'), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(dimensions.hidden, false);
      assert.ok(dimensions.width >= 40 && dimensions.height >= 40);
      assert.ok(dimensions.left >= 0 && dimensions.right <= width);
      assert.match(dimensions.label, /3/);
      assert.equal(dimensions.popup, 'dialog');
      assert.equal(dimensions.overflow, false);
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  });
}
