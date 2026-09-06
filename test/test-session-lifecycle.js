import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const lifecycle = readFileSync(new URL('../public/utils/session-lifecycle.js', import.meta.url), 'utf8');
const routerSource = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');

function sharedTabs({ storage = true, broadcast = true } = {}) {
  const tabs = [];
  const messages = [];
  function tab() {
    const tab = { events: {}, channels: [], callbacks: 0 };
    const window = { addEventListener: (type, fn) => { tab.events[type] = fn; } };
    if (broadcast) window.BroadcastChannel = class {
      constructor(name) { this.name = name; tab.channels.push(this); }
      addEventListener(_type, fn) { this.listener = fn; }
      postMessage(message) {
        for (const other of tabs.filter((entry) => entry !== tab)) {
          other.channels.filter((entry) => entry.name === this.name).forEach((entry) => entry.listener({ data: message }));
        }
      }
    };
    tab.context = vm.createContext({ window, Date, Math, localStorage: {
      setItem(key, value) {
        if (!storage) throw new Error('Storage unavailable');
        messages.push({ key, value });
        for (const other of tabs.filter((entry) => entry !== tab)) other.events.storage?.({ key, newValue: value });
      },
    } });
    vm.runInContext(lifecycle.replaceAll('export function ', 'function '), tab.context);
    tab.context.changed = () => { tab.callbacks++; };
    vm.runInContext('watchSessionChanges(changed)', tab.context);
    tab.send = (reason) => vm.runInContext(`broadcastSessionChange(${JSON.stringify(reason)})`, tab.context);
    tabs.push(tab);
    return tab;
  }
  return { tab, messages };
}

test('account changes notify other tabs once and never transmit account data or credentials', () => {
  const shared = sharedTabs();
  const alice = shared.tab();
  const other = shared.tab();
  alice.send('logout');
  assert.equal(alice.callbacks, 0);
  assert.equal(other.callbacks, 1, 'storage and BroadcastChannel duplicates are ignored');
  other.send('login');
  assert.equal(alice.callbacks, 1);
  assert.equal(other.callbacks, 1);
  for (const sent of shared.messages) {
    assert.deepEqual(Object.keys(JSON.parse(sent.value)).sort(), ['id', 'reason', 'source']);
    assert.doesNotMatch(sent.value, /password|token|cookie|username|userId/i);
  }
});

test('session signals work with either transport and ignore invalid messages', () => {
  for (const options of [{ storage: false }, { broadcast: false }]) {
    const shared = sharedTabs(options);
    const one = shared.tab();
    const two = shared.tab();
    one.send('login');
    assert.equal(two.callbacks, 1);
    two.events.storage?.({ key: 'yuvomi-session-change', newValue: '{invalid' });
    two.events.storage?.({ key: 'yuvomi-session-change', newValue: JSON.stringify({ source: 'other', id: 'bad', reason: 'update' }) });
    assert.equal(two.callbacks, 1);
  }
  const unavailable = sharedTabs({ storage: false, broadcast: false }).tab();
  assert.doesNotThrow(() => unavailable.send('logout'));
});

test('only completed authentication and logout publish a session change', async () => {
  const events = [];
  let response = { twoFactorRequired: true };
  let reject = false;
  const source = readFileSync(new URL('../public/api.js', import.meta.url), 'utf8');
  const start = source.indexOf('const auth = {');
  const end = source.indexOf('\n};', start) + 3;
  assert.ok(start > 0 && end > start);
  const noop = () => {};
  const context = vm.createContext({
    api: { post: async () => { if (reject) throw new Error('Offline'); return response; }, get: async () => response },
    setPermissions: noop, setHouseholdSize: noop, clearPermissions: noop, clearHouseholdSize: noop,
    clearApiCache: noop, forgetLayoutHint: noop, broadcastSessionChange: (reason) => events.push(reason),
  });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext('auth.login("alice", "synthetic")', context);
  assert.deepEqual(events, [], 'pending2FA is not an authenticated session');
  response = { user: { id: 1 } };
  await vm.runInContext('auth.verifyTwoFactor("synthetic")', context);
  await vm.runInContext('auth.me()', context);
  assert.deepEqual(events, ['login'], 'ordinary identity reads do not broadcast loops');
  await vm.runInContext('auth.login("bob", "synthetic")', context);
  reject = true;
  await assert.rejects(vm.runInContext('auth.logout()', context), /Offline/);
  assert.deepEqual(events, ['login', 'login', 'logout']);
});

function routerHarness(response, { online = true } = {}) {
  const events = [];
  const listeners = {};
  let revision = 1;
  let calls = 0;
  let onChange;
  const context = vm.createContext({
    currentUser: { id: 1 }, navigator: { onLine: online },
    document: { visibilityState: 'visible', getElementById: () => ({ replaceChildren: () => events.push('clear') }), addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { location: { reload: () => events.push('reload') }, addEventListener: (name, fn) => { listeners[name] = fn; } },
    api: { get: async (path) => { assert.equal(path, '/auth/me'); calls++; return await response(); } },
    watchSessionChanges: (fn) => { onChange = fn; }, sessionRevision: () => revision,
    forgetSessionState: () => { context.currentUser = null; events.push('forget'); },
  });
  const start = routerSource.indexOf('let sessionReloading = false;');
  const end = routerSource.indexOf('// Session abgelaufen', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(routerSource.slice(start, end), context);
  return { context, events, listeners, get calls() { return calls; }, changed: () => { revision++; onChange(); }, resume: () => vm.runInContext('verifyResumedSession()', context) };
}

test('another tab account change clears personal state and content before reloading, once', () => {
  const app = routerHarness(async () => ({ user: { id: 1 } }));
  app.changed();
  app.changed();
  assert.deepEqual(app.events, ['forget', 'clear', 'reload']);
  assert.equal(app.context.currentUser, null);
  assert.equal(app.calls, 0, 'receiving a change never sends server logout or another API mutation');
});

test('resume detects Reader/SSO account switches and shares overlapping identity checks', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const app = routerHarness(() => pending);
  const check = app.resume();
  await app.resume();
  assert.equal(app.calls, 1);
  resolve({ user: { id: 2 } });
  await check;
  assert.deepEqual(app.events, ['forget', 'clear', 'reload']);
});

test('resume preserves same-account and offline behavior and ignores obsolete identity responses', async () => {
  const same = routerHarness(async () => ({ user: { id: 1 } }));
  await same.resume();
  assert.deepEqual(same.events, []);
  const offline = routerHarness(async () => { throw new Error('Should not fetch'); }, { online: false });
  await offline.resume();
  assert.equal(offline.calls, 0);
  const failed = routerHarness(async () => { throw new Error('Network unavailable'); });
  await failed.resume();
  assert.deepEqual(failed.events, []);
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const stale = routerHarness(() => pending);
  const check = stale.resume();
  stale.context.currentUser = { id: 2 };
  resolve({ user: { id: 1 } });
  await check;
  assert.deepEqual(stale.events, []);
});
