import {createHash} from 'node:crypto';
import {cycleSourceFingerprint,cyclePermissionFingerprint,cyclePersonRequirements,createCyclePlanningTask,registerMealCycleTaskLifecycle} from './meal-cycles.js';
import {cycleOccurrenceModel,reconcileCycleOccurrence,materializeMealPlanOccurrences,synchronizeMealMenuGeneration} from './meal-plans.js';
import {materializeRecurringMealOccurrences} from './meal-recurrence.js';
import {withCycleMealWrite} from './meal-cycle-guards.js';
import {authorizeCycleCoordinator} from './meal-cycle-finalization.js';
import {isHouseholdMember} from './member-email.js';
import {archiveSupersededCycleTask} from './task-lifecycle.js';
import {availabilityInstantMs} from './presence.js';
import {utcToWall} from '../utils/timezone.js';
import {actorPermissions} from '../permissions.js';
import {ensureMealExecution,previewMealExecution} from './meal-execution.js';
import {stageFinalizedCycleRecovery,resolveRevertedCycleChanges} from './meal-cycle-adjustments.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message,status=409,code='MEAL_CYCLE_CONFLICT') {throw Object.assign(new Error(message),{status,code});}
const sourceNames=new Set(['availability','membership','permissions','meal','recipe','rotation','context','source_changed']);
/** Internal writer hook. Scope is identity-only and must never contain records. */
export function enqueueCycleReconciliation(d,{scope={},sourceRevision,reason='source_changed'}={}) {
  if(!sourceNames.has(reason)||!['string','number'].includes(typeof sourceRevision)||String(sourceRevision).length>200
    ||Object.keys(scope).some(k=>!['cycle_id','meal_id','member_id','from','to'].includes(k)))throw new Error('Invalid reconciliation identity.');
  const safe=Object.fromEntries(Object.keys(scope).sort().map(k=>[k,scope[k]]));
  for(const [key,value] of Object.entries(safe))if(key.endsWith('_id')?!Number.isSafeInteger(value):!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Invalid reconciliation scope.');
  const cycles=d.prepare("SELECT id,period_start,period_end FROM meal_cycles WHERE period_end>=date('now','-1 day')").all().filter(c=>(!safe.cycle_id||c.id===safe.cycle_id)&&(!safe.from||c.period_end>=safe.from)&&(!safe.to||c.period_start<=safe.to));
  const events=[];
  for(const c of cycles) {
    if(safe.meal_id&&!d.prepare('SELECT 1 FROM meal_cycle_memberships WHERE cycle_id=? AND meal_id=?').get(c.id,safe.meal_id))continue;
    const key=digest({scope:safe,cycle:c.id,sourceRevision:String(sourceRevision),reason});
    d.prepare('INSERT OR IGNORE INTO meal_cycle_events(dedup_key,cycle_id,scope_json,source_revision,reason) VALUES(?,?,?,?,?)').run(key,c.id,JSON.stringify(safe),String(sourceRevision),reason);
    events.push(d.prepare('SELECT id FROM meal_cycle_events WHERE dedup_key=?').get(key));
  }
  return {id:events[0]?.id??null,event_ids:events.map(x=>x.id)};
}
function supersede(d,link,now) {
  d.prepare("UPDATE meal_cycle_task_links SET state='superseded' WHERE id=?").run(link.id);
  archiveSupersededCycleTask(d,link.task_id,{now});
}
function occurrences(d,c,now) {
  const owned=new Set(d.prepare('SELECT meal_id FROM meal_cycle_memberships WHERE cycle_id=?').all(c.id).map(x=>x.meal_id));
  return cycleOccurrenceModel(d,{from:c.period_start,to:c.period_end}).filter(m=>owned.has(m.id)).map(m=>{
    const time=m.scheduled_time||m.preferred_time||m.latest_time||m.earliest_time;
    const at=time?new Date(availabilityInstantMs(`${m.date}T${time}`,c.timezone)).toISOString():null;
    return {...m,adopted_history:at?at<=c.created_at:m.date<utcToWall(c.created_at,c.timezone).date,begun:!!at&&at<=now};
  });
}
/** Trusted worker, synchronous immediate transaction. Idempotence is the durable
 * source fingerprint; the write lock supplies the expected revision boundary. */
export function reconcileCycle(d,cycleId,{now=new Date().toISOString()}={}) {
  now=new Date(now).toISOString();registerMealCycleTaskLifecycle();
  return d.transaction(()=>{
    const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(cycleId);if(!c)throw new Error('Cycle not found.');
    const sourceFingerprint=cycleSourceFingerprint(d,c.id),permissions=cyclePermissionFingerprint(d,c.id);
    const fingerprint=digest({source:sourceFingerprint,permissions});
    // Canonical Save seals source freshness itself. Submitted obligations have
    // an independent lifecycle and may still need a correction after that Save.
    const submitted=c.state==='open'?d.prepare("SELECT beneficiary_id FROM meal_cycle_task_links WHERE cycle_id=? AND purpose IN ('personal','correction') AND state='active' AND submission_revision IS NOT NULL").all(c.id):[];
    const currentModel=submitted.length?occurrences(d,c,now):[];
    const invalidSubmission=submitted.some(link=>cyclePersonRequirements(d,currentModel,link.beneficiary_id).some(r=>!r.complete));
    if(sourceFingerprint===c.source_fingerprint&&permissions===c.permission_fingerprint&&!invalidSubmission){
      if(c.state==='finalized')resolveRevertedCycleChanges(d,c,{now});
      return {cycle_id:c.id,revision:d.prepare('SELECT revision FROM meal_cycles WHERE id=?').get(c.id).revision,changed:false};
    }
    if(c.state==='finalized') {
      const sourceRevision=Math.max(c.source_revision,d.prepare('SELECT COALESCE(MAX(source_revision),0) n FROM meal_cycle_source_changes WHERE cycle_id=?').get(c.id).n)+1;
      const inserted=d.prepare('INSERT OR IGNORE INTO meal_cycle_source_changes(cycle_id,fingerprint,previous_fingerprint,source_revision,created_at) VALUES(?,?,?,?,?)').run(c.id,fingerprint,digest({source:c.source_fingerprint,permissions:c.permission_fingerprint}),sourceRevision,now);
      const change=d.prepare('SELECT id FROM meal_cycle_source_changes WHERE cycle_id=? AND fingerprint=?').get(c.id,fingerprint);
      if(inserted.changes)d.prepare("UPDATE meal_cycles SET attempt_status='review_required',blockers_json=? WHERE id=?").run(JSON.stringify([{code:'FINALIZED_SOURCE_CHANGE',source_change_id:change.id,message:'Review changed meal sources before applying an adjustment.'}]),c.id);
      let proposal=null,recoveryError=null;
      try {proposal=d.transaction(()=>stageFinalizedCycleRecovery(d,c.id,{now}))();}
      catch(error){recoveryError={code:error.code||'CYCLE_ADJUSTMENT_RECOVERY_REQUIRED',message:error.message};d.prepare("UPDATE meal_cycles SET attempt_status='review_required',blockers_json=? WHERE id=?").run(JSON.stringify([{code:'FINALIZED_SOURCE_CHANGE',source_change_id:change.id,message:'Review changed meal sources before applying an adjustment.'},recoveryError]),c.id);}
      return {cycle_id:c.id,revision:d.prepare('SELECT revision FROM meal_cycles WHERE id=?').get(c.id).revision,changed:!!inserted.changes,staged:true,source_change_id:change.id,proposal_id:proposal?.proposal_id??null,blockers:recoveryError?[recoveryError]:[]};
    }
    const settings=JSON.parse(c.settings_json),today=utcToWall(now,c.timezone).date;
    const blockers=[];let authorized=true;
    try {authorizeCycleCoordinator(d,c,settings.coordinator_id);}catch {authorized=false;blockers.push({code:'CYCLE_COORDINATOR_RECOVERY_REQUIRED',message:'An authorized administrator must explicitly restore cycle assignments.'});}
    withCycleMealWrite(d,c.id,()=>{
      if(authorized&&c.period_end>=today) {
        materializeRecurringMealOccurrences(d,{from:c.period_start<today?today:c.period_start,to:c.period_end,mealTypes:['breakfast','lunch','dinner']});
        materializeMealPlanOccurrences(d,{from:c.period_start<today?today:c.period_start,to:c.period_end,actorId:settings.coordinator_id,mealTypes:['breakfast','lunch','dinner']});
      }
      const candidates=d.prepare("SELECT id FROM meals WHERE date BETWEEN ? AND ? AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND meal_type IN ('breakfast','lunch','dinner') AND (meal_plan_rule_id IS NOT NULL OR scope IN ('household','travel')) ORDER BY id").all(c.period_start,c.period_end);
      for(const m of candidates)if(!d.prepare('SELECT 1 FROM meal_cycle_memberships WHERE meal_id=?').get(m.id)) {
        if(d.prepare('SELECT 1 FROM meal_grocery_item_sources WHERE meal_id=? OR meal_id IN (SELECT id FROM meals WHERE parent_meal_id=?)').get(m.id,m.id)||d.prepare('SELECT 1 FROM meal_execution_snapshots WHERE meal_id=? OR meal_id IN (SELECT id FROM meals WHERE parent_meal_id=?)').get(m.id,m.id)) {
          blockers.push({code:'CYCLE_ADOPTION_REVIEW_REQUIRED',meal_id:m.id,message:'Existing output history needs reviewed adoption.'});continue;
        }
        synchronizeMealMenuGeneration(d,m.id);d.prepare('INSERT INTO meal_cycle_memberships(cycle_id,meal_id) VALUES(?,?)').run(c.id,m.id);
      }
      for(const m of occurrences(d,c,now).filter(m=>!m.adopted_history&&!m.begun)) {
        reconcileCycleOccurrence(d,m.id,{cycleId:c.id,sourceRevision:c.source_revision+1,now});
        if(authorized&&d.prepare('SELECT 1 FROM meal_execution_snapshots WHERE meal_id=?').get(m.id)) {
          const preview=previewMealExecution(d,m.id,{actorId:settings.coordinator_id});
          if(preview.enabled&&!preview.frozen&&!preview.blockers.length&&!preview.roles.some(r=>r.required&&r.status==='missing'))ensureMealExecution(d,m.id,settings.coordinator_id);
        }
      }
    });
    const model=occurrences(d,c,now),links=d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND purpose IN ('personal','correction') ORDER BY id").all(c.id);
    const people=[...new Set([...model.flatMap(m=>m.participants.map(x=>x.user_id)),...links.map(x=>x.beneficiary_id)])];
    for(const person of people) {
      const required=cyclePersonRequirements(d,model,person),link=links.find(x=>x.beneficiary_id===person&&x.state==='active');
      if(!isHouseholdMember(person,{db:d})||!required.length) {if(link)supersede(d,link,now);continue;}
      if(link?.submission_revision!=null&&required.some(x=>!x.complete)) {
        if(!authorized)continue;
        supersede(d,link,now);createCyclePlanningTask(d,c,'correction',person,required,{obligationKey:`source:${c.source_revision+1}`,supersedesLinkId:link.id});
      } else if(link)d.prepare('UPDATE meal_cycle_task_links SET obligations_json=? WHERE id=?').run(JSON.stringify(required),link.id);
      else if(authorized) {
        const previous=links.findLast(x=>x.beneficiary_id===person);
        createCyclePlanningTask(d,c,previous?'correction':'personal',person,required,{obligationKey:`source:${c.source_revision+1}`,supersedesLinkId:previous?.id??null});
      }
    }
    d.prepare('UPDATE meal_cycles SET revision=revision+1,source_revision=source_revision+1,source_fingerprint=?,permission_fingerprint=?,blockers_json=?,attempt_status=? WHERE id=? AND revision=?').run(cycleSourceFingerprint(d,c.id),cyclePermissionFingerprint(d,c.id),JSON.stringify(blockers),blockers.length?'blocked':'pending',c.id,c.revision);
    return {cycle_id:c.id,revision:c.revision+1,changed:true,blockers};
  }).immediate();
}

/** Explicit open-cycle recovery; no global settings or implied replacement. */
export function recoverCycleAssignments(d,cycleId,{actorId,expectedRevision,requestKey,coordinatorId,shoppingAssigneeId,now=new Date().toISOString()}={}) {
  return d.transaction(()=>{
    const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(cycleId);
    if(!c)fail('Cycle not found.',404,'CYCLE_NOT_FOUND');
    if(!isHouseholdMember(actorId,{db:d})||!actorPermissions(d,actorId).admin)fail('Administrator permission required for assignment recovery.',403,'CYCLE_PERMISSION');
    if(!Number.isSafeInteger(expectedRevision)||typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200)fail('Expected revision and stable request identity required.',400,'CYCLE_REQUEST');
    const settings=JSON.parse(c.settings_json),next={...settings,coordinator_id:coordinatorId??settings.coordinator_id,shopping_assignee_id:shoppingAssigneeId??settings.shopping_assignee_id};
    const candidate={...c,settings_json:JSON.stringify(next)};
    authorizeCycleCoordinator(d,candidate,actorId);authorizeCycleCoordinator(d,candidate,next.coordinator_id);
    const payloadHash=digest({actorId,expectedRevision,coordinatorId,shoppingAssigneeId});
    const old=d.prepare("SELECT * FROM meal_cycle_requests WHERE scope_key=? AND operation='assignments.recover' AND request_key=?").get(`cycle:${c.id}`,requestKey);
    if(old) {if(old.actor_id!==actorId||old.payload_hash!==payloadHash)fail('Request key already used.');return JSON.parse(old.result_json);}
    if(c.state!=='open'||c.revision!==expectedRevision)fail('Open cycle at expected revision required.');
    d.prepare('UPDATE meal_cycles SET settings_json=?,revision=revision+1 WHERE id=?').run(candidate.settings_json,c.id);
    for(const [purpose,person] of [['review',next.coordinator_id],['shopping',next.shopping_assignee_id]]) {
      const link=d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND purpose=? AND state='active'").get(c.id,purpose);
      if(link?.beneficiary_id===person)continue;
      if(link)supersede(d,link,now);
      createCyclePlanningTask(d,candidate,purpose,person,[],{obligationKey:`recovery:${c.revision+1}`,supersedesLinkId:link?.id||null});
    }
    for(const link of d.prepare("SELECT * FROM meal_cycle_task_links WHERE cycle_id=? AND purpose='automatic_followup' AND state='active'").all(c.id))supersede(d,link,now);
    // Force a reconciliation after identity recovery even if the source digest
    // was already acknowledged by an earlier blocked worker.
    d.prepare('UPDATE meal_cycles SET source_fingerprint=NULL WHERE id=?').run(c.id);
    const result=reconcileCycle(d,c.id,{now});
    d.prepare("INSERT INTO meal_cycle_requests(scope_key,operation,request_key,cycle_id,actor_id,expected_revision,payload_hash,result_json) VALUES(?,'assignments.recover',?,?,?,?,?,?)").run(`cycle:${c.id}`,requestKey,c.id,actorId,expectedRevision,payloadHash,JSON.stringify(result));
    return result;
  }).immediate();
}
/** Recovery sweeps do not depend on generation or automatic confirmation flags. */
export function drainCycleReconciliation(d,{now=new Date().toISOString()}={}) {
  const results=[];
  // Fingerprint sweep also recovers an interrupted worker or a missed legacy hook.
  for(const c of d.prepare('SELECT id,period_end,timezone FROM meal_cycles ORDER BY id').all()) {
    try {
      if(c.period_end<utcToWall(now,c.timezone).date)continue;
      d.transaction(()=>{
        results.push(reconcileCycle(d,c.id,{now}));
        d.prepare("UPDATE meal_cycle_events SET status='processed',processed_at=?,error=NULL WHERE cycle_id=? AND status IN ('pending','processing','failed')").run(now,c.id);
      }).immediate();
    }catch(error) {
      d.prepare("UPDATE meal_cycle_events SET status='failed',error=? WHERE cycle_id=? AND status!='processed'").run(error.code||'CYCLE_RECONCILIATION_FAILED',c.id);
      results.push({cycle_id:c.id,error:error.code||'CYCLE_RECONCILIATION_FAILED'});
    }
  }
  return results;
}
