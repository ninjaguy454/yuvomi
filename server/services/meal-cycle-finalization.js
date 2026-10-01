import {createHash} from 'node:crypto';
import {actorPermissions} from '../permissions.js';
import {isHouseholdMember} from './member-email.js';
import {reviewCycle,cycleSourceFingerprint,cyclePermissionFingerprint,registerMealCycleTaskLifecycle} from './meal-cycles.js';
import {getCycleSettings} from './meal-cycle-settings.js';
import {cycleInstants} from './meal-cycle-schedule.js';
import {withCycleMealWrite} from './meal-cycle-guards.js';
import {mealDishPortionSummary} from './meal-dishes.js';
import {previewMealExecution,ensureMealExecution} from './meal-execution.js';
import {createOrRefreshGroceryRun,finalizeGroceryRun,publishGroceryRun} from './meal-grocery-runs.js';
import {changeTaskStatus} from './task-lifecycle.js';
import {taskCapabilities} from './task-access.js';
import {utcToWall} from '../utils/timezone.js';
import {captureCycleEffective} from './meal-cycle-snapshot.js';

function fail(message,code='MEAL_CYCLE_CONFLICT',status=409,blockers) {const e=new Error(message);Object.assign(e,{code,status,blockers});throw e;}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const automaticInvocations=new WeakSet();
/** Internal scheduler capability, never wired to request JSON. */
export function withAutomaticCycleInvocation(d,operation) {
  const previous=automaticInvocations.has(d);automaticInvocations.add(d);
  try {return operation();} finally {if(!previous)automaticInvocations.delete(d);}
}
export function authorizeCycleCoordinator(d,c,actorId) {
  if(!Number.isSafeInteger(actorId)||!isHouseholdMember(actorId,{db:d}))fail('Household coordinator permission is required.','CYCLE_PERMISSION',403);
  const p=actorPermissions(d,actorId),settings=JSON.parse(c.settings_json);
  if((!p.admin&&actorId!==settings.coordinator_id)||['meals','tasks','shopping'].some(k=>p.modules[k]!=='write')||['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.change_dates'].some(k=>p.capabilities[k]!=='allow'))fail('Coordinator needs current Kitchen, Shopping and Task permission.','CYCLE_PERMISSION',403);
  const shopper=actorPermissions(d,settings.shopping_assignee_id);
  if(!isHouseholdMember(settings.shopping_assignee_id,{db:d})||!['read','write'].includes(shopper.modules.meals)||shopper.modules.tasks!=='write'||shopper.modules.shopping!=='write'||shopper.capabilities['tasks.complete_own']!=='allow')fail('Shopping assignee needs Kitchen read access and current Tasks and Shopping permissions.','CYCLE_PERMISSION',403);
  return settings;
}
function load(d,id) {const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(Number(id));if(!c)fail('Cycle not found.','CYCLE_NOT_FOUND',404);return c;}
function request(d,c,operation,{actorId,expectedRevision,requestKey},payload,action) {
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200)fail('Expected revision and stable requestKey are required.','CYCLE_REQUEST',400);
  const fingerprint=hash(canonical({actorId,expectedRevision,payload}));
  const old=d.prepare('SELECT * FROM meal_cycle_requests WHERE scope_key=? AND operation=? AND request_key=?').get(`cycle:${c.id}`,operation,requestKey);
  if(old) {if(old.actor_id!==actorId||old.payload_hash!==fingerprint)fail('Request key belongs to another payload.');return JSON.parse(old.result_json);}
  const result=action();
  d.prepare('INSERT INTO meal_cycle_requests(scope_key,operation,request_key,cycle_id,actor_id,expected_revision,payload_hash,result_json) VALUES(?,?,?,?,?,?,?,?)').run(`cycle:${c.id}`,operation,requestKey,c.id,actorId,expectedRevision,fingerprint,JSON.stringify(result));return result;
}
function assertOpenCurrent(d,c,revision) {
  if(c.state!=='open')fail('Plan confirmed; propose a reviewed adjustment.');
  if(c.revision!==revision)fail('Cycle revision conflict; refresh before confirming.');
  if(c.source_fingerprint!==cycleSourceFingerprint(d,c.id))fail('Cycle sources changed; reconcile before confirming.','CYCLE_SOURCE_CHANGED');
}
function gapFingerprint(d,mealId) {
  const meal=d.prepare('SELECT id,title,recipe_id,portions,portions_mode,ingredients_manual_override FROM meals WHERE id=?').get(mealId);
  const dishes=mealDishPortionSummary(d,mealId).dishes.filter(x=>x.meal_id===mealId);
  return hash({meal,dishes,ingredients:d.prepare('SELECT id,name,quantity,category FROM meal_ingredients WHERE meal_id=? ORDER BY id').all(mealId),
    recipes:dishes.map(x=>({id:x.recipe_id,ingredients:x.recipe_id?d.prepare('SELECT id,name,quantity,category FROM recipe_ingredients WHERE recipe_id=? ORDER BY id').all(x.recipe_id):[]}))});
}
function scopeAndGaps(d,r) {
  const partitions=r.destinations.map(p=>({...p,source_meal_ids:[...new Set(p.source_meal_ids)].filter(id=>mealDishPortionSummary(d,id).dishes.some(x=>x.meal_id===id&&x.cook_portions>0))}));
  const ids=[...new Set(partitions.flatMap(p=>p.source_meal_ids))],gaps=[],warnings=[];
  for(const id of ids) {
    const meal=d.prepare('SELECT * FROM meals WHERE id=?').get(id);
    const dishes=mealDishPortionSummary(d,id).dishes.filter(x=>x.meal_id===id&&x.cook_portions>0);
    // Ingredient review is independent of whether this destination tracks Shopping.
    const missing=dishes.filter(dish=>{
      if(dish.primary&&d.prepare('SELECT 1 FROM meal_ingredients WHERE meal_id=? LIMIT 1').get(id))return false;
      if(dish.primary&&meal.ingredients_manual_override)return true;
      return !dish.recipe_id||!d.prepare('SELECT 1 FROM recipe_ingredients WHERE recipe_id=? LIMIT 1').get(dish.recipe_id);
    });
    const discrepancy=dishes.some(x=>x.planned_portions===0&&(meal.portions_mode==='fixed'||meal.ingredients_manual_override));
    if(missing.length||discrepancy) {
      const fingerprint=gapFingerprint(d,id),ack=d.prepare('SELECT fingerprint FROM meal_cycle_gap_acknowledgments WHERE cycle_id=? AND meal_id=?').get(r.cycle_id,id);
      gaps.push({meal_id:id,fingerprint,acknowledged:ack?.fingerprint===fingerprint,missing_dishes:missing.map(x=>x.title),portion_discrepancy:discrepancy});
    }
    for(const dish of dishes)if(dish.recipe_id&&d.prepare('SELECT yield_portions FROM recipes WHERE id=?').get(dish.recipe_id)?.yield_portions==null)warnings.push({code:'LEGACY_RECIPE_BATCH',meal_id:id,message:'Recipe yield is unspecified; existing legacy batch quantities are retained.'});
  }
  return {partitions,ids,gaps,warnings};
}
/** Coherent pure read: never resolves assignments through a writing code path. */
export function reviewCycleReadiness(d,cycleId,{actorId,now=new Date().toISOString()}={}) {
  return d.transaction(()=>{
    const r=reviewCycle(d,cycleId,{actorId,now}),scope=scopeAndGaps(d,r);
    const executions=scope.ids.map(id=>previewMealExecution(d,id,{actorId}));
    const blockers=r.blockers.filter(b=>b.code!=='MANUAL_REVIEW_REQUIRED');
    try {authorizeCycleCoordinator(d,r.cycle,actorId);} catch(error) {blockers.push({code:error.code,message:error.message});}
    const reviewLink=r.tasks.find(x=>x.purpose==='review'&&x.state==='active');
    const reviewTask=reviewLink?d.prepare('SELECT * FROM tasks WHERE id=?').get(reviewLink.task_id):null;
    if(reviewTask&&!taskCapabilities(d,actorId,reviewTask).complete)blockers.push({code:'REVIEW_TASK_PERMISSION_REQUIRED',message:'Current Task permission does not allow completing the household review.'});
    if(reviewLink&&!isHouseholdMember(reviewLink.beneficiary_id,{db:d}))blockers.push({code:'REVIEW_COORDINATOR_REASSIGN_REQUIRED',message:'The recorded review coordinator is no longer a household member; review assignment recovery is required.'});
    for(const link of r.tasks.filter(x=>['personal','correction'].includes(x.purpose)&&x.state==='active'&&x.submission_revision==null)) {
      blockers.push({code:'PERSONAL_SUBMISSION_REQUIRED',beneficiary_id:link.beneficiary_id,message:'Submit your choices or acknowledge no applicable meals before household confirmation.'});
    }
    for(const gap of scope.gaps)if(!gap.acknowledged)blockers.push({code:'INGREDIENT_REVIEW_REQUIRED',meal_id:gap.meal_id,message:'Review and acknowledge missing ingredients or explicit portions with no diner demand.'});
    for(const ex of executions) {
      for(const blocker of ex.blockers)blockers.push({...blocker,meal_id:ex.meal_id});
      if(ex.frozen)blockers.push({code:'EXECUTION_HISTORY_REVIEW_REQUIRED',meal_id:ex.meal_id,message:'Existing frozen or started execution history needs reviewed adoption.'});
      for(const role of ex.roles)if(role.required&&role.status==='missing')blockers.push({code:'EXECUTION_ASSIGNEE_REQUIRED',meal_id:ex.meal_id,role:role.role,message:'Assign an eligible person or explicitly configure a claimable role.'});
    }
    return {...r,...scope,executions,blockers,ready:blockers.length===0};
  })();
}
export function acknowledgeCycleGaps(d,cycleId,options={}) {
  const {actorId,expectedRevision,mealIds,now=new Date().toISOString()}=options;
  return d.transaction(()=>{
    const c=load(d,cycleId);authorizeCycleCoordinator(d,c,actorId);
    return request(d,c,'gaps.acknowledge',options,{mealIds},()=>{
      assertOpenCurrent(d,c,expectedRevision);
      if(!Array.isArray(mealIds)||!mealIds.length||mealIds.some(x=>!Number.isSafeInteger(x)))fail('Provide the meal IDs whose gaps were reviewed.','CYCLE_ACK_INPUT',400);
      const r=reviewCycleReadiness(d,c.id,{actorId,now});
      for(const id of new Set(mealIds)) {
        const gap=r.gaps.find(x=>x.meal_id===id);if(!gap)fail('Meal has no current review gap in this cycle.');
        d.prepare('INSERT INTO meal_cycle_gap_acknowledgments(cycle_id,meal_id,fingerprint,actor_id,acknowledged_at) VALUES(?,?,?,?,?) ON CONFLICT(cycle_id,meal_id) DO UPDATE SET fingerprint=excluded.fingerprint,actor_id=excluded.actor_id,acknowledged_at=excluded.acknowledged_at').run(c.id,id,gap.fingerprint,actorId,now);
      }
      d.prepare('UPDATE meal_cycles SET revision=revision+1 WHERE id=?').run(c.id);
      return reviewCycleReadiness(d,c.id,{actorId,now});
    });
  }).immediate();
}
export function finalizeCycle(d,cycleId,options={}) {
  const {actorId,expectedRevision,requestKey,trigger='manual',now=new Date().toISOString()}=options;
  if(trigger!=='manual'&&(trigger!=='automatic'||!automaticInvocations.has(d)))fail('Automatic trigger requires trusted scheduler invocation.','CYCLE_TRIGGER',403);
  registerMealCycleTaskLifecycle();
  return d.transaction(()=>{
    const c=load(d,cycleId);authorizeCycleCoordinator(d,c,actorId);
    if(trigger==='automatic'&&(!getCycleSettings(d).enabled||c.finalization_mode!=='automatic'||c.confirmation_at>now))fail('Automatic confirmation is paused or not due.','CYCLE_NOT_DUE');
    return request(d,c,'cycle.finalize',options,{},()=>{
      const old=d.prepare("SELECT output_json FROM meal_cycle_results WHERE cycle_id=? AND kind='finalization'").get(c.id);
      if(old)return JSON.parse(old.output_json);
      assertOpenCurrent(d,c,expectedRevision);
      const r=reviewCycleReadiness(d,c.id,{actorId,now});
      if(trigger==='automatic'&&r.occurrences.some(x=>x.governed_at&&x.governed_at<=now&&x.governed_at>=c.creation_at))r.blockers.push({code:'MANUAL_REVIEW_REQUIRED',message:'The first governed meal has begun; confirm after manual review.'});
      if(r.blockers.length)fail(`Cycle is not ready: ${r.blockers.map(x=>x.message).join(' ')}`,'CYCLE_NOT_READY',409,r.blockers);
      const effective=captureCycleEffective(d,c.id,{actorId,now});
      const grocery_runs=[],execution_task_ids=[];
      withCycleMealWrite(d,c.id,()=>{
        for(const p of r.partitions.filter(x=>x.track_groceries&&x.source_meal_ids.length)) {
          const run=createOrRefreshGroceryRun(d,{listId:p.shopping_list_id,from:c.period_start,to:c.period_end,userId:actorId,logicalKey:`meal-cycle:${c.id}:list:${p.shopping_list_id}:context:${p.context_id||'home'}`,mealIds:p.source_meal_ids}).run;
          finalizeGroceryRun(d,run.id);publishGroceryRun(d,run.id);grocery_runs.push({run_id:run.id,shopping_list_id:p.shopping_list_id,context_id:p.context_id,meal_ids:p.source_meal_ids});
        }
        for(const ex of r.executions.filter(x=>x.enabled&&x.has_demand)) {
          const execution=ensureMealExecution(d,ex.meal_id,actorId);execution_task_ids.push(...(execution?.tasks||[]).map(x=>x.task_id).filter(Boolean));
        }
      });
      const revision=c.revision+1,result={cycle_id:c.id,revision,grocery_runs,execution_task_ids:[...new Set(execution_task_ids)]};
      d.prepare("UPDATE meal_cycles SET state='finalized',revision=?,finalized_revision=?,finalized_at=?,attempt_status='finalized',last_attempt_at=?,blockers_json='[]',source_fingerprint=? WHERE id=?").run(revision,revision,now,now,cycleSourceFingerprint(d,c.id),c.id);
      d.prepare('UPDATE meal_cycles SET permission_fingerprint=? WHERE id=?').run(cyclePermissionFingerprint(d,c.id),c.id);
      const task=d.prepare("SELECT t.* FROM tasks t JOIN meal_cycle_task_links l ON l.task_id=t.id WHERE l.cycle_id=? AND l.purpose='review' AND l.state='active'").get(c.id);
      if(task)changeTaskStatus(d,task.id,'done',{actorId,body:{expected_revision:task.revision},now});
      d.prepare("INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,source_revision,input_json,output_json,actor_id,reason) VALUES(?,'finalization',?,?,?,?,?,?,?)").run(c.id,requestKey,r.fingerprint,c.source_revision,JSON.stringify({revision:c.revision,partitions:r.partitions,effective}),JSON.stringify(result),actorId,trigger);
      return result;
    });
  }).immediate();
}
export function rescheduleCycle(d,cycleId,options={}) {
  const {actorId,expectedRevision,requestKey,schedule,confirmDueNow=false,now=new Date().toISOString()}=options;
  return d.transaction(()=>{
    const c=load(d,cycleId),settings=authorizeCycleCoordinator(d,c,actorId);
    return request(d,c,'cycle.reschedule',options,{schedule,confirmDueNow},()=>{
      assertOpenCurrent(d,c,expectedRevision);
      if(!schedule||Array.isArray(schedule)||Object.keys(schedule).some(k=>!['creation','response','confirmation','shopping','finalization_mode'].includes(k)))fail('Invalid cycle schedule.','CYCLE_SCHEDULE',400);
      const next={...settings,...schedule};if(!['manual','automatic'].includes(next.finalization_mode))fail('Invalid finalization mode.');
      const t=cycleInstants(next,c.period_start);
      if((t.confirmation<=now||t.response<=now)&&confirmDueNow!==true)fail('Past-due rescheduling requires explicit confirmDueNow.','CYCLE_CONFIRM_DUE_NOW');
      const r=reviewCycle(d,c.id,{actorId,now});
      if(r.occurrences.some(m=>!m.adopted_history&&(!m.governed_at||t.response>=m.governed_at||t.confirmation>=m.governed_at)))fail('Response and confirmation must precede each governed meal.','CYCLE_DEADLINE_AFTER_MEAL');
      d.prepare('UPDATE meal_cycles SET settings_json=?,finalization_mode=?,creation_at=?,response_at=?,confirmation_at=?,shopping_at=?,revision=revision+1,attempt_status=\'pending\',blockers_json=\'[]\' WHERE id=?').run(JSON.stringify(next),next.finalization_mode,t.creation,t.response,t.confirmation,t.shopping,c.id);
      for(const link of r.tasks) {
        const at={personal:t.response,review:t.confirmation,shopping:t.shopping,automatic_followup:t.confirmation}[link.purpose];
        if(!at||link.status!=='open')continue;const wall=utcToWall(at,c.timezone);
        d.prepare('UPDATE tasks SET due_date=?,due_time=?,revision=revision+1 WHERE id=? AND status=\'open\'').run(wall.date,wall.time.slice(0,5),link.task_id);
        d.prepare("UPDATE planning_obligations SET due_at=?,response_deadline=? WHERE task_id=? AND status='pending'").run(at,at,link.task_id);
      }
      const result=reviewCycleReadiness(d,c.id,{actorId,now});
      d.prepare("INSERT INTO meal_cycle_results(cycle_id,kind,request_key,input_fingerprint,source_revision,input_json,output_json,actor_id,reason) VALUES(?,'reschedule',?,?,?,?,?,?,?)").run(c.id,requestKey,r.fingerprint,c.source_revision,JSON.stringify({schedule,confirmDueNow}),JSON.stringify({cycle_id:c.id,revision:result.revision}),actorId,'explicit reschedule');
      return result;
    });
  }).immediate();
}
