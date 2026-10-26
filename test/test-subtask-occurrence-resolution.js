import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {saveRotationGroupUsage} from '../server/services/rotation-shared.js';
import {replaceSubjectPermissions} from '../server/permissions.js';
import {taskCapabilities} from '../server/services/task-access.js';
import {resolveSubtaskOccurrence} from '../server/services/subtask-occurrence-resolution.js';
import {reconcileTaskSupervision,inspectTaskSupervision,taskSupervisionNotificationKey} from '../server/services/task-supervision.js';
import {respondToTaskObligation} from '../server/services/assignment-responsibilities.js';
import {publicTaskProjection,wallTaskVisible} from '../server/services/wall.js';
import {isNotificationDeliveryCurrent} from '../server/services/notification-events.js';

const members=d=>saveRotationGroup(d,{name:'Occurrence roster',member_ids:[2,3]},{actorId:1});
const assignments=(d,id)=>d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row=>row.user_id);

test('one occurrence resolves its stored Group rule once and a retry preserves the same worker',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Occurrence root',due_date:'2026-11-01',
    subtasks:[{title:'Occurrence action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child={data:{id:f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id}};
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child.data.id,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  const first=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'synthetic-once',actorId:1});
  assert.equal(first.decisions.length,1);
  assert.equal(first.conflicts.length,0);
  assert.ok([2,3].includes(first.decisions[0].assignee_ids[0]));
  const other=first.decisions[0].assignee_ids[0]===2?3:2;
  assert.equal(assignments(f.d,root.data.id).includes(other),false,'candidate membership is not an Activity assignment');
  saveRotationGroup(f.d,{name:'Occurrence roster',member_ids:[3,2]},
    {id:group.id,actorId:1,expectedRevision:group.revision});
  const before=f.changes();
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'synthetic-once',actorId:1}),first);
  assert.equal(f.changes(),before);
  assert.deepEqual(assignments(f.d,child.data.id),first.decisions[0].assignee_ids);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_runs').get().n,1);
});

test('a supervised Group member resolves only with one qualified adult and one linked helper scope',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  const group=saveRotationGroup(f.d,{name:'Supervised roster',member_ids:[2]},{actorId:1});
  const root=await f.create({title:'Supervised root',due_date:'2026-11-01',
    subtasks:[{title:'Supervised action',points:2,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Synthetic supervised skill',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'supervised')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(1,?,'normal')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'supervised-one',actorId:1});
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(assignments(f.d,child),[2]);
  const scope=f.d.prepare('SELECT * FROM task_activity_support_tasks WHERE source_task_id=?').all(root.data.id);
  assert.equal(scope.length,1);
  assert.equal(scope[0].supervisor_scope,'single');
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(child).supervisor_user_id,1);
});

test('Dad-only and Mom-only subtask pools share a parent and preserve distinct linked work',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'synthetic-mom','Mom','x','member','parent')").run();
  const dadWork=saveRotationGroup(f.d,{name:'Dad learner',member_ids:[2]},{actorId:1});
  const momWork=saveRotationGroup(f.d,{name:'Mom learner',member_ids:[3]},{actorId:1});
  const created=await f.create({title:'Two helpers',due_date:'2026-11-01',subtasks:[
    {title:'Dad watches',assigned_user_ids:[]},{title:'Mom watches',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,children=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root).map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Two-helper skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[4,'normal'],[2,'supervised'],[3,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  for(const [index,id] of children.entries()){
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
      .run(id,JSON.stringify({kind:'group',group_id:index?momWork.id:dadWork.id,mode:'random'}),
        JSON.stringify({kind:'person',user_id:index?4:1}));
  }
  const receipt=resolveSubtaskOccurrence(f.d,{rootTaskId:root,idempotencyKey:'two-helpers',actorId:1});
  assert.deepEqual(receipt.conflicts,[]);
  assert.deepEqual(assignments(f.d,children[0]),[2]);assert.deepEqual(assignments(f.d,children[1]),[3]);
  assert.deepEqual(f.d.prepare('SELECT action_task_id,supervisor_user_id,counterpart_task_id FROM task_supervision_actions WHERE source_task_id=? ORDER BY action_task_id').all(root)
    .map(row=>[row.action_task_id,row.supervisor_user_id,!!row.counterpart_task_id]),[[children[0],1,true],[children[1],4,true]]);
  const support=f.d.prepare('SELECT task_id,supervisor_scope FROM task_activity_support_tasks WHERE source_task_id=?').get(root);
  assert.equal(support.supervisor_scope,'per_action');
  assert.deepEqual(assignments(f.d,support.task_id),[1,4]);
  const counterparts=f.d.prepare('SELECT action_task_id,counterpart_task_id FROM task_supervision_actions WHERE source_task_id=?').all(root);
  const dadCounterpart=counterparts.find(row=>row.action_task_id===children[0]).counterpart_task_id;
  const momCounterpart=counterparts.find(row=>row.action_task_id===children[1]).counterpart_task_id;
  assert.equal(taskCapabilities(f.d,4,{id:dadCounterpart}).own,false,'Mom does not own Dad-only helper work');
  assert.equal(taskCapabilities(f.d,4,{id:momCounterpart}).view,true,'Mom can open her own linked work');
  assert.equal(inspectTaskSupervision(f.d,root).state,'assigned');
  const momNotice={entity_type:'task',entity_id:root,user_id:4,
    source_key:taskSupervisionNotificationKey(inspectTaskSupervision(f.d,root),{userId:4,manager:false})};
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[0]]:null},perActionPlanning:true,notify:false});
  assert.equal(isNotificationDeliveryCurrent(f.d,momNotice),true,'Dad-only changes do not stale Mom’s notice');
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[1]]:null},perActionPlanning:true,notify:false});
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[1]]:4},perActionPlanning:true});
  const momNotification=f.d.prepare("SELECT title,body FROM notification_inbox WHERE user_id=4 AND source_key LIKE 'task-supervision-scope:%' ORDER BY id DESC LIMIT 1").get();
  assert.equal(momNotification.title,'Supervision requested','a hidden sibling problem does not color Mom’s notice');
  assert.equal(momNotification.body.includes('Dad watches'),false);
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[0]]:1},perActionPlanning:true,notify:false});
  const before=f.changes();reconcileTaskSupervision(f.d,root,{actorId:1,notify:false});
  assert.equal(f.changes(),before,'repeat reconciliation writes nothing');
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:root,idempotencyKey:'two-helpers',actorId:1}),receipt);
  assert.equal(f.changes(),before,'receipt replay writes nothing');
  f.d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(children[1]);
  assert.equal(wallTaskVisible(f.d,momCounterpart,4,1),null,
    'a public helper projection cannot reveal its separately private source action to the Wall host');
  const partial=await f.call('GET',`/tasks/${root}`,undefined,2);
  assert.equal(partial.status,200,JSON.stringify(partial));
  assert.equal(JSON.stringify(partial).includes('Mom watches'),false,'hidden sibling title stays private');
  assert.deepEqual(partial.data.supervision.supervisor_user_ids,[],'aggregate helper IDs cannot reveal a hidden sibling');
  const wall=publicTaskProjection(f.d,{...f.row(root),subtasks:children.map(id=>f.row(id)),
    subtask_total:2,subtask_done:1,waiting_on_helper:true,supervision:inspectTaskSupervision(f.d,root)},1,2);
  assert.equal(wall.supervision.supervisor_user_id,null,'Wall cannot reveal an aggregate hidden helper');
  assert.equal(JSON.stringify(wall).includes('Mom watches'),false);
  assert.equal(wall.subtask_total,1,'Wall progress cannot count a host-hidden sibling');
  assert.equal(wall.subtask_done,0,'Wall progress cannot count a host-hidden completion');
  assert.equal(wall.waiting_on_helper,false,'Wall helper status cannot reflect a host-hidden sibling');
  f.d.prepare("UPDATE tasks SET visibility='all' WHERE id=?").run(children[1]);
  const requests=f.d.prepare("SELECT id,responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status='pending' ORDER BY responsible_user_id").all(root);
  assert.deepEqual(requests.map(row=>row.responsible_user_id),[1,4]);
  for(const request of requests)respondToTaskObligation(f.d,request.id,'accept',request.responsible_user_id);
  assert.deepEqual(f.d.prepare('SELECT status FROM planning_obligations WHERE id IN (?,?) ORDER BY id').all(...requests.map(row=>row.id)).map(row=>row.status),['accepted','accepted']);
  respondToTaskObligation(f.d,requests[1].id,'decline',4);
  const afterDecline=inspectTaskSupervision(f.d,root);
  assert.equal(afterDecline.actions.find(row=>row.action_task_id===children[0]).supervisor_user_id,1);
  assert.equal(afterDecline.actions.find(row=>row.action_task_id===children[1]).state,'unresolved');
  f.d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(children[1]);
  const partialWall=publicTaskProjection(f.d,{...f.row(root),supervision:inspectTaskSupervision(f.d,root)},1,2);
  assert.equal(partialWall.supervision.state,'assigned','a hidden unresolved sibling cannot change visible Wall state');
  f.d.prepare("UPDATE tasks SET visibility='all' WHERE id=?").run(children[1]);
  assert.deepEqual(assignments(f.d,support.task_id),[1]);
  const declineWrites=f.changes();reconcileTaskSupervision(f.d,root,{actorId:1,notify:false});
  assert.equal(f.changes(),declineWrites,'repeat after a declined helper must not rewrite the unresolved action');
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=3 AND skill_id=?").run(skill);
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[1]]:4},perActionPlanning:true,notify:false});
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[1]]:null},perActionPlanning:true,notify:false});
  const delegatedWrites=f.changes();reconcileTaskSupervision(f.d,root,{actorId:1,notify:false});
  assert.equal(f.changes(),delegatedWrites,'clearing delegated helper also remains a zero-write no-op');
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=3 AND skill_id=?").run(skill);
  const revised=reconcileTaskSupervision(f.d,root,{actorId:1,notify:false});
  assert.equal(revised.actions.find(row=>row.action_task_id===children[0]).supervisor_user_id,1);
  assert.equal(revised.actions.find(row=>row.action_task_id===children[1]).state,'not_required');
  assert.deepEqual(assignments(f.d,support.task_id),[1]);
});

test('private split supervision grants the assigned action pair without exposing its parent',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'private-helper','Private helper','x','member','parent')").run();
  const group=saveRotationGroup(f.d,{name:'Private learners',member_ids:[2]},{actorId:1});
  const created=await f.create({title:'Private source',visibility:'assignees',assigned_to:[1],due_date:'2026-11-01',
    subtasks:[{title:'First private action',assigned_user_ids:[]},{title:'Second private action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,children=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root).map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Private helper skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[4,'normal'],[2,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  for(const [index,id] of children.entries()){
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
      .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}),JSON.stringify({kind:'person',user_id:index?4:1}));
  }
  const receipt=resolveSubtaskOccurrence(f.d,{rootTaskId:root,idempotencyKey:'private-split',actorId:1});
  assert.deepEqual(receipt.conflicts,[]);
  const view=inspectTaskSupervision(f.d,root),own=view.actions.find(action=>action.action_task_id===children[1]);
  assert.equal(taskCapabilities(f.d,4,{id:own.action_task_id}).view,true);
  assert.equal(taskCapabilities(f.d,4,{id:own.counterpart_task_id}).view,true);
  assert.equal(taskCapabilities(f.d,4,{id:root}).view,false);
  assert.equal(taskCapabilities(f.d,4,{id:view.support_task_id}).view,false);
  assert.deepEqual(children.map(id=>assignments(f.d,id)),[[2],[2]]);
});

test('an explicit ineligible supervisor override leaves the action unresolved without fallback',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  const group=saveRotationGroup(f.d,{name:'No fallback roster',member_ids:[2]},{actorId:1});
  const root=await f.create({title:'No fallback root',due_date:'2026-11-01',
    subtasks:[{title:'Required action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('No fallback skill',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'supervised')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(1,?,'normal')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'excluded')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'smart'}),JSON.stringify({kind:'person',user_id:3}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'no-fallback',actorId:1});
  assert.equal(result.conflicts.length,1);
  assert.deepEqual(assignments(f.d,child),[]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root.data.id).n,0);
});

test('Smart includes historical fixed subtask workload without rewriting its assignee',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Balanced root',due_date:'2026-11-01',scoring_mode:'subtasks',
    subtasks:[{title:'Existing fixed',points:8,assigned_user_ids:[2]},
      {title:'New Smart work',points:3,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const [fixed,smart]=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id).map(row=>row.id);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(smart,JSON.stringify({kind:'group',group_id:group.id,mode:'smart'}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'balanced-one',actorId:1});
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(assignments(f.d,fixed),[2]);
  assert.deepEqual(assignments(f.d,smart),[3]);
  assert.equal(result.decisions.find(row=>row.key===String(fixed)).source.kind,'fixed');
});

test('Synced uses a common skill-eligible member and advances only once across its subtasks',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Synced root',due_date:'2026-11-01',
    subtasks:[{title:'Restricted',points:0,assigned_user_ids:[]},
      {title:'Open',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const [restricted,open]=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id).map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Synced restriction',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'normal')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(restricted,skill);
  for(const id of [restricted,open])f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'synced'}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'synced-one',actorId:1});
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(assignments(f.d,restricted),[3]);assert.deepEqual(assignments(f.d,open),[3]);
  assert.equal(result.cursor_advances.length,1);
  assert.equal(f.d.prepare("SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().occurrence_count,1);
  resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'synced-one',actorId:1});
  assert.equal(f.d.prepare("SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().occurrence_count,1);
});

test('Global never skips an ineligible universal member or advances an independent cursor',async t=>{
  const f=await scoringFixture(t);
  const group=saveRotationGroupUsage(f.d,{name:'Locked universal',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',start_mode:'first',effective_date:'2026-11-01',weekdays:[0,1,2,3,4,5,6],
      active_time:'10:00',finalize_time:'23:00',finalize_day_offset:0,eligibility:{}}},
    {actorId:1,now:new Date('2026-11-01T12:00:00Z')});
  const root=await f.create({title:'Global root',due_date:'2026-11-01',
    subtasks:[{title:'Skill restricted',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Global restriction',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'normal')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'global'}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'global-one',actorId:1});
  assert.deepEqual(result.conflicts,[{key:String(child),reason:'no_eligible_group_member'}]);
  assert.deepEqual(assignments(f.d,child),[]);
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().n,0);
});

test('denied actor cannot read or write a private occurrence resolution',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Private occurrence',visibility:'assignees',due_date:'2026-11-01',
    assigned_to:[2],subtasks:[{title:'Private action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  const before=f.changes();
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'private-one',actorId:3}),
    error=>error.status===403);
  assert.equal(f.changes(),before);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_runs').get().n,0);
});

test('a late category rejection rolls back assignments, provenance and cursor together',async t=>{
  const f=await scoringFixture(t);
  const root=await f.create({title:'Atomic occurrence',due_date:'2026-11-01',
    subtasks:[{title:'Two owners',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'fixed',user_ids:[2,3]}));
  f.d.prepare('UPDATE task_assignee_policies SET max_assignees=1 WHERE task_id=?').run(child);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'atomic-one',actorId:1}),
    /at most 1 direct assignee/);
  assert.deepEqual(assignments(f.d,child),[]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_runs').get().n,0);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_decisions').get().n,0);
});

test('fixed multi-person work does not lose supervision for a non-primary performer',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  const root=await f.create({title:'Multi-person supervision',due_date:'2026-11-01',
    subtasks:[{title:'Shared skilled action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Shared skilled action',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[2,'supervised'],[3,'normal']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'fixed',user_ids:[3,2]}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'multi-supervision',actorId:1});
  assert.deepEqual(result.conflicts,[{key:String(child),reason:'fixed_person_ineligible'}]);
  assert.deepEqual(assignments(f.d,child),[]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root.data.id).n,0);
});

test('assignment permission without reassignment permission cannot resolve another worker',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Protected assignment',due_date:'2026-11-01',
    subtasks:[{title:'Protected action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'tasks.view_household':'allow',
    'tasks.change_assignment':'allow','tasks.reassign':'none'}});
  assert.equal(taskCapabilities(f.d,2,f.row(root.data.id)).change_assignment,true);
  assert.equal(taskCapabilities(f.d,2,f.row(root.data.id)).reassign,false);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'protected-one',actorId:2}),
    error=>error.status===403);
  assert.deepEqual(assignments(f.d,child),[]);
});

test('a saved receipt cannot be replayed after the actor loses child visibility',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Replay protected root',due_date:'2026-11-01',
    subtasks:[{title:'Replay protected action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  const receipt=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'replay-one',actorId:1});
  const other=receipt.decisions.find(item=>item.key===String(child)).assignee_ids[0]===2?3:2;
  replaceSubjectPermissions(f.d,'user',other,{capabilities:{'tasks.view_household':'allow',
    'tasks.change_assignment':'allow','tasks.reassign':'allow'}});
  f.d.prepare("UPDATE tasks SET visibility='assignees' WHERE id=?").run(child);
  assert.equal(taskCapabilities(f.d,other,f.row(root.data.id)).change_assignment,true);
  assert.equal(taskCapabilities(f.d,other,f.row(child)).view,false);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'replay-one',actorId:other}),
    error=>error.status===403);
});

test('archiving or moving a private child cannot bypass saved receipt authorization',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Historical private root',due_date:'2026-11-01',
    subtasks:[{title:'Historical private action',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'historical-private',actorId:1});
  replaceSubjectPermissions(f.d,'user',3,{capabilities:{'tasks.view_household':'allow',
    'tasks.change_assignment':'allow','tasks.reassign':'allow'}});
  assert.equal(taskCapabilities(f.d,3,f.row(root.data.id)).change_assignment,true);
  f.d.prepare("UPDATE tasks SET archived_at='2026-11-02T00:00:00Z',visibility='private' WHERE id=?").run(child);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'historical-private',actorId:3}),
    error=>error.status===403);
  f.d.prepare('UPDATE tasks SET parent_task_id=NULL,archived_at=NULL WHERE id=?').run(child);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'historical-private',actorId:3}),
    error=>error.status===403);
});

test('required and optional supervised work keep distinct qualified helpers in one linked scope',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'helper4','Helper 4','x','member','parent')").run();
  const optionalGroup=saveRotationGroup(f.d,{name:'Optional learner',member_ids:[2]},{actorId:1});
  const requiredGroup=saveRotationGroup(f.d,{name:'Required learner',member_ids:[3]},{actorId:1});
  const root=await f.create({title:'Supervisor priority',due_date:'2026-11-01',
    subtasks:[{title:'Optional 1',points:0,is_optional:true,assigned_user_ids:[]},
      {title:'Optional 2',points:0,is_optional:true,assigned_user_ids:[]},
      {title:'Required',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const children=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id).map(row=>row.id);
  const [skillA,skillB]=['Optional helper skill','Required helper skill'].map(name=>Number(
    f.d.prepare('INSERT INTO skills(name,minimum_age,created_by) VALUES(?,0,1)').run(name).lastInsertRowid));
  for(const [user,skill,level] of [[2,skillA,'supervised'],[1,skillA,'normal'],[4,skillA,'excluded'],
    [3,skillB,'supervised'],[4,skillB,'normal'],[1,skillB,'excluded']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(user,skill,level);
  children.forEach((id,index)=>{
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,index<2?skillA:skillB);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
      .run(id,JSON.stringify({kind:'group',group_id:index<2?optionalGroup.id:requiredGroup.id,mode:'random'}));
  });
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'supervisor-priority',actorId:1});
  assert.deepEqual(assignments(f.d,children[2]),[3]);
  assert.deepEqual(assignments(f.d,children[0]),[2]);
  assert.deepEqual(assignments(f.d,children[1]),[2]);
  assert.equal(result.supervisor_user_id,null);
  assert.equal(f.d.prepare("SELECT supervisor_scope FROM task_activity_support_tasks WHERE source_task_id=?").get(root.data.id).supervisor_scope,'per_action');
  for(const id of children.slice(0,2))
    assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(id).supervisor_user_id,1);
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(children[2]).supervisor_user_id,4);
});

test('a preassigned Synced subtask holds its member for new siblings without advancing again',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Held sync',due_date:'2026-11-01',
    subtasks:[{title:'Already assigned',points:0,assigned_user_ids:[2]},
      {title:'New sibling',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const [held,pending]=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id).map(row=>row.id);
  for(const id of [held,pending])f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'synced'}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'held-sync',actorId:1});
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(assignments(f.d,held),[2]);
  assert.deepEqual(assignments(f.d,pending),[2]);
  assert.deepEqual(result.cursor_advances,[]);
});

test('separate recurrence occurrences reuse one Activity Synced cursor without rerolling the old receipt',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const make=async(date)=>{
    const root=await f.create({title:'Recurring sync',due_date:date,is_recurring:1,recurrence_rule:'FREQ=DAILY',
      subtasks:[{title:'One synced action',points:0,assigned_user_ids:[]}]});
    assert.equal(root.status,201,JSON.stringify(root));
    const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
      .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'synced'}));
    return {root:root.data.id,child};
  };
  const first=await make('2026-11-01');
  const series=f.d.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(first.root);
  assert.ok(series);
  const one=resolveSubtaskOccurrence(f.d,{rootTaskId:first.root,idempotencyKey:'series-one',actorId:1});
  assert.deepEqual(assignments(f.d,first.child),[2]);
  const second=await make('2026-11-02');
  f.d.prepare('UPDATE task_recurrence_occurrences SET series_id=?,predecessor_task_id=?,generation=1 WHERE task_id=?')
    .run(series.series_id,first.root,second.root);
  const two=resolveSubtaskOccurrence(f.d,{rootTaskId:second.root,idempotencyKey:'series-two',actorId:1});
  assert.deepEqual(assignments(f.d,second.child),[3]);
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:first.root,idempotencyKey:'series-one',actorId:1}),one);
  assert.equal(f.d.prepare("SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:series:%'").get().occurrence_count,2);
  assert.equal(two.cursor_advances.length,1);
});

test('an unpublished Group membership edit is read before the first occurrence resolution',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Changed roster',due_date:'2026-11-01',
    subtasks:[{title:'Member choice',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  saveRotationGroup(f.d,{name:'Occurrence roster',member_ids:[3]},
    {id:group.id,actorId:1,expectedRevision:group.revision});
  const receipt=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'edited-first',actorId:1});
  assert.deepEqual(receipt.conflicts,[]);
  assert.deepEqual(assignments(f.d,child),[3]);
  assert.deepEqual(receipt.decisions[0].source.member_order,[3]);
});

test('a Group default supervisor pool is honored without falling back to another adult',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'helper4','Helper 4','x','member','parent')").run();
  const workers=saveRotationGroup(f.d,{name:'Workers needing help',member_ids:[2]},{actorId:1});
  const helpers=saveRotationGroup(f.d,{name:'Chosen helpers',member_ids:[4]},{actorId:1});
  const root=await f.create({title:'Group helper default',due_date:'2026-11-01',
    subtasks:[{title:'Help required',points:0,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.data.id).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Group helper skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[2,'supervised'],[4,'normal']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:workers.id,mode:'random'}));
  f.d.prepare('INSERT INTO rotation_group_supervisor_defaults(group_id,pool_json) VALUES(?,?)')
    .run(workers.id,JSON.stringify({kind:'group',group_id:helpers.id}));
  const result=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'group-helper',actorId:1});
  assert.deepEqual(result.conflicts,[]);
  assert.equal(result.supervisor_user_id,4);
  assert.deepEqual(assignments(f.d,child),[2]);
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(child).supervisor_user_id,4);
});

test('changed eligibility recovers only unresolved work and keeps both idempotent receipts',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Recoverable occurrence',due_date:'2026-11-01',
    subtasks:[{title:'Stable assigned work',points:1,assigned_user_ids:[]},
      {title:'Temporarily blocked work',points:1,assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const [stable,blocked]=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id)
    .map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Recovery skill',0,1)")
    .run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(blocked,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(stable,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}));
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(blocked,JSON.stringify({kind:'fixed',user_ids:[2]}));
  const first=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'blocked-first',actorId:1});
  assert.deepEqual(first.conflicts,[{key:String(blocked),reason:'fixed_person_ineligible'}]);
  const selected=assignments(f.d,stable);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'unchanged-retry',actorId:1}),
    error=>error.status===409);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=2 AND skill_id=?").run(skill);
  const recovered=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'eligibility-recovered',actorId:1});
  assert.deepEqual(recovered.conflicts,[]);
  assert.deepEqual(assignments(f.d,stable),selected);
  assert.deepEqual(assignments(f.d,blocked),[2]);
  const before=f.changes();
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'blocked-first',actorId:1}),first);
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'eligibility-recovered',actorId:1}),recovered);
  assert.equal(f.changes(),before);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_resolution_attempts WHERE root_task_id=?').get(root.data.id).n,2);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'third-not-needed',actorId:1}),
    error=>error.status===409);
});

test('Synced recovery advances one Activity cursor only when a common member becomes eligible',async t=>{
  const f=await scoringFixture(t),group=members(f.d);
  const root=await f.create({title:'Recoverable sync',due_date:'2026-11-01',
    subtasks:[{title:'Restricted action',assigned_user_ids:[]},{title:'Other action',assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const [restricted,other]=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root.data.id)
    .map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Sync recovery',0,1)")
    .run().lastInsertRowid);
  for(const id of [2,3])f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,'excluded')")
    .run(id,skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(restricted,skill);
  for(const id of [restricted,other])f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'synced'}));
  const first=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'sync-conflict',actorId:1});
  assert.equal(first.conflicts.length,2);
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().n,0);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=3 AND skill_id=?").run(skill);
  const next=resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'sync-recovered',actorId:1});
  assert.deepEqual(next.conflicts,[]);
  assert.deepEqual(assignments(f.d,restricted),[3]);assert.deepEqual(assignments(f.d,other),[3]);
  assert.equal(f.d.prepare("SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().occurrence_count,1);
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:root.data.id,idempotencyKey:'sync-conflict',actorId:1}),first);
  assert.equal(f.d.prepare("SELECT occurrence_count FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").get().occurrence_count,1);
});
