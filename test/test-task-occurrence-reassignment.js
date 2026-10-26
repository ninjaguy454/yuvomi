import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {instantiateWorkflow} from '../server/services/activity-workflows.js';
import {reconcileTaskSupervision} from '../server/services/task-supervision.js';

const assignments=(d,id)=>d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id')
  .all(id).map(row=>row.user_id);
const childIds=(d,root)=>d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root).map(row=>row.id);
const body=(taskIds,extra={})=>({mode:'replace',task_ids:taskIds,from_user_id:2,replacement_user_id:3,...extra});
const preview=(f,root,payload,actor=1)=>f.call('POST',`/tasks/${root}/subtasks/reassign/preview`,payload,actor);
const apply=(f,root,payload,actor=1)=>f.call('POST',`/tasks/${root}/subtasks/reassign/apply`,payload,actor);

test('one occurrence reassignment previews, applies once and preserves the next series assignee',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Occurrence only',due_date:'2026-11-01',
    is_recurring:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Action',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=childIds(f.d,root)[0],request=body([child]);
  const before=f.snapshot(),shown=await preview(f,root,request);
  assert.equal(shown.status,200,JSON.stringify(shown));assert.equal(shown.data.can_apply,true);
  assert.deepEqual(shown.data.changes[0].after_user_ids,[3]);
  assert.equal(f.snapshot(),before,'preview must not persist work or helper changes');
  const save={...request,preview_hash:shown.data.preview_hash,idempotency_key:'one-occurrence'};
  const result=await apply(f,root,save);assert.equal(result.status,200,JSON.stringify(result));
  assert.deepEqual(assignments(f.d,child),[3]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_occurrence_overrides WHERE task_id=?').get(child).n,1);
  const changed=f.changes(),replay=await apply(f,root,save);
  assert.deepEqual(replay,result);assert.equal(f.changes(),changed,'receipt replay must make no writes');
  const finished=await f.finish(root);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);
  assert.ok(next);assert.deepEqual(assignments(f.d,childIds(f.d,next.id)[0]),[2]);
  assert.deepEqual(assignments(f.d,child),[3]);
});

test('skill changes stale the preview and an ineligible replacement stays unassigned',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Skill guard',
    subtasks:[{title:'Skill step',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=childIds(f.d,root)[0],request=body([child]);
  const first=await preview(f,root,request);assert.equal(first.status,200,JSON.stringify(first));
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Replacement skill',0,1)")
    .run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'excluded')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  const stale=await apply(f,root,{...request,preview_hash:first.data.preview_hash,idempotency_key:'stale-skill'});
  assert.equal(stale.status,409,JSON.stringify(stale));
  const blocked=await preview(f,root,request);assert.equal(blocked.status,200,JSON.stringify(blocked));
  assert.equal(blocked.data.can_apply,false);
  assert.deepEqual(assignments(f.d,child),[2]);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_subtask_occurrence_overrides').get().n,0);
});

test('Smart Rebalance changes only selected unfinished work and leaves the Group rule intact',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Rebalance group',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Balance step work',subtasks:[
    {title:'First',assigned_user_ids:[2],points:0},{title:'Second',assigned_user_ids:[2],points:0}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,children=childIds(f.d,root),rule=JSON.stringify({kind:'group',group_id:group.id,mode:'smart'});
  for(const id of children)f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)').run(id,rule);
  const request={mode:'rebalance',task_ids:children,from_user_id:2};
  const shown=await preview(f,root,request);assert.equal(shown.status,200,JSON.stringify(shown));
  assert.equal(shown.data.can_apply,true);
  assert.deepEqual(shown.data.changes.map(item=>item.after_user_ids[0]).sort(),[2,3]);
  const saved=await apply(f,root,{...request,preview_hash:shown.data.preview_hash,idempotency_key:'balance-once'});
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(children.flatMap(id=>assignments(f.d,id)).sort(),[2,3]);
  for(const id of children)assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(id).source_json),JSON.parse(rule));
});

test('a supervised replacement links one qualified helper and preserves the Group source',async t=>{
  const f=await scoringFixture(t);f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  const group=saveRotationGroup(f.d,{name:'Original Group',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Help after absence',due_date:'2026-11-01',
    subtasks:[{title:'Supervised action',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=childIds(f.d,root)[0];
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Replacement supervision',0,1)")
    .run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[2,'normal'],[3,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  const rule={kind:'group',group_id:group.id,mode:'smart'};
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)').run(child,JSON.stringify(rule));
  const request=body([child]),shown=await preview(f,root,request);
  assert.equal(shown.status,200,JSON.stringify(shown));assert.equal(shown.data.can_apply,true);
  assert.equal(shown.data.supervisor_user_id,1);
  const saved=await apply(f,root,{...request,preview_hash:shown.data.preview_hash,idempotency_key:'supervised-replacement'});
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(assignments(f.d,child),[3]);
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child).source_json),rule);
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE action_task_id=?').get(child).supervisor_user_id,1);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root).n,1);
});

test('presence and permissions fail closed before any occurrence override',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Presence guard',due_date:'2026-11-01',
    subtasks:[{title:'Home work',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=childIds(f.d,root)[0],request=body([child]);
  f.grant('reassign','none');
  assert.equal((await preview(f,root,request,2)).status,403);
  f.d.prepare("INSERT INTO task_planning_context(task_id,presence_policy,source) VALUES(?,'must_be_home','manual')")
    .run(root);
  const shown=await preview(f,root,request);assert.equal(shown.status,200,JSON.stringify(shown));
  assert.equal(shown.data.can_apply,false);
  assert.deepEqual(assignments(f.d,child),[2]);
});

test('a late write failure rolls back the occurrence assignment, helper and receipt',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Atomic replacement',
    subtasks:[{title:'Action',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=childIds(f.d,root)[0],request=body([child]);
  const shown=await preview(f,root,request);assert.equal(shown.status,200,JSON.stringify(shown));
  f.d.exec(`CREATE TRIGGER fail_reassignment_receipt BEFORE INSERT ON task_subtask_reassignment_runs
    BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;`);
  const before=f.snapshot(),result=await apply(f,root,{...request,preview_hash:shown.data.preview_hash,idempotency_key:'rollback'});
  assert.notEqual(result.status,200);assert.equal(f.snapshot(),before);
  assert.deepEqual(assignments(f.d,child),[2]);
});

test('receipt replay checks original request and read access, including after completion',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Replay guard',subtasks:[
    {title:'Selected',assigned_user_ids:[2]},{title:'Other',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const [selected,other]=childIds(f.d,created.data.id),request=body([selected]);
  f.grant('change_assignment','allow');f.grant('reassign','allow');
  const shown=await preview(f,created.data.id,request,2);
  assert.equal(shown.status,200,JSON.stringify(shown));
  const save={...request,preview_hash:shown.data.preview_hash,idempotency_key:'receipt-guard'};
  const receipt=await apply(f,created.data.id,save,2);assert.equal(receipt.status,200,JSON.stringify(receipt));
  const changed=f.changes();
  assert.equal((await apply(f,created.data.id,{...save,task_ids:[other]},2)).status,409);
  assert.equal((await apply(f,created.data.id,{...save,replacement_user_id:2},2)).status,400);
  assert.equal(f.changes(),changed);
  const completed=await f.finish(selected);assert.equal(completed.status,200,JSON.stringify(completed));
  const stable=f.changes(),again=await apply(f,created.data.id,save,2);
  assert.deepEqual(again,receipt);assert.equal(f.changes(),stable);
  f.grant('view_household','none');f.grant('view_own','none');
  assert.equal((await apply(f,created.data.id,save,2)).status,404);
});

test('multi-person supervised replacement and Smart Rebalance remain blocked',async t=>{
  const f=await scoringFixture(t);f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'Synthetic 4','Synthetic 4','x','member','other')").run();
  const created=await f.create({title:'Shared work',subtasks:[{title:'Shared action',assigned_user_ids:[2,3]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=childIds(f.d,created.data.id)[0];
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Shared supervision',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[2,'normal'],[3,'normal'],[4,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  const shown=await preview(f,created.data.id,body([child],{replacement_user_id:4}));
  assert.equal(shown.status,409,JSON.stringify(shown));
  assert.deepEqual(assignments(f.d,child),[2,3]);
  const group=saveRotationGroup(f.d,{name:'Shared Smart',member_ids:[2,3]},{actorId:1});
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'smart'}));
  const rebalance=await preview(f,created.data.id,{mode:'rebalance',task_ids:[child],from_user_id:2});
  assert.equal(rebalance.status,409,JSON.stringify(rebalance));
  assert.deepEqual(assignments(f.d,child),[2,3]);
});

test('an unselected historical rule cannot block selected unfinished work',async t=>{
  const f=await scoringFixture(t),created=await f.create({title:'Independent reassignment',subtasks:[
    {title:'Selected',assigned_user_ids:[2]},{title:'Unrelated',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const [selected,other]=childIds(f.d,created.data.id);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(other,JSON.stringify({kind:'fixed',user_ids:[3]}));
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(other);
  const shown=await preview(f,created.data.id,body([selected]));
  assert.equal(shown.status,200,JSON.stringify(shown));assert.equal(shown.data.can_apply,true);
});

test('a hidden Group source cannot be inspected through Rebalance or Replace',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Hidden pool',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Group work',subtasks:[{title:'Assigned',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=childIds(f.d,created.data.id)[0];
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'smart'}));
  f.grant('change_assignment','allow');f.grant('reassign','allow');
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','none')").run();
  assert.equal((await preview(f,created.data.id,{mode:'rebalance',task_ids:[child],from_user_id:2},2)).status,403);
  assert.equal((await preview(f,created.data.id,body([child]),2)).status,403);
});

test('a saved Group receipt stops exposing its source when Group access is revoked',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Receipt Group',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Receipt privacy',subtasks:[{title:'Assigned',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=childIds(f.d,created.data.id)[0];
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json) VALUES(?,?)')
    .run(child,JSON.stringify({kind:'group',group_id:group.id,mode:'smart'}));
  f.grant('change_assignment','allow');f.grant('reassign','allow');
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','allow')").run();
  const request=body([child]),shown=await preview(f,created.data.id,request,2);
  assert.equal(shown.status,200,JSON.stringify(shown));
  const save={...request,preview_hash:shown.data.preview_hash,idempotency_key:'private-group-receipt'};
  const receipt=await apply(f,created.data.id,save,2);
  assert.equal(receipt.status,200,JSON.stringify(receipt));
  f.d.prepare("UPDATE access_capabilities SET access='none' WHERE subject_type='user' AND subject_id='2' AND capability_key='rotations.view'").run();
  const before=f.changes(),denied=await apply(f,created.data.id,save,2);
  assert.equal(denied.status,403,JSON.stringify(denied));
  assert.equal(f.changes(),before);
});

test('reassigning one supervised action preserves its sibling helper and shared parent',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  for(const id of [4,5])f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(?,?,?,?,?,?)")
    .run(id,`synthetic-${id}`,`Synthetic ${id}`,'x','member',id===4?'parent':'other');
  const created=await f.create({title:'Scoped supervision',due_date:'2026-11-01',subtasks:[
    {title:'Dad help',assigned_user_ids:[2]},{title:'Mom help',assigned_user_ids:[3]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,[dad,mom]=childIds(f.d,root);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Scoped skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[4,'normal'],[2,'supervised'],[3,'supervised'],[5,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  for(const [id,helper] of [[dad,1],[mom,4]]){
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
      .run(id,JSON.stringify({kind:'fixed',user_ids:id===dad?[2]:[3]}),JSON.stringify({kind:'person',user_id:helper}));
  }
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[dad]:1,[mom]:4},perActionPlanning:true,notify:false});
  const siblingBefore=f.d.prepare('SELECT counterpart_task_id,supervisor_user_id,revision FROM task_supervision_actions WHERE action_task_id=?').get(mom);
  const dadBefore=f.d.prepare('SELECT counterpart_task_id FROM task_supervision_actions WHERE action_task_id=?').get(dad);
  const request=body([dad],{replacement_user_id:5}),shown=await preview(f,root,request);
  assert.equal(shown.status,200,JSON.stringify(shown));assert.equal(shown.data.can_apply,true);
  const saved=await apply(f,root,{...request,preview_hash:shown.data.preview_hash,idempotency_key:'dad-action-only'});
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.deepEqual(assignments(f.d,dad),[5]);assert.deepEqual(assignments(f.d,mom),[3]);
  assert.deepEqual(f.d.prepare('SELECT counterpart_task_id,supervisor_user_id,revision FROM task_supervision_actions WHERE action_task_id=?').get(mom),siblingBefore);
  assert.equal(f.d.prepare('SELECT counterpart_task_id FROM task_supervision_actions WHERE action_task_id=?').get(dad).counterpart_task_id,dadBefore.counterpart_task_id);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM task_activity_support_tasks WHERE source_task_id=?').get(root).n,1);
  const dadDone=await f.call('PATCH',`/tasks/${dadBefore.counterpart_task_id}/status`,{status:'done'},1);
  assert.equal(dadDone.status,200,JSON.stringify(dadDone));
  assert.equal(f.d.prepare('SELECT status FROM tasks WHERE id=?').get(mom).status,'open');
  const momDone=await f.call('PATCH',`/tasks/${siblingBefore.counterpart_task_id}/status`,{status:'done'},4);
  assert.equal(momDone.status,200,JSON.stringify(momDone));
  const support=f.d.prepare('SELECT task_id FROM task_activity_support_tasks WHERE source_task_id=?').get(root).task_id;
  assert.equal(f.d.prepare('SELECT status FROM tasks WHERE id=?').get(support).status,'done');
  const history=f.d.prepare('SELECT action_task_id,counterpart_task_id,supervisor_user_id FROM task_supervision_actions WHERE source_task_id=? ORDER BY action_task_id').all(root);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=4 AND skill_id=?").run(skill);
  reconcileTaskSupervision(f.d,root,{actorId:1,notify:false});
  assert.deepEqual(f.d.prepare('SELECT action_task_id,counterpart_task_id,supervisor_user_id FROM task_supervision_actions WHERE source_task_id=? ORDER BY action_task_id').all(root),history,'completed helper history survives later skill changes');
  assert.equal(f.d.prepare('SELECT status FROM tasks WHERE id=?').get(support).status,'done');
});

test('workflow Activity reassigns its own unfinished child without changing source rules or future turns',async t=>{
 const f=await scoringFixture(t),g=saveRotationGroup(f.d,{name:'Workflow replace workers',member_ids:[2,3]},{actorId:1});
 const template=await f.call('POST','/automation/admin/activity-templates',{name:'Workflow replace',assignment_strategy:'fixed',fixed_user_id:1,
   subtask_candidate_pool:{person_ids:[],group_ids:[g.id]},checklist:[{title_template:'Workflow group work',assignment_rule:{kind:'group',group_id:g.id,mode:'smart'}}]});
 assert.equal(template.status,201,JSON.stringify(template));
 const wid=Number(f.d.prepare("INSERT INTO workflow_templates(name,category,subject_required,created_by) VALUES('Replace workflow','misc',0,1)").run().lastInsertRowid);
 f.d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order) VALUES(?,?,'step',0)").run(wid,template.data.id);
 const made=instantiateWorkflow(f.d,wid,{createdBy:1}),root=made.tasks.find(row=>row.role==='primary').task_id;
 const child=childIds(f.d,root)[0],from=assignments(f.d,child)[0],to=from===2?3:2;
 const source=f.d.prepare('SELECT * FROM task_subtask_assignment_rules WHERE task_id=?').get(child),cursor=f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all();
 const request=body([child],{from_user_id:from,replacement_user_id:to}),shown=await preview(f,root,request);
 assert.equal(shown.status,200,JSON.stringify(shown));assert.equal(shown.data.can_apply,true);
 const save={...request,preview_hash:shown.data.preview_hash,idempotency_key:'workflow-only-override'};
 const saved=await apply(f,root,save);assert.equal(saved.status,200,JSON.stringify(saved));assert.deepEqual(assignments(f.d,child),[to]);
 assert.deepEqual(f.d.prepare('SELECT * FROM task_subtask_assignment_rules WHERE task_id=?').get(child),source);
 assert.deepEqual(f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),cursor);
 const n=f.changes();assert.deepEqual(await apply(f,root,save),saved);assert.equal(f.changes(),n);
 const wrong=await preview(f,child,request);assert.notEqual(wrong.status,200);
});
