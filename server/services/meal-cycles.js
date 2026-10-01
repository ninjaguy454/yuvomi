import {createHash} from 'node:crypto';
import {actorPermissions} from '../permissions.js';
import {isHouseholdMember} from './member-email.js';
import {getCycleSettings} from './meal-cycle-settings.js';
import {cycleInstants,validateCycleDate} from './meal-cycle-schedule.js';
import {availabilityInstantMs} from './presence.js';
import {materializeRecurringMealOccurrences} from './meal-recurrence.js';
import {utcToWall} from '../utils/timezone.js';
import {buildMealWeekModel,materializeMealPlanOccurrences,synchronizeMealMenuGeneration,saveMealDecision,publishCycleSharedMain,replaceCycleMealIngredients,cycleOccurrenceInputs,reconcileCycleAttendance,reconcileCycleOccurrence,createMealMenuItem,updateMealMenuItem,deleteMealMenuItem} from './meal-plans.js';
import {withCycleMealWrite,hasCycleMealWrite} from './meal-cycle-guards.js';
import {changeTaskStatus,registerTaskTransitionGuard} from './task-lifecycle.js';

function fail(message,status=409,code='MEAL_CYCLE_CONFLICT') {const e=new Error(message);e.status=status;e.code=code;throw e;}
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function authorize(d,actorId,beneficiaryId=actorId,write=false) {
  if(!Number.isSafeInteger(actorId)||!Number.isSafeInteger(beneficiaryId)||!isHouseholdMember(actorId,{db:d})||!isHouseholdMember(beneficiaryId,{db:d}))fail('Household member permission is required.',403);
  const p=actorPermissions(d,actorId);
  if(!['read','write'].includes(p.modules.meals)||(write&&p.modules.meals!=='write'))fail('Kitchen access permission is required.',403);
  if(actorId!==beneficiaryId&&!p.admin)fail('Only an administrator may act for another beneficiary.',403);
  return p;
}
function load(d,id) {const c=d.prepare('SELECT * FROM meal_cycles WHERE id=?').get(Number(id));if(!c)fail('Kitchen cycle not found.',404);return c;}
function request(d,scope,operation,key,actorId,revision,payload,action) {
  if(typeof key!=='string'||!key.trim()||key.length>200)fail('A stable cycle requestKey is required.',400);
  if(!Number.isSafeInteger(revision)||revision<0)fail('An expected revision is required.',400);
  const payloadHash=hash({actorId,revision,payload});
  const receipt=d.prepare('SELECT * FROM meal_cycle_requests WHERE scope_key=? AND operation=? AND request_key=?').get(scope,operation,key);
  if(receipt) {
    if(receipt.payload_hash!==payloadHash||receipt.actor_id!==actorId)fail('Cycle requestKey was already used for a different request.');
    return JSON.parse(receipt.result_json);
  }
  const result=action();
  d.prepare(`INSERT INTO meal_cycle_requests(scope_key,operation,request_key,cycle_id,actor_id,expected_revision,payload_hash,result_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(scope,operation,key,result.cycle_id,actorId,revision,payloadHash,JSON.stringify(result));return result;
}
function assertAnchored(settings,start) {
  validateCycleDate(start);const anchor=settings.first_period_start;
  if(start<anchor)fail('Cycle start precedes the configured cadence anchor.',400);
  if(settings.cadence==='monthly') {
    const day=Number(anchor.slice(8)),year=Number(start.slice(0,4)),month=Number(start.slice(5,7));
    if(Number(start.slice(8))!==Math.min(day,new Date(Date.UTC(year,month,0)).getUTCDate()))fail('Cycle start must align with the configured monthly anchor.',400);
  } else {
    const length={daily:1,weekly:7,fortnightly:14}[settings.cadence];
    if(!length||Math.round((Date.parse(start)-Date.parse(anchor))/86400000)%length)fail('Cycle start must align with the configured cadence anchor.',400);
  }
}
function assertTaskActors(d,settings) {
  if(!isHouseholdMember(settings.coordinator_id,{db:d}))fail('Coordinator household permission is required.',403);
  const coordinator=actorPermissions(d,settings.coordinator_id);
  if(['meals','tasks','shopping'].some(key=>coordinator.modules[key]!=='write')||['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.change_dates'].some(key=>coordinator.capabilities[key]!=='allow'))fail('Coordinator lacks current Kitchen, Tasks or Shopping permission.',403);
  if(!isHouseholdMember(settings.shopping_assignee_id,{db:d}))fail('Shopping assignee household permission is required.',403);
  const shopper=actorPermissions(d,settings.shopping_assignee_id);
  if(!['read','write'].includes(shopper.modules.meals)||shopper.modules.tasks!=='write'||shopper.modules.shopping!=='write'||shopper.capabilities['tasks.complete_own']!=='allow')fail('Shopping assignee needs Kitchen read access and current Tasks and Shopping permissions.',403);
}
function mealInstant(c,m) {
  const time=m.scheduled_time||m.preferred_time||m.latest_time||m.earliest_time;
  if(!time)return null;
  const value=availabilityInstantMs(`${m.date}T${time}`,c.timezone);return Number.isFinite(value)?new Date(value).toISOString():null;
}
/** Fingerprint authoritative sources, never derived review time or cycle task state.
 * External inputs are evaluated only for the owned dates, members and relevant plan coverage.
 */
export function cycleSourceFingerprint(d,cycleId) {
  const ids=d.prepare('SELECT meal_id FROM meal_cycle_memberships WHERE cycle_id=? ORDER BY meal_id').all(cycleId).map(x=>x.meal_id);
  const roots=ids.length?ids.map(()=>'?').join(','):'NULL';
  const meals=d.prepare(`SELECT * FROM meals WHERE id IN (${roots}) OR parent_meal_id IN (${roots}) ORDER BY id`).all(...ids,...ids);
  const all=meals.map(x=>x.id),marks=all.length?all.map(()=>'?').join(','):'NULL';
  // Output flags and audit clocks do not change planning demand.
  const planningRows=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['created_at','updated_at','on_shopping_list','shopping_item_id'].includes(key))));
  const data={meals:planningRows(meals)};
  for(const table of ['meal_participants','meal_person_decisions','meal_menu_items','meal_menu_generations','meal_occurrence_assignments','meal_ingredients'])data[table]=planningRows(d.prepare(`SELECT * FROM ${table} WHERE meal_id IN (${marks}) ORDER BY rowid`).all(...all));
  data.selections=d.prepare(`SELECT s.* FROM meal_person_menu_selections s JOIN meal_person_decisions p ON p.id=s.decision_id WHERE p.meal_id IN (${marks}) ORDER BY s.rowid`).all(...all);
  data.obligations=d.prepare(`SELECT * FROM planning_obligations WHERE entity_type='meal' AND entity_id IN (${marks}) ORDER BY id`).all(...all);
  const recipes=[...new Set([...meals,...data.meal_menu_items].map(x=>x.recipe_id).filter(Boolean))];
  const recipeMarks=recipes.length?recipes.map(()=>'?').join(','):'NULL';
  data.recipes=d.prepare(`SELECT id,title,yield_portions FROM recipes WHERE id IN (${recipeMarks}) ORDER BY id`).all(...recipes);
  data.recipe_ingredients=d.prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${recipeMarks}) ORDER BY id`).all(...recipes);
  data.execution_settings=d.prepare('SELECT * FROM meal_execution_settings ORDER BY id').all();
  data.grocery_settings=d.prepare('SELECT * FROM meal_grocery_settings ORDER BY id').all();
  data.effective=ids.map(id=>({meal_id:id,...cycleOccurrenceInputs(d,id)}));
  const members=[...new Set(data.effective.flatMap(x=>x.attendance.map(p=>p.user_id)))].sort((a,b)=>a-b);
  data.members=members.map(id=>({id,member:isHouseholdMember(id,{db:d}),
    skills:d.prepare('SELECT skill_id,proficiency FROM user_skill_proficiency WHERE user_id=? ORDER BY skill_id').all(id)}));
  const cycle=d.prepare('SELECT period_start,period_end,settings_json FROM meal_cycles WHERE id=?').get(cycleId);
  data.coverage=d.prepare("SELECT id,date,meal_type FROM meals WHERE date BETWEEN ? AND ? AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND meal_type IN ('breakfast','lunch','dinner') AND (meal_plan_rule_id IS NOT NULL OR scope IN ('household','travel')) ORDER BY id").all(cycle.period_start,cycle.period_end);
  const futurePlans=d.prepare("SELECT id,current_revision,home_enabled FROM meal_plans WHERE status='active' AND (effective_from IS NULL OR effective_from<=?) AND (effective_until IS NULL OR effective_until>=?) ORDER BY id").all(cycle.period_end,cycle.period_start);
  data.plan_sources=futurePlans.map(plan=>({plan,rules:planningRows(d.prepare("SELECT * FROM meal_plan_rules WHERE meal_plan_id=? AND active=1 AND meal_type IN ('breakfast','lunch','dinner') ORDER BY id").all(plan.id))})).filter(x=>x.rules.length);
  const activeContexts=d.prepare("SELECT id,context_type,starts_at,ends_at,place_id,status FROM planning_contexts WHERE status IN ('active','conflict','resolved') AND substr(starts_at,1,10)<=? AND substr(ends_at,1,10)>=? ORDER BY id").all(cycle.period_end,cycle.period_start);
  data.context_plans=activeContexts.map(context=>({context,links:d.prepare('SELECT meal_plan_id,effective_from,effective_until,is_primary FROM planning_context_meal_plans WHERE planning_context_id=? ORDER BY meal_plan_id').all(context.id)}));
  data.role_assignments=d.prepare(`SELECT r.* FROM meal_occurrence_role_assignments r JOIN meal_occurrence_assignments a ON a.id=r.occurrence_assignment_id WHERE a.meal_id IN (${roots}) ORDER BY r.id`).all(...ids);
  const contexts=[...new Set(meals.map(x=>x.planning_context_id).filter(Boolean))];
  data.context_groceries=contexts.map(id=>d.prepare('SELECT planning_context_id,track_groceries FROM planning_context_grocery_settings WHERE planning_context_id=?').get(id)||null);
  data.timezone=d.prepare("SELECT value FROM sync_config WHERE key='household_timezone'").get()||null;
  return hash(data);
}
/** Permissions invalidate operational eligibility, not saved meal answers.
 * Finalization always checks their current effective values independently. */
export function cyclePermissionFingerprint(d,cycleId) {
  const c=d.prepare('SELECT settings_json FROM meal_cycles WHERE id=?').get(cycleId),s=JSON.parse(c.settings_json);
  const ids=[...new Set([s.coordinator_id,s.shopping_assignee_id,...d.prepare('SELECT DISTINCT p.user_id FROM meal_participants p JOIN meal_cycle_memberships m ON m.meal_id=p.meal_id WHERE m.cycle_id=?').all(cycleId).map(x=>x.user_id)])].sort((a,b)=>a-b);
  return hash(ids.map(id=>{const p=actorPermissions(d,id);return {id,member:isHouseholdMember(id,{db:d}),modules:{tasks:p.modules.tasks,meals:p.modules.meals,shopping:p.modules.shopping},
    capabilities:Object.fromEntries(['tasks.complete_own','tasks.complete_others','tasks.claim',...(id===s.coordinator_id?['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.change_dates']:[])].map(k=>[k,p.capabilities[k]]))};}));
}
export function cyclePersonRequirements(d,occurrences,beneficiaryId) {
  if(!isHouseholdMember(beneficiaryId,{db:d}))return [];
  const list=[];
  for(const m of occurrences) {
    if(m.adopted_history||m.begun)continue;
    const p=m.participants.find(x=>x.user_id===beneficiaryId);if(!p)continue;
    const decision=m.decisions.find(x=>x.beneficiary_user_id===beneficiaryId);
    const away=p.status==='away',skip=p.status==='not_participating'||['away','not_participating'].includes(decision?.participation);
    if(m.choosers.some(x=>x.user_id===beneficiaryId) && m.rule?.policy!=='personal_choice')list.push({meal_id:m.id,kind:'main',complete:m.shared_choice_active&&m.selection_status==='selected',reason:m.shared_choice_active?null:'Choose the shared main.'});
    if(p.roles.includes('participant') || m.rule?.policy==='personal_choice') {
      const complete=away||skip||Boolean(decision?.confirmed&&decision.is_current_choice!==false&&decision.participation==='participating'&&decision.choice_kind!=='pending'&&(decision.choice_kind!=='household'||m.shared_choice_active));
      list.push({meal_id:m.id,kind:'decision',complete,contribution:away||skip?0:Number(decision?.portion_amount??1),status:away?'away':skip?'not_eating':complete?'ready':'pending',reason:complete?null:decision?.choice_kind==='household'&&!m.shared_choice_active?'Waiting for the shared main.':'Complete your meal answer.'});
    }
  }
  return list;
}
const requirements=cyclePersonRequirements;
function projection(d,c,actorId,beneficiaryId,permissions,now=new Date().toISOString()) {
  const settings=JSON.parse(c.settings_json),fingerprint=cycleSourceFingerprint(d,c.id);
  const owned=new Set(d.prepare('SELECT meal_id FROM meal_cycle_memberships WHERE cycle_id=?').all(c.id).map(x=>x.meal_id));
  const model=buildMealWeekModel(d,{from:c.period_start,to:c.period_end,actorId,memberId:beneficiaryId,isAdmin:permissions.admin,readOnly:true});
  const occurrences=model.occurrences.filter(x=>owned.has(x.id)).map(m=>{
    const at=mealInstant(c,m),adopted=at?at<=c.created_at:m.date<utcToWall(c.created_at,c.timezone).date;
    return {...m,governed_at:at,adopted_history:adopted,begun:Boolean(at&&at<=now),controls:{...m.controls,choose_backup:m.can_act_for&&m.applicable&&m.rule?.policy!=='personal_choice'}};
  });
  const tasks=d.prepare(`SELECT l.*,t.status,t.assigned_to,t.revision AS task_revision,a.path,a.params_json
    FROM meal_cycle_task_links l JOIN tasks t ON t.id=l.task_id LEFT JOIN task_action_links a ON a.task_id=t.id
    WHERE l.cycle_id=? ORDER BY l.id`).all(c.id).map(x=>({...x,obligations:JSON.parse(x.obligations_json),action_params:JSON.parse(x.params_json||'{}')}));
  const personalRequirements=requirements(d,occurrences,beneficiaryId),personalTask=tasks.findLast(x=>['personal','correction'].includes(x.purpose)&&x.beneficiary_id===beneficiaryId&&x.state==='active');
  const blockers=JSON.parse(c.blockers_json||'[]').filter(b=>b.code==='CYCLE_ADOPTION_REVIEW_REQUIRED');
  const governed=occurrences.filter(m=>!m.adopted_history);
  for(const m of governed) {
    if(!m.begun&&!m.shared_choice_active&&m.rotations?.chooser?.state==='needs_assignment')blockers.push({code:'CYCLE_CHOOSER_UNAVAILABLE',meal_id:m.id,message:'No eligible chooser is available; review availability or the configured rotation.'});
    if(!m.begun)for(const person of m.participants)if(!isHouseholdMember(person.user_id,{db:d}))blockers.push({code:'CYCLE_PARTICIPANT_INELIGIBLE',meal_id:m.id,beneficiary_id:person.user_id,message:'Review and reconcile this meal assignment: this saved participant is no longer a household member.'});
    if(!m.participants.some(p=>p.roles.includes('participant')))blockers.push({code:'ADOPTION_REVIEW_REQUIRED',meal_id:m.id,message:'Review the diners for this adopted household meal before confirming.'});
    if(!m.governed_at)blockers.push({code:'MEAL_TIME_REQUIRED',meal_id:m.id,message:'Set a meal time so Kitchen can check the automatic confirmation cutoff.'});
    else if(c.response_at>=m.governed_at||c.confirmation_at>=m.governed_at)blockers.push({code:'CYCLE_DEADLINE_AFTER_MEAL',meal_id:m.id,message:'Move response and confirmation before the first governed meal.'});
    if(m.context&&model.contexts.find(x=>x.id===m.context.id)?.status==='conflict')blockers.push({code:'CONTEXT_CONFLICT',meal_id:m.id,message:'Resolve the overlapping travel context.'});
  }
  if(!governed.length)blockers.push({code:'NO_FUTURE_MEALS',message:'No future governed meals remain in this period.'});
  if(c.finalization_mode==='automatic'&&governed.some(m=>m.begun))blockers.push({code:'MANUAL_REVIEW_REQUIRED',message:'A governed meal has begun; review this period manually.'});
  if(c.source_fingerprint&&c.source_fingerprint!==fingerprint)blockers.push({code:'CYCLE_SOURCE_CHANGED',message:'Meal sources changed; reconcile this cycle before confirming.',stored_fingerprint:c.source_fingerprint});
  const people=[...new Set(occurrences.flatMap(m=>m.participants.map(p=>p.user_id)))];
  for(const person of people)for(const r of requirements(d,occurrences,person).filter(x=>!x.complete))blockers.push({code:r.kind==='main'?'MAIN_REQUIRED':'RESPONSE_REQUIRED',beneficiary_id:person,...r,message:r.reason});
  const destinations=[...new Set(occurrences.map(m=>m.planning_context_id||null))].map(contextId=>{
    const context=contextId?model.contexts.find(x=>x.id===contextId):null;
    const grocery=contextId?d.prepare('SELECT * FROM planning_context_grocery_settings WHERE planning_context_id=?').get(contextId):null;
    const mealIds=occurrences.filter(m=>(m.planning_context_id||null)===contextId&&!m.adopted_history&&!m.begun).map(m=>m.id);
    const childIds=mealIds.length?d.prepare(`SELECT id FROM meals WHERE parent_meal_id IN (${mealIds.map(()=>'?').join(',')}) AND selection_status NOT IN ('declined','superseded') ORDER BY id`).all(...mealIds).map(x=>x.id):[];
    return {context_id:contextId,name:context?.name||'Home',shopping_list_id:settings.shopping_list_id,track_groceries:grocery?!!grocery.track_groceries:true,meal_ids:mealIds,source_meal_ids:[...mealIds,...childIds]};
  });
  if(!d.prepare('SELECT 1 FROM shopping_lists WHERE id=?').get(settings.shopping_list_id))blockers.push({code:'SHOPPING_DESTINATION_REQUIRED',message:'Choose an available Shopping list.'});
  const exclusions=model.occurrences.filter(m=>!owned.has(m.id)).map(m=>({meal_id:m.id,date:m.date,meal_type:m.meal_type,reason:['breakfast','lunch','dinner'].includes(m.meal_type)?'not_adopted':'legacy_slot',path:`/meals?meal=${m.id}`}));
  return {cycle:c,cycle_id:c.id,revision:c.revision,fingerprint,settings,occurrences,exclusions,personal:{beneficiary_id:beneficiaryId,requirements:personalRequirements,submitted:personalTask?.submission_revision!=null,submission_revision:personalTask?.submission_revision??null,needs_correction:Boolean(personalTask?.submission_revision&&personalRequirements.some(x=>!x.complete)),task_id:personalTask?.task_id??null},blockers,tasks,destinations};
}
/** Coherent synchronous read transaction; no materialization, Task or dish writes. */
export function reviewCycle(d,cycleId,{actorId,beneficiaryId=actorId,now=new Date().toISOString()}={}) {
  return d.transaction(()=>{const p=authorize(d,actorId,beneficiaryId);return projection(d,load(d,cycleId),actorId,beneficiaryId,p,now);})();
}
export function createCyclePlanningTask(d,c,purpose,beneficiaryId,obligations,{obligationKey='primary',supersedesLinkId=null}={}) {
  const settings=JSON.parse(c.settings_json),at={personal:c.response_at,correction:c.response_at,review:c.confirmation_at,shopping:c.shopping_at,automatic_followup:c.confirmation_at}[purpose];
  const due=utcToWall(at,c.timezone),title={personal:'Choose your meals',correction:'Review changed meal choices',review:'Review household meals',shopping:'Shop for household meals',automatic_followup:'Resolve blocked Kitchen confirmation'}[purpose];
  const taskId=Number(d.prepare(`INSERT INTO tasks(title,description,category,status,due_date,due_time,assigned_to,created_by,is_recurring,assignment_mode,points,visibility,expiration_policy)
    VALUES(?,?,'household','open',?,?,?,?,0,'fixed',0,'all','keep_overdue')`).run(title,`Kitchen ${c.period_start} to ${c.period_end}`,due.date,due.time.slice(0,5),beneficiaryId,settings.coordinator_id).lastInsertRowid);
  d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(taskId,beneficiaryId);
  d.prepare(`INSERT INTO task_assignment_context(task_id,strategy,state,override_allowed,beneficiary_user_id,source)
    VALUES(?,'fixed','assigned',0,?,'meal_cycle')`).run(taskId,beneficiaryId);
  d.prepare(`INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,responsible_user_id,due_at,response_deadline,status,metadata_json)
    VALUES('task',?,?,?,'primary',?,?,?,'pending',?)`).run(taskId,taskId,`meal-cycle:${c.id}:${purpose}:${beneficiaryId}:${obligationKey}`,beneficiaryId,at,at,JSON.stringify({cycle_id:c.id,purpose,beneficiary_id:beneficiaryId}));
  d.prepare(`INSERT INTO task_action_links(task_id,action_type,label,path,params_json,source_type,source_id)
    VALUES(?,'meal_cycle','Open Kitchen','/meals',?,'meal_cycle',?)`).run(taskId,JSON.stringify({cycle:c.id,beneficiary:beneficiaryId,purpose}),c.id);
  d.prepare(`INSERT INTO meal_cycle_task_links(cycle_id,purpose,beneficiary_id,task_id,obligations_json,obligation_key,supersedes_link_id) VALUES(?,?,?,?,?,?,?)`).run(c.id,purpose,beneficiaryId,taskId,JSON.stringify(obligations),obligationKey,supersedesLinkId);
  return taskId;
}
export function ensureCycle(d,{start,actorId,requestKey,expectedSettingsRevision,now=new Date().toISOString()}={}) {
  return d.transaction(()=>{
    const p=authorize(d,actorId,actorId,true),settings=getCycleSettings(d);
    if(!p.admin&&actorId!==settings.coordinator_id)fail('Coordinator permission is required to create a cycle.',403);
    return request(d,'cycles:household','cycle.ensure',requestKey,actorId,expectedSettingsRevision,{start},()=>{
      const existing=d.prepare('SELECT * FROM meal_cycles WHERE period_start=?').get(start);
      if(existing)return projection(d,existing,actorId,actorId,p,now);
      if(!settings.enabled)fail('Kitchen cycle generation is disabled.');
      if(settings.revision!==expectedSettingsRevision)fail('Cycle settings revision conflict.');
      assertTaskActors(d,settings);
      assertAnchored(settings,start);const t=cycleInstants(settings,start);
      if(d.prepare('SELECT id FROM meal_cycles WHERE period_start<=? AND period_end>=?').get(t.period.end,start))fail('Cycle coverage overlaps an existing owned period.');
      const today=utcToWall(now,settings.timezone).date;
      if(t.period.end<today)fail('Historical periods cannot create planning Tasks.');
      materializeRecurringMealOccurrences(d,{from:start<today?today:start,to:t.period.end,mealTypes:['breakfast','lunch','dinner']});
      materializeMealPlanOccurrences(d,{from:start<today?today:start,to:t.period.end,actorId,mealTypes:['breakfast','lunch','dinner']});
      const meals=d.prepare("SELECT * FROM meals WHERE date BETWEEN ? AND ? AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND meal_type IN ('breakfast','lunch','dinner') AND (meal_plan_rule_id IS NOT NULL OR scope IN ('household','travel')) ORDER BY id").all(start,t.period.end);
      for(const meal of meals) {
        if(d.prepare('SELECT 1 FROM meal_grocery_item_sources WHERE meal_id=? OR meal_id IN (SELECT id FROM meals WHERE parent_meal_id=?) LIMIT 1').get(meal.id,meal.id))fail('Existing grocery ownership needs review. Keep this period in its existing Shopping flow and activate a future cycle.',409,'CYCLE_ADOPTION_GROCERY_CONFLICT');
        if(d.prepare(`SELECT 1 FROM meal_execution_snapshots s LEFT JOIN meal_execution_tasks o ON o.meal_snapshot_id=s.id LEFT JOIN tasks t ON t.id=o.task_id
          WHERE (s.meal_id=? OR s.meal_id IN (SELECT id FROM meals WHERE parent_meal_id=?))
          AND (s.frozen_at IS NOT NULL OR t.status IN ('in_progress','done','expired') OR (o.id IS NOT NULL AND (t.id IS NULL OR t.archived_at IS NOT NULL))) LIMIT 1`).get(meal.id,meal.id))fail('Started execution history needs review. Keep this period in its existing flow and activate a future cycle.',409,'CYCLE_ADOPTION_EXECUTION_CONFLICT');
      }
      for(const meal of meals)synchronizeMealMenuGeneration(d,meal.id);
      const id=Number(d.prepare(`INSERT INTO meal_cycles(period_start,period_end,timezone,settings_json,settings_revision,finalization_mode,creation_at,response_at,confirmation_at,shopping_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(start,t.period.end,settings.timezone,JSON.stringify(settings),settings.revision,settings.finalization_mode,t.creation,t.response,t.confirmation,t.shopping,now).lastInsertRowid);
      for(const meal of meals)d.prepare('INSERT INTO meal_cycle_memberships(cycle_id,meal_id) VALUES(?,?)').run(id,meal.id);
      const c=load(d,id);
      withCycleMealWrite(d,id,()=>{for(const meal of meals) {
        const at=mealInstant(c,meal);
        if(at&&at>now)reconcileCycleOccurrence(d,meal.id,{cycleId:id,sourceRevision:1,now,initial:true});
      }});
      const r=projection(d,c,actorId,actorId,p,now);
      const people=[...new Set(r.occurrences.flatMap(m=>m.participants.map(x=>x.user_id)))];
      for(const person of people) {const required=requirements(d,r.occurrences,person);if(required.some(x=>x.status!=='away'))createCyclePlanningTask(d,c,'personal',person,required);}
      if(r.occurrences.some(m=>!m.adopted_history&&!m.begun)) {
        createCyclePlanningTask(d,c,'review',settings.coordinator_id,[]);createCyclePlanningTask(d,c,'shopping',settings.shopping_assignee_id,[]);
      }
      d.prepare('UPDATE meal_cycles SET source_fingerprint=?,permission_fingerprint=?,source_revision=1 WHERE id=?').run(cycleSourceFingerprint(d,id),cyclePermissionFingerprint(d,id),id);
      return projection(d,load(d,id),actorId,actorId,p,now);
    });
  }).immediate();
}
function assertOpen(c,expectedRevision) {
  if(c.state!=='open')fail('Plan confirmed; propose a reviewed adjustment.');
  if(c.revision!==expectedRevision)fail('Cycle revision conflict. Refresh the cycle before saving.');
}
function ensureCurrentSources(d,c) {
  if(c.source_fingerprint!==cycleSourceFingerprint(d,c.id))fail('Cycle sources changed; reconcile this cycle before saving.',409,'CYCLE_SOURCE_CHANGED');
}
function finishMutation(d,c) {
  d.prepare('UPDATE meal_cycles SET revision=revision+1,source_revision=source_revision+1,source_fingerprint=? WHERE id=?').run(cycleSourceFingerprint(d,c.id),c.id);
}
/** Internal canonical writer shared by Save and reviewed adjustments. No HTTP adapter. */
export function writeCyclePersonChanges(d,c,{actorId,beneficiaryId=actorId,changes}) {
      if(!hasCycleMealWrite(d,c.id))fail('Canonical cycle changes require the internal write scope.',403);
      const p=authorize(d,actorId,beneficiaryId,true);
      if(!Array.isArray(changes)||!changes.length||changes.length>200)fail('Provide an ordered nonempty changes array.',400);
      withCycleMealWrite(d,c.id,()=>{
        for(const change of changes) {
          if(!change||!Number.isSafeInteger(change.meal_id)||!d.prepare('SELECT 1 FROM meal_cycle_memberships WHERE cycle_id=? AND meal_id=?').get(c.id,change.meal_id))fail('Meal does not belong to this cycle.',400);
          const meal=d.prepare('SELECT * FROM meals WHERE id=?').get(change.meal_id),at=mealInstant(c,meal);
          if((at&&at<=new Date().toISOString())||meal.date<utcToWall(new Date().toISOString(),c.timezone).date)fail('This meal has begun; retain its recorded history.');
          if(change.kind==='main') {
            if(Object.keys(change).some(k=>!['meal_id','kind','title','recipe_id'].includes(k)))fail('Invalid shared-main change.',400);
            publishCycleSharedMain(d,change.meal_id,change,{actorId,beneficiaryId,isAdmin:p.admin});
          } else if(change.kind==='sides') {
            if(Object.keys(change).some(k=>!['meal_id','kind','operations'].includes(k))||!Array.isArray(change.operations)||!change.operations.length||change.operations.length>50)fail('Provide bounded side changes.',400);
            for(const operation of change.operations) {
              if(!operation||Object.keys(operation).some(k=>!['operation','id','title','recipe_id'].includes(k))||!['add','edit','remove'].includes(operation.operation))fail('Invalid side operation.',400);
              const options={isAdmin:p.admin,beneficiaryId};
              if(operation.operation==='add') {
                if(operation.id!=null)fail('A new side cannot specify an existing identity.',400);
                createMealMenuItem(d,change.meal_id,{item_type:'side',title:operation.title,recipe_id:operation.recipe_id},actorId,options);
              } else {
                if(!Number.isSafeInteger(operation.id)||!d.prepare("SELECT 1 FROM meal_menu_items i JOIN meals m ON m.id=i.meal_id WHERE i.id=? AND i.meal_id=? AND i.item_type='side' AND (i.menu_generation=m.current_menu_generation OR i.menu_generation=(SELECT max(generation) FROM meal_menu_generations WHERE meal_id=m.id AND status='fulfilled'))").get(operation.id,change.meal_id))fail('Choose an existing current side from this meal.',400);
                if(operation.operation==='remove')deleteMealMenuItem(d,change.meal_id,operation.id,actorId,options);
                else updateMealMenuItem(d,change.meal_id,operation.id,{item_type:'side',title:operation.title,recipe_id:operation.recipe_id},actorId,options);
              }
            }
            // Menu editors stage the current chooser generation. Publish it with
            // the unchanged primary main so new sides become usable meal choices.
            if(meal.title)publishCycleSharedMain(d,change.meal_id,{title:meal.title,recipe_id:meal.recipe_id},{actorId,beneficiaryId,isAdmin:p.admin});
          } else if(change.kind==='ingredients') {
            if(Object.keys(change).some(k=>!['meal_id','kind','ingredients'].includes(k)))fail('Invalid ingredient change.',400);
            replaceCycleMealIngredients(d,change.meal_id,change.ingredients,{actorId,beneficiaryId,isAdmin:p.admin});
          } else if(change.kind==='decision') {
            if(Object.keys(change).some(k=>!['meal_id','kind','decision'].includes(k))||!change.decision||typeof change.decision!=='object'||Array.isArray(change.decision))fail('Invalid personal decision.',400);
            if(['beneficiary_user_id','beneficiaryId','actorId','cycleId'].some(k=>Object.hasOwn(change.decision,k)))fail('Decision beneficiary comes from the authorized cycle operation.',400);
            let decision=change.decision;
            if(Object.hasOwn(decision,'select_shared_main')) {
              const {select_shared_main,select_side_ids,...rest}=decision;
              if(select_shared_main!==true||Object.hasOwn(rest,'menu_item_ids'))fail('Select the shared main without combining selection formats.',400);
              if(select_side_ids!==undefined&&(!Array.isArray(select_side_ids)||select_side_ids.length>50||select_side_ids.some(id=>!Number.isSafeInteger(id))))fail('Select existing side identities explicitly.',400);
              const items=d.prepare("SELECT i.id FROM meal_menu_items i JOIN meals m ON m.id=i.meal_id WHERE i.meal_id=? AND i.item_type='entree' AND i.menu_generation=m.current_menu_generation AND i.recipe_id IS m.recipe_id AND i.title=m.title ORDER BY i.id").all(change.meal_id);
              if(items.length!==1)fail('Exactly one shared main must be available.');
              // Retain only this beneficiary's latest selected sides. Released older
              // generations remain history; invalid latest sides need explicit input.
              const selections=d.prepare('SELECT i.id,i.item_type,i.menu_generation,i.title,i.recipe_id,i.generation_position,i.position FROM meal_person_menu_selections s JOIN meal_person_decisions p ON p.id=s.decision_id JOIN meal_menu_items i ON i.id=s.menu_item_id WHERE p.meal_id=? AND p.beneficiary_user_id=? AND s.selected=1').all(change.meal_id,beneficiaryId);
              const latest=Math.max(0,...selections.map(x=>x.menu_generation)),generation=d.prepare('SELECT current_menu_generation FROM meals WHERE id=?').get(change.meal_id).current_menu_generation;
              const sides=select_side_ids===undefined?selections.filter(x=>x.item_type==='side'&&x.menu_generation===latest):[...new Set(select_side_ids)].map(id=>{
                const side=d.prepare("SELECT * FROM meal_menu_items WHERE id=? AND meal_id=? AND item_type='side'").get(id,change.meal_id);if(!side)fail('Selected side does not belong to this meal.',400);return side;
              });
              const currentSides=sides.map(side=>{
                if(side.menu_generation===generation)return side.id;
                const matches=d.prepare("SELECT id FROM meal_menu_items WHERE meal_id=? AND menu_generation=? AND item_type='side' AND COALESCE(generation_position,position)=? AND title=? AND recipe_id IS ?").all(change.meal_id,generation,side.generation_position??side.position,side.title,side.recipe_id);
                if(matches.length!==1)fail('A previously selected side changed. Choose the current main and sides explicitly.');
                return matches[0].id;
              });
              decision={...rest,menu_item_ids:[...items.map(x=>x.id),...currentSides]};
            }
            else if(Object.hasOwn(decision,'select_side_ids'))fail('Explicit side identities require the shared-main selector.',400);
            saveMealDecision(d,change.meal_id,{...decision,beneficiary_user_id:beneficiaryId},{actorId,isAdmin:p.admin});
          } else fail('Unknown cycle change kind.',400);
        }
        // A retained chooser duty grants authority to answer, not attendance.
        // Restore effective parent/child status before accepting this fingerprint.
        for(const mealId of new Set(changes.map(change=>change.meal_id)))reconcileCycleAttendance(d,mealId);
      });
}
export function saveCyclePerson(d,cycleId,{actorId,beneficiaryId=actorId,expectedRevision,requestKey,changes}={}) {
  return d.transaction(()=>{
    const p=authorize(d,actorId,beneficiaryId,true),c=load(d,cycleId);
    return request(d,`cycle:${c.id}`,'person.save',requestKey,actorId,expectedRevision,{beneficiaryId,changes},()=>{
      assertOpen(c,expectedRevision);ensureCurrentSources(d,c);
      withCycleMealWrite(d,c.id,()=>writeCyclePersonChanges(d,c,{actorId,beneficiaryId,changes}));
      finishMutation(d,c);return projection(d,load(d,c.id),actorId,beneficiaryId,p);
    });
  }).immediate();
}
function readyToSubmit(d,c,actorId,beneficiaryId) {
  const p=authorize(d,actorId,beneficiaryId,true);ensureCurrentSources(d,c);
  const r=projection(d,c,actorId,beneficiaryId,p);
  if(r.personal.requirements.some(x=>!x.complete))fail('Your meal answers are incomplete; finish pending choices before submitting.',409,'CYCLE_PERSON_INCOMPLETE');
  return r;
}
/** Register at startup/route initialization; task-lifecycle never imports Kitchen. */
export function registerMealCycleTaskLifecycle() {
  registerTaskTransitionGuard('meal-cycle',(d,task,status,{actorId,principal})=>{
    if(!d.prepare("SELECT 1 FROM sqlite_master WHERE name='meal_cycle_task_links' AND type='table'").get())return;
    const link=d.prepare('SELECT * FROM meal_cycle_task_links WHERE task_id=?').get(task.id);if(!link)return;
    if(link.state!=='active')fail('This Kitchen work was superseded; open the current cycle Task.',409,'CYCLE_TASK_SUPERSEDED');
    const c=load(d,link.cycle_id);
    if(typeof principal!=='number')fail('Household member permission is required for this cycle Task.',403);
    authorize(d,actorId,link.beneficiary_id,true);
    if(link.submission_revision!=null&&status!=='done')fail('Keep the recorded Kitchen submission; edit answers in the cycle.');
    if(status!=='done')return;
    if(link.purpose==='review') {if(c.state!=='finalized')fail('Confirm this household plan through Kitchen finalization.');return;}
    if(!['personal','correction'].includes(link.purpose))return; // Shopping completion has no purchase/Pantry side effect.
    if(c.state!=='open')fail('Plan confirmed; personal submission history is preserved.');
    readyToSubmit(d,c,actorId,link.beneficiary_id);
    if(link.purpose==='correction')d.prepare('UPDATE tasks SET points=0 WHERE id=?').run(task.id);
    if(!link.submission_revision) {
      d.prepare('UPDATE meal_cycle_task_links SET submission_revision=? WHERE id=?').run(c.revision+1,link.id);
      d.prepare('UPDATE meal_cycles SET revision=revision+1 WHERE id=?').run(c.id);
    }
  });
}
export function submitCyclePerson(d,cycleId,{actorId,beneficiaryId=actorId,expectedRevision,requestKey}={}) {
  return d.transaction(()=>{
    const p=authorize(d,actorId,beneficiaryId,true),c=load(d,cycleId);
    // Revalidate authorization and current obligation even when a receipt exists.
    readyToSubmit(d,c,actorId,beneficiaryId);
    return request(d,`cycle:${c.id}`,'person.submit',requestKey,actorId,expectedRevision,{beneficiaryId},()=>{
      assertOpen(c,expectedRevision);const r=projection(d,c,actorId,beneficiaryId,p);
      if(!r.personal.task_id)fail('No personal submission Task is needed for this beneficiary.');
      const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(r.personal.task_id);
      changeTaskStatus(d,task.id,'done',{actorId,body:{expected_revision:task.revision}});
      return projection(d,load(d,c.id),actorId,beneficiaryId,p);
    });
  }).immediate();
}
