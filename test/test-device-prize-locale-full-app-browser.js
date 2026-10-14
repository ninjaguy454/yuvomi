// Real shell, i18n, permissions, device boundary and routes; disposable local DB only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-prize-locale-'));
Object.assign(process.env, { DB_PATH: join(folder, 'test.db'), SESSION_SECRET: 'synthetic-prize-locale-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { createDevice, devicePreset, deviceHash, DEVICE_COOKIE } = await import('../server/services/devices.js');
const { postLedger } = await import('../server/services/rewards.js');
const d = get(), password = 'Synthetic-prize-locale-2026!';
const hash = await hashPassword(password, 4);
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Parent','Parent',?,'admin','parent',1)").run(hash);
d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(2,'Child','Child',?,'member','child',1)").run(hash);
d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(2,1)').run();
postLedger(d, { userId: 2, delta: 103, type: 'bonus' });
d.prepare("INSERT INTO reward_catalog(name,cost) VALUES('Synthetic prize',10)").run();
let server, browser, origin;
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) =>
  (await import('/api.js')).api[method](path, body), { method, path, body });

test.before(async () => {
  server = fork(new URL('./helpers/task-card-full-app-server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: '0', TASK_CARD_BROWSER_SERVER_CHILD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-6000); });
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(output)), 60000);
    server.once('message', message => { clearTimeout(timer); resolve(message.origin); });
    server.once('exit', code => { clearTimeout(timer); reject(Error(`${code}: ${output}`)); });
  });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--disable-background-networking'] });
});
test.after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  d.close(); rmSync(folder, { recursive: true, force: true });
});

async function display(t, { enabled = true, mode = 'trusted_display', legacy = false, locale = 'en' } = {}) {
  const permissions = devicePreset();
  permissions.capabilities['device_rewards.redeem'] = enabled ? 'allow' : 'none';
  permissions.prize_redemption_mode = mode;
  const device = createDevice(d, { name: 'Synthetic locale display', permissions, scope: { member_ids: [2], show_points: true } }, 1);
  const token = randomUUID();
  d.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id, deviceHash(token), randomUUID());
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  await context.setCookie({ name: DEVICE_COOKIE, value: token, url: origin });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  // Distinct synthetic clients preserve the real per-IP limiter while the
  // 24-locale matrix runs in one minute through the loopback reverse proxy.
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `192.0.2.${device.id}` });
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [], requests = [], locales = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(locale => {
    localStorage.setItem('yuvomi-locale', locale);
    localStorage.setItem('vidamia-paired-device', '1');
  }, locale);
  let serveLegacy = legacy;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== origin) return void request.abort();
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname.startsWith('/locales/')) {
      locales.push({ path: url.pathname, legacy: serveLegacy });
      if (serveLegacy) {
        // The pre-cart release had no rewards.deviceCart namespace. Keep the
        // rest of the real locale to model a tab opened before a lazy-module update.
        const data = JSON.parse(readFileSync(new URL('../public' + url.pathname, import.meta.url), 'utf8'));
        delete data.rewards.deviceCart;
        return void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      }
    }
    void request.continue();
  });
  await page.goto(origin + '/device');
  await page.waitForSelector('.dashboard-overview__title');
  serveLegacy = false;
  await page.evaluate(() => window.yuvomi.navigate('/rewards'));
  await page.waitForSelector('[data-device-prizes]');
  return { page, device, requests, locales, errors };
}

async function assertCart(page, locale = 'en') {
  await page.waitForSelector('[data-device-prize-profile="2"]');
  await page.click('[data-device-prize-profile="2"]');
  const text = await page.$eval('[data-device-prizes]', node => node.textContent);
  assert.doesNotMatch(text, /rewards\.deviceCart\./, text);
  const data = JSON.parse(readFileSync(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8'));
  const numbers = await page.evaluate(async () => {
    const format = (await import('/i18n.js')).getNumberFormat();
    return [0, 10, 103].map(value => format.format(value));
  });
  assert.ok(text.includes(data.rewards.deviceCart.total));
  assert.ok(text.includes(data.rewards.deviceCart.remaining));
  assert.equal(await page.$eval('[data-device-prize-units]', node => node.textContent), data.rewards.deviceCart.units.replace('{{count}}', numbers[0]));
  assert.equal(await page.$eval('[data-device-prize-checkout]', node => node.textContent), data.rewards.deviceCart.redeem);
  assert.equal(await page.$eval('[data-device-prize-remaining]', node => node.textContent), `${numbers[2]} ${data.rewards.pointsUnit}`);
  await page.click('[data-device-prize-buy]');
  assert.equal(await page.$eval('[data-device-prize-total]', node => node.textContent), `${numbers[1]} ${data.rewards.pointsUnit}`);
}

test('fresh paired shell resolves real cart translations in every supported locale', async t => {
  const f = await display(t);
  assert.equal(await f.page.$eval('[data-device-prize-checkout]', node => node.textContent), 'Redeem prizes');
  const supported = await f.page.evaluate(async () => (await import('/i18n.js')).getSupportedLocales());
  await f.page.close();
  for (const locale of supported) {
    const localized = await display(t, { locale });
    await assertCart(localized.page, locale);
    assert.deepEqual(localized.errors, [], locale);
    assert.equal(localized.requests.some(request => request.method === 'POST' && /\/rewards\/(?:redemptions|approval\/begin)$/.test(request.path)), false, 'preview never redeems a prize');
    await localized.page.close();
  }
  assert.deepEqual(f.errors, []);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM reward_redemptions').get().n, 0);
});

for (const locale of ['de', 'en', 'fr']) test(`${locale}: pre-cart locale state refreshes before rendering the new lazy cart`, async t => {
  const f = await display(t, { legacy: true, locale });
  await assertCart(f.page, locale);
  assert.ok(f.locales.some(request => !request.legacy), 'new cart reloads a missing translation namespace');
  assert.deepEqual(f.errors, []);
});

for (const mode of ['trusted_display', 'member_signin']) test(`${mode}: allowed paired redemption does not claim changes are impossible`, async t => {
  const f = await display(t, { mode });
  await assertCart(f.page);
  assert.equal(await f.page.$('.module-readonly-banner'), null);
  assert.equal(await f.page.evaluate(() => document.documentElement.hasAttribute('data-module-readonly')), true, 'catalog editing remains read-only');
  const me = await call(f.page, 'get', '/auth/me');
  assert.equal(me.permissions.modules.rewards, 'read');
  assert.equal(me.permissions.capabilities['device_rewards.redeem'], 'allow');
  await f.page.evaluate(() => window.yuvomi.navigate('/calendar'));
  await f.page.waitForSelector('.module-readonly-banner');
  assert.match(await f.page.$eval('.module-readonly-banner', node => node.textContent), /read-only access/);
});

test('denied and revoked shared contexts do not acquire redemption access', async t => {
  const f = await display(t, { enabled: false });
  await f.page.waitForSelector('.module-readonly-banner');
  assert.equal(await f.page.$('[data-device-prize-profile]'), null);
  assert.equal(await f.page.$('[data-device-prize-checkout]'), null);
  assert.equal((await call(f.page, 'get', '/auth/me')).permissions.capabilities['device_rewards.redeem'], 'none');
  d.prepare("UPDATE household_devices SET status='revoked' WHERE id=?").run(f.device.id);
  await f.page.reload();
  await f.page.waitForFunction(() => !document.querySelector('[data-device-prize-checkout]'));
  assert.equal(await f.page.$('[data-device-prize-checkout]'), null);
});

test('ordinary read-only Rewards keeps the module explanation', async t => {
  d.prepare("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','rewards','read') ON CONFLICT(subject_type,subject_id,resource_type,resource_key) DO UPDATE SET access='read'").run();
  const context = await browser.createBrowserContext(); t.after(() => context.close());
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': '198.51.100.1' });
  await page.evaluateOnNewDocument(() => localStorage.setItem('yuvomi-locale', 'en'));
  await page.goto(origin + '/login'); await page.waitForSelector('#username');
  await page.type('#username', 'Child'); await page.type('#password', password); await page.click('[type=submit]');
  await page.waitForSelector('.dashboard-overview__title');
  await page.evaluate(() => window.yuvomi.navigate('/rewards'));
  await page.waitForSelector('.module-readonly-banner');
  assert.match(await page.$eval('.module-readonly-banner', node => node.textContent), /read-only access/);
  assert.equal(await page.$('[data-device-prize-checkout]'), null);
});
