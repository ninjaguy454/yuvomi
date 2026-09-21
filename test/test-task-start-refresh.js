import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/utils/task-live.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function events() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
      if (!listeners.get(name)?.size) listeners.delete(name);
    },
    emit(name, event = {}) { for (const callback of [...(listeners.get(name) || [])]) callback(event); },
  };
}

function harness(refresh = async () => {}) {
  const document = { ...events(), hidden: false }, window = events(), navigator = { onLine: true };
  const timers = new Map(); let seq = 0, calls = 0;
  const context = vm.createContext({
    document, window, navigator,
    // A wildly incorrect wall-device clock cannot change the server's deadline.
    Date: class extends Date { static now() { throw new Error('Client wall clock must not determine Task visibility'); } },
    setTimeout(fn, ms) { timers.set(++seq, { fn, ms }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    auth: { me: async () => {} }, deviceContext: () => null,
    EventSource: class { addEventListener() {} close() {} },
  });
  vm.runInContext(`${source}\nthis.subject={createTaskStartRefresh,watchTaskChanges,latestTaskLoader};`, context);
  const controller = context.subject.createTaskStartRefresh(async () => { calls++; return refresh(); });
  return {
    ...context.subject, controller, document, window, navigator, timers,
    calls: () => calls,
    one() { assert.equal(timers.size, 1); return [...timers.entries()][0]; },
    async fire(id = this.one()[0]) {
      const value = timers.get(id); assert.ok(value, 'timer is scheduled');
      timers.delete(id); await value.fn();
    },
  };
}

const deadline = (delay = 1000) => ({ server_now: 1_790_000_000_000, next_start_at: 1_790_000_000_000 + delay });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('start refresh uses only the two server instants, with no client date/timezone comparison', async () => {
  const h = harness();
  h.controller.update(deadline(43_200_000));
  assert.equal(h.one()[1].ms, 43_200_000); assert.equal(h.calls(), 0);
  await h.fire(); assert.equal(h.calls(), 1); assert.equal(h.timers.size, 0);
  h.controller.dispose();
});

test('boundary and distant deadlines use bounded timers rather than spinning or integer overflow', () => {
  const h = harness();
  for (const delay of [-1000, 0, 1, 99, 100]) {
    h.controller.update(deadline(delay)); assert.equal(h.one()[1].ms, 100);
  }
  h.controller.update(deadline(2_147_483_647 + 86_400_000));
  assert.equal(h.one()[1].ms, 2_147_483_647); h.controller.dispose();
});

test('a new canonical response replaces the deadline and a stale callback cannot refresh', async () => {
  const h = harness(); h.controller.update(deadline(1000));
  const [oldId, old] = h.one();
  h.controller.update(deadline(5000));
  const [newId] = h.one(); assert.notEqual(newId, oldId);
  await old.fn(); assert.equal(h.calls(), 0);
  assert.equal(h.one()[1].ms, 5000);
  await h.fire(newId); assert.equal(h.calls(), 1); h.controller.dispose();
});

test('no next start, include-future responses, and invalid metadata clear the old deadline', async () => {
  const h = harness();
  for (const response of [null, undefined, {}, { server_now: 1, next_start_at: null },
    { include_future: true, server_now: 1, next_start_at: null },
    { server_now: '1', next_start_at: 5 }, { server_now: 1, next_start_at: Infinity }]) {
    h.controller.update(deadline()); const old = h.one()[1];
    h.controller.update(response); assert.equal(h.timers.size, 0);
    await old.fn(); assert.equal(h.calls(), 0);
  }
  h.controller.dispose();
});

test('a canceled callback cannot lose the replacement timer handle during cleanup', async () => {
  const h = harness(); h.controller.update(deadline()); const old = h.one()[1];
  h.controller.update(deadline(5000)); await old.fn(); h.controller.dispose();
  assert.equal(h.timers.size, 0); assert.equal(h.calls(), 0);
});

test('disposed views remove listeners and cannot rearm from a late response', async () => {
  const h = harness(); h.controller.update(deadline()); const old = h.one()[1];
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.timers.size, 0); assert.equal(h.document.listeners.size, 0); assert.equal(h.window.listeners.size, 0);
  h.controller.update(deadline()); await old.fn();
  assert.equal(h.timers.size, 0); assert.equal(h.calls(), 0);
});

test('ending authentication permanently blocks the old mounted context, including late responses', async () => {
  for (const event of ['auth:expired', 'auth:context-ending']) {
    const h = harness(); h.controller.update(deadline()); const old = h.one()[1];
    h.window.emit(event); h.controller.update(deadline());
    h.window.emit('pageshow'); h.window.emit('online'); h.controller.update(deadline());
    await old.fn(); assert.equal(h.timers.size, 0); assert.equal(h.calls(), 0);
    h.controller.dispose();
  }
});

test('an in-flight failed refresh cannot install a retry after authentication ends', async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  h.controller.update(deadline()); const running = h.fire(); assert.equal(h.calls(), 1);
  h.window.emit('auth:context-ending'); pending.reject(new Error('old personal request'));
  await running; h.controller.update(deadline()); assert.equal(h.timers.size, 0); h.controller.dispose();
});

test('sleep/offline suspension drops old deadlines and resume waits for fresh canonical metadata', async () => {
  for (const kind of ['hidden', 'offline', 'pagehide']) {
    const h = harness(); h.controller.update(deadline()); const old = h.one()[1];
    if (kind === 'hidden') { h.document.hidden = true; h.document.emit('visibilitychange'); }
    else if (kind === 'offline') { h.navigator.onLine = false; h.window.emit('offline'); }
    else h.window.emit('pagehide');
    h.controller.update(deadline(20_000)); await old.fn();
    assert.equal(h.timers.size, 0); assert.equal(h.calls(), 0);
    if (kind === 'hidden') { h.document.hidden = false; h.document.emit('visibilitychange'); }
    else if (kind === 'offline') { h.navigator.onLine = true; h.window.emit('online'); }
    else h.window.emit('pageshow', { persisted: true });
    assert.equal(h.timers.size, 0, 'old server timestamps cannot create a zombie timer after resume');
    h.controller.update(deadline(500)); assert.equal(h.one()[1].ms, 500);
    await h.fire(); assert.equal(h.calls(), 1); h.controller.dispose();
  }
});

test('live resume refreshes the board and the returned canonical deadline rearms the start timer', async () => {
  const h = harness(); let reads = 0;
  const stopLive = h.watchTaskChanges(() => { reads++; h.controller.update(deadline(2000)); });
  h.controller.update(deadline()); h.window.emit('pagehide');
  assert.equal(h.timers.size, 0);
  h.window.emit('pageshow', { persisted: true });
  assert.equal(h.one()[1].ms, 80);
  await h.fire(); assert.equal(reads, 1); assert.equal(h.one()[1].ms, 2000);
  stopLive(); h.controller.dispose(); assert.equal(h.timers.size, 0);
});

test('refresh failure retries at a bounded interval and successful canonical data replaces retry', async () => {
  let shouldFail = true;
  const h = harness(() => { if (shouldFail) throw new Error('network unavailable'); h.controller.update(deadline(4000)); });
  h.controller.update(deadline()); await h.fire();
  assert.equal(h.calls(), 1); assert.equal(h.one()[1].ms, 30_000);
  await h.fire(); assert.equal(h.calls(), 2); assert.equal(h.one()[1].ms, 30_000);
  shouldFail = false; await h.fire(); assert.equal(h.calls(), 3); assert.equal(h.one()[1].ms, 4000);
  h.controller.dispose(); assert.equal(h.timers.size, 0);
});

test('old refresh rejection cannot replace a newer successful read deadline', async () => {
  const pending = deferred(), h = harness(() => pending.promise);
  h.controller.update(deadline()); const running = h.fire();
  h.controller.update(deadline(7500)); pending.reject(new Error('superseded request'));
  await running; assert.equal(h.one()[1].ms, 7500); h.controller.dispose();
});

test('latest loader accepts only current response metadata before arming the next-start timer', async () => {
  const h = harness(), earlier = deferred(), later = deferred(); let reads = 0;
  const loader = h.latestTaskLoader(() => ++reads === 1 ? earlier.promise : later.promise,
    response => h.controller.update(response.visibility));
  const first = loader.load(), second = loader.load();
  later.resolve({ visibility: deadline(6000) }); assert.equal(await second, true);
  earlier.resolve({ visibility: deadline(1000) }); assert.equal(await first, false);
  assert.equal(h.one()[1].ms, 6000); loader.dispose(); h.controller.dispose();
});
