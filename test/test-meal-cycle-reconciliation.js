import * as shared from '../server/services/rotation-shared.js';
import * as plans from '../server/services/meal-plans.js';
import * as grocery from '../server/services/meal-grocery-runs.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ensure,review,main,decision,submitAll,cycles,saveCycleSettings} from './meal-cycle-finalization-fixture.js';
import {mealDishPortionSummary} from '../server/services/meal-dishes.js';
import {runMealCycleScheduler} from '../server/services/meal-cycle-scheduler.js';
import {changeTaskStatus} from '../server/services/task-lifecycle.js';
import {ensureMealExecution,previewMealExecution} from '../server/services/meal-execution.js';
import {withCycleMealWrite} from '../server/services/meal-cycle-guards.js';
import {saveRotationGroup} from '../server/services/rotation.js';
import {reviewCycleReadiness,finalizeCycle} from '../server/services/meal-cycle-finalization.js';
import {savePlanningContext} from '../server/services/planning-contexts.js';
const service=await import('../server/services/meal-cycle-reconciliation.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
const now='2034-03-03T10:00:00Z';
function reconcile(d,id) {assert.equal(typeof service.reconcileCycle,'function','durable reconciliation service exists');return service.reconcileCycle(d,id,{now});}
function away(d,user=3,from='2034-03-06T00:00',to='2034-03-07T00:00') {
  return d.prepare("INSERT INTO availability_periods(user_id,source,category,state,starts_at,ends_at,active) VALUES(?,'manual','general','away',?,?,1)").run(user,from,to).lastInsertRowid;
}
test('source hooks persist bounded anonymous dirtiness, deduplicate retries and run while generation paused',()=>{
 const d=fixture();try {away(d);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_events').get().n,0);const c=ensure(d);away(d,2);assert.ok(d.prepare("SELECT 1 FROM meal_cycle_events WHERE status='pending'").get());
 assert.equal(typeof service.enqueueCycleReconciliation,'function');const input={scope:{cycle_id:c.cycle_id},sourceRevision:'revision-1',reason:'availability'};
 assert.equal(service.enqueueCycleReconciliation(d,input).id,service.enqueueCycleReconciliation(d,input).id);
 d.exec('UPDATE meal_cycle_settings SET enabled=0');runMealCycleScheduler(d,{now});assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_events WHERE status='pending'").get().n,0);
 assert.equal(review(d,c.cycle_id).blockers.some(x=>x.code==='CYCLE_SOURCE_CHANGED'),false);
 }finally{d.close();}
});
test('away removes personal child demand, return restores saved choice and legacy portion',()=>{
 const d=fixture({}, {presence_required:true});try {const c=ensure(d);main(d,c.cycle_id);decision(d,c.cycle_id,3,{choice_kind:'backup',menu_item_ids:[],title:'Soup',selected_meal_title:'Soup',portion_amount:1.37});
 const before=d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get();const child=before.selected_meal_id;assert.ok(child);const a=away(d);reconcile(d,c.cycle_id);
 assert.equal(mealDishPortionSummary(d,child).planned,0);assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE id=?').get(before.id),before);
 d.prepare('DELETE FROM availability_periods WHERE id=?').run(a);reconcile(d,c.cycle_id);assert.equal(mealDishPortionSummary(d,child).planned,1.37);
 }finally{d.close();}
});

test('R1 canonical Save by an absent fulfilled chooser preserves zero effective demand and saved legacy choice',()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);decision(d,c.cycle_id,2);away(d,2);reconcile(d,c.cycle_id);
 decision(d,c.cycle_id,2,{choice_kind:'backup',menu_item_ids:[],selected_meal_title:'Soup',portion_amount:1.37},'away-save');
 const saved=d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=2').get();assert.equal(saved.portion_amount,1.37);
 const check=()=>{const r=review(d,c.cycle_id,2);assert.equal(r.occurrences[0].shared_choice_active,true);assert.equal(r.personal.requirements.find(x=>x.kind==='decision').contribution,0);assert.equal(mealDishPortionSummary(d,saved.selected_meal_id).planned,0);};
 check();assert.equal(reconcile(d,c.cycle_id).changed,false);check();assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE id=?').get(saved.id),saved);
 d.exec('DELETE FROM availability_periods');reconcile(d,c.cycle_id);assert.equal(mealDishPortionSummary(d,saved.selected_meal_id).planned,1.37);assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE id=?').get(saved.id),saved);
 }finally{d.close();}
});

for(const table of ['split_expense_guest_users','housekeeping_workers'])test(`R2 ${table} restoration retains completed lineage and never rewards again`,()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);for(const p of [1,2,3])decision(d,c.cycle_id,p);const old=review(d,c.cycle_id,3).personal.task_id;
 d.exec('INSERT INTO reward_participants(user_id,enabled) VALUES(3,1)');d.prepare('UPDATE tasks SET points=7 WHERE id=?').run(old);submitAll(d,c.cycle_id);
 const ledger=d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(old);assert.equal(ledger.reduce((sum,x)=>sum+x.delta,0),7);
 d.exec(`INSERT INTO ${table}(user_id) VALUES(3)`);reconcile(d,c.cycle_id);d.exec(`DELETE FROM ${table} WHERE user_id=3`);reconcile(d,c.cycle_id);
 const r=review(d,c.cycle_id,3),link=d.prepare('SELECT * FROM meal_cycle_task_links WHERE task_id=?').get(r.personal.task_id),original=d.prepare('SELECT * FROM meal_cycle_task_links WHERE task_id=?').get(old);
 assert.equal(link.purpose,'correction');assert.equal(link.supersedes_link_id,original.id);assert.equal(original.state,'superseded');
 d.prepare('UPDATE tasks SET points=100 WHERE id=?').run(link.task_id);const input={actorId:3,expectedRevision:r.revision,requestKey:'returned-submit'};cycles.submitCyclePerson(d,c.cycle_id,input);cycles.submitCyclePerson(d,c.cycle_id,input);
 assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),ledger);assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(old),completion);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(old).status,'done');assert.equal(d.prepare('SELECT count(*) n FROM task_completions WHERE task_id=?').get(link.task_id).n,1);assert.equal(reconcile(d,c.cycle_id).changed,false);
 }finally{d.close();}
});

for(const [timezone,instant,included] of [['America/Los_Angeles','2034-03-07T01:00:00Z',true],['Asia/Tokyo','2034-03-06T16:00:00Z',false]])test(`R3 sweep uses stored ${timezone} final date instead of UTC or current settings`,()=>{
 const d=fixture();try {
 d.prepare("UPDATE sync_config SET value=? WHERE key='household_timezone'").run(timezone);saveCycleSettings(d,{timezone,cadence:'daily'},{actorId:1,expectedRevision:1,requestKey:'local-timezone'});const c=ensure(d,{expectedSettingsRevision:2});main(d,c.cycle_id);away(d,3);
 d.exec("UPDATE sync_config SET value='UTC' WHERE key='household_timezone'");saveCycleSettings(d,{timezone:'UTC'},{actorId:1,expectedRevision:2,requestKey:'changed-timezone'});
 const results=service.drainCycleReconciliation(d,{now:instant});assert.equal(results.some(x=>x.cycle_id===c.cycle_id),included);
 assert.equal(d.prepare("SELECT status FROM meal_participants WHERE user_id=3 AND role='participant'").get().status,included?'away':'participating');
 }finally{d.close();}
});
test('deliberate opt-out survives absence and return; valid shared main survives chooser travel',()=>{
 const d=fixture({}, {presence_required:true});try {const c=ensure(d);main(d,c.cycle_id);decision(d,c.cycle_id,3,{participation:'not_participating',choice_kind:'household'});const a=away(d,2);away(d,3);reconcile(d,c.cycle_id);
 assert.equal(review(d,c.cycle_id).occurrences[0].shared_choice_active,true);d.exec('DELETE FROM availability_periods');reconcile(d,c.cycle_id);
 assert.equal(review(d,c.cycle_id,3).personal.requirements.find(x=>x.kind==='decision').status,'not_eating');
 }finally{d.close();}
});
test('unrelated traveler and publication bookkeeping do not invalidate cycle sources',()=>{
 const d=fixture();try {const c=ensure(d);const before=cycles.cycleSourceFingerprint(d,c.cycle_id);away(d,3,'2035-01-01T00:00','2035-01-02T00:00');assert.equal(cycles.cycleSourceFingerprint(d,c.cycle_id),before);
 d.prepare('INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(?,?,?)').run(c.occurrences[0].id,'rice','1 kg');reconcile(d,c.cycle_id);const b=cycles.cycleSourceFingerprint(d,c.cycle_id);d.exec('UPDATE meal_ingredients SET on_shopping_list=1');assert.equal(cycles.cycleSourceFingerprint(d,c.cycle_id),b);
 }finally{d.close();}
});
test('invalidated completed submission gets required non-rewarding correction and stale Task cannot reopen',()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);for(const p of [1,2,3])decision(d,c.cycle_id,p);const old=review(d,c.cycle_id,3).personal.task_id;d.exec('INSERT INTO reward_participants(user_id,enabled) VALUES(3,1)');d.prepare('UPDATE tasks SET points=7 WHERE id=?').run(old);submitAll(d,c.cycle_id);
 const rewards=d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),completion=d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(old);assert.equal(rewards.reduce((sum,r)=>sum+r.delta,0),7);assert.equal(completion.length,1);
 d.prepare('UPDATE meal_person_decisions SET confirmed=0 WHERE beneficiary_user_id=3').run();reconcile(d,c.cycle_id);const r=review(d,c.cycle_id,3);assert.notEqual(r.personal.task_id,old);assert.equal(r.personal.submitted,false);
 assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(old).status,'done');assert.throws(()=>changeTaskStatus(d,old,'open',{actorId:3,body:{expected_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(old).revision}}));
 assert.throws(()=>changeTaskStatus(d,r.personal.task_id,'done',{actorId:3,body:{expected_revision:d.prepare('SELECT revision FROM tasks WHERE id=?').get(r.personal.task_id).revision}}));
 decision(d,c.cycle_id,3,{},'correct');d.prepare('UPDATE tasks SET points=100 WHERE id=?').run(r.personal.task_id);const submit={actorId:3,expectedRevision:review(d,c.cycle_id,3).revision,requestKey:'correction-submit'};cycles.submitCyclePerson(d,c.cycle_id,submit);cycles.submitCyclePerson(d,c.cycle_id,submit);
 assert.equal(d.prepare('SELECT points FROM tasks WHERE id=?').get(r.personal.task_id).points,0);assert.equal(review(d,c.cycle_id,3).personal.submitted,true);assert.equal(reconcile(d,c.cycle_id).changed,false);
 assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),rewards);assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE task_id=?').all(old),completion);assert.equal(d.prepare('SELECT count(*) n FROM task_completions WHERE task_id=?').get(r.personal.task_id).n,1);
 }finally{d.close();}
});
for(const externalTable of ['split_expense_guest_users','housekeeping_workers'])test(`${externalTable} classification supersedes personal work but retains participant history`,()=>{
 const d=fixture();try {const c=ensure(d);const old=review(d,c.cycle_id,3).personal.task_id;d.exec(`INSERT INTO ${externalTable}(user_id) VALUES(3)`);reconcile(d,c.cycle_id);
 assert.equal(d.prepare('SELECT state FROM meal_cycle_task_links WHERE task_id=?').get(old).state,'superseded');assert.ok(d.prepare('SELECT 1 FROM meal_participants WHERE user_id=3').get());assert.ok(d.prepare('SELECT archived_at FROM tasks WHERE id=?').get(old).archived_at);
 }finally{d.close();}
});
test('new canonical occurrences in owned date coverage gain ownership and personal obligations',()=>{
 const d=fixture();try {const c=ensure(d);const id=Number(d.prepare("INSERT INTO meals(date,meal_type,title,scope,scheduled_time,created_by) VALUES('2034-03-07','dinner','New','household','18:00',1)").run().lastInsertRowid);d.prepare("INSERT INTO meal_participants(meal_id,user_id,role,status) VALUES(?,3,'participant','participating')").run(id);reconcile(d,c.cycle_id);
 assert.ok(d.prepare('SELECT 1 FROM meal_cycle_memberships WHERE cycle_id=? AND meal_id=?').get(c.cycle_id,id));assert.ok(review(d,c.cycle_id,3).personal.requirements.some(x=>x.meal_id===id));
 }finally{d.close();}
});
test('finalized changes stage deduplicated signal without rewriting confirmed choices',()=>{
 const d=fixture({}, {presence_required:true});try {const c=ensure(d);main(d,c.cycle_id);d.prepare("UPDATE meal_cycles SET state='finalized',finalized_revision=revision WHERE id=?").run(c.cycle_id);const before=d.prepare('SELECT * FROM meal_participants ORDER BY rowid').all();away(d);const result=reconcile(d,c.cycle_id);assert.equal(result.staged,true);assert.deepEqual(d.prepare('SELECT * FROM meal_participants ORDER BY rowid').all(),before);reconcile(d,c.cycle_id);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_source_changes').get().n,1);
 }finally{d.close();}
});
test('school weekday lunch, holiday override, weekend and no-child household use canonical presence',()=>{
 const d=fixture({}, {meal_type:'lunch',preferred_time:'12:00'});try {
  d.exec("UPDATE users SET family_role='child' WHERE id=3; INSERT INTO availability_rules(user_id,name,weekdays_json,start_time,end_time,state,category) VALUES(3,'School','[0,1,2,3,4]','08:00','15:00','busy','school')");
  const c=ensure(d);reconcile(d,c.cycle_id);assert.equal(review(d,c.cycle_id,3).personal.requirements.find(x=>x.kind==='decision').status,'away');
  d.exec("INSERT INTO availability_periods(user_id,source,state,starts_at,ends_at,category) VALUES(3,'manual','available','2034-03-06T00:00','2034-03-07T00:00','vacation')");reconcile(d,c.cycle_id);assert.equal(review(d,c.cycle_id,3).personal.requirements.find(x=>x.kind==='decision').status,'pending');
  d.exec('DELETE FROM availability_periods');d.exec("UPDATE meals SET date='2034-03-11' WHERE parent_meal_id IS NULL");reconcile(d,c.cycle_id);assert.equal(review(d,c.cycle_id,3).personal.requirements.find(x=>x.meal_id===c.occurrences[0].id&&x.kind==='decision').status,'pending');
 }finally{d.close();}
 const adults=fixture({}, {meal_type:'lunch',preferred_time:'12:00'});try {const c=ensure(adults);reconcile(adults,c.cycle_id);assert.ok(review(adults,c.cycle_id,3).personal.requirements.every(x=>x.status!=='away'));}finally{adults.close();}
});
test('unavailable chooser before main gets targeted correction without another rotation turn',()=>{
 const d=fixture({}, {policy:'round_robin',fixed_user_id:null,presence_required:true});try {const c=ensure(d);const meal=c.occurrences[0].id,original=d.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id=?').get(meal).assigned_user_id;
 const rotations=d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all();away(d,original);reconcile(d,c.cycle_id);const assigned=d.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id=?').get(meal).assigned_user_id;assert.notEqual(assigned,original);assert.ok(assigned);assert.deepEqual(d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),rotations);assert.ok(d.prepare("SELECT 1 FROM meal_cycle_role_corrections WHERE role='chooser'").get());assert.equal(reconcile(d,c.cycle_id).changed,false);
 assert.equal(review(d,c.cycle_id,original).personal.requirements.some(x=>x.kind==='main'),false,'superseded chooser has no obsolete main obligation');
 }finally{d.close();}
});
test('publication and purchase reconciliation never stage a new planning adjustment',()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);for(const p of [1,2,3])decision(d,c.cycle_id,p);d.prepare('INSERT INTO meal_ingredients(meal_id,name,quantity) VALUES(?,?,?)').run(c.occurrences[0].id,'Rice','2 kg');reconcile(d,c.cycle_id);submitAll(d,c.cycle_id);
 const result=finalizeCycle(d,c.cycle_id,{actorId:1,expectedRevision:review(d,c.cycle_id,1).revision,requestKey:'confirm',now});assert.equal(result.grocery_runs.length,1);d.exec('UPDATE shopping_items SET is_checked=1');grocery.syncPurchasesFromShopping(d,result.grocery_runs[0].run_id);assert.equal(reconcile(d,c.cycle_id).changed,false);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_source_changes').get().n,0);
 }finally{d.close();}
});

test('shared rotation activation queues owned meals and recovery reuses its immutable selection',()=>{
 const d=fixture();try {
  const group=shared.saveRotationGroupUsage(d,{name:'Shared dinner order',member_ids:[2,3],usage_mode:'shared',shared_config:{strategy:'rotating_order',starting_member_id:2,effective_date:'2034-03-06',weekdays:[0,1,2,3,4,5,6],active_time:'08:00',finalize_time:'23:00',finalize_day_offset:0,advance_on_skip:false}},{actorId:1});
  const plan=plans.getMealPlan(d,d.prepare('SELECT id FROM meal_plans').get().id);plans.updateMealPlan(d,plan.id,{name:plan.name,rules:plan.rules.map(r=>({...r,policy:'round_robin',fixed_user_id:null,chooser_rotation_group_id:group.id}))},1);
  const c=ensure(d);const occurrence=shared.resolveSharedRotation(d,group.id,{dateKey:'2034-03-06',now:new Date('2034-03-06T08:00:00Z'),actorId:1});const history=d.prepare('SELECT * FROM rotation_occurrences ORDER BY id').all();reconcile(d,c.cycle_id);
  assert.equal(d.prepare('SELECT assigned_user_id FROM meal_occurrence_assignments WHERE meal_id=?').get(c.occurrences[0].id).assigned_user_id,occurrence.selected_member?.id||occurrence.order[0].id);assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences ORDER BY id').all(),history);
 }finally{d.close();}
});

test('empty cook group remains actionable and immutable rotation decisions survive correction',()=>{
 const d=fixture({}, {cook_strategy:'round_robin'});try {
  const group=saveRotationGroup(d,{name:'Cooks',member_ids:[2,3]},{actorId:1});
  // Configure before materialization through the canonical plan update API.
  const {getMealPlan,updateMealPlan}=plans;const plan=getMealPlan(d,d.prepare("SELECT id FROM meal_plans WHERE name='Dinners'").get().id);updateMealPlan(d,plan.id,{name:plan.name,rules:plan.rules.map(r=>({...r,cook_rotation_group_id:group.id,cook_strategy:'round_robin'}))},1);
  const c=ensure(d);main(d,c.cycle_id);const history=d.prepare('SELECT * FROM rotation_occurrences ORDER BY id').all();away(d,2);away(d,3);reconcile(d,c.cycle_id);
  assert.equal(JSON.parse(d.prepare('SELECT provenance_json FROM meals WHERE id=?').get(c.occurrences[0].id).provenance_json).rotations.cook.state,'needs_assignment');assert.deepEqual(d.prepare('SELECT * FROM rotation_occurrences ORDER BY id').all(),history);
 }finally{d.close();}
});

function executionFixture() {
 const d=fixture({}, {cook_strategy:'fixed',cook_user_id:2,generate_preparation:true,generate_cooking:true,generate_supervision:false,generate_serving:false,generate_cleanup:false,execution_assignment_strategies:{preparation:'cook',cooking:'cook'}});
 d.exec('UPDATE meal_execution_settings SET enabled=1,generate_preparation=1,generate_cooking=1,generate_supervision=0,generate_serving=0,generate_cleanup=0');const c=ensure(d);main(d,c.cycle_id);const meal=c.occurrences[0].id;
 const output=withCycleMealWrite(d,c.cycle_id,()=>ensureMealExecution(d,meal,1));return {d,c,meal,output};
}
test('untouched execution assignment refresh consumes no extra turn and ignores unrelated traveler',()=>{
 const {d,c,meal,output}=executionFixture();try {const first=output.tasks[0].task_id;away(d,3);reconcile(d,c.cycle_id);assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(first).assigned_to,2);
 away(d,2);reconcile(d,c.cycle_id);assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(first).assigned_to,1);assert.equal(d.prepare('SELECT count(*) n FROM meal_execution_tasks').get().n,2);
 }finally{d.close();}
});
for(const status of ['in_progress','done','expired','archived','deleted','frozen'])test(`one ${status} sibling protects all execution output history`,()=>{
 const {d,c,meal,output}=executionFixture();try {const first=output.tasks[0].task_id;
 if(status==='archived')d.prepare("UPDATE tasks SET archived_at='2034-03-03T09:00:00Z' WHERE id=?").run(first);
 else if(status==='deleted')d.prepare('DELETE FROM tasks WHERE id=?').run(first);
 else if(status==='frozen')d.prepare("UPDATE meal_execution_snapshots SET frozen_at='2034-03-03T09:00:00Z' WHERE id=?").run(output.id);
 else d.prepare('UPDATE tasks SET status=? WHERE id=?').run(status,first);
 d.prepare('DELETE FROM meal_execution_tasks WHERE id=?').run(output.tasks[1].id);
 const before=d.prepare('SELECT * FROM meal_execution_tasks ORDER BY id').all();away(d,2);reconcile(d,c.cycle_id);assert.deepEqual(d.prepare('SELECT * FROM meal_execution_tasks ORDER BY id').all(),before);assert.equal(previewMealExecution(d,meal).frozen,true);
 }finally{d.close();}
});
test('canonical draft Save invalidates submitted work even after source fingerprint is freshly sealed',()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);for(const p of [1,2,3])decision(d,c.cycle_id,p);submitAll(d,c.cycle_id);const old=review(d,c.cycle_id,3).personal.task_id;
 decision(d,c.cycle_id,3,{confirmed:false},'draft-after-submit');assert.equal(review(d,c.cycle_id,3).blockers.some(x=>x.code==='CYCLE_SOURCE_CHANGED'),false);
 reconcile(d,c.cycle_id);const r=review(d,c.cycle_id,3);assert.notEqual(r.personal.task_id,old);assert.equal(r.personal.submitted,false);assert.equal(d.prepare('SELECT status FROM tasks WHERE id=?').get(old).status,'done');assert.equal(reconcile(d,c.cycle_id).changed,false);
 }finally{d.close();}
});
test('untouched round robin output reassignment preserves committed execution cursor',()=>{
 const d=fixture({}, {generate_cooking:true,generate_preparation:false,generate_supervision:false,generate_serving:false,generate_cleanup:false,execution_assignment_strategies:{cooking:'eligible_round_robin'}});try {
 d.exec('UPDATE meal_execution_settings SET enabled=1,generate_cooking=1,generate_preparation=0,generate_supervision=0,generate_serving=0,generate_cleanup=0');const c=ensure(d);main(d,c.cycle_id);const meal=c.occurrences[0].id,first=withCycleMealWrite(d,c.cycle_id,()=>ensureMealExecution(d,meal,1));const task=first.tasks[0];const rotations=d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all();away(d,task.assigned_to);reconcile(d,c.cycle_id);assert.notEqual(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(task.task_id).assigned_to,task.assigned_to);assert.deepEqual(d.prepare('SELECT * FROM assignment_rotation_state ORDER BY rotation_key').all(),rotations);
 }finally{d.close();}
});
test('explicit administrator recovery replaces invalid coordinator and shopper without changing global settings',()=>{
 const d=fixture();try {const c=ensure(d);d.exec("UPDATE users SET role='admin' WHERE id=2; INSERT INTO split_expense_guest_users(user_id) VALUES(1)");reconcile(d,c.cycle_id);assert.equal(JSON.parse(d.prepare('SELECT settings_json FROM meal_cycles').get().settings_json).coordinator_id,1);
 assert.equal(typeof service.recoverCycleAssignments,'function');const options={actorId:2,expectedRevision:d.prepare('SELECT revision FROM meal_cycles').get().revision,requestKey:'recover',coordinatorId:2,shoppingAssigneeId:2,now};assert.throws(()=>service.recoverCycleAssignments(d,c.cycle_id,{...options,actorId:3}),{status:403});const recovered=service.recoverCycleAssignments(d,c.cycle_id,options);assert.deepEqual(service.recoverCycleAssignments(d,c.cycle_id,options),recovered);
 assert.equal(JSON.parse(d.prepare('SELECT settings_json FROM meal_cycles').get().settings_json).coordinator_id,2);assert.equal(JSON.parse(d.prepare('SELECT settings_json FROM meal_cycle_settings').get().settings_json).coordinator_id,1);
 assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='review' AND state='active'").get().n,1);assert.equal(d.prepare("SELECT beneficiary_id FROM meal_cycle_task_links WHERE purpose='review' AND state='active'").get().beneficiary_id,2);
 }finally{d.close();}
});
test('new occurrence with pre-existing output history remains an actionable adoption blocker',()=>{
 const {d,c}=executionFixture();try {
 const root=Number(d.prepare("INSERT INTO meals(date,meal_type,title,scope,scheduled_time,selection_status,created_by) VALUES('2034-03-07','dinner','Late root','household','18:00','selected',1)").run().lastInsertRowid);
 d.prepare("INSERT INTO meal_participants(meal_id,user_id,role,status) VALUES(?,1,'participant','participating'),(?,1,'cook','participating')").run(root,root);
 ensureMealExecution(d,root,1);reconcile(d,c.cycle_id);
 assert.ok(reviewCycleReadiness(d,c.cycle_id,{actorId:1,now}).blockers.some(x=>x.code==='CYCLE_ADOPTION_REVIEW_REQUIRED'&&x.meal_id===root));
 }finally{d.close();}
});
test('late canonical plan within cycle coverage materializes and adds required personal work',()=>{
 const d=fixture();try {const c=ensure(d);plans.createMealPlan(d,{name:'New Tuesday lunch',rules:[{weekday:1,meal_type:'lunch',policy:'fixed',fixed_user_id:3,participant_ids:[3],preferred_time:'12:00'}]},1);reconcile(d,c.cycle_id);
 assert.equal(review(d,c.cycle_id,3).occurrences.length,2);assert.ok(review(d,c.cycle_id,3).personal.requirements.some(x=>x.kind==='main'));
 }finally{d.close();}
});
for(const travelers of [[3],[1,2,3]])test(`late ${travelers.length===3?'whole':'partial'} household trip splits canonical meals without losing saved answers`,()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);decision(d,c.cycle_id,3);const saved=d.prepare('SELECT * FROM meal_person_decisions WHERE beneficiary_user_id=3').get();
 const trip=savePlanningContext(d,{context_key:'late-trip',name:'Private destination',context_type:'travel',starts_at:'2034-03-06T00:00:00',ends_at:'2034-03-07T00:00:00',member_ids:travelers},1);plans.attachMealPlanToContext(d,d.prepare('SELECT id FROM meal_plans').get().id,trip.id,{},1);reconcile(d,c.cycle_id);
 const r=review(d,c.cycle_id,3),home=r.occurrences.find(m=>!m.planning_context_id),travel=r.occurrences.find(m=>m.planning_context_id===trip.id);assert.ok(travel);assert.equal(r.personal.requirements.find(x=>x.meal_id===home.id&&x.kind==='decision').contribution,0);assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions WHERE id=?').get(saved.id),saved);
 const counts=d.prepare('SELECT count(*) n FROM meal_cycle_task_links').get().n;assert.equal(reconcile(d,c.cycle_id).changed,false);assert.equal(d.prepare('SELECT count(*) n FROM meal_cycle_task_links').get().n,counts);
 }finally{d.close();}
});
test('permission-only cook recovery uses permitted alternatives; finalized permission changes only stage',()=>{
 const {d,c,meal,output}=executionFixture();try {
  d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','tasks','none')");
  assert.ok(d.prepare("SELECT 1 FROM meal_cycle_events WHERE dedup_key LIKE '%access_permissions' AND status='pending'").get());reconcile(d,c.cycle_id);
  assert.equal(d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(output.tasks[0].task_id).assigned_to,1);
  d.prepare("UPDATE meal_cycles SET state='finalized',finalized_revision=revision WHERE id=?").run(c.cycle_id);
  const before=d.prepare('SELECT * FROM meal_execution_tasks').all();d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','3','module','tasks','none')");assert.equal(reconcile(d,c.cycle_id).staged,true);assert.deepEqual(d.prepare('SELECT * FROM meal_execution_tasks').all(),before);
 }finally{d.close();}
});
test('all execution skill dependencies including cleanup stage finalized eligibility changes',()=>{
 const d=fixture({}, {generate_cleanup:true,execution_assignment_strategies:{cleanup:'eligible_round_robin'}});try {const c=ensure(d);main(d,c.cycle_id);reconcile(d,c.cycle_id);d.prepare("UPDATE meal_cycles SET state='finalized',finalized_revision=revision WHERE id=?").run(c.cycle_id);
 d.exec("UPDATE skills SET active=0 WHERE system_key='cleanup'");assert.equal(reconcile(d,c.cycle_id).staged,true);
 }finally{d.close();}
});
test('failed correction transaction rolls back source application and retries exactly once',()=>{
 const d=fixture();try {const c=ensure(d);main(d,c.cycle_id);for(const p of [1,2,3])decision(d,c.cycle_id,p);submitAll(d,c.cycle_id);d.exec('UPDATE meal_person_decisions SET confirmed=0 WHERE beneficiary_user_id=3');
 const original=d.prepare('SELECT * FROM meal_cycle_task_links ORDER BY id').all();d.exec("CREATE TRIGGER fail_correction BEFORE INSERT ON meal_cycle_task_links WHEN NEW.purpose='correction' BEGIN SELECT RAISE(ABORT,'injected correction failure'); END");assert.throws(()=>reconcile(d,c.cycle_id),/injected correction failure/);assert.deepEqual(d.prepare('SELECT * FROM meal_cycle_task_links ORDER BY id').all(),original);
 d.exec('DROP TRIGGER fail_correction');runMealCycleScheduler(d,{now});runMealCycleScheduler(d,{now});assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_task_links WHERE purpose='correction'").get().n,1);assert.equal(review(d,c.cycle_id,3).personal.submitted,false);
 assert.ok(reviewCycleReadiness(d,c.cycle_id,{actorId:1,now}).blockers.some(x=>x.code==='PERSONAL_SUBMISSION_REQUIRED'&&x.beneficiary_id===3));
 }finally{d.close();}
});
