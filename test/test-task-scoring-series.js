import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringFixture} from './helpers/task-scoring-route-fixture.js';
const {taskSeriesState,seriesDefinitionForGeneration,appendSeriesDefinition}=await import('../server/services/task-series.js');
const recurring={assigned_to:[2],start_date:'2026-11-01',due_date:'2026-11-01',is_recurring:1,recurrence_rule:'FREQ=DAILY'};
for(const relative of [0,1])for(const scope of ['occurrence','future','future_only'])test(`${relative?'completion-relative':'calendar'} ${scope} scoring changes inherit correct fresh policy`,async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',recurrence_from_completion:relative,subtasks:[{title:'Step',points:7}]});const before=f.row(r.data.id),body=scope==='future_only'?{future_patch:{fields:{scoring_mode:'subtasks'}}}:{scoring_mode:'subtasks'};
 const e=await f.edit(r.data.id,{edit_scope:scope,...body});assert.equal(e.status,200,JSON.stringify(e));assert.equal(f.row(r.data.id).scoring_mode,scope==='future_only'?'whole_task':'subtasks');if(scope==='future_only'){assert.deepEqual(f.row(r.data.id),before);assert.equal(e.series_edit.current_preserved,true);assert.equal(e.series_edit.scope,'future_only');}
 assert.equal(f.d.prepare('SELECT count(*) n FROM task_scoring_settlements').get().n,0);await f.finish(r.data.id);const next=f.d.prepare('SELECT * FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id);assert.ok(next);assert.equal(next.scoring_mode,scope==='occurrence'?'whole_task':'subtasks');assert.equal(f.d.prepare('SELECT count(*) n FROM task_scoring_settlements WHERE root_task_id=?').get(next.id).n,0);
});
test('future patch rebases on actual pending terms and preserves current exception and absent actions',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'A',points:2},{title:'B',points:6}]});await f.edit(r.data.id,{points:9});const s=taskSeriesState(f.d,r.data.id),definition=structuredClone(s.definition.data);definition.task.points=5;definition.subtasks.push({action_key:'series-action:pending',source_task_id:null,task:{...definition.subtasks[0].task,title:'Pending',points:11},assigned_user_ids:[3],skill_ids:[],tags:[]});f.d.transaction(()=>appendSeriesDefinition(f.d,r.data.id,{definition,effectiveGeneration:s.occurrence.generation+1,expectedRevision:s.revision,actorId:1})).immediate();
 const before=f.snapshot(),current=f.row(r.data.id),p=await f.preview(r.data.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:{fields:{scoring_mode:'subtasks'}}});assert.equal(p.status,200,JSON.stringify(p));assert.equal(f.snapshot(),before);assert.deepEqual(p.data.before,[{user_id:2,points:5},{user_id:3,points:5}]);assert.deepEqual(p.data.after,[{user_id:2,points:8},{user_id:3,points:19}]);assert.equal(p.data.edit_definition.fields.points,5);assert.ok(p.data.edit_definition.actions.some(a=>a.action_key==='series-action:pending'));
 const e=await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{scoring_mode:'subtasks'}}});assert.equal(e.status,200,JSON.stringify(e));assert.deepEqual(f.row(r.data.id),current);const saved=seriesDefinitionForGeneration(f.d,s.series_id,s.occurrence.generation+1).data;assert.equal(saved.task.points,5);assert.equal(saved.subtasks.length,3);assert.equal(saved.subtasks[2].task.points,11);
 await f.finish(r.data.id);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id);
 assert.deepEqual((await f.call('GET','/tasks/'+next.id)).data.scoring.potential,p.data.after);
});
test('stable action keys preserve omitted terms through reorder and hidden prospective work never leaks or disappears',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'A',points:2},{title:'B',points:6}]});const s=taskSeriesState(f.d,r.data.id),definition=structuredClone(s.definition.data);definition.subtasks.push({action_key:'series-action:hidden',source_task_id:null,task:{...definition.subtasks[0].task,title:'PRIVATE FUTURE',points:91,visibility:'private'},authorization:{created_by:1,assigned_user_ids:[]},assigned_user_ids:[3],skill_ids:[],tags:[]});f.d.transaction(()=>appendSeriesDefinition(f.d,r.data.id,{definition,effectiveGeneration:s.occurrence.generation+1,expectedRevision:s.revision,actorId:1})).immediate();const keys=definition.subtasks.slice(0,2).map(a=>a.action_key),patch={actions:{order:[keys[1],keys[0]],update:[{action_key:keys[0],fields:{points:4}}]}};
 const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:patch},2);assert.equal(p.status,200,JSON.stringify(p));assert.deepEqual(p.data.before,[{user_id:2,points:8},{user_id:3,points:8}]);assert.deepEqual(p.data.after,[{user_id:2,points:10},{user_id:3,points:10}]);assert.ok(!JSON.stringify(p).includes('PRIVATE FUTURE'));assert.ok(!JSON.stringify(p).includes('series-action:hidden'));assert.equal(f.snapshot(),before);
 const denied=await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{actions:{remove:['series-action:hidden']}}},2);assert.equal(denied.status,404);assert.equal(f.snapshot(),before);const e=await f.edit(r.data.id,{edit_scope:'future_only',future_patch:patch},2);assert.equal(e.status,200,JSON.stringify(e));const saved=seriesDefinitionForGeneration(f.d,s.series_id,s.occurrence.generation+1).data;assert.deepEqual(saved.subtasks.map(a=>a.action_key),[keys[1],keys[0],'series-action:hidden']);assert.equal(saved.subtasks[2].task.points,91);
 await f.finish(r.data.id);const next=f.d.prepare('SELECT id FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id);
 const shown=await f.call('GET','/tasks/'+next.id,undefined,2);assert.deepEqual(shown.data.scoring.potential,p.data.after);assert.ok(!JSON.stringify(shown).includes('PRIVATE FUTURE'));
});
for(const state of ['partial','earned','done'])test(`future-only from ${state} preserves selected settings, revisions, history and exceptions`,async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'A',points:state==='partial'?0:2},{title:'B',points:6}]});await f.finish(state==='done'?r.data.id:r.data.subtasks[0].id);const current=f.row(r.data.id),history=JSON.stringify(f.d.prepare('SELECT * FROM task_activity_events WHERE task_id=?').all(r.data.id)),ledger=JSON.stringify(f.d.prepare('SELECT * FROM reward_ledger').all());const e=await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{scoring_mode:'whole_task',points:12}}});assert.equal(e.status,200,JSON.stringify(e));assert.deepEqual(f.row(r.data.id),current);assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM task_activity_events WHERE task_id=?').all(r.data.id)),history);assert.equal(JSON.stringify(f.d.prepare('SELECT * FROM reward_ledger').all()),ledger);
});
test('future legacy review remains independent of current earned lock; successors retain review',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'A',points:7}]});await f.finish(r.data.id);const s=taskSeriesState(f.d,r.data.id),def=structuredClone(s.definition.data);def.task.scoring_mode='legacy';def.task.scoring_review_required=1;f.d.transaction(()=>appendSeriesDefinition(f.d,r.data.id,{definition:def,effectiveGeneration:s.occurrence.generation+1,expectedRevision:s.revision,actorId:1})).immediate();const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',future_patch:{}});assert.equal(p.status,200);assert.equal(p.data.valid,false);assert.equal(p.data.review_required,true);assert.equal(f.snapshot(),before);assert.equal((await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{scoring_mode:'subtasks'}}})).status,200);
});
test('old JSON policy is snapshotted once before occurrence mode change and missing CAS rejects atomically',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'A',points:7}]});const s=taskSeriesState(f.d,r.data.id),old=structuredClone(s.definition.data);delete old.task.scoring_mode;delete old.task.scoring_review_required;f.d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(old),s.definition.id);const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',future_patch:{}});assert.equal(p.status,200);assert.equal(f.snapshot(),before);
 const e=await f.edit(r.data.id,{scoring_mode:'subtasks'});assert.equal(e.status,200,JSON.stringify(e));assert.equal(taskSeriesState(f.d,r.data.id).revision,s.revision+1);assert.equal(seriesDefinitionForGeneration(f.d,s.series_id,s.occurrence.generation+1).data.task.scoring_mode,'whole_task');await f.edit(r.data.id,{scoring_mode:'subtasks'});assert.equal(taskSeriesState(f.d,r.data.id).revision,s.revision+1);await f.finish(r.data.id);assert.equal(f.d.prepare('SELECT scoring_mode FROM tasks WHERE recurrence_origin_id=? AND parent_task_id IS NULL').get(r.data.id).scoring_mode,'whole_task');
});
test('old future JSON with unrelated current source shape retains its independent review gate',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'Mixed old future',points:7}]});
 const s=taskSeriesState(f.d,r.data.id),old=structuredClone(s.definition.data);delete old.task.scoring_mode;delete old.task.scoring_review_required;
 f.d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(old),s.definition.id);
 f.d.prepare('UPDATE tasks SET points=0 WHERE id=?').run(r.data.subtasks[0].id);
 const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',future_patch:{}});
 assert.equal(p.status,200);assert.equal(p.data.review_required,true);assert.equal(p.data.valid,false);assert.equal(f.snapshot(),before);
 assert.equal((await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{points:4}}})).status,409);assert.equal(f.snapshot(),before);
});
test('future unit references use stable action keys and phase labels after reorder and anonymous addition',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,scoring_mode:'subtasks',subtasks:[{title:'First',points:2},{title:'Second',points:7}]});
 const s=taskSeriesState(f.d,r.data.id),keys=s.definition.data.subtasks.map(a=>a.action_key),before=f.snapshot();
 const p=await f.preview(r.data.id,{edit_scope:'future_only',future_patch:{actions:{update:[{action_key:keys[0],fields:{title:'Renamed',is_optional:true}}],add:[{client_key:'draft_1',fields:{title:'New work',points:3}}],order:[keys[1],keys[0],'new:draft_1']}}});
 assert.equal(p.status,200);assert.ok(Array.isArray(p.data.before_units));assert.deepEqual(p.data.before_units.map(u=>u.ref),keys.map(action_key=>({kind:'action',action_key})));
 assert.deepEqual(p.data.after_units.map(u=>[u.ref.action_key,u.title,u.points,u.is_optional]),[[keys[1],'Second',7,false],[keys[0],'Renamed',2,true],['new:draft_1','New work',3,false]]);
 assert.ok(!JSON.stringify(p.data.after_units).includes('template_id'));assert.ok(!JSON.stringify(p.data.after_units).includes('task_id'));assert.equal(f.snapshot(),before);
});
test('old policy bootstrap requires series CAS/authority and rolls back after settled mode rejection',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task',subtasks:[{title:'Mixed policy',points:7}]});
 const s=taskSeriesState(f.d,r.data.id),old=structuredClone(s.definition.data);delete old.task.scoring_mode;delete old.task.scoring_review_required;
 f.d.prepare('UPDATE task_recurrence_definitions SET definition_json=? WHERE id=?').run(JSON.stringify(old),s.definition.id);
 let before=f.snapshot();assert.equal((await f.edit(r.data.id,{scoring_mode:'subtasks',expected_series_revision:undefined})).status,428);assert.equal(f.snapshot(),before);
 f.grant('change_dates','none');before=f.snapshot();assert.equal((await f.edit(r.data.id,{scoring_mode:'subtasks'},2)).status,403);assert.equal(f.snapshot(),before);
 await f.finish(r.data.id);await f.call('PATCH','/tasks/'+r.data.id+'/status',{status:'open',reset_progress:true});before=f.snapshot();
 const failed=await f.edit(r.data.id,{scoring_mode:'subtasks'});assert.equal(failed.status,409);assert.equal(failed.reason,'scoring_mode_locked');assert.equal(f.snapshot(),before);
});
test('private pending root policy does not borrow the selected public occurrence visibility',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'}),s=taskSeriesState(f.d,r.data.id),definition=structuredClone(s.definition.data);
 definition.task.visibility='private';definition.task.title='PRIVATE ROOT FUTURE';
 f.d.transaction(()=>appendSeriesDefinition(f.d,r.data.id,{definition,effectiveGeneration:s.occurrence.generation+1,expectedRevision:s.revision,actorId:1})).immediate();
 const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',include_edit_definition:true,future_patch:{}},2);
 assert.equal(p.status,404);assert.ok(!JSON.stringify(p).includes('PRIVATE ROOT FUTURE'));assert.equal(f.snapshot(),before);
 assert.equal((await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{points:6}}},2)).status,404);assert.equal(f.snapshot(),before);
});
test('future root lock honors the stored original creator instead of the selected occurrence creator',async t=>{
 const f=await scoringFixture(t),r=await f.create({...recurring,points:5,scoring_mode:'whole_task'}),s=taskSeriesState(f.d,r.data.id),definition=structuredClone(s.definition.data);
 definition.task.locked=1;definition.authorization={created_by:2,assigned_user_ids:[]};
 f.d.transaction(()=>appendSeriesDefinition(f.d,r.data.id,{definition,effectiveGeneration:s.occurrence.generation+1,expectedRevision:s.revision,actorId:1})).immediate();
 const before=f.snapshot(),p=await f.preview(r.data.id,{edit_scope:'future_only',future_patch:{fields:{points:6}}},2);
 assert.equal(p.status,200,JSON.stringify(p));assert.equal(f.snapshot(),before);
 assert.equal((await f.edit(r.data.id,{edit_scope:'future_only',future_patch:{fields:{points:6}}},2)).status,200);
 assert.equal(f.row(r.data.id).points,5);assert.equal(f.row(r.data.id).locked,0);
});
