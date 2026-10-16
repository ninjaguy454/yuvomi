import test from 'node:test';
import assert from 'node:assert/strict';
import { scoringFixture } from './helpers/task-scoring-route-fixture.js';
import { createDevice } from '../server/services/devices.js';
import { deviceTaskDetail } from '../server/services/device-tasks.js';

test('accepted metadata is exact, read-only and retains explicit device child assignments', async t => {
  const f = await scoringFixture(t);
  const created = await f.create({ title: 'Bounty source', assigned_to: [], subtasks: [
    { title: 'Allocated child' }, { title: 'Shared child' }, { title: 'Private unrelated child' }] });
  assert.equal(created.status, 201);
  const root = created.data.id, [own, shared, hidden] = created.data.subtasks.map(row => row.id);
  f.d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(hidden);
  f.grant('accept_with_helpers', 'allow');
  const options = (await f.call('GET', `/tasks/${root}/acceptance`, undefined, 2)).data;
  const accepted = await f.call('POST', `/tasks/${root}/accept`, { operation_id: 'helper-view-proof',
    expected_revision: options.expected_revision, coassignee_ids: [3], subtask_snapshot: options.subtask_snapshot,
    subtask_assignments: [{ id: own, user_id: 3 }] }, 2);
  assert.equal(accepted.status, 200);
  const principal = { kind: 'device', ...createDevice(f.d, { name: 'Synthetic helper board' }, 1) };
  const before = f.changes(), count = f.d.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const detail = (await f.call('GET', `/tasks/${root}`, undefined, 2)).data;
  assert.equal(detail.is_accepted_bounty, true);
  assert.deepEqual(detail.subtasks.find(row => row.id === own).explicit_assignee_ids, [3]);
  assert.deepEqual(detail.subtasks.find(row => row.id === shared).explicit_assignee_ids, []);
  assert.equal(detail.subtasks.some(row => row.id === hidden), false);
  assert.equal(JSON.stringify(detail).includes('principal_key'), false);
  const device = deviceTaskDetail(f.d, principal, root);
  assert.equal(device.is_accepted_bounty, true);
  assert.deepEqual(device.subtasks.find(row => row.id === shared).explicit_assignee_ids, []);
  assert.ok(device.subtasks.find(row => row.id === shared).assigned_users.length, 'existing device inheritance is retained');
  assert.equal(f.changes(), before);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM tasks').get().n, count);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_ledger').get().n, 0);

  const ordinary = (await f.create({ title: 'Legacy claimed work', assigned_to: [2, 3] })).data.id;
  f.d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role,source) VALUES(?,2,'primary','claim')").run(ordinary);
  const regular = (await f.call('GET', `/tasks/${ordinary}`, undefined, 2)).data;
  assert.equal(regular.is_accepted_bounty, false, 'claim source alone never activates helper views');
  assert.deepEqual(f.d.pragma('foreign_key_check'), []);
});
