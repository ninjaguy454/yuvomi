import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-weather-'));
Object.assign(process.env, { DB_PATH: join(folder, 'test.db'), SESSION_SECRET: 'synthetic-weather-browser-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true',
  OPENWEATHER_API_KEY: 'synthetic-provider-test-key', OPENWEATHER_CITY: 'Synthetic Household Town' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const db = get(), output = resolve(process.env.WEATHER_EVIDENCE || join(folder, 'evidence'));
mkdirSync(output, { recursive: true });
const password = 'Synthetic-weather-parent-only!';
const evidence = { screenshots: [], errors: [], weatherRequests: [], geolocationCalls: 0 };
let server, browser, origin, admin, display, deviceId, originalPermissions;
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const { api } = await import('/api.js'); return api[method](path, body);
}, { method, path, body });
const status = (page, path) => page.evaluate(async path => {
  const { api } = await import('/api.js'); return api.get(path).then(() => 200, error => error.status);
}, path);
const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key, value);
const storedDevice = () => db.prepare('SELECT * FROM household_devices WHERE id=?').get(deviceId);
async function login(page) {
  await page.waitForSelector('#username', { visible: true });
  await page.type('#username', 'Weather Parent'); await page.type('#password', password);
  await page.click('[type=submit]'); await page.waitForSelector('.dashboard');
}
async function overview() {
  await display.bringToFront(); await display.goto(origin + '/');
  await display.waitForSelector('.dashboard-overview__title');
  await display.waitForFunction(() => !document.querySelector('.dashboard-skeleton'));
}
async function weather() {
  await display.waitForSelector('#weather-widget', { visible: true });
  assert.match(await display.$eval('#weather-widget', node => node.textContent), /Synthetic Household Town/);
  assert.ok(!(await display.$eval('body', node => node.textContent)).includes('PRIVATE PERSONAL LOCATION'));
  assert.equal(await display.evaluate(() => window.__geoCalls), 0);
}
async function screenshot(name) {
  await display.$eval('#weather-widget', node => node.scrollIntoView({ block: 'center' }));
  const bounds = await display.$eval('#weather-widget', node => {
    const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1, JSON.stringify(bounds)); assert.equal(bounds.overflow, false);
  await display.screenshot({ path: join(output, name + '.png') }); evidence.screenshots.push({ name, ...bounds });
}
test.before(async () => {
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'Weather Parent','Weather Parent',?,'admin','parent',1)").run(await hashPassword(password, 4));
  for (const [key,value] of Object.entries({ family_name: 'Synthetic Family', weather_provider: 'open-meteo', weather_lat: '40', weather_lon: '-75', weather_city: 'Synthetic Household Town', weather_units: 'imperial', weather_auto_locate: '1', 'weather_lat:user:1': '10', 'weather_lon:user:1': '20', 'weather_city:user:1': 'PRIVATE PERSONAL LOCATION', 'weather_auto_locate:user:1': '0' })) setting(key, value);
  setting('dashboard_widgets:user:1', JSON.stringify([{id:'weather',visible:true,size:'2x1',order:0}]));
  server = fork(new URL('./helpers/device-weather-server.mjs', import.meta.url), [], { env: { ...process.env, PORT: '0' }, stdio: ['ignore','pipe','pipe','ipc'] });
  let log = ''; for (const stream of [server.stdout,server.stderr]) stream.on('data', data => log = (log + data).slice(-5000));
  origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 60000); server.once('message', message => { clearTimeout(timer); resolve(message.origin); }); server.once('exit', code => { clearTimeout(timer); reject(Error(`${code}: ${log}`)); }); });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' : undefined), args: ['--disable-gpu','--disable-dev-shm-usage','--disable-background-networking'] });
  evidence.browser = await browser.version();
  const pages = [];
  for (let i=0;i<2;i++) {
    const page = await (await browser.createBrowserContext()).newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => { const url = new URL(request.url()); if (['http:','https:'].includes(url.protocol) && url.origin !== origin) return request.abort(); if (url.pathname.startsWith('/api/v1/weather')) evidence.weatherRequests.push({ path: url.pathname, method: request.method() }); return request.continue(); });
    await page.evaluateOnNewDocument(() => { localStorage.setItem('yuvomi-locale', 'en'); window.__geoCalls = 0; navigator.geolocation.getCurrentPosition = () => { window.__geoCalls++; }; });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setViewport({ width: 1280, height: 900 }); await page.goto(origin + '/login'); pages.push(page);
  }
  [admin,display] = pages; await admin.bringToFront(); await login(admin);
  const pairing = await call(display, 'post', '/device/pair', {});
  const approved = await call(admin, 'post', '/devices/pairing-approve', { code: pairing.code, name: 'Synthetic Wall' }); deviceId = approved.data.id;
  await call(display, 'post', '/device/pair/claim', { confirm_transition: true });
  originalPermissions = JSON.parse(storedDevice().permissions_json);
  // Exercise upgrading an existing device record with no Weather layout entry.
  const prefs = JSON.parse(storedDevice().preferences_json); prefs.widgets = prefs.widgets.filter(w => w.id !== 'weather');
  db.prepare('UPDATE household_devices SET preferences_json=? WHERE id=?').run(JSON.stringify(prefs), deviceId);
  await display.goto(origin + '/device');
});
test.afterEach(async context => { if (context.error) { console.error(context.error); const name=context.name.slice(0,30).replace(/\W/g,'-'); await display?.screenshot({ path: join(output, `failure-${name}.png`) }); console.error(await display.evaluate(() => ({url:location.href,text:document.body.innerText.slice(0,3500)}))); } });
test.after(async () => { evidence.geolocationCalls = await display?.evaluate(() => window.__geoCalls).catch(() => -1); writeFileSync(join(output, 'results.json'), JSON.stringify(evidence,null,2)); await browser?.close(); server?.kill(); db.close(); });

test('existing denial is preserved; administrator explicitly enables household Weather and its widget', async () => {
  await overview(); assert.equal(await status(display, '/weather'), 403); assert.equal(await display.$('#weather-widget'), null);
  await admin.bringToFront(); await admin.goto(origin + '/settings/admin/devices'); await admin.waitForSelector('[data-device-edit]'); await admin.click('[data-device-edit]');
  assert.equal(await admin.$eval('[name="weather"]', input => input.checked), false);
  assert.equal(await admin.$eval('[name="widget:weather"]', input => input.checked), false);
  await admin.click('[data-device-save]'); await admin.waitForFunction(() => !document.querySelector('[data-device-config]'));
  assert.deepEqual(JSON.parse(storedDevice().permissions_json), originalPermissions, 'cosmetic save retains every grant');
  await admin.click('[data-device-edit]'); await admin.click('[name="weather"]');
  await admin.$eval('[name="widget:weather"]', input => { input.closest('details').open = true; input.scrollIntoView(); }); await admin.click('[name="widget:weather"]');
  await admin.screenshot({ path: join(output,'configuration-opt-in.png') });
  await admin.click('[data-device-save]'); await admin.waitForFunction(() => !document.querySelector('[data-device-config]'));
  const expected = structuredClone(originalPermissions); expected.widgets.weather = 'allow'; assert.deepEqual(JSON.parse(storedDevice().permissions_json), expected);
  await overview(); await weather(); assert.equal((await call(display,'get','/auth/me')).user.id, null);
  assert.equal(await status(display, '/devices'), 403); assert.equal(await status(display, '/documents'), 403);
});

test('Overview remains reachable with collapsed navigation, direct entry and reload at wall and mobile sizes', async () => {
  await display.setViewport({width:1280,height:900});
  await display.evaluate(() => localStorage.setItem('yuvomi.sidebar.collapsed','1')); await overview(); await weather();
  await display.click('.nav-sidebar [data-route="/tasks"]'); await display.waitForFunction(() => location.pathname === '/tasks');
  await display.click('.nav-sidebar [data-route="/"]'); await weather();
  assert.equal(await display.evaluate(() => document.documentElement.classList.contains('sidebar-collapsed')), true);
  await screenshot('overview-collapsed');
  for (const [name,width,height] of [['wall',1920,1080],['mobile',390,844]]) for (const theme of ['light','dark']) {
    await display.setViewport({width,height}); await overview(); await weather();
    await display.evaluate(theme => document.documentElement.setAttribute('data-theme',theme),theme); await screenshot(`${name}-${theme}`);
    await display.reload(); await weather();
  }
});

test('temporary personal sign-in uses its own Weather and return restores only household Weather', async () => {
  await display.setViewport({width:1280,height:900}); await overview();
  await display.click('[data-device-login]'); await login(display);
  assert.equal((await call(display,'get','/weather')).data.city,'PRIVATE PERSONAL LOCATION');
  await display.waitForFunction(() => document.querySelector('#weather-widget')?.textContent.includes('PRIVATE PERSONAL LOCATION'));
  assert.equal((await call(display,'get','/auth/me')).user.id,1);
  await display.click('.nav-sidebar [data-device-return], [data-temporary-access] button');
  await display.waitForFunction(() => document.querySelector('#weather-widget')?.textContent.includes('Synthetic Household Town'));
  await weather(); assert.equal((await call(display,'get','/auth/me')).user.id,null);
  await display.reload(); await weather();
});

test('hiding or denying Weather and denying Overview prevents weather in cards and masthead', async () => {
  const initial = storedDevice(), prefs = JSON.parse(initial.preferences_json), perms = JSON.parse(initial.permissions_json);
  const apply = async (permissions, preferences) => { await call(admin,'patch',`/devices/${deviceId}`,{revision:storedDevice().revision,permissions,preferences}); await overview(); };
  prefs.widgets.find(w => w.id === 'weather').visible = false; await apply(perms,prefs);
  assert.deepEqual(await call(display,'get','/weather'),{data:null}); assert.equal(await display.$('#weather-widget, .dashboard-overview__weather'),null);
  prefs.widgets.find(w => w.id === 'weather').visible = true; perms.widgets.weather='none'; await apply(perms,prefs);
  assert.equal(await status(display,'/weather'),403); assert.equal(await display.$('#weather-widget, .dashboard-overview__weather'),null);
  perms.widgets.weather='allow'; perms.modules.dashboard='none';
  await call(admin,'patch',`/devices/${deviceId}`,{revision:storedDevice().revision,permissions:perms,preferences:prefs});
  const bootstrap=display.waitForResponse(res=>res.url().endsWith('/device/launch')&&res.status()===200);
  await display.goto(origin+'/device'); await bootstrap;
  await display.waitForFunction(async()=>{const {deviceContext}=await import('/utils/device-context.js');return !!deviceContext();});
  assert.equal(await status(display,'/weather'),403);
  perms.modules.dashboard='read'; await apply(perms,prefs); await weather();
});

test('legacy provider renders local condition icons without opening icon routes or geolocation', async () => {
  setting('weather_provider','openweathermap'); await overview(); await weather();
  assert.equal(await display.$('#weather-widget img'),null);
  assert.ok(await display.$('#weather-widget svg'));
  assert.equal(await status(display,'/weather/icon/01d'),403);
  await screenshot('legacy-provider');
  assert.equal(evidence.weatherRequests.filter(r => r.path.startsWith('/api/v1/weather/icon')).length,1,'only the explicit negative API test requested an icon');
  assert.deepEqual(evidence.errors,[]);
});
