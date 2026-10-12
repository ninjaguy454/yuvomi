import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {taskSeriesState,seriesDefinitionForGeneration}=await import('../server/services/task-series.js');

const recurring={assigned_to:[2],due_date:'2026-11-01',is_recurring:true,recurrence_rule:'FREQ=DAILY'};
const future={edit_scope:'future_only',future_patch:{}};
const pending=(f,id)=>{
  const state=taskSeriesState(f.d,id);
  return seriesDefinitionForGeneration(f.d,state.series_id,state.occurrence.generation+1).data;
};
const successor=(f,id)=>f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(id);
const rotationState=f=>({activity:f.d.prepare('SELECT * FROM activity_rotation_state ORDER BY activity_template_id,purpose').all(),
  assignment:f.d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all()});
async function purePreview(f,id,body=future,actor=1){
  const snapshot=f.snapshot(),changes=f.changes(),input=structuredClone(body);
  const response=await f.preview(id,body,actor);
  assert.equal(f.snapshot(),snapshot,'all schema/table/sequence data is unchanged');
  assert.equal(f.changes(),changes,'preview performs no writes, including rollback writes');
  assert.deepEqual(body,input);
  return response;
}
function unitTotals(units){
  const totals=new Map();
  for(const unit of units)for(const member of unit.recipients)if(member.points>0)totals.set(member.user_id,(totals.get(member.user_id)||0)+member.points);
  return [...totals].sort(([a],[b])=>a-b).map(([user_id,points])=>({user_id,points}));
}
async function boundFixture(t,{policy='fixed',secondHelper=false}={}){
  const f=await scoringFixture(t);
  if(secondHelper){
    f.d.prepare("INSERT INTO users(id,username,display_name,password_hash,role,family_role) VALUES(4,'helper4','Helper Four','x','member','other')").run();
    f.d.prepare('INSERT INTO reward_participants(user_id,enabled) VALUES(4,1)').run();
  }
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Delegated future appliance',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'normal'],...(secondHelper?[[4,'excluded']]:[])])
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
  const activity=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Bound future routine','Bound future routine',?,?,2,0,'ignore',1)").run(policy==='eligible_random'?'fixed':policy,policy).lastInsertRowid);
  if(policy==='eligible_round_robin'){
    const rootSkill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Root future qualification',0,'normal',1)").run().lastInsertRowid);
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(1,?,'excluded','manual',1)").run(rootSkill);
    f.d.prepare('INSERT INTO activity_template_skills(activity_template_id,skill_id) VALUES(?,?)').run(activity,rootSkill);
  }
  const {assigned_to,...boundRecurring}=recurring;
  const created=await f.create({...boundRecurring,activity_template_id:activity,scoring_mode:'subtasks',subtasks:[{title:'Appliance work',skill_ids:[skill],points:5}]});
  assert.equal(created.status,201,JSON.stringify(created));
  return {f,skill,root:created.data.id};
}

for(const mode of ['whole_task','subtasks'])test(`fresh ${mode} future forecast matches actual next manual rotation`,async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3],scoring_mode:mode,
    ...(mode==='whole_task'?{points:5}:{subtasks:[{title:'Inherited work',points:5}]})});
  assert.equal(created.status,201);const id=created.data.id;
  assert.deepEqual((await purePreview(f,id,{})).data.after,[{user_id:2,points:5}]);
  const p=await purePreview(f,id);
  assert.equal(p.status,200);assert.equal(p.data.valid,true);assert.deepEqual(p.data.after,[{user_id:3,points:5}]);
  assert.deepEqual(unitTotals(p.data.after_units),p.data.after);
  assert.equal(p.data.forecast_context.effective_generation,1);assert.equal(p.data.forecast_context.after.preparation,'fresh');
  assert.equal((await f.finish(id)).status,200);
  const next=successor(f,id),loaded=await f.call('GET','/tasks/'+next.id);
  assert.equal(next.assigned_to,3);assert.deepEqual(p.data.after,loaded.data.scoring.potential);
});

for(const fields of [
  {assignment_mode:'round_robin'},
  {assignment_mode:'round_robin',rotation_user_ids:[2]},
  {assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'invalid-slot',rotation_slot:2},
  {assignment_mode:'round_robin',rotation_user_ids:[2,999]},
  {assignment_mode:'round_robin',rotation_user_ids:[2,2]}
])test('effective sparse rotation configuration rejects atomically: '+JSON.stringify(fields),async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,points:5,scoring_mode:'whole_task'}),id=created.data.id;
  const body={edit_scope:'future_only',future_patch:{fields}},before=f.snapshot();
  assert.equal((await purePreview(f,id,body)).status,400);
  assert.equal((await f.edit(id,body)).status,400);assert.equal(f.snapshot(),before);
});

for(const subtasks of [
  [{client_key:'draft_1',title:'Explicit',points:2},{title:'Anonymous',points:3}],
  [{title:'Anonymous',points:3},{client_key:'draft_0',title:'Explicit',points:2}],
  [{client_key:'draft_2',title:'Reserved',points:1},{client_key:'draft_2_1',title:'Reserved suffix',points:1},{title:'Anonymous',points:3}]
])test('compatible historical draft keys stay unique across explicit and automatic namespaces: '+subtasks.map(s=>s.client_key??'anonymous').join(','),async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,scoring_mode:'subtasks'}),id=created.data.id;
  assert.equal((await f.finish(id)).status,200);
  const body={edit_scope:'future',subtasks},p=await purePreview(f,id,body);
  assert.equal(p.status,200);assert.equal(p.data.valid,true);assert.deepEqual(p.data.after,[{user_id:2,points:5}]);
  assert.equal(new Set(p.data.after_units.map(unit=>unit.ref.action_key)).size,subtasks.length);
  const saved=await f.edit(id,body);assert.equal(saved.status,200);
  assert.equal(new Set(saved.series_edit.created_actions.map(action=>action.client_key)).size,subtasks.length);
  assert.equal(new Set(saved.series_edit.created_actions.map(action=>action.action_key)).size,subtasks.length);
  for(const step of subtasks.filter(step=>step.client_key))assert.ok(saved.series_edit.created_actions.some(action=>action.client_key===step.client_key));
});

test('actual API fixed bound delegated future forecasts helper and recomputes changed skills',async t=>{
  const {f,root}=await boundFixture(t),key=pending(f,root).subtasks[0].action_key;
  assert.deepEqual((await purePreview(f,root,{})).data.after,[{user_id:3,points:5}]);
  const p=await purePreview(f,root);
  assert.equal(p.status,200);assert.equal(p.data.valid,true);assert.deepEqual(p.data.after,[{user_id:3,points:5}]);
  assert.deepEqual(unitTotals(p.data.after_units),p.data.after);assert.equal(p.data.after_units[0].ref.action_key,key);
  const changed=await purePreview(f,root,{edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{skill_ids:[]}}]}}});
  assert.deepEqual(changed.data.before,[{user_id:3,points:5}]);assert.deepEqual(changed.data.after,[{user_id:2,points:5}]);
  const done=await f.call('PATCH',`/tasks/${root}/status`,{status:'done',complete_remaining:true},3);assert.equal(done.status,200);
  const next=successor(f,root),loaded=await f.call('GET','/tasks/'+next.id);
  assert.equal(next.assigned_to,2);assert.deepEqual(loaded.data.scoring.potential,p.data.after);
});

test('demonstrated untouched manual target uses its own index without advancing twice',async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3],scoring_mode:'whole_task',points:5}),id=created.data.id;
  assert.equal((await f.finish(id)).status,200);const target=successor(f,id);
  assert.equal(target.assigned_to,3);
  const p=await purePreview(f,id);assert.equal(p.status,200);assert.deepEqual(p.data.after,[{user_id:3,points:5}]);
  assert.equal(p.data.forecast_context.after.preparation,'existing_untouched');
});

test('manual rotated operational recipient never overwrites assignees-only canonical read authority',async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,assignment_mode:'round_robin',rotation_user_ids:[2,3],visibility:'assignees',scoring_mode:'whole_task',points:5}),id=created.data.id;
  const p=await purePreview(f,id,future,2);
  assert.equal(p.status,200);assert.deepEqual(p.data.after,[{user_id:3,points:5}]);
  assert.equal((await purePreview(f,id,future,3)).status,404);
  assert.deepEqual(pending(f,id).authorization.assigned_user_ids,[2]);
});

test('bound existing target remaps its own helper rather than source mappings',async t=>{
  const {f,root}=await boundFixture(t,{secondHelper:true});
  const nextSkill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Next helper only',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'excluded'],[4,'normal']])
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,nextSkill,proficiency);
  const key=pending(f,root).subtasks[0].action_key;
  assert.equal((await f.edit(root,{edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{skill_ids:[nextSkill]}}]}}})).status,200);
  assert.equal((await f.call('PATCH',`/tasks/${root}/status`,{status:'done',complete_remaining:true},3)).status,200);
  const target=successor(f,root);
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE source_task_id=?').get(target.id).supervisor_user_id,4);
  const p=await purePreview(f,root);
  assert.equal(p.status,200);assert.deepEqual(p.data.after,[{user_id:4,points:5}]);
  assert.equal(p.data.forecast_context.after.preparation,'existing_untouched');
});

test('untouched bound rotation keeps actual target performer through preview and future reconciliation',async t=>{
  const {f,root}=await boundFixture(t,{policy:'eligible_round_robin'});
  const fresh=await purePreview(f,root);assert.equal(fresh.status,200);assert.deepEqual(fresh.data.after,[{user_id:3,points:5}]);
  assert.equal((await f.call('PATCH',`/tasks/${root}/status`,{status:'done',complete_remaining:true},3)).status,200);
  const target=successor(f,root);assert.equal(target.assigned_to,3);
  const binding=f.d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(target.id);
  const cursors=rotationState(f);
  const joins=f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(target.id);
  const key=pending(f,root).subtasks[0].action_key;
  const body={edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{points:6}}]}}};
  const p=await purePreview(f,root,body);
  assert.equal(p.status,200);assert.deepEqual(p.data.before,[{user_id:3,points:5}]);assert.deepEqual(p.data.after,[{user_id:3,points:6}]);
  assert.equal(p.data.forecast_context.after.preparation,'existing_untouched');
  assert.equal((await f.edit(root,body)).status,200);
  assert.equal(f.row(target.id).assigned_to,3,'future reconciliation retains the demonstrated target performer');
  assert.deepEqual((await f.call('GET','/tasks/'+target.id)).data.scoring.potential,p.data.after);
  assert.deepEqual(rotationState(f),cursors);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(target.id),binding);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(target.id),joins);
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('New target delegation',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'excluded'],[2,'normal'],[3,'excluded']])
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
  const changed={edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{skill_ids:[skill]}}]}}};
  const next=await purePreview(f,root,changed);assert.equal(next.status,200);assert.deepEqual(next.data.before,[{user_id:3,points:6}]);assert.deepEqual(next.data.after,[{user_id:2,points:6}]);
  const saved=await f.edit(root,changed);assert.equal(saved.status,200,JSON.stringify(saved));assert.ok(saved.series_edit.updated.includes(target.id));
  assert.equal(f.row(target.id).assigned_to,3);assert.deepEqual((await f.call('GET','/tasks/'+target.id)).data.scoring.potential,next.data.after);
  assert.equal(f.d.prepare('SELECT supervisor_user_id FROM task_supervision_actions WHERE source_task_id=?').get(target.id).supervisor_user_id,2);
  assert.deepEqual(rotationState(f),cursors);
  assert.deepEqual(f.d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(target.id),binding);
  assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(target.id),joins);
  const whole={edit_scope:'future_only',future_patch:{fields:{scoring_mode:'whole_task',points:7}}};
  const wholePreview=await purePreview(f,root,whole);assert.equal(wholePreview.status,200);assert.deepEqual(wholePreview.data.after,[{user_id:3,points:7}]);
  assert.equal((await f.edit(root,whole)).status,200);assert.equal(f.row(target.id).assigned_to,3);
  assert.deepEqual((await f.call('GET','/tasks/'+target.id)).data.scoring.potential,wholePreview.data.after);
  const rootSkill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('Explicit target root supervision',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'excluded'],[2,'normal'],[3,'excluded']])
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,rootSkill,proficiency);
  const rootChange={edit_scope:'future_only',future_patch:{fields:{skill_ids:[rootSkill]}}};
  const rootPreview=await purePreview(f,root,rootChange);assert.equal(rootPreview.status,200,JSON.stringify(rootPreview));assert.deepEqual(rootPreview.data.before,[{user_id:3,points:7}]);assert.deepEqual(rootPreview.data.after,[{user_id:2,points:7}]);
  assert.deepEqual(unitTotals(rootPreview.data.after_units),rootPreview.data.after);assert.deepEqual(rootPreview.data.forecast_context.conditions,['binding_assignment_reprepared']);
  assert.deepEqual(rootPreview.data.after_units.find(unit=>unit.ref.action_key==='root').recipients,[{user_id:2,points:7}]);
  const rootSave=await f.edit(root,rootChange);assert.equal(rootSave.status,200,JSON.stringify(rootSave));assert.ok(rootSave.series_edit.updated.includes(target.id));
  assert.equal(f.row(target.id).assigned_to,2);assert.deepEqual((await f.call('GET','/tasks/'+target.id)).data.scoring.potential,rootPreview.data.after);
  const expectedBinding={...binding,updated_at:f.d.prepare('SELECT updated_at FROM task_activity_bindings WHERE task_id=?').get(target.id).updated_at,definition_snapshot_json:JSON.stringify({...JSON.parse(binding.definition_snapshot_json),required_skill_ids:[rootSkill]})};
  assert.deepEqual(f.d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(target.id),expectedBinding);
  assert.deepEqual(f.d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id=?').all(target.id),[{skill_id:rootSkill}]);
  assert.deepEqual(rotationState(f),cursors);assert.deepEqual(f.d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(target.id),[{user_id:2}]);
});

test('complete hidden canonical scope constrains helpers and exposes only generic unresolved guidance',async t=>{
  const {f,root}=await boundFixture(t,{secondHelper:true});
  const skill=Number(f.d.prepare("INSERT INTO skills(name,minimum_age,age_promotion,created_by) VALUES('SECRET qualification',0,'normal',1)").run().lastInsertRowid);
  for(const [id,proficiency] of [[1,'excluded'],[2,'excluded'],[3,'excluded'],[4,'normal']])
    f.d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source,updated_by) VALUES(?,?,?,'manual',1)").run(id,skill,proficiency);
  const saved=await f.edit(root,{edit_scope:'future_only',future_patch:{actions:{add:[{client_key:'secret',fields:{title:'SECRET hidden work',points:0,visibility:'private',skill_ids:[skill]}}]}}});
  assert.equal(saved.status,200,JSON.stringify(saved));const hiddenKey=saved.series_edit.created_actions[0].action_key;
  const p=await purePreview(f,root,future,2);
  assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.data.valid,true);assert.deepEqual(p.data.after,[]);
  assert.equal(p.data.after_units.length,1);assert.deepEqual(p.data.warnings,[{reason:'prospective_supervision_unresolved',message:'The prospective occurrence requires supervision that is not currently resolved.'}]);
  assert.deepEqual(p.data.forecast_context.conditions,['prospective_supervision_unresolved']);
  assert.ok(!JSON.stringify(p).includes('SECRET'));assert.ok(!JSON.stringify(p).includes(hiddenKey));
});

test('bound runtime helper recipient does not become an assignees-only action read join',async t=>{
  const {f,root}=await boundFixture(t),key=pending(f,root).subtasks[0].action_key;
  assert.equal((await f.edit(root,{edit_scope:'future_only',future_patch:{actions:{update:[{action_key:key,fields:{visibility:'assignees',assigned_user_ids:[2]}}]}}})).status,200);
  const learner=await purePreview(f,root,future,2),helper=await purePreview(f,root,future,3);
  assert.equal(learner.status,200);assert.deepEqual(learner.data.after,[{user_id:3,points:5}]);
  assert.equal(helper.status,200);assert.deepEqual(helper.data.after,[]);assert.deepEqual(helper.data.after_units,[]);
  assert.ok(!JSON.stringify(helper).includes(key));assert.deepEqual(pending(f,root).subtasks[0].authorization.assigned_user_ids,[2]);
});

test('fresh completion-relative forecast describes its assumed completion and actual successor window',async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,due_date:'2026-10-31',recurrence_from_completion:true,points:5,scoring_mode:'whole_task'}),root=created.data.id;
  const p=await purePreview(f,root);
  assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.forecast_context.conditions,['completion_date_assumed']);
  assert.equal(p.data.forecast_context.as_of_date,'2026-11-01');assert.equal(p.data.forecast_context.after.due_date,'2026-11-02');
  assert.equal((await f.finish(root)).status,200);assert.equal(successor(f,root).due_date,p.data.forecast_context.after.due_date);
});

test('unresolved random future assignment returns generic unavailable guidance without a promised recipient',async t=>{
  const {f,root}=await boundFixture(t,{policy:'eligible_random'}),p=await purePreview(f,root);
  assert.equal(p.status,409);assert.equal(p.reason,'scoring_projection_unavailable');assert.deepEqual(p.conditions,['random_assignment_unresolved']);
  assert.equal(p.data,undefined);assert.ok(!JSON.stringify(p).includes('Appliance work'));
});

test('ended future recurrence returns unavailable instead of configured recipient promises',async t=>{
  const f=await scoringFixture(t),created=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  const p=await purePreview(f,created.data.id,{edit_scope:'future_only',future_patch:{fields:{is_recurring:false}}});
  assert.equal(p.status,409);assert.deepEqual(p.conditions,['recurrence_ended']);assert.equal(p.data,undefined);
});

test('effective current-inclusive group validation excludes the joined selected root',async t=>{
  const f=await scoringFixture(t),activity=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Detachable routine','Detachable routine','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const created=await f.create({...recurring,activity_template_id:activity,points:5,scoring_mode:'whole_task'});assert.equal(created.status,201);
  const saved=await f.edit(created.data.id,{edit_scope:'future',activity_template_id:null,assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'Selected root group',rotation_slot:0});
  assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(f.row(created.data.id).rotation_group,'Selected root group');
  const other=await f.create({...recurring,points:5,scoring_mode:'whole_task'});
  const body={edit_scope:'future_only',future_patch:{fields:{assignment_mode:'round_robin',rotation_user_ids:[2,3],rotation_group:'Selected root group',rotation_slot:0}}},snapshot=f.snapshot();
  const p=await purePreview(f,other.data.id,body);assert.equal(p.status,400);assert.match(p.error,/position is already used/);
  assert.equal((await f.edit(other.data.id,body)).status,400);assert.equal(f.snapshot(),snapshot);
});

test('changed authoritative binding identity still applies its new policy to an existing target',async t=>{
  const {f,root}=await boundFixture(t,{policy:'eligible_round_robin'});
  assert.equal((await f.call('PATCH',`/tasks/${root}/status`,{status:'done',complete_remaining:true},3)).status,200);
  const target=successor(f,root);assert.equal(target.assigned_to,3);const cursors=rotationState(f);
  const oldBinding=f.d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(target.id);
  const activity=Number(f.d.prepare("INSERT INTO activity_templates(name,title_template,assignment_strategy,assignment_policy,fixed_user_id,subject_required,presence_policy,created_by) VALUES('Changed fixed policy','Changed fixed policy','fixed','fixed',2,0,'ignore',1)").run().lastInsertRowid);
  const body={edit_scope:'future',activity_template_id:activity},p=await purePreview(f,root,body);
  assert.equal(p.status,409);assert.deepEqual(p.conditions,['binding_policy_changed']);
  const saved=await f.edit(root,body);assert.equal(saved.status,200,JSON.stringify(saved));assert.ok(saved.series_edit.updated.includes(target.id));
  assert.equal(f.row(target.id).assigned_to,2);assert.equal(f.d.prepare('SELECT activity_template_id FROM task_activity_bindings WHERE task_id=?').get(target.id).activity_template_id,activity);
  assert.notEqual(oldBinding.activity_template_id,activity);assert.deepEqual(rotationState(f),cursors);
  assert.deepEqual((await f.call('GET','/tasks/'+target.id)).data.scoring.potential,[{user_id:3,points:5}]);
});

test('explicit frozen root requirement intent enforces required-skill permission atomically',async t=>{
  const {f,root,skill}=await boundFixture(t);f.grant('change_required_skills','none');
  const snapshot=f.snapshot(),body={edit_scope:'future_only',future_patch:{fields:{skill_ids:[skill]}}};
  assert.equal((await purePreview(f,root,body,2)).status,403);assert.equal((await f.edit(root,body,2)).status,403);assert.equal(f.snapshot(),snapshot);
});
