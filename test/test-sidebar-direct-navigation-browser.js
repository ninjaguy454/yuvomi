// Real app, disposable synthetic household, and Chromium's normal sandbox.
// Reintroducing hover/focus expansion must break the direct-tap assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'yuvomi-sidebar-direct-'));
process.env.DB_PATH = join(folder, 'synthetic.db');
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SESSION_SECRET = 'synthetic-sidebar-navigation-only';
process.env.SESSION_SECURE = 'false';
process.env.BACKUP_ENABLED = 'false';
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_ALLOW_PASSWORD_LOGIN = 'true';
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), password = 'Synthetic-sidebar-2026!';
let server, browser, origin, admin, display;
const evidence = { scope: 'Synthetic localhost; desktop Chrome with touch emulation; not physical-device latency', profiling: 'Data Saver suppresses idle prewarming; normal pointer-intent prefetch remains enabled. Cold clears HTTP cache in a new document; warm is same-document SPA navigation.', profiles: [], errors: [] };
const notesLink = '.nav-sidebar [data-route="/notes"]';
const toggle = '.nav-sidebar__toggle';
const requestBlocks = new Map();
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/api.js');
  return api[method](path, body);
}, { method, path, body });

async function pageFor() {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1000, hasTouch: true });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return request.abort();
    const blocker = requestBlocks.get(page);
    if (blocker && url.pathname === blocker.path && !blocker.request) {
      blocker.request = request; blocker.resolve(); return;
    }
    return request.continue();
  });
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    // Make first-use import timing reproducible instead of racing idle prewarm.
    if (navigator.connection) Object.defineProperty(navigator.connection, 'saveData', { get: () => true });
    localStorage.setItem('yuvomi-locale', 'en');
    if (localStorage.getItem('yuvomi.sidebar.collapsed') === null) localStorage.setItem('yuvomi.sidebar.collapsed', '1');
    window.__startShellTrace = () => {
      const trace = window.__shellTrace = { start: performance.now(), events: [], frames: [], milestones: {}, tasks: [] };
      const originalPush = history.pushState;
      history.pushState = function (...args) {
        trace.events.push({ type: 'pushState', at: performance.now(), path: String(args[2]) });
        return originalPush.apply(this, args);
      };
      const controller = new AbortController();
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mouseover', 'mousedown', 'focusin', 'click']) {
        document.addEventListener(type, event => {
          trace.events.push({ type, at: performance.now(), route: event.target.closest?.('[data-route]')?.dataset.route, target: event.target.id || event.target.tagName });
        }, { capture: true, passive: true, signal: controller.signal });
      }
      const observer = new PerformanceObserver(list => trace.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
      observer.observe({ type: 'longtask' });
      let stopped = false;
      const frame = () => {
        if (stopped) return;
        const at = performance.now(), rail = document.querySelector('.nav-sidebar'), grid = document.querySelector('#notes-grid');
        trace.frames.push({ at, width: rail?.getBoundingClientRect().width, notesTop: rail?.querySelector('[data-route="/notes"]')?.getBoundingClientRect().top });
        const mark = (key, yes) => { if (yes && trace.milestones[key] === undefined) trace.milestones[key] = at; };
        mark('active', rail?.querySelector('[data-route="/notes"]')?.getAttribute('aria-current') === 'page');
        mark('shell', document.querySelector('.notes-page'));
        mark('ready', grid && !grid.hasAttribute('aria-busy'));
        mark('focused', grid && document.activeElement?.id === 'main-content');
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.__stopShellTrace = () => {
        stopped = true; controller.abort(); observer.disconnect(); history.pushState = originalPush;
        trace.path = location.pathname;
        trace.resources = performance.getEntriesByType('resource').filter(r => r.startTime >= trace.start && !r.name.includes('/changes')).map(r => ({ path: new URL(r.name).pathname, start: r.startTime, end: r.responseEnd, duration: r.duration }));
        return trace;
      };
    };
  });
  return page;
}

async function settle(page = display) {
  await page.waitForFunction(() => document.activeElement?.id === 'main-content');
  await page.waitForFunction(() => !document.querySelector('.nav-sidebar')?.getAnimations().some(a => a.playState === 'running'));
}
async function fresh(collapsed = true, page = display) {
  await page.bringToFront();
  await page.mouse.move(1300, 20);
  await page.evaluate(value => localStorage.setItem('yuvomi.sidebar.collapsed', value ? '1' : '0'), collapsed);
  await page.goto(origin + '/');
  await page.waitForSelector('.dashboard-overview__title'); await settle(page);
}
async function tap(selector, page = display) {
  const point = await page.$eval(selector, el => {
    const r = el.getBoundingClientRect(), rail = el.closest('.nav-sidebar')?.getBoundingClientRect();
    return { x: (Math.max(r.left, 0) + Math.min(r.right, rail?.right ?? innerWidth)) / 2, y: r.top + r.height / 2 };
  });
  await page.touchscreen.tap(point.x, point.y);
}
async function railState(page = display) {
  return page.evaluate(() => ({
    width: document.querySelector('.nav-sidebar').getBoundingClientRect().width,
    collapsed: document.documentElement.classList.contains('sidebar-collapsed'),
    saved: localStorage.getItem('yuvomi.sidebar.collapsed'),
    expanded: document.querySelector('.nav-sidebar__toggle').getAttribute('aria-expanded'),
  }));
}
async function assertCollapsed(page = display) {
  const state = await railState(page);
  assert.equal(state.width, 56, JSON.stringify(state));
  assert.equal(state.collapsed, true); assert.equal(state.saved, '1');
}
async function recordTap(name, { collapsed = true, cold = false } = {}) {
  if (cold) await fresh(collapsed);
  else {
    await display.evaluate(() => window.yuvomi.navigate('/'));
    await display.waitForSelector('.dashboard-overview__title'); await settle();
  }
  if (cold) { const cdp = await display.createCDPSession(); await cdp.send('Network.clearBrowserCache'); await cdp.detach(); }
  await display.evaluate(() => window.__startShellTrace());
  await tap(notesLink);
  // Sample the full existing sidebar transition even if a moved target loses the tap.
  await new Promise(resolve => setTimeout(resolve, 650));
  const trace = await display.evaluate(() => window.__stopShellTrace());
  evidence.profiles.push({ name, ...trace });
  if (process.env.SIDEBAR_EVIDENCE) await display.screenshot({ path: join(process.env.SIDEBAR_EVIDENCE, name + '.png') });
  assert.equal(trace.path, '/notes', JSON.stringify(trace.events));
  await display.waitForFunction(() => !!document.querySelector('#notes-grid') && !document.querySelector('#notes-grid').hasAttribute('aria-busy'));
  await settle();
  if (collapsed) {
    assert.ok(trace.frames.every(f => f.width === 56), 'a module tap must never expand the rail or move the target');
    await assertCollapsed();
  }
  return trace;
}

test.before(async () => {
  if (process.env.SIDEBAR_EVIDENCE) mkdirSync(process.env.SIDEBAR_EVIDENCE, { recursive: true });
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Alex','Alex Parent',?,'admin','parent',1)").run(await hashPassword(password, 4));
  server = fork(new URL('./helpers/note-board-full-app-server.mjs', import.meta.url), [], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', v => output = (output + v).slice(-6000));
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(output)), 60000);
    server.once('message', m => { clearTimeout(timer); resolve(m.origin); });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`${code}: ${output}`)); });
  });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
  evidence.browser = await browser.version();
  assert.ok(!browser.process().spawnargs.some(arg => /--no-sandbox|--disable-web-security|--ignore-certificate-errors/.test(arg)));
  admin = await pageFor(); await admin.goto(origin + '/login');
  await admin.waitForSelector('#username', { visible: true });
  await admin.type('#username', 'Alex'); await admin.type('#password', password); await admin.click('[type=submit]');
  await admin.waitForSelector('.dashboard-overview__title'); await settle(admin);
  for (let i = 0; i < 8; i++) await call(admin, 'post', '/notes', { title: `Synthetic note ${i + 1}`, content: 'A short synthetic note\n- [ ] Check item', visibility: 'all', color: '#EFE3BE' });
  display = await pageFor(); await display.goto(origin + '/login');
  await display.waitForSelector('#username', { visible: true });
  const pairing = await call(display, 'post', '/device/pair', {});
  await call(admin, 'post', '/devices/pairing-approve', { code: pairing.code, name: 'Synthetic Wall Calendar', permissions: { capabilities: { 'device_notes.view': 'allow' } } });
  await call(display, 'post', '/device/pair/claim', { confirm_transition: true });
  await fresh();
});

test.after(async () => {
  if (process.env.SIDEBAR_EVIDENCE) writeFileSync(join(process.env.SIDEBAR_EVIDENCE, 'profiles.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  db.close(); rmSync(folder, { recursive: true, force: true });
});

test('expanded touch navigation profiles cold and warm Notes loading', async () => {
  await recordTap('expanded-cold', { collapsed: false, cold: true });
  await recordTap('expanded-warm', { collapsed: false });
});

test('one collapsed module tap navigates directly without any expansion', async () => {
  await recordTap('collapsed-cold', { cold: true });
  await recordTap('collapsed-warm');
});

test('Notes startup does not wait for task inspection styles', { timeout: 15000 }, async () => {
  await fresh();
  const blocker = { path: '/styles/tasks.css', resolve() {} };
  requestBlocks.set(display, blocker);
  try {
    await tap(notesLink);
    const ready = await display.waitForFunction(() => !!document.querySelector('#notes-grid') && !document.querySelector('#notes-grid').hasAttribute('aria-busy'), { timeout: 1800 }).then(() => true, () => false);
    assert.equal(ready, true, 'Notes must render while task inspection CSS is unavailable');
    assert.equal(blocker.request, undefined, 'task inspection CSS is requested only when opening an offer');
    await settle(); await assertCollapsed();
  } finally {
    requestBlocks.delete(display);
    if (blocker.request && !blocker.request.isInterceptResolutionHandled()) await blocker.request.continue();
  }
});

test('mouse hover and keyboard focus preserve collapsed geometry and accessible navigation', async () => {
  await fresh();
  await display.hover(notesLink);
  await new Promise(resolve => setTimeout(resolve, 450));
  await assertCollapsed();
  await display.focus(notesLink);
  await assertCollapsed();
  assert.match(await display.$eval(notesLink, el => el.getAttribute('aria-label') || el.textContent), /Notes/i);
  await display.keyboard.press('Enter');
  await display.waitForSelector('.notes-page'); await settle(); await assertCollapsed();
});

test('only explicit toggle expands; keyboard focus, reload and history retain the choice', async () => {
  await fresh();
  await display.focus(toggle); await display.keyboard.press('Enter');
  await display.waitForFunction(() => !document.documentElement.classList.contains('sidebar-collapsed'));
  assert.equal((await railState()).expanded, 'true');
  await display.keyboard.press('Enter');
  await display.waitForFunction(() => document.querySelector('.nav-sidebar').getBoundingClientRect().width === 56);
  assert.equal(await display.$eval(toggle, el => el === document.activeElement), true);
  assert.equal((await railState()).expanded, 'false');
  await display.reload(); await display.waitForSelector('.dashboard-overview__title'); await settle(); await assertCollapsed();
  await tap(notesLink); await display.waitForSelector('.notes-page'); await settle();
  await display.goBack(); await display.waitForSelector('.dashboard-overview__title'); await settle(); await assertCollapsed();
  await display.goForward(); await display.waitForSelector('.notes-page'); await settle(); await assertCollapsed();
});

test('personal desktop mouse navigation also preserves the collapsed sidebar', async () => {
  await admin.setViewport({ width: 1440, height: 1000, hasTouch: false });
  await fresh(true, admin);
  await admin.click(notesLink); await admin.waitForSelector('.notes-page'); await settle(admin); await assertCollapsed(admin);
  assert.deepEqual(evidence.errors, []);
});

test('touch toggle changes the saved state without a compatibility-click reversal', async () => {
  await fresh();
  for (const collapsed of [false, true]) {
    await tap(toggle);
    await display.waitForFunction(value => document.documentElement.classList.contains('sidebar-collapsed') === value, {}, collapsed);
    await new Promise(resolve => setTimeout(resolve, 450));
    const state = await railState();
    assert.equal(state.saved, collapsed ? '1' : '0');
    assert.equal(state.expanded, String(!collapsed));
    assert.equal(state.width, collapsed ? 56 : 220);
    assert.equal(new URL(display.url()).pathname, '/');
  }
});

test('repeated and rapid module taps keep only the latest queued destination', { timeout: 30000 }, async () => {
  await fresh();
  const blocker = { path: '/api/v1/notes/board' };
  const held = new Promise(resolve => { blocker.resolve = resolve; });
  requestBlocks.set(display, blocker);
  await display.evaluate(() => window.__startShellTrace());
  try {
    await tap(notesLink); await held;
    await tap(notesLink); await tap(notesLink);
    await tap('.nav-sidebar [data-route="/tasks"]');
    await tap('.nav-sidebar [data-route="/calendar"]');
    await tap('.nav-sidebar [data-route="/calendar"]');
    await assertCollapsed();
    await blocker.request.continue();
    // The router updates history before importing/rendering the destination.
    // Main-content can still be focused with the preceding Notes DOM, so wait
    // for Calendar's completed render before testing Back and opening a note.
    await display.waitForFunction(() => location.pathname === '/calendar'
      && document.querySelector('#cal-body')?.getAttribute('aria-busy') === null);
    await settle();
    const trace = await display.evaluate(() => window.__stopShellTrace());
    assert.deepEqual(trace.events.filter(e => e.type === 'pushState').map(e => e.path), ['/notes', '/calendar']);
    assert.ok(trace.frames.every(f => f.width === 56));
    await display.goBack(); await display.waitForSelector('.notes-page'); await settle(); await assertCollapsed();
    await display.waitForSelector('.note-card__title', { visible: true });
    await tap('.note-card__title'); await display.waitForSelector('.note-modal');
    await display.keyboard.press('Escape'); await display.waitForSelector('.note-modal', { hidden: true });
    assert.equal(new URL(display.url()).pathname, '/notes'); await assertCollapsed();
  } finally {
    requestBlocks.delete(display);
    if (blocker.request && !blocker.request.isInterceptResolutionHandled()) await blocker.request.continue();
  }
});

test('a touch scroll in the collapsed module list neither navigates nor expands', async () => {
  await display.setViewport({ width: 1440, height: 540, hasTouch: true });
  await fresh();
  try {
    const list = await display.$eval('.nav-sidebar__items', el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height, scrollTop: el.scrollTop, overflow: el.scrollHeight - el.clientHeight };
    });
    assert.ok(list.overflow > 50, JSON.stringify(list));
    const cdp = await display.createCDPSession();
    const y = list.top + list.height * .8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 28, y }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 28, y: y - list.height * .6 * step / 8 }] });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    await display.waitForFunction(top => document.querySelector('.nav-sidebar__items').scrollTop > top + 20, {}, list.scrollTop);
    assert.equal(new URL(display.url()).pathname, '/'); await assertCollapsed();
  } finally { await display.setViewport({ width: 1440, height: 1000, hasTouch: true }); }
});

test('a Notes tap during Tasks loading is retained; preceding data wait is measurable', { timeout: 30000 }, async () => {
  await fresh(false);
  const blocker = { path: '/api/v1/tasks' };
  const held = new Promise(resolve => { blocker.resolve = resolve; });
  requestBlocks.set(display, blocker);
  try {
    await tap('.nav-sidebar [data-route="/tasks"]'); await held;
    await display.evaluate(() => window.__startShellTrace());
    await tap(notesLink);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(new URL(display.url()).pathname, '/tasks', 'the existing router serializes page render promises');
    await blocker.request.continue();
    await display.waitForSelector('.notes-page'); await settle();
    evidence.profiles.push({ name: 'notes-queued-behind-held-tasks', ...await display.evaluate(() => window.__stopShellTrace()) });
    assert.equal(new URL(display.url()).pathname, '/notes');
  } finally {
    requestBlocks.delete(display);
    if (blocker.request && !blocker.request.isInterceptResolutionHandled()) await blocker.request.continue();
  }
});
