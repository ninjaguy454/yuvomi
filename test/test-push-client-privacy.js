import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/push.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/export\s*\{[^}]+\};?\s*$/, '');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function client({ shared = false, subscribed = true, owned = true, post, get, permission, ready } = {}) {
  const state = { shared, local: null, calls: [], messages: [], subscribed: 0, unsubscribed: 0 };
  const listeners = {};
  function subscription() {
    const sub = {
      endpoint: 'https://push.example.test/local-device',
      options: {},
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'key', auth: 'auth' } }; },
      async unsubscribe() { state.unsubscribed++; if (state.local === sub) state.local = null; return true; },
    };
    return sub;
  }
  if (subscribed) state.local = subscription();
  const reg = {
    active: { postMessage: (message) => state.messages.push(message) },
    pushManager: {
      getSubscription: async () => state.local,
      subscribe: async () => { state.subscribed++; state.local = subscription(); return state.local; },
    },
  };
  const api = {
    async get(path) { state.calls.push(path); return get ? get(path) : { data: { key: 'AQID' } }; },
    async post(path, body) { state.calls.push(path); return post ? post(path, body) : { data: { subscribed: owned } }; },
  };
  const Notification = { permission: 'granted', requestPermission: permission || (async () => 'granted') };
  const window = { Notification, PushManager: function () {}, addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); } };
  const sandbox = { api, window, navigator: { serviceWorker: { ready: ready ? ready.then(() => reg) : Promise.resolve(reg) } }, Notification,
    isWallModeEnabled: () => state.shared, atob, Uint8Array, console };
  runInNewContext(`${source}\nglobalThis.clientPush = { initPush, stopPush, pushStatus, enablePush, disablePush, repairPush, resyncSubscription, isPushSubscribed };`, sandbox);
  return { ...sandbox.clientPush, state, async wall(enabled, crossTab = false) {
    state.shared = enabled;
    for (const listener of listeners[crossTab ? 'storage' : 'yuvomi:wall-mode-change'] || []) listener({ key: 'yuvomi-wall-mode' });
    await flush();
  } };
}

test('wall mode revokes the browser even when the server is offline and never auto-enables on exit', async () => {
  const env = client({ shared: true, post: async () => { throw new Error('offline'); } });
  await env.initPush();
  assert.equal(env.state.unsubscribed, 1);
  assert.equal(env.state.local, null);
  assert.equal(env.isPushSubscribed(), false);
  assert.ok(env.state.messages.every((message) => message.enabled === true));
  await env.wall(false);
  assert.equal(env.state.subscribed, 0);
  assert.ok(!env.state.calls.includes('/push/subscribe'));
});

test('startup verifies ownership without silently transferring another users subscription', async () => {
  const env = client({ owned: false });
  await env.initPush();
  assert.equal(env.state.unsubscribed, 1);
  assert.equal(env.isPushSubscribed(), false);
  assert.deepEqual(env.state.calls, ['/push/status']);
  assert.ok(env.state.messages.every((message) => message.enabled === true));
});

test('startup lifts worker suppression only after current-session ownership is verified', async () => {
  const reply = deferred(), started = deferred();
  const env = client({ post: async () => { started.resolve(); return reply.promise; } });
  const init = env.initPush();
  await started.promise;
  assert.ok(env.state.messages.every((message) => message.enabled === true));
  reply.resolve({ data: { subscribed: true } });
  await init;
  assert.equal(env.isPushSubscribed(), true);
  assert.equal(env.state.messages.at(-1).enabled, false);
  assert.ok(!env.state.calls.includes('/push/subscribe'));
});

test('a delayed ownership result after logout cannot restore push state', async () => {
  const reply = deferred(), started = deferred();
  const env = client({ post: async (path) => { if (path === '/push/status') { started.resolve(); return reply.promise; } return {}; } });
  const init = env.initPush();
  await started.promise;
  env.stopPush();
  reply.resolve({ data: { subscribed: true } });
  await init;
  await flush();
  assert.equal(env.isPushSubscribed(), false);
  assert.equal(env.state.local, null);
  assert.equal(env.state.messages.at(-1).enabled, true);
});

test('enabling wall mode while permission is pending prevents subscription creation', async () => {
  const permission = deferred();
  const env = client({ subscribed: false, permission: () => permission.promise });
  await env.initPush();
  const enabling = env.enablePush();
  await env.wall(true);
  permission.resolve('granted');
  assert.equal((await enabling).subscribed, false);
  assert.equal(env.state.subscribed, 0);
  assert.equal(env.isPushSubscribed(), false);
});

test('a registration response after logout cannot reactivate the local subscription', async () => {
  const reply = deferred(), started = deferred();
  const env = client({ subscribed: false, post: async (path) => {
    if (path === '/push/subscribe') { started.resolve(); return reply.promise; }
    return {};
  } });
  await env.initPush();
  const enabling = env.enablePush();
  await started.promise;
  env.stopPush();
  reply.resolve({ data: { id: 1 } });
  assert.equal((await enabling).subscribed, false);
  await flush();
  assert.equal(env.state.local, null);
  assert.equal(env.isPushSubscribed(), false);
  assert.equal(env.state.messages.at(-1).enabled, true);
});

test('cross-tab wall mode changes revoke a verified device subscription', async () => {
  const env = client();
  await env.initPush();
  assert.equal(env.isPushSubscribed(), true);
  await env.wall(true, true);
  assert.equal(env.isPushSubscribed(), false);
  assert.equal(env.state.local, null);
  assert.equal(env.state.messages.at(-1).enabled, true);
});

test('startup waiting for a worker does not resume ownership checks after logout', async () => {
  const ready = deferred();
  const env = client({ ready: ready.promise });
  const initializing = env.initPush();
  env.stopPush();
  ready.resolve();
  await initializing;
  await flush();
  assert.ok(!env.state.calls.includes('/push/status'));
  assert.ok(!env.state.calls.includes('/push/subscribe'));
  assert.equal(env.isPushSubscribed(), false);
  assert.equal(env.state.local, null);
});

test('repair waiting for server keys cannot subscribe after wall mode begins', async () => {
  const keys = deferred(), started = deferred();
  const env = client({ subscribed: false, get: async () => { started.resolve(); return keys.promise; } });
  await env.initPush();
  const repairing = env.repairPush();
  await started.promise;
  await env.wall(true);
  keys.resolve({ data: { key: 'AQID' } });
  assert.equal(await repairing, false);
  assert.equal(env.state.subscribed, 0);
  assert.equal(env.isPushSubscribed(), false);
});
