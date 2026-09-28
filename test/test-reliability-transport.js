import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const readSource = path => readFileSync(process.env.RELIABILITY_SOURCE_ROOT ? resolve(process.env.RELIABILITY_SOURCE_ROOT, path) : new URL(`../${path}`, import.meta.url), 'utf8');

function events() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    emit(type, detail = {}) { this.dispatchEvent({ type, ...detail }); } };
}
function apiHarness(fetchImpl) {
  const window = events(), requests = [], active = new Set(); let epoch = 1;
  const scope = { window, document: { cookie: '' }, AbortController, Response, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options, requests.length); },
    authenticationSnapshot: () => ({ epoch, context: 'device-test-context' }), sameAuthentication: value => value.epoch === epoch,
    trackContextRequest: controller => { active.add(controller); return () => active.delete(controller); },
    acceptAuthentication() {}, pairedDeviceHint: () => false,
    clearApiCache() {}, setPermissions() {}, clearPermissions() {}, setHouseholdSize() {}, clearHouseholdSize() {}, forgetLayoutHint() {}, broadcastSessionChange() {}, setWallModeEnabled() {},
  };
  const source = readSource('public/api.js').replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^\n]+\};?$/gm, '');
  vm.runInNewContext(`${source}\nthis.subject={api,ApiError};`, scope);
  return { ...scope.subject, window, requests, changeContext() { epoch++; for (const controller of active) controller.abort(); }, active };
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('permission denial is one rejected mutation, not a CSRF retry', async () => {
  const h = apiHarness(() => json({ error: 'Not permitted', reason: 'device_access_denied' }, 403, { 'X-CSRF-Token': 'current-token' }));
  await assert.rejects(h.api.patch('/tasks/1', { completed: true }), error => error.status === 403 && error.data.reason === 'device_access_denied');
  assert.equal(h.requests.length, 1);
});
test('only an explicit CSRF rejection retries once using the same request identity', async () => {
  const h = apiHarness((url, options, count) => count === 1 ? json({ error: 'Invalid CSRF token.' }, 403, { 'X-CSRF-Token': 'refreshed' }) : json({ ok: true }));
  await h.api.patch('/tasks/1', { completed: true }, { headers: { 'Idempotency-Key': 'same-operation' } });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].options.headers['X-CSRF-Token'], 'refreshed');
  assert.equal(h.requests[1].options.headers['Idempotency-Key'], 'same-operation');
});
test('HTML upstream 502 retains status and unknown write outcome without expiry or retry', async () => {
  const h = apiHarness(() => new Response('<html>Bad gateway</html>', { status: 502 })); let expired = 0;
  h.window.addEventListener('auth:expired', () => expired++);
  await assert.rejects(h.api.patch('/tasks/1', { completed: true }), error => error.status === 502 && error.transient === true && error.outcome === 'unknown');
  assert.equal(h.requests.length, 1); assert.equal(expired, 0);
});
test('interrupted network mutation is unknown, never blindly retried', async () => {
  const h = apiHarness(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(h.api.post('/rewards/1/redeem', {}), error => error.status === 0 && error.transient === true && error.outcome === 'unknown');
  assert.equal(h.requests.length, 1);
});
test('truncated successful JSON cannot become a false successful mutation', async () => {
  const h = apiHarness(() => new Response('{"task":', { status: 200 }));
  await assert.rejects(h.api.patch('/tasks/1', {}), error => error.outcome === 'unknown' && error.data.reason === 'invalid_response');
});
test('204 remains valid and 429 exposes bounded Retry-After without retry or expiry', async () => {
  const h = apiHarness((url, options, count) => count === 1 ? new Response(null, { status: 204 }) : json({ error: 'Slow down' }, 429, { 'Retry-After': '17' }));
  assert.equal(await h.api.delete('/tasks/1'), null);
  await assert.rejects(h.api.get('/tasks'), error => error.status === 429 && error.retryAfterMs === 17_000);
  assert.equal(h.requests.length, 2);
});
test('a genuine 401 expires access and context change rejects delayed response', async () => {
  const h = apiHarness(() => json({ error: 'Sign in' }, 401)); let expired = 0; h.window.addEventListener('auth:expired', () => expired++);
  await assert.rejects(h.api.get('/tasks')); assert.equal(expired, 1);
  let resolve;
  const delayed = apiHarness(() => new Promise(done => { resolve = done; })); const pending = delayed.api.get('/tasks');
  delayed.changeContext(); resolve(json({ secret: 'must not publish' }));
  await assert.rejects(pending, error => error.data?.reason === 'auth_context_changed');
});
test('canonical readback rejects an older service-worker snapshot rather than settling an uncertain write', async () => {
  const h = apiHarness(() => json({ data: [{ id: 1, completed: false }] }, 200, { 'x-cached-at': '1000' }));
  await assert.rejects(h.api.get('/tasks', { requireFresh: true }), error => error.status === 503 && error.transient && error.data?.reason === 'stale_response');
  assert.equal(h.requests[0].options.requireFresh, undefined, 'client-only option is not a fetch option');
  assert.equal((await h.api.get('/tasks')).data[0].id, 1, 'explicit offline read-only display remains supported');
});
test('authentication context remains tracked until response body finishes', async () => {
  let finish, begin;
  const bodyStarted = new Promise(resolve => { begin = resolve; });
  const h = apiHarness(() => ({ status: 200, ok: true, headers: new Headers(), json: () => { begin(); return new Promise(resolve => { finish = resolve; }); } }));
  const pending = h.api.get('/tasks'); await bodyStarted;
  assert.equal(h.active.size, 1); h.changeContext(); finish({ data: 'private' });
  await assert.rejects(pending, error => error.data?.reason === 'auth_context_changed'); assert.equal(h.active.size, 0);
});

function liveHarness(kind = 'tasks') {
  const window = events(), document = { ...events(), hidden: false }, navigator = { onLine: true }, timers = new Map(), streams = [];
  let id = 0, now = 0, reads = 0, rejected = false, authRead = null;
  class Source {
    constructor(url) { Object.assign(this, events()); this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; this.closed = true; }
  }
  const scope = { window, document, navigator, EventSource: Source, deviceContext: () => 'test-context',
    auth: { me: async () => { reads++; if (authRead) return authRead(); if (rejected) throw Object.assign(new Error('unavailable'), { status: 502 }); } },
    api: { get: async () => { reads++; if (rejected) throw Object.assign(new Error('unavailable'), { status: 502 }); } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }), Date: { now: () => now },
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout(key) { timers.delete(key); },
  };
  const file = kind === 'device' ? 'device-session' : kind === 'rewards' ? 'reward-live' : 'task-live';
  const factory = kind === 'device' ? 'deviceChanges' : kind === 'rewards' ? 'watchRewardChanges' : 'watchTaskChanges';
  const source = readSource(`public/utils/${file}.js`).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(`${source}\nthis.subject={watchTaskChanges:${factory}};`, scope);
  return { ...scope.subject, window, document, navigator, streams, timers, reads: () => reads, rejectAuth(value) { rejected = value; }, setAuthRead(read) { authRead = read; },
    async advance(ms) { const end = now + ms; for (;;) { const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); await due[1].fn(); await Promise.resolve(); } now = end; },
  };
}
test('stream outage closes native retry loop and does not fan out failed-auth refreshes', async () => {
  const h = liveHarness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++); h.rejectAuth(true);
  h.streams[0].emit('error'); await h.advance(100);
  assert.equal(h.streams[0].closed, true); assert.equal(refresh, 0);
  const firstAttempts = h.streams.length; await h.advance(500); assert.equal(h.streams.length, firstAttempts);
  stop(); assert.equal(h.timers.size, 0);
});
test('auth ending cannot be undone by focus/online and stale stream events', async () => {
  const h = liveHarness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.window.emit('auth:context-ending'); h.window.emit('focus'); h.window.emit('online'); h.streams[0].emit('change', { data: '{"version":1}' }); await h.advance(100);
  assert.equal(h.streams.length, 1); assert.equal(refresh, 0); stop();
});
test('ordinary version notifications do not each perform an authentication read', async () => {
  const h = liveHarness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
  h.streams[0].readyState = 1; h.streams[0].emit('open'); await h.advance(100); const initial = h.reads();
  for (let version = 1; version <= 4; version++) { h.streams[0].emit('change', { data: JSON.stringify({ version }) }); await h.advance(100); }
  assert.equal(h.reads(), initial); assert.equal(refresh, 5); stop();
});
test('one reconnect catch-up after a burst; observers share one connection', async () => {
  const h = liveHarness(); let a = 0, b = 0; const stops = [h.watchTaskChanges(() => a++), h.watchTaskChanges(() => b++)];
  h.streams[0].readyState = 1; h.streams[0].emit('open'); h.streams[0].emit('change', { data: '{"version":2}' }); h.window.emit('focus'); h.window.emit('online');
  await h.advance(100); assert.equal(h.streams.length, 1); assert.equal(a, 1); assert.equal(b, 1); stops.forEach(stop => stop());
});
for (const kind of ['device', 'rewards']) {
  test(`${kind} old-context stream cannot restart after authentication ends`, async () => {
    const h = liveHarness(kind); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++);
    h.window.emit('auth:context-ending'); h.window.emit('online'); h.document.emit('visibilitychange'); h.streams[0].emit('change', { data: '{"version":1}' }); await h.advance(200);
    assert.equal(h.streams.length, 1); assert.equal(refresh, 0); stop(); assert.equal(h.timers.size, 0);
  });
  test(`${kind} repeated errors stop native reconnection and bound new attempts`, async () => {
    const h = liveHarness(kind); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++); h.rejectAuth(true);
    for (let index = 0; index < 30; index++) { h.streams.at(-1).emit('error'); await h.advance(1000); }
    assert.ok(h.streams.length <= 6, `bounded attempts: ${h.streams.length}`);
    assert.ok(refresh <= 1, `bounded failed refreshes: ${refresh}`);
    assert.ok(h.streams.slice(0, -1).every(source => source.closed)); stop(); assert.equal(h.timers.size, 0);
  });
}
test('Task outage uses bounded attempts, clears timers, and catches up once after recovery', async () => {
  const h = liveHarness(); let refresh = 0; const stop = h.watchTaskChanges(() => refresh++); h.rejectAuth(true);
  for (let index = 0; index < 30; index++) { h.streams.at(-1).emit('error'); await h.advance(1000); }
  assert.ok(h.streams.length <= 6); assert.equal(refresh, 0);
  h.rejectAuth(false); await h.advance(32_000); const current = h.streams.at(-1);
  current.readyState = 1; current.emit('open'); current.emit('change', { data: '{"version":10}' }); await h.advance(100);
  assert.equal(refresh, 1); stop(); assert.equal(h.timers.size, 0);
});
test('a version arriving during a failed auth probe cannot bypass the failed probe', async () => {
  const h = liveHarness(); let fail, refresh = 0, attempts = 0;
  h.setAuthRead(() => ++attempts === 1 ? new Promise((_, reject) => { fail = reject; }) : Promise.reject(new Error('still unavailable')));
  const stop = h.watchTaskChanges(() => refresh++); h.streams[0].readyState = 1; h.streams[0].emit('open');
  const waiting = h.advance(100); await Promise.resolve();
  h.streams[0].emit('change', { data: '{"version":9}' }); fail(new Error('unavailable')); await waiting; await h.advance(100);
  assert.equal(refresh, 0); assert.equal(h.reads(), 1); stop();
});
