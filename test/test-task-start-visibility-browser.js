import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, cpSync, mkdirSync, symlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

// The real application runs in an isolated process. Only its Date is controlled;
// browser clocks, HTTP, authentication, live streams and timers remain real.
if (process.env.TASK_START_VISIBILITY_SERVER === '1') {
  mock.timers.enable({ apis: ['Date'], now: Number(process.env.TASK_START_VISIBILITY_NOW) });
  process.on('message', message => {
    if (message?.setTime != null) { mock.timers.setTime(message.setTime); process.send({ clockSet: message.setTime }); }
  });
  process.env.TASK_CARD_BROWSER_SERVER_CHILD = '1';
  await import('./helpers/task-card-full-app-server.mjs');
} else {
  const folder = mkdtempSync(join(tmpdir(), 'vidamia-start-visibility-'));
  Object.assign(process.env, { DB_PATH: join(folder, 'browser.db'), SESSION_SECRET: 'isolated-start-visibility-browser',
    SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error' });
  delete process.env.DB_ENCRYPTION_KEY;
  const { get } = await import('../server/db.js');
  const { hashPassword } = await import('../server/utils/password.js');
  const { todayKey, storedToInstantMs } = await import('../server/utils/timezone.js');
  const db = get(), password = 'Synthetic-start-boundary-2026!';
  db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  const day = todayKey(db), boundary = storedToInstantMs(`${day}T19:00:00`, 'America/New_York');
  const admin = Number(db.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Boundary parent','Boundary parent',?,'admin','parent',1)").run(await hashPassword(password)).lastInsertRowid);
  const child = Number(db.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Boundary Eleanor','Eleanor','no-login','member','child',1)").run().lastInsertRowid);
  const seed = (title, time = null) => {
    const id = Number(db.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,start_date,start_time,due_date,due_time) VALUES(?,?,?,'all',?,?,?,'23:59')").run(title, admin, child, time ? day : null, time, day).lastInsertRowid);
    db.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, child); return id;
  };
  const ordinary = seed('Always visible routine');
  const bedtime = seed('Scheduled bedtime routine', '19:00');
  const steps = ['Take shower', 'Brush teeth'].map(title => Number(db.prepare("INSERT INTO tasks(title,parent_task_id,created_by,visibility,start_date,start_time,due_date,due_time) VALUES(?,?,?,'all',?,'19:00',?,'23:59')")
    .run(title, bedtime, admin, day, day).lastInsertRowid));
  let server, browser, origin, output = '';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checkpoint = phase => writeFileSync(join(folder, 'phase.txt'), phase);
  const card = id => `article[data-task-id="${id}"]`;
  const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => (await import('/api.js')).api[method](path, body), { method, path, body });
  const clock = time => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.off('message', receive); reject(new Error('Synthetic server clock did not acknowledge')); }, 5000);
    const receive = message => { if (message.clockSet === time) { clearTimeout(timer); server.off('message', receive); resolve(); } };
    server.on('message', receive); server.send({ setTime: time });
  });
  test.before(async () => {
    // Express sendFile deliberately rejects dot-directory ancestors. Copy the
    // current runtime unchanged out of a possible .codex checkout, retaining
    // the real application routes/assets rather than changing static serving.
    const repo = fileURLToPath(new URL('..', import.meta.url)), runtime = join(folder, 'runtime');
    mkdirSync(join(runtime, 'test', 'helpers'), { recursive: true });
    for (const entry of ['server', 'public', 'modules', 'package.json']) cpSync(join(repo, entry), join(runtime, entry), { recursive: true });
    cpSync(fileURLToPath(import.meta.url), join(runtime, 'test', 'test-task-start-visibility-browser.js'));
    cpSync(join(repo, 'test', 'helpers', 'task-card-full-app-server.mjs'), join(runtime, 'test', 'helpers', 'task-card-full-app-server.mjs'));
    symlinkSync(realpathSync(join(repo, 'node_modules')), join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    server = fork(join(runtime, 'test', 'test-task-start-visibility-browser.js'), [], { cwd: runtime, env: { ...process.env, PORT: '0', TASK_START_VISIBILITY_SERVER: '1', TASK_START_VISIBILITY_NOW: String(boundary - 60_000) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    for (const pipe of [server.stdout, server.stderr]) pipe.on('data', data => { output = (output + data).slice(-6000); });
    origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Real app failed to start: ${output}`)), 60000);
      server.on('message', message => { if (message.origin) { clearTimeout(timeout); resolve(message.origin); } });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Real app exited ${code}: ${output}`)); });
    });
    const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync(edge) ? edge : undefined), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  });
  test.after(async () => {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
    db.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.ok(basename(folder).startsWith('vidamia-start-visibility-'));
    rmSync(folder, { recursive: true, force: true });
  });
  let sequence = 80;
  async function page(context) {
    const result = await context.newPage(); result.setDefaultTimeout(18000);
    await result.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${++sequence}` });
    await result.setViewport({ width: 1366, height: 900 });
    await result.emulateTimezone('America/Los_Angeles');
    const session = await result.createCDPSession(); await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await session.detach();
    result.errors = []; result.on('pageerror', error => result.errors.push(error.message));
    result.reads = 0; result.on('response', response => { if (new URL(response.url()).pathname === '/api/v1/tasks') result.reads++; });
    return result;
  }
  async function board(page, view) {
    if (!page.installSettled) await page.goto(`${origin}/tasks?view=${view}`, { waitUntil: 'domcontentloaded' });
    if (!page.installSettled) { await wait(3000); page.installSettled = true; }
    await page.waitForSelector('.app-shell');
    // A fresh paired launch intentionally starts at its own landing view.
    // Navigate normally after the device context has finished bootstrapping.
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await page.evaluate(path => window.yuvomi.navigate(path), `/tasks?view=${view}`); }
      catch (error) { if (!/context was destroyed/.test(error.message)) throw error; await wait(100); continue; }
      if (new URL(page.url()).pathname === '/tasks' && new URL(page.url()).searchParams.get('view') === view) break;
      await wait(50);
    }
    try { await page.waitForSelector(card(ordinary)); }
    catch (error) {
      throw new Error(`Board failed: ${JSON.stringify({ url: page.url(), errors: page.errors, body: await page.$eval('body', node => node.innerText.slice(-2200)), api: await api(page, 'get', '/tasks').catch(error => error.message), output })}`, { cause: error });
    }
  }
  async function heldCompletion(page, id) {
    const expand = `[data-action="toggle-subtasks"][data-id="${bedtime}"]`;
    if (await page.$eval(expand, node => node.getAttribute('aria-expanded') !== 'true')) await page.click(expand);
    const selector = `[data-action="toggle-subtask"][data-id="${id}"]`;
    await page.waitForSelector(selector); await page.$eval(selector, node => node.scrollIntoView({ block: 'center' }));
    let release, arrived, writes = 0; const dispatched = new Promise(resolve => { arrived = resolve; });
    const intercept = request => {
      if (new URL(request.url()).pathname === `/api/v1/tasks/${id}/status`) { writes++; release = () => request.continue(); arrived(); }
      else request.continue();
    };
    await page.setRequestInterception(true); page.on('request', intercept);
    try {
      await page.$eval(selector, button => {
        window.boundaryFeedback = new Promise(resolve => button.addEventListener('click', () => {
          const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            elapsed: performance.now() - start, checked: button.getAttribute('aria-pressed'), pending: button.getAttribute('aria-busy'),
          })));
        }, { capture: true, once: true }));
      });
      assert.equal(await page.$eval(selector, button => button.disabled), false, 'visible step is permitted');
      await page.click(selector);
      await Promise.race([dispatched, wait(5000).then(() => { throw new Error(`Checkbox did not dispatch: ${id}`); })]);
      const result = await page.evaluate(() => window.boundaryFeedback);
      assert.equal(result.checked, 'true'); assert.equal(result.pending, 'true');
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'open');
      await page.$eval(selector, button => button.click()); assert.equal(writes, 1);
      await wait(200); release(); release = null;
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-busy') === 'false', {}, selector);
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status, 'done');
      return result;
    } finally { release?.(); page.off('request', intercept); await page.setRequestInterception(false); }
  }

  test('real app: personal and paired List/Kanban hide future starts, retain upcoming, and reveal automatically at the household boundary', { timeout: 150000 }, async () => {
    const personalContext = await browser.createBrowserContext(), deviceContext = await browser.createBrowserContext();
    const personalList = await page(personalContext), displayList = await page(deviceContext);
    const pages = [personalList, displayList];
    try {
      await personalList.goto(origin + '/login');
      assert.equal(await personalList.evaluate(async password => (await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Boundary parent', password }) })).status, password), 200);
      await personalList.evaluate(() => localStorage.setItem('yuvomi-lang', 'en'));
      await board(personalList, 'list');
      checkpoint('personal board ready');
      // Pair through the production authentication endpoints, never fabricate a
      // member identity or bypass the device principal/capability boundary.
      await displayList.goto(origin + '/device/pair');
      const pairing = await api(displayList, 'post', '/device/pair', { confirm_transition: true });
      await api(personalList, 'post', '/devices/pairing-approve', { code: pairing.code, name: 'Kitchen Wall boundary QA' });
      await api(displayList, 'post', '/device/pair/claim', { confirm_transition: true });
      await board(displayList, 'list');
      checkpoint('paired board ready');
      const identity = await displayList.evaluate(async () => (await import('/api.js')).auth.me());
      assert.equal(identity.principal.kind, 'device'); assert.equal(identity.user.id, null);
      checkpoint('both boards ready');
      // Let initial service-worker activation and live-stream opening settle.
      await wait(2000);
      for (const current of pages) {
        assert.equal(await current.$(card(bedtime)), null);
        const hidden = await api(current, 'get', '/tasks');
        assert.equal(hidden.data.some(task => task.id === bedtime), false);
        assert.equal(hidden.visibility.next_start_at, boundary);
        assert.equal((await api(current, 'get', '/tasks?include_future=1')).data.some(task => task.id === bedtime), true);
      }
      await personalList.click('#filter-toggle-btn'); await personalList.click('#filter-show-future');
      await personalList.waitForSelector(card(bedtime));
      await personalList.click('#filter-show-future'); await personalList.waitForFunction(id => !document.querySelector(`article[data-task-id="${id}"]`), {}, bedtime);
      checkpoint('upcoming filter passed');
      // A canonical reload arms a short server-relative boundary. There is no
      // navigation, manual refresh, mutation or synthetic SSE after this point.
      const boundaries = [];
      for (const [personalView, deviceView] of [['list', 'kanban'], ['kanban', 'list']]) {
        await clock(boundary - 1500);
        await board(personalList, personalView); await board(displayList, deviceView);
        // Wait for the page's canonical loader, not merely an already-present
        // control card. Otherwise an in-flight navigation read could finish
        // after the clock jump and falsely stand in for the boundary timer.
        for (const current of pages) await current.evaluate(async () => {
          const { __test } = await import('/pages/tasks.js');
          await __test.loadTasks(document.getElementById('main-content'));
        });
        await wait(200);
        for (const current of pages) await current.waitForFunction(id => !document.querySelector(`article[data-task-id="${id}"]`), {}, bedtime);
        const versions = db.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
        const before = pages.map(current => current.reads), began = performance.now();
        await clock(boundary);
        await Promise.all(pages.map(current => current.waitForSelector(card(bedtime), { timeout: 7000 })));
        assert.equal(db.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version, versions, 'time passage must not mutate Tasks or generate a fake write event');
        pages.forEach((current, index) => assert.ok(current.reads > before[index], 'boundary triggers authoritative reload'));
        boundaries.push({ personalView, deviceView, appeared_ms: performance.now() - began });
      }
      checkpoint('all four view/principal combinations automatically revealed');
      const feedback = [await heldCompletion(displayList, steps[0])];
      await board(displayList, 'kanban'); feedback.push(await heldCompletion(displayList, steps[1]));
      checkpoint('held feedback passed');
      console.log('START_BOUNDARY_BROWSER', JSON.stringify({ boundaries, server_timezone: 'America/New_York', browser_timezone: 'America/Los_Angeles', held_checkbox: feedback }));
      for (const current of pages) assert.deepEqual(current.errors, []);
    } catch (error) {
      console.error('START_BOUNDARY_FAILURE', error.stack, pages.map(current => ({ url: current.url(), errors: current.errors })), output);
      throw error;
    } finally { await personalContext.close().catch(() => {}); await deviceContext.close().catch(() => {}); }
  });
}
