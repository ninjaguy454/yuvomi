import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
const plain = (source) => source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/^export \{[^\n]+\n/gm, '').replace(/^export /gm, '');
const value = (object) => JSON.parse(JSON.stringify(object));

function stateHarness() {
  const writes = [];
  const context = vm.createContext({ api: { patch: async (path, body) => { writes.push({ path, body }); return { data: { id: 1, status: body.status, revision: 5 } }; } }, confirmOverModal: async () => true });
  vm.runInContext(`${plain(read('utils/task-progress.js'))}\n${plain(read('utils/task-state.js'))}\nthis.subject={actionableSubtasks,structuralSubtasks,helperWaitingLabel,taskRevision,taskStatusConfirmation,changeTaskStatus}`, context);
  return { ...context.subject, writes };
}

test('progress excludes archived/support children while the supervision view counts its own projections', () => {
  const { actionableSubtasks } = stateHarness();
  const task = { subtasks: [{ id: 1 }, { id: 2, archived_at: '2050-01-01' }, { id: 3, is_supervision_projection: true }, { id: 4, is_support_task: true }] };
  assert.deepEqual(value(actionableSubtasks(task)).map(x => x.id), [1]);
  assert.deepEqual(value(actionableSubtasks({ ...task, is_supervision_projection: true })).map(x => x.id), [1, 3]);
});

test('delegated source actions leave learner progress and completion confirmation while definitions and helper work remain', () => {
  const { actionableSubtasks, structuralSubtasks, taskStatusConfirmation } = stateHarness();
  const task = { status: 'in_progress', subtasks: [
    { id: 1, status: 'done' },
    { id: 2, status: 'done', supervision_action: { execution_mode: 'supervised' } },
    { id: 3, status: 'open', supervision_action: { execution_mode: 'delegated' } },
    { id: 4, status: 'done', supervision_action: { execution_mode: 'delegated' } },
  ] };
  assert.deepEqual(value(actionableSubtasks(task)).map(row => row.id), [1, 2]);
  assert.deepEqual(value(structuralSubtasks(task)).map(row => row.id), [1, 2, 3, 4], 'Edit retains all original definitions and stable IDs');
  assert.equal(taskStatusConfirmation(task, 'done'), null, 'learner confirmation must not offer to complete helper responsibilities');
  assert.deepEqual(value(actionableSubtasks({ is_supervision_projection: true,
    subtasks: task.subtasks.slice(2).map(row => ({ ...row, is_supervision_projection: true })) })).map(row => row.id), [3, 4]);
  task.subtasks[2].supervision_action.state = 'not_required';
  assert.deepEqual(value(actionableSubtasks(task)).map(row => row.id), [1, 2, 3], 'independent action returns to learner scope after reconciliation');
});

test('waiting on helper is an explained state without declaring the occurrence Completed', () => {
  const { helperWaitingLabel } = stateHarness();
  const task = { assigned_to: 3, status: 'in_progress', waiting_on_helper: true };
  assert.equal(helperWaitingLabel(task, 3), 'Your steps complete · waiting on supervisor');
  assert.equal(helperWaitingLabel(task, 1), 'Learner steps complete · waiting on supervisor');
  assert.equal(helperWaitingLabel({ ...task, waiting_on_helper: false }, 3), '');
  assert.equal(task.status, 'in_progress');
});

test('assigned helper confirms delegated parent completion while learner progress remains responsibility-only', async () => {
  const { actionableSubtasks, taskStatusConfirmation, changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 12, status: 'in_progress', subtasks: [
    { id: 2, status: 'done' },
    { id: 3, status: 'open', permissions: { complete: true }, supervision_action: {
      execution_mode: 'delegated', state: 'assigned', can_complete: true } },
  ] };
  const confirmation = taskStatusConfirmation(task, 'done');
  assert.equal(confirmation.flag, 'complete_remaining');
  assert.match(confirmation.detail, /including direct helper responsibilities/);
  assert.deepEqual(value(actionableSubtasks(task)).map(row => row.id), [2], 'confirmation scope must not alter the learner denominator');
  const before = value(task);
  assert.equal(await changeTaskStatus(task, 'done', { confirm: async () => false }), null);
  assert.deepEqual(writes, []);
  assert.deepEqual(task, before);
  await changeTaskStatus(task, 'done', { confirm: async () => true });
  assert.deepEqual(value(writes), [{ path: '/tasks/1/status', body: { status: 'done', expected_revision: 12, complete_remaining: true } }]);
});

test('unknown, denied or partial helper permission does not offer completion of delegated responsibilities', () => {
  const { taskStatusConfirmation } = stateHarness();
  const task = { status: 'in_progress', subtasks: [
    { id: 2, status: 'done' },
    { id: 3, status: 'open', supervision_action: { execution_mode: 'delegated', state: 'assigned', can_complete: true } },
    { id: 4, status: 'open', supervision_action: { execution_mode: 'delegated', state: 'unresolved', can_complete: false } },
  ] };
  assert.equal(taskStatusConfirmation(task, 'done'), null);
  delete task.subtasks[2].supervision_action.can_complete;
  assert.equal(taskStatusConfirmation(task, 'done'), null, 'missing eligibility is not permission');
  task.subtasks[2].supervision_action.can_complete = true;
  task.subtasks[2].permissions = { complete: false };
  assert.equal(taskStatusConfirmation(task, 'done'), null, 'explicit capability denial remains authoritative');
  task.subtasks[0].status = 'open';
  const learnerConfirmation = taskStatusConfirmation(task, 'done');
  assert.equal(learnerConfirmation.flag, 'complete_remaining');
  assert.doesNotMatch(learnerConfirmation.detail, /direct helper responsibilities/);
});

test('reset discloses completed delegated work even when the learner has no progress and cancel preserves it', async () => {
  const { taskStatusConfirmation, changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 15, status: 'in_progress', subtasks: [
    { id: 2, status: 'open' },
    { id: 3, status: 'done', supervision_action: { execution_mode: 'delegated', state: 'assigned', can_complete: false } },
  ] };
  const confirmation = taskStatusConfirmation(task, 'open');
  assert.equal(confirmation.flag, 'reset_progress');
  assert.match(confirmation.detail, /Completed helper actions will also be reset/);
  assert.match(confirmation.detail, /Completion history is retained/);
  const before = value(task);
  assert.equal(await changeTaskStatus(task, 'open', { confirm: async () => false }), null);
  assert.deepEqual(task, before);
  assert.deepEqual(writes, []);
  await changeTaskStatus(task, 'open', { confirm: async () => true });
  assert.deepEqual(value(writes), [{ path: '/tasks/1/status', body: { status: 'open', expected_revision: 15, reset_progress: true } }]);
});

test('starting without completed subtasks does not create a redundant reset warning', () => {
  const { taskStatusConfirmation } = stateHarness();
  assert.equal(taskStatusConfirmation({ status: 'open', subtasks: [] }, 'open'), null);
  assert.equal(taskStatusConfirmation({ status: 'in_progress', subtasks: [{ status: 'open' }] }, 'open'), null);
  assert.equal(taskStatusConfirmation({ status: 'done', subtasks: [] }, 'in_progress'), null);
});

test('parent completion explains remaining actionable steps and reset warns about saved progress', () => {
  const { taskStatusConfirmation } = stateHarness();
  assert.equal(taskStatusConfirmation({ status: 'open', subtasks: [{ status: 'open' }] }, 'done').flag, 'complete_remaining');
  assert.equal(taskStatusConfirmation({ status: 'open', subtasks: [{ status: 'done' }] }, 'open').flag, 'reset_progress');
  assert.equal(taskStatusConfirmation({ status: 'done' }, 'open').flag, 'reset_progress');
  assert.equal(taskStatusConfirmation({ status: 'open', subtasks: [{ status: 'open', archived_at: '2050-01-01' }] }, 'done'), null);
});

test('canceling parent completion preserves status, subtask state and sends no mutation', async () => {
  const { changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 4, status: 'open', subtasks: [{ status: 'open' }] };
  const before = value(task);
  assert.equal(await changeTaskStatus(task, 'done', { confirm: async () => false }), null);
  assert.deepEqual(task, before);
  assert.deepEqual(writes, []);
});

test('confirmed completion sends the revision captured before confirmation, not a newer unseen snapshot', async () => {
  const { changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 4, parent_revision: 9, status: 'open', subtasks: [{ status: 'open' }] };
  await changeTaskStatus(task, 'done', { confirm: async (_message, options) => {
    assert.equal(options.closeOnConfirm, false);
    task.revision = 7;
    return true;
  } });
  assert.deepEqual(value(writes), [{ path: '/tasks/1/status', body: { status: 'done', expected_revision: 4, expected_parent_revision: 9, complete_remaining: true } }]);
});

test('pending feedback begins immediately before dispatch, only after required confirmation', async () => {
  const { changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 4, status: 'open', subtasks: [{ status: 'open' }] };
  let accept, painted = 0;
  const completing = changeTaskStatus(task, 'done', {
    confirm: () => new Promise(resolve => { accept = resolve; }), beforeRequest: () => { painted++; assert.equal(writes.length, 0); },
  });
  assert.equal(painted, 0);
  accept(false);
  assert.equal(await completing, null);
  assert.equal(painted, 0);
  assert.equal(writes.length, 0);
  await changeTaskStatus(task, 'done', { confirm: async () => true, beforeRequest: () => { painted++; assert.equal(writes.length, 0); } });
  assert.equal(painted, 1);
  assert.equal(writes.length, 1);
  assert.equal(task.status, 'open');
});

test('reset confirmation is explicit and reopening does not send a reset or erase completion records', async () => {
  const { changeTaskStatus, writes } = stateHarness();
  const task = { id: 1, revision: 4, status: 'done' };
  await changeTaskStatus(task, 'open');
  assert.equal(writes[0].body.reset_progress, true);
  await changeTaskStatus(task, 'in_progress');
  assert.deepEqual(value(writes[1].body), { status: 'in_progress', expected_revision: 4 });
  assert.equal(task.status, 'done', 'UI waits for canonical state instead of inventing optimistic history');
});

function liveHarness() {
  const timers = new Map(); let seq = 0;
  const events = () => ({ listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); } });
  const document = { ...events(), hidden: false };
  const window = events();
  const streams = [];
  class Source {
    constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  let authReads = 0;
  const context = vm.createContext({ document, window, navigator: { onLine: true }, EventSource: Source,
    auth: { me: async () => { authReads++; } },
    setTimeout(fn, delay) { timers.set(++seq, { fn, delay }); return seq; }, clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(`${plain(read('utils/task-live.js'))}\nthis.subject={watchTaskChanges,latestTaskLoader}`, context);
  return { ...context.subject, streams, document, window, authReads: () => authReads,
    async flush() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) await timer.fn(); } };
}

test('new assignment invalidation refreshes already open list/detail through one connection and rechecks permissions', async () => {
  const h = liveHarness(); let list = 0, detail = 0;
  const stopList = h.watchTaskChanges(() => list++);
  const stopDetail = h.watchTaskChanges(() => detail++);
  assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0].url, '/api/v1/tasks/changes');
  h.streams[0].emit('change', { version: 2 }); await h.flush();
  assert.equal(list, 1); assert.equal(detail, 1); assert.equal(h.authReads(), 1);
  h.streams[0].emit('change', { version: 2 }); await h.flush();
  assert.equal(list, 1, 'duplicate version cannot reload a draft');
  stopList(); assert.equal(h.streams[0].closed, undefined);
  stopDetail(); assert.equal(h.streams[0].closed, true);
});

test('visibility/resume reconnects and focuses refresh without hidden-tab polling', async () => {
  const h = liveHarness(); let reads = 0;
  const stop = h.watchTaskChanges(() => reads++);
  h.document.hidden = true; h.document.listeners.get('visibilitychange')();
  assert.equal(h.streams[0].closed, true);
  h.document.hidden = false; h.document.listeners.get('visibilitychange')(); await h.flush();
  assert.equal(h.streams.length, 2); assert.equal(reads, 1);
  h.window.listeners.get('focus')(); await h.flush(); assert.equal(reads, 2);
  stop(); assert.equal(h.window.listeners.has('focus'), false);
});

test('disposing the final subscriber cancels a queued invalidation', async () => {
  const h = liveHarness(); let reads = 0;
  const stop = h.watchTaskChanges(() => reads++);
  h.streams[0].emit('change', { version: 9 }); stop(); await h.flush();
  assert.equal(reads, 0);
});

test('out-of-order Task GETs cannot restore older assignment/status/progress', async () => {
  const h = liveHarness(); const pending = [], accepted = [];
  const loader = h.latestTaskLoader(() => new Promise(resolve => pending.push(resolve)), data => accepted.push(data));
  const first = loader.load(); const second = loader.load();
  pending[1]({ revision: 8, status: 'done' }); await second;
  pending[0]({ revision: 7, status: 'open' }); assert.equal(await first, false);
  assert.deepEqual(accepted, [{ revision: 8, status: 'done' }]);
});

test('mutation invalidation and unmount discard pending reads and stale failures', async () => {
  const h = liveHarness(); let resolve, reject;
  const accepted = [];
  const loader = h.latestTaskLoader(() => new Promise((yes, no) => { resolve = yes; reject = no; }), data => accepted.push(data));
  const old = loader.load(); loader.invalidate(); resolve({ revision: 1 }); assert.equal(await old, false);
  const failed = loader.load(); loader.dispose(); reject(new Error('obsolete failure')); assert.equal(await failed, false);
  assert.deepEqual(accepted, []);
});

class Element {
  constructor(tag) { this.isConnected = true; this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.classList = { add() {}, toggle() {} }; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return null; }
  setAttribute(key, val) { this.attributes[key] = val; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
}
const elementText = el => [el?.textContent, ...(el?.children || []).map(elementText)].filter(Boolean).join(' ');
const contextSummary = el => elementText(el.children.find(child => child.tagName === 'SUMMARY') || el);
function detailHarness(overrides = {}) {
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, HTMLElement: Element, window: {},
    canTask: (task, key) => task?.permissions?.[key] === true, isArchived: task => !!task.archived_at,
    isExpired: task => task?.status === 'expired',
    t: key => key, actionableSubtasks: stateHarness().actionableSubtasks, ...overrides });
  vm.runInContext(`${plain(read('components/task-detail.js'))}\nthis.subject={subtaskListNode,progressNode,supervisionNode,commentsNode,seriesHistoryNode,runTaskDetailMutation,taskStatusResponseSnapshot,mergeTaskDetailSnapshot}`, context);
  return context.subject;
}

test('normal detail exposes operational toggles and read-only required skills, never definition/skill editors', () => {
  const h = detailHarness();
  const task = { subtasks: [{ id: 2, title: 'Load washer', status: 'open', permissions: { complete: true }, skill_ids: [3], skills: [{ id: 3, name: 'Washing Machine' }] }] };
  const node = h.subtaskListNode(task, { currentUserId: 4, skills: [] });
  const row = node.children[0];
  assert.equal(row.children[0].tagName, 'BUTTON');
  assert.match(contextSummary(row.children[1]), /Washing Machine/);
  assert.equal(row.children[1].tagName, 'DETAILS');
  assert.equal(row.children[1].open, false);
  const tags = []; const walk = el => { tags.push(el.tagName); el.children?.forEach(walk); }; walk(node);
  assert.ok(!tags.includes('INPUT') && !tags.includes('SELECT') && !tags.includes('FORM'));
});

test('pending subtask paints checkbox and responsibility progress without inventing points or parent status', () => {
  const h = detailHarness({ completionCounts: task => ({ total: 2, done: task.subtasks.filter(row => row.status === 'done').length,
    totalPoints: 0, earnedPoints: 0 }) });
  const task = { id: 1, revision: 9, status: 'open', points: 30, subtasks: [
    { id: 2, revision: 3, title: 'Gather laundry', status: 'open', permissions: { complete: true } },
    { id: 3, revision: 4, title: 'Fold laundry', status: 'open', permissions: { complete: true } },
  ] };
  const saved = value(task), ctx = { busy: true, pendingSubtask: { id: 2, status: 'done' }, skills: [] };
  const row = h.subtaskListNode(task, ctx).children[0];
  assert.equal(row.children[0].attributes['aria-pressed'], 'true');
  assert.equal(row.children[0].attributes['aria-busy'], 'true');
  assert.equal(row.children[0].disabled, true);
  assert.equal(row.children.find(child => child.className === 'detail-subtask__pending').textContent, 'Saving…');
  assert.match(h.progressNode(task, ctx).children[1].textContent, /1 of 2 complete · 50%/);
  assert.deepEqual(task, saved, 'the optimistic projection is not canonical completion or reward evidence');
  task.subtasks[0].status = 'done';
  assert.match(h.progressNode(task, ctx).children[1].textContent, /1 of 2 complete · 50%/, 'matching live state does not count the optimistic step twice');
  ctx.pendingSubtask.status = 'in_progress';
  assert.match(h.progressNode(task, ctx).children[1].textContent, /0 of 2 complete · 0%/, 'reopen immediately removes this step from projected progress');
});

function pendingMutationHarness() {
  const errors = [], paints = [];
  const h = detailHarness({ document: { body: {}, activeElement: null }, window: { yuvomi: { showToast: message => errors.push(message) } } });
  const task = { id: 1, revision: 9, status: 'open', assigned_to: 2, points: 30, subtasks: [
    { id: 2, revision: 3, parent_revision: 9, title: 'Gather laundry', status: 'open' },
  ] };
  let invalidated = 0, reloaded = 0, changed = 0;
  const ctx = { task, loader: { invalidate() { invalidated++; } },
    renderOperationState() { paints.push(value({ pending: ctx.pendingSubtask || null, task })); },
    acceptSnapshot(fresh) {
      if (h.mergeTaskDetailSnapshot(task, fresh, ctx.minimumTaskRevision || 0)) { ctx.minimumTaskRevision = 0; ctx.refreshRequired = false; }
    },
    async refresh() { reloaded++; }, onChanged() { changed++; },
  };
  const button = { dataset: { focusKey: 'subtask-2' }, isConnected: true, disabled: false };
  return { ...h, ctx, task, button, paints, errors, counts: () => ({ invalidated, reloaded, changed }) };
}

test('parent reopen repaints enabled operation controls after its busy refresh finishes', async () => {
  const h = pendingMutationHarness(), busyStates = [];
  h.task.status = 'expired';
  h.ctx.refresh = async () => { assert.equal(h.ctx.busy, true); h.task.status = 'in_progress'; };
  h.ctx.renderOperationState = () => busyStates.push(h.ctx.busy);
  await h.runTaskDetailMutation(h.ctx, h.button, async () => ({ data: { ...h.task, status: 'in_progress' } }));
  assert.deepEqual(busyStates, [false], 'refreshing while busy must not leave the newly reopened controls disabled');
  assert.equal(h.ctx.busy, false);
  assert.equal(h.task.status, 'in_progress');
});

test('rapid repeated taps send one mutation and its acknowledgement does not wait for the surrounding Task list', async () => {
  const h = pendingMutationHarness(), before = value(h.task);
  let finish, calls = 0;
  h.ctx.onChanged = () => new Promise(() => {});
  const operation = begin => { calls++; begin(); return new Promise(resolve => { finish = resolve; }); };
  const pending = h.runTaskDetailMutation(h.ctx, h.button, operation, { subtask: h.task.subtasks[0], status: 'done' });
  assert.equal(h.ctx.busy, true);
  assert.deepEqual(value(h.ctx.pendingSubtask), { id: 2, status: 'done' });
  assert.equal(h.paints.length, 1, 'feedback is synchronous, before awaiting network');
  assert.deepEqual(h.task, before);
  await h.runTaskDetailMutation(h.ctx, h.button, operation, { subtask: h.task.subtasks[0], status: 'done' });
  assert.equal(calls, 1);
  finish({ data: { id: 2, revision: 4, status: 'done', parent_task: { ...before, revision: 10, status: 'done', subtasks: [{ ...before.subtasks[0], status: 'done', revision: 4, parent_revision: 10 }] } } });
  await pending;
  assert.equal(h.ctx.busy, false);
  assert.equal(h.ctx.pendingSubtask, null);
  assert.equal(h.task.status, 'done');
  assert.equal(h.task.subtasks[0].status, 'done');
  assert.equal(h.counts().reloaded, 0, 'the hydrated acknowledgement replaces an unnecessary detail GET');
  assert.equal(h.counts().invalidated, 2, 'reads dispatched before the acknowledgement are retired');
});

test('a newer live reset/reassignment survives an older successful optimistic response', async () => {
  const h = pendingMutationHarness(); let finish;
  const pending = h.runTaskDetailMutation(h.ctx, h.button, begin => { begin(); return new Promise(resolve => { finish = resolve; }); },
    { subtask: h.task.subtasks[0], status: 'done' });
  h.ctx.acceptSnapshot({ ...h.task, revision: 12, status: 'open', assigned_to: 7,
    subtasks: [{ ...h.task.subtasks[0], revision: 6, parent_revision: 12, status: 'open' }] });
  finish({ data: { id: 2, revision: 4, status: 'done', parent_task: { ...h.task, revision: 10, status: 'done', assigned_to: 2,
    subtasks: [{ ...h.task.subtasks[0], revision: 4, status: 'done' }] } } });
  await pending;
  assert.equal(h.task.revision, 12);
  assert.equal(h.task.assigned_to, 7);
  assert.equal(h.task.status, 'open');
  assert.equal(h.task.subtasks[0].status, 'open');
  assert.equal(h.ctx.pendingSubtask, null);
  assert.equal(h.counts().reloaded, 0);
});

test('server supervision rejection reverts only pending paint and shows the real reason', async () => {
  const h = pendingMutationHarness(); let reject;
  const pending = h.runTaskDetailMutation(h.ctx, h.button, begin => { begin(); return new Promise((_resolve, no) => { reject = no; }); },
    { subtask: h.task.subtasks[0], status: 'done' });
  h.ctx.acceptSnapshot({ ...h.task, revision: 12, assigned_to: 7 });
  reject(Object.assign(new Error('Rejected'), { status: 403, data: { error: 'Duane must supervise this action.' } }));
  await pending;
  assert.deepEqual(h.errors, ['Duane must supervise this action.']);
  assert.equal(h.ctx.pendingSubtask, null);
  assert.equal(h.ctx.busy, false);
  assert.equal(h.task.assigned_to, 7);
  assert.equal(h.task.revision, 12);
  assert.equal(h.task.subtasks[0].status, 'open');
  assert.equal(h.counts().changed, 0);
  assert.equal(h.counts().invalidated, 2);
});

test('stale revision conflict clears feedback before refreshing and retains its reason if refresh fails', async () => {
  const h = pendingMutationHarness();
  h.ctx.refresh = async () => { assert.equal(h.ctx.pendingSubtask, null); throw new Error('Network lost'); };
  await h.runTaskDetailMutation(h.ctx, h.button, begin => {
    begin(); throw Object.assign(new Error('Conflict'), { status: 409, data: { error: 'This Task was reset on another device.' } });
  }, { subtask: h.task.subtasks[0], status: 'done' });
  assert.deepEqual(h.errors, ['This Task was reset on another device.']);
  assert.equal(h.task.subtasks[0].status, 'open');
  assert.equal(h.ctx.busy, false);
});

test('helper projection consumes its own parent snapshot and never replaces itself with the learner Task', () => {
  const h = pendingMutationHarness();
  const learner = { id: 1, revision: 10 }, helper = { id: 10, revision: 20 };
  const response = { data: { id: 11, revision: 6, parent_task: learner, projection_parent_task: helper } };
  assert.equal(h.taskStatusResponseSnapshot(helper, response), helper);
  delete response.data.projection_parent_task;
  assert.equal(h.taskStatusResponseSnapshot(helper, response), undefined, 'older compatible server responses require a targeted read');
});

test('a committed compatible response survives follow-up read failure and requires fresh parent state before another write', async () => {
  const h = pendingMutationHarness();
  h.ctx.refresh = async () => { throw new Error('Network lost'); };
  await h.runTaskDetailMutation(h.ctx, h.button, begin => { begin(); return { data: {
    id: 2, revision: 4, parent_revision: 10, parent_task_id: 1, status: 'done',
  } }; }, { subtask: h.task.subtasks[0], status: 'done' });
  assert.equal(h.ctx.pendingSubtask, null);
  assert.equal(h.task.subtasks[0].status, 'done', 'an acknowledged write must not appear rejected');
  assert.equal(h.task.status, 'open', 'unknown parent propagation is not guessed');
  assert.equal(h.ctx.refreshRequired, true);
  assert.match(h.errors[0], /step was saved.*details could not be refreshed/);
  let called = false;
  await h.runTaskDetailMutation(h.ctx, h.button, () => { called = true; });
  assert.equal(called, false, 'no operation may use the obsolete parent revision');
  h.ctx.acceptSnapshot({ ...h.task, revision: 9, subtasks: [{ id: 2, revision: 3, status: 'open' }] });
  assert.equal(h.ctx.refreshRequired, true);
  assert.equal(h.task.subtasks[0].status, 'done', 'reads older than the committed parent revision are discarded');
  h.ctx.acceptSnapshot({ ...h.task, revision: 10, status: 'in_progress' });
  assert.equal(h.ctx.refreshRequired, false);
  assert.equal(h.task.status, 'in_progress');
});

test('learner detail omits transferred toggles and helper detail distinguishes direct work from supervision', () => {
  const h = detailHarness();
  const task = { subtasks: [
    { id: 2, title: 'Gather laundry', status: 'open', permissions: { complete: true } },
    { id: 3, title: 'Fold laundry', status: 'open', permissions: { complete: true }, supervision_action: {
      execution_mode: 'supervised', state: 'assigned', learner_name: 'Frank', supervisor_name: 'Duane', can_complete: false } },
    { id: 4, title: 'Load washer', status: 'open', permissions: { complete: false }, supervision_action: {
      execution_mode: 'delegated', state: 'assigned', learner_name: 'Frank', supervisor_name: 'Duane', can_complete: false } },
  ] };
  const learner = h.subtaskListNode(task, { currentUserId: 3, skills: [] });
  assert.deepEqual(learner.children.map(row => row.dataset.subtaskId), ['2', '3']);
  const helper = h.subtaskListNode({ is_supervision_projection: true, subtasks: task.subtasks.slice(1).map(row => ({
    ...row, id: row.id + 10, is_supervision_projection: true, permissions: { complete: true },
    supervision_action: { ...row.supervision_action, can_complete: true },
  })) }, { currentUserId: 5, skills: [] });
  assert.match(elementText(helper.children[0].children[1]), /Frank performs this with you/);
  assert.match(elementText(helper.children[1].children[1]), /Direct responsibility · You perform this for Frank/);
  assert.doesNotMatch(elementText(helper.children[1].children[1]), /Supervision required|performs this with you/);
  assert.deepEqual(helper.children.map(row => row.children[0].disabled), [false, false]);
});

test('delegated helper scope explains direct responsibility without suggesting the learner can perform it', () => {
  const h = detailHarness();
  const task = { id: 1, title: "Frank's Laundry", supervision: { state: 'needed', can_view_support: false,
    display_reason: 'No single available household member can cover all remaining actions.',
    actions: [{ action_task_id: 2, action_title: 'Load washer', execution_mode: 'delegated', state: 'unresolved', learner_name: 'Frank',
      required_skills: [{ name: 'Washing Machine' }],
      display_reason: 'Frank must not perform Load washer under the current Washing Machine settings. A qualified helper must perform this action.' }] } };
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  let all = flatten(h.supervisionNode(task, {}));
  assert.ok(all.some(el => el.textContent === 'Helper needed'));
  assert.ok(all.some(el => el.textContent === 'Direct responsibility: Load washer'));
  assert.ok(all.some(el => el.textContent.includes('The helper performs this for Frank')));
  assert.ok(!all.some(el => /cannot override|Frank performs this with you/.test(el.textContent)));
  task.supervision.actions[0] = { ...task.supervision.actions[0], completed: true, supervisor_name: 'Duane' };
  task.supervision.state = 'none';
  all = flatten(h.supervisionNode(task, {}));
  assert.ok(all.some(el => el.textContent.includes('Completed · Performed by Duane')));
  assert.ok(!all.some(el => el.textContent.includes('Previously supervised')));
});

test('supervised actions are operable by the current eligible supervisor and visibly restricted for the learner', () => {
  const h = detailHarness();
  const task = { subtasks: [{ id: 2, title: 'Load washer', status: 'open', permissions: { complete: true }, supervision_action: {
    state: 'assigned', supervisor_user_id: 5, supervisor_name: 'Parent', reason: 'Supervision required for Washing Machine' } }] };
  const learner = h.subtaskListNode(task, { currentUserId: 4, skills: [] });
  const supervisor = h.subtaskListNode(task, { currentUserId: 5, skills: [] });
  assert.equal(learner.children[0].children[0].disabled, true);
  assert.match(elementText(learner.children[0].children[1]), /Supervision required.*Supervisor: Parent/);
  assert.equal(supervisor.children[0].children[0].disabled, false);
});

test('skill explanations distinguish independent, supervised and prohibited actions without changing completion access', () => {
  const h = detailHarness();
  const entries = [
    { id: 2, title: 'Sort laundry', skill: 'Laundry Sorting', proficiency: 'normal', state: 'not_required', can_complete: true,
      reason: 'Frank can perform Sort laundry independently using Laundry Sorting.' },
    { id: 3, title: 'Fold laundry', skill: 'Fold Laundry', proficiency: 'supervised', state: 'unresolved', can_complete: false,
      reason: 'Frank can perform Fold laundry with supervision for Fold Laundry. Supervision cannot be assigned while other actions on this Task are not permitted.' },
    { id: 4, title: 'Load washer', skill: 'Washing Machine', proficiency: 'excluded', state: 'excluded', can_complete: false,
      reason: 'Frank cannot perform Load washer, even with supervision: Washing Machine is not permitted by his current age policy.' },
    { id: 5, title: 'Start dryer', skill: 'Dryer', proficiency: 'excluded', state: 'excluded', can_complete: false,
      reason: 'Frank cannot perform Start dryer, even with supervision: Dryer is not permitted by his current age policy.' },
  ];
  const actions = entries.map(entry => ({ action_task_id: entry.id, action_title: entry.title,
    state: entry.state, can_complete: entry.can_complete, reason: 'Legacy action diagnostic', display_reason: entry.reason,
    required_skills: [{ name: entry.skill }] }));
  const task = { id: 1, title: "Frank's Laundry", supervision: { state: 'excluded',
    reason: 'Legacy scope diagnostic', display_reason: 'Frank cannot perform Load washer or Start dryer under the current skill settings.', actions },
    subtasks: entries.map((entry, index) => ({ id: entry.id, title: entry.title, status: 'open', permissions: { complete: true },
      skill_ids: [entry.id], skills: [{ id: entry.id, name: entry.skill }], supervision_action: actions[index],
      skill_eligibility: [{ skill_id: entry.id, skill_name: entry.skill, proficiency: entry.proficiency, reason: entry.reason }] })) };
  const ctx = { currentUserId: 4, skills: [] };
  const node = h.subtaskListNode(task, ctx);
  const summaries = node.children.map(row => contextSummary(row.children[1]));
  assert.equal(summaries[0], 'Laundry Sorting · Independent');
  assert.equal(summaries[1], 'Fold Laundry · Supervision needed');
  assert.equal(summaries[2], 'Washing Machine · Cannot perform even with supervision');
  assert.equal(summaries[3], 'Dryer · Cannot perform even with supervision');
  const legacy = h.subtaskListNode({ ...task, subtasks: task.subtasks.map(({ skill_eligibility, ...subtask }) => subtask) }, ctx);
  const toggles = view => view.children.map(row => ({ disabled: row.children[0].disabled, label: row.children[0].attributes['aria-label'] }));
  assert.deepEqual(toggles(node), toggles(legacy), 'read-only explanations cannot grant or remove operational permission');
  assert.deepEqual(toggles(node).map(toggle => toggle.disabled), [false, true, true, true]);
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const all = flatten(h.supervisionNode(task, {}));
  assert.ok(all.some(el => el.textContent === 'Skill restriction'));
  assert.ok(all.some(el => el.textContent === 'A supervisor cannot override these skill restrictions.'));
  for (const entry of entries.slice(1)) {
    assert.ok(elementText(node).includes(entry.reason), `${entry.title} keeps its own explanation in the matching subtask disclosure`);
  }
  assert.ok(!all.some(el => el.textContent.includes('Legacy')), 'presentation reasons replace, not mutate, old diagnostics');
  assert.equal(all.filter(el => ['SELECT', 'INPUT', 'BUTTON'].includes(el.tagName)).length, 0);
});

test('a permitted supervised action explains missing supervisor availability instead of a learner skill prohibition', () => {
  const h = detailHarness();
  const reason = 'Eleanor can perform Load washer with supervision for Washing Machine, but no qualified supervisor is available during this Task’s completion window.';
  const task = { id: 1, title: "Eleanor's Laundry", supervision: { state: 'needed', eligible_supervisors: [],
    reason: 'No qualified supervisor is available during this Task’s completion window.',
    supervisor_explanations: [{ name: 'Duane', eligible: false, reason: 'Legacy candidate diagnostic',
      display_reason: 'Duane is qualified but unavailable during this Task’s completion window.' }],
    actions: [{ action_task_id: 2, action_title: 'Load washer', state: 'unresolved', can_complete: false,
      reason: 'Legacy action diagnostic', display_reason: reason, required_skills: [{ name: 'Washing Machine' }] }] }, subtasks: [{ id: 2, title: 'Load washer', status: 'open',
      permissions: { complete: true }, skill_ids: [3], skills: [{ id: 3, name: 'Washing Machine' }],
      skill_eligibility: [{ skill_id: 3, skill_name: 'Washing Machine', proficiency: 'supervised', reason }] }] };
  const row = h.subtaskListNode(task, { currentUserId: 4, skills: [] }).children[0];
  assert.equal(contextSummary(row.children[1]), 'Washing Machine · Supervision needed');
  assert.equal(row.children[0].disabled, true);
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const all = flatten(h.supervisionNode(task, {}));
  assert.ok(elementText(row).includes(reason), 'the canonical action reason is available in its subtask disclosure');
  assert.ok(all.some(el => el.textContent === 'Duane: Duane is qualified but unavailable during this Task’s completion window.'));
  assert.ok(!all.some(el => el.textContent.includes('Legacy')));
  assert.ok(!all.some(el => /Skill restriction|Cannot perform even with supervision/.test(el.textContent)));
});

test('capability denial removes operational access independently of skill labels', () => {
  const h = detailHarness();
  const node = h.subtaskListNode({ subtasks: [{ id: 2, title: 'Fold laundry', status: 'done', permissions: { complete: false } }] }, { currentUserId: 4, skills: [] });
  assert.equal(node.children[0].children[0].disabled, true);
  assert.equal(node.children[0].children[0].attributes['aria-label'], 'Reopen: Fold laundry');
});

test('detail hierarchy keeps tags after instructions and one supervisor summary before subtasks, with Activity collapsed below comments', () => {
  const source = read('components/task-detail.js');
  const render = source.slice(source.indexOf('function renderTaskDetail('), source.indexOf('\n/**\n * Die Notiz'));
  const order = ['statusSummaryNode', 'descriptionNode', '{ node: tags }', 'supervisionNode', 'subtaskListNode', 'metadataNode', 'documentListNode', 'commentsNode', '{ node: activity }'];
  assert.deepEqual(order.map(name => render.indexOf(name)).sort((a, b) => a - b), order.map(name => render.indexOf(name)));
});


test('saved operational selectors do not dirty the modal while Edit and comment drafts remain protected', () => {
  const code = /function serializeForm\([\s\S]*?\n\}/.exec(read('components/modal.js'))[0];
  const context = vm.createContext({});
  vm.runInContext(`${code};this.serializeForm=serializeForm`, context);
  const operation = { name: 'status', value: 'open', hasAttribute: key => key === 'data-immediate-action' };
  const draft = { name: 'description', value: 'Original instructions', hasAttribute: () => false };
  const comment = { name: 'comment', value: '', hasAttribute: () => false };
  const container = { querySelectorAll: () => [operation, draft, comment] };
  const saved = context.serializeForm(container);
  operation.value = 'done';
  assert.equal(context.serializeForm(container), saved);
  draft.value = 'Unsent edit';
  assert.notEqual(context.serializeForm(container), saved);
  draft.value = 'Original instructions'; comment.value = 'Unsent discussion';
  assert.notEqual(context.serializeForm(container), saved);
});


test('restricted learners see supervision context without inaccessible support links or repeated reasons', () => {
  const h = detailHarness();
  const reason = 'The learner needs supervision for Washing Machine.';
  const task = { id: 1, title: 'Laundry', permissions: {}, supervision: { state: 'assigned', reason, can_view_support: false,
    actions: [{ action_title: 'Load washer', state: 'assigned', reason, counterpart_task_id: 3, supervisor_name: 'Parent', required_skills: [{ name: 'Washing Machine' }] }] } };
  const node = h.supervisionNode(task, {});
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  assert.equal(flatten(node).filter(el => el.tagName === 'A').length, 0);
  assert.equal(flatten(node).filter(el => el.textContent === reason).length, 1);
  task.supervision.can_view_support = true;
  assert.equal(flatten(h.supervisionNode(task, {})).filter(el => el.tagName === 'A').length, 1);
});

test('all supervised actions share one Task-level supervisor picker and source revision', async () => {
  const writes = [];
  const h = detailHarness({ api: { post: async (path, body) => { writes.push({ path, body }); } } });
  const task = { id: 90, title: 'Supervise Laundry', is_supervision_projection: true,
    supervision: { source_task_id: 1, source_revision: 7, state: 'assigned', may_assign: true,
      supervisor_user_id: 5, supervisor_name: 'Parent', eligible_supervisors: [{ id: 5, display_name: 'Parent' }, { id: 6, display_name: 'Other parent' }],
      actions: [{ action_task_id: 2, action_title: 'Load washer', state: 'assigned', supervisor_name: 'Parent', eligible_supervisors: [{ id: 8, display_name: 'Washer-only helper' }] },
        { action_task_id: 3, action_title: 'Start dryer', state: 'assigned', supervisor_name: 'Parent', eligible_supervisors: [{ id: 9, display_name: 'Dryer-only helper' }] }] } };
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const all = flatten(h.supervisionNode(task, { runMutation: (_button, write) => write() }));
  const selectors = all.filter(el => el.tagName === 'SELECT');
  assert.equal(selectors.length, 1, 'one control covers the entire source Task');
  assert.equal(selectors[0].attributes['aria-label'], 'Supervisor for all remaining supervised actions');
  assert.deepEqual(selectors[0].children.map(option => option.textContent), ['Parent', 'Other parent']);
  assert.equal(all.filter(el => el.textContent === 'Parent · Covers all remaining supervised actions.').length, 1);
  const assign = all.find(el => el.tagName === 'BUTTON');
  selectors[0].value = '6';
  task.supervision.source_revision = 99;
  await assign.listeners.click();
  assert.deepEqual(value(writes), [{ path: '/tasks/1/supervisor', body: { supervisor_user_id: 6, expected_revision: 7 } }]);
});

test('split skill coverage is explained without offering individual-action helper choices', () => {
  const h = detailHarness();
  const task = { id: 1, title: 'Laundry', permissions: { reassign: true, change_assignment: true }, supervision: {
    source_task_id: 1, source_revision: 7, state: 'needed', may_assign: true, qualified_supervisor_count: 0, eligible_supervisors: [],
    reason: 'No single household member can supervise both Washing Machine and Dryer.',
    supervisor_explanations: [{ user_id: 5, name: 'Alex', eligible: false, reason: 'Cannot supervise Dryer.' },
      { user_id: 6, name: 'Sam', eligible: false, reason: 'Cannot supervise Washing Machine.' }],
    actions: [{ action_task_id: 2, action_title: 'Load washer', state: 'unresolved', eligible_supervisors: [{ id: 5, display_name: 'Alex' }] },
      { action_task_id: 3, action_title: 'Start dryer', state: 'unresolved', eligible_supervisors: [{ id: 6, display_name: 'Sam' }] }],
  } };
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  const all = flatten(h.supervisionNode(task, {}));
  assert.equal(all.filter(el => el.tagName === 'SELECT' || el.tagName === 'BUTTON').length, 0);
  assert.ok(all.some(el => el.textContent === task.supervision.reason));
  assert.ok(all.some(el => el.textContent === 'Alex: Cannot supervise Dryer.'));
  assert.ok(all.some(el => el.textContent === 'Sam: Cannot supervise Washing Machine.'));
});

test('manual supervisor selection requires explicit source permission rather than local assignment controls', () => {
  const h = detailHarness();
  const task = { id: 1, permissions: { reassign: true, change_assignment: true }, supervision: {
    source_task_id: 1, source_revision: 7, state: 'needed', may_assign: false,
    eligible_supervisors: [{ id: 5, display_name: 'Parent' }],
    actions: [{ action_task_id: 2, state: 'unresolved', eligible_supervisors: [{ id: 5, display_name: 'Parent' }] }],
  } };
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  assert.equal(flatten(h.supervisionNode(task, {})).filter(el => el.tagName === 'SELECT').length, 0);
  delete task.supervision.may_assign;
  assert.equal(flatten(h.supervisionNode(task, {})).filter(el => el.tagName === 'SELECT').length, 0, 'older or redacted responses cannot infer permission');
});

test('completed action helpers are clearly historical while the remaining scope has one current supervisor', () => {
  const h = detailHarness();
  const task = { id: 1, title: 'Laundry', supervision: { source_task_id: 1, state: 'assigned',
    supervisor_user_id: 6, supervisor_name: 'Current parent', may_assign: true, eligible_supervisors: [{ id: 6, display_name: 'Current parent' }],
    actions: [{ action_task_id: 2, action_title: 'Load washer', state: 'fulfilled', completed: true, supervisor_name: 'Previous parent', required_skills: [{ name: 'Washing Machine' }] },
      { action_task_id: 3, action_title: 'Start dryer', state: 'assigned', completed: false, supervisor_name: 'Current parent', required_skills: [{ name: 'Dryer' }] }] } };
  const flatten = el => [el, ...el.children.flatMap(flatten)];
  let all = flatten(h.supervisionNode(task, {}));
  assert.ok(all.some(el => el.textContent === 'Washing Machine · Completed · Previously supervised by Previous parent'));
  assert.equal(all.filter(el => el.textContent === 'Current parent · Covers all remaining supervised actions.').length, 1);
  assert.ok(!all.some(el => el.textContent.includes('Supervisor: Previous parent')));
  task.supervision.actions[1].completed = true;
  task.supervision.state = 'none';
  all = flatten(h.supervisionNode(task, {}));
  assert.equal(all.filter(el => el.tagName === 'SELECT').length, 0, 'completed history cannot acquire a new active supervisor');
});

test('completed subtask context does not present its historical helper as the current supervisor', () => {
  const h = detailHarness();
  const task = { subtasks: [{ id: 2, title: 'Load washer', status: 'done', permissions: { complete: true }, supervision_action: {
    state: 'fulfilled', completed: true, supervisor_user_id: 5, supervisor_name: 'Previous parent', can_complete: true } }] };
  const meta = h.subtaskListNode(task, { currentUserId: 4, skills: [] }).children[0].children[1];
  assert.match(elementText(meta), /Previously supervised by Previous parent/);
  assert.doesNotMatch(elementText(meta), /Supervision needed|Supervisor:/);
});

test('Task mutations restore a focused supervisor control after disabling and replacing it', async () => {
  const document = { body: {}, activeElement: null };
  const replacement = { disabled: false, focus(options) { document.activeElement = this; assert.equal(options.preventScroll, true); } };
  document.querySelector = selector => {
    assert.equal(selector, '.detail-view__pane');
    return { querySelector(key) { assert.equal(key, '[data-focus-key="assign-task-supervisor"]'); return replacement; } };
  };
  const button = { dataset: { focusKey: 'assign-task-supervisor' }, isConnected: false,
    set disabled(value) { if(value) document.activeElement = document.body; } };
  document.activeElement = button;
  const ctx = { refresh: async () => {}, onChanged: async () => {} };
  await detailHarness({ document }).runTaskDetailMutation(ctx, button, async () => ({}));
  assert.equal(document.activeElement, replacement);
  assert.equal(ctx.busy, false);
});

test('a late Task mutation does not steal focus from a comment or a closed detail', async () => {
  const document = { body: {}, activeElement: null, querySelector() { throw new Error('Must not restore an obsolete focus target'); } };
  const button = { dataset: { focusKey: 'assign-task-supervisor' }, isConnected: false,
    set disabled(value) { if(value) document.activeElement = document.body; } };
  const comment = {};
  const ctx = { refresh: async () => {}, onChanged: async () => { document.activeElement = comment; } };
  document.activeElement = button;
  await detailHarness({ document }).runTaskDetailMutation(ctx, button, async () => ({}));
  assert.equal(document.activeElement, comment);
  document.activeElement = button;
  ctx.closed = true; ctx.onChanged = async () => {};
  await detailHarness({ document }).runTaskDetailMutation(ctx, button, async () => ({}));
  assert.equal(document.activeElement, document.body);
});

test('new Tasks views include work in progress and do not advertise creation to restricted members', () => {
  const source = read('pages/tasks.js');
  assert.match(source, /filters:\s*\{ status: \['open', 'in_progress'\]/);
  assert.match(source, /action: canCapability\('tasks.create'\) \? [^\n]+empty-cta-tasks/);
  assert.match(source, /hint: canCapability\('tasks.create'\) \? t\('emptyHint.tasks'\) : undefined/);
});


test('late comment reads and sends preserve newer conversation state and unsent text', async () => {
  const reads = []; let finishPost;
  const h = detailHarness({ api: {
    get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    post: () => new Promise(resolve => { finishPost = resolve; }),
  } });
  const ctx = { users: [] };
  const node = h.commentsNode({ id: 1, permissions: { comment: true } }, ctx);
  const newest = ctx.refreshComments();
  reads[1].resolve({ data: [] }); await newest;
  const accepted = node.children[0].children[0];
  reads[0].reject(new Error('obsolete error')); await Promise.resolve();
  assert.equal(node.children[0].children[0], accepted, 'late errors cannot replace the latest comments');
  const form = node.children[1]; const field = form.children[0].children[0];
  field.value = 'First comment';
  const posting = form.listeners.submit({ preventDefault() {} });
  field.value = 'A new unsent comment';
  finishPost({ data: {} }); await new Promise(setImmediate);
  reads[2].resolve({ data: [] }); await posting;
  assert.equal(field.value, 'A new unsent comment', 'an older send response cannot erase newly typed text');
});


test('reopened Tasks show actual historical parent completion when the current completion ledger is empty', async () => {
  const h = detailHarness({ api: { get: async () => ({ data: [] }) }, formatDate: value => value.slice(0, 10), formatTime: () => '14:30' });
  const node = h.seriesHistoryNode({ id: 1, status: 'in_progress' }, { activityRequest: Promise.resolve({ data: [
    { event_type: 'reopened', action_task_id: 1, created_at: '2026-09-12T15:00:00Z' },
    { event_type: 'completed', action_task_id: 2, created_at: '2026-09-12T14:45:00Z', actor_name: 'Other actor' },
    { event_type: 'completed', action_task_id: 1, created_at: '2026-09-12T14:30:00Z', actor_name: 'Parent' },
  ] }) });
  await new Promise(setImmediate);
  assert.match(node.children[0].textContent, /2026-09-12 14:30.*Parent.*Historical completion retained in Activity/);
  assert.doesNotMatch(node.children[0].textContent, /Never|Other actor/);
});

test('child completion is not reported as parent completion and empty net history makes no claim about the past', async () => {
  const h = detailHarness({ api: { get: async () => ({ data: [] }) } });
  const node = h.seriesHistoryNode({ id: 1 }, { activityRequest: Promise.resolve({ data: [
    { event_type: 'completed', action_task_id: 2, created_at: '2026-09-12T14:30:00Z' },
  ] }) });
  await new Promise(setImmediate);
  assert.equal(node.children[0].textContent, 'No completed or expired occurrences currently recorded.');
});
