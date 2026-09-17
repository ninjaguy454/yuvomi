import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubtaskQueue } from '../public/utils/task-subtask-queue.js';

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
  let task = { id: 1, revision: 10, status: 'open', points: 2, subtasks: [
    { id: 11, revision: 1, parent_revision: 10, status: 'open', is_optional: 0 },
    { id: 12, revision: 1, parent_revision: 10, status: 'open', is_optional: 0 },
    { id: 13, revision: 1, parent_revision: 10, status: 'open', is_optional: 1 },
  ] };
  const calls = [], paints = [], errors = [], uncertain = [], accepted = [];
  let drains = 0, forceReject = false;
  const queue = createSubtaskQueue({ getTask: () => task, getChild: id => task.subtasks.find(child => child.id === id),
    canDispatch: child => child.permissions?.complete !== false && child.supervision_action?.can_complete !== false,
    send: (child, status) => new Promise((resolve, reject) => calls.push({ child, status, resolve, reject })),
    accept: snapshot => {
      accepted.push(snapshot);
      if (forceReject || snapshot.revision < task.revision) return false;
      task = structuredClone(snapshot); return true;
    },
    onPending: pending => paints.push(pending), onError: (error, intent) => errors.push({ error, intent }),
    onUncertain: error => uncertain.push(error), onDrain: () => drains++,
  });
  const snapshot = (id, { revision = task.revision + 2, parentStatus = 'in_progress', status = 'done' } = {}) => {
    const fresh = structuredClone(task); fresh.revision = revision; fresh.status = parentStatus;
    for (const child of fresh.subtasks) {
      child.parent_revision = revision;
      if (child.id === id) { child.status = status; child.revision++; }
    }
    return fresh;
  };
  return { queue, calls, paints, errors, uncertain, accepted, snapshot,
    get task() { return task; }, get drains() { return drains; },
    external(fresh) { task = structuredClone(fresh); queue.invalidate(task); },
    rejectAccept() { forceReject = true; },
  };
}

test('different children paint immediately while requests serialize with acknowledged parent revisions', async () => {
  const f = fixture();
  assert.equal(f.queue.enqueue(11, 'done'), true); assert.equal(f.queue.enqueue(12, 'done'), true);
  assert.equal(f.calls.length, 1); assert.deepEqual([...f.paints.at(-1).keys()], [11, 12]);
  assert.equal(f.task.status, 'open'); assert.equal(f.task.points, 2); assert.ok(f.task.subtasks.every(child => child.status === 'open'));
  f.calls[0].resolve(f.snapshot(11)); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].child.revision, 1); assert.equal(f.calls[1].child.parent_revision, 12);
  assert.deepEqual([...f.queue.pending.keys()], [12]);
  f.calls[1].resolve(f.snapshot(12, { parentStatus: 'done' })); await settle();
  assert.equal(f.task.status, 'done'); assert.equal(f.queue.busy, false); assert.equal(f.drains, 1); assert.equal(f.errors.length, 0);
});

test('a pending child cannot enqueue a duplicate or opposite intent; published Maps are defensive', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done');
  assert.equal(f.queue.enqueue(11, 'done'), false); assert.equal(f.queue.enqueue(11, 'in_progress'), false);
  const pending = f.queue.pending; pending.get(11).status = 'open'; pending.clear();
  assert.equal(f.queue.pending.get(11).status, 'done'); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(f.snapshot(11)); await settle(); assert.equal(f.drains, 1);
});

test('last required acknowledgement cancels queued optional progress without sending it', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(13, 'done');
  f.calls[0].resolve(f.snapshot(11, { parentStatus: 'done' })); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.task.subtasks[2].status, 'open');
  assert.equal(f.errors[0].error.reason, 'optional_parent_completed'); assert.equal(f.queue.busy, false);
});

test('optional progress queued before the last required action can finish in that order', async () => {
  const f = fixture(); f.queue.enqueue(13, 'done'); f.queue.enqueue(11, 'done');
  f.calls[0].resolve(f.snapshot(13)); await settle(); assert.equal(f.calls.length, 2);
  f.calls[1].resolve(f.snapshot(11, { parentStatus: 'done' })); await settle();
  assert.equal(f.task.subtasks[2].status, 'done'); assert.equal(f.errors.length, 0);
});

test('a newer external canonical snapshot wins over a delayed old acknowledgement and cancels queued work', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  const ack = f.snapshot(11, { revision: 12 });
  const newer = f.snapshot(11, { revision: 14, status: 'open', parentStatus: 'open' }); f.external(newer);
  assert.equal(f.queue.pending.has(11), false, 'newer reset also wins over the pending checkbox');
  assert.equal(f.queue.enqueue(11, 'done'), false, 'hidden overlay does not release the in-flight slot');
  f.calls[0].resolve(ack); await settle();
  assert.equal(f.task.revision, 14); assert.equal(f.task.subtasks[0].status, 'open'); assert.equal(f.calls.length, 1);
  assert.equal(f.queue.pending.size, 0); assert.ok(f.errors.some(item => item.intent.id === 12));
});

test('an equal-revision SSE echo of the own write allows unchanged queued child to proceed', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  const ack = f.snapshot(11); f.external(ack); f.calls[0].resolve(ack); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].child.parent_revision, 12);
  f.calls[1].resolve(f.snapshot(12)); await settle(); assert.equal(f.errors.length, 0);
});

for (const change of ['reset', 'delete', 'reassign', 'permission', 'supervision']) test(`external ${change} cancels the affected queued intent without changing its original revision`, async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  const fresh = structuredClone(f.task);
  if (change === 'delete') fresh.subtasks = fresh.subtasks.filter(child => child.id !== 12);
  else if (change === 'permission') fresh.subtasks[1].permissions = { complete: false };
  else if (change === 'supervision') fresh.subtasks[1].supervision_action = { can_complete: false };
  else { fresh.subtasks[1].revision++; fresh.subtasks[1].assigned_to = 88; }
  f.external(fresh); assert.equal(f.queue.pending.has(12), false);
  f.calls[0].resolve(f.snapshot(11)); await settle(); assert.equal(f.calls.length, 1);
  assert.ok(f.errors.some(item => item.intent.id === 12));
});

for (const status of [403, 409, 500, undefined]) test(`request failure ${status ?? 'network'} cancels the queue, blocks new writes, and never retries`, async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  const error = Object.assign(new Error('Rejected or uncertain'), status ? { status } : {});
  f.calls[0].reject(error); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.queue.pending.size, 0); assert.equal(f.queue.blocked, true);
  assert.equal(f.queue.enqueue(13, 'done'), false); assert.equal(f.uncertain.length, !status || status >= 500 ? 1 : 0);
  f.external(structuredClone(f.task)); assert.equal(f.queue.blocked, false); assert.equal(f.queue.busy, false);
  assert.equal(f.queue.enqueue(13, 'done'), true); f.queue.dispose();
});

test('a missing canonical parent acknowledgement is uncertain and never drains into another PATCH', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  f.calls[0].resolve(null); await settle();
  assert.equal(f.uncertain.length, 1); assert.equal(f.uncertain[0].reason, 'queue_ack_missing');
  assert.equal(f.calls.length, 1); assert.equal(f.queue.blocked, true);
});

test('an acknowledgement rejected by the parent adapter cannot rebase queued children', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done'); f.rejectAccept();
  f.calls[0].resolve(f.snapshot(11)); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.task.revision, 10); assert.equal(f.queue.pending.size, 0);
});

test('disposing suppresses late acknowledgement, errors, paints and drain callbacks', async () => {
  const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
  f.queue.dispose(); const paints = f.paints.length;
  f.calls[0].resolve(f.snapshot(11)); await settle();
  assert.equal(f.accepted.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.paints.length, paints);
  assert.equal(f.drains, 0); assert.equal(f.queue.busy, false); assert.equal(f.queue.enqueue(13, 'done'), false);
});

test('expired or archived canonical parent cancels queued work and rejects new enqueue', async () => {
  for (const terminal of ['expired', 'archived']) {
    const f = fixture(); f.queue.enqueue(11, 'done'); f.queue.enqueue(12, 'done');
    const ack = f.snapshot(11), fresh = { ...structuredClone(f.task), revision: 14 };
    if (terminal === 'expired') fresh.status = 'expired'; else fresh.archived_at = '2026-09-17T12:00:00Z';
    f.external(fresh); assert.equal(f.queue.pending.has(12), false); assert.equal(f.queue.enqueue(13, 'done'), false);
    f.calls[0].resolve(ack); await settle(); assert.equal(f.calls.length, 1);
  }
});
