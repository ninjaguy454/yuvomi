import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET ||= 'supervision-resolution-cost';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { inspectTaskSupervision, reconcileTaskSupervision, taskSupervisionTransition } = await import('../server/services/task-supervision.js');

let d, learner, helper, root, skill, children;
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys=ON');
  for (const migration of ALL_MIGRATIONS) {
    typeof migration.up === 'function' ? migration.up(d) : d.exec(migration.up);
    migration.afterUp?.(d);
  }
  _setTestDatabase(d);
  const user = (name, role) => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role) VALUES(?,?,'x',?)")
    .run(name, name, role).lastInsertRowid);
  learner = user('Learner', 'member'); helper = user('Helper', 'admin');
  skill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Washer',0,'normal',?)")
    .run(helper).lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'supervised','manual',?)")
    .run(learner, skill, helper);
  root = Number(d.prepare("INSERT INTO tasks(title,created_by,assigned_to,due_date,due_time) VALUES('Laundry',?,?,'2030-09-14','12:00')")
    .run(helper, learner).lastInsertRowid);
  children = [];
  for (let index = 0; index < 5; index++) {
    const id = Number(d.prepare('INSERT INTO tasks(title,created_by,parent_task_id) VALUES(?,?,?)')
      .run(`Washer step ${index}`, helper, root).lastInsertRowid);
    d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id) VALUES(?,?)').run(id, skill);
    children.push(id);
  }
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });

function observedReads(fn) {
  const prepare = d.prepare.bind(d), counts = new Map();
  d.prepare = (sql, ...args) => {
    counts.set(sql, (counts.get(sql) || 0) + 1);
    return prepare(sql, ...args);
  };
  try { return { result: fn(), count: pattern => [...counts].filter(([sql]) => pattern.test(sql)).reduce((sum, [, count]) => sum + count, 0) }; }
  finally { d.prepare = prepare; }
}
function enableAvailability() {
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(root);
}

test('one read inspection shares proficiency facts and skips ignored Availability work', () => {
  const before = d.prepare('SELECT total_changes() n').get().n;
  const { result, count } = observedReads(() => inspectTaskSupervision(d, root));
  assert.equal(result.actions.length, 5);
  assert.ok(result.actions.every(action => action.eligible_supervisors.some(member => member.id === helper)));
  assert.equal(count(/FROM user_skill_proficiency/), 2, 'one learner and one helper proficiency for the shared skill/date');
  assert.equal(count(/FROM availability_periods/), 0, 'ignored Availability is not a hidden full calendar query');
  assert.equal(d.prepare('SELECT total_changes() n').get().n, before, 'inspection remains side-effect free');
});

test('matching inherited windows resolve Availability once per person within an inspection', () => {
  enableAvailability();
  const { result, count } = observedReads(() => inspectTaskSupervision(d, root));
  assert.ok(result.actions.every(action => action.eligible_supervisors.some(member => member.id === helper)));
  // The resolver loads the future window and a separate current Presence point.
  assert.equal(count(/FROM availability_periods/), 4);
});

test('different action windows remain independent and later inspections see changed Availability', () => {
  enableAvailability();
  d.prepare("UPDATE tasks SET due_time='09:00' WHERE id=?").run(children[0]);
  d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,note) VALUES(?,'explicit','busy','2030-09-14T10:00','2030-09-14T13:00','Work')").run(helper);
  const first = inspectTaskSupervision(d, root);
  assert.equal(first.blocked_requirements.find(action => action.action_task_id === children[0]).eligible_supervisor_ids.length, 1);
  assert.equal(first.blocked_requirements.find(action => action.action_task_id === children[1]).eligible_supervisor_ids.length, 0);
  assert.match(first.reason, /Work: busy/);
  d.prepare('DELETE FROM availability_periods WHERE user_id=?').run(helper);
  const second = inspectTaskSupervision(d, root);
  assert.equal(second.eligible_supervisors.length, 1);
  assert.equal(first.eligible_supervisors.length, 0, 'an earlier snapshot is not mutated by cache reuse');
});

test('proficiency cache includes the action date and no facts survive an inspection', () => {
  d.prepare('UPDATE skills SET minimum_age=18 WHERE id=?').run(skill);
  d.prepare("INSERT INTO birthdays(name,birth_date,family_user_id,created_by) VALUES('Helper','2012-09-15',?,?)").run(helper, helper);
  d.prepare("UPDATE tasks SET due_date='2030-09-15' WHERE id=?").run(children[1]);
  const first = inspectTaskSupervision(d, root);
  assert.equal(first.blocked_requirements.find(action => action.action_task_id === children[0]).eligible_supervisor_ids.length, 0);
  assert.equal(first.blocked_requirements.find(action => action.action_task_id === children[1]).eligible_supervisor_ids.length, 1);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'excluded','manual',?)")
    .run(helper, skill, helper);
  const second = inspectTaskSupervision(d, root);
  assert.ok(second.actions.every(action => action.eligible_supervisors.length === 0));
});

test('delegated work does not acquire a learner Availability restriction from a supervised sibling', () => {
  enableAvailability();
  const directSkill = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Dryer',0,'normal',?)").run(helper).lastInsertRowid);
  d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,'excluded','manual',?)")
    .run(learner, directSkill, helper);
  d.prepare('UPDATE task_skill_requirements SET skill_id=? WHERE task_id=?').run(directSkill, children[1]);
  d.prepare("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,note) VALUES(?,'explicit','busy','2030-09-14T10:00','2030-09-14T13:00','School')").run(learner);
  const view = inspectTaskSupervision(d, root);
  assert.equal(view.blocked_requirements.find(action => action.action_task_id === children[0]).eligible_supervisor_ids.length, 0);
  assert.equal(view.blocked_requirements.find(action => action.action_task_id === children[1]).eligible_supervisor_ids.length, 1);
  assert.equal(view.eligible_supervisors.length, 0, 'one helper must still cover the whole mixed scope');
  assert.throws(() => taskSupervisionTransition(d, children[0], 'done', helper), /School: busy/);
});

test('reconciliation retains fresh initial/final validation while deriving new projection links locally', () => {
  const { result, count } = observedReads(() => reconcileTaskSupervision(d, root, { notify: false }));
  assert.equal(count(/SELECT u.id, u.display_name, u.first_name/), 2);
  assert.equal(result.supervisor_user_id, helper);
  assert.equal(result.actions.length, 5);
  assert.ok(result.actions.every(action => action.counterpart_task_id && action.supervisor_user_id === helper));
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(result.support_task_id).status, 'open');
  const before = d.prepare('SELECT total_changes() n').get().n;
  reconcileTaskSupervision(d, root, { notify: false });
  assert.equal(d.prepare('SELECT total_changes() n').get().n, before, 'unchanged reconciliation produces no repeat history, notification, or revision writes');
});
