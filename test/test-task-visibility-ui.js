import test from 'node:test';
import assert from 'node:assert/strict';

// Import the actual Tasks helpers; only unrelated browser integrations use the
// existing loader stubs. Authorization belongs to the API, before these rows
// reach the page. A device layout must not add an implicit assignment filter.
globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
globalThis.customElements = globalThis.customElements ?? { define() {}, get() {} };
const { __test: tasks } = await import('../public/pages/tasks.js');

const initial = {
  tasks: tasks.state.tasks,
  currentUserId: tasks.state.currentUserId,
  boardScope: tasks.state.boardScope,
  viewMode: tasks.state.viewMode,
  searchQuery: tasks.state.searchQuery,
  filters: tasks.state.filters,
  showFuture: tasks.state.showFuture,
};
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage;

test.beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => storage.get(key) ?? null },
  });
  Object.assign(tasks.state, {
    tasks: [], currentUserId: 1, boardScope: 'personal', viewMode: 'list',
    searchQuery: '', showFuture: false,
    filters: { status: ['open', 'in_progress'], priority: [], assigned_to: [], tags: [] },
  });
});
test.afterEach(() => {
  Object.assign(tasks.state, initial);
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else delete globalThis.localStorage;
});

function sharedTask(overrides = {}) {
  return {
    id: 72, title: 'Eleanor laundry', description: 'Sort clothes', created_by: 1,
    assigned_to: 2, assigned_users: [{ id: 2, display_name: 'Eleanor' }],
    visibility: 'all', status: 'open', permissions: { view: true }, tags: ['Laundry'],
    ...overrides,
  };
}
const boardIds = () => tasks.boardTasks().map(row => row.id);
const query = () => new URLSearchParams(tasks.taskQuery().replace(/^\?/, ''));

for (const [name, viewer] of [['creator', 1], ['assignee', 2], ['another authorized household member', 3]]) {
  test(`${name} retains an API-authorized household Task assigned to Eleanor in the normal board`, () => {
    tasks.state.currentUserId = viewer;
    tasks.state.tasks = [sharedTask()];
    tasks.state.boardScope = tasks.deviceTaskBoardScope();
    assert.equal(tasks.state.boardScope, 'personal');
    assert.deepEqual(boardIds(), [72]);
    assert.deepEqual(query().getAll('assigned_to'), [], 'a device does not silently select Assigned to me');
  });
}

test('Wall device preference changes Tasks layout without replacing authenticated API visibility', () => {
  // The signed-in creator may see this private Task. This is the normal Tasks
  // page; dashboard shared-display presentation is a separate surface.
  tasks.state.tasks = [sharedTask(), sharedTask({ id: 73, visibility: 'private', title: 'Creator private Task' })];
  for (const [enabled, layout] of [['0', 'personal'], ['1', 'household']]) {
    storage.set('yuvomi-wall-mode', enabled);
    tasks.state.boardScope = tasks.deviceTaskBoardScope();
    assert.equal(tasks.state.boardScope, layout);
    assert.deepEqual(boardIds(), [72, 73]);
  }
});

test('an own-only API response remains its complete board audience without fabricated household rows', () => {
  tasks.state.currentUserId = 2;
  tasks.state.tasks = [sharedTask(), sharedTask({ id: 74, visibility: 'assignees' })];
  for (const layout of ['personal', 'household']) {
    tasks.state.boardScope = layout;
    assert.deepEqual(boardIds(), [72, 74]);
  }
});

test('board search still filters authorized rows by title, description and tags', () => {
  tasks.state.tasks = [
    sharedTask(),
    sharedTask({ id: 73, title: 'Kitchen', description: 'Clean counter', tags: ['Cooking'] }),
    sharedTask({ id: 74, title: 'Study', description: 'Read chapter', tags: [] }),
  ];
  for (const [search, expected] of [[' ELEANOR ', [72]], ['counter', [73]], ['COOKING', [73]], ['missing', []]]) {
    tasks.state.searchQuery = search;
    assert.deepEqual(boardIds(), expected);
  }
  tasks.state.searchQuery = '';
  assert.deepEqual(boardIds(), [72, 73, 74]);
});

test('Not Started and In Progress are included by the default list query and both remain on the board', () => {
  tasks.state.tasks = [sharedTask(), sharedTask({ id: 73, status: 'in_progress' })];
  assert.deepEqual(query().getAll('status'), ['open', 'in_progress']);
  assert.deepEqual(boardIds(), [72, 73]);
  tasks.state.viewMode = 'kanban';
  assert.deepEqual(query().getAll('status'), [], 'board columns represent status, including Completed');
  assert.equal(query().get('archived'), '1', 'the existing board Archive column remains requested');
  assert.deepEqual(boardIds(), [72, 73]);
});

test('explicit assignee, priority and tag filters remain API query constraints in list and board', () => {
  tasks.state.filters.assigned_to = ['1', '2'];
  tasks.state.filters.priority = ['high'];
  tasks.state.filters.tags = ['Laundry', 'School'];
  for (const mode of ['list', 'kanban']) {
    tasks.state.viewMode = mode;
    const params = query();
    assert.deepEqual(params.getAll('assigned_to'), ['1', '2']);
    assert.deepEqual(params.getAll('priority'), ['high']);
    assert.deepEqual(params.getAll('tag'), ['Laundry', 'School']);
  }
});

test('future-start scope retains the explicit Show future toggle and Calendar inclusion', () => {
  for (const mode of ['list', 'kanban']) {
    tasks.state.viewMode = mode;
    tasks.state.showFuture = false;
    assert.equal(query().has('include_future'), false);
    tasks.state.showFuture = true;
    assert.equal(query().get('include_future'), '1');
  }
  tasks.state.showFuture = false;
  tasks.state.viewMode = 'calendar';
  assert.equal(query().get('include_future'), '1');
  assert.deepEqual(query().getAll('status'), ['open', 'in_progress']);
});

test('a refreshed or live-reloaded authorized snapshot has the same cross-user board membership', () => {
  const row = sharedTask();
  tasks.state.tasks = [row];
  assert.deepEqual(boardIds(), [72]);
  // The page replaces API snapshots after initial load, creation and live
  // refresh. Membership cannot depend on a create-only flag or object identity.
  tasks.state.tasks = JSON.parse(JSON.stringify([row]));
  assert.deepEqual(boardIds(), [72]);
  tasks.state.tasks = [sharedTask({ revision: 2, status: 'in_progress' })];
  assert.deepEqual(boardIds(), [72]);
});
