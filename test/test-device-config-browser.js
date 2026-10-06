import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-device-config-'));
process.env.DB_PATH = join(folder, 'test.db');
Object.assign(process.env, { SESSION_SECRET: 'synthetic-device-config-tests',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { createDevice, devicePreset } = await import('../server/services/devices.js');
const db = get(), output = resolve(process.env.DEVICE_CONFIG_EVIDENCE || join(folder, 'evidence'));
mkdirSync(output, { recursive: true });
const password = 'Synthetic-device-config-only!';
let server, browser, page, origin, device;
const evidence = { viewports: [], mutations: [], errors: [] };

test.before(async () => {
  const admin = Number(db.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Config parent','Config parent',?,'admin','parent',1)").run(await hashPassword(password, 4)).lastInsertRowid);
  db.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role,onboarding_version) VALUES('Child','A long household member name','no-login','member','child',1)").run();
  const permissions = devicePreset();
  for(const key of ['move','pin','group','ungroup'])delete permissions.capabilities[`device_notes.${key}`];
  permissions.capabilities['device_notes.view'] = 'allow';
  permissions.capabilities['device_notes.create'] = 'allow';
  permissions.capabilities['tasks.change_dates'] = 'allow';
  device = createDevice(db, { name: 'Kitchen display', permissions }, admin);
  server = fork(new URL('./helpers/note-board-full-app-server.mjs', import.meta.url), [], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => log = (log + data).slice(-5000));
  origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 60000); server.once('message', message => { clearTimeout(timer); resolve(message.origin); }); server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${log}`)); }); });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' : undefined),args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] });
  evidence.browser = await browser.version();
  page = await browser.newPage(); page.setDefaultTimeout(15000);
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if ((['http:', 'https:'].includes(url.protocol) && url.origin !== origin) || url.pathname === '/sw.js') return request.abort();
    if (request.method() !== 'GET' && url.pathname.startsWith('/api/v1/devices')) evidence.mutations.push({ path: url.pathname, method: request.method(), body: request.postData() });
    return request.continue();
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem('yuvomi-lang', 'en'));
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(origin + '/login'); await page.waitForSelector('#username'); await page.type('#username', 'Config parent'); await page.type('#password', password);
  await page.click('[type=submit]'); await page.waitForSelector('.dashboard');
  await page.goto(origin + '/settings/admin/devices'); await page.waitForSelector('[data-device-edit]');
});

test.afterEach(async context => { if (context.error) { console.error(context.error); await page?.screenshot({path:join(output,'failure.png')}); } });
test.after(async () => {
  writeFileSync(join(output, 'results.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGKILL'); await new Promise(resolve => server.once('exit', resolve)); }
  db.close();
});

test('configuration disclosure, cancel and save preserve independent permissions across responsive layouts', { timeout: 180000 }, async () => {
  await page.click('[data-device-edit]'); await page.waitForSelector('[data-device-config]');
  for(const key of ['move','pin','group','ungroup'])assert.equal(await page.$eval(`[name="note:${key}"]`,input=>input.value),'legacy');
  await page.screenshot({ path: join(output, 'initial.png') });
  assert.equal(await page.$$eval('[data-device-config] details', nodes => nodes.length), 3, 'advanced controls have three native disclosure sections');
  const initial = await page.$eval('[data-device-config]', form => [...new FormData(form)]);
  for (const [name, width, height] of [['mobile', 390, 844], ['open-fold', 884, 1104], ['wall', 1920, 1080], ['desktop', 1440, 1050]]) {
    for (const theme of ['light', 'dark']) {
      await page.setViewport({ width, height });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const scale of [1, 2]) {
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.$$eval('[data-device-config] details', nodes => nodes.forEach(node => node.open = true));
        await page.$eval('.modal-panel__body', body => body.scrollTop = 0);
        const dimensions = await page.$eval('[data-device-config]', form => {
          const panel = form.closest('.modal-panel'), bounds = panel.getBoundingClientRect();
          const controls = [...panel.querySelectorAll('input, select, button, summary')].filter(el => el.getClientRects().length);
          return { overflow: form.scrollWidth > form.clientWidth + 1, clipped: controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < bounds.left - 1 || r.right > bounds.right + 1; }).map(el => el.name || el.textContent), saveVisible: (() => { const r = panel.querySelector('[data-device-save]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })() };
        });
        evidence.viewports.push({ name, width, height, theme, scale, ...dimensions });
        await page.screenshot({ path: join(output, `${name}-${theme}-${scale}x.png`) });
        assert.equal(dimensions.overflow, false, `${name}/${theme}/${scale} form overflow`);
        assert.deepEqual(dimensions.clipped, [], `${name}/${theme}/${scale} clipped controls`);
        assert.equal(dimensions.saveVisible, true, `${name}/${theme}/${scale} Save remains visible`);
        if (scale === 1) {
          await page.$eval('[name="note:view"]', input => input.closest('section').scrollIntoView({block:'start'}));
          await page.screenshot({path:join(output,`${name}-${theme}-notes.png`)});
          await page.$eval('[name="idle"]', input => input.closest('details').scrollIntoView({block:'start'}));
          await page.screenshot({path:join(output,`${name}-${theme}-advanced.png`)});
        }
      }
    }
  }
  await page.setViewport({ width: 1440, height: 1050 });
  await page.evaluate(() => document.documentElement.style.fontSize = '100%');
  const summaries = await page.$$('[data-device-config] summary');
  await page.$$eval('[data-device-config] details', nodes => nodes.forEach(node => node.open = false));
  for (const summary of summaries) { await summary.focus(); await page.keyboard.press('Enter'); }
  assert.deepEqual(await page.$eval('[data-device-config]', form => [...new FormData(form)]), initial, 'opening sections changes no values');
  assert.equal(evidence.mutations.length, 0);
  await page.click('[name="note:edit"]');
  await page.click('.modal-panel [data-action="close-modal"]');
  await page.waitForSelector('#confirm-modal-ok');
  await page.click('#confirm-modal-ok');
  await page.waitForFunction(() => !document.querySelector('[data-device-config]'));
  assert.equal(evidence.mutations.length, 0, 'Cancel does not save grants');
  await page.click('[data-device-edit]'); await page.waitForSelector('[data-device-config]');
  assert.deepEqual(await page.$eval('[data-device-config]', form => [...new FormData(form)]), initial);
  const saved = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().endsWith(`/devices/${device.id}`));
  await page.click('[data-device-save]'); assert.equal((await saved).status(), 200);
  await page.waitForFunction(() => !document.querySelector('[data-device-config]'));
  const row = db.prepare('SELECT * FROM household_devices WHERE id=?').get(device.id);
  assert.deepEqual(JSON.parse(row.permissions_json), device.permissions);
  assert.deepEqual(JSON.parse(row.preferences_json), device.preferences);
  assert.deepEqual(JSON.parse(row.scope_json), device.scope);
  assert.equal(row.idle_seconds, device.idle_seconds); assert.equal(row.maximum_seconds, device.maximum_seconds);
  await page.click('[data-device-edit]'); await page.waitForSelector('[data-device-config]');
  db.prepare('UPDATE household_devices SET revision=revision+1 WHERE id=?').run(device.id);
  const conflict = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().endsWith(`/devices/${device.id}`));
  await page.click('[data-device-save]'); assert.equal((await conflict).status(), 409);
  await page.waitForFunction(() => document.querySelector('[data-device-form-error]')?.textContent.includes('Reload'));
  assert.equal(await page.$eval('[data-device-save]', button => button.disabled), false);
  assert.deepEqual(JSON.parse(db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json), device.permissions);
  await page.screenshot({path:join(output,'stale-save-error.png')});
  assert.deepEqual(evidence.errors, []);
});

test('explicit layout controls save independently of Edit and preserve unrelated grants',async()=>{
  await page.goto(origin+'/settings/admin/devices');await page.waitForSelector('[data-device-edit]');await page.click('[data-device-edit]');
  await page.select('[name="note:move"]','allow');await page.select('[name="note:pin"]','none');
  await page.select('[name="note:group"]','allow');await page.select('[name="note:ungroup"]','none');
  const response=page.waitForResponse(res=>res.request().method()==='PATCH'&&res.url().endsWith(`/devices/${device.id}`));
  await page.click('[data-device-save]');assert.equal((await response).status(),200);
  const saved=JSON.parse(db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json);
  for(const [key,value] of Object.entries({move:'allow',pin:'none',group:'allow',ungroup:'none',edit:'none',view:'allow',create:'allow'}))assert.equal(saved.capabilities[`device_notes.${key}`],value);
  for(const [key,value] of Object.entries(device.permissions.capabilities))assert.equal(saved.capabilities[key],value);
});
