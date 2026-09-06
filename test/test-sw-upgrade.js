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
  constructor() { this.entries = new Map(); this.addedRequests = []; }
  async put(input, response) { this.entries.set(keyOf(input), response); }
  async match(input) { return this.entries.get(keyOf(input)); }
  async delete(input) { return this.entries.delete(keyOf(input)); }
  async keys() { return [...this.entries.keys()].map((path) => new MockRequest(path)); }
  async addAll(requests) {
    this.addedRequests.push(...requests);
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
  const context = createContext(sandbox);
  runInContext(SW_SOURCE, context);
  const cacheNames = runInContext('({ APP_RELEASE, SHELL_CACHE, PAGES_CACHE, LOCALES_CACHE, ASSETS_CACHE, API_CACHE })', context);
  return { listeners, caches, signals, cacheNames };
}

async function dispatchLifecycle(listener) {
  let completion;
  listener({ waitUntil(value) { completion = Promise.resolve(value); } });
  await completion;
}

test('2.54.0 through Kitchen .4 caches upgrade to the Kitchen .5 refinement with shared Meal and Task modules', async () => {
  const env = loadWorker();
  const oldReleases = ['2.54.0', '2.54.0-kitchen.1', '2.54.0-kitchen.2', '2.54.0-kitchen.3', '2.54.0-kitchen.4'];
  const oldCaches = oldReleases.flatMap((release) => [
    `yuvomi-shell-${release}`,
    `yuvomi-pages-${release}`,
    `yuvomi-locales-${release}`,
    `yuvomi-assets-${release}`,
    `yuvomi-api-${release}`,
  ]);
  for (const name of oldCaches) await env.caches.open(name);
  for (const release of oldReleases) {
    const oldPages = await env.caches.open(`yuvomi-pages-${release}`);
    await oldPages.put('/pages/tasks.js', new MockResponse(`stale tasks:${release}`));
    await oldPages.put('/pages/calendar.js', new MockResponse(`stale calendar:${release}`));
    await oldPages.put('/pages/meals.js', new MockResponse(`stale meals:${release}`));
  }

  await dispatchLifecycle(env.listeners.install[0]);
  assert.equal(env.signals.skipped, 1, 'the installed worker must activate immediately');

  const shell = await env.caches.open(env.cacheNames.SHELL_CACHE);
  const pages = await env.caches.open(env.cacheNames.PAGES_CACHE);
  assert.ok(await shell.match('/components/task-detail.js'));
  assert.ok(await shell.match('/utils/task-fields.js'));
  assert.ok(await shell.match('/utils/meal-week-model.js'));
  assert.ok(await pages.match('/pages/tasks.js'));
  assert.ok(await pages.match('/pages/calendar.js'));
  assert.ok(await pages.match('/pages/meals.js'));

  await dispatchLifecycle(env.listeners.activate[0]);
  for (const name of oldCaches) {
    assert.equal((await env.caches.keys()).includes(name), false, `${name} must be removed`);
  }
  assert.equal(env.signals.claimed, 1, 'the new worker must claim the existing page');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(env.signals.messages), JSON.stringify([{ type: 'SW_UPDATED' }]));
  assert.equal((await pages.match('/pages/tasks.js')).body, 'fresh:/pages/tasks.js');
  assert.equal((await pages.match('/pages/calendar.js')).body, 'fresh:/pages/calendar.js');
  assert.equal((await pages.match('/pages/meals.js')).body, 'fresh:/pages/meals.js');
});

test('same Kitchen .5 baseline caches receive refinement imports and fresh modules and lose authenticated Reader pages', async () => {
  const env = loadWorker();
  // The deployed fork already reports Kitchen .5. Stage the refinement in new
  // names while retaining that visible release and the device privacy flag.
  assert.equal(env.cacheNames.APP_RELEASE, '2.54.0-kitchen.5');
  const shell = await env.caches.open('yuvomi-shell-2.54.0-kitchen.5');
  const pages = await env.caches.open('yuvomi-pages-2.54.0-kitchen.5');
  const locales = await env.caches.open('yuvomi-locales-2.54.0-kitchen.5');
  const api = await env.caches.open('yuvomi-api-2.54.0-kitchen.5');
  const assets = await env.caches.open('yuvomi-assets-2.54.0-kitchen.5');
  const privacy = await env.caches.open('yuvomi-device-privacy');
  await privacy.put('/shared-display', new MockResponse('', { headers: { 'X-Shared-Display': '1' } }));
  const shellPaths = ['/router.js', '/push.js', '/reminders.js', '/theme-init.js',
    '/components/modal.js', '/components/activity-automation.js', '/utils/wall-mode.js',
    '/styles/tokens.css', '/styles/typography.css', '/styles/reminders.css'];
  const pagePaths = ['/pages/tasks.js', '/pages/calendar.js', '/pages/meals.js', '/pages/shopping.js',
    '/settings/pages/personal-appearance.js', '/settings/pages/notifications.js'];
  const newImports = ['/notification-center.js', '/utils/appearance-preferences.js', '/utils/html-escape.js',
    '/utils/session-lifecycle.js'];
  for (const path of shellPaths) await shell.put(path, new MockResponse(`baseline:${path}`));
  for (const path of pagePaths) await pages.put(path, new MockResponse(`baseline:${path}`));
  await locales.put('/locales/en.json', new MockResponse('baseline:locale'));
  await assets.put('/icons/icon-192.png', new MockResponse('baseline:icon'));
  await shell.put('/reader', new MockResponse('Private baseline overview'));
  await shell.put('/reader/tasks', new MockResponse('Private baseline tasks'));
  await pages.put('/reader/meals', new MockResponse('Private baseline meals'));
  await api.put('/reader/tasks/42', new MockResponse('Private baseline detail'));
  for (const path of newImports) assert.equal(await env.caches.match(path), undefined);

  await dispatchLifecycle(env.listeners.install[0]);
  assert.equal(env.signals.skipped, 1);
  const freshShell = await env.caches.open(env.cacheNames.SHELL_CACHE);
  const freshPages = await env.caches.open(env.cacheNames.PAGES_CACHE);
  const freshLocales = await env.caches.open(env.cacheNames.LOCALES_CACHE);
  assert.notEqual(freshShell, shell);
  assert.notEqual(freshPages, pages);
  assert.equal((await shell.match('/router.js'))?.body, 'baseline:/router.js');
  assert.equal((await pages.match('/pages/meals.js'))?.body, 'baseline:/pages/meals.js');
  for (const path of [...shellPaths, ...newImports]) {
    assert.equal((await freshShell.match(path))?.body, `fresh:${path}`, `${path} must be refreshed or newly cached`);
    assert.equal(freshShell.addedRequests.find((request) => keyOf(request) === path)?.cache, 'reload',
      `${path} must bypass the old HTTP cache`);
  }
  for (const path of pagePaths) {
    assert.equal((await freshPages.match(path))?.body, `fresh:${path}`);
    assert.equal(freshPages.addedRequests.find((request) => keyOf(request) === path)?.cache, 'reload');
  }
  assert.equal((await freshLocales.match('/locales/en.json'))?.body, 'fresh:/locales/en.json');
  await freshShell.put('/reader/tasks/current', new MockResponse('Private current cached detail'));

  await dispatchLifecycle(env.listeners.activate[0]);
  assert.equal(env.signals.claimed, 1);
  assert.equal(JSON.stringify(env.signals.messages), JSON.stringify([{ type: 'SW_UPDATED' }]));
  for (const kind of ['shell', 'pages', 'locales', 'assets', 'api']) {
    assert.equal((await env.caches.keys()).includes(`yuvomi-${kind}-2.54.0-kitchen.5`), false);
  }
  assert.equal((await privacy.match('/shared-display'))?.headers.get('X-Shared-Display'), '1');
  assert.ok((await env.caches.keys()).includes('yuvomi-device-privacy'));
  for (const path of ['/reader', '/reader/tasks', '/reader/meals', '/reader/tasks/42', '/reader/tasks/current']) {
    assert.equal(await env.caches.match(path), undefined, `${path} must not survive same-version activation`);
  }
  for (const path of newImports) assert.equal((await env.caches.match(path))?.body, `fresh:${path}`);
});

test('a partially failed refinement install leaves the active Kitchen .5 cache generation unchanged', async () => {
  const env = loadWorker();
  const oldShell = await env.caches.open('yuvomi-shell-2.54.0-kitchen.5');
  const oldPages = await env.caches.open('yuvomi-pages-2.54.0-kitchen.5');
  await oldShell.put('/router.js', new MockResponse('baseline router'));
  await oldShell.put('/reader/tasks', new MockResponse('baseline Reader'));
  await oldPages.put('/settings/pages/personal-appearance.js', new MockResponse('baseline appearance'));
  const freshShell = await env.caches.open(env.cacheNames.SHELL_CACHE);
  freshShell.addAll = async () => { throw new Error('One shell asset could not be fetched'); };

  await assert.rejects(dispatchLifecycle(env.listeners.install[0]), /shell asset/);
  // Other independent cache groups may finish after the install has rejected.
  await new Promise((resolve) => setImmediate(resolve));
  const freshPages = await env.caches.open(env.cacheNames.PAGES_CACHE);
  assert.equal((await freshPages.match('/settings/pages/personal-appearance.js'))?.body,
    'fresh:/settings/pages/personal-appearance.js', 'exercise a real partial fill of the staged generation');
  assert.equal((await oldShell.match('/router.js'))?.body, 'baseline router');
  assert.equal((await oldShell.match('/reader/tasks'))?.body, 'baseline Reader', 'cleanup waits for successful activation');
  assert.equal((await oldPages.match('/settings/pages/personal-appearance.js'))?.body, 'baseline appearance');
  assert.equal(await oldShell.match('/utils/appearance-preferences.js'), undefined);
  assert.equal(env.signals.skipped, 0, 'a failed install must not request activation');
  assert.equal(env.signals.claimed, 0);
  assert.deepEqual(env.signals.messages, []);
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
