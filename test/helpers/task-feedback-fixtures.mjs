// Synthetic users/tasks only. Used by the opt-in full-application browser probe.
import assert from 'node:assert/strict';

export function createFeedbackFixtures(d, { reconcileTaskSupervision, inspectTaskSupervision, changeTaskStatus, setTaskSkills, todayKey }) {
  const user = (name, role, family) => Number(d.prepare("INSERT INTO users(username,display_name,first_name,password_hash,role,family_role) VALUES(?,?,?,'test-placeholder',?,?)").run(name, name, name, role, family).lastInsertRowid);
  const admin = user('QA parent', 'admin', 'parent');
  const learner = user('QA learner', 'member', 'child');
  const helper = user('QA helper', 'member', 'parent');
  const others = Array.from({ length: 3 }, (_, i) => user(`QA other ${i}`, 'member', 'child'));
  d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
  for (const id of [learner, helper]) d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  const skills = Array.from({ length: 5 }, (_, i) => {
    const id = Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(`QA skill ${i}`, admin).lastInsertRowid);
    for (const [who, level] of [[admin, 'excluded'], [helper, 'normal'], [learner, i === 1 ? 'excluded' : 'supervised'], ...others.map(who => [who, 'excluded'])]) {
      d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',?)").run(who, id, level, admin);
    }
    return id;
  });

  function fixture(kind) {
    const date = todayKey(d);
    const mixed = kind.includes('helper');
    const root = Number(d.prepare(`INSERT INTO tasks(title,created_by,assigned_to,points,start_date,start_time,due_date,due_time,is_recurring,recurrence_rule,expiration_policy)
      VALUES('QA Routine',?,?,2,?,'00:00',?,'23:59',1,'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR','expire_incomplete')`).run(admin, learner, date, date).lastInsertRowid);
    d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(root, learner);
    const children = Array.from({ length: 10 }, (_, i) => {
      const id = Number(d.prepare("INSERT INTO tasks(title,created_by,parent_task_id,start_date,start_time,due_date,due_time,is_optional) VALUES(?,?,?,?,'00:00',?,'23:59',?)").run(`QA Step ${i}`, admin, root, date, date, i === 9 ? 1 : 0).lastInsertRowid);
      if (mixed && i < 5) setTaskSkills(d, id, [skills[i]]);
      return id;
    });
    if (mixed) d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(root);
    reconcileTaskSupervision(d, root, { notify: false });
    const action = id => inspectTaskSupervision(d, root).actions.find(a => a.action_task_id === id);
    const complete = id => {
      const a = action(id);
      return changeTaskStatus(d, a?.counterpart_task_id || id, 'done', { actorId: a?.supervisor_user_id || learner, requireRevision: false });
    };
    let target = children[0], actor = learner, status = 'done', detail;
    if (kind === 'required-middle') { for (const id of children.slice(0, 4)) complete(id); target = children[4]; }
    if (kind === 'optional') { complete(children[0]); target = children[9]; }
    if (kind === 'required-final-recurring') { for (const id of children.slice(0, 8)) complete(id); target = children[8]; }
    if (kind === 'reopen-step') { complete(target); status = 'in_progress'; }
    if (mixed) {
      const original = children[kind === 'supervised-helper' ? 0 : 1];
      const a = action(original); assert.ok(a?.counterpart_task_id);
      actor = a.supervisor_user_id;
      if (kind === 'supervised-helper') { target = original; detail = root; }
      else target = a.counterpart_task_id;
    }
    return { root, target, actor, status, detail, kind };
  }
  return { fixture, admin, learner, helper };
}
