import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'synthetic-reopened-acceptance';
process.env.LOG_LEVEL = 'error';
const { get } = await import('../server/db.js');
const { acceptanceOptions } = await import('../server/services/task-acceptance-policy.js');
const { acceptTask } = await import('../server/services/task-acceptance.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');
const { createDevice, devicePrincipal } = await import('../server/services/devices.js');
const d = get();
for (const [id, name, role] of [[1, 'Author', 'admin'], [2, 'Claimant', 'member'], [3, 'Helper', 'member'], [4, 'Restricted', 'member']]) {
  d.prepare("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'synthetic',?)").run(id, name, name, role);
}
const grant = (id, key, access) => d.prepare("INSERT INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user',?,?,?) ON CONFLICT(subject_type,subject_id,capability_key) DO UPDATE SET access=excluded.access").run(String(id), key, access);
for (const id of [2, 4]) {
  grant(id, 'tasks.change_assignment', 'none');
  grant(id, 'tasks.reassign', 'none');
  grant(id, 'tasks.accept_with_helpers', id === 2 ? 'allow' : 'none');
}
const display = helpers => createDevice(d, {
  name: `Synthetic ${helpers ? 'authorized' : 'restricted'} display`, scope: { member_ids: [2, 3] },
  permissions: { capabilities: { 'device_tasks.claim': 'allow', 'device_tasks.accept_with_helpers': helpers ? 'allow' : 'none' } },
}, 1);
const allowedDisplay = display(true), deniedDisplay = display(false);
const currentDevice = id => devicePrincipal(d.prepare('SELECT * FROM household_devices WHERE id=?').get(id));
const actors = [
  { name: 'admin with ordinary assignment authority', principal: () => 1, primary: 1 },
  { name: 'member with bounded helper authority', principal: () => 2, primary: 2 },
  { name: 'paired display with bounded helper authority', principal: () => currentDevice(allowedDisplay.id), primary: 2, device: true },
];
let serial = 0;
const seed = (title, parent = null) => Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,visibility,status) VALUES(?,1,?,'all','open')").run(title, parent).lastInsertRowid);
const row = id => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
function transition(id, status) {
  const task = row(id);
  changeTaskStatus(d, id, status, { principal: 1, actorId: 1, body: {
    expected_revision: task.revision, expected_parent_revision: row(task.parent_task_id).revision,
  } });
}
function fixture() {
  const parent = seed(`Synthetic reopened offer ${++serial}`);
  const reopened = seed('Reopened step', parent), untouched = seed('Untouched step', parent);
  transition(reopened, 'done');
  transition(reopened, 'in_progress');
  assert.equal(row(reopened).status, 'in_progress');
  assert.equal(row(parent).status, 'in_progress');
  return { parent, reopened, untouched };
}
function request(f, actor, assignments = []) {
  const principal = actor.principal();
  const options = acceptanceOptions(d, principal, f.parent, actor.device ? actor.primary : undefined);
  return { principal, options, body: {
    operation_id: `reopened-acceptance-${++serial}`, expected_revision: options.expected_revision,
    ...(actor.device ? { primary_user_id: actor.primary } : {}), coassignee_ids: [3],
    subtask_snapshot: options.subtask_snapshot, subtask_assignments: assignments,
  } };
}
const snapshots = () => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, d.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
const progress = f => ({
  statuses: [f.parent, f.reopened, f.untouched].map(id => ({ id, status: row(id).status })),
  childHistory: d.prepare('SELECT * FROM task_activity_events WHERE task_id IN (?,?) ORDER BY id').all(f.reopened, f.untouched),
  rewards: d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),
});

for (const actor of actors) for (const allocation of ['none', 'partial', 'all']) {
  test(`${actor.name}: ${allocation} allocation preserves reopened progress and receipt replay`, () => {
    const f = fixture();
    const assignments = allocation === 'none' ? [{ id: f.reopened, user_id: null }]
      : [{ id: f.reopened, user_id: 3 }, ...(allocation === 'all' ? [{ id: f.untouched, user_id: actor.primary }] : [])];
    const { principal, options, body } = request(f, actor, assignments);
    const child = options.subtasks.find(item => item.id === f.reopened);
    assert.equal(child.allocatable, true, 'An ordinary unassigned reopened step is eligible');
    assert.equal(child.reason, null);
    assert.ok(child.eligible_assignee_ids.includes(3));
    const beforeProgress = progress(f);
    assert.equal(acceptTask(d, principal, f.parent, body).replayed, false);
    assert.equal(row(f.parent).assigned_to, actor.primary);
    assert.equal(row(f.reopened).assigned_to, allocation === 'none' ? null : 3);
    assert.equal(row(f.untouched).assigned_to, allocation === 'all' ? actor.primary : null);
    assert.deepEqual(progress(f), beforeProgress, 'Assignment never resets, starts, or completes a step');
    const after = snapshots();
    assert.equal(acceptTask(d, principal, f.parent, body).replayed, true);
    assert.deepEqual(snapshots(), after, 'Exact replay creates no additional assignment/history/reward');
  });
}

for (const actor of [
  { name: 'member', principal: () => 4, primary: 4 },
  { name: 'paired display', principal: () => currentDevice(deniedDisplay.id), primary: 2, device: true },
]) test(`${actor.name} still needs helper authority for an unassigned reopened step`, () => {
  const f = fixture(), { principal, options, body } = request(f, actor, [{ id: f.reopened, user_id: 3 }]);
  assert.equal(options.can_add_helpers, false);
  assert.equal(options.subtasks.find(item => item.id === f.reopened).allocatable, false);
  const before = snapshots();
  assert.throws(() => acceptTask(d, principal, f.parent, body), error => error.status === 403 && error.reason === 'helpers_not_allowed');
  assert.deepEqual(snapshots(), before);
});

const protectedCases = [
  ['done', 'not_open', f => transition(f.reopened, 'done')],
  ['expired', 'not_open', f => d.prepare("UPDATE tasks SET status='expired' WHERE id=?").run(f.reopened)],
  ['locked child', 'locked', f => d.prepare('UPDATE tasks SET locked=1 WHERE id=?').run(f.reopened)],
  ['locked parent', 'locked', f => d.prepare('UPDATE tasks SET locked=1 WHERE id=?').run(f.parent)],
  ['legacy assignee', 'already_assigned', f => d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(f.reopened)],
  ['relation assignee', 'already_assigned', f => d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(f.reopened)],
  ['active responsibility', 'already_assigned', f => d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role) VALUES(?,3,'subtask_assignee')").run(f.reopened)],
  ['managed assignment', 'managed_assignment', f => d.prepare("INSERT INTO task_assignment_context(task_id,strategy,state) VALUES(?,'fixed','unavailable')").run(f.reopened)],
  ['round robin', 'managed_assignment', f => d.prepare("UPDATE tasks SET assignment_mode='round_robin' WHERE id=?").run(f.reopened)],
];
for (const [name, reason, protect] of protectedCases) test(`${name} remains protected for every acceptance principal`, () => {
  for (const actor of actors) {
    const f = fixture(); protect(f);
    const { principal, options, body } = request(f, actor, [{ id: f.untouched, user_id: 3 }, { id: f.reopened, user_id: 3 }]);
    const child = options.subtasks.find(item => item.id === f.reopened);
    assert.equal(child.allocatable, false, actor.name);
    assert.equal(child.reason, reason, actor.name);
    assert.deepEqual(child.eligible_assignee_ids, []);
    const before = snapshots();
    assert.throws(() => acceptTask(d, principal, f.parent, body), error => [403, 409].includes(error.status));
    assert.deepEqual(snapshots(), before, 'A rejected child must not partially claim its sibling or parent');
  }
});

test('a reopened child changed after the draft rejects atomically for every principal', () => {
  for (const actor of actors) {
    const f = fixture(), { principal, body } = request(f, actor, [{ id: f.untouched, user_id: 3 }, { id: f.reopened, user_id: 3 }]);
    d.prepare("UPDATE tasks SET title='Changed after draft' WHERE id=?").run(f.reopened);
    const before = snapshots();
    assert.throws(() => acceptTask(d, principal, f.parent, body), error => error.status === 409);
    assert.deepEqual(snapshots(), before);
  }
});

test('a late failure rolls back reopened-child assignments and every persisted side effect', () => {
  const f = fixture(), { principal, body } = request(f, actors[1], [{ id: f.reopened, user_id: 3 }]);
  const before = snapshots();
  d.exec("CREATE TRIGGER reopened_acceptance_fault BEFORE INSERT ON task_acceptance_receipts BEGIN SELECT RAISE(ABORT,'synthetic reopened failure'); END");
  try { assert.throws(() => acceptTask(d, principal, f.parent, body), /synthetic reopened failure/); }
  finally { d.exec('DROP TRIGGER reopened_acceptance_fault'); }
  assert.deepEqual(snapshots(), before);
});

test('reopened-child replay cannot lend a revoked bounded helper grant', () => {
  const f = fixture(), { principal, body } = request(f, actors[1], [{ id: f.reopened, user_id: 3 }]);
  acceptTask(d, principal, f.parent, body);
  grant(2, 'tasks.accept_with_helpers', 'none');
  try {
    const before = snapshots();
    assert.throws(() => acceptTask(d, principal, f.parent, body), error => error.status === 403 && error.reason === 'helpers_not_allowed');
    assert.deepEqual(snapshots(), before);
  } finally { grant(2, 'tasks.accept_with_helpers', 'allow'); }
});
