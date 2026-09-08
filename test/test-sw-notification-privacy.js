import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://household.example.test';

function storage() {
  const entries = new Map();
  return {
    async open(name) {
      if (!entries.has(name)) entries.set(name, new Map());
      const values = entries.get(name);
      const key = (input) => new URL(input.url || input, origin).pathname;
      return {
        async put(input, value) { values.set(key(input), value); },
        async match(input) { return values.get(key(input)); },
        async delete(input) { return values.delete(key(input)); },
        async keys() { return [...values.keys()].map((path) => new Request(new URL(path, origin))); },
      };
    },
    async keys() { return [...entries.keys()]; },
    async delete(name) { return entries.delete(name); },
  };
}

function worker(caches = storage()) {
  const listeners = {}, shown = [], navigated = [];
  let closed = 0;
  const client = { focus: async () => {}, navigate: async (url) => navigated.push(url), postMessage() {} };
  const clients = { matchAll: async () => [client], openWindow: async (url) => navigated.push(url), claim: async () => {} };
  const self = {
    location: { origin }, clients,
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    skipWaiting: async () => {},
    registration: {
      showNotification: async (title, options) => shown.push({ title, options }),
      getNotifications: async () => [{ close() { closed++; } }],
    },
  };
  runInNewContext(source, { self, clients, caches, URL, Request, Response, Headers, console });
  async function dispatch(type, event = {}) {
    const waits = [];
    for (const listener of listeners[type] || []) listener({ ...event, waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
  }
  return { caches, dispatch, shown, navigated, clients, self, closed: () => closed };
}

const push = (env, payload = { title: 'Tasks', body: 'Private task', notificationId: 42 }) =>
  env.dispatch('push', { data: { json: () => payload } });

test('device notifications use Vidamia branding while preserving existing notification identity', async () => {
  const env = worker();
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  await push(env, { body: 'Ready to cook', notificationId: 42 });
  await env.dispatch('push', { data: { json() { throw new Error('Plain text payload'); }, text: () => 'A household reminder' } });
  assert.deepEqual(env.shown.map(notification => notification.title), ['Vidamia', 'Vidamia']);
  for (const { options } of env.shown) {
    assert.equal(options.icon, '/icons/icon-192.png');
    assert.equal(options.badge, '/icons/notification-badge.png');
    assert.equal(options.tag, 'yuvomi-push');
  }
  assert.equal(env.shown[0].options.data.notificationId, 42);
  assert.equal(env.shown[1].options.body, 'A household reminder');
});

test('first upgrade with no saved device privacy state suppresses personal push until verified', async () => {
  const env = worker();
  await push(env);
  await env.dispatch('notificationclick', { notification: { data: { notificationId: 42 }, close() {} } });
  assert.equal(env.shown.length, 0);
  assert.deepEqual(env.navigated, []);
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  await push(env);
  assert.equal(env.shown.length, 1);
});

test('shared-display privacy closes visible notifications even when storage cannot persist the flag', async () => {
  const caches = storage();
  const open = caches.open.bind(caches);
  const oldCache = await open('yuvomi-device-privacy');
  await oldCache.put('/shared-display', new Response('', { headers: { 'x-shared-display': '0' } }));
  caches.open = async (name) => {
    const cache = await open(name);
    if (name === 'yuvomi-device-privacy') cache.put = async () => { throw new Error('Quota exceeded'); };
    return cache;
  };
  const env = worker(caches);
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } });
  assert.equal(env.closed(), 1);
  await push(env);
  assert.equal(env.shown.length, 0);
  const restarted = worker(caches);
  await push(restarted);
  assert.equal(restarted.shown.length, 0);
});

test('shared-device suppression persists across worker restart, logout and upgrade', async () => {
  const first = worker();
  await first.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } });
  assert.equal(first.closed(), 1);
  await push(first);
  assert.equal(first.shown.length, 0);
  await first.dispatch('message', { data: { type: 'CLEAR_API_CACHE' } });
  await first.dispatch('activate');
  assert.ok((await first.caches.keys()).includes('yuvomi-device-privacy'));
  const restarted = worker(first.caches);
  await push(restarted);
  assert.equal(restarted.shown.length, 0);
});

test('personal-device push carries its canonical inbox id and authenticated handoff', async () => {
  const env = worker();
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  await push(env);
  assert.equal(env.shown.length, 1);
  assert.equal(env.shown[0].options.data.notificationId, 42);
  await env.dispatch('notificationclick', { notification: { data: env.shown[0].options.data, close() {} } });
  assert.deepEqual(env.navigated, ['/?notification=42']);
});

test('shared-device clicks do not open personal content and external click targets are rejected', async () => {
  const shared = worker();
  await shared.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } });
  await shared.dispatch('notificationclick', { notification: { data: { notificationId: 42 }, close() {} } });
  assert.deepEqual(shared.navigated, []);
  const env = worker();
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  for (const url of ['https://unrelated.example.test/private', 'javascript:alert(1)', '//unrelated.example.test/']) {
    await env.dispatch('notificationclick', { notification: { data: { url }, close() {} } });
  }
  assert.deepEqual(env.navigated, ['/', '/', '/']);
});

test('the most recent shared-device setting survives rapid toggles', async () => {
  const env = worker();
  await Promise.all([
    env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } }),
    env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } }),
  ]);
  const restarted = worker(env.caches);
  await push(restarted);
  assert.equal(restarted.shown.length, 0);
});

test('a notification that finishes showing after wall mode starts is closed again', async () => {
  const env = worker();
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  let finishShowing;
  env.self.registration.showNotification = () => new Promise((resolve) => { finishShowing = resolve; });
  const delivery = push(env);
  await new Promise((resolve) => setImmediate(resolve));
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } });
  const closedBeforeCompletion = env.closed();
  finishShowing();
  await delivery;
  assert.equal(env.closed(), closedBeforeCompletion + 1);
});

test('wall mode enabled while finding a notification destination prevents navigation', async () => {
  const env = worker();
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: false } });
  let finishLookup;
  env.clients.matchAll = () => new Promise((resolve) => { finishLookup = resolve; });
  const click = env.dispatch('notificationclick', { notification: { data: { notificationId: 42 }, close() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  await env.dispatch('message', { data: { type: 'SET_SHARED_DISPLAY', enabled: true } });
  finishLookup([{ focus() {}, navigate(url) { env.navigated.push(url); } }]);
  await click;
  assert.deepEqual(env.navigated, []);
});
