import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/notification-center.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function harness() {
  let wall = false;
  const calls = [];
  const listeners = new Map();
  const context = vm.createContext({
    URL, location: { origin: 'https://household.example' },
    t: (key) => key, isWallModeEnabled: () => wall,
    document: { querySelectorAll: () => [], visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name), yuvomi: { navigate: (url) => calls.push(['navigate', url]) } },
    api: { get: async () => ({ data: { items: [], unreadCount: 0 } }), patch: async () => ({ data: { items: [], unreadCount: 0 } }) },
    closeModal: async () => { calls.push(['close']); return true; },
    setInterval: () => 1, clearInterval() {}, setTimeout() {},
  });
  vm.runInContext(`${source}\nthis.subject={init,stop,refresh,safeNotificationUrl,openNotificationItem,getSnapshot:()=>snapshot};`, context);
  return { context, subject: context.subject, calls, wall(value, crossTab = false) { wall = value; crossTab ? listeners.get('storage')?.({ key: 'yuvomi-wall-mode' }) : listeners.get('yuvomi:wall-mode-change')?.(); } };
}

test('notification links only accept local paths, never protocol-relative or escaped hosts', () => {
  const { subject } = harness();
  for (const url of ['https://evil.test', '//evil.test', '/\\evil.test', '/\n/evil.test', 'javascript:alert(1)', null]) assert.equal(subject.safeNotificationUrl(url), null);
  assert.equal(subject.safeNotificationUrl('/tasks?open=42&section=subtasks'), '/tasks?open=42&section=subtasks');
});

test('overlapping refreshes share one request and logout discards its late private result', async () => {
  const { subject, context } = harness();
  let finish;
  let count = 0;
  context.api.get = () => { count++; return new Promise((resolve) => { finish = resolve; }); };
  subject.init();
  const refresh = subject.refresh();
  assert.equal(count, 1);
  subject.stop();
  finish({ data: { items: [{ id: 1, title: 'Private' }], unreadCount: 1 } });
  await refresh;
  assert.equal(subject.getSnapshot().unreadCount, 0);
  assert.equal(subject.getSnapshot().items.length, 0);
});

test('wall mode prevents inbox hydration and clears a previously loaded personal history', async () => {
  const { subject, context, wall } = harness();
  let count = 0;
  context.api.get = async () => { count++; return { data: { items: [{ id: 1, title: 'Private' }], unreadCount: 1 } }; };
  wall(true);
  subject.init();
  await subject.refresh();
  assert.equal(count, 0);
  wall(false);
  await subject.refresh();
  assert.equal(subject.getSnapshot().unreadCount, 1);
  wall(true);
  assert.equal(subject.getSnapshot().items.length, 0);
  await subject.refresh();
  assert.equal(count, 1);
});

test('an old user response cannot replace the next user notification count', async () => {
  const { subject, context } = harness();
  let first;
  context.api.get = () => new Promise((resolve) => { first = resolve; });
  subject.init();
  const oldRequest = subject.refresh();
  subject.stop();
  context.api.get = async () => ({ data: { items: [], unreadCount: 2 } });
  subject.init();
  await subject.refresh();
  first({ data: { items: [{ id: 9, title: 'Previous user' }], unreadCount: 9 } });
  await oldRequest;
  assert.equal(subject.getSnapshot().unreadCount, 2);
  assert.equal(subject.getSnapshot().items.length, 0);
});

test('opening a notification marks it read and lets the router consume the overlay without a competing Back', async () => {
  const { subject, context, calls } = harness();
  subject.init();
  await subject.refresh();
  context.api.patch = async (url) => { calls.push(['read', url]); return { data: { items: [], unreadCount: 0 } }; };
  await subject.openNotificationItem({ id: 42, url: '/tasks?open=4' });
  assert.deepEqual(calls, [['read', '/notifications/inbox/42/read'], ['navigate', '/tasks?open=4']]);
});

test('failed or revoked read actions do not open an unauthorized destination', async () => {
  const { subject, context, calls } = harness();
  subject.init();
  await subject.refresh();
  context.api.patch = async () => { throw new Error('No longer accessible'); };
  await subject.openNotificationItem({ id: 42, url: '/tasks?open=4' });
  assert.deepEqual(calls, []);
});

test('a poll started before marking read cannot restore the old unread count', async () => {
  const { subject, context } = harness();
  let finish;
  context.api.get = () => new Promise((resolve) => { finish = resolve; });
  subject.init();
  const poll = subject.refresh();
  await subject.openNotificationItem({ id: 42, url: '/tasks?open=4' });
  finish({ data: { items: [{ id: 42, title: 'Task assigned' }], unreadCount: 1 } });
  await poll;
  assert.equal(subject.getSnapshot().unreadCount, 0);
});

test('enabling wall mode in another tab clears the current private inbox', async () => {
  const { subject, context, wall } = harness();
  context.api.get = async () => ({ data: { items: [{ id: 1, title: 'Private' }], unreadCount: 1 } });
  subject.init();
  await subject.refresh();
  wall(true, true);
  assert.equal(subject.getSnapshot().items.length, 0);
  assert.equal(await subject.refresh(), false);
});
