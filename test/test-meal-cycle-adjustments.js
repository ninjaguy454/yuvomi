import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ensure,review,save,decision,submitAll,cycles} from './meal-cycle-finalization-fixture.js';
import {finalizeCycle} from '../server/services/meal-cycle-finalization.js';
import {updatePurchase,loadGroceryRun,loadSourceIngredients} from '../server/services/meal-grocery-runs.js';
import {reconcileCycle} from '../server/services/meal-cycle-reconciliation.js';
import {savePlanningContext} from '../server/services/planning-contexts.js';
import {attachMealPlanToContext} from '../server/services/meal-plans.js';
const api=await import('../server/services/meal-cycle-adjustments.js').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));
const now='2034-03-04T19:00:00.000Z';
function ready({execution=false}={}){
 const d=fixture({},execution?{generate_cooking:true,execution_assignment_strategies:{cooking:'open_claimable'}}:{});if(execution)d.exec('UPDATE meal_execution_settings SET enabled=1,generate_cooking=1');d.exec("INSERT INTO recipes(id,title,yield_portions,created_by) VALUES(90,'Rice dinner',1,1); INSERT INTO recipe_ingredients(recipe_id,name,quantity) VALUES(90,'Rice','1 kg')");
 const id=ensure(d).cycle_id,m=review(d,id).occurrences[0].id;
 save(d,id,[{meal_id:m,kind:'main',title:'Rice dinner',recipe_id:90}]);
 for(const p of [1,2,3])decision(d,id,p,{portion_amount:p===2?3:1});
 d.exec('INSERT INTO reward_participants(user_id,enabled) VALUES(3,1)');d.prepare("UPDATE tasks SET points=7 WHERE id=(SELECT task_id FROM meal_cycle_task_links WHERE beneficiary_id=3 AND purpose='personal')").run();submitAll(d,id);
 const result=finalizeCycle(d,id,{actorId:1,expectedRevision:review(d,id,1).revision,requestKey:'finalize',now});
 return {d,id,m,result};
}
const options=(d,id,key,actorId=2)=>({actorId,expectedRevision:review(d,id,actorId).revision,requestKey:key,now});
const propose=(d,id,m,amount,key='proposal',extra={})=>{assert.equal(typeof api.proposeCycleAdjustment,'function');return api.proposeCycleAdjustment(d,id,{...options(d,id,key),changes:[{meal_id:m,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,portion_amount:amount}}],...extra});};
const apply=(d,id,p,key='apply')=>api.applyCycleAdjustment(d,id,{...options(d,id,key,1),proposalId:p.proposal_id});
const quantities=d=>d.prepare('SELECT quantity FROM shopping_items ORDER BY id').all().map(x=>x.quantity);
test('confirmed effective baseline is immutable and 5 -> 3 -> 4 reconciles amended outstanding demand',()=>{
 const {d,id,m}=ready(),original=d.prepare("SELECT * FROM meal_cycle_results WHERE kind='finalization'").get();
 assert.equal(JSON.parse(original.input_json).effective.occurrences[0].id,m);
 const meals=d.prepare('SELECT * FROM meals ORDER BY id').all(),p=propose(d,id,m,1);
 assert.deepEqual(d.prepare('SELECT * FROM meals ORDER BY id').all(),meals);assert.deepEqual(quantities(d),['5 kg']);
 assert.equal(p.desired.ingredients[0].quantity,'3 kg');apply(d,id,p);assert.deepEqual(quantities(d),['3 kg']);
 const q=propose(d,id,m,2,'increase');const o={...options(d,id,'increase-apply',1),proposalId:q.proposal_id};
 api.applyCycleAdjustment(d,id,o);api.applyCycleAdjustment(d,id,o);assert.equal(quantities(d).reduce((n,x)=>n+parseFloat(x),0),4);
 assert.deepEqual(d.prepare("SELECT * FROM meal_cycle_results WHERE kind='finalization'").get(),original);d.close();
});
test('own proposals preserve canonical authority; coordinator applies and stale purchase or canceled proposals reject',()=>{
 const {d,id,m,result}=ready();
 assert.throws(()=>propose(d,id,m,1,'other',{beneficiaryId:3}),/permission|administrator|beneficiary/i);
 assert.throws(()=>api.proposeCycleAdjustment(d,id,{...options(d,id,'shared',3),changes:[{meal_id:m,kind:'main',title:'Stolen'}]}),/chooser|permission|allowed/i);
 assert.throws(()=>api.proposeCycleAdjustment(d,id,{...options(d,id,'ingredients-other',3),changes:[{meal_id:m,kind:'ingredients',ingredients:[]}]}),/chooser|permission|allowed/i);
 const p=propose(d,id,m,1);assert.throws(()=>api.applyCycleAdjustment(d,id,{...options(d,id,'unauthorized'),proposalId:p.proposal_id}),/permission|coordinator/i);
 const item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];updatePurchase(d,item.grocery_run_id,item.id,{purchasedQuantity:2,remainingQuantity:3,purchaseStatus:'partial'});
 assert.throws(()=>apply(d,id,p),/stale|changed/i);const q=propose(d,id,m,1,'protected');const r=apply(d,id,q,'protected-apply');assert.ok(r.preserved.length);assert.deepEqual(quantities(d),['5 kg']);
 const c=propose(d,id,m,2,'cancel');api.cancelCycleAdjustment(d,id,{...options(d,id,'cancel-it'),proposalId:c.proposal_id});assert.throws(()=>apply(d,id,c,'cancel-apply'),/cancel|pending|revision/i);d.close();
});
export {ready,options,propose,apply,now};

for(const travelers of [[3],[1,2,3]])test(`post-confirmation ${travelers.length} traveler new choices use stable pending identities and preserve old records`,()=>{
 const {d,id,m}=ready();
 const tables=['meals','meal_participants','meal_menu_items','meal_person_decisions','meal_execution_snapshots','meal_grocery_items'];
 const before=Object.fromEntries(tables.map(t=>[t,d.prepare(`SELECT rowid AS test_rowid,* FROM ${t} ORDER BY rowid`).all()]));
 const trip=savePlanningContext(d,{context_key:'adjustment-trip',name:'Travel',context_type:'travel',starts_at:'2034-03-06T00:00:00',ends_at:'2034-03-07T00:00:00',member_ids:travelers},1);
 attachMealPlanToContext(d,d.prepare('SELECT id FROM meal_plans').get().id,trip.id,{},1);
 const recovered=reconcileCycle(d,id,{now});assert.ok(recovered.proposal_id,JSON.stringify(recovered));
 const travel=d.prepare('SELECT id FROM meals WHERE planning_context_id=? AND parent_meal_id IS NULL').get(trip.id).id;
 for(const t of tables)for(const row of before[t])assert.deepEqual(d.prepare(`SELECT rowid AS test_rowid,* FROM ${t} WHERE rowid=?`).get(row.test_rowid),row);
 const staged=api.reviewCycleAdjustment(d,id,{actorId:1});assert.ok(staged.blockers.some(x=>x.meal_id===travel));
 assert.ok(staged.baseline.effective.occurrences.every(x=>x.id!==travel));assert.equal(staged.desired.occurrences.find(x=>x.id===m).participants.find(p=>p.user_id===3).status,'away');
 assert.throws(()=>save(d,id,[{meal_id:travel,kind:'main',title:'Bypass'}],'bypass'),/confirmed/i);
 const count=d.prepare('SELECT count(*) n FROM tasks').get().n;assert.equal(reconcileCycle(d,id,{now}).proposal_id,recovered.proposal_id);assert.equal(d.prepare('SELECT count(*) n FROM tasks').get().n,count);
 api.cancelCycleAdjustment(d,id,{...options(d,id,'cancel-source',1),proposalId:recovered.proposal_id});const recovery=reconcileCycle(d,id,{now});assert.ok(recovery.proposal_id!==recovered.proposal_id);assert.equal(d.prepare('SELECT id FROM meals WHERE planning_context_id=? AND parent_meal_id IS NULL').get(trip.id).id,travel);
 let p=api.reviewCycleAdjustment(d,id,{actorId:1});
 const chooser=p.desired.occurrences.find(x=>x.id===travel).choosers[0].user_id;
 p=api.proposeCycleAdjustment(d,id,{...options(d,id,'trip-main',chooser),baseProposalId:p.proposal_id,changes:[{meal_id:travel,kind:'main',title:'Rice dinner',recipe_id:90}]});
 for(const person of travelers){p=api.proposeCycleAdjustment(d,id,{...options(d,id,`trip-choice-${person}`,person),baseProposalId:p.proposal_id,changes:[{meal_id:travel,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,portion_amount:1,select_shared_main:true}}]});}
 assert.equal(typeof api.submitCycleAdjustmentPerson,'function');
 const links=d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE 'adjustment:response:%' AND state='active'").all(id);
 const ledger=d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),completions=d.prepare('SELECT * FROM task_completions ORDER BY id').all();assert.equal(ledger.reduce((n,x)=>n+x.delta,0),7);
 for(const l of links){d.prepare('UPDATE tasks SET points=100 WHERE id=?').run(l.task_id);const o={...options(d,id,`trip-submit-${l.beneficiary_id}`,l.beneficiary_id),proposalId:p.proposal_id};api.submitCycleAdjustmentPerson(d,id,o);api.submitCycleAdjustmentPerson(d,id,o);assert.equal(d.prepare('SELECT count(*) n FROM task_completions WHERE task_id=?').get(l.task_id).n,1);}
 assert.deepEqual(d.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),ledger);for(const completion of completions)assert.deepEqual(d.prepare('SELECT * FROM task_completions WHERE id=?').get(completion.id),completion);
 apply(d,id,p,'trip-apply');assert.equal(d.prepare('SELECT state FROM meal_cycles WHERE id=?').get(id).state,'finalized');assert.ok(d.prepare('SELECT accepted_revision FROM meal_cycle_pending_occurrences WHERE meal_id=?').get(travel).accepted_revision);
 assert.equal(d.prepare('SELECT count(*) n FROM meal_person_decisions WHERE meal_id=?').get(travel).n,travelers.length);d.close();
});

test('manual edits and purchases survive reduction and later demand only adds unmet amount',()=>{
 for(const mode of ['manual','purchased']){const {d,id,m,result}=ready();const item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
  if(mode==='manual')d.prepare("UPDATE shopping_items SET notes='Keep brand' WHERE id=?").run(item.shopping_item_id);
  if(mode==='purchased')updatePurchase(d,item.grocery_run_id,item.id,{purchasedQuantity:5,remainingQuantity:0,purchaseStatus:'purchased'});
  const before=d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id);let p=propose(d,id,m,1);assert.ok(apply(d,id,p).preserved.length);assert.deepEqual(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),before);
  p=propose(d,id,m,2,'back-four');apply(d,id,p,'back-four-apply');assert.deepEqual(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),before);assert.equal(d.prepare('SELECT count(*) n FROM shopping_items').get().n,1);
  p=propose(d,id,m,4,'to-six');apply(d,id,p,'to-six-apply');assert.equal(quantities(d).reduce((n,x)=>n+parseFloat(x),0),6);d.close();
 }
});
test('newly started cooking invalidates a proposal; restaging preserves the whole frozen snapshot and Tasks',()=>{
 const {d,id,m}=ready({execution:true});const p=propose(d,id,m,1);d.exec("UPDATE tasks SET status='in_progress' WHERE id IN (SELECT task_id FROM meal_execution_tasks)");
 assert.throws(()=>apply(d,id,p),/stale|changed/i);
 const snapshots=d.prepare('SELECT * FROM meal_execution_snapshots').all(),tasks=d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all();
 const q=propose(d,id,m,1,'frozen');assert.ok(apply(d,id,q,'frozen-apply').preserved.some(x=>x.reason==='frozen_execution'));
 assert.deepEqual(d.prepare('SELECT * FROM meal_execution_snapshots').all(),snapshots);assert.deepEqual(d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all(),tasks);d.close();
});
test('source reversion retires obsolete staged signal and proposal without changing the confirmed meal',()=>{
 const {d,id,m}=ready();const meal=d.prepare('SELECT * FROM meals WHERE id=?').get(m);
 d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');const a=reconcileCycle(d,id,{now});assert.ok(a.proposal_id);
 d.exec('UPDATE recipes SET yield_portions=1 WHERE id=90');reconcileCycle(d,id,{now});
 assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_source_changes WHERE status='pending'").get().n,0);
 assert.equal(d.prepare("SELECT count(*) n FROM meal_cycle_adjustments WHERE status='pending' AND source_change_id IS NOT NULL").get().n,0);
 assert.deepEqual(d.prepare('SELECT * FROM meals WHERE id=?').get(m),meal);d.close();
});
test('apply rechecks original authors and rolls back accepted choices after downstream failure',()=>{
 const {d,id,m}=ready();let p=propose(d,id,m,4);d.exec("INSERT INTO access_permissions(subject_type,subject_id,resource_type,resource_key,access) VALUES('user','2','module','meals','none')");assert.throws(()=>apply(d,id,p),/stale|permission|changed/i);d.exec("DELETE FROM access_permissions WHERE subject_type='user' AND subject_id='2' AND resource_key='meals'");
 p=propose(d,id,m,4,'retry');const before=d.prepare('SELECT * FROM meal_person_decisions ORDER BY id').all(),shop=d.prepare('SELECT * FROM shopping_items').all();
 d.exec("CREATE TRIGGER adjustment_rollback AFTER INSERT ON shopping_items BEGIN SELECT RAISE(ABORT,'adjustment injected failure'); END");assert.throws(()=>apply(d,id,p,'rollback'),/injected failure/);assert.deepEqual(d.prepare('SELECT * FROM meal_person_decisions ORDER BY id').all(),before);assert.deepEqual(d.prepare('SELECT * FROM shopping_items').all(),shop);d.exec('DROP TRIGGER adjustment_rollback');apply(d,id,p,'rollback');assert.equal(quantities(d).reduce((n,x)=>n+parseFloat(x),0),6);d.close();
});
test('a shared Shopping row keeps foreign source attribution and only adds unmet owned demand',()=>{
 const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
 d.exec("INSERT INTO meals(id,date,meal_type,title,created_by) VALUES(501,'2034-03-06','dinner','Outside cycle',1)");
 d.prepare("INSERT INTO meal_grocery_item_sources(grocery_item_id,source_key,source_kind,meal_id,meal_date_snapshot,meal_title_snapshot,ingredient_name_snapshot,quantity_snapshot,category_snapshot) VALUES(?,'foreign','meal_ingredient',501,'2034-03-06','Outside cycle','Rice','1 kg','Sonstiges')").run(item.id);
 d.prepare("UPDATE meal_grocery_items SET quantity='6 kg',planned_quantity=6,remaining_quantity=6 WHERE id=?").run(item.id);d.prepare("UPDATE shopping_items SET quantity='6 kg' WHERE id=?").run(item.shopping_item_id);
 d.prepare('UPDATE meal_grocery_output_state SET credited_quantity=6,shopping_json=? WHERE grocery_item_id=?').run(JSON.stringify(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id)),item.id);
 let p=propose(d,id,m,1);const r=apply(d,id,p);assert.ok(r.preserved.some(x=>x.reason==='mixed_ownership'));assert.deepEqual(quantities(d),['6 kg']);
 p=propose(d,id,m,4,'owned-six');apply(d,id,p,'owned-six-apply');assert.deepEqual(quantities(d),['6 kg','1 kg']);d.close();
});
test('real purchased amount, not planned whole run, determines later unmet demand',()=>{
 for(const purchased of [2,7]){const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];updatePurchase(d,item.grocery_run_id,item.id,{purchasedQuantity:purchased,remainingQuantity:0,purchaseStatus:'purchased'});const p=propose(d,id,m,6);apply(d,id,p);assert.equal(parseFloat(quantities(d).at(-1)),8-purchased);d.close();}
});
test('pure ingredient demand refreshes explicit recipe yield without rewriting a recipe or materialized meal',()=>{
 const {d,m}=ready();const meal=d.prepare('SELECT * FROM meal_ingredients WHERE meal_id=?').all(m);d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');const recipe=d.prepare('SELECT * FROM recipes WHERE id=90').get();
 assert.equal(loadSourceIngredients(d,'2034-03-06','2034-03-12',[m])[0].quantity,'2.5 kg');assert.deepEqual(d.prepare('SELECT * FROM recipes WHERE id=90').get(),recipe);assert.deepEqual(d.prepare('SELECT * FROM meal_ingredients WHERE meal_id=?').all(m),meal);d.close();
});
test('late source review preserves begun-meal groceries instead of treating history as removed future demand',()=>{
 const {d,id}=ready();const shopping=d.prepare('SELECT * FROM shopping_items').all();d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');const late='2034-03-07T19:00:00.000Z';
 const recovered=reconcileCycle(d,id,{now:late});assert.ok(recovered.proposal_id);const p=api.reviewCycleAdjustment(d,id,{actorId:1});assert.ok(p.preserved.some(x=>x.reason==='begun_meal_history'));
 api.applyCycleAdjustment(d,id,{...options(d,id,'late',1),now:late,proposalId:p.proposal_id});assert.deepEqual(d.prepare('SELECT * FROM shopping_items').all(),shopping);d.close();
});
test('recipe-yield refresh, explicit empty override removal and changed source invalidate staged proposals',()=>{
 const {d,id,m}=ready({execution:true});const p=propose(d,id,m,1);d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');assert.throws(()=>apply(d,id,p),/stale|changed/i);
 const recovered=reconcileCycle(d,id,{now});assert.ok(recovered.proposal_id);let preview=api.reviewCycleAdjustment(d,id,{actorId:1});assert.equal(preview.desired.ingredients[0].quantity,'2.5 kg');apply(d,id,preview,'yield');assert.deepEqual(quantities(d),['2.5 kg']);
 preview=api.proposeCycleAdjustment(d,id,{...options(d,id,'manual-empty'),changes:[{meal_id:m,kind:'ingredients',ingredients:[]}]});assert.deepEqual(preview.desired.ingredients,[]);
 assert.ok(preview.blockers.some(b=>b.code==='INGREDIENT_REVIEW_REQUIRED'));
 const acknowledged=api.proposeCycleAdjustment(d,id,{...options(d,id,'empty-ack',1),baseProposalId:preview.proposal_id,changes:[],acknowledgeMealIds:[m]});apply(d,id,acknowledged,'empty-apply');assert.deepEqual(quantities(d),[]);assert.deepEqual(JSON.parse(d.prepare('SELECT snapshot_json FROM meal_execution_snapshots WHERE meal_id=?').get(m).snapshot_json).ingredients,[]);d.close();
});
test('same-title new recipe identity is reviewed with new choices and only unmet ingredient demand is published',()=>{
 const {d,id,m}=ready();d.exec("INSERT INTO recipes(id,title,yield_portions,created_by) VALUES(91,'Rice dinner',1,1); INSERT INTO recipe_ingredients(recipe_id,name,quantity) VALUES(91,'Rice','2 kg')");
 let p=api.proposeCycleAdjustment(d,id,{...options(d,id,'recipe-change'),changes:[{meal_id:m,kind:'main',title:'Rice dinner',recipe_id:91}]});
 assert.equal(d.prepare('SELECT recipe_id FROM meals WHERE id=?').get(m).recipe_id,90);assert.equal(p.desired.occurrences[0].recipe_id,91);
 for(const person of [1,2,3])p=api.proposeCycleAdjustment(d,id,{...options(d,id,`new-recipe-choice-${person}`,person),baseProposalId:p.proposal_id,changes:[{meal_id:m,kind:'decision',decision:{participation:'participating',choice_kind:'household',confirmed:true,portion_amount:person===2?3:1,select_shared_main:true}}]});
 assert.deepEqual(p.blockers.filter(b=>['MAIN_REQUIRED','RESPONSE_REQUIRED'].includes(b.code)),[],JSON.stringify(p.desired.occurrences.map(m=>({shared:m.shared_choice_active,generation:m.current_menu_generation,decisions:m.decisions}))));
 for(const l of d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE 'adjustment:response:%' AND state='active'").all(id))api.submitCycleAdjustmentPerson(d,id,{...options(d,id,`new-recipe-submit-${l.beneficiary_id}`,l.beneficiary_id),proposalId:p.proposal_id});
 apply(d,id,p,'new-recipe-apply');assert.equal(d.prepare('SELECT recipe_id FROM meals WHERE id=?').get(m).recipe_id,91);assert.equal(quantities(d).reduce((n,x)=>n+parseFloat(x),0),10);d.close();
});
test('zero-demand cooking work is explicitly preserved for review while unchecked grocery demand is removed',()=>{
 const {d,id,m}=ready({execution:true});const outputs=d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all();let p=null;
 for(const person of [1,2,3])p=api.proposeCycleAdjustment(d,id,{...options(d,id,`skip-${person}`,person),baseProposalId:p?.proposal_id,changes:[{meal_id:m,kind:'decision',decision:{participation:'not_participating'}}]});
 const result=apply(d,id,p);assert.deepEqual(quantities(d),[]);assert.ok(result.preserved.some(x=>x.reason==='no_current_demand_execution'&&x.task_links.length));assert.equal(result.requires_manual_review,true);assert.equal(d.prepare('SELECT attempt_status FROM meal_cycles WHERE id=?').get(id).attempt_status,'review_required');assert.deepEqual(d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all(),outputs);d.close();
});

test('R1 source reversion retains accepted unresolved cooking conflicts and is idempotent',()=>{
 const {d,id,m}=ready({execution:true});let p=null;
 for(const person of [1,2,3])p=api.proposeCycleAdjustment(d,id,{...options(d,id,`r1-skip-${person}`,person),baseProposalId:p?.proposal_id,changes:[{meal_id:m,kind:'decision',decision:{participation:'not_participating'}}]});
 apply(d,id,p);const before=d.prepare('SELECT blockers_json FROM meal_cycles WHERE id=?').get(id).blockers_json;
 const tasks=d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all();
 d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');reconcileCycle(d,id,{now});
 d.exec('UPDATE recipes SET yield_portions=1 WHERE id=90');reconcileCycle(d,id,{now});
 const cycle=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(id);assert.equal(cycle.attempt_status,'review_required');assert.equal(cycle.blockers_json,before);
 assert.ok(JSON.parse(before).some(x=>x.reason==='no_current_demand_execution'&&x.task_links.length));
 reconcileCycle(d,id,{now});assert.deepEqual(d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(id),cycle);assert.deepEqual(d.prepare('SELECT t.* FROM tasks t JOIN meal_execution_tasks e ON e.task_id=t.id').all(),tasks);d.close();
});

test('R2 source reversion atomically restores surviving authored proposal and every active action link',()=>{
 const {d,id,m}=ready();const own=propose(d,id,m,1);
 d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');const source=reconcileCycle(d,id,{now});assert.notEqual(source.proposal_id,own.proposal_id);
 d.exec('UPDATE recipes SET yield_portions=1 WHERE id=90');reconcileCycle(d,id,{now});
 const current=api.reviewCycleAdjustment(d,id,{actorId:1});assert.equal(current.proposal_id,own.proposal_id);assert.equal(current.status,'pending');assert.equal(current.stale,false);
 const links=()=>d.prepare("SELECT a.* FROM task_action_links a JOIN meal_cycle_task_links l ON l.task_id=a.task_id WHERE l.cycle_id=? AND l.state='active' AND l.obligation_key LIKE 'adjustment:%'").all(id);
 assert.ok(links().length);assert.ok(links().every(x=>JSON.parse(x.params_json).proposal===own.proposal_id));
 const before=links(),revision=review(d,id).revision,count=d.prepare('SELECT count(*) n FROM tasks').get().n;
 reconcileCycle(d,id,{now});assert.equal(review(d,id).revision,revision);assert.deepEqual(links(),before);assert.equal(d.prepare('SELECT count(*) n FROM tasks').get().n,count);
 apply(d,id,own,'r2-apply');assert.deepEqual(quantities(d),['3 kg']);d.close();
});

test('R3 manual shortfall is protected and only verified sole-source same-unit coverage offsets growth',()=>{
 for(const quantity of ['2 kg','2 bags','some']){const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
  d.prepare('UPDATE shopping_items SET quantity=? WHERE id=?').run(quantity,item.shopping_item_id);const before=d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id);
  const p=propose(d,id,m,4);assert.ok(p.preserved.some(x=>x.grocery_item_id===item.id&&x.reason==='manually_edited'));
  const r=apply(d,id,p);assert.equal(r.requires_manual_review,true);assert.equal(d.prepare('SELECT attempt_status FROM meal_cycles WHERE id=?').get(id).attempt_status,'review_required');assert.deepEqual(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),before);
  const conflict=r.preserved.find(x=>x.grocery_item_id===item.id);assert.equal(conflict.historical_quantity,5);assert.equal(conflict.actual_quantity,quantity);
  if(quantity==='2 kg'){assert.equal(conflict.coverage_quantity,2);assert.equal(conflict.coverage_status,'verified');assert.deepEqual(quantities(d),['2 kg','4 kg']);}
  else {assert.equal(conflict.coverage_status,'unverified');assert.equal(conflict.coverage_quantity,null);assert.equal(conflict.additions_deferred,true);assert.equal(conflict.demand_quantity,6);assert.deepEqual(conflict.meal_ids,[m]);assert.ok(conflict.shopping_link.startsWith('/shopping?list='));assert.deepEqual(quantities(d),[quantity]);}
  assert.equal(d.prepare('SELECT credited_quantity FROM meal_grocery_output_state WHERE grocery_item_id=?').get(item.id).credited_quantity,5);d.close();
 }
});

test('R1 source reversion also retains accepted manual Shopping discrepancies',()=>{
 const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
 d.prepare("UPDATE shopping_items SET quantity='2 bags' WHERE id=?").run(item.shopping_item_id);apply(d,id,propose(d,id,m,4));
 const before=d.prepare('SELECT blockers_json FROM meal_cycles WHERE id=?').get(id).blockers_json;
 d.exec('UPDATE recipes SET yield_portions=2 WHERE id=90');reconcileCycle(d,id,{now});d.exec('UPDATE recipes SET yield_portions=1 WHERE id=90');reconcileCycle(d,id,{now});
 const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(id);assert.equal(c.attempt_status,'review_required');assert.equal(c.blockers_json,before);d.close();
});

for(const foreignQuantity of ['1 kg','handful'])test(`R3 ambiguous shared manual coverage (${foreignQuantity}) defers additions without claiming foreign quantities`,()=>{
 const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
 d.exec("INSERT INTO meals(id,date,meal_type,title,created_by) VALUES(501,'2034-03-06','dinner','Outside cycle',1)");
 d.prepare("INSERT INTO meal_grocery_item_sources(grocery_item_id,source_key,source_kind,meal_id,meal_date_snapshot,meal_title_snapshot,ingredient_name_snapshot,quantity_snapshot,category_snapshot) VALUES(?,'foreign','meal_ingredient',501,'2034-03-06','Outside cycle','Rice',?,'Sonstiges')").run(item.id,foreignQuantity);
 d.prepare("UPDATE shopping_items SET quantity='2 kg' WHERE id=?").run(item.shopping_item_id);
 const before=d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),sources=d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(item.id);
 const p=propose(d,id,m,4),conflict=p.preserved.find(x=>x.grocery_item_id===item.id);assert.equal(conflict.reason,'mixed_ownership');assert.equal(conflict.coverage_status,'unverified');assert.equal(conflict.additions_deferred,true);
 const r=apply(d,id,p);assert.equal(r.requires_manual_review,true);assert.deepEqual(quantities(d),['2 kg']);assert.deepEqual(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),before);assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(item.id),sources);d.close();
});

for(const foreignQuantity of ['handful','1 litre'])for(const purchased of [false,true])for(const growth of [false,true])test(`unknown shared ownership (${foreignQuantity}, ${purchased?'purchased':'outstanding'}, ${growth?'growth':'unchanged'}) defers additions and exact retries`,()=>{
 const {d,id,m,result}=ready();try{
  const item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
  d.exec("INSERT INTO meals(id,date,meal_type,title,created_by) VALUES(501,'2034-03-06','dinner','Outside cycle',1)");
  d.prepare("INSERT INTO meal_grocery_item_sources(grocery_item_id,source_key,source_kind,meal_id,meal_date_snapshot,meal_title_snapshot,ingredient_name_snapshot,quantity_snapshot,category_snapshot) VALUES(?,'foreign','meal_ingredient',501,'2034-03-06','Outside cycle','Rice',?,'Sonstiges')").run(item.id,foreignQuantity);
  if(purchased)updatePurchase(d,item.grocery_run_id,item.id,{purchasedQuantity:5,remainingQuantity:0,purchaseStatus:'purchased'});
  const original=d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),sources=d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=? ORDER BY id').all(item.id),history=d.prepare('SELECT * FROM meal_grocery_items WHERE id=?').get(item.id);
  const p=growth?propose(d,id,m,4,'shared-growth'):api.proposeCycleAdjustment(d,id,{...options(d,id,'shared-unchanged',1),changes:[]});
  const conflict=p.preserved.find(x=>x.grocery_item_id===item.id);assert.equal(conflict.reason,'mixed_ownership');assert.equal(conflict.coverage_status,'unverified');assert.equal(conflict.coverage_quantity,null);assert.equal(conflict.additions_deferred,true);
  const o={...options(d,id,'shared-apply',1),proposalId:p.proposal_id},r=api.applyCycleAdjustment(d,id,o);assert.deepEqual(api.applyCycleAdjustment(d,id,o),r);
  assert.equal(r.requires_manual_review,true);assert.deepEqual(quantities(d),['5 kg']);assert.deepEqual(d.prepare('SELECT * FROM shopping_items WHERE id=?').get(item.shopping_item_id),original);assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=? ORDER BY id').all(item.id),sources);assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_items WHERE id=?').get(item.id),history);
 }finally{d.close();}
});

for(const growth of [false,true])test(`R4 deleted Shopping output stays removed for ${growth?'growth':'unchanged'} demand and retries`,()=>{
 const {d,id,m,result}=ready(),item=loadGroceryRun(d,result.grocery_runs[0].run_id).items[0];
 d.prepare('DELETE FROM shopping_items WHERE id=?').run(item.shopping_item_id);
 const before=d.prepare('SELECT * FROM meal_grocery_items WHERE id=?').get(item.id),state=d.prepare('SELECT * FROM meal_grocery_output_state WHERE grocery_item_id=?').get(item.id),sources=d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(item.id);
 const p=growth?propose(d,id,m,4,'removed-growth'):api.proposeCycleAdjustment(d,id,{...options(d,id,'removed-unchanged',1),changes:[]});
 const check=conflicts=>{const conflict=conflicts.find(x=>x.grocery_item_id===item.id);assert.equal(conflict.reason,'removed_shopping_row');assert.equal(conflict.actual_quantity,null);assert.equal(conflict.coverage_quantity,null);assert.equal(conflict.coverage_status,'unverified');assert.equal(conflict.additions_deferred,true);assert.equal(conflict.historical_quantity,5);assert.equal(conflict.demand_quantity,growth?6:5);assert.deepEqual(conflict.meal_ids,[m]);assert.equal(conflict.shopping_link,`/shopping?list=${result.grocery_runs[0].shopping_list_id}`);};
 const o={...options(d,id,'removed-apply',1),proposalId:p.proposal_id};const accepted=api.applyCycleAdjustment(d,id,o);
 assert.deepEqual(quantities(d),[]);check(p.preserved);check(accepted.preserved);assert.equal(accepted.requires_manual_review,true);
 const cycle=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(id);assert.equal(cycle.attempt_status,'review_required');check(JSON.parse(cycle.blockers_json));
 const runCount=d.prepare('SELECT count(*) n FROM meal_grocery_runs').get().n;assert.deepEqual(api.applyCycleAdjustment(d,id,o),accepted);assert.equal(d.prepare('SELECT count(*) n FROM meal_grocery_runs').get().n,runCount);assert.deepEqual(quantities(d),[]);
 const restaged=api.proposeCycleAdjustment(d,id,{...options(d,id,'removed-restage',1),changes:[]});check(restaged.preserved);apply(d,id,restaged,'removed-restage-apply');assert.deepEqual(quantities(d),[]);
 assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_items WHERE id=?').get(item.id),before);assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_output_state WHERE grocery_item_id=?').get(item.id),state);assert.deepEqual(d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=?').all(item.id),sources);d.close();
});
