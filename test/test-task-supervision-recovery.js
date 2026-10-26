import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {inspectTaskSupervision,reconcileTaskSupervision} from '../server/services/task-supervision.js';
import {taskCapabilities} from '../server/services/task-access.js';

test('a manager recovers one unfinished split helper without changing sibling or accepting stale choices',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'recovery-mom','Mom','x','member','parent')").run();
  const group=saveRotationGroup(f.d,{name:'Recovery learners',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Recovery source',due_date:'2026-11-01',subtasks:[
    {title:'First supervised',assigned_user_ids:[]},{title:'Second supervised',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,children=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY id').all(root).map(row=>row.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Recovery skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[4,'normal'],[2,'supervised'],[3,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  for(const [index,id] of children.entries()){
    f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(id,skill);
    f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
      .run(id,JSON.stringify({kind:'group',group_id:group.id,mode:'random'}),JSON.stringify({kind:'person',user_id:index?4:1}));
  }
  // Assign explicit learners so this test does not depend on a random roster draw.
  f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,2),(?,3)').run(...children);
  f.d.prepare('UPDATE tasks SET assigned_to=2 WHERE id=?').run(children[0]);
  f.d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(children[1]);
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[0]]:1,[children[1]]:4},perActionPlanning:true,notify:false});
  const initial=inspectTaskSupervision(f.d,root);
  assert.equal(initial.supervisor_scope,'per_action');
  const second=initial.actions.find(row=>row.action_task_id===children[1]);
  const sibling=initial.actions.find(row=>row.action_task_id===children[0]);
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorAssignments:{[children[1]]:null},perActionPlanning:true,notify:false});
  const unresolved=inspectTaskSupervision(f.d,root).actions.find(row=>row.action_task_id===children[1]);
  assert.deepEqual(unresolved.eligible_supervisors.map(person=>person.id),[4],
    'the picker cannot offer a qualified adult outside the authored Mom-only pool');
  assert.deepEqual(unresolved.supervisor_explanations.map(person=>person.user_id),[4]);
  assert.deepEqual(unresolved.qualified_supervisor_ids,[4]);
  const body={action_task_id:children[1],supervisor_user_id:4,
    expected_action_revision:unresolved.revision,expected_revision:f.row(root).revision};
  const denied=await f.call('POST',`/tasks/${root}/supervisor`,body,2);
  assert.equal(denied.status,403,JSON.stringify(denied));
  const missing=await f.call('POST',`/tasks/${root}/supervisor`,{
    action_task_id:children[1],supervisor_user_id:4});
  assert.equal(missing.status,428,JSON.stringify(missing));
  const stale=await f.call('POST',`/tasks/${root}/supervisor`,{...body,expected_action_revision:second.revision});
  assert.equal(stale.status,409,JSON.stringify(stale));
  const wrongPool=await f.call('POST',`/tasks/${root}/supervisor`,{...body,supervisor_user_id:1});
  assert.equal(wrongPool.status,409,JSON.stringify(wrongPool));
  const before=f.changes();
  const recovered=await f.call('POST',`/tasks/${root}/supervisor`,body);
  assert.equal(recovered.status,200,JSON.stringify(recovered));
  const after=inspectTaskSupervision(f.d,root);
  assert.equal(after.actions.find(row=>row.action_task_id===children[1]).supervisor_user_id,4);
  assert.equal(after.actions.find(row=>row.action_task_id===children[0]).revision,sibling.revision);
  assert.equal(after.actions.find(row=>row.action_task_id===children[1]).counterpart_task_id,second.counterpart_task_id);
  assert.ok(f.changes()>before);
  const saved=f.changes();
  const replay=await f.call('POST',`/tasks/${root}/supervisor`,body);
  assert.equal(replay.status,200,JSON.stringify(replay));
  assert.equal(f.changes(),saved,'identical replay does not write');
  const conflict=await f.call('POST',`/tasks/${root}/supervisor`,{...body,supervisor_user_id:1});
  assert.equal(conflict.status,409,JSON.stringify(conflict));
  for(const key of ['view_household','change_assignment','reassign'])f.grant(key,'allow');
  f.d.prepare('UPDATE tasks SET created_by=2 WHERE id=?').run(root);
  f.d.prepare('UPDATE tasks SET created_by=3,locked=1 WHERE id=?').run(children[1]);
  const rootRights=taskCapabilities(f.d,2,{id:root}),childRights=taskCapabilities(f.d,2,{id:children[1]});
  assert.equal(rootRights.reassign,true,'the source creator may manage this Activity');
  assert.equal(childRights.view,true,'the locked child remains visible');
  assert.equal(childRights.reassign,false,'its other creator retains the assignment lock');
  const locked=await f.call('POST',`/tasks/${root}/supervisor`,{
    ...body,expected_revision:f.row(root).revision,
    expected_action_revision:after.actions.find(row=>row.action_task_id===children[1]).revision},2);
  assert.equal(locked.status,403,JSON.stringify(locked));
  const lockedRead=await f.call('GET',`/tasks/${root}`,undefined,2);
  assert.equal(lockedRead.data.supervision.actions.find(row=>row.action_task_id===children[1]).may_assign,false);
  f.d.prepare('UPDATE tasks SET created_by=1 WHERE id=?').run(root);
  f.d.prepare('UPDATE tasks SET created_by=1,locked=0 WHERE id=?').run(children[1]);
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=4 AND skill_id=?").run(skill);
  const ineligibleWrites=f.changes();
  const ineligible=await f.call('POST',`/tasks/${root}/supervisor`,{
    ...body,expected_revision:f.row(root).revision,
    expected_action_revision:after.actions.find(row=>row.action_task_id===children[1]).revision});
  assert.equal(ineligible.status,409,JSON.stringify(ineligible));
  assert.equal(f.changes(),ineligibleWrites,'an ineligible helper cannot be accepted as an old replay');
  f.d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=4 AND skill_id=?").run(skill);
  f.d.prepare("UPDATE tasks SET status='done' WHERE id=?").run(children[1]);
  const closedWrites=f.changes();
  const completed=await f.call('POST',`/tasks/${root}/supervisor`,{
    ...body,expected_revision:f.row(root).revision,expected_action_revision:after.actions.find(row=>row.action_task_id===children[1]).revision});
  assert.equal(completed.status,409,JSON.stringify(completed));
  assert.equal(f.changes(),closedWrites,'historical work is never reassigned');
});

test('an authored supervisor pool also limits the legacy single-helper selector',async t=>{
  const f=await scoringFixture(t);
  f.d.prepare("UPDATE users SET family_role='parent' WHERE id=1").run();
  f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'pool-mom','Mom','x','member','parent')").run();
  const made=await f.create({title:'Single helper with authored pool',due_date:'2026-11-01',
    subtasks:[{title:'One supervised action',assigned_user_ids:[2]}]});
  assert.equal(made.status,201,JSON.stringify(made));
  const root=made.data.id,child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root).id;
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Pool skill',0,1)").run().lastInsertRowid);
  for(const [id,level] of [[1,'normal'],[4,'normal'],[2,'supervised']])
    f.d.prepare('INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(?,?,?)').run(id,skill,level);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child,skill);
  f.d.prepare('INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json) VALUES(?,?,?)')
    .run(child,JSON.stringify({kind:'fixed',user_ids:[2]}),JSON.stringify({kind:'person',user_id:4}));
  reconcileTaskSupervision(f.d,root,{actorId:1,supervisorUserId:4,notify:false});
  const view=inspectTaskSupervision(f.d,root);
  assert.equal(view.supervisor_scope??'single','single');
  assert.deepEqual(view.eligible_supervisors.map(person=>person.id),[4]);
  const before=f.changes();
  const wrong=await f.call('POST',`/tasks/${root}/supervisor`,{
    supervisor_user_id:1,expected_revision:f.row(root).revision});
  assert.equal(wrong.status,409,JSON.stringify(wrong));
  assert.match(wrong.error,/qualified|eligible/i);
  assert.equal(f.changes(),before);
  assert.equal(inspectTaskSupervision(f.d,root).supervisor_user_id,4);
});
