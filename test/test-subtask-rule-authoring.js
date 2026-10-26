import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {saveRotationGroupUsage} from '../server/services/rotation-shared.js';
import {replaceSubjectPermissions} from '../server/permissions.js';
import {saveTaskSubtaskRule,saveTemplateSubtaskRule} from '../server/services/subtask-assignment-rules.js';
import {captureActivityTemplateDefinition} from '../server/services/task-activity-snapshot.js';
import {materializeActivityChecklist} from '../server/services/activity-template-checklist.js';
import {captureSeriesDefinition,appendSeriesDefinition,taskSeriesState,seriesDefinitionForGeneration} from '../server/services/task-series.js';
import {resolveSubtaskOccurrence} from '../server/services/subtask-occurrence-resolution.js';

test('Task subtask rule authoring checks access, revision and current occurrence receipts',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Rule people',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Rule activity',subtasks:[{title:'Rule action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').get(created.data.id);
  const rule={kind:'group',group_id:group.id,mode:'random',start_mode:'first'};
  replaceSubjectPermissions(f.d,'user',3,{capabilities:{'tasks.change_assignment':'none'}});
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:child.id,source:rule,actorId:3,expectedRevision:child.revision}),
    error=>error.status===403);
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:child.id,
    source:{kind:'group',group_id:group.id,mode:'global'},actorId:1,expectedRevision:child.revision}),
    error=>error.status===400);
  const saved=saveTaskSubtaskRule(f.d,{taskId:child.id,source:rule,actorId:1,expectedRevision:child.revision});
  assert.equal(saved.source.kind,'group');
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id),[]);
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:child.id,source:rule,actorId:1,expectedRevision:child.revision}),
    error=>error.status===409);
  f.d.prepare('INSERT INTO task_subtask_resolution_runs(root_task_id,idempotency_key,input_hash,receipt_json) VALUES(?,?,?,?)')
    .run(created.data.id,'existing','hash',JSON.stringify({decisions:[]}));
  f.d.prepare(`INSERT INTO task_subtask_resolution_decisions(task_id,root_task_id,source_json,selected_user_ids_json,state,input_hash)
    VALUES(?,?,?,'[2]','assigned','hash')`).run(child.id,created.data.id,JSON.stringify(rule));
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:child.id,source:rule,actorId:1,
    expectedRevision:f.row(child.id).revision}),error=>error.status===409);
});

test('Template subtask rules snapshot into new instances without assigning their candidate pool',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Template people',member_ids:[2,3]},{actorId:1});
  const template=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,created_by) VALUES('Rule template','Rule template',1)")
    .run().lastInsertRowid);
  const item=Number(f.d.prepare(`INSERT INTO activity_template_checklist_items
    (activity_template_id,title_template,fixed_user_id) VALUES(?,'Template action',2)`).run(template).lastInsertRowid);
  const rule={kind:'group',group_id:group.id,mode:'smart'};
  assert.throws(()=>saveTemplateSubtaskRule(f.d,{checklistItemId:item,source:rule,actorId:3}),
    error=>error.status===403);
  saveTemplateSubtaskRule(f.d,{checklistItemId:item,source:rule,
    supervisorPool:{kind:'person',user_id:1},actorId:1});
  saveTemplateSubtaskRule(f.d,{checklistItemId:item,source:rule,actorId:1});
  const snapshot=captureActivityTemplateDefinition(f.d,template);
  assert.equal(snapshot.checklist[0].fixed_user_id,null);
  assert.deepEqual(JSON.parse(snapshot.checklist[0].assignment_rule_json).mode,'smart');
  const root=await f.create({title:'Instance root',due_date:'2026-11-01'});
  assert.equal(root.status,201,JSON.stringify(root));
  const [child]=materializeActivityChecklist(f.d,{activity:{id:template,name:'Rule template'},parentTaskId:root.data.id});
  assert.ok(child);
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child).source_json).mode,'smart');
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT supervisor_pool_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child).supervisor_pool_json),
    {kind:'person',user_id:1});
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child),[]);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(root.data.id),[]);
});

test('future recurrence copies a saved rule without changing the current occurrence',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Series people',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Rule series',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY',
    subtasks:[{title:'Series action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=f.d.prepare('SELECT * FROM tasks WHERE parent_task_id=?').get(root);
  const source={kind:'group',group_id:group.id,mode:'synced'};
  const authored=saveTaskSubtaskRule(f.d,{taskId:child.id,source,actorId:1,expectedRevision:child.revision}).source;
  const resolved=resolveSubtaskOccurrence(f.d,{rootTaskId:root,idempotencyKey:'series-source',actorId:1});
  assert.deepEqual(resolved.conflicts,[]);
  const historical=f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id).map(row=>row.user_id);
  assert.equal(historical.length,1);
  const state=taskSeriesState(f.d,root);
  const future=captureSeriesDefinition(f.d,root);
  assert.deepEqual(future.subtasks[0].assignment_rule,authored);
  assert.deepEqual(future.subtasks[0].assigned_user_ids,[],'one resolved person is not the next occurrence policy');
  assert.deepEqual(future.subtasks[0].authorization.assigned_user_ids,[]);
  appendSeriesDefinition(f.d,root,{expectedRevision:state.revision,actorId:1,definition:future,effectiveGeneration:1});
  const finished=await f.finish(root);
  assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);
  assert.ok(next);
  const nextChild=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(next.id);
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(nextChild.id).source_json),authored);
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child.id).source_json),authored);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id).map(row=>row.user_id),historical);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(nextChild.id),[{user_id:3}]);
});

test('new subtask sources use the selected pool while an existing source survives pool edits',async t=>{
  const f=await scoringFixture(t);
  const selected=saveRotationGroup(f.d,{name:'Selected source',member_ids:[2]},{actorId:1});
  const other=saveRotationGroup(f.d,{name:'Unselected source',member_ids:[3]},{actorId:1});
  const root=await f.create({title:'Pool constrained',subtask_candidate_pool:{person_ids:[3],group_ids:[selected.id]},
    subtasks:[{title:'Pool action',assigned_user_ids:[]}]});
  assert.equal(root.status,201,JSON.stringify(root));
  const child=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=?').get(root.data.id);
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:child.id,
    source:{kind:'group',group_id:other.id,mode:'random'},actorId:1,expectedRevision:child.revision}),
    error=>error.status===400);
  saveTaskSubtaskRule(f.d,{taskId:child.id,source:{kind:'fixed',user_ids:[3]},actorId:1,
    expectedRevision:child.revision});
  saveTaskSubtaskRule(f.d,{taskId:child.id,
    source:{kind:'group',group_id:selected.id,mode:'random'},actorId:1,
    expectedRevision:f.row(child.id).revision});
  f.d.prepare('UPDATE tasks SET subtask_candidate_pool_json=? WHERE id=?')
    .run(JSON.stringify({person_ids:[],group_ids:[other.id]}),root.data.id);
  saveTaskSubtaskRule(f.d,{taskId:child.id,
    source:{kind:'group',group_id:selected.id,mode:'random'},actorId:1,
    expectedRevision:f.row(child.id).revision});
  assert.equal(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child.id).source_json).group_id,selected.id);
});

test('an unresolved occurrence rule can be corrected without changing already assigned work',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Recovery rule',due_date:'2026-11-01',subtasks:[
    {title:'Stable',assigned_user_ids:[3]}, {title:'Blocked',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const [stable,blocked]=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=? ORDER BY id').all(created.data.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Rule correction',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'normal')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(blocked.id,skill);
  saveTaskSubtaskRule(f.d,{taskId:blocked.id,source:{kind:'fixed',user_ids:[2]},actorId:1,
    expectedRevision:f.row(blocked.id).revision});
  const first=resolveSubtaskOccurrence(f.d,{rootTaskId:created.data.id,idempotencyKey:'rule-before',actorId:1});
  assert.equal(first.conflicts.length,1);
  assert.throws(()=>saveTaskSubtaskRule(f.d,{taskId:blocked.id,source:null,actorId:1,
    expectedRevision:f.row(blocked.id).revision}),error=>error.status===409);
  saveTaskSubtaskRule(f.d,{taskId:blocked.id,source:{kind:'fixed',user_ids:[3]},actorId:1,
    expectedRevision:f.row(blocked.id).revision});
  const recovered=resolveSubtaskOccurrence(f.d,{rootTaskId:created.data.id,idempotencyKey:'rule-after',actorId:1});
  assert.deepEqual(recovered.conflicts,[]);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(stable.id).map(row=>row.user_id),[3]);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(blocked.id).map(row=>row.user_id),[3]);
  assert.deepEqual(resolveSubtaskOccurrence(f.d,{rootTaskId:created.data.id,idempotencyKey:'rule-before',actorId:1}),first);
});

test('a manual assignment after an unresolved receipt closes its stale decision without reassignment',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Manual recovery',due_date:'2026-11-01',
    subtasks:[{title:'Blocked action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=?').get(created.data.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Manual recovery skill',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(3,?,'normal')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child.id,skill);
  saveTaskSubtaskRule(f.d,{taskId:child.id,source:{kind:'fixed',user_ids:[2]},actorId:1,
    expectedRevision:f.row(child.id).revision});
  const first=resolveSubtaskOccurrence(f.d,{rootTaskId:created.data.id,idempotencyKey:'manual-before',actorId:1});
  assert.equal(first.conflicts.length,1);
  f.d.prepare('UPDATE tasks SET assigned_to=3 WHERE id=?').run(child.id);
  f.d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,3)').run(child.id);
  const next=resolveSubtaskOccurrence(f.d,{rootTaskId:created.data.id,idempotencyKey:'manual-after',actorId:1});
  assert.deepEqual(next.conflicts,[]);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(child.id).map(row=>row.user_id),[3]);
  const decision=f.d.prepare('SELECT state,selected_user_ids_json FROM task_subtask_resolution_decisions WHERE task_id=?').get(child.id);
  assert.equal(decision.state,'preserved');assert.deepEqual(JSON.parse(decision.selected_user_ids_json),[3]);
});

test('an unresolved decision cannot be silently adopted by a different Activity',async t=>{
  const f=await scoringFixture(t);
  const first=await f.create({title:'First root',subtasks:[{title:'Blocked action',assigned_user_ids:[]}]});
  const second=await f.create({title:'Second root'});
  assert.equal(first.status,201);assert.equal(second.status,201);
  const child=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=?').get(first.data.id);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,created_by) VALUES('Move guard',0,1)").run().lastInsertRowid);
  f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency) VALUES(2,?,'excluded')").run(skill);
  f.d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES(?,?,0)').run(child.id,skill);
  saveTaskSubtaskRule(f.d,{taskId:child.id,source:{kind:'fixed',user_ids:[2]},actorId:1,
    expectedRevision:f.row(child.id).revision});
  assert.equal(resolveSubtaskOccurrence(f.d,{rootTaskId:first.data.id,idempotencyKey:'first-root',actorId:1}).conflicts.length,1);
  f.d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(second.data.id,child.id);
  assert.throws(()=>resolveSubtaskOccurrence(f.d,{rootTaskId:second.data.id,idempotencyKey:'second-root',actorId:1}),
    error=>error.status===409);
  assert.equal(f.d.prepare('SELECT root_task_id FROM task_subtask_resolution_decisions WHERE task_id=?').get(child.id).root_task_id,first.data.id);
});

test('a sparse future Person edit replaces a saved Group rule while a full-form edit preserves it',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Future source',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Future choice',due_date:'2026-11-01',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=?').get(created.data.id);
  saveTaskSubtaskRule(f.d,{taskId:child.id,source:{kind:'group',group_id:group.id,mode:'random'},actorId:1,
    expectedRevision:child.revision});
  const incidental=await f.edit(created.data.id,{edit_scope:'future',subtasks:[{id:child.id,title:'Action renamed',
    is_optional:false,skill_ids:[],assigned_user_ids:[3]}]});
  assert.equal(incidental.status,200,JSON.stringify(incidental));
  const state=taskSeriesState(f.d,created.data.id);
  const nextGeneration=state.occurrence.generation+1;
  const before=seriesDefinitionForGeneration(f.d,state.series_id,nextGeneration).data.subtasks[0];
  assert.equal(before.assignment_rule?.mode,'random');
  assert.deepEqual(before.assigned_user_ids,[]);
  const edited=await f.edit(created.data.id,{edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:before.action_key,fields:{assigned_user_ids:[3]}}]}}});
  assert.equal(edited.status,200,JSON.stringify(edited));
  const saved=seriesDefinitionForGeneration(f.d,state.series_id,nextGeneration).data.subtasks[0];
  assert.equal(saved.assignment_rule,undefined);
  assert.deepEqual(saved.assigned_user_ids,[3]);
  const finished=await f.finish(created.data.id);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(created.data.id);
  assert.ok(next);
  const nextChild=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(next.id);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(nextChild.id).map(row=>row.user_id),[3]);
  assert.equal(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(nextChild.id),undefined);
});

test('future-only rule authoring keeps the current occurrence and resolves from the saved next definition',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Future-only pool',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Future-only rule',due_date:'2026-11-01',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,child=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root);
  const state=taskSeriesState(f.d,root),key=state.definition.data.subtasks[0].action_key;
  const source={kind:'group',group_id:group.id,mode:'smart'};
  const edit=await f.edit(root,{edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:key,fields:{assignment_rule:source}}]}}});
  assert.equal(edit.status,200,JSON.stringify(edit));
  assert.equal(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child.id),undefined);
  const nextDefinition=seriesDefinitionForGeneration(f.d,state.series_id,state.occurrence.generation+1).data.subtasks[0];
  assert.equal(nextDefinition.assignment_rule?.mode,'smart');
  assert.deepEqual(nextDefinition.assigned_user_ids,[]);
  const finished=await f.finish(root);assert.equal(finished.status,200,JSON.stringify(finished));
  const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);
  assert.ok(next);
  const nextChild=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(next.id);
  assert.equal(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(nextChild.id).source_json).mode,'smart');
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(nextChild.id),[{user_id:2}]);
});

test('future-only rule edits reconcile a pristine successor and reject stale series revisions',async t=>{
  const f=await scoringFixture(t);
  const created=await f.create({title:'Pristine successor',due_date:'2026-11-01',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Action',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const root=created.data.id,firstChild=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root).id;
  const firstState=taskSeriesState(f.d,root),key=firstState.definition.data.subtasks[0].action_key;
  const done=await f.finish(root);assert.equal(done.status,200,JSON.stringify(done));
  const successor=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(root);
  assert.ok(successor);
  const nextChild=f.d.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(successor.id).id;
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(nextChild).map(row=>row.user_id),[2]);
  const saved=await f.edit(root,{edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:key,fields:{assignment_rule:{kind:'fixed',user_ids:[3]}}}]}}});
  assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(firstChild),undefined);
  assert.deepEqual(JSON.parse(f.d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(nextChild).source_json),
    {kind:'fixed',user_ids:[3]});
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(nextChild),[{user_id:3}]);
  const again=await f.edit(root,{edit_scope:'future_only',expected_series_revision:firstState.revision,
    future_patch:{actions:{update:[{action_key:key,fields:{assignment_rule:{kind:'fixed',user_ids:[2]}}}]}}});
  assert.equal(again.status,409,JSON.stringify(again));
});

test('future-only Group mode checks the next occurrence date across a shared-usage boundary',async t=>{
  const f=await scoringFixture(t);
  const shared=saveRotationGroupUsage(f.d,{name:'Future rule boundary',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',start_mode:'first',effective_date:'2026-11-03',weekdays:[0,1,2,3,4,5,6],
      active_time:'10:00',finalize_time:'23:00',finalize_day_offset:0,eligibility:{}}},
    {actorId:1,now:new Date('2026-11-01T12:00:00Z')});
  const created=await f.create({title:'Mode boundary',due_date:'2026-11-02',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Rule',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const state=taskSeriesState(f.d,created.data.id),key=state.definition.data.subtasks[0].action_key;
  const patch=mode=>({edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:key,fields:{assignment_rule:{kind:'group',group_id:shared.id,mode}}}]}}});
  const denied=await f.edit(created.data.id,patch('smart'));
  assert.equal(denied.status,400,JSON.stringify(denied));
  const allowed=await f.edit(created.data.id,patch('global'));
  assert.equal(allowed.status,200,JSON.stringify(allowed));
  assert.equal(seriesDefinitionForGeneration(f.d,state.series_id,state.occurrence.generation+1).data.subtasks[0].assignment_rule.mode,'global');
});

test('future Group mode uses the shifted child date rather than the parent date',async t=>{
  const f=await scoringFixture(t);
  const shared=saveRotationGroupUsage(f.d,{name:'Child boundary',member_ids:[2,3],usage_mode:'shared',
    shared_config:{strategy:'rotating_order',start_mode:'first',effective_date:'2026-11-03',weekdays:[0,1,2,3,4,5,6],
      active_time:'10:00',finalize_time:'23:00',finalize_day_offset:0,eligibility:{}}},
    {actorId:1,now:new Date('2026-11-01T12:00:00Z')});
  const created=await f.create({title:'Child crosses boundary',due_date:'2026-11-01',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Later step',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const state=taskSeriesState(f.d,created.data.id),key=state.definition.data.subtasks[0].action_key;
  const patch=mode=>({edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:key,fields:{due_date:'2026-11-02',assignment_rule:{kind:'group',group_id:shared.id,mode}}}]}}});
  const denied=await f.edit(created.data.id,patch('smart'));
  assert.equal(denied.status,400,JSON.stringify(denied));
  const allowed=await f.edit(created.data.id,patch('global'));
  assert.equal(allowed.status,200,JSON.stringify(allowed));
});

test('an unchanged completion-relative Group rule does not block a future title edit',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Completion Group',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Completion relative',due_date:'2026-11-01',is_recurring:1,
    recurrence_from_completion:1,recurrence_rule:'FREQ=DAILY',subtasks:[{title:'Action',assigned_user_ids:[]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const child=f.d.prepare('SELECT id,revision FROM tasks WHERE parent_task_id=?').get(created.data.id);
  saveTaskSubtaskRule(f.d,{taskId:child.id,source:{kind:'group',group_id:group.id,mode:'random'},
    actorId:1,expectedRevision:child.revision});
  const state=taskSeriesState(f.d,created.data.id),next=captureSeriesDefinition(f.d,created.data.id);
  appendSeriesDefinition(f.d,created.data.id,{expectedRevision:state.revision,actorId:1,
    definition:next,effectiveGeneration:state.occurrence.generation+1});
  const edit=await f.edit(created.data.id,{edit_scope:'future_only',future_patch:{fields:{title:'Later title'}}});
  assert.equal(edit.status,200,JSON.stringify(edit));
});

test('future rule authoring checks Group visibility before revealing Group validity',async t=>{
  const f=await scoringFixture(t),group=saveRotationGroup(f.d,{name:'Private future pool',member_ids:[2,3]},{actorId:1});
  const created=await f.create({title:'Future privacy',due_date:'2026-11-01',is_recurring:1,
    recurrence_rule:'FREQ=DAILY',assigned_to:2,subtasks:[{title:'Step',assigned_user_ids:[2]}]});
  assert.equal(created.status,201,JSON.stringify(created));
  const key=taskSeriesState(f.d,created.data.id).definition.data.subtasks[0].action_key;
  for(const key of ['edit','edit_series','change_assignment','reassign'])f.grant(key,'allow');
  f.d.prepare("INSERT OR REPLACE INTO access_capabilities(subject_type,subject_id,capability_key,access) VALUES('user','2','rotations.view','none')").run();
  const request=groupId=>({edit_scope:'future_only',future_patch:{actions:{update:[
    {action_key:key,fields:{assignment_rule:{kind:'group',group_id:groupId,mode:'smart'}}}]}}});
  const before=f.snapshot();
  const valid=await f.edit(created.data.id,request(group.id),2);
  const invalid=await f.edit(created.data.id,request(999999),2);
  assert.equal(valid.status,403,JSON.stringify(valid));
  assert.equal(invalid.status,403,JSON.stringify(invalid));
  assert.equal(valid.error,invalid.error);
  assert.equal(f.snapshot(),before);
});
