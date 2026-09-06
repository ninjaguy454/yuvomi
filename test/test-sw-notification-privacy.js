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
  return { caches, dispatch, shown, navigated, closed: () => closed };
}

const push = (env, payload = { title: 'Tasks', body: 'Private task', notificationId: 42 }) =>
  env.dispatch('push', { data: { json: () => payload } });

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
