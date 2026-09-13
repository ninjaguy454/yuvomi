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
  vm.runInContext(`${plain(read('utils/task-progress.js'))}\n${plain(read('utils/task-state.js'))}\nthis.subject={actionableSubtasks,taskRevision,taskStatusConfirmation,changeTaskStatus}`, context);
  return { ...context.subject, writes };
}

test('progress excludes archived/support children while the supervision view counts its own projections', () => {
  const { actionableSubtasks } = stateHarness();
  const task = { subtasks: [{ id: 1 }, { id: 2, archived_at: '2050-01-01' }, { id: 3, is_supervision_projection: true }, { id: 4, is_support_task: true }] };
  assert.deepEqual(value(actionableSubtasks(task)).map(x => x.id), [1]);
  assert.deepEqual(value(actionableSubtasks({ ...task, is_supervision_projection: true })).map(x => x.id), [1, 3]);
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
function detailHarness(overrides = {}) {
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) }, HTMLElement: Element, window: {},
    canTask: (task, key) => task?.permissions?.[key] === true, isArchived: task => !!task.archived_at,
    t: key => key, actionableSubtasks: stateHarness().actionableSubtasks, ...overrides });
  vm.runInContext(`${plain(read('components/task-detail.js'))}\nthis.subject={subtaskListNode,supervisionNode,commentsNode,seriesHistoryNode}`, context);
  return context.subject;
}

test('normal detail exposes operational toggles and read-only required skills, never definition/skill editors', () => {
  const h = detailHarness();
  const task = { subtasks: [{ id: 2, title: 'Load washer', status: 'open', permissions: { complete: true }, skill_ids: [3], skills: [{ id: 3, name: 'Washing Machine' }] }] };
  const node = h.subtaskListNode(task, { currentUserId: 4, skills: [] });
  const row = node.children[0];
  assert.equal(row.children[0].tagName, 'BUTTON');
  assert.match(row.children[1].textContent, /Washing Machine/);
  const tags = []; const walk = el => { tags.push(el.tagName); el.children?.forEach(walk); }; walk(node);
  assert.ok(!tags.includes('INPUT') && !tags.includes('SELECT') && !tags.includes('FORM'));
});

test('supervised actions are operable by the current eligible supervisor and visibly restricted for the learner', () => {
  const h = detailHarness();
  const task = { subtasks: [{ id: 2, title: 'Load washer', status: 'open', permissions: { complete: true }, supervision_action: {
    state: 'assigned', supervisor_user_id: 5, supervisor_name: 'Parent', reason: 'Supervision required for Washing Machine' } }] };
  const learner = h.subtaskListNode(task, { currentUserId: 4, skills: [] });
  const supervisor = h.subtaskListNode(task, { currentUserId: 5, skills: [] });
  assert.equal(learner.children[0].children[0].disabled, true);
  assert.match(learner.children[0].children[1].textContent, /Supervision required.*Supervisor: Parent/);
  assert.equal(supervisor.children[0].children[0].disabled, false);
});

test('capability denial removes operational access independently of skill labels', () => {
  const h = detailHarness();
  const node = h.subtaskListNode({ subtasks: [{ id: 2, title: 'Fold laundry', status: 'done', permissions: { complete: false } }] }, { currentUserId: 4, skills: [] });
  assert.equal(node.children[0].children[0].disabled, true);
  assert.equal(node.children[0].children[0].attributes['aria-label'], 'Reopen: Fold laundry');
});

test('detail hierarchy keeps instructions and subtasks before compact metadata, comments before Activity', () => {
  const source = read('components/task-detail.js');
  const render = source.slice(source.indexOf('function renderTaskDetail('), source.indexOf('\n/**\n * Die Notiz'));
  const order = ['statusSummaryNode', 'descriptionNode', 'subtaskListNode', 'supervisionNode', 'metadataNode', 'documentListNode', 'commentsNode', 'activityNode'];
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
  assert.equal(node.children[0].textContent, 'No completed occurrences currently recorded.');
});
