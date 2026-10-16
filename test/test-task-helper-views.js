import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { define() {}, get() {} };
const { __test: page } = await import('../public/pages/tasks.js');
const { completionCounts } = await import('../public/utils/task-fields.js');
const person = id => ({ id, display_name: `Member ${id}` });
const child = (id, ids = [], extra = {}) => ({ id, parent_task_id: 10, title: `Step ${id}`, status: 'open', points: 2,
  assigned_to: ids[0] ?? null, assigned_users: ids.map(person), explicit_assignee_ids: ids,
  permissions: { view: true, complete: true }, ...extra });
const sample = extra => ({ id: 10, title: 'Accepted work', status: 'open', assigned_to: 2,
  assigned_users: [2, 3, 4, 9].map(person), direct_assignee_ids: [2, 3, 4], is_accepted_bounty: true,
  permissions: { view: true, complete: true, reopen: true, edit: true },
  activity_responsibilities: [{ user_id: 9, display_name: 'Former owner', role: 'primary', source: 'claim' }],
  subtasks: [child(101, [2]), child(102, [3]), child(103), child(104, [4]), child(105, [5])], ...extra });
const buckets = task => page.taskBuckets([task], 'assignee');
const forUser = (rows, id) => rows.find(row => row.id === `user-${id}`)?.tasks[0];

test('accepted bounty keeps the full canonical primary and projects each current helper subset', () => {
  const task = sample(), before = structuredClone(task), rows = buckets(task);
  assert.equal(forUser(rows, 2), task);
  assert.deepEqual(rows.map(row => row.id), ['user-2', 'user-3', 'user-4', 'user-5']);
  for (const [id, ids] of [[3, [102, 103]], [4, [103, 104]], [5, [103, 105]]]) {
    const view = forUser(rows, id);
    assert.equal(view.id, task.id, 'action IDs remain canonical');
    assert.equal(view.helper_view_user_id, id);
    assert.deepEqual(view.subtasks.map(row => row.id), ids);
    assert.deepEqual(view.assigned_users.map(row => row.id), [id]);
  }
  assert.deepEqual(task, before, 'grouping never mutates canonical state');
});

test('reassignment follows current owner and children rather than former acceptance responsibilities', () => {
  const task = sample({ assigned_to: 4, direct_assignee_ids: [4, 3], subtasks: [child(102, [5])] });
  const rows = buckets(task);
  assert.equal(forUser(rows, 4), task);
  assert.equal(forUser(rows, 2), undefined);
  assert.equal(forUser(rows, 3), undefined, 'helper disappears when no own or unassigned children remain');
  assert.deepEqual(forUser(rows, 5).subtasks.map(row => row.id), [102]);
});

test('unassigned device children use explicit metadata despite inherited participant arrays', () => {
  const task = sample({ subtasks: [child(103, [], { assigned_users: [2, 3, 4].map(person) })] });
  for (const id of [3, 4]) assert.deepEqual(forUser(buckets(task), id).subtasks.map(row => row.id), [103]);
});

test('historical accepted work without direct provenance retains its existing participant cards',()=>{
  const task=sample({direct_assignee_ids:null,subtasks:[child(103,[])]}),rows=buckets(task);
  assert.deepEqual(rows.map(row=>row.id),['user-2','user-3','user-4','user-9']);
  assert.equal(forUser(rows,3),task,'unknown direct-vs-visibility membership is not guessed or hidden');
});

test('helper grouping excludes archived and generated counterparts without changing ordinary shared work', () => {
  const task = sample({ subtasks: [child(102, [3]), child(103, [], { archived_at: 'past' }),
    child(104, [6], { is_supervision_projection: true }), child(105, [7], { is_support_task: true })] });
  assert.deepEqual(buckets(task).map(row => row.id), ['user-2', 'user-3']);
  const ordinary = sample({ is_accepted_bounty: false });
  assert.ok(buckets(ordinary).every(row => row.tasks[0] === ordinary));
  const supervision = sample({ is_supervision_projection: true });
  assert.ok(buckets(supervision).every(row => row.tasks[0] === supervision));
  assert.equal(page.taskBuckets([task], 'none')[0].tasks[0], task);
  assert.ok(page.taskBuckets([task], 'assignee', { helperViews: false }).every(row => row.tasks[0] === task));
});

test('shared explicit allocation appears for each current recipient without copying root scheduled totals', () => {
  const task = sample({ subtasks: [child(102, [3, 4]), child(103, [], { is_optional: 1 })],
    scheduled_subtask_total: 12, scheduled_subtask_points: 99 });
  for (const id of [3, 4]) {
    const view = forUser(buckets(task), id);
    assert.deepEqual(view.subtasks.map(row => row.id), [102, 103]);
    assert.equal(view.subtasks[0], task.subtasks[0]);
    assert.equal(view.scheduled_subtask_total, undefined);
    assert.equal(view.scheduled_subtask_points, undefined);
    assert.equal(view.status, task.status, 'helper has no independent lifecycle');
    assert.equal(completionCounts(view, id).totalPoints, null, 'helper view cannot fabricate a reward from child definitions');
  }
});

test('helper cards expose child actions and an explicit full-activity link without parent mutation controls', () => {
  const helper = forUser(buckets(sample()), 3);
  const html = page.renderTaskCard(helper, { board: true, showCheckbox: true, expandedSubtasks: true });
  assert.match(html, /data-helper-view-user-id="3"/);
  assert.match(html, /Open full activity/);
  assert.match(html, /Helper work/);
  assert.match(html, /data-action="toggle-subtask" data-id="102"/);
  assert.doesNotMatch(html, /data-action="toggle-status"|data-task-drag-handle|task-bulk-checkbox/);
  assert.doesNotMatch(html, /class="activity-card__points"/);
});
