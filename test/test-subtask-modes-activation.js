import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {saveRotationGroupUsage} from '../server/services/rotation-shared.js';
import {replaceSubjectPermissions} from '../server/permissions.js';
import {instantiateWorkflow} from '../server/services/activity-workflows.js';
import {resolveSubtaskOccurrence,materializeSavedSubtaskOccurrence} from '../server/services/subtask-occurrence-resolution.js';
const people=(f,id)=>f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(r=>r.user_id);
const children=(f,id)=>f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY id').all(id);
const rule=group=>({kind:'group',group_id:group.id,mode:'synced'});

test('Task creation resolves authored modes once; reads and ordinary edits preserve the receipt',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Workers',member_ids:[2,3]},{actorId:1});
  const r=await f.create({title:'Resolved creation',assigned_to:[1],subtask_candidate_pool:{group_ids:[g.id],person_ids:[]},
    subtasks:[{title:'A',assignment_rule:rule(g)},{title:'B',assignment_rule:rule(g)}]});
  assert.equal(r.status,201,JSON.stringify(r));
  const rows=children(f,r.data.id);assert.deepEqual(rows.map(row=>people(f,row.id)),[[2],[2]]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_synced_advances').get().n,1);
  const before=f.changes();assert.equal((await f.call('GET','/tasks/'+r.data.id)).status,200);assert.equal(f.changes(),before);
  const receipt=f.d.prepare('SELECT receipt_json FROM task_subtask_resolution_runs WHERE root_task_id=?').get(r.data.id).receipt_json;
  assert.equal((await f.edit(r.data.id,{title:'Renamed'})).status,200);
  assert.equal(f.d.prepare('SELECT receipt_json FROM task_subtask_resolution_runs WHERE root_task_id=?').get(r.data.id).receipt_json,receipt);
});

test('Template create/edit carries mode and supervisor policy into launches, leaving existing work intact',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Template workers',member_ids:[2,3]},{actorId:1});
  const made=await f.call('POST','/automation/admin/activity-templates',{name:'Mode template',assignment_strategy:'fixed',fixed_user_id:1,
    subtask_candidate_pool:{group_ids:[g.id],person_ids:[]},checklist:[{title_template:'Mode child',assignment_rule:rule(g),supervisor_pool:{kind:'person',user_id:1}}]});
  assert.equal(made.status,201,JSON.stringify(made));
  assert.equal(JSON.parse(made.data.checklist[0].assignment_rule_json).mode,'synced');
  const first=await f.create({activity_template_id:made.data.id});assert.equal(first.status,201,JSON.stringify(first));
  const child=children(f,first.data.id)[0];assert.deepEqual(people(f,child.id),[2]);
  const edited=await f.call('PUT','/automation/admin/activity-templates/'+made.data.id,{checklist:[{id:made.data.checklist[0].id,title_template:'Changed',assignment_rule:{...rule(g),mode:'random'}}]});
  assert.equal(edited.status,200,JSON.stringify(edited));assert.deepEqual(people(f,child.id),[2]);
  assert.equal(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child.id).source_json).mode,'synced');
  const next=await f.create({activity_template_id:made.data.id});assert.equal(next.status,201,JSON.stringify(next));
  assert.equal(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(children(f,next.data.id)[0].id).source_json).mode,'random');
});

test('recurrence resolves the next saved rule and retry consumes no second turn',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Recurring workers',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Recurring modes',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'A',assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));assert.deepEqual(people(f,children(f,made.data.id)[0].id),[2]);
  assert.equal((await f.finish(made.data.id)).status,200);
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id);
  assert.ok(next);assert.deepEqual(people(f,children(f,next.id)[0].id),[3]);
  const cursor=f.d.prepare('SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE ?').all('subtask-synced:%');
  assert.equal((await f.finish(made.data.id)).status,200);
  assert.deepEqual(f.d.prepare('SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE ?').all('subtask-synced:%'),cursor);
});

test('revoked saved creator produces an explicit unresolved recurrence without blocking completion or advancing a cursor',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Revoked workers',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Revoked recurrence',assigned_to:[2],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'A',assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));
  f.d.prepare('UPDATE tasks SET created_by=2 WHERE id=?').run(made.data.id);
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'tasks.change_assignment':'none'}});
  const cursor=f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all();
  assert.equal((await f.finish(made.data.id)).status,200);
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id);
  assert.ok(next);const c=children(f,next.id)[0];assert.deepEqual(people(f,c.id),[]);
  assert.equal(f.d.prepare('SELECT reason FROM task_subtask_resolution_decisions WHERE task_id=?').get(c.id)?.reason,'assignment_authorization_required');
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_synced_advances').get().n,1);
  assert.deepEqual(f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all(),cursor);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(next.id).n,0);
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'tasks.change_assignment':'allow','tasks.reassign':'allow','tasks.view_own':'allow','tasks.view_household':'allow'}});
  const recovery=await f.call('POST',`/tasks/${next.id}/subtasks/resolve`,{idempotency_key:'restored-author'},1);
  assert.equal(recovery.status,200,JSON.stringify(recovery));assert.deepEqual(people(f,c.id),[3]);
});

test('explicit recovery requires current revision and permission; exact replay writes zero rows',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Recovery workers',member_ids:[2]},{actorId:1});
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Recovery',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  const made=await f.create({title:'Unresolved modes',subtasks:[{title:'A',skill_ids:[skill],assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));const c=children(f,made.data.id)[0];assert.deepEqual(people(f,c.id),[]);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=2 AND skill_id=?").run(skill);
  const path=`/tasks/${made.data.id}/subtasks/resolve`,body={idempotency_key:'recover-test',expected_revision:f.row(made.data.id).revision};
  assert.equal((await f.call('POST',path,{...body,expected_revision:1})).status,409);
  const resolved=await f.call('POST',path,body);assert.equal(resolved.status,200,JSON.stringify(resolved));assert.deepEqual(people(f,c.id),[2]);
  const before=f.changes(),replay=await f.call('POST',path,body);assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(f.changes(),before);
});

test('workflow nested Activities resolve their own dated checklist and replay one atomic instance',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Workflow workers',member_ids:[2,3]},{actorId:1});
  const template=await f.call('POST','/automation/admin/activity-templates',{name:'Workflow modes',assignment_strategy:'fixed',fixed_user_id:1,
    subtask_candidate_pool:{person_ids:[],group_ids:[g.id]},due_date_offset_days:2,checklist:[{title_template:'Nested work',assignment_rule:rule(g)}]});
  assert.equal(template.status,201,JSON.stringify(template));
  const wid=Number(f.d.prepare("INSERT INTO workflow_templates(name,category,subject_required,created_by) VALUES('Mode workflow','misc',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(?,?,'step',0)").run(wid,template.data.id);
  const args={createdBy:1,startDate:'2026-11-03',requestKey:'nested_modes_retry'};
  const first=instantiateWorkflow(f.d,wid,args),activity=first.tasks.find(row=>row.role==='primary');
  assert.deepEqual(JSON.parse(f.row(activity.task_id).subtask_candidate_pool_json),{person_ids:[],group_ids:[g.id]});
  const c=children(f,activity.task_id)[0];assert.equal(c.due_date,'2026-11-05');assert.deepEqual(people(f,c.id),[2]);
  const before=f.changes();assert.deepEqual(instantiateWorkflow(f.d,wid,args),first);assert.equal(f.changes(),before);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:c.id,actorId:1,idempotencyKey:'wrong-nested'}),/open Activity|no subtask rules/);
});

test('full task edit preserves resolved source and actual work; adding a ruled child does not rerun old decisions',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Edit workers',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Mode editor',subtasks:[{title:'Original',assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));const c=children(f,made.data.id)[0];
  const edit=await f.edit(made.data.id,{subtasks:[{id:c.id,title:'Original edited',assignment_rule:rule(g),assigned_user_ids:[2]},
    {title:'Added',assignment_rule:rule(g)}]});
  assert.equal(edit.status,200,JSON.stringify(edit));assert.deepEqual(children(f,made.data.id).map(row=>people(f,row.id)),[[2],[2]]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_synced_advances').get().n,1);
  const before=f.changes();materializeSavedSubtaskOccurrence(f.d,made.data.id);assert.equal(f.changes(),before);
});

test('unchanged unresolved retries write nothing, and recovery responses hide Group policy after visibility revocation',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Hidden rule',member_ids:[2]},{actorId:1});
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Blocked privacy',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  const made=await f.create({title:'Private recovery',assigned_to:[2],subtasks:[{title:'Blocked',skill_ids:[skill],assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));const path=`/tasks/${made.data.id}/subtasks/resolve`;
  const before=f.changes();const noChange=await f.call('POST',path,{idempotency_key:'unchanged-public'});assert.equal(noChange.status,409,JSON.stringify(noChange));assert.equal(f.changes(),before);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=2 AND skill_id=?").run(skill);
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'tasks.change_assignment':'allow','tasks.reassign':'allow','tasks.view_own':'allow','tasks.view_household':'allow','rotations.view':'none'}});
  const recovered=await f.call('POST',path,{idempotency_key:'private-recovery'},2);assert.equal(recovered.status,200,JSON.stringify(recovered));
  assert.equal(recovered.data.decisions[0].source,undefined);assert.deepEqual(recovered.data.cursor_advances,[]);
});

test('ruled creation never notifies candidates and retries never duplicate notification or award rows',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Notification pool',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Notice activity',assigned_to:[1],scoring_mode:'subtasks',subtasks:[{title:'Worth points',points:4,assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));const c=children(f,made.data.id)[0];
  assert.deepEqual(f.d.prepare('SELECT DISTINCT user_id FROM notification_inbox WHERE entity_id=?').all(c.id),[{user_id:2}]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_task_awards WHERE task_id=?').get(c.id).n,0);
  const notices=f.d.prepare('SELECT COUNT(*) n FROM notification_inbox').get().n;
  materializeSavedSubtaskOccurrence(f.d,made.data.id);assert.equal(f.d.prepare('SELECT COUNT(*) n FROM notification_inbox').get().n,notices);
  assert.equal((await f.finish(made.data.id)).status,200);const awards=f.d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n;
  assert.equal((await f.finish(made.data.id)).status,200);assert.equal(f.d.prepare('SELECT COUNT(*) n FROM reward_task_awards').get().n,awards);
});

test('a saved independent mode crossing a shared date records a policy conflict without blocking completion',async t=>{
  const f=await scoringFixture(t);
  const g=saveRotationGroupUsage(f.d,{name:'Shared date boundary',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',start_mode:'first',effective_date:'2026-11-02',weekdays:[0,1,2,3,4,5,6],active_time:'10:00',finalize_time:'23:00',finalize_day_offset:0,eligibility:{}}},
    {actorId:1,now:new Date('2026-11-01T12:00:00Z')});
  const made=await f.create({title:'Boundary recurrence',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'A',assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));const cursor=f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all();
  const finished=await f.finish(made.data.id);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id),c=children(f,next.id)[0];
  assert.deepEqual(people(f,c.id),[]);assert.equal(f.d.prepare('SELECT reason FROM task_subtask_resolution_decisions WHERE task_id=?').get(c.id).reason,'group_mode_policy_conflict');
  assert.deepEqual(f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all(),cursor);
  const correction=await f.edit(next.id,{subtasks:[{id:c.id,title:c.title,assignment_rule:{...rule(g),mode:'global'}}]});
  assert.equal(correction.status,200,JSON.stringify(correction));
  assert.equal(f.d.prepare('SELECT state FROM task_subtask_resolution_decisions WHERE task_id=?').get(c.id).state,'assigned',
    f.d.prepare('SELECT receipt_json FROM task_subtask_resolution_runs WHERE root_task_id=?').get(next.id).receipt_json);
});

test('Template and future editor projections hide rule Group identity without Group visibility',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Private Template Group',member_ids:[2,3]},{actorId:1});
  const made=await f.call('POST','/automation/admin/activity-templates',{name:'Hidden policy template',assignment_strategy:'fixed',fixed_user_id:1,
    checklist:[{title_template:'Private Group action',assignment_rule:rule(g),supervisor_pool:{kind:'group',group_id:g.id}}]});
  assert.equal(made.status,201,JSON.stringify(made));
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'activities.view':'allow','rotations.view':'none'}});
  const list=await f.call('GET','/automation/admin/activity-templates',undefined,2);assert.equal(list.status,200,JSON.stringify(list));
  const item=list.data.find(row=>row.id===made.data.id).checklist[0];assert.equal(item.assignment_rule_json,null);assert.equal(item.supervisor_pool_json,null);
});

test('two standalone launches of one Template use separate concrete Synced cursors',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Separate activities',member_ids:[2,3]},{actorId:1});
  const template=await f.call('POST','/automation/admin/activity-templates',{name:'Separate launches',assignment_strategy:'fixed',fixed_user_id:1,checklist:[{title_template:'A',assignment_rule:rule(g)}]});
  assert.equal(template.status,201,JSON.stringify(template));
  const a=await f.create({activity_template_id:template.data.id}),b=await f.create({activity_template_id:template.data.id});
  assert.equal(a.status,201,JSON.stringify(a));assert.equal(b.status,201,JSON.stringify(b));
  assert.deepEqual(people(f,children(f,a.data.id)[0].id),[2]);assert.deepEqual(people(f,children(f,b.data.id)[0].id),[2]);
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:task:%'").get().n,2);
});

test('a saved independent order appends current Group members in later occurrences',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Growing saved order',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Growing recurrence',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',
    subtasks:[{title:'A',assignment_rule:{...rule(g),member_order:[3,2]}}]});
  assert.equal(made.status,201,JSON.stringify(made));assert.deepEqual(people(f,children(f,made.data.id)[0].id),[3]);
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'newmember','New member','x','member','other')").run();
  saveRotationGroup(f.d,{name:g.name,member_ids:[2,3,4]},{id:g.id,actorId:1,expectedRevision:g.revision});
  const finished=await f.finish(made.data.id);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id);
  assert.deepEqual(people(f,children(f,next.id)[0].id),[2]);
});

test('an authorization-unresolved supervised recurrence creates no inherited Owner helper assignment',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Supervised authority',member_ids:[2]},{actorId:1});
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Authority helper',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[2,'supervised']])f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  const made=await f.create({title:'Supervised revoked source',assigned_to:[2],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',
    subtasks:[{title:'Supervised action',skill_ids:[skill],assignment_rule:rule(g),supervisor_pool:{kind:'person',user_id:1}}]});
  assert.equal(made.status,201,JSON.stringify(made));
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM notification_inbox WHERE user_id=1 AND entity_id=? AND source_key LIKE 'task-supervision-scope:%'").get(made.data.id).n,1);
  f.d.prepare('UPDATE tasks SET created_by=2 WHERE id=?').run(made.data.id);
  replaceSubjectPermissions(f.d,'user',2,{capabilities:{'tasks.change_assignment':'none'}});
  const finished=await f.finish(made.data.id);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id);
  const action=children(f,next.id).find(row=>row.title==='Supervised action');assert.deepEqual(people(f,action.id),[]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(next.id).n,0);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_supervision_actions WHERE source_task_id=?').get(next.id).n,0);
});

test('an assignment editor can author an unsupervised rule without changing the saved supervisor pool',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Delegated editor',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Other creator',assigned_to:[2],subtasks:[{title:'Empty work',assigned_user_ids:[]}]});assert.equal(made.status,201,JSON.stringify(made));
  for(const key of ['edit_own','edit_others','change_assignment','reassign','view_own','view_household'])f.grant(key,'allow');
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','allow')").run();
  const c=children(f,made.data.id)[0],result=await f.edit(made.data.id,{subtasks:[{id:c.id,title:c.title,assignment_rule:rule(g),supervisor_pool:null}]},2);
  assert.equal(result.status,200,JSON.stringify(result));assert.deepEqual(people(f,c.id),[2]);
});

test('a removed saved creator leaves the successor unresolved without blocking current completion',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Removed author',member_ids:[2,3]},{actorId:1});
  const made=await f.create({title:'Removed creator recurrence',assigned_to:[2],due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'A',assignment_rule:rule(g)}]});
  assert.equal(made.status,201,JSON.stringify(made));
  f.d.prepare('UPDATE tasks SET created_by=NULL WHERE id=?').run(made.data.id);
  const cursor=f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all();
  const finished=await f.finish(made.data.id);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(made.data.id),c=children(f,next.id)[0];
  assert.deepEqual(people(f,c.id),[]);assert.equal(f.d.prepare('SELECT reason FROM task_subtask_resolution_decisions WHERE task_id=?').get(c.id).reason,'assignment_authorization_required');
  assert.deepEqual(f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE 'subtask-synced:%'").all(),cursor);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(next.id).n,0);
});

test('an unchanged Template rule survives an inactive Group and launches an explicit unresolved occurrence',async t=>{
  const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Inactive saved source',member_ids:[2,3]},{actorId:1});
  const made=await f.call('POST','/automation/admin/activity-templates',{name:'Inactive source template',assignment_strategy:'fixed',fixed_user_id:1,
    checklist:[{title_template:'Saved rule',assignment_rule:rule(g)}]});assert.equal(made.status,201,JSON.stringify(made));
  saveRotationGroup(f.d,{name:g.name,active:false,member_ids:[2,3]},{id:g.id,actorId:1,expectedRevision:g.revision});
  const item=made.data.checklist[0],edited=await f.call('PUT','/automation/admin/activity-templates/'+made.data.id,
    {checklist:[{id:item.id,title_template:'Renamed action',assignment_rule:JSON.parse(item.assignment_rule_json)}]});
  assert.equal(edited.status,200,JSON.stringify(edited));
  const launched=await f.create({activity_template_id:made.data.id});assert.equal(launched.status,201,JSON.stringify(launched));
  const c=children(f,launched.data.id)[0];assert.deepEqual(people(f,c.id),[]);
  assert.equal(f.d.prepare('SELECT reason FROM task_subtask_resolution_decisions WHERE task_id=?').get(c.id).reason,'group_unavailable');
});
