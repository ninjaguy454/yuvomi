import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-card-feedback-'));
process.env.DB_PATH = join(folder, 'browser.db');
delete process.env.DB_ENCRYPTION_KEY;
process.env.SESSION_SECRET = 'isolated-card-feedback-browser-tests-only';
process.env.SESSION_SECURE = 'false'; process.env.BACKUP_ENABLED = 'false';
process.env.NODE_ENV = 'development'; process.env.LOG_LEVEL = 'error';
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { todayKey } = await import('../server/utils/timezone.js');
const { reconcileTaskSupervision } = await import('../server/services/task-supervision.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');
// The real lifecycle intentionally requires the Tasks adapter for recurrence.
await import('../server/routes/tasks.js');
const db = get();
let server, browser, otherBrowser, origin, client = 30;
const password = 'Isolated-Card-Browser-Only-2026!';
const createUser = (name, role, family) => Number(db.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role,onboarding_version) VALUES(?,?,?,'test',?,?,1)").run(name, name, name, role, family).lastInsertRowid);
const admin = createUser('QA card parent', 'admin', 'parent');
const learner = createUser('QA card learner', 'member', 'child');
db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
db.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(learner);
const launch = () => puppeteer.launch({ headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' && existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined),
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });

test.before(async () => {
  db.prepare('UPDATE users SET password_hash=?').run(await hashPassword(password));
  server = fork(new URL('./helpers/task-card-full-app-server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: '0', TASK_CARD_BROWSER_SERVER_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  server.stdout.on('data', data => { output = (output + data).slice(-6000); });
  server.stderr.on('data', data => { output = (output + data).slice(-6000); });
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Full app did not start: ${output}`)), 60000);
    server.once('message', message => { clearTimeout(timeout); resolve(message.origin); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Full app exited ${code}: ${output}`)); });
  });
  browser = await launch();
});
test.after(async () => {
  await browser?.close(); await otherBrowser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  db.close();
  // Only known files in this suite's freshly created temporary directory.
  for (const suffix of ['', '-wal', '-shm']) { try { unlinkSync(join(folder, `browser.db${suffix}`)); } catch {} }
  try { rmdirSync(folder); } catch {}
});

function fixture({ recurring = false, completed = 0, count = 10 } = {}) {
  const day = todayKey(db);
  const root = Number(db.prepare("INSERT INTO tasks(title,description,created_by,assigned_to,points,start_date,start_time,due_date,due_time,is_recurring,recurrence_rule,expiration_policy) VALUES('QA morning card','Preserve this expanded description.',?,?,2,?,'00:00',?,'23:59',?,?,'expire_incomplete')").run(admin, learner, day, day, Number(recurring), recurring ? 'FREQ=DAILY' : null).lastInsertRowid);
  db.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(root, learner);
  const children = Array.from({ length: count }, (_, index) => Number(db.prepare("INSERT INTO tasks(title,created_by,parent_task_id,start_date,start_time,due_date,due_time,is_optional) VALUES(?,?,?,?,'00:00',?,'23:59',?)").run(`Morning step ${index + 1}`, admin, root, day, day, Number(index === count - 1)).lastInsertRowid));
  reconcileTaskSupervision(db, root, { notify: false });
  for (const id of children.slice(0, completed)) changeTaskStatus(db, id, 'done', { actorId: learner, requireRevision: false });
  return { root, children };
}
const selector = id => `[data-action="toggle-subtask"][data-id="${id}"]`;
const row = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
async function open(f, { mobile = false, secondary = false, mode = 'kanban' } = {}) {
  if (secondary && !otherBrowser) otherBrowser = await launch();
  const context = await (secondary ? otherBrowser : browser).createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Full-app browser error:', error.message));
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `198.51.100.${++client}` });
  await page.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
  await page.goto(`${origin}/login`);
  const login = await page.evaluate(async ({ password }) => {
    const response = await fetch('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'QA card learner', password }) });
    return response.status;
  }, { password });
  assert.equal(login, 200);
  await page.evaluate(mode => { localStorage.setItem('yuvomi-tasks-view', mode); }, mode);
  await page.goto(`${origin}/tasks?view=${mode}`, { waitUntil: 'domcontentloaded' });
  // A fresh browser installs its first worker; the real router applies that
  // update with an 8-second reload. Exercise the settled, already open app.
  await new Promise(resolve => setTimeout(resolve, 10000));
  await page.waitForSelector(`article[data-task-id="${f.root}"]`, { timeout: 30000 });
  const toggle = `article[data-task-id="${f.root}"] [data-action="toggle-subtasks"]`;
  if (await page.$eval(toggle, element => element.getAttribute('aria-expanded') !== 'true')) await page.locator(toggle).click();
  await page.waitForSelector(selector(f.children[0]), { visible: true });
  await new Promise(resolve => setTimeout(resolve, 1800));
  return { page, context };
}
async function hold(page) {
  const requests = [];
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.method() === 'PATCH' && /\/tasks\/\d+\/status$/.test(request.url())) requests.push(request);
    else void request.continue();
  });
  return {
    requests,
    async at(index = 0) {
      for (let attempt = 0; attempt < 200; attempt++) { if (requests[index]) return requests[index]; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error(`Expected status write ${index + 1}; got ${requests.length}`);
    },
  };
}
async function state(page, id) {
  return page.$eval(selector(id), async button => {
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return { done: button.getAttribute('aria-pressed') === 'true', busy: button.getAttribute('aria-busy') === 'true',
      path: button.querySelector('svg path')?.getAttribute('d') || '', disabled: button.disabled,
      visible: button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility === 'visible' };
  });
}
async function waitSaved(page, id, done = true) {
  await page.waitForFunction(({ selector, done }) => { const button = document.querySelector(selector); return button && button.getAttribute('aria-busy') === 'false' && button.getAttribute('aria-pressed') === String(done); }, { timeout: 15000 }, { selector: selector(id), done });
}

test('full app card paints two required intents before HTTP, deduplicates and preserves expansion/focus', async () => {
  const f = fixture(), { page, context } = await open(f);
  const requests = [];
  page.on('request', request => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
  // Page-level DevTools response events omit worker-handled Tasks reads. Observe
  // the real response consumed by the app without bypassing its service worker.
  await page.evaluate(root => {
    window.cardListReads = [];
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const request = args[0], method = args[1]?.method || request?.method || 'GET';
      const path = new URL(typeof request === 'string' ? request : request.url, location.origin).pathname;
      if (method === 'GET' && path === '/api/v1/tasks') {
        const json = response.json.bind(response);
        response.json = async () => {
          const payload = await json();
          window.cardListReads.push(payload.data?.find(task => task.id === root));
          return payload;
        };
      }
      return response;
    };
  }, f.root);
  const readAt = async revision => {
    await page.waitForFunction(revision => window.cardListReads.some(task => task?.revision >= revision), { timeout: 8000 }, revision);
    await state(page, f.children[1]);
  };
  try {
    const details = `article[data-task-id="${f.root}"] [data-action="toggle-activity-details"]`;
    await page.click(details);
    await page.evaluate(id => { window.feedbackRow = document.querySelector(`[data-subtask-id="${id}"]`); }, f.children[0]);
    const held = await hold(page);
    await page.click(selector(f.children[0])); await held.at();
    const immediate = await state(page, f.children[0]);
    assert.equal(immediate.done && immediate.busy && immediate.visible && !!immediate.path, true);
    assert.equal(row(f.children[0]).status, 'open', 'server mutation is still held');
    assert.equal(await page.$eval(`article[data-task-id="${f.root}"] [data-action="toggle-status"]`, button => button.title), 'In Progress');
    await page.$eval(selector(f.children[0]), button => button.click());
    await page.click(selector(f.children[1]));
    assert.equal((await state(page, f.children[1])).done, true); assert.equal(held.requests.length, 1);
    const scroll = await page.$eval(`article[data-task-id="${f.root}"]`, card => ({
      bucket: card.closest('.task-board__bucket-scroll')?.scrollTop || 0,
      page: document.querySelector('.page-scrollport')?.scrollTop || 0,
    }));
    await held.requests[0].continue(); const second = await held.at(1);
    const body = JSON.parse(second.postData()); assert.equal(body.expected_parent_revision, row(f.root).revision);
    // Exercise an actual list reconciliation while the second write remains
    // held; its canonical response must not erase the provisional checkmark.
    await page.evaluate(() => window.dispatchEvent(new Event('task-data-changed')));
    await readAt(row(f.root).revision);
    const stillPending = await state(page, f.children[1]);
    assert.equal(stillPending.done && stillPending.busy && !!stillPending.path, true);
    await second.continue(); await waitSaved(page, f.children[1]);
    await readAt(row(f.root).revision);
    await state(page, f.children[1]);
    assert.equal(held.requests.length, 2); assert.equal(row(f.children[0]).status, 'done'); assert.equal(row(f.children[1]).status, 'done');
    assert.equal(await page.$eval(details, button => button.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.evaluate(id => window.feedbackRow === document.querySelector(`[data-subtask-id="${id}"]`), f.children[0]), true);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), String(f.children[1]));
    const afterScroll = await page.$eval(`article[data-task-id="${f.root}"]`, card => ({
      bucket: card.closest('.task-board__bucket-scroll')?.scrollTop || 0,
      page: document.querySelector('.page-scrollport')?.scrollTop || 0,
    }));
    assert.deepEqual(afterScroll, scroll);
  } catch (error) { console.error('Card interaction request trace:', requests); throw error; }
  finally { await context.close(); }
});

test('full app stale-write rejection restores checkbox from canonical state and shows the actual reason', async () => {
  const f = fixture(), { page, context } = await open(f);
  try {
    const held = await hold(page); await page.click(selector(f.children[0])); await held.at();
    assert.equal((await state(page, f.children[0])).done, true);
    changeTaskStatus(db, f.children[1], 'done', { actorId: learner, requireRevision: false });
    const response = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/status$/.test(response.url()));
    await held.requests[0].continue(); assert.equal((await response).status(), 409);
    await waitSaved(page, f.children[0], false);
    assert.equal(row(f.children[0]).status, 'open'); assert.equal(held.requests.length, 1);
    assert.match(await page.evaluate(() => document.body.innerText), /changed|refresh|updated|revision/i);
    assert.equal((await state(page, f.children[0])).path, '');
  } finally { await context.close(); }
});

test('full app optional/final required flow awards parent points and recurrence exactly once', async () => {
  const f = fixture({ recurring: true, completed: 8 }), { page, context } = await open(f);
  try {
    await page.click(selector(f.children[9])); await waitSaved(page, f.children[9]);
    assert.equal(row(f.root).status, 'in_progress');
    const held = await hold(page); await page.click(selector(f.children[8])); await held.at();
    assert.equal((await state(page, f.children[8])).done, true); assert.equal(row(f.root).status, 'in_progress');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(f.root).n, 0);
    const acknowledged = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/status$/.test(response.url()));
    await held.requests[0].continue(); assert.equal((await acknowledged).status(), 200);
    assert.equal(row(f.root).status, 'done');
    const earned = db.prepare("SELECT COUNT(*) n,SUM(delta) points FROM reward_ledger WHERE task_id=? AND type='earn'").get(f.root);
    assert.equal(earned.n, 1); assert.equal(earned.points, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND action_task_id=? AND event_type='completed'").get(f.root, f.root).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(f.root).n, 1);
  } finally { await context.close(); }
});

test('full app reopening paints unchecked while its mutation is still held', async () => {
  const f = fixture({ completed: 1 }), { page, context } = await open(f);
  try {
    const held = await hold(page); await page.click(selector(f.children[0])); await held.at();
    const pending = await state(page, f.children[0]);
    assert.equal(pending.done, false); assert.equal(pending.path, ''); assert.equal(pending.busy, true);
    assert.equal(row(f.children[0]).status, 'done');
    await held.requests[0].continue(); await waitSaved(page, f.children[0], false);
    assert.equal(row(f.children[0]).status, 'in_progress');
  } finally { await context.close(); }
});

test('full app second independent client converges for card completion and reopening', async () => {
  const f = fixture(), first = await open(f), second = await open(f, { secondary: true });
  try {
    await first.page.locator(selector(f.children[0])).click(); await waitSaved(second.page, f.children[0]);
    await second.page.locator(selector(f.children[0])).click(); await waitSaved(first.page, f.children[0], false);
    assert.equal(row(f.children[0]).status, 'in_progress');
  } finally { await first.context.close(); await second.context.close(); }
});

test('full app mobile swipe over a checkbox scrolls without mutation; deliberate tap paints before HTTP', async () => {
  const f = fixture({ count: 18 }), { page, context } = await open(f, { mobile: true });
  try {
    await page.evaluate(() => {
      window.mobileCardEvents = [];
      for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'click']) document.addEventListener(name, event => {
        const target = event.target.closest('[data-action]');
        window.mobileCardEvents.push({ name, action: target?.dataset.action, id: target?.dataset.id, x: event.clientX, y: event.clientY });
      }, true);
    });
    const held = await hold(page), client = await page.createCDPSession();
    const box = await page.$eval(selector(f.children[2]), button => { button.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const scrollPositions = () => page.$eval(selector(f.children[2]), button => {
      const positions = [];
      for (let node = button.parentElement; node; node = node.parentElement) positions.push({
        tag: node.tagName, class: node.className, top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
      });
      return positions;
    });
    const scrollBefore = await scrollPositions();
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [box] });
    for (let i = 1; i <= 5; i++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x, y: box.y - i * 22 }] });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(held.requests.length, 0); assert.equal(row(f.children[2]).status, 'open');
    const scrollAfter = await scrollPositions();
    assert.ok(scrollAfter.some((node, index) => node.top > scrollBefore[index].top), `Touch swipe must scroll: ${JSON.stringify({ before: scrollBefore, after: scrollAfter })}`);
    await page.$eval(selector(f.children[2]), button => button.scrollIntoView({ block: 'center', behavior: 'instant' }));
    // Native touch inertia can consume a tap intended to stop scrolling. Wait
    // for a genuinely stable target before testing an intentional activation.
    await page.$eval(selector(f.children[2]), async button => {
      let previous, stable = 0;
      for (let frame = 0; frame < 180; frame++) {
        await new Promise(requestAnimationFrame);
        const r = button.getBoundingClientRect(), position = `${r.x}:${r.y}:${button.closest('.task-board__bucket-scroll').scrollTop}`;
        stable = position === previous ? stable + 1 : 0; previous = position;
        if (stable >= 12) return;
      }
      throw new Error('Mobile checkbox did not settle after scrolling');
    });
    const hit = await page.$eval(selector(f.children[2]), button => {
      const r = button.getBoundingClientRect(), target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-action]');
      return { disabled: button.disabled, id: target?.dataset.id, action: target?.dataset.action, x: r.x, y: r.y };
    });
    assert.equal(hit.disabled, false); assert.equal(hit.id, String(f.children[2]), JSON.stringify(hit));
    assert.equal(hit.action, 'toggle-subtask', JSON.stringify(hit));
    await page.tap(selector(f.children[2])); await held.at();
    assert.equal((await state(page, f.children[2])).done, true);
    await held.requests[0].continue(); await waitSaved(page, f.children[2]);
    assert.equal(held.requests.length, 1); await client.detach();
  } catch (error) { console.error('Mobile card events:', await page.evaluate(() => window.mobileCardEvents)); throw error; }
  finally { await context.close(); }
});
