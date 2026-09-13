import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3-multiple-ciphers';
import { modernTaskFetch } from './helpers/task-client-revision-fixture.js';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'delegated-task-supervision-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { inspectTaskSupervision, reconcileTaskSupervision, attachTaskSupervision,
  assertTaskSupervisionAssignee, taskSupervisionTransition, deleteTaskSupervisionProjections } = await import('../server/services/task-supervision.js');
const { assertTaskSkillAssignments, assertTaskMemberSkills, qualifiedTaskAssignees,
  setTaskSkills, copyTaskSkills } = await import('../server/services/task-skills.js');
const { taskCapabilities, taskVisibilityWhere } = await import('../server/services/task-access.js');
const { obligationInbox } = await import('../server/services/assignment-responsibilities.js');
const { resolveActivityAssignment } = await import('../server/services/activity-eligibility.js');
const { notifyTaskAssignments, isNotificationDeliveryCurrent } = await import('../server/services/notification-events.js');

let d, actor, admin, learner, helper, other, washer, dryer, folding;
const app = express(); app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor; req.authRole = actor === admin ? 'admin' : 'member';
  req.session = { userId: actor, role: req.authRole }; next();
});
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys = ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for (const migration of ALL_MIGRATIONS) {
    typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
    migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version, migration.description);
  }
  _setTestDatabase(d);
  const user = (name, role = 'member', family = 'parent') => Number(d.prepare(`
    INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)
  `).run(name, name, role, family).lastInsertRowid);
  admin = user('Creator', 'admin'); learner = user('Frank', 'member', 'child');
  helper = user('Duane'); other = user('Other helper'); actor = admin;
  washer = skill('Washing Machine'); dryer = skill('Dryer'); folding = skill('Fold Laundry');
  for (const id of [washer, dryer, folding]) {
    proficiency(learner, id, id === folding ? 'supervised' : 'excluded');
    proficiency(helper, id, 'normal'); proficiency(other, id, 'excluded'); proficiency(admin, id, 'excluded');
  }
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
function skill(name) {
  return Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name, admin).lastInsertRowid);
}
function proficiency(user, id, value) {
  d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
    VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(user, id, value, admin);
}
function task(title, parent = null, assigned = learner) {
  return Number(d.prepare(`INSERT INTO tasks(title,created_by,parent_task_id,assigned_to,due_date,due_time)
    VALUES(?,?,?,?,'2026-09-14','12:00')`).run(title, admin, parent, assigned).lastInsertRowid);
}
function laundry() {
  const root = task("Frank's Laundry"), gather = task('Gather laundry', root, null), wash = task('Load washer', root, null);
  const dry = task('Start dryer', root, null), fold = task('Fold laundry', root, null);
  setTaskSkills(d, wash, [washer]); setTaskSkills(d, dry, [dryer]); setTaskSkills(d, fold, [folding]);
  return { root, gather, wash, dry, fold };
}
function busy(user, start, end) {
  const shift = Number(d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES('Work',?,?,'busy')").run(start, end).lastInsertRowid);
  const pattern = Number(d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,'Daily','2026-09-14',1)").run(user).lastInsertRowid);
  d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,0,?)').run(pattern, shift);
}
const row = id => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const mapped = id => d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(id);
async function request(method, path, body, as = admin) {
  actor = as;
  const response = await modernTaskFetch(d, base + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
function snapshot() {
  return Object.fromEntries(['tasks', 'task_assignments', 'task_supervision_actions', 'task_activity_support_tasks',
    'task_responsibilities', 'planning_obligations', 'planning_obligation_events', 'task_activity_events',
    'notification_inbox', 'task_change_clock'].map(name => [name, d.prepare(`SELECT * FROM ${name}`).all()]));
}

test('mixed learner scope keeps independent work and assigns supervised plus delegated actions to one helper', () => {
  const x = laundry(), view = reconcileTaskSupervision(d, x.root);
  assert.equal(view.state, 'assigned'); assert.equal(view.supervisor_user_id, helper);
  assert.deepEqual(view.actions.map(action => [action.action_task_id, action.execution_mode]),
    [[x.wash, 'delegated'], [x.dry, 'delegated'], [x.fold, 'supervised']]);
  assert.ok(view.actions.every(action => action.supervisor_user_id === helper && action.state === 'assigned'));
  assert.equal(mapped(x.gather), undefined);
  assert.equal(row(x.root).assigned_to, learner);
  assert.ok(view.actions.every(action => row(action.action_task_id).parent_task_id === x.root));
  assert.ok(view.actions.every(action => row(action.counterpart_task_id).parent_task_id === view.support_task_id));
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").get(x.root).n, 1);
});

test('a delegated action requires the helper to independently cover every explicit action skill', () => {
  const x = laundry(); proficiency(learner, folding, 'normal'); setTaskSkills(d, x.wash, [washer, folding]);
  proficiency(helper, folding, 'supervised');
  const view = reconcileTaskSupervision(d, x.root);
  assert.equal(view.state, 'needed'); assert.equal(view.supervisor_user_id, null);
  const action = view.actions.find(action => action.action_task_id === x.wash);
  assert.equal(action.execution_mode, 'delegated'); assert.equal(action.state, 'unresolved');
  assert.deepEqual(action.required_skills.map(skill => skill.id), [washer, folding]);
  assert.ok(action.qualified_supervisor_ids?.length === 0 || action.qualified_supervisor_count === 0);
});

test('partial helpers cannot split supervised and delegated responsibilities', () => {
  const x = laundry(); proficiency(helper, folding, 'excluded'); proficiency(other, folding, 'normal');
  const view = reconcileTaskSupervision(d, x.root);
  assert.equal(view.state, 'needed'); assert.equal(view.supervisor_user_id, null);
  assert.ok(view.actions.every(action => action.state === 'unresolved' && action.supervisor_user_id == null));
  assert.match(view.display_reason || view.reason, /single|one.*supervisor|one.*helper/i);
});

test('multiple complete-scope candidates still create exactly one helper and no duplicate counterpart work', () => {
  const x = laundry(); for (const id of [washer, dryer, folding]) proficiency(other, id, 'normal');
  const first = reconcileTaskSupervision(d, x.root), before = snapshot();
  for (let i = 0; i < 3; i++) reconcileTaskSupervision(d, x.root);
  assert.equal(first.supervisor_user_id, helper);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(x.root).n, 1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions WHERE source_task_id=?').get(x.root).n, 3);
  assert.deepEqual(snapshot(), before);
});

test('a learner cannot complete delegated source or counterpart through normal or compatibility status routes', async () => {
  const x = laundry(), view = reconcileTaskSupervision(d, x.root), action = view.actions.find(action => action.action_task_id === x.wash);
  for (const prefix of ['/api/v1/tasks', '/api/tasks']) for (const id of [x.wash, action.counterpart_task_id]) {
    const result = await request('PATCH', `${prefix}/${id}/status`, { status: 'done' }, learner);
    assert.ok([403, 409].includes(result.status), JSON.stringify(result));
    assert.equal(row(x.wash).status, 'open'); assert.equal(row(action.counterpart_task_id).status, 'open');
  }
  const done = await request('PATCH', `/api/v1/tasks/${action.counterpart_task_id}/status`, { status: 'done' }, helper);
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(row(x.wash).status, 'done'); assert.equal(row(action.counterpart_task_id).status, 'done');
  assert.equal(mapped(x.wash).execution_mode, 'delegated');
});

test('legacy PUT completion does not let a learner bypass delegated ownership', async () => {
  const x = laundry(); reconcileTaskSupervision(d, x.root);
  const result = await request('PUT', `/api/tasks/${x.wash}`, { status: 'done' }, learner);
  assert.ok([403, 409].includes(result.status), JSON.stringify(result)); assert.equal(row(x.wash).status, 'open');
});

test('learner cannot reopen or reset completed delegated work using stale helper projections', async () => {
  const x = laundry(), view = reconcileTaskSupervision(d, x.root), action = view.actions.find(action => action.action_task_id === x.wash);
  assert.equal((await request('PATCH', `/api/v1/tasks/${action.counterpart_task_id}/status`, { status: 'done' }, helper)).status, 200);
  for (const id of [x.wash, action.counterpart_task_id]) for (const status of ['open', 'in_progress']) {
    const result = await request('PATCH', `/api/v1/tasks/${id}/status`, { status, reset_progress: true }, learner);
    assert.ok([403, 409].includes(result.status), JSON.stringify(result));
    assert.equal(row(x.wash).status, 'done'); assert.equal(row(action.counterpart_task_id).status, 'done');
  }
});

test('delegated work requires helper availability without requiring an overlapping learner window', () => {
  const x = laundry(); proficiency(learner, folding, 'normal');
  d.prepare('UPDATE tasks SET due_time=NULL WHERE id IN (?,?,?,?)').run(x.root, x.wash, x.dry, x.fold);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','completion','activity_template')").run(x.root);
  busy(learner, '12:00', '00:00'); busy(helper, '00:00', '12:00');
  const view = reconcileTaskSupervision(d, x.root);
  assert.equal(view.state, 'assigned'); assert.equal(view.supervisor_user_id, helper);
  assert.ok(view.actions.every(action => action.execution_mode === 'delegated'));
  proficiency(learner, folding, 'supervised');
  const supervised = reconcileTaskSupervision(d, x.root);
  assert.equal(supervised.state, 'needed'); assert.equal(supervised.supervisor_user_id, null);
  assert.match(supervised.display_reason || supervised.reason, /eligible time with the learner|shared eligible time/i);
});

test('read-only detail, list, resolver and obligation inbox reads preserve assignment and every operational table', async () => {
  const x = laundry(), view = reconcileTaskSupervision(d, x.root), before = snapshot();
  for (let i = 0; i < 3; i++) {
    assert.equal((await request('GET', `/api/v1/tasks/${x.root}`, undefined, learner)).status, 200);
    assert.equal((await request('GET', '/api/v1/tasks', undefined, learner)).status, 200);
    assert.equal((await request('GET', `/api/tasks/${view.support_task_id}`, undefined, helper)).status, 200);
    const rows = [row(x.root), row(x.wash), row(view.support_task_id)];
    attachTaskSupervision(d, rows, learner); inspectTaskSupervision(d, x.root); obligationInbox(d, helper);
  }
  assert.deepEqual(snapshot(), before);
});

test('one helper notification distinguishes performing delegated work from supervising learner work', () => {
  const x = laundry(); reconcileTaskSupervision(d, x.root);
  const messages = d.prepare("SELECT * FROM notification_inbox WHERE user_id=? AND source_key LIKE 'task-supervision-scope:%'").all(helper);
  assert.equal(messages.length, 1); assert.equal(messages[0].title, 'Helper work assigned');
  assert.match(messages[0].body, /Perform: Load washer/); assert.match(messages[0].body, /Perform: Start dryer/);
  assert.match(messages[0].body, /Supervise: Fold laundry/); assert.doesNotMatch(messages[0].body, /Supervise: Load washer|Supervise: Start dryer/);
  assert.equal(isNotificationDeliveryCurrent(d, messages[0]), true);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE user_id=? AND source_key LIKE 'task-supervision-scope:%'").get(learner).n, 0);
  const before = snapshot(); reconcileTaskSupervision(d, x.root); assert.deepEqual(snapshot(), before);
});

test('creating explicitly assigned delegated work never tells the prohibited learner that the action is assigned to them', async () => {
  const root = task('Laundry');
  const response = await request('POST', '/api/v1/tasks', { title: 'Load washer', parent_task_id: root, assigned_to: [learner], skill_ids: [washer] });
  assert.equal(response.status, 201, JSON.stringify(response));
  const action = d.prepare("SELECT id FROM tasks WHERE parent_task_id=? AND title='Load washer'").get(root);
  notifyTaskAssignments(d, action.id);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE user_id=? AND entity_type='task' AND entity_id=?").get(learner, action.id).n, 0);
  assert.ok(d.prepare("SELECT 1 FROM notification_inbox WHERE user_id=? AND entity_id=? AND title='Helper work assigned'").get(helper, root));
});

test('queued learner assignment delivery becomes obsolete after the action transfers without deleting its receipt history', () => {
  const x = laundry(); proficiency(learner, washer, 'normal');
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(learner, x.wash);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(x.wash, learner);
  notifyTaskAssignments(d, x.wash);
  const receipt = d.prepare("SELECT * FROM notification_inbox WHERE user_id=? AND entity_id=? AND source_key LIKE 'task:%:assigned:%'").get(learner, x.wash);
  assert.ok(receipt); assert.equal(isNotificationDeliveryCurrent(d, receipt), true);
  proficiency(learner, washer, 'excluded'); reconcileTaskSupervision(d, x.root);
  const before = snapshot(); assert.equal(isNotificationDeliveryCurrent(d, receipt), false); assert.deepEqual(snapshot(), before);
  assert.ok(d.prepare('SELECT 1 FROM notification_inbox WHERE id=?').get(receipt.id));
});

test('unfinished legacy excluded mappings are reconciled in place without changing completed history or learner data', () => {
  const x = laundry();
  proficiency(learner, washer, 'supervised'); proficiency(learner, dryer, 'supervised');
  const initial = reconcileTaskSupervision(d, x.root);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(x.fold);
  reconcileTaskSupervision(d, x.root);
  const historical = { ...mapped(x.fold) };
  d.prepare("UPDATE tasks SET points=19,description='Keep instructions',recurrence_rule='FREQ=WEEKLY;BYDAY=MO',is_recurring=1 WHERE id=?").run(x.root);
  const learnerBefore = [x.root, x.gather, x.wash, x.dry, x.fold].map(id => ({ ...row(id) }));
  const eventsBefore = d.prepare('SELECT * FROM task_activity_events ORDER BY id').all();
  for (const id of [washer, dryer]) proficiency(learner, id, 'excluded');
  d.prepare("UPDATE task_supervision_actions SET state='excluded' WHERE action_task_id IN (?,?)").run(x.wash, x.dry);
  const after = reconcileTaskSupervision(d, x.root);
  assert.equal(after.support_task_id, initial.support_task_id);
  for (const id of [x.wash, x.dry]) {
    assert.equal(mapped(id).counterpart_task_id, initial.actions.find(action => action.action_task_id === id).counterpart_task_id);
    assert.equal(mapped(id).execution_mode, 'delegated');
  }
  assert.equal(mapped(x.fold).execution_mode, historical.execution_mode);
  assert.equal(mapped(x.fold).supervisor_user_id, historical.supervisor_user_id);
  assert.equal(row(x.fold).status, 'done');
  for (const previous of learnerBefore) {
    const next = row(previous.id);
    for (const key of Object.keys(previous).filter(key => !['revision', 'updated_at'].includes(key))) assert.equal(next[key], previous[key], `${previous.id}.${key}`);
  }
  assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id<=? ORDER BY id').all(eventsBefore.at(-1)?.id || 0), eventsBefore);
  const stable = snapshot(); reconcileTaskSupervision(d, x.root); assert.deepEqual(snapshot(), stable);
});

test('fresh occurrence re-evaluates excluded to supervised to independent without rewriting prior completed mode', () => {
  const x = laundry(); const initial = reconcileTaskSupervision(d, x.root);
  d.prepare("UPDATE tasks SET status='done' WHERE id IN (?,?,?,?)").run(x.gather, x.wash, x.dry, x.fold);
  reconcileTaskSupervision(d, x.root);
  const oldAction = mapped(x.wash), next = task('Next Laundry'), wash = task('Load washer', next, learner);
  copyTaskSkills(d, x.wash, wash); proficiency(learner, washer, 'supervised');
  const nextView = reconcileTaskSupervision(d, next);
  assert.equal(nextView.actions[0].execution_mode, 'supervised');
  assert.equal(mapped(x.wash).execution_mode, 'delegated'); assert.equal(mapped(x.wash).counterpart_task_id, oldAction.counterpart_task_id);
  const later = task('Later Laundry'), laterWash = task('Load washer', later, learner);
  copyTaskSkills(d, x.wash, laterWash); proficiency(learner, washer, 'normal');
  const laterView = reconcileTaskSupervision(d, later);
  assert.equal(laterView.actions.length, 0); assert.equal(laterView.support_task_id, null);
  assert.notEqual(initial.support_task_id, nextView.support_task_id);
});

test('structured child assignment preserves the learner without weakening standalone or whole-Activity skill eligibility', () => {
  const x = laundry();
  assert.doesNotThrow(() => assertTaskSkillAssignments(d, [washer], [learner], undefined, { allowDelegation: true }));
  assert.doesNotThrow(() => assertTaskMemberSkills(d, x.wash, learner));
  assert.deepEqual(qualifiedTaskAssignees(d, x.wash, [learner], '2026-09-21'), [learner]);
  assert.doesNotThrow(() => assertTaskSupervisionAssignee(d, x.root, learner));
  assert.throws(() => assertTaskSkillAssignments(d, [washer], [learner]), /permitted/);
  assert.throws(() => assertTaskSkillAssignments(d, [washer], [987654], undefined, { allowDelegation: true }), /permitted/);
  const standalone = task('Operate washer'); setTaskSkills(d, standalone, [washer]);
  assert.throws(() => assertTaskMemberSkills(d, standalone, learner), /permitted/);
  assert.deepEqual(qualifiedTaskAssignees(d, standalone, [learner], '2026-09-21'), []);
  const activity = Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,created_by)
    VALUES('Operate washer','Operate washer','fixed','fixed',?,?)`).run(learner, admin).lastInsertRowid);
  d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(activity, washer);
  assert.throws(() => resolveActivityAssignment(d, d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activity), { subjectUserId: learner }), /cannot perform/);
});

test('explicitly assigned excluded child can be created without authorizing its learner to complete it', async () => {
  const root = task('Laundry');
  const created = await request('POST', '/api/v1/tasks', { title: 'Load washer', parent_task_id: root, assigned_to: [learner], skill_ids: [washer] });
  assert.equal(created.status, 201, JSON.stringify(created));
  const action = d.prepare("SELECT * FROM tasks WHERE parent_task_id=? AND title='Load washer'").get(root);
  assert.equal(action.assigned_to, learner); assert.equal(mapped(action.id).execution_mode, 'delegated');
  assert.throws(() => taskSupervisionTransition(d, action.id, 'done', learner));
});

test('a private delegated source still protects counterpart visibility and operational errors', async () => {
  const x = laundry(); d.prepare("UPDATE tasks SET visibility='private',created_by=?,title='Private delegated action' WHERE id=?").run(other, x.wash);
  const view = reconcileTaskSupervision(d, x.root), action = view.actions.find(action => action.action_task_id === x.wash);
  assert.equal(taskCapabilities(d, learner, { id: action.counterpart_task_id }).view, false);
  const visible = d.prepare(`SELECT t.id FROM tasks t WHERE ${taskVisibilityWhere(d, learner, 't', '@me')}`).all({ me: learner });
  assert.equal(visible.some(row => row.id === action.counterpart_task_id), false);
  const result = await request('GET', `/api/v1/tasks/${x.root}`, undefined, learner);
  assert.equal(result.status, 200); assert.equal(JSON.stringify(result.data).includes('Private delegated action'), false);
  const failure = await request('PATCH', `/api/v1/tasks/${action.counterpart_task_id}/status`, { status: 'done' }, learner);
  assert.equal(failure.status, 404); assert.equal(JSON.stringify(failure.data).includes('Private delegated action'), false);
});

test('archiving and restoring a delegated action reuses its linked work and deletion removes only the recognized projection', () => {
  const x = laundry(), view = reconcileTaskSupervision(d, x.root), wash = mapped(x.wash);
  const arbitrary = task('Unrelated helper-looking checklist', view.support_task_id, helper);
  d.prepare("UPDATE tasks SET archived_at='2026-09-13T12:00:00Z' WHERE id=?").run(x.wash);
  reconcileTaskSupervision(d, x.root);
  assert.ok(row(wash.counterpart_task_id).archived_at);
  assert.throws(() => taskSupervisionTransition(d, wash.counterpart_task_id, 'done', helper), /archive/i);
  d.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(x.wash); reconcileTaskSupervision(d, x.root);
  assert.equal(mapped(x.wash).counterpart_task_id, wash.counterpart_task_id); assert.equal(row(wash.counterpart_task_id).archived_at, null);
  deleteTaskSupervisionProjections(d, x.wash); d.prepare('DELETE FROM tasks WHERE id=?').run(x.wash); reconcileTaskSupervision(d, x.root);
  assert.equal(row(wash.counterpart_task_id), undefined); assert.ok(row(arbitrary)); assert.ok(row(x.dry));
});
