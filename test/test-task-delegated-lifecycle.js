import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'delegated-task-lifecycle-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { reconcileTaskSupervision, inspectTaskSupervision } = await import('../server/services/task-supervision.js');
const { changeTaskStatus, actionableSubtasks } = await import('../server/services/task-lifecycle.js');
const { setTaskSkills } = await import('../server/services/task-skills.js');
const { materializeActivityChecklist } = await import('../server/services/activity-template-checklist.js');
// Use the actual anchored recurrence adapter, not a substitute spawn hook.
await import('../server/routes/tasks.js');

let d, admin, learner, helper, supervisedSkill, delegatedSkill;
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys = ON');
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
    migration.afterUp?.(d);
  }
  _setTestDatabase(d);
  const user = (name, role, family) => Number(d.prepare(`INSERT INTO users(username,display_name,password_hash,role,family_role)
    VALUES(?,?,'x',?,?)`).run(name, name, role, family).lastInsertRowid);
  admin = user('Admin', 'admin', 'parent'); learner = user('Frank', 'member', 'child'); helper = user('Duane', 'member', 'parent');
  const skill = name => Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)")
    .run(name, admin).lastInsertRowid);
  supervisedSkill = skill('Laundry Sorting'); delegatedSkill = skill('Washing Machine');
  proficiency(learner, supervisedSkill, 'supervised'); proficiency(learner, delegatedSkill, 'excluded');
  for (const id of [supervisedSkill, delegatedSkill]) {
    proficiency(helper, id, 'normal'); proficiency(admin, id, 'excluded');
  }
  for (const id of [learner, helper]) d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
function proficiency(user, skill, value) {
  d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
    VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`)
    .run(user, skill, value, admin);
}
function task(title, parent = null, points = 0) {
  const id = Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,parent_task_id,points,due_date,due_time)
    VALUES(?,?,?,?,?,'2099-01-03','12:00')`).run(title, admin, parent ? null : learner, parent, points).lastInsertRowid);
  if (!parent) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, learner);
  return id;
}
function mixed() {
  const root = task("Frank's Laundry", null, 20);
  const independent = task('Gather laundry', root);
  const supervised = task('Sort laundry', root, 3); setTaskSkills(d, supervised, [supervisedSkill]);
  const delegated = task('Load and start washer', root, 7); setTaskSkills(d, delegated, [delegatedSkill]);
  return {root, independent, supervised, delegated};
}
function change(id, status, actorId, body = {}) {
  return changeTaskStatus(d, id, status, {actorId, authorize: false, body});
}
const status = id => d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status;
const earns = id => d.prepare("SELECT user_id,delta,created_by FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY user_id").all(id);
const actionOf = (root, actionId) => inspectTaskSupervision(d, root).actions.find(action => action.action_task_id === actionId);

test('mixed occurrence uses learner steps for progress but waits for delegated source work before completing', () => {
  const x = mixed(); const initial = reconcileTaskSupervision(d, x.root);
  assert.equal(initial.supervisor_user_id, helper);
  assert.equal(actionOf(x.root, x.supervised).execution_mode, 'supervised');
  assert.equal(actionOf(x.root, x.delegated).execution_mode, 'delegated');
  // This lifecycle collection deliberately remains the full Activity structure.
  assert.deepEqual(actionableSubtasks(d, x.root).map(row => row.id), [x.independent, x.supervised, x.delegated]);
  change(x.independent, 'done', learner);
  change(actionOf(x.root, x.supervised).counterpart_task_id, 'done', helper);
  assert.equal(status(x.root), 'in_progress');
  assert.equal(status(x.delegated), 'open');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.root).n, 0);
  assert.deepEqual(earns(x.root), []);
  change(actionOf(x.root, x.delegated).counterpart_task_id, 'done', helper);
  assert.equal(status(x.root), 'done');
  assert.equal(status(initial.support_task_id), 'done');
  assert.deepEqual(earns(x.root), [{user_id: learner, delta: 20, created_by: helper}]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_completions WHERE task_id=?').get(x.root).n, 1);
});

test('learner cannot use a delegated source action or parent completion to perform transferred work', () => {
  const x = mixed(); reconcileTaskSupervision(d, x.root);
  const before = d.prepare('SELECT * FROM tasks ORDER BY id').all();
  assert.throws(() => change(x.delegated, 'done', learner));
  assert.throws(() => change(x.root, 'done', learner, {complete_remaining: true}),
    error => error.details?.reason === 'waiting_for_helper' && /helper must finish/i.test(error.message));
  assert.deepEqual(d.prepare('SELECT * FROM tasks ORDER BY id').all(), before);
});

test('delegated subtask reward follows its actual helper even with a stale structural learner assignment', () => {
  const x = mixed();
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(learner, x.delegated);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(x.delegated, learner);
  const view = reconcileTaskSupervision(d, x.root);
  const delegated = actionOf(x.root, x.delegated);
  // Legacy generated rows cannot mint duplicate points either.
  d.prepare('UPDATE tasks SET points=40 WHERE id IN (?,?)').run(delegated.counterpart_task_id, view.support_task_id);
  change(delegated.counterpart_task_id, 'done', helper);
  assert.deepEqual(earns(x.delegated), [{user_id: helper, delta: 7, created_by: helper}]);
  assert.deepEqual(earns(delegated.counterpart_task_id), []);
  assert.deepEqual(earns(view.support_task_id), []);
  change(delegated.counterpart_task_id, 'in_progress', helper);
  assert.deepEqual(earns(x.delegated), []);
  d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=?').run(helper);
  change(delegated.counterpart_task_id, 'done', helper);
  assert.deepEqual(earns(x.delegated), [], 'unenrolled helper never transfers prohibited work points to the learner');
});

test('supervised action points still belong to learner and parent legacy assignment never rewards helper', () => {
  const x = mixed();
  d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(x.root);
  reconcileTaskSupervision(d, x.root);
  change(x.independent, 'done', learner);
  change(actionOf(x.root, x.supervised).counterpart_task_id, 'done', helper);
  assert.deepEqual(earns(x.supervised), [{user_id: learner, delta: 3, created_by: helper}]);
  change(actionOf(x.root, x.delegated).counterpart_task_id, 'done', helper);
  assert.deepEqual(earns(x.root), [{user_id: learner, delta: 20, created_by: helper}]);
});

test('explicit delegated parent requirement does not inherit onto children or transfer its parent reward', () => {
  const root = task('Parent requires the washer', null, 30);
  const child = task('Gather laundry', root); setTaskSkills(d, root, [delegatedSkill]);
  const view = reconcileTaskSupervision(d, root);
  assert.deepEqual(view.actions.map(action => [action.action_task_id, action.execution_mode]), [[root, 'delegated']]);
  change(child, 'done', learner);
  assert.equal(status(root), 'in_progress');
  change(actionOf(root, root).counterpart_task_id, 'done', helper);
  assert.equal(status(root), 'done');
  assert.deepEqual(earns(root), []);
});

test('reopen and reset keep delegated views synchronized and retain prior completion Activity', () => {
  const x = mixed(); reconcileTaskSupervision(d, x.root);
  change(x.independent, 'done', learner);
  change(actionOf(x.root, x.supervised).counterpart_task_id, 'done', helper);
  const delegated = actionOf(x.root, x.delegated);
  change(delegated.counterpart_task_id, 'done', helper);
  const event = d.prepare("SELECT * FROM task_activity_events WHERE action_task_id=? AND event_type='completed' ORDER BY id LIMIT 1").get(x.delegated);
  assert.ok(event);
  change(delegated.counterpart_task_id, 'in_progress', helper);
  assert.equal(status(x.root), 'in_progress');
  assert.equal(status(x.delegated), status(delegated.counterpart_task_id));
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(event.id), event);
  assert.ok(d.prepare("SELECT 1 FROM task_activity_events WHERE action_task_id=? AND event_type='reopened'").get(x.delegated));
  change(delegated.counterpart_task_id, 'open', helper);
  assert.equal(status(x.delegated), 'open');
  assert.equal(status(delegated.counterpart_task_id), 'open');
  assert.equal(status(x.independent), 'done');
});

test('learner cannot reset or reopen transferred progress; a source manager may reopen without erasing history', () => {
  const x = mixed(); reconcileTaskSupervision(d, x.root);
  const delegated = actionOf(x.root, x.delegated);
  change(delegated.counterpart_task_id, 'done', helper);
  const completedEvent = d.prepare("SELECT * FROM task_activity_events WHERE action_task_id=? AND event_type='completed' ORDER BY id LIMIT 1").get(x.delegated);
  for (const desired of ['open', 'in_progress']) {
    assert.throws(() => change(x.delegated, desired, learner));
    assert.throws(() => change(delegated.counterpart_task_id, desired, learner));
    assert.equal(status(x.delegated), 'done');
    assert.equal(status(delegated.counterpart_task_id), 'done');
  }
  change(x.delegated, 'in_progress', admin);
  assert.equal(status(x.delegated), 'in_progress');
  assert.equal(status(delegated.counterpart_task_id), 'in_progress');
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(completedEvent.id), completedEvent);
});

test('the next anchored occurrence reclassifies delegated work from current proficiency without copying history', () => {
  for (const nextProficiency of ['supervised', 'normal']) {
    proficiency(learner, delegatedSkill, 'excluded');
    const x = mixed();
    d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',assignment_mode='fixed' WHERE id=?").run(x.root);
    d.prepare('INSERT INTO task_comments(task_id,user_id,comment) VALUES(?,?,?)').run(x.root, learner, 'Keep on original occurrence only.');
    reconcileTaskSupervision(d, x.root);
    change(actionOf(x.root, x.delegated).counterpart_task_id, 'done', helper);
    const historical = d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.delegated);
    proficiency(learner, delegatedSkill, nextProficiency);
    change(x.independent, 'done', learner);
    change(actionOf(x.root, x.supervised).counterpart_task_id, 'done', helper);
    const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').all(x.root);
    assert.equal(next.length, 1); assert.equal(next[0].assigned_to, learner); assert.equal(next[0].due_date, '2099-01-10');
    const originalChildren = actionableSubtasks(d, next[0].id);
    assert.equal(originalChildren.length, 3); assert.ok(originalChildren.every(row => row.status === 'open'));
    const washer = originalChildren.find(row => row.recurrence_origin_id === x.delegated);
    assert.ok(washer);
    const nextAction = actionOf(next[0].id, washer.id);
    if (nextProficiency === 'supervised') assert.equal(nextAction.execution_mode, 'supervised');
    else assert.ok(!nextAction || nextAction.state === 'not_required');
    assert.equal(d.prepare('SELECT COUNT(*) n FROM task_comments WHERE task_id=?').get(next[0].id).n, 0);
    assert.deepEqual(d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.delegated), historical);
  }
});

test('template definition provenance remains linked through delegation and actual recurrence without sharing mutable checklist state', () => {
  const activityId = Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,created_by)
    VALUES('Laundry','Laundry','fixed','fixed',?,?)`).run(learner, admin).lastInsertRowid);
  const itemId = Number(d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES(?,'Start washer')")
    .run(activityId).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_checklist_skills(checklist_item_id,skill_id) VALUES(?,?)').run(itemId, delegatedSkill);
  const root = task('Template Laundry');
  d.prepare("UPDATE tasks SET is_recurring=1,recurrence_rule='FREQ=WEEKLY',assignment_mode='fixed' WHERE id=?").run(root);
  const [sourceId] = materializeActivityChecklist(d, {activity: {id: activityId, name: 'Laundry'}, parentTaskId: root});
  assert.equal(d.prepare('SELECT activity_template_checklist_item_id FROM tasks WHERE id=?').get(sourceId).activity_template_checklist_item_id, itemId);
  const provenance = d.prepare("SELECT * FROM task_activity_events WHERE action_task_id=? AND event_type='template_action_created'").get(sourceId);
  assert.ok(provenance);
  assert.deepEqual(JSON.parse(provenance.details_json), {title: 'Start washer', activity_template_id: activityId,
    activity_template_checklist_item_id: itemId});
  reconcileTaskSupervision(d, root);
  const mapped = actionOf(root, sourceId);
  assert.equal(mapped.execution_mode, 'delegated');
  change(mapped.counterpart_task_id, 'done', helper);
  const next = d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);
  assert.ok(next);
  const [nextSource] = actionableSubtasks(d, next.id);
  assert.equal(nextSource.recurrence_origin_id, sourceId);
  assert.equal(nextSource.activity_template_checklist_item_id, itemId);
  assert.equal(nextSource.status, 'open');
  const nextMap = actionOf(next.id, nextSource.id);
  assert.equal(nextMap.execution_mode, 'delegated');
  assert.notEqual(nextMap.counterpart_task_id, mapped.counterpart_task_id);
  d.prepare("UPDATE activity_template_checklist_items SET title_template='Future template wording' WHERE id=?").run(itemId);
  assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(sourceId).title, 'Start washer');
  assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(nextSource.id).title, 'Start washer');
  d.prepare('DELETE FROM activity_template_checklist_items WHERE id=?').run(itemId);
  for (const id of [sourceId, nextSource.id]) {
    const retained = d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    assert.ok(retained); assert.equal(retained.activity_template_checklist_item_id, null);
  }
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(provenance.id), provenance);
  assert.equal(d.prepare('SELECT counterpart_task_id FROM task_supervision_actions WHERE id=?').get(mapped.id).counterpart_task_id, mapped.counterpart_task_id);
});

test('materializing an unlinked or foreign checklist item does not guess a source template identity', () => {
  const insert = d.prepare("INSERT INTO activity_templates(name,title_template,created_by) VALUES(?,?,?)");
  const activity = Number(insert.run('Laundry', 'Laundry', admin).lastInsertRowid);
  const foreign = Number(insert.run('Other routine', 'Other routine', admin).lastInsertRowid);
  const itemId = Number(d.prepare("INSERT INTO activity_template_checklist_items(activity_template_id,title_template) VALUES(?,'Same title')")
    .run(foreign).lastInsertRowid);
  const root = task('Unlinked checklist');
  const created = materializeActivityChecklist(d, {activity: {id: activity, name: 'Laundry', checklist: [
    {title_template: 'Same title'}, {id: itemId, title_template: 'Same title'},
  ]}, parentTaskId: root});
  assert.equal(created.length, 2);
  for (const id of created) assert.equal(d.prepare('SELECT activity_template_checklist_item_id FROM tasks WHERE id=?').get(id).activity_template_checklist_item_id, null);
});
