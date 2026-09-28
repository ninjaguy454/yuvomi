import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = process.env.TASK_RELIABILITY_ROOT ? new URL(`file:///${process.env.TASK_RELIABILITY_ROOT.replaceAll('\\', '/')}/`) : new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function loaderFactory() {
  const source = read('public/utils/task-live.js');
  const body = source.slice(source.indexOf('export function latestTaskLoader('), source.indexOf('/** Re-read a board'));
  const context = vm.createContext({});
  vm.runInContext(body.replace('export function', 'function') + '\nthis.factory=latestTaskLoader;', context);
  return context.factory;
}

test('twenty simultaneous refresh requests use one in-flight read and one coordinated catch-up', async () => {
  const calls = [], accepted = [];
  const loader = loaderFactory()(() => { const request = deferred(); calls.push(request); return request.promise; }, value => accepted.push(value));
  const loads = Array.from({ length: 20 }, () => loader.load());
  assert.equal(calls.length, 1, 'refresh storm must not open twenty parallel Task-tree reads');
  calls[0].resolve({ revision: 1 }); await settle();
  assert.equal(calls.length, 2); assert.equal(accepted.length, 0, 'first response predates the requested catch-up');
  calls[1].resolve({ revision: 2 }); await Promise.all(loads);
  assert.equal(calls.length, 2); assert.deepEqual(accepted, [{ revision: 2 }]);
});

test('invalidated or disposed refresh cannot restore old content or start a catch-up', async () => {
  const calls = [], accepted = [];
  const loader = loaderFactory()(() => { const request = deferred(); calls.push(request); return request.promise; }, value => accepted.push(value));
  const first = loader.load(); loader.invalidate(); calls[0].resolve({ revision: 1 });
  assert.equal(await first, false); assert.equal(accepted.length, 0);
  const second = loader.load(); loader.load(); loader.dispose(); calls[1].reject(new Error('old context'));
  assert.equal(await second, false); assert.equal(calls.length, 2);
});

test('successful reconnect clears an initial load error, while a later 502 preserves authorized data', async () => {
  const source = read('public/pages/tasks.js');
  const body = source.slice(source.indexOf('async function loadTasks(container)'), source.indexOf('/**\n * Vergebene Tags', source.indexOf('async function loadTasks(container)')));
  const state = { tasks: [], assignmentRequests: [], loadError: new Error('initial 502') };
  let fail = false, renders = 0;
  const context = vm.createContext({ state, persistAssignedToMe() {}, taskPageLoaders: new WeakMap(), latestTaskLoader: loaderFactory(),
    api: { get: async path => { if (fail && path.startsWith('/tasks')) throw Object.assign(new Error('proxy unavailable'), { status: 502 }); return { data: path.startsWith('/tasks') ? [{ id: 1, revision: 5 }] : [] }; } },
    taskQuery: () => '', updateTaskStartRefresh() {}, taskConnectionNotices: new WeakMap(), taskConnectionState: () => 'connected', taskCardSubtasks: new WeakMap(), applyTaskPagePermissions() {}, renderTaskList() { renders++; } });
  vm.runInContext(body + '\nthis.load=loadTasks;', context);
  const container = { isConnected: true, querySelector: () => ({}) };
  await context.load(container);
  assert.equal(state.loadError, null, 'a successful Task read must dismiss the initial error screen');
  const before = state.tasks; fail = true;
  await assert.rejects(context.load(container), /proxy unavailable/);
  assert.equal(state.tasks, before); assert.equal(renders, 1, 'transient failure must not rebuild the board');
});

function queueFixture() {
  const context = vm.createContext({});
  vm.runInContext(read('public/utils/task-subtask-queue.js').replace('export function', 'function') + '\nthis.factory=createSubtaskQueue;', context);
  let task = { id: 1, revision: 1, status: 'open', subtasks: [{ id: 2, revision: 1, status: 'open' }, { id: 3, revision: 1, status: 'open' }] };
  const write = deferred(), sent = [], errors = [], unknown = [];
  const queue = context.factory({ getTask: () => task, getChild: id => task.subtasks.find(child => child.id === id),
    send: (child, status) => { sent.push({ child, status }); return write.promise; }, accept: () => true,
    onError: error => errors.push(error), onUncertain: error => unknown.push(error) });
  return { queue, write, sent, errors, unknown, read(status = 'done') { task = { ...task, revision: 2, subtasks: task.subtasks.map(child => child.id === 2 ? { ...child, revision: 2, status } : child) }; queue.invalidate(task); } };
}

test('lost mutation acknowledgement stays explicitly uncertain until canonical readback; no write retry', async () => {
  const f = queueFixture(); f.queue.enqueue(2, 'done'); f.queue.enqueue(3, 'done');
  f.write.reject(Object.assign(new Error('upstream interrupted'), { status: 502, outcome: 'unknown' })); await settle();
  assert.equal(f.queue.pending.get(2)?.uncertain, true, 'an unknown result is not a confirmed rejection');
  assert.equal(f.queue.pending.has(3), false, 'unsent work is canceled');
  assert.equal(f.queue.blocked, true); assert.equal(f.sent.length, 1); assert.equal(f.unknown.length, 1);
  f.read(); assert.equal(f.queue.pending.size, 0); assert.equal(f.queue.blocked, false); assert.equal(f.sent.length, 1);
});

test('an unchanged fresh read does not misclassify a still-running mutation as rejected', async () => {
  const f = queueFixture(); f.queue.enqueue(2, 'done');
  f.write.reject(Object.assign(new Error('interrupted'), { status: 502, outcome: 'unknown' })); await settle();
  f.queue.invalidate({ id: 1, revision: 1, status: 'open' });
  assert.equal(f.queue.pending.get(2)?.uncertain, true); assert.equal(f.queue.blocked, true);
  assert.equal(f.queue.pending.get(2).status, 'open', 'show canonical progress, not a permanently completed optimistic step');
  assert.equal(f.queue.enqueue(2, 'done'), false); assert.equal(f.sent.length, 1);
  f.read(); assert.equal(f.queue.pending.size, 0); assert.equal(f.queue.blocked, false);
});

for (const status of [403, 409, 429]) test(`definite ${status} rejection rolls back without automatic retry`, async () => {
  const f = queueFixture(); f.queue.enqueue(2, 'done');
  f.write.reject(Object.assign(new Error('rejected'), { status })); await settle();
  assert.equal(f.queue.pending.size, 0); assert.equal(f.queue.blocked, true); assert.equal(f.unknown.length, 0); assert.equal(f.sent.length, 1);
  f.queue.dispose();
});

test('a canceled local confirmation is rejected, never reported as an unknown server mutation', async () => {
  const f = queueFixture(); f.queue.enqueue(2, 'done');
  f.write.reject(Object.assign(new Error('This step was not changed.'), { outcome: 'rejected' })); await settle();
  assert.equal(f.queue.pending.size, 0); assert.equal(f.unknown.length, 0); assert.equal(f.errors[0].message, 'This step was not changed.');
  f.queue.dispose();
});

for (const path of ['public/pages/tasks.js', 'public/components/task-detail.js']) test(`${path} reports definitely rejected local intent separately from an unknown write`, async () => {
  const callback = read(path).match(/onError:\s*(error\s*=>\s*\{[\s\S]*?\n\s*\}),\n\s*(?:refresh:|onDrain:)/)?.[1];
  assert.ok(callback, 'extract the actual mounted queue error callback');
  for (const [error, expected] of [
    [Object.assign(new Error('This step was not changed.'), { outcome: 'rejected' }), ['This step was not changed.', 'danger']],
    [Object.assign(new Error('Proxy interrupted'), { status: 502, outcome: 'unknown' }), ['This step may have saved. Checking its current status; it will not be sent again.', 'warning']],
  ]) {
    const toasts = [], context = vm.createContext({ window: { yuvomi: { showToast: (...args) => toasts.push(args) } }, ctx: { refresh: async () => {} } });
    vm.runInContext(`this.handler = (${callback});`, context);
    context.handler(error); await settle();
    assert.deepEqual(toasts, [expected]);
  }
});
