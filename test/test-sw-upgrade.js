import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const REGISTER_SOURCE = readFileSync(new URL('../public/sw-register.js', import.meta.url), 'utf8')
  .replace('export function clearApiCache()', 'function clearApiCache()');
const ORIGIN = 'https://upgrade.test';

const keyOf = (input) => {
  const raw = typeof input === 'string' ? input : input.url;
  return new URL(raw, ORIGIN).pathname;
};

class MockHeaders {
  constructor(init = {}) {
    this.values = new Map(Object.entries(init).map(([key, value]) => [key.toLowerCase(), String(value)]));
  }
  get(key) { return this.values.get(String(key).toLowerCase()) ?? null; }
  set(key, value) { this.values.set(String(key).toLowerCase(), String(value)); }
}

class MockResponse {
  constructor(body = '', { status = 200, headers = {}, type = 'basic' } = {}) {
    this.body = body;
    this.status = status;
    this.statusText = status === 200 ? 'OK' : 'Error';
    this.ok = status >= 200 && status < 300;
    this.type = type;
    this.headers = headers instanceof MockHeaders ? headers : new MockHeaders(headers);
  }
  clone() { return new MockResponse(this.body, { status: this.status, headers: Object.fromEntries(this.headers.values), type: this.type }); }
  async blob() { return this.body; }
}

class MockRequest {
  constructor(input, init = {}) {
    this.url = new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
    this.method = init.method || input?.method || 'GET';
    this.mode = init.mode || input?.mode || 'same-origin';
    this.cache = init.cache || input?.cache || 'default';
  }
}

class MockCache {
  constructor() { this.entries = new Map(); }
  async put(input, response) { this.entries.set(keyOf(input), response); }
  async match(input) { return this.entries.get(keyOf(input)); }
  async delete(input) { return this.entries.delete(keyOf(input)); }
  async addAll(requests) {
    for (const request of requests) {
      await this.put(request, new MockResponse(`fresh:${keyOf(request)}`));
    }
  }
}

class MockCacheStorage {
  constructor() { this.named = new Map(); }
  async open(name) {
    if (!this.named.has(name)) this.named.set(name, new MockCache());
    return this.named.get(name);
  }
  async keys() { return [...this.named.keys()]; }
  async delete(name) { return this.named.delete(name); }
  async match(input) {
    for (const cache of this.named.values()) {
      const match = await cache.match(input);
      if (match) return match;
    }
    return undefined;
  }
}

function loadWorker({ claimImpl, matchAllImpl } = {}) {
  const listeners = {};
  const caches = new MockCacheStorage();
  const signals = { skipped: 0, claimed: 0, messages: [] };
  const client = { postMessage(message) { signals.messages.push(message); } };
  const self = {
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    skipWaiting() { signals.skipped += 1; return Promise.resolve(); },
    clients: {
      claim() {
        signals.claimed += 1;
        return claimImpl ? claimImpl() : Promise.resolve();
      },
      matchAll() { return matchAllImpl ? matchAllImpl(client) : Promise.resolve([client]); },
    },
    registration: { showNotification() { return Promise.resolve(); } },
    location: { origin: ORIGIN },
  };
  const sandbox = {
    self,
    caches,
    fetch: async (request) => new MockResponse(`network:${keyOf(request)}`),
    Request: MockRequest,
    Response: MockResponse,
    Headers: MockHeaders,
    URL,
    Date,
    Promise,
    JSON,
    Number,
    String,
    Object,
    Array,
    Math,
    Map,
    Set,
    parseInt,
    console,
  };
  runInContext(SW_SOURCE, createContext(sandbox));
  return { listeners, caches, signals };
}

async function dispatchLifecycle(listener) {
  let completion;
  listener({ waitUntil(value) { completion = Promise.resolve(value); } });
  await completion;
}

test('2.51.0 cache upgrades atomically to 2.54.0 with shared Task modules', async () => {
  const env = loadWorker();
  const oldCaches = [
    'yuvomi-shell-2.51.0',
    'yuvomi-pages-2.51.0',
    'yuvomi-locales-2.51.0',
    'yuvomi-assets-2.51.0',
    'yuvomi-api-2.51.0',
  ];
  for (const name of oldCaches) await env.caches.open(name);
  await (await env.caches.open('yuvomi-pages-2.51.0')).put('/pages/tasks.js', new MockResponse('stale tasks'));
  await (await env.caches.open('yuvomi-pages-2.51.0')).put('/pages/calendar.js', new MockResponse('stale calendar'));

  await dispatchLifecycle(env.listeners.install[0]);
  assert.equal(env.signals.skipped, 1, 'the installed worker must activate immediately');

  const shell = await env.caches.open('yuvomi-shell-2.54.0');
  const pages = await env.caches.open('yuvomi-pages-2.54.0');
  assert.ok(await shell.match('/components/task-detail.js'));
  assert.ok(await shell.match('/utils/task-fields.js'));
  assert.ok(await pages.match('/pages/tasks.js'));
  assert.ok(await pages.match('/pages/calendar.js'));

  await dispatchLifecycle(env.listeners.activate[0]);
  for (const name of oldCaches) {
    assert.equal((await env.caches.keys()).includes(name), false, `${name} must be removed`);
  }
  assert.equal(env.signals.claimed, 1, 'the new worker must claim the existing page');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(env.signals.messages), JSON.stringify([{ type: 'SW_UPDATED' }]));
  assert.equal((await pages.match('/pages/tasks.js')).body, 'fresh:/pages/tasks.js');
  assert.equal((await pages.match('/pages/calendar.js')).body, 'fresh:/pages/calendar.js');
});

test('controller change reloads once without requiring a hard reload', async () => {
  const windowListeners = {};
  const workerListeners = {};
  const signals = { registrations: [], updates: 0, reloads: 0, delay: null };
  const registration = { update() { signals.updates += 1; return Promise.resolve(); } };
  const serviceWorker = {
    register(path, options) { signals.registrations.push([path, options]); return Promise.resolve(registration); },
    addEventListener(type, callback) { workerListeners[type] = callback; },
    getRegistration() { return Promise.resolve(registration); },
    controller: { postMessage() {} },
  };
  const sandbox = {
    navigator: { serviceWorker },
    window: {
      addEventListener(type, callback) { windowListeners[type] = callback; },
      location: { reload() { signals.reloads += 1; } },
    },
    document: { visibilityState: 'hidden', addEventListener() {} },
    setTimeout(callback, delay) { signals.delay = delay; callback(); },
    console,
  };
  runInContext(REGISTER_SOURCE, createContext(sandbox));
  windowListeners.load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    JSON.stringify(signals.registrations),
    JSON.stringify([['/sw.js', { updateViaCache: 'none' }]]),
  );
  assert.equal(signals.updates, 1);

  workerListeners.controllerchange();
  workerListeners.controllerchange();
  assert.equal(signals.delay, 200);
  assert.equal(signals.reloads, 1, 'duplicate controller changes must not cause a reload loop');
});

test('activation remains alive until claim and update notification finish', async () => {
  let releaseClaim;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const env = loadWorker({ claimImpl: () => claimGate });
  let completion;
  env.listeners.activate[0]({ waitUntil(value) { completion = Promise.resolve(value); } });

  let settled = false;
  completion.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'event.waitUntil must still own the delayed client claim');
  assert.deepEqual(env.signals.messages, [], 'no update is announced before takeover');

  releaseClaim();
  await completion;
  assert.equal(settled, true);
  assert.equal(JSON.stringify(env.signals.messages), JSON.stringify([{ type: 'SW_UPDATED' }]));
});
