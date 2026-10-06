import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'synthetic-weather-tests';
for (const key of Object.keys(process.env)) if (/^(WEATHER_|OPENWEATHER_)/.test(key)) delete process.env[key];
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { createDevice, updateDevice, devicePreset, normalizeDevicePermissions, deviceHash } = await import('../server/services/devices.js');
const { deviceAppMiddleware, deviceAppPreferences, deviceAppRouteSupported } = await import('../server/services/device-app.js');
const { default: weatherRouter } = await import('../server/routes/weather.js');
const realFetch = globalThis.fetch;
let db, principal, server, base, upstream, sequence = 0;
const setting = (key, value) => db.prepare('INSERT OR REPLACE INTO sync_config(key,value) VALUES(?,?)').run(key, value);
test.beforeEach(async () => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  for (const m of ALL_MIGRATIONS) { typeof m.up === 'function' ? m.up(db) : db.exec(m.up); m.afterUp?.(db); }
  _setTestDatabase(db);
  db.exec("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(1,'Parent','Parent','synthetic','admin')");
  setting('weather_lat', String(40 + ++sequence / 100)); setting('weather_lon', '-75');
  setting('weather_city', 'Household forecast'); setting('weather_units', 'imperial');
  setting('weather_lat:user:1', '1'); setting('weather_lon:user:1', '2');
  setting('weather_city:user:1', 'PRIVATE PERSONAL LOCATION'); setting('weather_auto_locate', '1');
  principal = { kind: 'device', ...createDevice(db, { name: 'Synthetic display' }, 1) };
  // Model an explicit administrator grant independently of normalization.
  principal.permissions.widgets.weather = 'allow';
  principal.preferences.widgets.push({ id: 'weather', visible: true, size: 'medium', order: 20 });
  principal.preferences.widgets = [...new Map(principal.preferences.widgets.map(w => [w.id, w])).values()];
  upstream = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    const parsed = new URL(url); upstream.push(parsed);
    assert.equal(parsed.hostname, 'api.open-meteo.com');
    return { ok: true, json: async () => ({ current: { temperature_2m: 68, apparent_temperature: 67, relative_humidity_2m: 50, is_day: 1, weather_code: 2, wind_speed_10m: 4 }, daily: { time: [new Date().toISOString().slice(0,10)], weather_code: [2], temperature_2m_max: [72], temperature_2m_min: [55] } }) };
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.devicePrincipal = principal; req.authUserId = 1; req.session = { userId: 1 }; next(); });
  app.use('/api/v1', deviceAppMiddleware); app.use('/api/v1/weather', weatherRouter);
  app.use((_req, res) => res.json({ private: 'HUMAN ROUTER' }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
test.afterEach(async () => { globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); _setTestDatabase(null); db.close(); });
const read = async (path = '/weather', method = 'GET') => { const response = await fetch(base + path, { method }); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() }; };

test('allowed Weather uses household configuration without personal overrides, coordinates or auto-location preferences', async () => {
  const result = await read('/weather?city=PRIVATE&lat=1&lon=2&user_id=1&lang=en');
  assert.equal(result.status, 200); assert.equal(result.body.data.city, 'Household forecast');
  assert.equal(result.body.data.units, 'imperial'); assert.equal(result.cache, 'private, no-store');
  assert.equal(upstream.length, 1); assert.equal(upstream[0].searchParams.get('latitude'), String(40 + sequence / 100));
  assert.equal(upstream[0].searchParams.get('longitude'), '-75');
  assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
  assert.equal(result.body.data.latitude, undefined); assert.equal(result.body.data.longitude, undefined);
  const prefs = deviceAppPreferences(db, principal);
  assert.equal(prefs.dashboard_widgets.find(w => w.id === 'weather').visible, true);
  assert.ok(!Object.keys(prefs).some(key => key.startsWith('weather_')));
});

test('Weather denial, hidden widget and dashboard denial do not disclose a forecast or fall through', async () => {
  principal.permissions.widgets.weather = 'none';
  assert.equal((await read()).status, 403);
  delete principal.permissions.widgets.weather;
  assert.equal((await read()).status, 403);
  principal.permissions.widgets.weather = 'allow'; principal.permissions.modules.dashboard = 'none';
  assert.equal((await read()).status, 403);
  principal.permissions.modules.dashboard = 'read'; principal.preferences.widgets.find(w => w.id === 'weather').visible = false;
  assert.deepEqual((await read()).body, { data: null }); assert.equal(upstream.length, 0);
});

test('only the forecast read is admitted; writes, personal settings and unrelated APIs remain denied', async () => {
  assert.equal(deviceAppRouteSupported('GET', '/api/v1/weather?lang=en'), true);
  for (const [path, method] of [['/weather','POST'],['/weather','PUT'],['/weather/location','GET'],['/weather/icon/01d','GET'],['/preferences','PUT'],['/documents','GET'],['/auth/api-tokens','GET']]) {
    const result = await read(path, method); assert.equal(result.status, 403, `${method} ${path}`);
    assert.ok(!JSON.stringify(result.body).includes('HUMAN ROUTER'));
  }
});

test('explicit Weather opt-in preserves every unrelated grant; an unrelated save retains Weather denial', () => {
  const before = devicePreset(); assert.equal(before.widgets.weather, 'none');
  const requested = structuredClone(before); requested.widgets.weather = 'allow';
  const normalized = normalizeDevicePermissions(requested);
  assert.deepEqual(normalized, requested);
  assert.throws(() => normalizeDevicePermissions({ ...before, widgets: { ...before.widgets, weather: 'write' } }));
  const device = createDevice(db, { name: 'Denied' }, 1);
  const saved = updateDevice(db, device.id, { revision: device.revision, name: 'Still denied' }, 1);
  assert.deepEqual(saved.permissions, device.permissions);
  assert.equal(saved.preferences.widgets.find(w => w.id === 'weather').visible, false);
  const allowed = updateDevice(db, saved.id, { revision: saved.revision, permissions: { widgets: { weather: 'allow' } } }, 1);
  const expected = structuredClone(saved.permissions); expected.widgets.weather = 'allow';
  assert.deepEqual(allowed.permissions, expected);
});

test('personal Weather cache cannot supply a private label to the device at the same coordinates', async () => {
  setting('weather_lat:user:1', String(40 + sequence / 100)); setting('weather_lon:user:1', '-75');
  const device = principal; principal = null;
  assert.equal((await read()).body.data.city, 'PRIVATE PERSONAL LOCATION');
  principal = device;
  assert.equal((await read()).body.data.city, 'Household forecast');
});

test('unconfigured Weather and provider failures retain the existing empty forecast contract', async () => {
  db.prepare("DELETE FROM sync_config WHERE key LIKE 'weather_%'").run();
  assert.deepEqual((await read()).body, { data: null });
  setting('weather_lat', '48'); setting('weather_lon', '3');
  globalThis.fetch = (url, options) => String(url).startsWith('http://127.0.0.1:') ? realFetch(url, options) : Promise.reject(new Error('Synthetic provider failure'));
  const result = await read(); assert.equal(result.status, 200); assert.deepEqual(result.body, { data: null });
});

test('legacy provider uses the household city rather than a caller-supplied location', async () => {
  setting('weather_provider', 'openweathermap');
  process.env.OPENWEATHER_API_KEY = 'synthetic-test-key'; process.env.OPENWEATHER_CITY = 'Household Town';
  const seen = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    const parsed = new URL(url); seen.push(parsed); assert.equal(parsed.hostname, 'api.openweathermap.org');
    return { ok: true, json: async () => parsed.pathname.endsWith('/forecast') ? { list: [] } : { name: 'Household Town', main: { temp: 70, feels_like: 68, humidity: 55 }, weather: [{ icon: '01d', description: 'Clear' }], wind: { speed: 3 } } };
  };
  try {
    const result = await read('/weather?city=PRIVATE&lang=en%26id%3D12345%26lat%3D1%26lon%3D2');
    assert.equal(result.status, 200); assert.equal(result.body.data.city, 'Household Town');
    assert.ok(seen.every(url => url.searchParams.get('q') === 'Household Town'));
    assert.ok(seen.every(url => !['id','lat','lon'].some(key => url.searchParams.has(key))));
    assert.ok(!JSON.stringify(result.body).includes('synthetic-test-key'));
  } finally { delete process.env.OPENWEATHER_API_KEY; delete process.env.OPENWEATHER_CITY; }
});

test('a forecast held across a device permission update cannot disclose its old authorized response', async () => {
  const { deviceWeather } = await import('../server/services/device-weather.js');
  const token = 'synthetic-weather-credential', context = 'synthetic-weather-context';
  db.prepare('INSERT INTO device_credentials(device_id,token_hash,context_key) VALUES(?,?,?)').run(principal.id,deviceHash(token),context);
  let release, entered;
  const waiting = new Promise(resolve => { entered=resolve; });
  const held = new Promise(resolve => { release=resolve; });
  const prior = globalThis.fetch;
  globalThis.fetch = async (...args) => { entered(); await held; return prior(...args); };
  const req = { devicePrincipal:principal, headers:{cookie:`vidamia.device=${token}`,'x-auth-context':context}, query:{lang:'en'}, method:'GET',url:'/weather',session:{},authUserId:null };
  let result; const finished = new Promise(resolve => { result=resolve; });
  const res = { statusCode:200,status(value){this.statusCode=value;return this;},json(body){result({status:this.statusCode,body});} };
  deviceWeather(req,res); await waiting;
  updateDevice(db,principal.id,{revision:principal.revision,permissions:{widgets:{weather:'none'}}},1);
  release();
  const response=await finished;
  assert.equal(response.status,409); assert.equal(response.body.reason,'device_context_changed');
  assert.ok(!JSON.stringify(response.body).includes('Household forecast'));
});
