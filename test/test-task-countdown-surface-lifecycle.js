import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import puppeteer from 'puppeteer';

// Mount the real pages against an isolated HTTP data fixture. Clock control is
// limited to the countdown timer so unrelated polling cannot refresh the label.
const task = { id: 1, title: 'Timed household task', status: 'open', priority: 'none',
  countdown: 1, due_date: '2026-10-05', due_time: '12:02', revision: 1,
  assigned_to: 1, assigned_name: 'Alex', assigned_users: [{ id: 1, display_name: 'Alex' }],
  points: 0, subtasks: [], tags: [], permissions: { view: true, complete: true } };
const user = { id: 1, display_name: 'Alex', role: 'admin' };
const wallConfig = { widgets: [{ id: 'tasks', visible: true, size: 'large', order: 0 }],
  appearance: { theme: 'light', palette: 'warm', font: 'default', density: 'comfortable', clock: false },
  interaction: { mode: 'read_only', actions: [] },
  privacy: { notifications: 'hidden', showPoints: false, showPresence: false } };
const dashboard = { urgentTasks: [task], upcomingEvents: [], todayMeals: [], shoppingLists: [],
  pinnedNotes: [], birthdays: [], countdowns: [], users: [user], budget: {}, rewards: {}, health: {}, housekeeping: {} };
const app = express();
const publicRoot = new URL('../public/', import.meta.url);
const baseStyles = [...readFileSync(new URL('index.html', publicRoot), 'utf8')
  .matchAll(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g)].map(match => match[0]).join('');
app.use(express.json());
app.use(express.static(fileURLToPath(publicRoot)));
app.get('/countdown-surface-test', (req, res) => res.send(`<!doctype html><html lang="en"><head>
  <meta name="viewport" content="width=device-width,initial-scale=1"><script src="/lucide.min.js"></script>
  ${req.query.styled === '1' ? `${baseStyles}<link rel="stylesheet" href="/styles/calendar.css">
    <style>html,body{height:100%;margin:0}#main-content{height:100dvh;padding:16px;display:flex;flex-direction:column;min-width:0}
      *,*::before,*::after{animation:none!important;transition:none!important}</style>` : ''}
  </head><body><main id="main-content"></main></body></html>`));
app.use('/api/v1', (req, res) => {
  if (req.path === '/auth/me') return res.json({ user, permissions: { admin: true }, csrfToken: 'fixture' });
  if (req.path === '/auth/users') return res.json({ data: [user] });
  if (req.path === '/tasks') return res.json({ data: [{ ...task, ...(req.get('x-countdown-long-title') ? {
    title: 'Prepare school bags and sports clothes, check every homework folder, and make sure the whole household is ready to leave together',
  } : {}) }] });
  if (req.path === '/planning/routines/entries') return res.json({ data: { entries: [], warnings: [] } });
  if (req.path === '/dashboard') return res.json(dashboard);
  if (req.path === '/weather') return res.json({ data: null });
  if (req.path === '/preferences') return res.json({ data: { dashboard_today_glance: false,
    dashboard_widgets: [{ id: 'tasks', visible: true, size: 'large' }] } });
  if (req.path === '/wall/enter') return res.json({ data: {} });
  if (req.path === '/wall/config') return res.json({ data: { config: wallConfig, defaults: wallConfig, supportedActions: [] } });
  if (req.path === '/wall/dashboard') return res.json({ data: { ...dashboard, config: wallConfig,
    timezone: 'UTC', today: '2026-10-05', notification: { mode: 'hidden' } } });
  return res.json({ data: [] });
});

let server, browser, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await puppeteer.launch({ headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(edge) ? edge : undefined),
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
test.after(async () => {
  await browser?.close();server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve) || resolve());
});

async function mount(surface, { width = 1100, view = null, styled = false, longTitle = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.setViewport({ width, height: 900 });
  if (longTitle) await page.setExtraHTTPHeaders({ 'x-countdown-long-title': '1' });
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.goto(`${base}/countdown-surface-test${styled ? '?styled=1' : ''}`);
  await page.evaluate(async ({ surface, user, view }) => {
    localStorage.clear();localStorage.setItem('yuvomi-locale', 'en');
    if (view) localStorage.setItem('yuvomi:calendar:view', view);
    window.yuvomi = { showToast() {}, isModuleDisabled: () => false };
    window.EventSource = class {
      constructor() { this.readyState = 1; }
      addEventListener() {}
      close() { this.readyState = 2; }
    };
    const NativeDate = Date;
    window.testNow = NativeDate.parse('2026-10-05T12:00:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.testNow])); }
      static now() { return window.testNow; }
    };
    // Track resources by their owning module, without replacing its renderer,
    // binder, DOM operations, or callbacks with test doubles.
    const timers = new Map(), hooks = [];
    let timerId = -1;
    const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout;
    window.setTimeout = function(callback, delay, ...args) {
      if (!new Error().stack.includes('/utils/task-countdown.js')) return nativeTimeout(callback, delay, ...args);
      const id = timerId--;timers.set(id, () => callback(...args));return id;
    };
    window.clearTimeout = function(id) { timers.delete(id);nativeClear(id); };
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (new Error().stack.includes('/utils/task-countdown.js')) hooks.push({ target: this, type, listener });
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      const index = hooks.findIndex(hook => hook.target === this && hook.type === type && hook.listener === listener);
      if (index !== -1) hooks.splice(index, 1);
      return remove.call(this, type, listener, options);
    };
    window.countdownResources = () => ({ timers: timers.size, hooks: hooks.map(hook => hook.type).sort() });
    window.advanceCountdown = minutes => {
      window.testNow += minutes * 60_000;
      const pending = [...timers.values()];timers.clear();pending.forEach(callback => callback());
    };
    await (await import('/i18n.js')).initI18n();
    (await import('/permissions.js')).setPermissions({ admin: true });
    (await import('/utils/timezone.js')).setDisplayTimeZone('UTC');
    if (surface === 'wall') {
      localStorage.setItem('yuvomi-wall-mode', '1');
      document.documentElement.setAttribute('data-wall-mode', '');
    }
    const module = await import(surface === 'calendar' ? '/pages/calendar.js' : '/pages/dashboard.js');
    const container = document.getElementById('main-content');
    window.mountSurface = () => module.render(container, { user });
    window.disposeSurface = await window.mountSurface();
  }, { surface, user, view });
  await page.waitForSelector(surface === 'wall' ? '[data-wall-grid]' : surface === 'calendar' ? '#cal-body' : '#dashboard-shell');
  await page.waitForSelector('[data-task-countdown]', { visible: true });
  return page;
}

for (const surface of ['dashboard', 'calendar', 'wall']) {
  test(`${surface} keeps mounted Task countdowns current and releases their resources on disposal`, async () => {
    const page = await mount(surface);
    try {
      const before = await page.$eval('[data-task-countdown]', element => element.textContent);
      await page.evaluate(() => { window.initialCountdown = document.querySelector('[data-task-countdown]'); });
      await page.evaluate(() => window.advanceCountdown(1));
      const after = await page.$eval('[data-task-countdown]', element => element.textContent);
      assert.notEqual(after, before, 'the existing label must refresh as a minute elapses without fetching or rerendering');
      assert.match(after, /1/, 'the two-minute deadline now has one minute remaining');
      assert.equal(await page.evaluate(() => window.initialCountdown === document.querySelector('[data-task-countdown]')), true,
        'clock ticks update the existing label in place');
      const resources = await page.evaluate(() => window.countdownResources());
      assert.deepEqual(resources, { timers: 1, hooks: ['focus', 'pageshow', 'visibilitychange'] });

      await page.evaluate(async () => {
        window.originalDisposeSurface = window.disposeSurface;
        window.disposeSurface = await window.mountSurface();
      });
      assert.deepEqual(await page.evaluate(() => window.countdownResources()), resources,
        'rendering the surface again replaces its countdown subscription instead of accumulating one');
      assert.equal(await page.evaluate(() => typeof window.disposeSurface), 'function');
      await page.evaluate(surface => {
        // The router retains the first disposer while these pages rerender
        // internally. Wall has its own mount/dispose cycle.
        if (surface === 'wall') window.disposeSurface();
        else window.originalDisposeSurface();
      }, surface);
      assert.deepEqual(await page.evaluate(() => window.countdownResources()), { timers: 0, hooks: [] });
      const stopped = await page.$eval('[data-task-countdown]', element => element.textContent);
      await page.evaluate(() => {
        window.advanceCountdown(3);
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('pageshow'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(await page.$eval('[data-task-countdown]', element => element.textContent), stopped,
        'disposed surfaces cannot update through either timer or wake listeners');
      assert.deepEqual(page.errors, []);
    } finally { await page.close(); }
  });
}

for (const [width, view] of [[390, 'agenda'], [390, 'day'], [1280, 'month']]) {
  test(`Calendar ${view} keeps the complete countdown visible beside a long task title at ${width}px`, async () => {
    const page = await mount('calendar', { width, view, styled: true, longTitle: true });
    try {
      await page.evaluate(() => document.fonts.ready);
      const bounds = await page.$eval('.cal-task-chip [data-task-countdown]', element => {
        const chip = element.closest('.cal-task-chip');
        const text = document.createRange();text.selectNodeContents(element);
        const rect = value => ({ left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height });
        const ancestors = [];
        for (let node = element; node; node = node.parentElement) {
          if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(node).overflowX)) ancestors.push(rect(node.getBoundingClientRect()));
          if (node === chip) break;
        }
        return { text: rect(text.getBoundingClientRect()), chip: rect(chip.getBoundingClientRect()), ancestors,
          label: element.textContent, viewport: innerWidth };
      });
      assert.ok(bounds.text.width > 0 && bounds.text.height > 0, 'the countdown has visible text');
      assert.ok(bounds.text.left >= bounds.chip.left - 1 && bounds.text.right <= bounds.chip.right + 1,
        `the full countdown must fit in the task chip: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.ancestors.every(rect => bounds.text.left >= rect.left - 1 && bounds.text.right <= rect.right + 1),
        `no title or countdown wrapper may clip the text: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.text.left >= 0 && bounds.text.right <= bounds.viewport,
        'the countdown remains within the visible viewport');
      assert.deepEqual(page.errors, []);
      if (process.env.TASK_COUNTDOWN_QA_OUTPUT) {
        mkdirSync(process.env.TASK_COUNTDOWN_QA_OUTPUT, { recursive: true });
        await page.screenshot({ path: join(process.env.TASK_COUNTDOWN_QA_OUTPUT, `countdown-calendar-${view}-${width}.png`), fullPage: true });
      }
    } finally { await page.close(); }
  });
}

test('Calendar task button exposes the changing relative countdown to assistive technology', async () => {
  const page = await mount('calendar', { width: 390, view: 'agenda', styled: true });
  try {
    const chip = await page.$('.cal-task-chip[role="button"]');
    const before = await page.accessibility.snapshot({ root: chip });
    assert.equal(before.role, 'button');
    assert.match(`${before.name} ${before.description || ''}`, /2m left/,
      'the task button accessible name or description includes its current relative deadline');
    await page.evaluate(() => window.advanceCountdown(1));
    const after = await page.accessibility.snapshot({ root: chip });
    assert.match(`${after.name} ${after.description || ''}`, /1m left/,
      'the same task button exposes the updated relative deadline after a clock tick');
    assert.doesNotMatch(`${after.name} ${after.description || ''}`, /2m left/,
      'the accessible deadline cannot retain the stale relative time');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});
