import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';
process.env.DB_PATH=':memory:';process.env.SESSION_SECRET='shared-rotation-consumer-fixtures';process.env.LOG_LEVEL='error';
const {ALL_MIGRATIONS,_setTestDatabase}=await import('../server/db.js');
const R=await import('../server/services/rotation.js');
const S=await import('../server/services/rotation-shared.js');
const {instantiateWorkflow,previewWorkflow,resolveActivityTemplate}=await import('../server/services/activity-workflows.js');
const {executeWorkflowRotationOperation,workflowRotationOperations}=await import('../server/services/workflow-rotation-operations.js');
const {createMealPlan,materializeMealPlanOccurrences,repairMealChooser}=await import('../server/services/meal-plans.js');
const {rotationOccurrenceVariable,renderRotationVariableTemplates,normalizeVariableValue}=await import('../server/services/variable-resolution.js');
const {projectRotationTrack,readRotationOccurrence,sharedRotationUsage}=await import('../server/services/rotation-access.js');
const {replaceSubjectPermissions}=await import('../server/permissions.js');
const {taskCapabilities}=await import('../server/services/task-access.js');
const {default:rotationRouter}=await import('../server/routes/rotations.js');
const {default:automationRouter}=await import('../server/routes/automation.js');
const {default:idempotencyMiddleware}=await import('../server/middleware/idempotency.js');
let d,admin,kids,group;
test.beforeEach(t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-09-19T23:00:00Z')});
 d=new Database(':memory:');for(const m of ALL_MIGRATIONS){if(m.foreignKeysOff)d.pragma('foreign_keys=OFF');d.transaction(()=>{typeof m.up==='function'?m.up(d):d.exec(m.up);m.afterUp?.(d);})();if(m.foreignKeysOff)d.pragma('foreign_keys=ON');}
 d.pragma('foreign_keys=ON');_setTestDatabase(d);
 const user=(name,role='member')=>Number(d.prepare("INSERT INTO users(username,display_name,password_hash,role,family_role) VALUES(?,?,'x',?,'parent')").run(name,name,role).lastInsertRowid);
 admin=user('Parent','admin');kids=['Gracelynn','Eleanor','Frankie'].map(name=>user(name));
 for(const id of [admin,...kids])d.prepare("INSERT INTO user_skill_proficiency(user_id,skill_id,proficiency,source) SELECT ?,id,'normal','manual' FROM skills WHERE system_key IS NOT NULL").run(id);
 d.prepare("INSERT OR REPLACE INTO sync_config(key,value) VALUES('household_timezone','America/New_York')").run();
 group=S.saveRotationGroupUsage(d,{name:'Kids shared order',member_ids:kids,usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:kids[0],effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:admin});
});
test.afterEach(()=>{assert.deepEqual(d.pragma('foreign_key_check'),[]);_setTestDatabase(null);d.close();});
const binding=()=>({purpose_key:'shower_order',label:'Shower Order',group_id:group.id,strategy:'round_robin',advance_policy:'on_completed',workflow_operations:['resolve','finalize','skip']});
function workflow(){
 const activity=Number(d.prepare("INSERT INTO activity_templates(name,title_template,description,subject_required,assignment_strategy,assignment_policy) VALUES('Bedtime','Bed {{shower_order.position_label}}','Position {{shower_order.position}}',0,'fixed','fixed')").run().lastInsertRowid);
 const id=Number(d.prepare("INSERT INTO workflow_templates(name,subject_required,rotation_bindings_json) VALUES('Bedtime',0,?)").run(JSON.stringify([binding()])).lastInsertRowid);
 kids.forEach((kid,index)=>d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id) VALUES(?,?,?,?, 'fixed',?)").run(id,activity,`child_${index}`,index,kid));return id;
}
function plan(){return createMealPlan(d,{name:'Dinner',rules:[{weekdays:[0,1,2,3,4,5,6],meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:group.id,participant_ids:kids,cook_strategy:'none',supervisor_strategy:'none'}]},admin);}
const generate=date=>materializeMealPlanOccurrences(d,{from:date,to:date,actorId:admin});

test('shared reverse direction is authoritative for Workflow text and Meal choice across scheduled evenings',t=>{
 group=S.saveRotationGroupUsage(d,{name:'Reverse shared order',member_ids:kids,usage_mode:'shared',shared_config:{
  strategy:'rotating_order',direction:'last_to_first',starting_member_id:kids[0],effective_date:'2026-09-19',weekdays:[0,1,2,3,4,5,6],
  active_time:'18:00',finalize_time:'02:00',finalize_day_offset:1,advance_on_skip:false}},{actorId:admin});
 const first=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});
 const workflowId=workflow();plan();generate('2026-09-19');
 assert.equal(d.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments').get().assigned_user_id,kids[0]);
 t.mock.timers.setTime(Date.parse('2026-09-20T23:00:00Z'));
 assert.equal(S.reconcileSharedRotationPeriods(d,{groupId:group.id,now:new Date()}).failed,0);
 const second=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-20',actorId:admin});
 assert.deepEqual(second.member_ids,[kids[2],kids[0],kids[1]]);
 const options={createdBy:admin,startDate:'2026-09-20',requestKey:'reverse_shared_workflow'};
 const run=instantiateWorkflow(d,workflowId,options);
 assert.equal(run.rotations[0].occurrence.id,second.id);
 assert.deepEqual(run.tasks.map(task=>d.prepare('SELECT title FROM tasks WHERE id=?').get(task.task_id).title),['Bed 2nd','Bed 3rd','Bed 1st']);
 assert.deepEqual(instantiateWorkflow(d,workflowId,options),run);
 generate('2026-09-20');
 const assignment=d.prepare('SELECT * FROM meal_occurrence_assignments WHERE rotation_occurrence_id=?').get(second.id);
 assert.equal(assignment.assigned_user_id,kids[2]);
 assert.equal(R.getRotationTrack(d,first.track_id).advance_count,1);
 assert.equal(R.getRotationTrack(d,first.track_id).direction,'last_to_first');
 assert.equal(d.prepare("SELECT count(*) n FROM rotation_tracks WHERE consumer_type IN ('workflow','meal_plan')").get().n,0);
});

test('shared Workflow resolution and retries reuse the Group period; authored consumer finalize/skip cannot advance it',()=>{
 const id=workflow(),before=d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n;
 const preview=previewWorkflow(d,id,{startDate:'2026-09-19',actorId:admin});
 assert.deepEqual(preview.steps.map(step=>step.title),['Bed 1st','Bed 2nd','Bed 3rd']);
 assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,before,'preview has no resolution side effect');
 const options={createdBy:admin,startDate:'2026-09-19',requestKey:'shared_workflow_night_1'};
 const result=instantiateWorkflow(d,id,options),second=instantiateWorkflow(d,id,{...options,requestKey:'shared_workflow_night_other'});
 assert.deepEqual(instantiateWorkflow(d,id,options),result,'same Workflow request is idempotent');
 assert.equal(result.rotations[0].occurrence.id,second.rotations[0].occurrence.id,'independent runs intentionally consume shared Group period');
 assert.equal(d.prepare("SELECT count(*) n FROM rotation_tracks WHERE consumer_type='workflow'").get().n,0);
 assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
 const parent=d.prepare('SELECT * FROM tasks WHERE id=?').get(result.parent_task_id);
 const operations=workflowRotationOperations(d,parent,admin);assert.deepEqual(operations.purposes[0].operations,['resolve']);
 for(const operation of ['finalize','skip'])assert.throws(()=>executeWorkflowRotationOperation(d,result.id,'shower_order',operation,{actor:admin,actorId:admin,expectedTaskRevision:parent.revision,expectedOccurrenceRevision:result.rotations[0].occurrence.revision}),error=>error.code==='rotation_shared_consumer_operation');
 assert.equal(R.getRotationTrack(d,result.rotations[0].occurrence.track_id).advance_count,0);
});

test('future Workflow preview/creation uses a provisional shared value without consuming an occurrence',()=>{
 const id=workflow(),result=instantiateWorkflow(d,id,{createdBy:admin,startDate:'2026-09-20',requestKey:'shared_future_night'});
 assert.equal(result.rotations[0].occurrence.id,0);assert.equal(result.rotations[0].occurrence.status,'preview');
 assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,0);
 assert.equal(d.prepare('SELECT coalesce(sum(advance_count),0) n FROM rotation_tracks').get().n,0);
 assert.ok(result.tasks.every(task=>d.prepare('SELECT title FROM tasks WHERE id=?').get(task.task_id).title.includes('Bed ')));
});

test('canonical Meal shared binding consumes the same planned first member, never a local cursor or finalizer',()=>{
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});plan();generate('2026-09-19');
 const assignment=d.prepare('SELECT * FROM meal_occurrence_assignments').get();
 assert.equal(assignment.rotation_occurrence_id,occurrence.id);assert.equal(assignment.assigned_user_id,kids[0]);
 assert.equal(R.getRotationTrack(d,occurrence.track_id).advance_count,0);
 assert.equal(d.prepare("SELECT count(*) n FROM rotation_tracks WHERE consumer_type='meal_plan'").get().n,0);
 generate('2026-09-20');const future=d.prepare('SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.date=?').get('2026-09-20');
 assert.equal(future.assigned_user_id,null);assert.equal(future.rotation_occurrence_id,null);
 assert.equal(d.prepare("SELECT count(*) n FROM planning_obligations WHERE entity_type='meal' AND entity_id=?").get(future.meal_id).n,0,'future preview does not notify/provision an uncertain assignee');
 assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
});

test('shared Meal selection fails closed when its selected member is ineligible; no local filtering, fallback or advancement',()=>{
 d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(kids[0]);
 plan();generate('2026-09-19');
 const assignment=d.prepare('SELECT * FROM meal_occurrence_assignments').get(),occurrence=R.getRotationOccurrence(d,assignment.rotation_occurrence_id);
 assert.equal(assignment.assigned_user_id,null);assert.deepEqual(occurrence.member_ids,kids);
 const meal=d.prepare('SELECT * FROM meals WHERE id=?').get(assignment.meal_id),provenance=JSON.parse(meal.provenance_json);
 assert.equal(provenance.rotations.chooser.reason_code,'rotation_shared_incompatible');
 assert.equal(R.getRotationTrack(d,occurrence.track_id).advance_count,0);
 assert.equal(repairMealChooser(d,meal.id,{actorId:admin}).status,'unresolved');
 assert.equal(d.prepare('SELECT count(*) n FROM assignment_rotation_state').get().n,0);
});

test('restricted viewers can read Group-owned state without private consumer context or Used by entries',async()=>{
 const viewer=kids[1];replaceSubjectPermissions(d,'user',viewer,{capabilities:{'rotations.view':'allow','rotations.history':'allow','tasks.view_own':'allow','tasks.view_household':'none'}});
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin}),track=R.getRotationTrack(d,occurrence.track_id);
 const privateTask=Number(d.prepare("INSERT INTO tasks(title,description,visibility,created_by,start_date,due_date) VALUES('Secret clinician','Private details','private',?,'2037-04-17','2037-04-18')").run(admin).lastInsertRowid);
 d.prepare('INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id) VALUES(?,?,?,?,?)').run(privateTask,'order',track.id,occurrence.id,privateTask);
 assert.equal(taskCapabilities(d,viewer,{id:privateTask}).view,false);
 assert.ok(projectRotationTrack(d,viewer,track));assert.deepEqual(sharedRotationUsage(d,viewer,track.id),[]);
 const result=readRotationOccurrence(d,viewer,occurrence.id);assert.deepEqual(result.member_ids,kids);
 assert.equal(normalizeVariableValue(d,{id:'period',type:'rotation_occurrence'},occurrence.id,{actor:viewer}).id,occurrence.id);
 const payload=JSON.stringify([result,projectRotationTrack(d,viewer,track),sharedRotationUsage(d,viewer,track.id)]);
  for(const secret of ['Secret clinician','Private details','2037-04-17','2037-04-18','subject_user_id','task_id'])assert.ok(!payload.includes(secret),secret);
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=viewer;req.authRole='member';req.session={userId:viewer,role:'member'};next();});app.use('/automation',rotationRouter);app.use('/automation',automationRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try {
   for(const path of [`rotation-groups/${group.id}`,`rotation-tracks/${track.id}`,`rotation-tracks/${track.id}/history`,`rotation-occurrences/${occurrence.id}`,`rotation-occurrences/${occurrence.id}/history`,'quick-add']) {
     const response=await fetch(`http://127.0.0.1:${server.address().port}/automation/${path}`),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));
     for(const secret of ['Secret clinician','Private details','2037-04-17','2037-04-18','subject_user_id','task_id'])assert.ok(!JSON.stringify(value).includes(secret),`${path}: ${secret}`);
   }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('position label is a typed ordinal for the supplied performer; expressions remain read-only',()=>{
 const occurrence=S.previewSharedRotation(d,group.id,{dateKey:'2026-09-19'}),before=d.prepare('SELECT total_changes() n').get().n;
 assert.equal(rotationOccurrenceVariable(occurrence,kids[1]).position_label,'2nd');
 const rendered=renderRotationVariableTemplates(d,{templates:['Take shower · {{shower_order.position_label}}'],bindings:[binding()],rotations:[{purpose_key:'shower_order',occurrence}],subjectUserId:kids[2]});
 assert.equal(rendered.values[0],'Take shower · 3rd');assert.equal(d.prepare('SELECT total_changes() n').get().n,before);
});

test('shared Meal activation and repeated overrides reconcile untouched assignments; recorded work is preserved',t=>{
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});plan();generate('2026-09-19');generate('2026-09-20');
 const assignment=date=>d.prepare('SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.date=?').get(date);
 const update=members=>d.transaction(()=>{
   const current=R.getRotationOccurrence(d,occurrence.id);
   const changed=R.overrideRotation(d,current.id,{member_ids:members,expected_revision:current.revision,actorId:admin});
   S.notifySharedRotationReconciliation(d,{groupId:group.id,occurrence:changed,reason:'period_overridden'});return changed;
 })();
 update([kids[2],kids[0],kids[1]]);assert.equal(assignment('2026-09-19').assigned_user_id,kids[2]);
 update([kids[1],kids[2],kids[0]]);assert.equal(assignment('2026-09-19').assigned_user_id,kids[1]);
 assert.equal(d.prepare("SELECT count(*) n FROM planning_obligations WHERE entity_id=? AND entity_type='meal' AND status='pending'").get(assignment('2026-09-19').meal_id).n,1);
 assert.equal(R.getRotationTrack(d,occurrence.track_id).advance_count,0);
 const mealId=assignment('2026-09-19').meal_id;d.prepare('UPDATE meals SET user_modified=1 WHERE id=?').run(mealId);
 const protectedRow=d.prepare('SELECT * FROM meals WHERE id=?').get(mealId),protectedAssignment=assignment('2026-09-19');
 update(kids);assert.deepEqual(d.prepare('SELECT * FROM meals WHERE id=?').get(mealId),protectedRow);assert.deepEqual(assignment('2026-09-19'),protectedAssignment);
 t.mock.timers.setTime(new Date('2026-09-20T23:00:00Z').valueOf());
 const result=S.reconcileSharedRotationPeriods(d);assert.equal(result.failed,0);
 assert.equal(assignment('2026-09-20').assigned_user_id,kids[1]);assert.ok(assignment('2026-09-20').rotation_occurrence_id);
 const state=R.getRotationTrack(d,occurrence.track_id);assert.equal(state.advance_count,1);
 S.reconcileSharedRotationPeriods(d);assert.equal(R.getRotationTrack(d,state.id).advance_count,1);
});

test('mode-conversion preview includes authored Workflow and Meal consumers before they have independent Tracks',()=>{
 const workflowId=workflow(),mealPlan=plan();
 const preview=S.previewRotationGroupUsage(d,group.id,{usage_mode:'independent',effective_date:'2026-09-20',independent_starts:[]},{actorId:admin});
 assert.ok(preview.consumers.some(row=>row.consumer_type==='workflow'&&row.consumer_id===String(workflowId)&&row.purpose_key==='shower_order'));
 assert.ok(preview.consumers.some(row=>row.consumer_type==='meal_plan'&&row.consumer_id.startsWith(`${mealPlan.id}:`)&&row.purpose_key==='chooser'));
 assert.throws(()=>S.saveRotationGroupUsage(d,{usage_mode:'independent',effective_date:'2026-09-20',independent_starts:[],confirmation_token:preview.confirmation_token},{id:group.id,actorId:admin,expectedRevision:group.revision}),/explicit next member/);
});

test('shared-to-independent Meal conversion uses the confirmed consumer seed, preserves old shared snapshots, and leaves protected Meals unchanged',()=>{
 const current=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});plan();generate('2026-09-19');generate('2026-09-20');
 const active=d.prepare("SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.date='2026-09-19'").get();
 d.prepare('UPDATE meals SET user_modified=1 WHERE id=?').run(active.meal_id);
 const protectedMeal=d.prepare('SELECT * FROM meals WHERE id=?').get(active.meal_id),snapshot=R.getRotationOccurrence(d,current.id);
 const draft={usage_mode:'independent',effective_date:'2026-09-20',independent_starts:[]};
 let preview=S.previewRotationGroupUsage(d,group.id,draft,{actorId:admin});
 assert.ok(preview.exceptions.some(value=>value.consumer_type==='meal_plan'),'conversion discloses protected Meal evidence');
 draft.independent_starts=preview.consumers.map(value=>({consumer_type:value.consumer_type,consumer_id:value.consumer_id,purpose_key:value.purpose_key,next_member_id:kids[2]}));
 preview=S.previewRotationGroupUsage(d,group.id,draft,{actorId:admin});
 S.saveRotationGroupUsage(d,{...draft,confirmation_token:preview.confirmation_token},{id:group.id,actorId:admin,expectedRevision:group.revision});
 const future=d.prepare("SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.date='2026-09-20'").get();
 assert.equal(future.assigned_user_id,kids[2]);assert.ok(future.rotation_occurrence_id);
 assert.notEqual(R.getRotationOccurrence(d,future.rotation_occurrence_id).track_id,current.track_id);
 assert.deepEqual(R.getRotationOccurrence(d,current.id),snapshot);assert.deepEqual(d.prepare('SELECT * FROM meals WHERE id=?').get(active.meal_id),protectedMeal);
});

test('independent-to-shared Meal conversion rebinds untouched future assignments and preserves historical or protected evidence',t=>{
 const independent=R.saveRotationGroup(d,{name:'Independent meal membership',member_ids:kids},{actorId:admin});
 const mealPlan=createMealPlan(d,{name:'Converting dinner',rules:[{weekdays:[0,1,2,3,4,5,6],meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:independent.id,participant_ids:kids,cook_strategy:'none',supervisor_strategy:'none'}]},admin);
 for(const date of ['2026-09-19','2026-09-20','2026-09-21'])generate(date);
 const assignment=date=>d.prepare('SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.date=? AND m.meal_plan_id=?').get(date,mealPlan.id);
 const historical=assignment('2026-09-19'),future=assignment('2026-09-20'),protectedAssignment=assignment('2026-09-21');
 d.prepare('UPDATE meals SET user_modified=1 WHERE id=?').run(protectedAssignment.meal_id);
 const protectedMeal=d.prepare('SELECT * FROM meals WHERE id=?').get(protectedAssignment.meal_id);
 const oldSnapshots=[historical,future,protectedAssignment].map(value=>R.getRotationOccurrence(d,value.rotation_occurrence_id));
 const draft={usage_mode:'shared',shared_config:{...group.shared_config,effective_date:'2026-09-20',starting_member_id:kids[2]}};
 const preview=S.previewRotationGroupUsage(d,independent.id,draft,{actorId:admin});
 assert.ok(preview.exceptions.some(value=>value.consumer_type==='meal_plan'),'meaningful future evidence is disclosed before conversion');
 S.saveRotationGroupUsage(d,{...draft,confirmation_token:preview.confirmation_token},{id:independent.id,actorId:admin,expectedRevision:independent.revision});
 assert.equal(assignment('2026-09-20').assigned_user_id,null,'unstarted future Meal becomes provisional until the shared period activates');
 assert.equal(assignment('2026-09-20').rotation_occurrence_id,null);
 assert.equal(d.prepare("SELECT count(*) n FROM planning_obligations WHERE entity_type='meal' AND entity_id=? AND status='pending'").get(future.meal_id).n,0);
 assert.equal(JSON.parse(d.prepare('SELECT provenance_json FROM meals WHERE id=?').get(future.meal_id).provenance_json).rotations.chooser.shared,true);
 t.mock.timers.setTime(new Date('2026-09-20T23:00:00Z').valueOf());assert.equal(S.reconcileSharedRotationPeriods(d).failed,0);
 const active=assignment('2026-09-20'),period=S.previewSharedRotation(d,independent.id,{dateKey:'2026-09-20'});
 assert.equal(active.assigned_user_id,kids[2]);assert.equal(active.rotation_occurrence_id,period.id);
 assert.equal(R.getRotationTrack(d,period.track_id).advance_count,0,'consumer conversion and activation do not advance the schedule');
 assert.deepEqual(assignment('2026-09-19'),historical);assert.deepEqual(assignment('2026-09-21'),protectedAssignment);
 assert.deepEqual(d.prepare('SELECT * FROM meals WHERE id=?').get(protectedAssignment.meal_id),protectedMeal);
 assert.deepEqual(oldSnapshots.map(value=>R.getRotationOccurrence(d,value.id)),oldSnapshots,'finalized independent history is preserved');
});

for(const unavailable of [false,true])test(`Meal mode roundtrip uses the explicit independent seed without rewriting a ${unavailable?'provisional':'finalized'} old decision`,()=>{
 const independent=R.saveRotationGroup(d,{name:'Meal roundtrip',member_ids:kids},{actorId:admin});
 if(unavailable)for(const kid of kids)d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(kid);
 const mealPlan=createMealPlan(d,{name:'Roundtrip dinner',rules:[{weekdays:[0,1,2,3,4,5,6],meal_type:'dinner',policy:'round_robin',chooser_rotation_group_id:independent.id,participant_ids:kids,cook_strategy:'none',supervisor_strategy:'none'}]},admin);
 generate('2026-09-21');
 const assignment=()=>d.prepare('SELECT a.* FROM meal_occurrence_assignments a JOIN meals m ON m.id=a.meal_id WHERE m.meal_plan_id=?').get(mealPlan.id);
 const original=assignment(),snapshot=d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(original.rotation_occurrence_id);
 let current=independent;
 const convert=input=>{const proposal=S.previewRotationGroupUsage(d,current.id,input,{actorId:admin});current=S.saveRotationGroupUsage(d,{...input,confirmation_token:proposal.confirmation_token},{id:current.id,actorId:admin,expectedRevision:current.revision});};
 convert({usage_mode:'shared',shared_config:{...group.shared_config,effective_date:'2026-09-20',starting_member_id:kids[1]}});
 assert.equal(assignment().rotation_occurrence_id,null);
 if(unavailable)assert.ok(R.getRotationOccurrence(d,snapshot.id).supersession,'abandoned unresolved decision is retired without fabricating advancement');
 for(const kid of kids)d.prepare("UPDATE user_skill_proficiency SET proficiency='normal' WHERE user_id=? AND skill_id IN(SELECT id FROM skills WHERE system_key='meal_choosing')").run(kid);
 const input={usage_mode:'independent',effective_date:'2026-09-21',independent_starts:[]};
 const preview=S.previewRotationGroupUsage(d,current.id,input,{actorId:admin});
 input.independent_starts=preview.consumers.map(value=>({consumer_type:value.consumer_type,consumer_id:value.consumer_id,purpose_key:value.purpose_key,next_member_id:kids[2]}));
 convert(input);
 assert.equal(assignment().assigned_user_id,kids[2]);assert.notEqual(assignment().rotation_occurrence_id,snapshot.id);
 assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences WHERE id=?').get(snapshot.id),snapshot);
 const result=assignment(),newDecision=R.getRotationOccurrence(d,result.rotation_occurrence_id),count=R.getRotationTrack(d,newDecision.track_id).advance_count;
 S.notifySharedRotationReconciliation(d,{groupId:current.id,dateKey:'2026-09-21',reason:'independent_boundary'});
 assert.deepEqual(assignment(),result);assert.equal(R.getRotationTrack(d,newDecision.track_id).advance_count,count);
});

test('shared Meal binding rejects a conflicting fixed local assignment instead of silently ignoring the Group',()=>{
 assert.throws(()=>createMealPlan(d,{name:'Conflict',rules:[{weekdays:[0],meal_type:'dinner',policy:'fixed',fixed_user_id:kids[1],fallback_user_id:kids[2],chooser_rotation_group_id:group.id}]},admin),error=>error.code==='ROTATION_SHARED_CONFLICT');
 assert.equal(d.prepare('SELECT count(*) n FROM meal_plans').get().n,0);
});

test('shared Meal reconciliation continues beyond one 100-row batch without leaving future consumers stuck',t=>{
 createMealPlan(d,{name:'Synthetic batch',rules:Array.from({length:101},(_,index)=>({weekdays:[6],meal_type:'custom',custom_label:`Batch ${index}`,policy:'round_robin',chooser_rotation_group_id:group.id,participant_ids:kids,cook_strategy:'none',supervisor_strategy:'none'}))},admin);
 generate('2026-09-20');assert.equal(d.prepare('SELECT count(*) n FROM meal_occurrence_assignments WHERE assigned_user_id IS NULL').get().n,101);
 t.mock.timers.setTime(new Date('2026-09-20T23:00:00Z').valueOf());
 const result=S.reconcileSharedRotationPeriods(d);assert.equal(result.failed,0);
 assert.equal(d.prepare('SELECT count(*) n FROM meal_occurrence_assignments WHERE assigned_user_id IS NULL').get().n,0);
 assert.equal(d.prepare('SELECT count(DISTINCT rotation_occurrence_id) n FROM meal_occurrence_assignments').get().n,1);
 assert.equal(d.prepare('SELECT sum(advance_count) n FROM rotation_tracks').get().n,1,'101 consumers did not advance the Track; only the recovered previous period did');
});

test('shared Group can deactivate after its last member leaves while keeping history and denying new usable resolution',()=>{
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin}),before=R.getRotationOccurrence(d,occurrence.id);
 for(const kid of kids)d.prepare('DELETE FROM users WHERE id=?').run(kid);
 const retired=S.saveRotationGroupUsage(d,{active:false},{id:group.id,expectedRevision:group.revision,actorId:admin});
 assert.equal(retired.active,0);assert.deepEqual(R.getRotationOccurrence(d,occurrence.id),before);
 const preview=S.previewSharedRotation(d,group.id,{dateKey:'2026-09-20'});assert.deepEqual(preview.order,[]);
 assert.throws(()=>S.saveRotationGroupUsage(d,{active:true},{id:group.id,expectedRevision:retired.revision,actorId:admin}),/starting member|at least one/);
});

test('a finalized shared Fixed Order period cannot later become skipped even though no cursor advanced',()=>{
 const fixed=S.saveRotationGroupUsage(d,{name:'Fixed shared',member_ids:kids,usage_mode:'shared',shared_config:{...group.shared_config,strategy:'fixed_order'}},{actorId:admin});
 const occurrence=S.resolveSharedRotation(d,fixed.id,{dateKey:'2026-09-19',actorId:admin});
 R.finalizeRotation(d,occurrence.id,{actorId:admin,expectedRevision:occurrence.revision,sharedSchedule:true});
 const historical=R.getRotationOccurrence(d,occurrence.id);assert.equal(historical.advanced,0);
 assert.throws(()=>R.skipRotation(d,occurrence.id,{actorId:admin,expectedRevision:historical.revision,sharedSchedule:true}),error=>error.status===409);
 assert.deepEqual(R.getRotationOccurrence(d,occurrence.id),historical);
});

test('an active shared period override retains that period membership after a confirmed future membership change',()=>{
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});
 const draft={member_ids:kids.slice(0,2),usage_mode:'shared',shared_config:{...group.shared_config,effective_date:'2026-09-20',starting_member_id:kids[0]}};
 const proposal=S.previewRotationGroupUsage(d,group.id,draft,{actorId:admin});
 S.saveRotationGroupUsage(d,{...draft,confirmation_token:proposal.confirmation_token},{id:group.id,actorId:admin,expectedRevision:group.revision});
 const changed=R.overrideRotation(d,occurrence.id,{actorId:admin,expected_revision:occurrence.revision,member_ids:[kids[2],kids[0],kids[1]]});
 assert.deepEqual(changed.member_ids,[kids[2],kids[0],kids[1]]);assert.deepEqual(changed.original_order.map(member=>member.id),kids);
 assert.deepEqual(S.previewSharedRotation(d,group.id,{dateKey:'2026-09-20'}).member_ids,kids.slice(0,2));
});

test('rechecking unavailable shared period does not adopt members added for a future boundary',()=>{
 const skillId=d.prepare("SELECT id FROM skills WHERE system_key='meal_choosing'").get().id;
 for(const kid of kids)d.prepare("UPDATE user_skill_proficiency SET proficiency='excluded' WHERE user_id=? AND skill_id=?").run(kid,skillId);
 const original=S.saveRotationGroupUsage(d,{name:'Skill shared',member_ids:kids,usage_mode:'shared',shared_config:{...group.shared_config,eligibility:{skill_ids:[skillId]}}},{actorId:admin});
 const occurrence=S.resolveSharedRotation(d,original.id,{dateKey:'2026-09-19',actorId:admin});assert.equal(occurrence.order.length,0);
 const draft={member_ids:[...kids,admin],usage_mode:'shared',shared_config:{...original.shared_config,effective_date:'2026-09-20'}};
 const proposal=S.previewRotationGroupUsage(d,original.id,draft,{actorId:admin});
 S.saveRotationGroupUsage(d,{...draft,confirmation_token:proposal.confirmation_token},{id:original.id,actorId:admin,expectedRevision:original.revision});
 const rechecked=R.refreshRotationOccurrence(d,occurrence.id,{actorId:admin,expected_revision:occurrence.revision});
 assert.equal(rechecked.order.length,0);assert.deepEqual(rechecked.members.map(member=>member.id),kids);
 assert.deepEqual(S.previewSharedRotation(d,original.id,{dateKey:'2026-09-20'}).member_ids,[admin]);
});

test('Group conversion preview retries recheck current consumer visibility and management permission',async()=>{
 const viewer=kids[0];replaceSubjectPermissions(d,'user',viewer,{capabilities:{'rotations.manage':'allow','rotations.view':'allow','rotations.history':'allow','tasks.view_own':'allow','tasks.view_household':'allow'}});
 const {bindTaskRotations}=await import('../server/services/task-rotation.js');
 const owner=Number(d.prepare("INSERT INTO tasks(title,visibility,created_by,start_date,start_time,due_date,due_time,rotation_bindings_json) VALUES('Private preview secret','all',?,'2026-09-19','19:00','2026-09-19','22:00',?)").run(admin,JSON.stringify([binding()])).lastInsertRowid);
 bindTaskRotations(d,owner,{actorId:admin});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authUserId=viewer;req.authRole='member';req.session={userId:viewer,role:'member'};next();});app.use(idempotencyMiddleware);app.use('/automation',rotationRouter);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const request=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/automation/rotation-groups/${group.id}/usage-preview`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'shared-preview-current-access'},body:JSON.stringify({usage_mode:'independent',effective_date:'2026-09-20',independent_starts:[]})});return {status:response.status,text:await response.text()};};
 try {
   const first=await request();assert.equal(first.status,200,first.text);assert.match(first.text,/Private preview secret/);
   d.prepare("UPDATE tasks SET visibility='private' WHERE id=?").run(owner);
   const privacy=await request();assert.equal(privacy.status,200,privacy.text);assert.doesNotMatch(privacy.text,/Private preview secret/);
   replaceSubjectPermissions(d,'user',viewer,{capabilities:{'rotations.manage':'none','rotations.view':'allow'}});
   assert.equal((await request()).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('overnight Activity previews and Workflow materialization share the canonical evening and keep expression provenance',()=>{
 const occurrence=S.resolveSharedRotation(d,group.id,{dateKey:'2026-09-19',actorId:admin});
 const activity=Number(d.prepare(`INSERT INTO activity_templates(name,title_template,description,subject_required,assignment_strategy,assignment_policy,
   fixed_user_id,start_time,due_time,due_date_offset_days,rotation_bindings_json)
   VALUES('Late bedtime','Bed {{shower_order.position_label}}','Position {{shower_order.position}}',0,'fixed','fixed',?,'00:30','01:00',0,?)`).run(kids[0],JSON.stringify([binding()])).lastInsertRowid);
 const preview=resolveActivityTemplate(d,activity,{subjectUserId:kids[0],task:{start_date:'2026-09-20'},actorId:admin});
 assert.equal(preview.data.title,'Bed 1st','template-inherited after-midnight start belongs to the previous evening');
 const explicit=resolveActivityTemplate(d,activity,{subjectUserId:kids[0],task:{start_date:'2026-09-20',start_time:'00:45'},actorId:admin});
 assert.equal(explicit.data.title,'Bed 1st');
 const workflowId=Number(d.prepare("INSERT INTO workflow_templates(name,subject_required) VALUES('Late bedtime owner',0)").run().lastInsertRowid);
 d.prepare("INSERT INTO workflow_template_steps(workflow_template_id,activity_template_id,step_key,sort_order,assignment_policy_override,assignment_user_id) VALUES(?,?,'bedtime',0,'fixed',?)").run(workflowId,activity,kids[0]);
 assert.equal(previewWorkflow(d,workflowId,{startDate:'2026-09-20',actorId:admin}).steps[0].title,'Bed 1st');
 const result=instantiateWorkflow(d,workflowId,{createdBy:admin,startDate:'2026-09-20',requestKey:'shared_overnight_activity'});
 const taskId=result.tasks[0].task_id;
 assert.equal(d.prepare('SELECT occurrence_id FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').get(taskId).occurrence_id,occurrence.id);
 assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(taskId).title,'Bed 1st');
 const changed=R.overrideRotation(d,occurrence.id,{actorId:admin,expected_revision:occurrence.revision,member_ids:[kids[2],kids[0],kids[1]]});
 S.notifySharedRotationReconciliation(d,{groupId:group.id,occurrence:changed,reason:'period_overridden'});
 assert.equal(d.prepare('SELECT title FROM tasks WHERE id=?').get(taskId).title,'Bed 2nd','live override retains and refreshes authored expression');
 assert.equal(d.prepare('SELECT description FROM tasks WHERE id=?').get(taskId).description,'Position 2');
 const explicitOwner=workflow();
 d.prepare('UPDATE workflow_templates SET rotation_bindings_json=? WHERE id=?').run(JSON.stringify([{...binding(),period_date_offset_days:-1}]),explicitOwner);
 assert.equal(previewWorkflow(d,explicitOwner,{startDate:'2026-09-20',actorId:admin}).steps[0].title,'Bed 2nd');
 const next=instantiateWorkflow(d,explicitOwner,{createdBy:admin,startDate:'2026-09-20',requestKey:'shared_explicit_previous_evening'});
 assert.equal(next.rotations[0].occurrence.id,occurrence.id);
 assert.equal(d.prepare('SELECT count(*) n FROM rotation_occurrences').get().n,1);
});
