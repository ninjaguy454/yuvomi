import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-device-navigation-'));
Object.assign(process.env, {
  DB_PATH: join(folder, 'test.db'), SESSION_SECRET: 'synthetic-device-navigation-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development',
  LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true',
});
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), password = 'Synthetic-navigation-parent-2026!';
db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Alex','Alex Parent',?,'admin','parent',1)").run(await hashPassword(password));
db.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('family_name','Maple Grove')").run();
let server, browser, origin, admin, display;
const returnSelector = '.nav-sidebar [data-device-return], [data-temporary-access] button';
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/api.js');
  return api[method](path, body);
}, { method, path, body });

async function submitLogin(page) {
  await page.waitForSelector('#username', { visible: true });
  await page.type('#username', 'Alex');
  await page.type('#password', password);
  const response = page.waitForResponse(res => res.url().endsWith('/auth/login') && res.request().method() === 'POST');
  await page.click('[type=submit]');
  assert.equal((await response).status(), 200);
}

async function signInTemporarily() {
  await display.bringToFront();
  await display.waitForSelector('[data-device-login]', { visible: true });
  await display.click('[data-device-login]');
  await submitLogin(display);
  await display.waitForSelector('.dashboard-overview__title');
  assert.match(await display.$eval('.dashboard-overview__title', node => node.textContent), /Alex/);
  await display.waitForSelector(returnSelector, { visible: true });
}

async function assertAnonymousHousehold() {
  await display.waitForFunction(() => document.querySelector('.dashboard-overview__title')?.textContent === 'Hello Maple Grove Family');
  const me = await call(display, 'get', '/auth/me');
  assert.equal(me.principal.kind, 'device');
  assert.equal(me.user.id, null);
  assert.equal(await display.$(returnSelector), null);
  assert.equal(await display.$('[data-device-approve]'), null);
  assert.equal(await display.$('.nav-sidebar [data-route="/settings"]'), null);
  assert.equal(db.prepare('SELECT temporary_sid FROM device_credentials LIMIT 1').get().temporary_sid, null);
  assert.equal(await display.evaluate(async () => {
    const { api } = await import('/api.js');
    return api.get('/devices').then(() => 200, error => error.status);
  }), 403);
}

test.before(async () => {
  server = fork(new URL('./helpers/task-card-full-app-server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: '0', TASK_CARD_BROWSER_SERVER_CHILD: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => output = (output + chunk).slice(-6000));
  origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output)), 60000);
    server.once('message', message => { clearTimeout(timeout); resolve(message.origin); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`${code}: ${output}`)); });
  });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox'] });
  const pages = [];
  for (let index = 0; index < 2; index++) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    // The held request must reach Puppeteer instead of an installed worker.
    await page.setBypassServiceWorker(true);
    page.setDefaultTimeout(10000);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(origin + '/login');
    await page.evaluate(() => localStorage.setItem('yuvomi-locale', 'en'));
    await page.reload();
    pages.push(page);
  }
  [admin, display] = pages;
  await admin.bringToFront(); await submitLogin(admin);
  await admin.waitForSelector('.dashboard-overview__title');
  const pairing = await call(display, 'post', '/device/pair', {});
  await call(admin, 'post', '/devices/pairing-approve', { code: pairing.code, name: 'Wall' });
  await call(display, 'post', '/device/pair/claim', { confirm_transition: true });
  await display.bringToFront();
  await display.goto(origin + '/device');
  await display.waitForSelector('.dashboard-overview__title');
});

test.after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve));
  }
  db.close(); rmSync(folder, { recursive: true, force: true });
});

// Removing retention of a navigation requested during render must fail this
// test. Holding a real dashboard request makes the lost-click window explicit.
test('navigation requested from the visible sidebar during temporary login is retained', { timeout: 30000 }, async () => {
  await display.click('[data-device-login]');
  await display.waitForSelector('#username');
  const held = {};
  const intercepted = display.waitForRequest(request => new URL(request.url()).pathname === '/api/v1/dashboard');
  const intercept = request => {
    if (new URL(request.url()).pathname === '/api/v1/dashboard' && !held.request) {
      held.request = request;
    } else void request.continue();
  };
  await display.setRequestInterception(true);
  display.on('request', intercept);
  try {
    await submitLogin(display);
    await intercepted;
    await display.waitForSelector('.dashboard');
    assert.equal(await display.$('.dashboard-overview__title'), null, 'dashboard is still loading');
    await display.click('.nav-sidebar [data-route="/settings"]');
    await held.request.continue();
    await display.waitForFunction(() => location.pathname.startsWith('/settings'));
    const devicesLink = '.settings-desktop-overview__leaf[href="/settings/admin/devices"]';
    await display.waitForSelector(devicesLink, { visible: true });
    await display.click(devicesLink);
    await display.waitForSelector('[data-device-approve]');
    assert.equal((await call(display, 'get', '/auth/me')).user.id, 1);
  } finally {
    if (held.request && !held.request.isInterceptResolutionHandled()) await held.request.continue();
    await display.setRequestInterception(false);
    display.off('request', intercept);
  }
});

test('explicit return removes administration and restores the anonymous family greeting', async () => {
  await display.click(returnSelector);
  await assertAnonymousHousehold();
  assert.equal((await call(admin, 'get', '/auth/me')).user.id, 1);
});

for (const boundary of ['idle', 'maximum']) test(`${boundary} expiry clears personal administration and restores the household greeting`, async () => {
  await signInTemporarily();
  await display.evaluate(() => window.yuvomi.navigate('/settings/admin/devices'));
  await display.waitForSelector('[data-device-approve]');
  const column = boundary === 'idle' ? 'temporary_idle_at' : 'temporary_started_at';
  db.prepare(`UPDATE device_credentials SET ${column}=? WHERE temporary_user_id=1`).run(Date.now() - 700_000);
  const rejection = display.waitForResponse(response => response.url().endsWith('/api/v1/devices') && [401, 409].includes(response.status()));
  await call(display, 'get', '/devices').catch(() => {});
  await rejection;
  await assertAnonymousHousehold();
  await display.goBack().catch(() => {});
  await assertAnonymousHousehold();
});

test('reload ends temporary personal access and restores the anonymous family greeting', async () => {
  await signInTemporarily();
  await display.reload();
  await assertAnonymousHousehold();
});
