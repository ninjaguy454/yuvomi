import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCardSubtasks, taskCardPendingProjection } from '../public/utils/task-card-subtasks.js';

const children = task => task?.subtasks || [];
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const sample = () => ({ id: 1, revision: 4, status: 'open', points: 2, subtasks: [
  { id: 11, revision: 1, status: 'open', points: 0 },
  { id: 12, revision: 1, status: 'open', points: 0 },
  { id: 13, revision: 1, status: 'open', points: 0, is_optional: 1 },
] });
function fixture(initial = sample()) {
  let tasks = [initial], invalidations = 0, refreshes = 0;
  const calls = [], paints = [], errors = [];
  const controller = createTaskCardSubtasks({ children,
    canComplete: (_task, child) => child.permissions?.complete !== false && child.supervision_action?.can_complete !== false,
    send: (child, status, parent) => new Promise((resolve, reject) => calls.push({ child, status, parent, resolve, reject })),
    invalidateReads: () => invalidations++,
    onCanonical: task => { tasks = tasks.map(row => row.id === task.id ? task : row); },
    onPending: (task, pending, queue) => paints.push({ task, pending, busy: queue.busy, blocked: queue.blocked }),
    onError: error => errors.push(error), refresh: () => { refreshes++; },
  });
  const acknowledge = (index, overrides = {}) => {
    const call = calls[index];
    const current = tasks.find(task => task.id === call.parent.id) || call.parent;
    const fresh = { ...structuredClone(current), revision: current.revision + 1, status: 'in_progress', ...overrides };
    fresh.subtasks = fresh.subtasks.map(child => ({ ...child, parent_revision: fresh.revision,
      ...(child.id === call.child.id ? { status: call.status, revision: child.revision + 1 } : {}) }));
    call.resolve(fresh); return fresh;
  };
  return { controller, calls, paints, errors, acknowledge,
    get tasks() { return tasks; }, get invalidations() { return invalidations; }, get refreshes() { return refreshes; },
    read(fresh) { tasks = controller.reconcile(fresh); return tasks; },
    enqueue(id, status = 'done') { return controller.enqueue(tasks[0], id, status); },
  };
}

test('card intents paint before HTTP, serialize siblings and invalidate stale list reads', async () => {
  const f = fixture();
  assert.equal(f.enqueue(11), true); assert.equal(f.enqueue(12), true);
  assert.deepEqual([...f.paints.at(-1).pending.keys()], [11, 12]);
  assert.equal(f.calls.length, 1); assert.equal(f.tasks[0].subtasks[0].status, 'open');
  f.acknowledge(0); await settle();
  assert.equal(f.tasks[0].subtasks[0].status, 'done'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].child.parent_revision, 5); assert.equal(f.calls[1].child.revision, 1);
  f.acknowledge(1, { status: 'done' }); await settle();
  assert.equal(f.tasks[0].status, 'done'); assert.equal(f.refreshes, 1); assert.equal(f.invalidations, 4);
});

test('full detail acknowledgement cannot expose a scheduled child; a boundary read can', async () => {
  const initial = sample();
  initial.subtasks = [initial.subtasks[0]];
  Object.assign(initial, { scheduled_action_count: 2, scheduled_subtask_total: 1, scheduled_subtask_done: 0,
    scheduled_optional_subtask_total: 1, scheduled_optional_subtask_done: 0 });
  const f = fixture(initial);
  f.enqueue(11);
  assert.equal(f.paints.at(-1).pending.get(11).status, 'done', 'feedback precedes acknowledgement');
  const full = f.acknowledge(0, { subtasks: sample().subtasks });
  await settle();
  assert.deepEqual(f.tasks[0].subtasks.map(child => child.id), [11]);
  assert.equal(f.tasks[0].subtasks[0].status, 'done');
  assert.equal(f.tasks[0].scheduled_subtask_total, 1);
  const activated = { ...full, scheduled_action_count: 0, scheduled_subtask_total: 0, scheduled_optional_subtask_total: 0 };
  f.read([activated]);
  assert.deepEqual(f.tasks[0].subtasks.map(child => child.id), [11, 12, 13]);
  f.controller.dispose();
});

test('duplicate/opposite taps on a pending card step do not dispatch twice', async () => {
  const f = fixture(); f.enqueue(11);
  assert.equal(f.enqueue(11), false); assert.equal(f.enqueue(11, 'in_progress'), false);
  assert.equal(f.calls.length, 1); f.acknowledge(0); await settle();
  assert.equal(f.enqueue(11, 'in_progress'), true); f.acknowledge(1); await settle();
  assert.equal(f.tasks[0].subtasks[0].status, 'in_progress');
});

test('list reconciliation and explicit repaint retain pending state without changing canonical progress', async () => {
  const f = fixture(); f.enqueue(11); f.read([sample()]); f.controller.repaint();
  assert.equal(f.paints.at(-1).pending.get(11).status, 'done');
  assert.equal(f.tasks[0].subtasks[0].status, 'open');
  f.acknowledge(0); await settle();
  const accepted = f.tasks[0]; f.read([sample()]);
  assert.equal(f.tasks[0], accepted); assert.equal(f.tasks[0].revision, 5);
});

test('equal-revision live permission changes outrank the delayed acknowledgement', async () => {
  const f = fixture(); f.enqueue(11); f.enqueue(12);
  const ack = f.acknowledge(0);
  const newerRead = structuredClone(ack); newerRead.subtasks[1].permissions = { complete: false };
  f.read([newerRead]); await settle();
  assert.equal(f.tasks[0].subtasks[1].permissions.complete, false);
  assert.equal(f.calls.length, 1); assert.equal(f.paints.at(-1).pending.size, 0);
});

test('newer live reset outranks old HTTP and clears the provisional indicator', async () => {
  const f = fixture(); f.enqueue(11); f.enqueue(12);
  const ack = f.acknowledge(0);
  const reset = sample(); reset.revision = ack.revision + 2; reset.subtasks[0].revision = 4;
  f.read([reset]); await settle();
  assert.equal(f.tasks[0].revision, 7); assert.equal(f.tasks[0].subtasks[0].status, 'open');
  assert.equal(f.paints.at(-1).pending.size, 0); assert.equal(f.calls.length, 1);
});

for (const reason of ['permission_denied', 'stale_revision', 'task_not_started', 'task_expired', 'supervision_required']) {
  test(`${reason} restores canonical card state and refreshes once without a write retry`, async () => {
    const f = fixture(); f.enqueue(11); f.enqueue(12);
    const error = Object.assign(new Error(reason), { status: 409, data: { error: reason } });
    f.calls[0].reject(error); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 1); assert.equal(f.errors[0], error);
    assert.equal(f.refreshes, 1); assert.equal(f.paints.at(-1).pending.size, 0);
    assert.equal(f.paints.at(-1).blocked, true); assert.equal(f.tasks[0].subtasks[0].status, 'open');
    assert.equal(f.enqueue(13), false);
    f.read([sample()]); assert.equal(f.enqueue(13), true);
    f.controller.dispose();
  });
}

test('required final response cancels unsent optional action, preserving points from the server', async () => {
  const f = fixture(); f.enqueue(11); f.enqueue(13);
  f.acknowledge(0, { status: 'done', points: 2 }); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.tasks[0].subtasks[2].status, 'open');
  assert.equal(f.tasks[0].points, 2); assert.equal(f.paints.at(-1).pending.size, 0);
});

test('removing a card disposes its queue and ignores its late response', async () => {
  const f = fixture(); f.enqueue(11); f.enqueue(12);
  f.read([]); const painted = f.paints.length; f.acknowledge(0); await settle();
  assert.deepEqual(f.tasks, []); assert.equal(f.calls.length, 1); assert.equal(f.paints.length, painted);
});

test('required provisional counts safely start/reopen but never complete the canonical parent', () => {
  const original = sample(), pending = new Map([[11, { status: 'done' }], [12, { status: 'done' }]]);
  const projected = taskCardPendingProjection(original, pending, children);
  assert.equal(projected.status, 'in_progress'); assert.equal(projected.points, 2);
  assert.equal(projected.subtasks.filter(child => !child.is_optional && child.status === 'done').length, 2);
  assert.equal(original.status, 'open'); assert.equal(original.subtasks[0].status, 'open');
  const done = { ...original, status: 'done' };
  assert.equal(taskCardPendingProjection(done, new Map([[11, { status: 'in_progress' }]]), children).status, 'in_progress');
});

test('optional and supervised/helper actions get child feedback without predicting parent lifecycle', () => {
  const original = sample();
  const optional = taskCardPendingProjection(original, new Map([[13, { status: 'done' }]]), children);
  assert.equal(optional.status, 'open'); assert.equal(optional.subtasks[2].status, 'done');
  for (const kind of ['supervised', 'delegated', 'helper']) {
    const task = sample();
    task.subtasks[0].supervision_action = { state: 'assigned', execution_mode: kind };
    if (kind === 'helper') task.is_supervision_projection = true;
    const view = taskCardPendingProjection(task, new Map([[11, { status: 'done' }]]), children);
    assert.equal(view.status, 'open'); assert.equal(view.subtasks[0].status, 'done');
  }
});
