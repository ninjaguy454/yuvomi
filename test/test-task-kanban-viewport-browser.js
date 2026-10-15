// Real shell, router and Tasks against a disposable synthetic household.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-kanban-viewport-'));
Object.assign(process.env, { DB_PATH: join(folder, 'synthetic.db'), SESSION_SECRET: 'synthetic-kanban-viewport-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), password = 'Synthetic-Kanban-Viewport-Only!';
const output = process.env.TASK_KANBAN_VIEWPORT_EVIDENCE;
if (output) mkdirSync(output, { recursive: true });
const evidence = { measurements: [], errors: [], writes: [] };
let server, browser, origin;
test.before(async () => {
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'kanbanreview','Synthetic Parent',?,'admin','parent',1)").run(await hashPassword(password, 4));
  const insert = db.prepare("INSERT INTO tasks(title,description,category,created_by,visibility,points) VALUES(?,?,?,1,'all',0)");
  for (let group = 0; group < 7; group++) for (let row = 0; row < (group === 0 ? 28 : group === 1 ? 16 : 1); row++) {
    insert.run(`Group ${group + 1} Task ${String(row + 1).padStart(2, '0')}`, 'Synthetic instructions. '.repeat(8), `group-${group}`);
  }
  server = fork(new URL('./helpers/note-board-full-app-server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { log = (log + data).slice(-5000); });
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(log || 'Synthetic app startup deadline')), 20000);
    server.once('message', value => { clearTimeout(timer); resolve(value.origin); });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`Synthetic app exited ${code}: ${log}`)); });
  });
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await puppeteer.launch({ headless: true, pipe: false, ignoreDefaultArgs: ['--hide-scrollbars'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(edge) ? edge : undefined), args: ['--disable-background-networking'] });
});
test.after(async () => {
  if (output) writeFileSync(join(output, 'results.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  if (server?.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  db.close(); assert.equal(dirname(folder), resolve(tmpdir())); rmSync(folder, { recursive: true, force: true });
});
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mounted(viewport) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  page.setDefaultTimeout(12000); await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) return request.abort();
    if (request.url().startsWith(origin + '/api/v1/tasks') && !['GET', 'HEAD'].includes(request.method())) evidence.writes.push(request.url());
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('yuvomi-locale', 'en'); localStorage.setItem('yuvomi-lang', 'en'); });
  await page.goto(origin + '/login');
  assert.equal(await page.evaluate(async password => (await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'kanbanreview', password }) })).status, password), 200);
  await page.goto(origin + '/tasks?view=kanban'); await page.waitForSelector('.task-board__bucket'); await frames(page);
  return { context, page };
}
async function geometry(page, label) {
  const value = await page.evaluate(() => {
    const rect = node => node?.getBoundingClientRect().toJSON();
    const port = document.querySelector('.app-content'), board = document.querySelector('.task-board');
    return { viewport: { width: innerWidth, height: innerHeight }, content: rect(port), outerScroll: port.scrollHeight - port.clientHeight,
      board: rect(board), toolbar: rect(document.querySelector('.tasks-toolbar')), footer: rect(document.querySelector('.nav-bottom')),
      buckets: [...document.querySelectorAll('.task-board__bucket')].map(node => ({ rect: rect(node),
        header: rect(node.firstElementChild), scroll: rect(node.lastElementChild), maxScroll: node.lastElementChild.scrollHeight - node.lastElementChild.clientHeight })) };
  });
  evidence.measurements.push({ label, ...value });
  if (output) await page.screenshot({ path: join(output, `${label}.png`) });
  return value;
}

test('Kanban uses the available shell height with independent expanding groups and a bottom horizontal track', async () => {
  const failures = [];
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 3840, height: 2160 }]) {
    const { context, page } = await mounted(viewport);
    try {
      const value = await geometry(page, `${viewport.width}x${viewport.height}`);
      if (Math.abs(value.board.bottom - value.content.bottom) > 12) failures.push(`${viewport.width}: board bottom ${value.board.bottom}, shell bottom ${value.content.bottom}`);
      if (Math.abs(value.buckets[0].rect.bottom - value.board.bottom) > 20) failures.push(`${viewport.width}: long group ends at ${value.buckets[0].rect.bottom}, board ends at ${value.board.bottom}`);
      if (value.outerScroll > 2) failures.push(`${viewport.width}: unwanted shared vertical overflow ${value.outerScroll}`);
      if (value.buckets[0].maxScroll <= 0) failures.push(`${viewport.width}: long group must scroll independently`);
      assert.ok(value.buckets[2].rect.height < value.buckets[0].rect.height, 'short groups keep their content height');
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, []);
});

async function gesture(page, from, to) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8, id: 1 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 3840, height: 2160 }]) {
  test(`Kanban ${viewport.width}px keeps final cards reachable, independent scrolling, expansion and fixed chrome`, async () => {
    const { context, page } = await mounted(viewport);
    const beforeTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    try {
      const initial = await geometry(page, `interaction-${viewport.width}-initial`);
      const point = { x: initial.buckets[0].scroll.left + 110, y: Math.min(initial.buckets[0].scroll.top + 250, initial.board.bottom - 60) };
      if (viewport.hasTouch) await gesture(page, point, { x: point.x + 3, y: point.y - 160 });
      else { await page.mouse.move(point.x, point.y); await page.mouse.wheel({ deltaY: 320 }); }
      await page.waitForFunction(() => document.querySelector('.task-board__bucket-scroll').scrollTop > 50);
      const scrolled = await page.evaluate(() => ({ tops: [...document.querySelectorAll('.task-board__bucket-scroll')].map(node => node.scrollTop),
        outer: document.querySelector('.app-content').scrollTop, dragging: !!document.querySelector('.kanban-board--dragging') }));
      assert.ok(scrolled.tops[0] > 50); assert.equal(scrolled.tops[1], 0); assert.equal(scrolled.outer, 0); assert.equal(scrolled.dragging, false);
      const fixed = await geometry(page, `interaction-${viewport.width}-scrolled`);
      assert.deepEqual(fixed.toolbar, initial.toolbar); assert.deepEqual(fixed.footer, initial.footer);
      assert.deepEqual(fixed.buckets[0].header, initial.buckets[0].header);

      // Expanding the short group's real card grows that group, bounded only by
      // the available shell. Neighbours keep their own scroll position.
      const growth = await page.evaluate(() => {
        const bucket = document.querySelectorAll('.task-board__bucket')[2];
        const before = bucket.getBoundingClientRect().height;
        bucket.querySelector('[data-action="toggle-activity-details"]').click();
        return { before, after: bucket.getBoundingClientRect().height };
      });
      assert.ok(growth.after > growth.before, JSON.stringify(growth));
      assert.ok(growth.after <= initial.buckets[0].rect.height + 1);
      const collapsed = await page.evaluate(() => {
        const bucket = document.querySelectorAll('.task-board__bucket')[2];
        bucket.querySelector('[data-action="toggle-activity-details"]').click();
        return bucket.getBoundingClientRect().height;
      });
      assert.ok(Math.abs(collapsed - growth.before) <= 1, 'collapsing restores the natural group height');

      await page.evaluate(() => { const node = document.querySelector('.task-board__bucket-scroll'); node.scrollTop = node.scrollHeight; }); await frames(page);
      const last = await page.evaluate(() => {
        const port = document.querySelector('.task-board__bucket-scroll');
        const cards = port.querySelectorAll('.task-card'), button = cards[cards.length - 1].querySelector('[data-action="open-task"]');
        const r = button.getBoundingClientRect(), p = port.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, portTop: p.top, portBottom: p.bottom,
          reachable: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      });
      assert.ok(last.top >= last.portTop && last.bottom <= last.portBottom && last.reachable, JSON.stringify(last));
      if (output) await page.screenshot({ path: join(output, `interaction-${viewport.width}-last-card.png`) });

      if (viewport.hasTouch) {
        const from = { x: initial.buckets[0].scroll.left + 240, y: initial.buckets[0].scroll.top + 130 };
        await gesture(page, from, { x: from.x - 190, y: from.y + 2 });
      } else {
        // Drag the actual native horizontal thumb at the bottom of the board.
        const b = initial.board;
        await page.mouse.move(b.left + 35, b.bottom - 4); await page.mouse.down();
        await page.mouse.move(b.left + Math.min(b.width - 30, 450), b.bottom - 4, { steps: 10 }); await page.mouse.up();
      }
      await page.waitForFunction(() => document.querySelector('.task-board').scrollLeft > 50);
      assert.equal(await page.$eval('.app-content', node => node.scrollTop), 0);
      assert.equal(await page.$eval('.task-board__bucket-scroll', node => node.scrollTop > 0), true);
      assert.equal(await page.$('.kanban-board--dragging'), null);
      const track = await page.$eval('.task-board', node => ({ thickness: node.offsetHeight - node.clientHeight,
        overflow: getComputedStyle(node).overflowX, width: getComputedStyle(node).scrollbarWidth }));
      if (!viewport.hasTouch) assert.ok(track.thickness > 0, 'desktop allocates a native bottom track');
      assert.notEqual(track.width, 'none', 'touch browsers may paint an overlay track'); assert.equal(track.overflow, 'auto');
      assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), beforeTasks);
      assert.deepEqual(evidence.writes, []);
    } finally { await context.close(); }
  });
}

test('Kanban responds to search, sidebar, resize and view changes without altering List scrolling', async () => {
  const { context, page } = await mounted({ width: 1280, height: 900 });
  try {
    await page.click('#tasks-search-toggle'); await frames(page);
    let value = await geometry(page, 'search-open');
    assert.ok(Math.abs(value.board.bottom - value.content.bottom) <= 2);
    await page.click('.nav-sidebar__toggle');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.nav-sidebar')).width !== '220px'); await frames(page);
    value = await geometry(page, 'sidebar-collapsed');
    assert.ok(Math.abs(value.board.bottom - value.content.bottom) <= 2);
    await page.setViewport({ width: 1024, height: 600 }); await frames(page);
    value = await geometry(page, 'resized-1024x600');
    assert.ok(Math.abs(value.board.bottom - value.content.bottom) <= 2);
    assert.equal(value.outerScroll, 0);
    await page.click('#task-view-btn'); await page.click('[data-task-view="list"]'); await page.waitForFunction(() => !document.querySelector('.task-board'));
    assert.equal(await page.$('.page-scrollport'), null);
    assert.ok(await page.$eval('.app-content', node => node.scrollHeight > node.clientHeight), 'List remains page-scrollable');
    await page.$eval('.app-content', node => { node.scrollTop = node.scrollHeight; }); await frames(page);
    assert.ok(await page.$eval('.app-content', node => node.scrollTop > 0));
    await page.evaluate(() => window.yuvomi.navigate('/tasks?view=kanban')); await page.waitForSelector('.task-board'); await frames(page);
    value = await geometry(page, 'returned-from-list'); assert.ok(Math.abs(value.board.bottom - value.content.bottom) <= 2); assert.equal(value.outerScroll, 0);
    await page.evaluate(() => window.yuvomi.navigate('/shopping')); await page.waitForFunction(() => !document.querySelector('.tasks-page'));
    assert.deepEqual(evidence.errors, []);
  } finally { await context.close(); }
});

test('household Kanban also fills a wall-sized viewport and retains content-sized groups', async () => {
  const { context, page } = await mounted({ width: 3840, height: 2160 });
  try {
    await page.evaluate(async () => {
      // Select the device-local household layout without initiating a shell
      // route change or a server session lock in this read-only layout check.
      localStorage.setItem('yuvomi-wall-mode', '1');
      const { __test } = await import('/pages/tasks.js');
      __test.state.groupModes.household = 'category';
      __test.renderKanban(document.querySelector('.app-content'));
    }); await frames(page);
    assert.equal(await page.$eval('.task-board', node => node.dataset.boardScope), 'household');
    const value = await geometry(page, 'household-3840x2160');
    assert.ok(Math.abs(value.board.bottom - value.content.bottom) <= 2);
    assert.ok(value.buckets[2].rect.height < value.buckets[0].rect.height);
    assert.equal(value.outerScroll, 0);
    assert.deepEqual(evidence.writes, []);
  } finally { await context.close(); }
});
