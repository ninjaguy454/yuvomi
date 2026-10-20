import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {saveRotationGroupUsage} from '../server/services/rotation-shared.js';
import {chooseGroupAssignee} from '../server/services/group-assignment.js';
import {replaceSubjectPermissions} from '../server/permissions.js';

const group=(d,name='Synthetic group')=>saveRotationGroup(d,{name,member_ids:[2,3]},{actorId:1});

test('first and random starts are stable, qualified, and advance only on commit',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'first'};
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'sample',eligibleIds:[2,3]}),2);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'sample',eligibleIds:[2,3]}),2);
  assert.equal(f.d.prepare('SELECT count(*) n FROM assignment_rotation_state').get().n,0);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'sample',eligibleIds:[2,3],commit:true}),2);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'sample',eligibleIds:[2,3]}),3);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'sample',eligibleIds:[3],commit:true}),3);
  const reverse={...config,direction:'last_to_first'};
  assert.equal(chooseGroupAssignee(f.d,reverse,{consumerKey:'reverse',eligibleIds:[2,3],commit:true}),2);
  assert.equal(chooseGroupAssignee(f.d,reverse,{consumerKey:'reverse',eligibleIds:[2,3]}),3);
  assert.equal(chooseGroupAssignee(f.d,reverse,{consumerKey:'reverse',eligibleIds:[2,3],commit:true}),3);
  assert.equal(chooseGroupAssignee(f.d,reverse,{consumerKey:'reverse',eligibleIds:[2,3]}),2);
  assert.equal(chooseGroupAssignee(f.d,{...config,start_mode:'random'},{consumerKey:'sample',eligibleIds:[2,3]}),
    chooseGroupAssignee(f.d,{...config,start_mode:'random'},{consumerKey:'sample',eligibleIds:[2,3]}));
  const random={group_id:g.id,start_mode:'random'};
  const first=chooseGroupAssignee(f.d,random,{consumerKey:'random',eligibleIds:[2,3]});
  assert.ok([2,3].includes(first));
  assert.equal(chooseGroupAssignee(f.d,random,{consumerKey:'random',eligibleIds:[2,3]}),first);
  assert.throws(()=>chooseGroupAssignee(f.d,config,{consumerKey:'none',eligibleIds:[]}),/qualified and present/);
});

test('later Group membership order changes affect the next independent turn only',async t=>{
  const f=await scoringFixture(t);
  const g=saveRotationGroup(f.d,{name:'Ordered group',member_ids:[2,3,1]},{actorId:1});
  const config={group_id:g.id,start_mode:'first'};
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'ordered',eligibleIds:[1,2,3],commit:true}),2);
  const changed=saveRotationGroup(f.d,{name:'Ordered group',member_ids:[2,1,3]},
    {id:g.id,actorId:1,expectedRevision:g.revision});
  assert.equal(changed.id,g.id);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'ordered',eligibleIds:[1,2,3]}),1);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'ordered',eligibleIds:[1,2,3],commit:true}),1);
});

test('private Task Group use blocks a manager without Task visibility from changing shared member order',async t=>{
  const f=await scoringFixture(t),g=group(f.d,'Private use group');
  const created=await f.create({title:'Private Group work',visibility:'private',due_date:'2026-11-01',
    assignment_group:{group_id:g.id,start_mode:'first'},assigned_to:[]});
  assert.equal(created.status,201,JSON.stringify(created));
  replaceSubjectPermissions(f.d,'user',3,{capabilities:{'rotations.manage':'allow','rotations.view':'allow',
    'tasks.view_own':'allow','tasks.view_household':'none'}});
  assert.throws(()=>saveRotationGroupUsage(f.d,{name:g.name,member_ids:[3,2],usage_mode:'independent'},
    {id:g.id,actorId:3,expectedRevision:g.revision}),error=>error.status===403);
  assert.equal(saveRotationGroupUsage(f.d,{name:g.name,member_ids:[3,2],usage_mode:'independent'},
    {id:g.id,actorId:1,expectedRevision:g.revision}).members[0].id,3);
});

test('a Task Group choice creates a concrete assignment and an immutable decision',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'first',direction:'first_to_last'};
  const created=await f.create({due_date:'2026-11-01',assignment_group:config,assigned_to:[]});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id;
  assert.equal(f.row(id).assigned_to,2);
  assert.deepEqual(JSON.parse(f.row(id).assignment_group_json),config);
  assert.equal(f.d.prepare('SELECT selected_user_id FROM task_group_assignment_decisions WHERE task_id=?').get(id).selected_user_id,2);
  const edited=await f.edit(id,{title:'Still assigned',assignment_group:config,assigned_to:[]});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.equal(f.row(id).assigned_to,2);
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id=?').get(id).n,1);
  const changed=await f.edit(id,{assignment_group:{...config,start_mode:'random'},assigned_to:[]});
  assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id=?').get(id).n,2);
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id=? AND superseded_at IS NULL').get(id).n,1);
});

test('editing one independent Group assignment leaves another Activity and its cursor untouched',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'first',direction:'first_to_last'};
  const a=await f.create({title:'First activity',due_date:'2026-11-01',assignment_group:config,assigned_to:[]});
  const b=await f.create({title:'Second activity',due_date:'2026-11-01',assignment_group:config,assigned_to:[]});
  assert.equal(a.status,201,JSON.stringify(a));assert.equal(b.status,201,JSON.stringify(b));
  const before=f.row(b.data.id),decisions=f.d.prepare('SELECT * FROM task_group_assignment_decisions WHERE task_id=?').all(b.data.id);
  const cursor=f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE ?").all(`group-assignment:task:${b.data.id}:%`);
  const changed=await f.edit(a.data.id,{assignment_group:{...config,direction:'last_to_first'},assigned_to:[]});
  assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(f.row(b.data.id).assigned_to,before.assigned_to);
  assert.equal(f.row(b.data.id).assignment_group_json,before.assignment_group_json);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_group_assignment_decisions WHERE task_id=?').all(b.data.id),decisions);
  assert.deepEqual(f.d.prepare("SELECT * FROM assignment_rotation_state WHERE rotation_key LIKE ?").all(`group-assignment:task:${b.data.id}:%`),cursor);
});

test('template root and checklist Group defaults materialize separately and preserve reusable definitions',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config=JSON.stringify({group_id:g.id,start_mode:'first',direction:'first_to_last'});
  const template=Number(f.d.prepare(`INSERT INTO activity_templates(name,title_template,category,assignment_strategy,assignment_policy,
    subject_required,presence_policy,created_by,points,assignment_group_json)
    VALUES('Group template','Group work','misc','eligible_round_robin','group_rotation',0,'ignore',1,0,?)`).run(config).lastInsertRowid);
  f.d.prepare('INSERT INTO activity_template_checklist_items(activity_template_id,title_template,sort_order,is_optional,points,assignment_group_json) VALUES(?,?,0,0,0,?)')
    .run(template,'Group subtask',config);
  const created=await f.create({activity_template_id:template,due_date:'2026-11-01'});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,child=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND activity_template_checklist_item_id IS NOT NULL').get(id);
  assert.equal(f.row(id).assigned_to,2);
  assert.ok(child);assert.equal(child.assigned_to,2);
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id IN (?,?)').get(id,child.id).n,2);
  assert.equal(f.d.prepare('SELECT assignment_group_json FROM activity_templates WHERE id=?').get(template).assignment_group_json,config);
  const edited=await f.edit(id,{title:'Group work edited',activity_template_id:template});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.equal(f.row(id).assignment_group_json,config);
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id=? AND superseded_at IS NULL').get(id).n,1);
});

test('manual subtask Group choice saves a concrete qualified assignee',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'random',direction:'first_to_last'};
  const created=await f.create({due_date:'2026-11-01',subtasks:[{title:'Group action',points:0,assignment_group:config,assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').get(created.data.id);
  assert.ok([2,3].includes(child.assigned_to));
  assert.deepEqual(JSON.parse(child.assignment_group_json),config);
  assert.equal(f.d.prepare('SELECT selected_user_id FROM task_group_assignment_decisions WHERE task_id=?').get(child.id).selected_user_id,child.assigned_to);
  const edited=await f.edit(created.data.id,{subtasks:[{id:child.id,title:'Group action updated',points:0,
    assignment_group:{...config,direction:'last_to_first'},assigned_user_ids:[],skill_ids:[]}]});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.deepEqual(JSON.parse(f.row(child.id).assignment_group_json),{...config,direction:'last_to_first'});
});

test('a saved Group survives unrelated edits when its viewer permission and active state change',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'first',direction:'first_to_last'};
  const created=await f.create({due_date:'2026-11-01',assignment_group:config,assigned_to:[],
    subtasks:[{title:'Group action',points:0,assignment_group:config,assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const id=created.data.id,child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(id).id;
  f.d.prepare('UPDATE rotation_groups SET active=0 WHERE id=?').run(g.id);
  const edited=await f.edit(id,{title:'Still saved',assignment_group:config,assigned_to:[],
    subtasks:[{id:child,title:'Still action',points:0,assignment_group:config,assigned_user_ids:[],skill_ids:[]}]});
  assert.equal(edited.status,200,JSON.stringify(edited));
  assert.deepEqual(JSON.parse(f.row(id).assignment_group_json),config);
  assert.deepEqual(JSON.parse(f.row(child).assignment_group_json),config);
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','none')").run();
  const memberEdit=await f.edit(id,{title:'Member note',assignment_group:config,assigned_to:[]},2);
  assert.equal(memberEdit.status,200,JSON.stringify(memberEdit));
  assert.deepEqual(JSON.parse(f.row(id).assignment_group_json),config);
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','allow'),('user','2','tasks.change_assignment','allow'),('user','2','tasks.reassign','none')").run();
  const denied=await f.edit(id,{assignment_group:{...config,start_mode:'random'},assigned_to:[]},2);
  assert.equal(denied.status,403,'changing automatic assignment needs reassign authority');
  assert.deepEqual(JSON.parse(f.row(id).assignment_group_json),config);
  const newcomer=await f.create({assignment_group:config,assigned_to:[]});
  assert.equal(newcomer.status,400,'inactive Groups cannot be newly attached');
});

test('recurrence resolves the next Group member for root and subtask from captured choices',async t=>{
  const f=await scoringFixture(t),g=group(f.d);
  const config={group_id:g.id,start_mode:'first',direction:'first_to_last'};
  const created=await f.create({start_date:'2026-11-01',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',
    assignment_group:config,assigned_to:[],subtasks:[{title:'Action',points:0,assignment_group:config,assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const source=created.data.id,firstChild=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').get(source);
  assert.equal(f.row(source).assigned_to,2);assert.equal(firstChild.assigned_to,2);
  const finished=await f.finish(source);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(source);
  assert.ok(next);assert.equal(next.assigned_to,3);
  const nextChild=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').get(next.id);
  assert.equal(nextChild.assigned_to,3);
  assert.equal(f.d.prepare('SELECT count(*) n FROM task_group_assignment_decisions WHERE task_id IN (?,?)').get(next.id,nextChild.id).n,2);
});

test('shared scheduled Group supplies its Group-owned order without advancing an independent cursor',async t=>{
  const f=await scoringFixture(t);
  const shared=saveRotationGroupUsage(f.d,{name:'Shared synthetic',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',start_mode:'first',effective_date:'2026-11-01',weekdays:[0,1,2,3,4,5,6],
      active_time:'10:00',finalize_time:'23:00',finalize_day_offset:0,eligibility:{}}},{actorId:1,now:new Date('2026-11-01T12:00:00Z')});
  const config={group_id:shared.id,start_mode:'random'};
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'one',eligibleIds:[2,3],dateKey:'2026-11-01',commit:true}),2);
  assert.equal(chooseGroupAssignee(f.d,config,{consumerKey:'two',eligibleIds:[3],dateKey:'2026-11-01',commit:true}),3);
  assert.equal(f.d.prepare("SELECT count(*) n FROM assignment_rotation_state WHERE rotation_key LIKE 'group-assignment:%'").get().n,0);
});
