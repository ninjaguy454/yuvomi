import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'task-supervision-test';
const { ALL_MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { inspectTaskSupervision, reconcileTaskSupervision, taskSupervisionTransition, supervisionProjectionUpdates,
  attachTaskSupervision, assertTaskSupervisionAssignee } = await import('../server/services/task-supervision.js');
const { applyTaskActivityBinding, copyTaskActivityBinding } = await import('../server/services/task-activity-bindings.js');
const { setTaskSkills, copyTaskSkills, attachTaskSkills } = await import('../server/services/task-skills.js');
const { respondToTaskObligation, obligationInbox, reconcileOverdueTaskObligations } = await import('../server/services/assignment-responsibilities.js');
const { resolveActivityAssignment } = await import('../server/services/activity-eligibility.js');
const { isNotificationDeliveryCurrent, notifyTaskObligations } = await import('../server/services/notification-events.js');
const { changeTaskStatus } = await import('../server/services/task-lifecycle.js');

let d, learner, admin, helper, washer, dryer;
test.beforeEach(() => {
  d = new Database(':memory:'); d.pragma('foreign_keys = ON');
  d.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,description TEXT,applied_at TEXT)');
  for (const migration of ALL_MIGRATIONS) {
    if (typeof migration.up === 'function') migration.up(d); else d.exec(migration.up);
    migration.afterUp?.(d);
    d.prepare('INSERT INTO schema_migrations(version,description) VALUES(?,?)').run(migration.version,migration.description);
  }
  _setTestDatabase(d);
  const user = (name, role, family) => Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,?)").run(name,name,role,family).lastInsertRowid);
  admin=user('Admin','admin','parent'); learner=user('Eleanor','member','child'); helper=user('Duane','member','parent');
  washer=skill('Washing Machine'); dryer=skill('Dryer');
  for (const id of [washer,dryer]) { proficiency(learner,id,'supervised'); proficiency(helper,id,'normal'); proficiency(admin,id,'excluded'); }
});
test.afterEach(() => { _setTestDatabase(null); d.close(); });
function skill(name) { return Number(d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES(?,0,'normal',?)").run(name,admin).lastInsertRowid); }
function proficiency(user, id, value) { d.prepare(`INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by)
  VALUES(?,?,?,'manual',?) ON CONFLICT(user_id,skill_id) DO UPDATE SET proficiency=excluded.proficiency`).run(user,id,value,admin); }
function task(title='Laundry', parent=null, assigned=learner) { return Number(d.prepare(`INSERT INTO tasks(title,created_by,parent_task_id,assigned_to,due_date,due_time)
  VALUES(?,?,?,?,'2026-09-14','12:00')`).run(title,admin,parent,assigned).lastInsertRowid); }
function laundry() { const root=task(), independent=task('Gather laundry',root,null), wash=task('Load washer',root,null), dry=task('Start dryer',root,null);
  setTaskSkills(d,wash,[washer]); setTaskSkills(d,dry,[dryer]); return {root,independent,wash,dry}; }
function activity(strategy='fixed', skills=[]) { const id=Number(d.prepare(`INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,
  fixed_user_id,subject_required,presence_policy,created_by) VALUES('Laundry','Laundry',?,?,?,0,'ignore',?)`).run(strategy,strategy,learner,admin).lastInsertRowid);
  for(const skillId of skills) d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(id,skillId); return id; }
function busy(user,start='08:00',end='16:00') { const shift=Number(d.prepare("INSERT INTO schedule_shift_types(name,start_time,end_time,availability_state) VALUES('Work',?,?,'busy')").run(start,end).lastInsertRowid);
  const pattern=Number(d.prepare("INSERT INTO schedule_patterns(user_id,name,anchor_date,cycle_length) VALUES(?,'Daily','2026-09-14',1)").run(user).lastInsertRowid);
  d.prepare('INSERT INTO schedule_pattern_days(pattern_id,position,shift_type_id) VALUES(?,0,?)').run(pattern,shift); return pattern; }
function policy(id) { d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','due','activity_template')").run(id); }
function assertSingleSupervisor(view, expected) {
  const wanted = expected == null ? [] : [expected];
  const pending = view.actions.filter(action => !action.completed && action.state !== 'not_required');
  assert.equal(view.supervisor_user_id, expected);
  assert.deepEqual([...new Set(pending.filter(action => action.state === 'assigned').map(action => action.supervisor_user_id))], wanted);
  assert.deepEqual(d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active' ORDER BY user_id").all(view.source_task_id).map(row => row.user_id), wanted);
  assert.deepEqual(d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted') ORDER BY responsible_user_id").all(view.source_task_id).map(row => row.responsible_user_id), wanted);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(view.source_task_id).n, 1);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(view.support_task_id).assigned_to, expected);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(view.support_task_id).map(row => row.user_id), wanted);
  for (const action of pending) {
    assert.equal(action.supervisor_user_id, expected);
    assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(action.counterpart_task_id).assigned_to, expected);
    assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(action.counterpart_task_id).map(row => row.user_id), wanted);
  }
}

test('legacy fixed learner is evaluated against explicit child skills without writes or parent skill inheritance',()=>{
  const x=laundry(), before=d.totalChanges;
  const view=inspectTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assert.deepEqual(view.actions.map(a=>a.action_task_id),[x.wash,x.dry]);
  assert.equal(view.actions[0].learner_name,'Eleanor'); assert.match(view.actions[0].reason,/Washing Machine/);
  assert.match(view.reason,/one eligible supervisor.*all remaining requirements/i);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions').get().n,0);
  assert.equal(d.totalChanges,before);
});
test('one supervisor container contains only the actual deficient actions and linked source IDs',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'assigned'); assert.equal(view.actions.length,2);
  assert.ok(view.actions.every(a=>a.learner_user_id===learner&&a.supervisor_user_id===helper));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(x.root).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?').get(view.support_task_id).n,2);
  assertSingleSupervisor(view,helper);
  const rows=[d.prepare('SELECT * FROM tasks WHERE id=?').get(view.support_task_id),d.prepare('SELECT * FROM tasks WHERE id=?').get(view.actions[0].counterpart_task_id)];
  attachTaskSupervision(d,rows,helper); assert.ok(rows.every(row=>row.is_supervision_projection)); assert.equal(rows[1].supervision_action.can_complete,true);
});
test('explicitly assigned child uses that performer, not hypothetical parent learner',()=>{
  const x=laundry(); d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(helper,x.wash);
  const view=reconcileTaskSupervision(d,x.root); assert.deepEqual(view.actions.map(a=>a.action_task_id),[x.dry]);
});
test('parent-only supervision creates one explicit parent action without attributing skills to children',()=>{
  const root=task(), child=task('Read instructions',root,null); setTaskSkills(d,root,[washer]);
  const view=reconcileTaskSupervision(d,root); assert.deepEqual(view.actions.map(a=>a.action_task_id),[root]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_skill_requirements WHERE task_id=?').get(child).n,0);
});
test('learner cannot complete supervised action; assigned supervisor maps both views to one canonical status',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root), action=view.actions[0];
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',learner),/Duane needs to complete/);
  const transition=taskSupervisionTransition(d,action.counterpart_task_id,'done',helper);
  assert.equal(transition.taskId,x.wash); assert.deepEqual(transition.projectionTaskIds,[action.counterpart_task_id]);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(x.wash);
  assert.equal(supervisionProjectionUpdates(d,x.root).find(row=>row.id===action.counterpart_task_id).status,'done');
  d.prepare("UPDATE tasks SET status='open' WHERE id=?").run(x.wash);
  assert.equal(supervisionProjectionUpdates(d,x.root).find(row=>row.id===action.counterpart_task_id).status,'open');
  assert.doesNotThrow(()=>taskSupervisionTransition(d,x.independent,'done',learner));
});
test('no qualified supervisor preserves learner and exposes required skills with deduplicated creator notification',()=>{
  const x=laundry(); proficiency(helper,washer,'excluded'); proficiency(helper,dryer,'excluded');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assert.match(view.reason,/no single qualified supervisor exists/i);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(x.root).assigned_to,learner);
  const count=d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE title='Supervision needed'").get().n;
  assert.equal(count,1); reconcileTaskSupervision(d,x.root);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE title='Supervision needed'").get().n,count);
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',learner),/no single qualified supervisor/i);
});
test('qualified but unavailable supervisor has a distinct useful explanation',()=>{
  const x=laundry(); policy(x.root); busy(helper);
  const view=reconcileTaskSupervision(d,x.root); assert.equal(view.state,'needed');
  assert.match(view.reason,/no single qualified supervisor shares an eligible time/i); assert.equal(view.actions[0].qualified_supervisor_count,1);
});

test('learner skill explanations distinguish independent, supervised and excluded actions without changing canonical supervision',()=>{
  d.prepare("UPDATE users SET display_name='Frank' WHERE id=?").run(learner);
  d.prepare("INSERT INTO birthdays(name,birth_date,family_user_id,created_by) VALUES('Frank','2021-01-01',?,?)").run(learner,admin);
  const x=laundry(), sorting=skill('Laundry Sorting'), folding=skill('Fold Laundry');
  setTaskSkills(d,x.independent,[sorting]); proficiency(learner,sorting,'normal');
  const fold=task('Fold laundry',x.root,null); setTaskSkills(d,fold,[folding]);
  proficiency(learner,folding,'supervised'); proficiency(helper,folding,'normal'); proficiency(admin,folding,'excluded');
  for(const id of [washer,dryer]) {
    d.prepare('DELETE FROM user_skill_proficiency WHERE user_id=? AND skill_id=?').run(learner,id);
    d.prepare("UPDATE skills SET minimum_age=7,age_promotion='supervised' WHERE id=?").run(id);
  }
  const baseline=reconcileTaskSupervision(d,x.root);
  assertSingleSupervisor(baseline,null);
  assert.equal(baseline.state,'excluded');
  assert.deepEqual(baseline.actions.map(a=>[a.action_task_id,a.state]),[[x.wash,'excluded'],[x.dry,'excluded'],[fold,'unresolved']]);
  // Legacy persisted reasons remain byte-for-byte unchanged; improved wording is a read projection.
  assert.ok(baseline.actions.every(a=>a.reason==='Frank cannot currently perform Washing Machine, even with supervision.'));
  const capture=()=>Object.fromEntries(['tasks','task_supervision_actions','task_responsibilities','task_assignments','task_activity_support_tasks',
    'planning_obligations','planning_obligation_events','task_activity_events','notification_inbox','task_change_clock']
    .map(name=>[name,d.prepare(`SELECT * FROM ${name}`).all()]));
  const before=capture(), rows=d.prepare('SELECT * FROM tasks WHERE id IN (?,?,?,?) ORDER BY id').all(x.independent,x.wash,x.dry,fold);
  attachTaskSupervision(d,rows,learner);
  const independent=rows.find(r=>r.id===x.independent), wash=rows.find(r=>r.id===x.wash), dry=rows.find(r=>r.id===x.dry), folded=rows.find(r=>r.id===fold);
  assert.equal(independent.supervision_action,null);
  assert.equal(independent.skill_eligibility[0].proficiency,'normal');
  assert.match(independent.skill_eligibility[0].reason,/Frank.*Gather laundry.*Laundry Sorting.*independently/);
  assert.match(wash.supervision_action.display_reason,/Frank.*Load washer.*Washing Machine.*even with supervision.*age-based/);
  assert.match(dry.supervision_action.display_reason,/Frank.*Start dryer.*Dryer.*even with supervision.*age-based/);
  assert.doesNotMatch(dry.supervision_action.display_reason,/Washing Machine|Load washer/);
  assert.equal(folded.skill_eligibility[0].proficiency,'supervised');
  assert.match(folded.supervision_action.display_reason,/Frank.*Fold laundry.*with supervision.*another action.*skill restriction/);
  assert.match(wash.supervision.display_reason,/Load washer.*Washing Machine.*Start dryer.*Dryer/);
  const adult=wash.supervision.supervisor_explanations.find(c=>c.user_id===helper);
  assert.equal(adult.eligible,false);
  assert.match(adult.display_reason,/Frank.*even with supervision.*cannot override/);
  assert.doesNotMatch(adult.display_reason,/Not independently qualified/);
  assert.deepEqual(wash.supervision.eligible_supervisors,[]);
  assert.equal(wash.supervision_action.can_complete,false);
  assert.throws(()=>taskSupervisionTransition(d,x.dry,'done',helper),/Frank.*Start dryer.*Dryer.*even with supervision/);
  assert.doesNotThrow(()=>taskSupervisionTransition(d,x.independent,'done',learner));
  reconcileTaskSupervision(d,x.root);
  assert.deepEqual(capture(),before,'readable wording must not change revisions, history, obligations or notifications');
});

test('display distinguishes permitted supervised work from a missing or unavailable qualified supervisor',()=>{
  const x=laundry(); proficiency(helper,washer,'excluded'); proficiency(helper,dryer,'excluded');
  const unqualified=inspectTaskSupervision(d,x.root);
  assert.equal(unqualified.state,'needed'); assert.equal(unqualified.qualified_supervisor_count,0);
  assert.match(unqualified.actions[0].display_reason,/Eleanor.*Load washer.*Washing Machine.*with supervision.*No single qualified supervisor/);
  assert.doesNotMatch(unqualified.actions[0].display_reason,/cannot perform.*even with supervision/);
  proficiency(helper,washer,'normal'); proficiency(helper,dryer,'normal'); policy(x.root); busy(helper);
  const unavailable=inspectTaskSupervision(d,x.root);
  assert.equal(unavailable.state,'needed'); assert.equal(unavailable.qualified_supervisor_count,1);
  assert.deepEqual(unavailable.eligible_supervisors,[]);
  assert.match(unavailable.actions[0].display_reason,/Qualified supervisors exist, but none is available.*completion window/);
  assert.match(unavailable.actions[0].display_reason,/Washing Machine/);
  assert.doesNotMatch(unavailable.actions[0].display_reason,/cannot perform.*even with supervision/);
});

test('skill assessment display never adds independent or completed work to active supervision mappings',()=>{
  const x=laundry(), sorting=skill('Laundry Sorting'); setTaskSkills(d,x.independent,[sorting]); proficiency(learner,sorting,'normal');
  const first=reconcileTaskSupervision(d,x.root);
  assert.equal(first.supervisor_user_id,helper); assert.equal(first.actions.length,2);
  d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(x.wash);
  const saved=d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash);
  proficiency(learner,washer,'excluded');
  const rows=d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY id').all(x.root); attachTaskSupervision(d,rows,learner);
  assert.deepEqual(rows.find(r=>r.id===x.wash).skill_eligibility,[]);
  assert.equal(rows.find(r=>r.id===x.wash).supervision_action.completed,true);
  reconcileTaskSupervision(d,x.root);
  assert.deepEqual(d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash),saved);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions WHERE action_task_id=?').get(x.independent).n,0);
});

test('individually available learner and helper with disjoint windows explain the lack of shared time',()=>{
  const x=laundry();
  d.prepare('UPDATE tasks SET due_time=NULL WHERE id IN (?,?,?)').run(x.root,x.wash,x.dry);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','completion','activity_template')").run(x.root);
  busy(learner,'12:00','00:00'); busy(helper,'00:00','12:00');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed');
  const explanation=view.supervisor_explanations.find(candidate=>candidate.user_id===helper);
  assert.equal(explanation.eligible,false);
  assert.match(explanation.reason,/No shared eligible time with the learner/);
});
test('current supervisor Availability change invalidates every pending action and selects one replacement',()=>{
  const x=laundry(); policy(x.root); const first=reconcileTaskSupervision(d,x.root);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal'); busy(helper);
  const live=inspectTaskSupervision(d,x.root); assert.equal(live.state,'needed');
  assert.equal(live.supervisor_user_id,null); assert.ok(live.actions.every(action=>action.state==='unresolved'));
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/supervis/i);
  const updated=reconcileTaskSupervision(d,x.root); assert.equal(updated.state,'assigned');
  assertSingleSupervisor(updated,admin);
  assert.equal(updated.support_task_id,first.support_task_id);
  assert.deepEqual(updated.actions.map(action=>action.counterpart_task_id),first.actions.map(action=>action.counterpart_task_id));
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/Admin needs to complete/);
  assert.doesNotThrow(()=>taskSupervisionTransition(d,x.wash,'done',admin));
});
test('manual supervisor choice through any action must cover the entire Task and replaces all pending assignments',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root); proficiency(admin,washer,'normal');
  assert.throws(()=>reconcileTaskSupervision(d,x.wash,{supervisorUserId:admin}),/qualified|every|all/i);
  assertSingleSupervisor(inspectTaskSupervision(d,x.root),helper);
  proficiency(admin,dryer,'normal');
  const view=reconcileTaskSupervision(d,x.wash,{supervisorUserId:admin});
  assertSingleSupervisor(view,admin);
});
test('removed supervisor remains visibly unresolved and cannot authorize completion',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root); d.prepare('DELETE FROM users WHERE id=?').run(helper);
  const view=inspectTaskSupervision(d,x.root); assert.equal(view.state,'needed'); assert.equal(view.actions[0].supervisor_user_id,null);
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/supervisor/);
});
test('proficiency progression stops requiring current help without deleting completed historical mapping',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root); d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(x.wash);
  proficiency(learner,washer,'normal'); proficiency(learner,dryer,'normal');
  const next=reconcileTaskSupervision(d,x.root);
  assert.equal(next.actions.find(a=>a.action_task_id===x.wash).state,'assigned');
  assert.equal(next.actions.find(a=>a.action_task_id===x.wash).supervisor_user_id,helper);
  assert.equal(next.actions.find(a=>a.action_task_id===x.dry).state,'not_required');
  assert.equal(next.support_task_id,view.support_task_id);
});
test('excluded requirements cannot be bypassed by fixed assignment or a qualified supervisor',()=>{
  const x=laundry(); proficiency(learner,washer,'excluded');
  assert.throws(()=>assertTaskSupervisionAssignee(d,x.root,learner),/cannot perform one or more explicit Task or subtask requirements, even with supervision/);
  const view=reconcileTaskSupervision(d,x.root); assert.equal(view.state,'excluded');
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/even with supervision/);
});
test('fixed Activity accepts a supervised actual learner and attaches parent-level linked work',()=>{
  const root=task(), id=activity('fixed',[washer]);
  const result=applyTaskActivityBinding(d,root,{activityTemplateId:id});
  assert.equal(result.resolution.primary.id,learner); assert.equal(result.supervision.state,'assigned');
});
test('subject-skill unresolved helper no longer drops valid learner work',()=>{
  proficiency(helper,washer,'excluded'); const id=activity('subject_skill',[washer]);
  const result=resolveActivityAssignment(d,d.prepare('SELECT * FROM activity_templates WHERE id=?').get(id),{subjectUserId:learner});
  assert.equal(result.primary.id,learner); assert.equal(result.supervisionNeeded,true);
});
test('next occurrence copies explicit structure but evaluates fresh proficiency and supervisor',()=>{
  const x=laundry(), id=activity(); applyTaskActivityBinding(d,x.root,{activityTemplateId:id});
  const prior=inspectTaskSupervision(d,x.root); d.prepare("UPDATE tasks SET status='done' WHERE id IN (?,?)").run(x.wash,x.dry);
  proficiency(learner,washer,'normal'); proficiency(helper,dryer,'excluded');
  const next=task('Next laundry'), wash=task('Load washer',next,null), dry=task('Start dryer',next,null);
  copyTaskSkills(d,x.wash,wash); copyTaskSkills(d,x.dry,dry);
  copyTaskActivityBinding(d,x.root,next);
  const view=inspectTaskSupervision(d,next); assert.equal(view.actions.length,1); assert.equal(view.actions[0].action_task_id,dry);
  assert.equal(view.actions[0].state,'unresolved'); assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(dry).status,'open');
  assert.notEqual(view.support_task_id,prior.support_task_id);
});
test('unchanged reconciliation does not churn task revisions, change clock, obligations or notifications',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  const capture=()=>({ clock:d.prepare('SELECT version FROM task_change_clock').get().version,
    tasks:d.prepare('SELECT id,revision FROM tasks ORDER BY id').all(), actions:d.prepare('SELECT id,revision FROM task_supervision_actions').all(),
    obligations:d.prepare('SELECT COUNT(*) n FROM planning_obligations').get().n, notices:d.prepare('SELECT COUNT(*) n FROM notification_inbox').get().n });
  const before=capture(); reconcileTaskSupervision(d,x.root); assert.deepEqual(capture(),before);
});
test('supervisor decline keeps learner and synchronizes counterpart to unresolved instead of stale helper',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  const request=d.prepare("SELECT id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
  respondToTaskObligation(d,request.id,'decline',helper);
  const view=inspectTaskSupervision(d,x.root); assert.equal(view.state,'needed');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(x.root).assigned_to,learner);
  assert.ok(view.actions.every(action=>d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(action.counterpart_task_id).assigned_to===null));
});

test('supervisor decline chooses one whole-scope fallback and preserves the same linked work',()=>{
  const x=laundry(), first=reconcileTaskSupervision(d,x.root);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  const request=d.prepare("SELECT id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
  respondToTaskObligation(d,request.id,'decline',helper);
  const view=inspectTaskSupervision(d,x.root); assertSingleSupervisor(view,admin);
  assert.equal(view.support_task_id,first.support_task_id);
  assert.deepEqual(view.actions.map(action=>action.counterpart_task_id),first.actions.map(action=>action.counterpart_task_id));
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(request.id).status,'declined');
  assert.throws(()=>respondToTaskObligation(d,request.id,'accept',helper),/closed/);
  assertSingleSupervisor(inspectTaskSupervision(d,x.root),admin);
});

test('supervisor decline cannot fall back to a helper who covers only part of the remaining requirements',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root); proficiency(admin,washer,'normal');
  const request=d.prepare("SELECT id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
  respondToTaskObligation(d,request.id,'decline',helper);
  const view=inspectTaskSupervision(d,x.root); assert.equal(view.state,'needed'); assertSingleSupervisor(view,null);
  reconcileTaskSupervision(d,x.root);
  assertSingleSupervisor(inspectTaskSupervision(d,x.root),null);
});
test('stale supervision notification revisions stop delivery after assignment is resolved',()=>{
  const x=laundry(); proficiency(helper,washer,'excluded'); proficiency(helper,dryer,'excluded'); reconcileTaskSupervision(d,x.root);
  const receipt=d.prepare("SELECT * FROM notification_inbox WHERE source_key LIKE 'task-supervision-scope:%' LIMIT 1").get();
  assert.equal(isNotificationDeliveryCurrent(d,receipt),true);
  proficiency(helper,washer,'normal'); proficiency(helper,dryer,'normal'); reconcileTaskSupervision(d,x.root,{supervisorUserId:helper});
  assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
});

test('one scoped request lists all required actions and is superseded when the single supervisor changes',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  const notices=d.prepare("SELECT * FROM notification_inbox WHERE entity_id=? AND title='Supervision requested'").all(x.root);
  assert.equal(notices.length,1); const first=notices[0];
  assert.equal(first.user_id,helper); assert.match(first.body,/Load washer/); assert.match(first.body,/Start dryer/);
  assert.equal(isNotificationDeliveryCurrent(d,first),true);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  reconcileTaskSupervision(d,x.root,{supervisorUserId:admin});
  assert.equal(isNotificationDeliveryCurrent(d,first),false);
  const current=d.prepare("SELECT * FROM notification_inbox WHERE entity_id=? AND user_id=? AND title='Supervision requested'").all(x.root,admin);
  assert.equal(current.length,1); assert.equal(isNotificationDeliveryCurrent(d,current[0]),true);
  reconcileTaskSupervision(d,x.root); notifyTaskObligations(d,x.root);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE entity_id=? AND user_id=? AND title='Supervision requested'").get(x.root,admin).n,1);
});

test('completing one supervised action does not request the same supervisor again for the remaining work',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root);
  const receipts=()=>d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE entity_id=? AND user_id=? AND title='Supervision requested'").get(x.root,helper).n;
  const assignments=()=>d.prepare("SELECT COUNT(*) n FROM task_activity_events WHERE task_id=? AND event_type='supervisor_assigned'").get(x.root).n;
  assert.equal(receipts(),1);const beforeEvents=assignments();
  changeTaskStatus(d,view.actions.find(action=>action.action_task_id===x.wash).counterpart_task_id,'done',{actorId:helper,authorize:false});
  reconcileTaskSupervision(d,x.root);notifyTaskObligations(d,x.root);
  assert.equal(receipts(),1);assert.equal(assignments(),beforeEvents);
  assertSingleSupervisor(inspectTaskSupervision(d,x.root),helper);
});

test('canonical lifecycle completes and reopens both learner and supervisor projections atomically',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root), action=view.actions[0];
  assert.throws(()=>changeTaskStatus(d,x.wash,'done',{actorId:learner,authorize:false}),/Duane needs to complete/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'open');
  changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false});
  for(const id of [x.wash,action.counterpart_task_id]) assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'done');
  changeTaskStatus(d,action.counterpart_task_id,'in_progress',{actorId:helper,authorize:false});
  for(const id of [x.wash,action.counterpart_task_id]) assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'in_progress');
});
test('canonical reset clears supervised action and projection together while retaining immutable activity',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root), action=view.actions[0];
  changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false});
  const events=d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n;
  assert.throws(()=>changeTaskStatus(d,x.root,'open',{actorId:admin,authorize:false}),/Resetting/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'done');
  changeTaskStatus(d,x.root,'open',{actorId:admin,authorize:false,body:{reset_progress:true}});
  for(const id of [x.wash,action.counterpart_task_id]) assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'open');
  assert.ok(d.prepare('SELECT COUNT(*) n FROM task_activity_events').get().n>events);
});
test('stale supervisor completion after learner reassignment cannot complete newly independent work through old helper view',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root), action=view.actions[0];
  const revision=d.prepare('SELECT revision FROM tasks WHERE id=?').get(action.counterpart_task_id).revision;
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(helper,x.root); reconcileTaskSupervision(d,x.root);
  assert.throws(()=>changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false,body:{expected_revision:revision}}),/changed on another device/);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'open');
});

test('parent supervision container or counterpart cannot silently complete unseen independent learner steps',()=>{
  const root=task(), child=task('Gather laundry',root,null); setTaskSkills(d,root,[washer]);
  const view=reconcileTaskSupervision(d,root);
  for(const id of [view.support_task_id,view.actions[0].counterpart_task_id]) {
    assert.throws(()=>changeTaskStatus(d,id,'done',{actorId:helper,authorize:false,body:{complete_remaining:true}}),/original Task's subtasks/);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'open');
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'open');
  }
  changeTaskStatus(d,child,'done',{actorId:learner,authorize:false});
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(child).status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'in_progress');
  changeTaskStatus(d,view.actions[0].counterpart_task_id,'done',{actorId:helper,authorize:false});
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(root).status,'done');
});

test('retired requirements archive helper views, preserve rows, and can safely become required again',()=>{
  const x=laundry(), before=reconcileTaskSupervision(d,x.root);
  proficiency(learner,washer,'normal'); proficiency(learner,dryer,'normal');
  const retired=reconcileTaskSupervision(d,x.root); assert.equal(retired.state,'none');
  for(const id of [before.support_task_id,...before.actions.map(a=>a.counterpart_task_id)]) assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(id).archived_at);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'open');
  assert.throws(()=>taskSupervisionTransition(d,before.actions[0].counterpart_task_id,'done',helper),/no longer required/);
  proficiency(learner,washer,'supervised');
  const restored=reconcileTaskSupervision(d,x.root);
  assert.equal(restored.support_task_id,before.support_task_id);
  const wash=restored.actions.find(a=>a.action_task_id===x.wash);
  assert.equal(wash.counterpart_task_id,before.actions[0].counterpart_task_id);
  assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(wash.counterpart_task_id).archived_at,null);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(wash.counterpart_task_id).status,'open');
});
test('completed legacy Tasks never gain invented historical supervision assignments',()=>{
  const x=laundry(); d.prepare("UPDATE tasks SET status='done' WHERE id IN (?,?,?)").run(x.root,x.wash,x.dry);
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.actions.length,0); assert.equal(view.support_task_id,null);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions').get().n,0);
});

test('split parent and child skill coverage remains unresolved instead of assigning different helpers',()=>{
  const root=task(), dry=task('Start dryer',root,null); setTaskSkills(d,dry,[dryer]);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const id=activity('subject_skill',[washer]);
  applyTaskActivityBinding(d,root,{activityTemplateId:id,subjectUserId:learner});
  const view=inspectTaskSupervision(d,root);
  assert.equal(view.state,'needed');
  assertSingleSupervisor(view,null);
  assert.match(view.reason,/single|one.*supervisor/i);
  assert.match(view.reason,/Washing Machine/); assert.match(view.reason,/Dryer/);
  assert.ok(view.actions.every(action=>action.eligible_supervisors.length===0));
  assert.throws(()=>taskSupervisionTransition(d,root,'done',helper),/supervis/i);
  assert.throws(()=>taskSupervisionTransition(d,dry,'done',admin),/supervis/i);
});

test('two helpers who each cover only one supervised subtask cannot jointly qualify as a Task supervisor',()=>{
  const x=laundry(); proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assertSingleSupervisor(view,null);
  assert.equal(view.qualified_supervisor_count,0); assert.deepEqual(view.eligible_supervisors,[]);
  assert.match(view.reason,/Washing Machine/); assert.match(view.reason,/Dryer/);
  assert.match(view.reason,/single|one.*supervisor/i);
  assert.ok(view.blocked_requirements.length>0);
  for (const candidate of [admin,helper]) {
    assert.throws(()=>reconcileTaskSupervision(d,x.root,{supervisorUserId:candidate}),/qualified|all|every/i);
  }
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(x.root).assigned_to,learner);
  assert.deepEqual(d.prepare('SELECT id,status FROM tasks WHERE id IN (?,?,?) ORDER BY id').all(x.independent,x.wash,x.dry).map(row=>row.status),['open','open','open']);
});

test('ordinary grandchildren share their ancestor Task learner and supervisor intersection',()=>{
  const root=task(), wash=task('Load washer',root,null), phase=task('Dry phase',root,null), dry=task('Start dryer',phase,null);
  setTaskSkills(d,wash,[washer]); setTaskSkills(d,dry,[dryer]);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const view=reconcileTaskSupervision(d,root);
  assert.equal(view.state,'needed'); assertSingleSupervisor(view,null);
  assert.deepEqual(view.actions.map(action=>action.action_task_id),[wash,dry]);
  assert.ok(view.actions.every(action=>action.learner_user_id===learner));
  assert.match(view.reason,/Washing Machine/); assert.match(view.reason,/Dryer/);
  const nested=reconcileTaskSupervision(d,dry);
  assert.equal(nested.source_task_id,root); assert.equal(nested.support_task_id,view.support_task_id);
  assertSingleSupervisor(nested,null);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks').get().n,1);
  for(const actor of [admin,helper]) assert.throws(()=>taskSupervisionTransition(d,dry,'done',actor),/supervis/i);
});

test('prospective assignee validation checks inherited descendants using the replacement while preserving explicit child performers',()=>{
  const root=task(), phase=task('Laundry phase',root,null), wash=task('Load washer',phase,null);
  setTaskSkills(d,wash,[washer]); proficiency(helper,washer,'excluded');
  assert.throws(()=>assertTaskSupervisionAssignee(d,root,helper),/even with supervision/);
  assert.doesNotThrow(()=>assertTaskSupervisionAssignee(d,root,learner));
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(learner,phase);
  assert.doesNotThrow(()=>assertTaskSupervisionAssignee(d,root,helper),'an explicitly assigned intermediate Task retains its own learner');
});

test('legacy nested supervisor containers consolidate into one active scope without losing progress or Activity',()=>{
  const root=task(), wash=task('Load washer',root,null), phase=task('Dry phase',root,learner), dry=task('Start dryer',phase,null);
  setTaskSkills(d,wash,[washer]); setTaskSkills(d,dry,[dryer]);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const main=task('Supervise Laundry',root,helper), extra=task('Supervise Dry phase',phase,admin);
  const washProjection=task('Supervise Load washer',main,helper), dryProjection=task('Supervise Start dryer',extra,admin);
  for(const [source,container,action,counterpart,supervisor,required] of [
    [root,main,wash,washProjection,helper,washer],[phase,extra,dry,dryProjection,admin,dryer],
  ]) {
    d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(source,container);
    d.prepare("INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,learner_user_id,supervisor_user_id,required_skill_ids_json,state,reason) VALUES(?,?,?,?,?,?,'assigned','Historical assignment')")
      .run(source,action,counterpart,learner,supervisor,JSON.stringify([required]));
    for(const target of [container,counterpart]) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(target,supervisor);
    d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role,source) VALUES(?,?,'supervisor','task_supervision')").run(source,supervisor);
    d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,responsible_user_id) VALUES('task',?,?,?,'supervisor',?)")
      .run(source,source,`task:${source}:legacy-supervision`,supervisor);
    d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'supervisor_assigned',?)")
      .run(source,action,admin,JSON.stringify({supervisor_user_id:supervisor,required_skills:[required]}));
  }
  d.prepare("UPDATE tasks SET status='done' WHERE id IN (?,?)").run(wash,washProjection);
  d.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(root);
  d.prepare("INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json) VALUES(?,?,?,'completed','{}')").run(root,wash,helper);
  const history=d.prepare('SELECT * FROM task_activity_events ORDER BY id').all(), tasks=d.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const view=reconcileTaskSupervision(d,dry);
  assert.equal(view.source_task_id,root); assertSingleSupervisor(view,admin);
  assert.equal(view.support_task_id,main);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,tasks);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions WHERE source_task_id=?').get(root).n,2);
  assert.equal(d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(dryProjection).parent_task_id,main);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(extra).archived_at);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(extra).assigned_to,null);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(extra),[]);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").get(phase).n,0);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted')").get(phase).n,0);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(wash).status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(washProjection).status,'done');
  assert.equal(d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(wash).supervisor_user_id,helper);
  for(const event of history) assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(event.id),event);
  const again=reconcileTaskSupervision(d,phase); assert.equal(again.source_task_id,root); assertSingleSupervisor(again,admin);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,tasks);
});

test('an Activity-bound descendant remains a separate occurrence with its own single supervisor',()=>{
  const group=task('Workflow',null,null), first=task('Washer activity',null,learner), next=task('Dryer activity',null,learner);
  const firstActivity=activity('fixed',[washer]), nextActivity=activity('fixed',[dryer]);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  applyTaskActivityBinding(d,first,{activityTemplateId:firstActivity}); applyTaskActivityBinding(d,next,{activityTemplateId:nextActivity});
  d.prepare('UPDATE tasks SET parent_task_id=? WHERE id IN (?,?)').run(group,first,next);
  const a=inspectTaskSupervision(d,first), b=inspectTaskSupervision(d,next), container=reconcileTaskSupervision(d,group);
  assert.equal(a.source_task_id,first); assertSingleSupervisor(a,helper);
  assert.equal(b.source_task_id,next); assertSingleSupervisor(b,admin);
  assert.equal(container.actions.length,0); assert.equal(container.support_task_id,null);
  assert.notEqual(a.support_task_id,b.support_task_id);
});

test('multiple members qualified for every action select exactly one stable supervisor without duplicate work',()=>{
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  const x=laundry(), first=reconcileTaskSupervision(d,x.root);
  assert.equal(first.state,'assigned'); assert.equal(first.eligible_supervisors.length,2);
  const selected=first.supervisor_user_id; assert.ok([admin,helper].includes(selected));
  assertSingleSupervisor(first,selected);
  const ids=first.actions.map(action=>action.counterpart_task_id), before=d.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  for (let attempt=0;attempt<3;attempt++) {
    const view=reconcileTaskSupervision(d,x.root);
    assertSingleSupervisor(view,selected); assert.equal(view.support_task_id,first.support_task_id);
    assert.deepEqual(view.actions.map(action=>action.counterpart_task_id),ids);
  }
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,before);
});

test('Availability must qualify the same candidate for every supervised action window',()=>{
  const x=laundry(); policy(x.root);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  d.prepare("UPDATE tasks SET due_time='16:00' WHERE id=?").run(x.dry);
  busy(helper,'11:00','13:00'); busy(admin,'15:00','17:00');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assert.equal(view.qualified_supervisor_count,2);
  assertSingleSupervisor(view,null); assert.deepEqual(view.eligible_supervisors,[]);
  assert.ok(view.actions.every(action=>action.eligible_supervisors.length===0));
  assert.match(view.reason,/eligible|available|Availability/i);
  assert.ok(view.supervisor_explanations.every(candidate=>candidate.eligible===false));
});

test('invalid supervisor with no whole-scope replacement clears all active assignments and preserves learner progress',()=>{
  const x=laundry(); policy(x.root); const first=reconcileTaskSupervision(d,x.root);
  changeTaskStatus(d,x.independent,'done',{actorId:learner,authorize:false});
  busy(helper); proficiency(admin,washer,'normal');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assertSingleSupervisor(view,null);
  assert.equal(view.support_task_id,first.support_task_id);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.independent).status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.root).status,'in_progress');
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/supervis/i);
  assert.ok(d.prepare("SELECT COUNT(*) n FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='superseded'").get(x.root).n>=1);
});

test('replacement covers remaining scope while completed supervision stays historical and out of active helper assignments',()=>{
  const x=laundry(), first=reconcileTaskSupervision(d,x.root), wash=first.actions.find(action=>action.action_task_id===x.wash);
  changeTaskStatus(d,wash.counterpart_task_id,'done',{actorId:helper,authorize:false});
  const historical=d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash);
  const events=d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? ORDER BY id').all(x.wash);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'assigned'); assertSingleSupervisor(view,admin);
  assert.equal(view.support_task_id,first.support_task_id);
  assert.deepEqual(d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash),historical);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'done');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(wash.counterpart_task_id).status,'done');
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(wash.counterpart_task_id).assigned_to,null);
  assert.deepEqual(d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(wash.counterpart_task_id),[]);
  const currentEvents=d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? ORDER BY id').all(x.wash);
  for (const event of events) assert.deepEqual(currentEvents.find(current=>current.id===event.id),event);
  assert.doesNotThrow(()=>taskSupervisionTransition(d,x.dry,'done',admin));
});

test('reopening historical supervised work reevaluates the expanded scope without reviving its former active helper',()=>{
  const x=laundry(), first=reconcileTaskSupervision(d,x.root), wash=first.actions.find(action=>action.action_task_id===x.wash);
  changeTaskStatus(d,wash.counterpart_task_id,'done',{actorId:helper,authorize:false});
  const history=d.prepare('SELECT * FROM task_activity_events WHERE action_task_id=? ORDER BY id').all(x.wash);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  assertSingleSupervisor(reconcileTaskSupervision(d,x.root),admin);
  changeTaskStatus(d,x.wash,'in_progress',{actorId:admin,authorize:false});
  const reopened=inspectTaskSupervision(d,x.root);
  assert.equal(reopened.state,'needed'); assertSingleSupervisor(reopened,null);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'in_progress');
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(wash.counterpart_task_id).status,'in_progress');
  for (const event of history) assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(event.id),event);
  for (const actor of [admin,helper]) assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',actor),/supervis/i);
});

test('legacy split helpers consolidate through the same container and preserve prior assignment Activity',()=>{
  const x=laundry(), first=reconcileTaskSupervision(d,x.root), dry=first.actions.find(action=>action.action_task_id===x.dry);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  d.prepare('UPDATE task_supervision_actions SET supervisor_user_id=? WHERE action_task_id=?').run(admin,x.dry);
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(admin,dry.counterpart_task_id);
  d.prepare('UPDATE task_assignments SET user_id=? WHERE task_id=?').run(admin,dry.counterpart_task_id);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(first.support_task_id,admin);
  d.prepare("INSERT INTO task_responsibilities(task_id,user_id,role,source) VALUES(?,?,'supervisor','task_supervision')").run(x.root,admin);
  d.prepare("INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,responsible_user_id,attempt) VALUES('task',?,?,?,'supervisor',?,2)").run(x.root,x.root,`task:${x.root}:legacy-second-supervisor`,admin);
  const history=d.prepare('SELECT * FROM task_activity_events ORDER BY id').all(), count=d.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const stale=inspectTaskSupervision(d,x.root); assert.equal(stale.state,'needed'); assert.equal(stale.supervisor_user_id,null);
  const view=reconcileTaskSupervision(d,x.root); assert.equal(view.state,'assigned');
  assertSingleSupervisor(view,view.supervisor_user_id);
  assert.equal(view.support_task_id,first.support_task_id);
  assert.deepEqual(view.actions.map(action=>action.counterpart_task_id),first.actions.map(action=>action.counterpart_task_id));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks').get().n,count);
  for (const event of history) assert.deepEqual(d.prepare('SELECT * FROM task_activity_events WHERE id=?').get(event.id),event);
});

test('legacy per-action supervisor override cannot split the Task and a rejected request changes nothing',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  const capture=()=>({actions:d.prepare('SELECT * FROM task_supervision_actions ORDER BY id').all(),
    responsibilities:d.prepare('SELECT * FROM task_responsibilities ORDER BY task_id,user_id,role').all(),
    clock:d.prepare('SELECT version FROM task_change_clock').get().version});
  const before=capture();
  assert.throws(()=>reconcileTaskSupervision(d,x.root,{supervisorAssignments:{[x.wash]:admin,[x.dry]:helper}}),/one|single|same/i);
  assert.deepEqual(capture(),before); assertSingleSupervisor(inspectTaskSupervision(d,x.root),helper);
});

test('a subsequent occurrence independently selects one helper instead of copying the prior occurrence assignment',()=>{
  const x=laundry(), id=activity(); applyTaskActivityBinding(d,x.root,{activityTemplateId:id});
  const first=inspectTaskSupervision(d,x.root); assertSingleSupervisor(first,helper);
  for (const action of first.actions) changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false});
  proficiency(helper,dryer,'excluded'); proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  const next=task('Next laundry'), wash=task('Load washer',next,null), dry=task('Start dryer',next,null);
  copyTaskSkills(d,x.wash,wash); copyTaskSkills(d,x.dry,dry); copyTaskActivityBinding(d,x.root,next);
  const view=inspectTaskSupervision(d,next); assertSingleSupervisor(view,admin);
  assert.notEqual(view.support_task_id,first.support_task_id);
  for (const action of view.actions) {
    assert.equal(action.completed,false);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(action.action_task_id).status,'open');
  }
  for (const action of first.actions) {
    const historical=d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(action.action_task_id);
    assert.equal(historical.supervisor_user_id,helper);
    assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(action.action_task_id).status,'done');
  }
});

test('Workflow grouping parent does not duplicate ownership of Activity child supervision',()=>{
  const group=task('Workflow',null,null), child=task('Laundry activity',group,learner), id=activity('fixed',[washer]);
  d.prepare('INSERT INTO task_activity_bindings(task_id,activity_template_id) VALUES(?,?)').run(child,id);
  const childView=reconcileTaskSupervision(d,child);
  const groupView=reconcileTaskSupervision(d,group);
  assert.equal(groupView.actions.length,0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions WHERE action_task_id=?').get(child).n,1);
  assert.equal(inspectTaskSupervision(d,child).support_task_id,childView.support_task_id);
});
test('inherited actual performer prevents a misleading unassigned-skill warning without copying parent requirements',()=>{
  const x=laundry(), row=d.prepare('SELECT * FROM tasks WHERE id=?').get(x.wash);
  attachTaskSkills(d,[row]);
  assert.equal(row.assigned_to,null); assert.equal(row.effective_assignee_id,learner);
  assert.equal(row.effective_assignee_name,'Eleanor'); assert.equal(row.skill_assignment_needed,false);
  assert.deepEqual(row.skill_ids,[washer]);
});

test('unassigned explicit skills request an assignee without generating hypothetical supervision',()=>{
  const root=task('Unassigned work',null,null); setTaskSkills(d,root,[washer]);
  const view=reconcileTaskSupervision(d,root); assert.equal(view.actions.length,0); assert.equal(view.support_task_id,null);
  assert.throws(()=>changeTaskStatus(d,root,'done',{actorId:admin,authorize:false}),/Choose an assignee/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks').get().n,0);
});
test('strict Home requirement explains unknown Presence through the shared resolver',()=>{
  const x=laundry(); const home=Number(d.prepare("INSERT INTO places(name,type) VALUES('Home','home')").run().lastInsertRowid);
  d.prepare("INSERT INTO task_planning_context(task_id,place_id,presence_policy,presence_window,source) VALUES(?,?,'must_be_home','due','activity_template')").run(x.root,home);
  const view=reconcileTaskSupervision(d,x.root); assert.equal(view.state,'needed');
  assert.match(view.reason,/Eleanor/); assert.match(view.reason,/No planned location is known/i);
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/No planned location is known/i);
});

test('generic obligation notification does not duplicate an already recorded linked supervision request',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  const count=()=>d.prepare('SELECT COUNT(*) n FROM notification_inbox WHERE entity_id=? AND user_id=?').get(x.root,helper).n;
  const before=count(); assert.ok(before>0);
  notifyTaskObligations(d,x.root); assert.equal(count(),before);
});

test('points for an inherited supervised learner action go to the learner and retain the supervisor as actor',()=>{
  const x=laundry(); d.prepare('UPDATE tasks SET points=7 WHERE id=?').run(x.wash);
  for(const id of [learner,helper]) d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(?,1)').run(id);
  const view=reconcileTaskSupervision(d,x.root), action=view.actions.find(a=>a.action_task_id===x.wash);
  changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false});
  const awards=d.prepare("SELECT user_id,delta,created_by FROM reward_ledger WHERE task_id=? AND type='earn'").all(x.wash);
  assert.deepEqual(awards,[{user_id:learner,delta:7,created_by:helper}]);
  changeTaskStatus(d,action.counterpart_task_id,'in_progress',{actorId:helper,authorize:false});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(x.wash).n,0);
  d.prepare('UPDATE reward_participants SET enabled=0 WHERE user_id=?').run(learner);
  changeTaskStatus(d,action.counterpart_task_id,'done',{actorId:helper,authorize:false});
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reward_ledger WHERE task_id=? AND type='earn'").get(x.wash).n,0,'an unenrolled learner does not transfer their reward to the helper');
});

test('archived source or individual action retires linked helper work without losing restore history',()=>{
  const x=laundry(), initial=reconcileTaskSupervision(d,x.root);
  const wash=initial.actions.find(a=>a.action_task_id===x.wash), dry=initial.actions.find(a=>a.action_task_id===x.dry);
  d.prepare("UPDATE tasks SET archived_at='2026-09-12T12:00:00Z' WHERE id=?").run(x.wash);
  const pure=inspectTaskSupervision(d,x.root);
  assert.equal(pure.actions.find(a=>a.action_task_id===x.wash).state,'not_required');
  assert.throws(()=>taskSupervisionTransition(d,wash.counterpart_task_id,'done',helper),/Restore the original/);
  reconcileTaskSupervision(d,x.root);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(wash.counterpart_task_id).archived_at);
  assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(dry.counterpart_task_id).archived_at,null);
  assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(initial.support_task_id).archived_at,null);
  d.prepare("UPDATE tasks SET archived_at='2026-09-12T12:00:00Z' WHERE id=?").run(x.root);
  reconcileTaskSupervision(d,x.root);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(initial.support_task_id).archived_at);
  assert.throws(()=>changeTaskStatus(d,initial.support_task_id,'done',{actorId:helper,authorize:false}),/Restore the original/);
  d.prepare('UPDATE tasks SET archived_at=NULL WHERE id IN (?,?)').run(x.root,x.wash);
  const restored=reconcileTaskSupervision(d,x.root);
  assert.equal(restored.state,'assigned'); assert.equal(restored.support_task_id,initial.support_task_id);
  assert.deepEqual(restored.actions.map(a=>a.counterpart_task_id),initial.actions.map(a=>a.counterpart_task_id));
  for(const id of [initial.support_task_id,wash.counterpart_task_id,dry.counterpart_task_id]) assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(id).archived_at,null);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(x.wash).status,'open');
});

test('archiving and restoring completed source preserves the historical supervised actor and completion',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root), wash=view.actions.find(a=>a.action_task_id===x.wash);
  changeTaskStatus(d,wash.counterpart_task_id,'done',{actorId:helper,authorize:false});
  const mapping=d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash);
  d.prepare("UPDATE tasks SET archived_at='2026-09-12T12:00:00Z' WHERE id=?").run(x.root);
  reconcileTaskSupervision(d,x.root);
  assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(wash.counterpart_task_id).archived_at);
  d.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(x.root);
  reconcileTaskSupervision(d,x.root);
  assert.equal(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(wash.counterpart_task_id).archived_at,null);
  assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(wash.counterpart_task_id).status,'done');
  assert.deepEqual(d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(x.wash),mapping);
});

test('household evening remains assigned after UTC midnight and explicit local response deadlines expire at the correct instant',()=>{
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const x=laundry(); d.prepare("UPDATE tasks SET due_date='2026-09-12',due_time='23:59' WHERE id=?").run(x.root);
  reconcileTaskSupervision(d,x.root);
  const obligation=d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
  assert.equal(obligation.due_at,'2026-09-13T03:59:00Z'); assert.equal(obligation.response_deadline,null);
  obligationInbox(d,helper,{nowAt:'2026-09-13T00:02:00Z'});
  assert.equal(inspectTaskSupervision(d,x.root).state,'assigned');
  d.prepare("UPDATE planning_obligations SET response_deadline='2026-09-12T23:30:00' WHERE id=?").run(obligation.id);
  reconcileTaskSupervision(d,x.root);
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(obligation.id).response_deadline,'2026-09-12T23:30:00','a separately configured response deadline survives reconciliation');
  reconcileOverdueTaskObligations(d,{nowAt:'2026-09-13T03:29:59Z'});
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'pending');
  obligationInbox(d,helper,{nowAt:'2026-09-13T03:30:00Z'});
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'pending','reading an expired request cannot process it');
  reconcileOverdueTaskObligations(d,{nowAt:'2026-09-13T03:30:00Z'});
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'timed_out');
  assert.equal(inspectTaskSupervision(d,x.root).state,'needed');
});

test('overdue helper work and reassignment do not gain an already expired approval deadline',()=>{
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const x=laundry(); d.prepare("UPDATE tasks SET due_date='2026-09-01',due_time='12:00' WHERE id=?").run(x.root);
  reconcileTaskSupervision(d,x.root);
  obligationInbox(d,helper,{nowAt:'2026-09-13T00:02:00Z'});
  assert.equal(inspectTaskSupervision(d,x.root).actions[0].supervisor_user_id,helper);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal');
  reconcileTaskSupervision(d,x.root,{supervisorUserId:admin});
  obligationInbox(d,admin,{nowAt:'2026-09-13T00:03:00Z'});
  const view=inspectTaskSupervision(d,x.root);
  assert.equal(view.state,'assigned'); assert.ok(view.actions.every(action=>action.supervisor_user_id===admin));
  assert.equal(d.prepare("SELECT response_deadline FROM planning_obligations WHERE task_id=? AND role='supervisor' AND responsible_user_id=? AND status='pending'").get(x.root,admin).response_deadline,null);
});

test('legacy default helper deadlines cannot remove assigned work before reconciliation',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root);
  const row=d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
  d.prepare("UPDATE planning_obligations SET due_at='2026-09-01T23:59:00',response_deadline='2026-09-01T23:59:00' WHERE id=?").run(row.id);
  obligationInbox(d,helper,{nowAt:'2026-09-13T00:02:00Z'});
  assert.equal(inspectTaskSupervision(d,x.root).state,'assigned');
  reconcileTaskSupervision(d,x.root);
  assert.equal(d.prepare('SELECT response_deadline FROM planning_obligations WHERE id=?').get(row.id).response_deadline,null);
});

test('separate supervisor response deadlines retain household DST and explicit-offset semantics',()=>{
  d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  for(const [deadline,before,at] of [
    ['2026-11-01T03:30:00','2026-11-01T08:29:59Z','2026-11-01T08:30:00Z'],
    ['2026-03-08T03:30:00-04:00','2026-03-08T07:29:59Z','2026-03-08T07:30:00Z'],
  ]) {
    const x=laundry(); reconcileTaskSupervision(d,x.root);
    const row=d.prepare("SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending'").get(x.root);
    d.prepare('UPDATE planning_obligations SET response_deadline=? WHERE id=?').run(deadline,row.id);
    reconcileOverdueTaskObligations(d,{nowAt:before});
    assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(row.id).status,'pending');
    reconcileOverdueTaskObligations(d,{nowAt:at});
    assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(row.id).status,'timed_out');
  }
});
