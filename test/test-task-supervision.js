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
const { respondToTaskObligation, obligationInbox } = await import('../server/services/assignment-responsibilities.js');
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

test('legacy fixed learner is evaluated against explicit child skills without writes or parent skill inheritance',()=>{
  const x=laundry(), before=d.totalChanges;
  const view=inspectTaskSupervision(d,x.root);
  assert.equal(view.state,'needed'); assert.deepEqual(view.actions.map(a=>a.action_task_id),[x.wash,x.dry]);
  assert.match(view.actions[0].reason,/Eleanor requires supervision for Washing Machine/);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_supervision_actions').get().n,0);
  assert.equal(d.totalChanges,before);
});
test('one supervisor container contains only the actual deficient actions and linked source IDs',()=>{
  const x=laundry(), view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'assigned'); assert.equal(view.actions.length,2);
  assert.ok(view.actions.every(a=>a.learner_user_id===learner&&a.supervisor_user_id===helper));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(x.root).n,1);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM tasks WHERE parent_task_id=?').get(view.support_task_id).n,2);
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
  assert.equal(view.state,'needed'); assert.match(view.reason,/no qualified supervisor exists/);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(x.root).assigned_to,learner);
  const count=d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE title='Supervision needed'").get().n;
  assert.equal(count,2); reconcileTaskSupervision(d,x.root);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE title='Supervision needed'").get().n,count);
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',learner),/no qualified supervisor/);
});
test('qualified but unavailable supervisor has a distinct useful explanation',()=>{
  const x=laundry(); policy(x.root); busy(helper);
  const view=reconcileTaskSupervision(d,x.root); assert.equal(view.state,'needed');
  assert.match(view.reason,/no qualified supervisor shares an eligible time/); assert.equal(view.actions[0].qualified_supervisor_count,1);
});

test('individually available learner and helper with disjoint windows explain the lack of shared time',()=>{
  const x=laundry();
  d.prepare('UPDATE tasks SET due_time=NULL WHERE id IN (?,?,?)').run(x.root,x.wash,x.dry);
  d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,presence_window,source) VALUES(?,'available_before_due','completion','activity_template')").run(x.root);
  busy(learner,'12:00','00:00'); busy(helper,'00:00','12:00');
  const view=reconcileTaskSupervision(d,x.root);
  assert.equal(view.state,'needed');
  assert.equal(view.actions[0].supervisor_explanations[0].eligible,false);
  assert.match(view.actions[0].supervisor_explanations[0].reason,/No shared eligible time with the learner/);
});
test('current supervisor Availability change blocks execution and marks unresolved without silently picking another',()=>{
  const x=laundry(); policy(x.root); const first=reconcileTaskSupervision(d,x.root);
  proficiency(admin,washer,'normal'); proficiency(admin,dryer,'normal'); busy(helper);
  const live=inspectTaskSupervision(d,x.root); assert.equal(live.state,'needed'); assert.equal(live.actions[0].supervisor_user_id,helper);
  assert.throws(()=>taskSupervisionTransition(d,x.wash,'done',helper),/no longer supervise/);
  const updated=reconcileTaskSupervision(d,x.root); assert.equal(updated.actions[0].supervisor_user_id,helper); assert.equal(updated.actions[0].state,'unresolved');
  assert.equal(updated.support_task_id,first.support_task_id);
});
test('manual supervisor choice is qualified, action-scoped, and does not replace unrelated action assignment',()=>{
  const x=laundry(); reconcileTaskSupervision(d,x.root); proficiency(admin,washer,'normal');
  assert.throws(()=>reconcileTaskSupervision(d,x.dry,{supervisorUserId:admin}),/independently qualified/);
  const view=reconcileTaskSupervision(d,x.wash,{supervisorUserId:admin});
  assert.equal(view.actions.find(a=>a.action_task_id===x.wash).supervisor_user_id,admin);
  assert.equal(view.actions.find(a=>a.action_task_id===x.dry).supervisor_user_id,helper);
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
test('stale supervision notification revisions stop delivery after assignment is resolved',()=>{
  const x=laundry(); proficiency(helper,washer,'excluded'); proficiency(helper,dryer,'excluded'); reconcileTaskSupervision(d,x.root);
  const receipt=d.prepare("SELECT * FROM notification_inbox WHERE source_key LIKE 'task-supervision:%' LIMIT 1").get();
  assert.equal(isNotificationDeliveryCurrent(d,receipt),true);
  proficiency(helper,washer,'normal'); proficiency(helper,dryer,'normal'); reconcileTaskSupervision(d,x.root,{supervisorUserId:helper});
  assert.equal(isNotificationDeliveryCurrent(d,receipt),false);
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

test('different explicit requirements may resolve different qualified helpers in one linked container',()=>{
  const root=task(), dry=task('Start dryer',root,null); setTaskSkills(d,dry,[dryer]);
  proficiency(helper,dryer,'excluded'); proficiency(admin,dryer,'normal');
  const id=activity('subject_skill',[washer]);
  applyTaskActivityBinding(d,root,{activityTemplateId:id,subjectUserId:learner});
  const view=inspectTaskSupervision(d,root);
  assert.equal(view.state,'assigned');
  assert.equal(view.actions.find(a=>a.action_task_id===root).supervisor_user_id,helper);
  assert.equal(view.actions.find(a=>a.action_task_id===dry).supervisor_user_id,admin);
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
  obligationInbox(d,helper,{nowAt:'2026-09-13T03:29:59Z'});
  assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(obligation.id).status,'pending');
  obligationInbox(d,helper,{nowAt:'2026-09-13T03:30:00Z'});
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
    obligationInbox(d,helper,{nowAt:before});
    assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(row.id).status,'pending');
    obligationInbox(d,helper,{nowAt:at});
    assert.equal(d.prepare('SELECT status FROM planning_obligations WHERE id=?').get(row.id).status,'timed_out');
  }
});
