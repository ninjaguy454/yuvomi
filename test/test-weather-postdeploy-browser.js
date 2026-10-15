import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const folder = mkdtempSync(join(tmpdir(), 'vidamia-weather-postdeploy-'));
const now = Date.parse('2026-10-15T01:08:00.000Z');
Object.assign(process.env, { DB_PATH: join(folder, 'synthetic.db'), SESSION_SECRET: 'synthetic-postdeploy-only',
  SESSION_SECURE: 'false', BACKUP_ENABLED: 'false', NODE_ENV: 'development', LOG_LEVEL: 'error', AUTH_ALLOW_PASSWORD_LOGIN: 'true' });
delete process.env.DB_ENCRYPTION_KEY;
const { get } = await import('../server/db.js');
const { hashPassword } = await import('../server/utils/password.js');
const { defaultNamedAppearance } = await import('../public/utils/named-appearance.js');
const { saveWallConfig, WALL_DEFAULTS } = await import('../server/services/wall.js');
const { createDevice, normalizeDevicePreferences, deviceHash, devicePreset } = await import('../server/services/devices.js');
const db = get(), password = 'SyntheticWeatherPostdeploy!', selected = { ...defaultNamedAppearance(), theme: 'local-weather' };
db.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role,onboarding_version) VALUES(1,'weatherbug','Synthetic parent',?,'admin','parent',1)").run(await hashPassword(password, 4));
for (const [key, value] of Object.entries({ weather_provider: 'open-meteo', weather_lat: '40', weather_lon: '-75',
  weather_city: 'Synthetic household', 'weather_lat:user:1': '1', 'weather_lon:user:1': '2',
  'named_appearance:user:1': JSON.stringify(selected) })) db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key, value);
for (let i = 0; i < 6; i++) {
  const task = Number(db.prepare("INSERT INTO tasks(title,created_by,assigned_to,visibility,points) VALUES(?,1,1,'all',5)").run('Synthetic nighttime task ' + i).lastInsertRowid);
  db.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,1)').run(task);
}
saveWallConfig(db, { ...structuredClone(WALL_DEFAULTS), appearance: { ...WALL_DEFAULTS.appearance, named_appearance: selected } });
const preferences = normalizeDevicePreferences(db, {});
preferences.allow_theme_changes = true; preferences.appearance.named_appearance = selected;
preferences.default_view = 'list';
const permissions = devicePreset(); permissions.widgets.weather = 'allow';
const device = createDevice(db, { name: 'Synthetic Weather display', permissions, preferences }, 1), token = 'synthetic-postdeploy-' + device.id;
db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(device.id, deviceHash(token), 'synthetic-postdeploy-context-' + device.id);
const storedPermissions = db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json;
const settingSnapshot = () => db.prepare("SELECT key,value FROM sync_config WHERE key LIKE 'weather_%' ORDER BY key").all();
const storedSettings = settingSnapshot();
let browser, server, origin;
const report = { base: 'e1cf3378a41b57ef346eb55bf3fec39bf1819c40', syntheticData: true,
  fixedUtcNow: new Date(now).toISOString(), samples: [], screenshots: [], errors: [] };
const output = process.env.WEATHER_POSTDEPLOY_EVIDENCE;
const capture = async (page, name) => { if (output) { mkdirSync(output, { recursive: true }); await page.screenshot({ path: join(output, name + '.png') }); report.screenshots.push(name + '.png'); } };
test.before(async () => {
  server = fork(new URL('./helpers/weather-postdeploy-full-app-server.mjs', import.meta.url), [],
    { env: { ...process.env, PORT: '0', WEATHER_FIXTURE_NOW: new Date(now).toISOString() }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let log = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => log = (log + data).slice(-5000));
  origin = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 30000);
    server.once('message', message => { clearTimeout(timer); resolve(message.origin); }); server.once('exit', code => { clearTimeout(timer); reject(Error(code + ': ' + log)); }); });
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, args: ['--mute-audio'] });
  report.browserPid = browser.process()?.pid; report.serverPid = server.pid;
});
test.after(async () => {
  await browser?.close(); report.browserClosed = true;
  if (server?.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  report.serverClosed = true;
  report.settingsUnchanged = JSON.stringify(settingSnapshot()) === JSON.stringify(storedSettings);
  report.permissionsUnchanged = db.prepare('SELECT permissions_json FROM household_devices WHERE id=?').get(device.id).permissions_json === storedPermissions;
  db.close();
  if (output) { mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'weather-postdeploy-browser.json'), JSON.stringify(report, null, 2) + '\n'); }
  assert.equal(report.settingsUnchanged, true, 'Weather correction cannot change household settings');
  assert.equal(report.permissionsUnchanged, true, 'Weather correction cannot change device grants');
  assert.deepEqual(report.errors, [], 'actual app has no runtime errors');
});
async function setServerClock(value) {
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => {server.off('message',ack);reject(Error('Synthetic clock acknowledgement missing'));},5000);
    const ack = message => {if(message?.type==='weather-fixture-clock'&&message.now===value){clearTimeout(timer);server.off('message',ack);resolve();}};
    server.on('message',ack);server.send({type:'weather-fixture-clock',now:value});
  });
}
async function pageFor(kind, viewport, clock = now) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  page.setDefaultTimeout(15000); page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: viewport.width < 900, hasTouch: true });
  await page.evaluateOnNewDocument((fixed, paired) => {
    window.weatherFixtureNow = fixed;
    const NativeDate = Date; window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.weatherFixtureNow])); } static now() { return window.weatherFixtureNow; }
    };
    localStorage.setItem('yuvomi-lang', 'en'); localStorage.setItem('yuvomi-locale', 'en');
    if (paired) localStorage.setItem('vidamia-paired-device', '1');
    window.weatherFirstFacts = null;
    new MutationObserver(() => {
      const stage = document.querySelector('.local-weather-scene');
      if (!window.weatherFirstFacts && stage?.dataset.rich === 'true') window.weatherFirstFacts = {
        phase: stage.dataset.phase, dayOpacity: Number(stage.querySelector('[data-grade="clear-day"]').style.opacity)
      };
    }).observe(document, {subtree:true, childList:true, attributes:true, attributeFilter:['data-rich','data-phase']});
  }, clock, kind === 'paired');
  const focus = await page.createCDPSession(); await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await focus.detach();
  if (kind === 'paired') await page.setCookie({ name: 'vidamia.device', value: token, url: origin, httpOnly: true });
  else {
    await page.goto(origin + '/login'); await page.waitForSelector('#username'); await page.type('#username', 'weatherbug'); await page.type('#password', password);
    await page.click('[type=submit]'); await page.waitForSelector('.dashboard');
    if (kind === 'wall') await page.evaluate(async () => { await (await import('/api.js')).api.post('/wall/enter', {}); (await import('/utils/wall-mode.js')).setWallModeEnabled(true); });
  }
  await page.goto(origin + (kind === 'wall' ? '/' : '/tasks?view=list'));
  try { await page.waitForSelector(kind === 'wall' ? '[data-wall-grid]' : '.activity-card'); }
  catch (error) { console.error('WEATHER_FIXTURE_LOAD_FAILURE', await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0,1500) }))); await context.close(); throw error; }
  await page.waitForSelector('.local-weather-scene');
  await page.waitForFunction(() => [...document.querySelectorAll('.local-weather-art')].every(image => image.complete && image.naturalWidth));
  return { page, context };
}
async function sample(page, kind) {
  const row = await page.evaluate(async kind => {
    const envelope = (await (await import('/api.js')).api.get(kind.startsWith('wall') ? '/wall/weather/scene' : '/weather/scene')).data;
    const stage = document.querySelector('.local-weather-scene'), art = stage.querySelector('[data-grade="clear-night"]'), r = art.getBoundingClientRect();
    return { kind, clock: new Date().toISOString(), envelope, firstFacts: window.weatherFirstFacts, namedTheme: document.documentElement.dataset.namedTheme, phase: stage.dataset.phase,
      grades: Object.fromEntries([...stage.querySelectorAll('.local-weather-art')].map(image => [image.dataset.grade, Number(image.style.opacity)])),
      image: { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, objectFit: getComputedStyle(art).objectFit },
      viewport: { width: innerWidth, height: innerHeight },
      shell: ['.app-shell', '.app-content'].map(selector => { const css = getComputedStyle(document.querySelector(selector)); return { selector, background: css.backgroundColor, image: css.backgroundImage }; }) };
  }, kind);
  report.samples.push(row); console.log('WEATHER_POSTDEPLOY_SAMPLE ' + JSON.stringify(row)); return row;
}

test('mounted idle Wall updates across sunset through its normal minute timer without navigation', async () => {
  const beforeSunset = Date.parse('2026-10-14T21:59:00.000Z'), afterSunset = Date.parse('2026-10-14T22:41:00.000Z');
  await setServerClock(beforeSunset);
  const {page,context} = await pageFor('wall',{width:1280,height:800},beforeSunset);
  try {
    await page.waitForFunction(() => document.querySelector('.local-weather-scene').dataset.phase==='day');
    const before = await sample(page,'wall-before-sunset');
    assert.match(before.namedTheme,/-day$/);assert.equal(before.envelope.theme.is_day,true);
    await page.evaluate(next => {window.weatherOriginalStage=document.querySelector('.local-weather-scene');window.weatherFixtureNow=next;},afterSunset);
    const started = Date.now();
    await page.waitForFunction(() => document.documentElement.dataset.namedTheme.endsWith('-night')&&document.querySelector('.local-weather-scene').dataset.phase==='night', {timeout:70000,polling:250});
    const after = await sample(page,'wall-after-sunset');after.realTimerWaitMs=Date.now()-started;
    assert.equal(await page.evaluate(() => document.querySelector('.local-weather-scene')===window.weatherOriginalStage),true,'board keeps its mounted scene');
    assert.equal(after.envelope.theme.is_day,true,'cached reported flag stays daytime; valid sunset drives the current phase');
    assert.equal(after.envelope.theme.observed_at,before.envelope.theme.observed_at);
    assert.match(after.namedTheme,/-night$/);assert.equal(after.phase,'night');
    await capture(page,'wall-open-across-sunset');assert.deepEqual(report.errors,[]);
  } finally {await context.close();}
});

test('reported Eastern nighttime reaches personal phone, Wall tablet and paired Tasks without changing household facts', async () => {
  await setServerClock(now);
  for (const [kind, viewport] of [['personal', { width: 390, height: 844 }], ['wall', { width: 1280, height: 800 }], ['paired', { width: 768, height: 1024 }]]) {
    const { page, context } = await pageFor(kind, viewport);
    try {
      await page.waitForFunction(() => document.querySelector('.local-weather-scene').dataset.phase === 'night', { timeout: 6000 });
      const row = await sample(page, kind); await capture(page, 'night-' + kind);
      assert.equal(row.envelope.theme.is_day, false); assert.equal(row.envelope.scene.solar.is_day, false);
      assert.equal(row.envelope.theme.observed_at, '2026-10-15T01:08:00.000Z');
      assert.equal(row.envelope.theme.sunset_at, '2026-10-14T22:20:00.000Z');
      assert.match(row.namedTheme, /-night$/); assert.equal(row.phase, 'night');
      assert.equal(row.firstFacts.phase, 'night', 'first valid night facts cannot paint a daytime frame');
      assert.equal(row.firstFacts.dayOpacity, 0);
      assert.ok(row.grades['clear-day'] < .25); assert.deepEqual(report.errors, []);
    } finally { await context.close(); }
  }
});

test('Tasks painting covers the phone viewport in portrait and landscape for personal and paired views', async () => {
  await setServerClock(now);
  for (const kind of ['personal', 'paired']) {
    const { page, context } = await pageFor(kind, { width: 390, height: 844 });
    try {
      for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
        await page.waitForFunction(width => document.querySelector('.local-weather-scene').getBoundingClientRect().width === width, {}, viewport.width);
        const row = await sample(page, kind); await capture(page, 'tasks-' + kind + '-' + viewport.width + 'x' + viewport.height);
        assert.ok(row.image.x <= 1 && row.image.y <= 1 && row.image.width >= row.viewport.width - 1 && row.image.bottom >= row.viewport.height - 1,
          'actual Tasks artwork must cover viewport rather than stop at the top strip: ' + JSON.stringify(row.image));
        assert.ok(row.shell.every(css => css.background === 'rgba(0, 0, 0, 0)' && css.image === 'none'));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
    } finally { await context.close(); }
  }
});
