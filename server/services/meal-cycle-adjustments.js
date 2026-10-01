import {createHash} from 'node:crypto';
import {actorPermissions} from '../permissions.js';
import {isHouseholdMember} from './member-email.js';
import {reviewCycle,writeCyclePersonChanges,cycleSourceFingerprint,cyclePermissionFingerprint,createCyclePlanningTask,cyclePersonRequirements} from './meal-cycles.js';
import {authorizeCycleCoordinator,reviewCycleReadiness} from './meal-cycle-finalization.js';
import {captureCycleEffective} from './meal-cycle-snapshot.js';
import {withCycleMealWrite} from './meal-cycle-guards.js';
import {reconcileCycleOccurrence,materializeMealPlanOccurrences,synchronizeMealMenuGeneration} from './meal-plans.js';
import {materializeRecurringMealOccurrences} from './meal-recurrence.js';
import {mealDishPortionSummary,syncRecipeMealIngredients} from './meal-dishes.js';
import {reconcileReviewedGroceries} from './meal-grocery-runs.js';
import {ensureMealExecution,previewMealExecution} from './meal-execution.js';
import {archiveSupersededCycleTask,changeTaskStatus,registerTaskTransitionGuard} from './task-lifecycle.js';
import {utcToWall} from '../utils/timezone.js';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
function fail(message,code='CYCLE_ADJUSTMENT_CONFLICT',status=409){throw Object.assign(new Error(message),{code,status});}
function load(d,id){const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(id);if(!c)fail('Cycle not found.','CYCLE_NOT_FOUND',404);return c;}
function member(d,id,beneficiary=id){const p=actorPermissions(d,id);if(!isHouseholdMember(id,{db:d})||!isHouseholdMember(beneficiary,{db:d})||p.modules.meals!=='write'||(id!==beneficiary&&!p.admin))fail('Only your own answers or authorized administrator beneficiary action is permitted.','CYCLE_PERMISSION',403);return p;}
function current(c,revision){if(c.state!=='finalized'||c.revision!==revision)fail('Finalized cycle at expected revision required.');}
function request(d,c,operation,o,payload,action){
 if(!Number.isSafeInteger(o.expectedRevision)||typeof o.requestKey!=='string'||!o.requestKey.trim()||o.requestKey.length>200)fail('Expected revision and stable requestKey required.','CYCLE_REQUEST',400);
 const digest=hash(canonical({actorId:o.actorId,expectedRevision:o.expectedRevision,payload}));
 const old=d.prepare('SELECT * FROM meal_cycle_requests WHERE scope_key=? AND operation=? AND request_key=?').get(`cycle:${c.id}`,operation,o.requestKey);
 if(old){if(old.actor_id!==o.actorId||old.payload_hash!==digest)fail('Request key belongs to another payload.');return JSON.parse(old.result_json);}
 const r=action();d.prepare('INSERT INTO meal_cycle_requests(scope_key,operation,request_key,cycle_id,actor_id,expected_revision,payload_hash,result_json) VALUES(?,?,?,?,?,?,?,?)').run(`cycle:${c.id}`,operation,o.requestKey,c.id,o.actorId,o.expectedRevision,digest,JSON.stringify(r));return r;
}
function baseline(d,id){const row=d.prepare("SELECT * FROM meal_cycle_results WHERE cycle_id=? AND kind IN ('finalization','adjustment') ORDER BY id DESC LIMIT 1").get(id);const effective=row&&JSON.parse(row.input_json).effective;if(!effective)fail('Confirmed effective baseline unavailable; explicit historical recovery is required.','CYCLE_BASELINE_UNAVAILABLE');return {result_id:row.id,effective};}
/** Includes actual Shopping edits/deletion, partial receipts and whole execution history. */
export function cycleProtectedFingerprint(d,id){
 const runs=d.prepare('SELECT * FROM meal_grocery_runs WHERE instr(logical_key,?)=1 ORDER BY id').all(`meal-cycle:${id}:`);
 const items=runs.flatMap(r=>d.prepare('SELECT * FROM meal_grocery_items WHERE grocery_run_id=? ORDER BY id').all(r.id));
 const roots=d.prepare('SELECT meal_id FROM meal_cycle_memberships WHERE cycle_id=? ORDER BY meal_id').all(id).map(x=>x.meal_id);
 const meals=roots.flatMap(m=>[m,...d.prepare('SELECT id FROM meals WHERE parent_meal_id=? ORDER BY id').all(m).map(x=>x.id)]);
 return hash({runs,items,sources:items.map(i=>d.prepare('SELECT * FROM meal_grocery_item_sources WHERE grocery_item_id=? ORDER BY id').all(i.id)),outputs:items.map(i=>({state:d.prepare('SELECT * FROM meal_grocery_output_state WHERE grocery_item_id=?').get(i.id)||null,shopping:i.shopping_item_id?d.prepare('SELECT * FROM shopping_items WHERE id=?').get(i.shopping_item_id)||null:null,owners:i.shopping_item_id?d.prepare('SELECT * FROM meal_grocery_items WHERE shopping_item_id=? ORDER BY id').all(i.shopping_item_id):[]})),
 executions:meals.map(m=>({snapshot:d.prepare('SELECT * FROM meal_execution_snapshots WHERE meal_id=?').all(m),outputs:d.prepare('SELECT * FROM meal_execution_tasks WHERE meal_id=? ORDER BY id').all(m).map(t=>({output:t,task:t.task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(t.task_id)||null:null}))}))});
}
function prospective(d,c,batches,{actorId,now}){
 return withCycleMealWrite(d,c.id,()=>{
  for(const m of reviewCycle(d,c.id,{actorId,now}).occurrences.filter(m=>!m.begun&&!m.adopted_history))reconcileCycleOccurrence(d,m.id,{cycleId:c.id,sourceRevision:c.source_revision+1,now});
  for(const batch of batches)if(batch.changes.length)writeCyclePersonChanges(d,c,{...batch,changes:batch.changes.map(change=>{
   if(change.kind!=='decision'||!change.decision?.select_shared_main)return change;
   const {select_shared_main,...decision}=change.decision;
   if(select_shared_main!==true||Object.hasOwn(decision,'menu_item_ids'))fail('Select one shared main explicitly; do not combine selection formats.','CYCLE_REQUEST',400);
   const items=d.prepare("SELECT i.id FROM meal_menu_items i JOIN meals m ON m.id=i.meal_id WHERE i.meal_id=? AND i.item_type='entree' AND i.menu_generation=m.current_menu_generation AND i.recipe_id IS m.recipe_id AND i.title=m.title ORDER BY i.id").all(change.meal_id);
   if(items.length!==1)fail('Exactly one shared main must be available.','HOUSEHOLD_ENTREE_REQUIRED');
   return {...change,decision:{...decision,menu_item_ids:items.map(x=>x.id)}};
  })});
  const r=reviewCycle(d,c.id,{actorId,now});
  for(const id of new Set(r.destinations.flatMap(p=>p.source_meal_ids))){
   const meal=d.prepare('SELECT m.*,r.yield_portions FROM meals m LEFT JOIN recipes r ON r.id=m.recipe_id WHERE m.id=?').get(id);
   if(meal?.recipe_id&&meal.yield_portions!=null&&!meal.ingredients_manual_override){const primary=mealDishPortionSummary(d,id).dishes.find(x=>x.meal_id===id&&x.primary);if(primary)syncRecipeMealIngredients(d,id,primary.cook_portions);}
  }
  const desired=captureCycleEffective(d,c.id,{actorId,now});let readiness=reviewCycleReadiness(d,c.id,{actorId,now});
  for(const batch of batches)if(batch.acknowledgeMealIds?.length){
   authorizeCycleCoordinator(d,c,batch.actorId);
   if(!batch.acknowledgments)batch.acknowledgments=batch.acknowledgeMealIds.map(id=>{const gap=readiness.gaps.find(g=>g.meal_id===id);if(!gap)fail('Acknowledgment must identify a current ingredient gap.');return {meal_id:id,fingerprint:gap.fingerprint};});
   for(const ack of batch.acknowledgments){const gap=readiness.gaps.find(g=>g.meal_id===ack.meal_id);if(gap?.fingerprint!==ack.fingerprint)continue;d.prepare('INSERT INTO meal_cycle_gap_acknowledgments(cycle_id,meal_id,fingerprint,actor_id,acknowledged_at) VALUES(?,?,?,?,?) ON CONFLICT(cycle_id,meal_id) DO UPDATE SET fingerprint=excluded.fingerprint,actor_id=excluded.actor_id,acknowledged_at=excluded.acknowledged_at').run(c.id,ack.meal_id,ack.fingerprint,batch.actorId,now);}
  }
  if(batches.some(b=>b.acknowledgeMealIds?.length))readiness=reviewCycleReadiness(d,c.id,{actorId,now});
  const ignored=new Set(['CYCLE_SOURCE_CHANGED','EXECUTION_HISTORY_REVIEW_REQUIRED','PERSONAL_SUBMISSION_REQUIRED','REVIEW_TASK_PERMISSION_REQUIRED','MANUAL_REVIEW_REQUIRED']);
  const blockers=[...readiness.blockers.filter(b=>!ignored.has(b.code)),...submissionBlockers(d,c,desired)];
  // Source-driven workers may stage with missing coordinator capability; apply never can.
  const preserveMealIds=desired.occurrences.filter(m=>m.begun||m.adopted_history).flatMap(m=>[m.id,...d.prepare('SELECT id FROM meals WHERE parent_meal_id=?').all(m.id).map(x=>x.id)]);
  const grocery=reconcileReviewedGroceries(d,c,desired.partitions,{actorId,revision:c.revision+1,preserveMealIds});
  const preserved=[...grocery.preserved,...readiness.executions.filter(x=>x.frozen).map(x=>({meal_id:x.meal_id,reason:'frozen_execution'}))];
  for(const row of d.prepare('SELECT DISTINCT s.meal_id FROM meal_execution_snapshots s JOIN meals m ON m.id=s.meal_id JOIN meal_cycle_memberships cm ON (cm.meal_id=m.id OR cm.meal_id=m.parent_meal_id) WHERE cm.cycle_id=?').all(c.id)){
   const ex=previewMealExecution(d,row.meal_id,{actorId});
   if(!preserved.some(x=>x.meal_id===row.meal_id)&&(ex.frozen||!ex.has_demand||!ex.enabled))preserved.push({meal_id:row.meal_id,reason:ex.frozen?'frozen_execution':!ex.has_demand?'no_current_demand_execution':'disabled_execution',task_ids:ex.roles.map(x=>x.output_task_id).filter(Boolean)});
  }
  for(const conflict of preserved)if(conflict.meal_id){conflict.task_ids=d.prepare('SELECT task_id FROM meal_execution_tasks WHERE meal_id=? AND task_id IS NOT NULL ORDER BY id').all(conflict.meal_id).map(x=>x.task_id);conflict.task_links=conflict.task_ids.map(id=>`/tasks?open=${id}`);}
  return {evaluated_at:now,desired,blockers,gaps:readiness.gaps,warnings:readiness.warnings,executions:readiness.executions,preserved,preserveMealIds,reductions:grocery.reductions,ready:blockers.length===0};
 });
}
function simulate(d,operation){const sentinel={};let result;try{d.transaction(()=>{result=operation();throw sentinel;})();}catch(e){if(e!==sentinel)throw e;}return result;}
function pending(d,id,cycleId){const p=d.prepare('SELECT * FROM meal_cycle_adjustments WHERE id=? AND cycle_id=?').get(id,cycleId);if(!p||p.status!=='pending')fail('Proposal is not pending (canceled, superseded or already applied).');return p;}
function timeStale(p,now){const preview=JSON.parse(p.preview_json);return preview.desired.occurrences.some(m=>m.governed_at&&m.governed_at>preview.evaluated_at&&m.governed_at<=now);}
function assertFresh(d,c,p,now=new Date().toISOString()){if(timeStale(p,now)||p.source_fingerprint!==cycleSourceFingerprint(d,c.id)||p.permission_fingerprint!==cyclePermissionFingerprint(d,c.id)||p.protected_fingerprint!==cycleProtectedFingerprint(d,c.id))fail('Proposal is stale: meal time, source, permission or protected output changed.','CYCLE_ADJUSTMENT_STALE');}

export function proposeCycleAdjustment(d,cycleId,o={}){
 const {actorId,beneficiaryId=actorId,changes=[],baseProposalId=null,acknowledgeMealIds=[],now=new Date().toISOString()}=o;
 return d.transaction(()=>{
  member(d,actorId,beneficiaryId);const c=load(d,cycleId);
  if(!Array.isArray(acknowledgeMealIds)||acknowledgeMealIds.some(x=>!Number.isSafeInteger(x)))fail('Invalid gap acknowledgments.','CYCLE_REQUEST',400);
  if(acknowledgeMealIds.length)authorizeCycleCoordinator(d,c,actorId);
  return request(d,c,'adjustment.propose',o,{beneficiaryId,changes,baseProposalId,acknowledgeMealIds},()=>{
   current(c,o.expectedRevision);if(!Array.isArray(changes)||changes.length>200)fail('Provide an ordered changes array.','CYCLE_REQUEST',400);
   let batches=[],base=null;
   if(baseProposalId){base=pending(d,baseProposalId,c.id);assertFresh(d,c,base,now);batches=JSON.parse(base.batches_json);}
   if(changes.length||acknowledgeMealIds.length)batches.push({actorId,beneficiaryId,changes,acknowledgeMealIds});
   const accepted=baseline(d,c.id),preview=simulate(d,()=>prospective(d,c,batches,{actorId:JSON.parse(c.settings_json).coordinator_id,now}));
   const source=cycleSourceFingerprint(d,c.id),permissions=cyclePermissionFingerprint(d,c.id),protectedFingerprint=cycleProtectedFingerprint(d,c.id);
   const signal=d.prepare("SELECT id FROM meal_cycle_source_changes WHERE cycle_id=? AND fingerprint=? AND status='pending'").get(c.id,hash({source,permissions}));
   const info=d.prepare('INSERT INTO meal_cycle_adjustments(cycle_id,actor_id,source_fingerprint,permission_fingerprint,protected_fingerprint,source_change_id,batches_json,preview_json) VALUES(?,?,?,?,?,?,?,?)').run(c.id,actorId,source,permissions,protectedFingerprint,signal?.id??null,JSON.stringify(batches),JSON.stringify({...preview,baseline:accepted}));
   const proposalId=Number(info.lastInsertRowid);
   if(base)d.prepare("UPDATE meal_cycle_adjustments SET status='superseded' WHERE id=?").run(base.id);
   d.prepare("UPDATE meal_cycles SET revision=revision+1,pending_adjustment_id=?,attempt_status='review_required' WHERE id=?").run(proposalId,c.id);
   const result={cycle_id:c.id,revision:c.revision+1,proposal_id:proposalId,baseline:accepted,...preview};
   d.prepare("INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,source_revision,input_json,output_json,actor_id,reason) VALUES(?,'proposal',?,?,?,?,?,?,?)").run(c.id,o.requestKey,source,c.source_revision,JSON.stringify({batches,baseline_result_id:accepted.result_id}),JSON.stringify(result),actorId,'staged only');
   refreshAdjustmentFollowups(d,load(d,c.id),result,{now});return result;
  });
 }).immediate();
}
export function applyCycleAdjustment(d,cycleId,o={}){
 const {actorId,proposalId,now=new Date().toISOString()}=o;
 return d.transaction(()=>{
  const c=load(d,cycleId);authorizeCycleCoordinator(d,c,actorId);
  return request(d,c,'adjustment.apply',o,{proposalId},()=>{
   current(c,o.expectedRevision);const p=pending(d,proposalId,c.id);assertFresh(d,c,p,now);
   const batches=JSON.parse(p.batches_json);const preview=prospective(d,c,batches,{actorId,now});
   if(preview.blockers.length)fail(`Adjustment needs review: ${preview.blockers.map(x=>x.message).join(' ')}`,'CYCLE_ADJUSTMENT_NOT_READY');
   const revision=c.revision+1,result=withCycleMealWrite(d,c.id,()=>{
    const groceries=reconcileReviewedGroceries(d,c,preview.desired.partitions,{actorId,revision,apply:true,preserveMealIds:preview.preserveMealIds});const execution_task_ids=[];
    for(const id of new Set(preview.desired.partitions.flatMap(p=>p.source_meal_ids))){const ex=previewMealExecution(d,id,{actorId});if(ex.enabled&&ex.has_demand&&!ex.frozen)execution_task_ids.push(...(ensureMealExecution(d,id,actorId)?.tasks||[]).map(x=>x.task_id).filter(Boolean));}
    return {cycle_id:c.id,revision,proposal_id:p.id,...groceries,preserved:preview.preserved,requires_manual_review:preview.preserved.length>0,execution_task_ids};
   });
   const effective=captureCycleEffective(d,c.id,{actorId,now});
   const audit=d.prepare("INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,source_revision,input_json,output_json,actor_id,reason) VALUES(?,'adjustment',?,?,?,?,?,?,?)").run(c.id,o.requestKey,p.source_fingerprint,c.source_revision+1,JSON.stringify({effective,proposal_id:p.id,proposer_id:p.actor_id,batches}),JSON.stringify(result),actorId,'reviewed adjustment');
   d.prepare("UPDATE meal_cycle_adjustments SET status='applied',result_id=? WHERE id=?").run(audit.lastInsertRowid,p.id);
   d.prepare("UPDATE meal_cycle_adjustments SET status='superseded' WHERE cycle_id=? AND status='pending'").run(c.id);
   d.prepare("UPDATE meal_cycle_source_changes SET status=CASE WHEN id=? THEN 'reviewed' ELSE 'superseded' END WHERE cycle_id=? AND status='pending'").run(p.source_change_id,c.id);
   d.prepare('UPDATE meal_cycles SET revision=?,source_revision=source_revision+1,source_fingerprint=?,permission_fingerprint=?,pending_adjustment_id=NULL,attempt_status=?,blockers_json=? WHERE id=?').run(revision,cycleSourceFingerprint(d,c.id),cyclePermissionFingerprint(d,c.id),result.requires_manual_review?'review_required':'finalized',JSON.stringify(result.preserved.map(conflict=>({code:'ADJUSTMENT_PRESERVED_OUTPUT',message:'Review the preserved Shopping or cooking output; no purchase or completed work was reversed.',...conflict}))),c.id);
   d.prepare('UPDATE meal_cycle_pending_occurrences SET accepted_revision=? WHERE cycle_id=? AND accepted_revision IS NULL').run(revision,c.id);
   retireAdjustmentFollowups(d,c,now);return result;
  });
 }).immediate();
}
export function cancelCycleAdjustment(d,cycleId,o={}){
 return d.transaction(()=>{const c=load(d,cycleId);member(d,o.actorId);const p=d.prepare('SELECT * FROM meal_cycle_adjustments WHERE id=? AND cycle_id=?').get(o.proposalId,c.id);if(!p)fail('Proposal not found.');if(p.actor_id!==o.actorId)authorizeCycleCoordinator(d,c,o.actorId);
  return request(d,c,'adjustment.cancel',o,{proposalId:o.proposalId},()=>{current(c,o.expectedRevision);pending(d,p.id,c.id);d.prepare("UPDATE meal_cycle_adjustments SET status='canceled' WHERE id=?").run(p.id);d.prepare('UPDATE meal_cycles SET revision=revision+1,pending_adjustment_id=CASE WHEN pending_adjustment_id=? THEN NULL ELSE pending_adjustment_id END WHERE id=?').run(p.id,c.id);return {cycle_id:c.id,revision:c.revision+1,proposal_id:p.id,status:'canceled'};});
 }).immediate();
}
/** Pure internal read; transport must filter household/member fields before returning. */
export function reviewCycleAdjustment(d,cycleId,{actorId,proposalId}={}){
 return d.transaction(()=>{
 member(d,actorId);const c=load(d,cycleId),p=d.prepare('SELECT * FROM meal_cycle_adjustments WHERE id=? AND cycle_id=?').get(proposalId??c.pending_adjustment_id,c.id);if(!p)return null;
 const preview=JSON.parse(p.preview_json),blockers=[...preview.blockers.filter(b=>b.code!=='ADJUSTMENT_SUBMISSION_REQUIRED'),...submissionBlockers(d,c,preview.desired)];
 return {cycle_id:c.id,revision:c.revision,proposal_id:p.id,proposer_id:p.actor_id,source_change_id:p.source_change_id,status:p.status,stale:timeStale(p,new Date().toISOString())||p.source_fingerprint!==cycleSourceFingerprint(d,c.id)||p.permission_fingerprint!==cyclePermissionFingerprint(d,c.id)||p.protected_fingerprint!==cycleProtectedFingerprint(d,c.id),...preview,blockers,ready:blockers.length===0,pending_occurrences:d.prepare('SELECT meal_id,accepted_revision FROM meal_cycle_pending_occurrences WHERE cycle_id=? ORDER BY meal_id').all(c.id)};
 })();
}

function retireAdjustmentFollowups(d,c,now){for(const l of d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE 'adjustment:%' AND state='active'").all(c.id)){d.prepare("UPDATE meal_cycle_task_links SET state='superseded' WHERE id=?").run(l.id);archiveSupersededCycleTask(d,l.task_id,{now});}}
/** Internal recovery for externally reverted sources; preserve immutable proposal audit. */
export function resolveRevertedCycleChanges(d,c,{now}){
 return d.transaction(()=>{
  const signals=d.prepare("UPDATE meal_cycle_source_changes SET status='superseded' WHERE cycle_id=? AND status='pending'").run(c.id).changes;
  const changed=d.prepare("UPDATE meal_cycle_adjustments SET status='superseded' WHERE cycle_id=? AND status='pending' AND source_change_id IS NOT NULL").run(c.id).changes;
  const candidates=d.prepare("SELECT * FROM meal_cycle_adjustments WHERE cycle_id=? AND status='pending' ORDER BY id DESC").all(c.id);
  const source=cycleSourceFingerprint(d,c.id),permission=cyclePermissionFingerprint(d,c.id),protectedOutput=cycleProtectedFingerprint(d,c.id);
  const next=candidates.find(p=>p.source_fingerprint===source&&p.permission_fingerprint===permission&&p.protected_fingerprint===protectedOutput&&!timeStale(p,now))??candidates[0];
  if(!signals&&!changed&&(c.pending_adjustment_id??null)===(next?.id??null))return;
  // Reverting inputs cannot resolve accepted Shopping/cooking discrepancies.
  const accepted=d.prepare("SELECT output_json FROM meal_cycle_results WHERE cycle_id=? AND kind IN ('finalization','adjustment') ORDER BY id DESC LIMIT 1").get(c.id);
  const blockers=(accepted?JSON.parse(accepted.output_json).preserved||[]:[]).map(conflict=>({code:'ADJUSTMENT_PRESERVED_OUTPUT',message:'Review the preserved Shopping or cooking output; no purchase or completed work was reversed.',...conflict}));
  d.prepare('UPDATE meal_cycles SET revision=revision+1,pending_adjustment_id=?,attempt_status=?,blockers_json=? WHERE id=?').run(next?.id??null,next||blockers.length?'review_required':'finalized',JSON.stringify(blockers),c.id);
  if(next)refreshAdjustmentFollowups(d,load(d,c.id),{...JSON.parse(next.preview_json),proposal_id:next.id},{now});
  else retireAdjustmentFollowups(d,c,now);
 })();
}
function refreshAdjustmentFollowups(d,c,preview,{now}){
 const settings=JSON.parse(c.settings_json);try{authorizeCycleCoordinator(d,c,settings.coordinator_id);}catch{return;}
 const requirements=new Map();for(const b of preview.blockers.filter(x=>['MAIN_REQUIRED','RESPONSE_REQUIRED','ADJUSTMENT_SUBMISSION_REQUIRED'].includes(x.code))){if(!requirements.has(b.beneficiary_id))requirements.set(b.beneficiary_id,[]);requirements.get(b.beneficiary_id).push(b);}
 const people=[{person:settings.coordinator_id,purpose:'review'},...[...requirements.keys()].map(person=>({person,purpose:'response'}))];
 for(const {person,purpose} of people){
  const key=`adjustment:${purpose}:${person}`;
  let link=d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE ? AND state='active' ORDER BY id DESC LIMIT 1").get(c.id,`${key}:%`);
  if(link&&purpose==='response'&&link.submission_revision!=null&&d.prepare('SELECT signature FROM meal_cycle_adjustment_submissions WHERE link_id=?').get(link.id)?.signature!==personalSignature(d,preview.desired,person)){
   d.prepare("UPDATE meal_cycle_task_links SET state='superseded' WHERE id=?").run(link.id);archiveSupersededCycleTask(d,link.task_id,{now});link=null;
  }
  if(!link){const task=createCyclePlanningTask(d,c,'automatic_followup',person,requirements.get(person)||[],{obligationKey:`${key}:${c.revision}`});link=d.prepare('SELECT * FROM meal_cycle_task_links WHERE task_id=?').get(task);d.prepare('UPDATE tasks SET title=? WHERE id=?').run(purpose==='review'?'Review changed household meals':'Propose your changed meal choices',task);}
  d.prepare('UPDATE task_action_links SET params_json=? WHERE task_id=?').run(JSON.stringify({cycle:c.id,proposal:preview.proposal_id,beneficiary:person,purpose:'adjustment'}),link.task_id);
 }
 // Existing response work follows the current proposal even once its draft is complete.
 for(const link of d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE 'adjustment:response:%' AND state='active'").all(c.id))d.prepare('UPDATE task_action_links SET params_json=? WHERE task_id=?').run(JSON.stringify({cycle:c.id,proposal:preview.proposal_id,beneficiary:link.beneficiary_id,purpose:'adjustment'}),link.task_id);
}

function personalSignature(d,desired,person){return hash(canonical({requirements:cyclePersonRequirements(d,desired.occurrences,person),choices:desired.occurrences.map(m=>({meal_id:m.id,main:m.choosers.some(x=>x.user_id===person)?{title:m.title,recipe_id:m.recipe_id}:null,decision:(m.decisions||[]).filter(x=>x.beneficiary_user_id===person).map(x=>Object.fromEntries(['participation','choice_kind','portion_amount','confirmed','selected_meal_id','selected_meal_title','recipe_id'].map(k=>[k,x[k]??null])))}))}));}
function submissionBlockers(d,c,desired){return d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND obligation_key LIKE 'adjustment:response:%' AND state='active'").all(c.id).filter(l=>d.prepare('SELECT signature FROM meal_cycle_adjustment_submissions WHERE link_id=?').get(l.id)?.signature!==personalSignature(d,desired,l.beneficiary_id)).map(l=>({code:'ADJUSTMENT_SUBMISSION_REQUIRED',beneficiary_id:l.beneficiary_id,message:'Submit the staged changed choices before accepting this adjustment.'}));}
const submissionScopes=new WeakSet();
registerTaskTransitionGuard('meal-cycle-adjustment',(d,task,status)=>{
 if(!d.prepare("SELECT 1 FROM sqlite_master WHERE name='meal_cycle_adjustments'").get())return;
 const link=d.prepare("SELECT * FROM meal_cycle_task_links WHERE task_id=? AND obligation_key LIKE 'adjustment:%'").get(task.id);if(!link||status!=='done')return;
 if(!submissionScopes.has(d))fail('Complete changed choices through the Kitchen adjustment submission action.');
 d.prepare('UPDATE tasks SET points=0 WHERE id=?').run(task.id);
});
export function submitCycleAdjustmentPerson(d,cycleId,o={}){
 const {actorId,beneficiaryId=actorId,proposalId,now=new Date().toISOString()}=o;
 return d.transaction(()=>{
  member(d,actorId,beneficiaryId);const c=load(d,cycleId),p=pending(d,proposalId,c.id);assertFresh(d,c,p,now);
  return request(d,c,'adjustment.submit',o,{beneficiaryId,proposalId},()=>{
   current(c,o.expectedRevision);const preview=simulate(d,()=>prospective(d,c,JSON.parse(p.batches_json),{actorId:JSON.parse(c.settings_json).coordinator_id,now}));
   if(cyclePersonRequirements(d,preview.desired.occurrences,beneficiaryId).some(x=>!x.complete))fail('Complete your staged meal choices before submitting.','CYCLE_PERSON_INCOMPLETE');
   const link=d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND beneficiary_id=? AND obligation_key LIKE 'adjustment:response:%' AND state='active' ORDER BY id DESC LIMIT 1").get(c.id,beneficiaryId);if(!link)fail('No new response work requires submission.');
   const signature=personalSignature(d,preview.desired,beneficiaryId),previous=d.prepare('SELECT * FROM meal_cycle_adjustment_submissions WHERE link_id=?').get(link.id);
   if(previous&&previous.signature!==signature)fail('Changed submitted response needs a new correction Task.');
   const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(link.task_id);
   submissionScopes.add(d);try{changeTaskStatus(d,task.id,'done',{actorId,body:{expected_revision:task.revision},now});}finally{submissionScopes.delete(d);}
   d.prepare('INSERT OR IGNORE INTO meal_cycle_adjustment_submissions(link_id,proposal_id,signature) VALUES(?,?,?)').run(link.id,p.id,signature);
   d.prepare('UPDATE meal_cycle_task_links SET submission_revision=COALESCE(submission_revision,?) WHERE id=?').run(c.revision+1,link.id);
   d.prepare('UPDATE meal_cycles SET revision=revision+1 WHERE id=?').run(c.id);
   return {cycle_id:c.id,revision:c.revision+1,proposal_id:p.id,submitted:true,task_id:task.id};
  });
 }).immediate();
}

/** Trusted recovery-only: reserve genuinely new canonical identities. Existing
 * owned occurrences are skipped by the canonical materializer itself. */
export function stageFinalizedCycleRecovery(d,cycleId,{now=new Date().toISOString()}={}){
 const c=load(d,cycleId),settings=JSON.parse(c.settings_json);authorizeCycleCoordinator(d,c,settings.coordinator_id);
 const today=utcToWall(now,c.timezone).date;
 withCycleMealWrite(d,c.id,()=>{
  materializeRecurringMealOccurrences(d,{from:c.period_start<today?today:c.period_start,to:c.period_end,mealTypes:['breakfast','lunch','dinner']});
  materializeMealPlanOccurrences(d,{from:c.period_start<today?today:c.period_start,to:c.period_end,actorId:settings.coordinator_id,mealTypes:['breakfast','lunch','dinner'],newOnly:true});
  for(const m of d.prepare("SELECT id FROM meals WHERE date BETWEEN ? AND ? AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND meal_type IN ('breakfast','lunch','dinner') AND (meal_plan_rule_id IS NOT NULL OR scope IN ('household','travel')) ORDER BY id").all(c.period_start,c.period_end)){
   if(d.prepare('SELECT 1 FROM meal_cycle_memberships WHERE meal_id=?').get(m.id))continue;
   if(d.prepare('SELECT 1 FROM meal_grocery_item_sources WHERE meal_id=?').get(m.id)||d.prepare('SELECT 1 FROM meal_execution_snapshots WHERE meal_id=?').get(m.id))fail('New occurrence already has output history; reviewed adoption is required.','CYCLE_ADOPTION_REVIEW_REQUIRED');
   synchronizeMealMenuGeneration(d,m.id);d.prepare('INSERT INTO meal_cycle_memberships(cycle_id,meal_id) VALUES(?,?)').run(c.id,m.id);d.prepare('INSERT INTO meal_cycle_pending_occurrences(meal_id,cycle_id) VALUES(?,?)').run(m.id,c.id);
  }
 });
 const source=cycleSourceFingerprint(d,c.id),permissions=cyclePermissionFingerprint(d,c.id),composite=hash({source,permissions});
 if(source===c.source_fingerprint&&permissions===c.permission_fingerprint){resolveRevertedCycleChanges(d,c,{now});return null;}
 const old=d.prepare("SELECT * FROM meal_cycle_adjustments WHERE cycle_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(c.id);
 if(old&&!timeStale(old,now)&&old.source_fingerprint===source&&old.permission_fingerprint===permissions&&old.protected_fingerprint===cycleProtectedFingerprint(d,c.id))return {proposal_id:old.id};
 const revision=Math.max(c.source_revision,d.prepare('SELECT COALESCE(MAX(source_revision),0) n FROM meal_cycle_source_changes WHERE cycle_id=?').get(c.id).n)+1;
 d.prepare('INSERT OR IGNORE INTO meal_cycle_source_changes(cycle_id,fingerprint,previous_fingerprint,source_revision,created_at) VALUES(?,?,?,?,?)').run(c.id,composite,hash({source:c.source_fingerprint,permissions:c.permission_fingerprint}),revision,now);
 const signal=d.prepare('SELECT id FROM meal_cycle_source_changes WHERE cycle_id=? AND fingerprint=?').get(c.id,composite);
 d.prepare("UPDATE meal_cycle_source_changes SET status='pending' WHERE id=?").run(signal.id);
 d.prepare("UPDATE meal_cycle_source_changes SET status='superseded' WHERE cycle_id=? AND id!=? AND status='pending'").run(c.id,signal.id);
 // Changed sources must be freshly reviewed; stale member proposals remain audit evidence.
 return proposeCycleAdjustment(d,c.id,{actorId:settings.coordinator_id,expectedRevision:c.revision,requestKey:`source:${signal.id}:${c.revision}`,changes:[],now});
}
