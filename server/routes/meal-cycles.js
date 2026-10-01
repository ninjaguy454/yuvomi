import express from 'express';
import * as db from '../db.js';
import {actorPermissions,moduleAccessVerdict} from '../permissions.js';
import {tokenAllows} from '../scopes.js';
import {isHouseholdMember} from '../services/member-email.js';
import {taskCapabilities} from '../services/task-access.js';
import {getCycleSettings,saveCycleSettings,previewCycleSettings} from '../services/meal-cycle-settings.js';
import {ensureCycle,reviewCycle,saveCyclePerson,submitCyclePerson} from '../services/meal-cycles.js';
import {reviewCycleReadiness,acknowledgeCycleGaps,finalizeCycle,rescheduleCycle} from '../services/meal-cycle-finalization.js';
import {recoverCycleAssignments} from '../services/meal-cycle-reconciliation.js';
import {proposeCycleAdjustment,applyCycleAdjustment,cancelCycleAdjustment,submitCycleAdjustmentPerson,reviewCycleAdjustment} from '../services/meal-cycle-adjustments.js';
import {cycleInstants} from '../services/meal-cycle-schedule.js';
import {listMealCycleGenerationFailures} from '../services/meal-cycle-scheduler.js';
import {getSettings as getExecutionSettings,previewMealExecution} from '../services/meal-execution.js';
import {buildMealWeekModel} from '../services/meal-plans.js';
import {evaluatePresence} from '../services/presence.js';
import {ingredientDemandChanges} from '../services/meal-cycle-review.js';

const router=express.Router();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>object?.[k]!==undefined).map(k=>[k,object[k]]));
const positive=value=>{if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value)))fail('Choose a valid Kitchen record.');return Number(value);};
function permitted(req,module,access='read') {
  const level=actorPermissions(db.get(),req.authUserId).modules[module];
  return (level==='write'||(access==='read'&&level==='read'))&&tokenAllows(req.authScopes,module,access)&&moduleAccessVerdict(req.sessionModuleAccess,module,access)==='allow';
}
function requireModule(req,module,access='write'){if(!permitted(req,module,access))fail(`Current ${module} ${access} access is required.`,403);}
function admin(req){if(!actorPermissions(db.get(),req.authUserId).admin)fail('A household administrator is required.',403);}
function body(req,fields){const value=req.body||{};if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))fail('Unexpected Kitchen operation input.');return value;}
function request(req,fields=[]){const b=body(req,['expected_revision','request_key',...fields]);if(!Number.isSafeInteger(b.expected_revision)||b.expected_revision<0||typeof b.request_key!=='string'||!b.request_key.trim()||b.request_key.length>200)fail('Expected revision and stable request key are required.');return {actorId:req.authUserId,expectedRevision:b.expected_revision,requestKey:b.request_key};}
function beneficiary(req,value){const id=value==null?req.authUserId:positive(value);if(id!==req.authUserId&&!actorPermissions(db.get(),req.authUserId).admin)fail('Only an administrator may act for another person.',403);return id;}
function record(id){const c=db.get().prepare('SELECT * FROM meal_cycles WHERE id=?').get(positive(id));if(!c)fail('Kitchen period not found.',404);return c;}
function reviewer(req,c){return actorPermissions(db.get(),req.authUserId).admin||JSON.parse(c.settings_json).coordinator_id===req.authUserId;}
function taskVisible(req,id){return Boolean(id&&permitted(req,'tasks')&&taskCapabilities(db.get(),req,{id}).view);}
function safeSettings(req,s){return pick(s,['revision','enabled','timezone','cadence','first_period_start','creation','response','confirmation','shopping','finalization_mode','coordinator_id',...(permitted(req,'shopping')?['shopping_list_id','shopping_assignee_id']:[])]);}
function occurrence(req,m,coordinating,person){
  const out=pick(m,['id','date','meal_type','title','recipe_id','planning_context_id','shared_choice_active','selection_status','chooser_status','applicable','can_act_for','governed_at','adopted_history','begun','recipe_yield_portions']);
  const menu=item=>pick(item,['id','meal_id','item_type','title','recipe_id','menu_generation','generation_position','position']);
  const role=p=>pick(p,['user_id','display_name','roles','is_chooser','is_cook','is_supervisor']);
  out.context=m.context?pick(m.context,['id','context_key','name','context_type','place_id']):null;
  out.rule=m.rule?pick(m.rule,['id','policy','max_entree_choices','max_side_choices','preferred_time']):null;
  out.menu_items=(m.menu_items||[]).filter(item=>['entree','side'].includes(item.item_type)).map(menu);
  const own=m.decisions?.find(x=>x.beneficiary_user_id===person)||(m.my_decision?.beneficiary_user_id===person?m.my_decision:null);
  out.my_decision=own?{...pick(own,['id','beneficiary_user_id','participation','choice_kind','confirmed','portion_amount','selected_recipe_id','selected_meal_title','selected_meal_id','menu_item_ids','selected_menu_item_ids']),menu_items:(own.menu_items||[]).map(menu)}:null;
  for(const key of ['choosers','cooks','supervisors'])out[key]=(m[key]||[]).map(role);
  out.participants=(m.participants||[]).filter(p=>coordinating||p.user_id===person).map(p=>({...role(p),status:p.status,decision:coordinating?p.decision:out.my_decision}));
  if(coordinating)Object.assign(out,pick(m,['decisions','portions','planned_portions','cook_portions','portion_summary','dish_portions']));
  else out.dish_portions=(m.dish_portions||[]).filter(d=>d.kind!=='individual'||d.beneficiary_user_ids?.includes(person)).map(d=>d.kind==='individual'?pick(d,['meal_id','menu_item_id','recipe_id','title','kind','primary','planned_portions','cook_portions','beneficiary_user_ids']):pick(d,['meal_id','menu_item_id','recipe_id','title','kind','primary']));
  // Derived metadata is built only after the authorized shared/personal view exists.
  out.recipe_bases=[...new Set([out.recipe_id,out.my_decision?.selected_recipe_id,...out.menu_items.map(x=>x.recipe_id),...(out.dish_portions||[]).map(x=>x.recipe_id)].filter(Boolean))].map(id=>db.get().prepare('SELECT id,title,yield_portions,serving_basis_amount,serving_basis_unit,serving_basis_label FROM recipes WHERE id=?').get(id)).filter(Boolean);
  out.participants=out.participants.map(p=>{
    let reason=null;
    if(permitted(req,'calendar'))try{reason=evaluatePresence(db.get(),{userId:p.user_id,startAt:`${m.date}T${m.preferred_time||'00:00'}:00`,endAt:`${m.date}T${m.preferred_time||'23:59'}:00`,targetPlaceId:m.context?.place_id||null,policy:'available_before_due'}).reason;}catch{/* The existing participation status remains authoritative. */}
    return {...p,attendance_reason:reason};
  });
  // Domain menus/rules are meal data; never transport serialized operational rows.
  const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!k.endsWith('_json')&&!/^(task_|shopping_|grocery_|execution_)/.test(k)).map(([k,v])=>[k,strip(v)])):value;
  return strip(out);
}
function taskRows(req,rows){return (rows||[]).filter(x=>taskVisible(req,x.task_id)).map(x=>pick(x,['task_id','purpose','beneficiary_id','state','status','submission_revision','task_revision','obligation_key']));}
function executionRows(req,rows){if(!permitted(req,'tasks'))return [];const name=id=>id?db.get().prepare('SELECT display_name FROM users WHERE id=?').get(id)?.display_name||null:null;return (rows||[]).map(x=>({meal_id:x.meal_id,enabled:x.enabled,has_demand:x.has_demand,frozen:x.frozen,roles:(x.roles||[]).map(r=>({...pick(r,['role','required','status','strategy','planned_assignee_id']),planned_assignee_name:name(r.planned_assignee_id),...(taskVisible(req,r.output_task_id)?{output_task_id:r.output_task_id,output_assignee_id:r.output_assignee_id??db.get().prepare('SELECT assigned_to FROM tasks WHERE id=?').get(r.output_task_id)?.assigned_to,output_assignee_name:name(r.output_assignee_id??db.get().prepare('SELECT assigned_to FROM tasks WHERE id=?').get(r.output_task_id)?.assigned_to)}:{})})),tasks:taskRows(req,x.tasks)}));}
function preservedRows(req,rows){return (rows||[]).filter(x=>!(x.task_id||x.task_ids?.length)||permitted(req,'tasks')).filter(x=>!(x.shopping_item_id||x.item_id||x.grocery_item_id)||permitted(req,'shopping')).map(x=>{
  const out=pick(x,['kind','reason','meal_id','source_meal_id','message']);
  if(permitted(req,'shopping'))Object.assign(out,pick(x,['shopping_item_id','item_id','grocery_item_id','source_id','name','quantity','deferred_quantity','planned_quantity','purchased_quantity','meal_ids','historical_quantity','actual_quantity','coverage_quantity','coverage_status','demand_quantity','unit','additions_deferred']));
  if(permitted(req,'shopping')){const id=x.shopping_item_id||x.item_id||x.grocery_item_id;if(id)out.shopping_list_id=db.get().prepare('SELECT list_id FROM shopping_items WHERE id=?').get(id)?.list_id||null;}
  if(permitted(req,'tasks')){out.task_ids=(x.task_ids||[]).filter(id=>taskVisible(req,id));if(taskVisible(req,x.task_id))out.task_id=x.task_id;}
  return out;
});}
function output(req,result,householdReview=true){return {...pick(result,['cycle_id','revision','proposal_id','status','requires_manual_review']),grocery_runs:permitted(req,'shopping')?(result.grocery_runs||[]).map(x=>pick(x,['run_id','shopping_list_id','context_id','meal_ids'])):[],execution_task_ids:(result.execution_task_ids||[]).filter(id=>taskVisible(req,id)),preserved:preservedRows(req,result.preserved),reductions:householdReview&&permitted(req,'shopping')?(result.reductions||[]).map(row=>({...pick(row,['grocery_item_id','shopping_item_id','previous','outstanding']),...pick(Number.isSafeInteger(row.grocery_item_id)?db.get().prepare('SELECT name,unit FROM meal_grocery_items WHERE id=?').get(row.grocery_item_id):null,['name','unit'])})):[]};}
function proposalAllowed(req,c,p){return reviewer(req,c)||p.actor_id===req.authUserId||JSON.parse(p.batches_json).some(b=>b.beneficiaryId===req.authUserId)||Boolean(db.get().prepare("SELECT 1 FROM meal_cycle_task_links WHERE cycle_id=? AND beneficiary_id=? AND state='active' AND obligation_key LIKE 'adjustment:response:%'").get(c.id,req.authUserId));}
function proposal(req,c,id,person=req.authUserId){
  const p=db.get().prepare('SELECT * FROM meal_cycle_adjustments WHERE cycle_id=? AND id=?').get(c.id,positive(id));if(!p)fail('Adjustment not found.',404);if(!proposalAllowed(req,c,p))fail('This adjustment is not assigned to you.',403);
  const r=reviewCycleAdjustment(db.get(),c.id,{actorId:req.authUserId,proposalId:p.id}),full=reviewer(req,c);
  const view={...pick(r,['cycle_id','revision','proposal_id','status','proposer_id','stale','evaluated_at','ready']),blockers:(r.blockers||[]).filter(b=>full||b.beneficiary_id===person).map(b=>pick(b,['code','meal_id','beneficiary_id','message','role'])),occurrences:(r.desired?.occurrences||[]).filter(m=>full||m.participants?.some(x=>x.user_id===person)).map(m=>occurrence(req,m,full,person))};
  if(full)Object.assign(view,{before:(r.baseline?.effective?.occurrences||[]).map(m=>occurrence(req,m,true,person)),gaps:r.gaps||[],warnings:r.warnings||[],executions:executionRows(req,r.executions),...output(req,r)});
  if(full&&permitted(req,'shopping'))view.grocery_changes=ingredientDemandChanges(r.baseline?.effective,r.desired);
  return view;
}
function projection(req,r){
  const c=r.cycle,full=reviewer(req,c),person=r.personal.beneficiary_id,currentSettings=getCycleSettings(db.get());
  const review=full&&c.state==='open'?reviewCycleReadiness(db.get(),c.id,{actorId:req.authUserId}):r;
  const tasks=taskRows(req,review.tasks).filter(x=>full||x.beneficiary_id===person||x.purpose==='shopping');
  const out={cycle:pick(c,['id','period_start','period_end','timezone','state','revision','finalization_mode','creation_at','response_at','confirmation_at','shopping_at','finalized_at','attempt_status']),cycle_id:c.id,revision:r.revision,
    automation:{generation_enabled:currentSettings.enabled,automatic_confirmation_paused:c.state==='open'&&c.finalization_mode==='automatic'&&!currentSettings.enabled},
    permissions:{review:full,admin:actorPermissions(db.get(),req.authUserId).admin,write:permitted(req,'meals','write'),tasks:permitted(req,'tasks'),shopping:permitted(req,'shopping'),submit:permitted(req,'tasks','write')&&permitted(req,'meals','write')},
    personal:{...r.personal,...(!tasks.some(x=>x.task_id===r.personal.task_id)?{submitted:null,submission_revision:null,needs_correction:null}:{}),beneficiary_name:db.get().prepare('SELECT display_name FROM users WHERE id=?').get(person)?.display_name||'',task_id:tasks.some(x=>x.task_id===r.personal.task_id)?r.personal.task_id:null},
    occurrences:r.occurrences.map(m=>occurrence(req,m,full,person)),tasks,
    blockers:(review.blockers||[]).filter(b=>full||b.beneficiary_id===person||b.meal_id&&r.personal.requirements.some(x=>x.meal_id===b.meal_id)).map(b=>pick(b,['code','message','meal_id','beneficiary_id','role'])),
    destinations:permitted(req,'shopping')?r.destinations.map(x=>({...pick(x,['context_id','name','shopping_list_id','track_groceries','meal_ids']),shopping_list_name:db.get().prepare('SELECT name FROM shopping_lists WHERE id=?').get(x.shopping_list_id)?.name||''})):[],
    adjustments:db.get().prepare("SELECT * FROM meal_cycle_adjustments WHERE cycle_id=? AND status='pending' ORDER BY id").all(c.id).filter(p=>proposalAllowed(req,c,p)).map(p=>({id:p.id,proposer_id:p.actor_id,status:p.status,created_at:p.created_at})),
  };
  if(full){out.settings=safeSettings(req,r.settings);out.ready=review.ready===true;out.gaps=review.gaps||[];out.warnings=review.warnings||[];out.executions=executionRows(req,review.executions||r.occurrences.map(m=>previewMealExecution(db.get(),m.id,{actorId:req.authUserId})));out.exclusions=r.exclusions;out.execution_settings=permitted(req,'tasks')?pick(getExecutionSettings(db.get()),['enabled','generate_preparation','generate_cooking','generate_supervision','generate_serving','generate_cleanup']):null;out.blockers.push(...JSON.parse(c.blockers_json||'[]').filter(b=>['ADJUSTMENT_PRESERVED_OUTPUT','FINALIZED_SOURCE_CHANGE'].includes(b.code)).map(b=>pick(b,['code','message','meal_id'])));out.members=db.get().prepare('SELECT id,display_name FROM users ORDER BY display_name').all().filter(u=>isHouseholdMember(u.id,{db:db.get()}));}
  const accepted=db.get().prepare("SELECT output_json FROM meal_cycle_results WHERE cycle_id=? AND kind IN ('finalization','adjustment') ORDER BY id DESC LIMIT 1").get(c.id);
  if(accepted)out.result=output(req,JSON.parse(accepted.output_json),full);
  return out;
}
const handle=fn=>(req,res)=>{try{res.set('Cache-Control','no-store');res.json({data:db.get().transaction(()=>fn(req))()});}catch(error){res.status(error.status||(error instanceof TypeError?400:500)).json({error:error.status||error instanceof TypeError?error.message:'Kitchen could not finish this operation.',code:error.code||'KITCHEN_REQUEST'});}};
router.use((req,res,next)=>{
  try{if(req.devicePrincipal||req.authRole==='device')fail('Sign in personally to open a Kitchen period.',403);req.authUserId=req.authUserId??req.session?.userId;if(!Number.isSafeInteger(req.authUserId))fail('Sign in to open Kitchen.',401);if(!isHouseholdMember(req.authUserId,{db:db.get()}))fail('Household membership is required.',403);requireModule(req,'meals',['GET','HEAD'].includes(req.method)?'read':'write');next();}catch(e){res.status(e.status||403).json({error:e.message});}
});
router.get('/settings',handle(req=>{
  const s=getCycleSettings(db.get()),isAdmin=actorPermissions(db.get(),req.authUserId).admin;
  if(!isAdmin)return {enabled:s.enabled,revision:s.revision,timezone:s.timezone,admin:false};
  return {...safeSettings(req,s),admin:true,members:db.get().prepare('SELECT id,display_name FROM users ORDER BY display_name').all().filter(u=>isHouseholdMember(u.id,{db:db.get()})),lists:permitted(req,'shopping')?db.get().prepare('SELECT id,name FROM shopping_lists ORDER BY name').all():[],execution_settings:permitted(req,'tasks')?pick(getExecutionSettings(db.get()),['enabled','generate_preparation','generate_cooking','generate_supervision','generate_serving','generate_cleanup']):null,generation_failures:listMealCycleGenerationFailures(db.get())};
}));
router.put('/settings',handle(req=>{const o=request(req,['settings']);admin(req);const pause=req.body.settings?.enabled===false&&Object.keys(req.body.settings).length===1;if(!pause){requireModule(req,'tasks');requireModule(req,'shopping');}return safeSettings(req,saveCycleSettings(db.get(),req.body.settings,o));}));
router.post('/preview',handle(req=>{body(req,['settings']);admin(req);const p=previewCycleSettings(db.get(),req.body.settings);const model=p.schedule?buildMealWeekModel(db.get(),{from:p.schedule.period.start,to:p.schedule.period.end,actorId:req.authUserId,memberId:req.authUserId,isAdmin:true,readOnly:true}):null;return {...p,settings:safeSettings(req,p.settings),existing_meals:model?.occurrences.length||0,adoption_note:'Existing protected grocery or cooking history requires review; choose a future period if adoption is blocked.'};}));
router.get('/',handle(req=>db.get().prepare('SELECT id,period_start,period_end,state,revision,finalization_mode FROM meal_cycles ORDER BY period_start DESC LIMIT 100').all()));
router.post('/ensure',handle(req=>{const o=request(req,['start']);admin(req);requireModule(req,'tasks');requireModule(req,'shopping');return projection(req,ensureCycle(db.get(),{actorId:o.actorId,requestKey:o.requestKey,expectedSettingsRevision:o.expectedRevision,start:req.body.start}));}));
router.get('/:cycleId',handle(req=>projection(req,reviewCycle(db.get(),positive(req.params.cycleId),{actorId:req.authUserId,beneficiaryId:beneficiary(req,req.query.beneficiary_id)}))));
router.post('/:cycleId/save',handle(req=>{const o=request(req,['beneficiary_id','changes']);return projection(req,saveCyclePerson(db.get(),positive(req.params.cycleId),{...o,beneficiaryId:beneficiary(req,req.body.beneficiary_id),changes:req.body.changes}));}));
router.post('/:cycleId/submit',handle(req=>{const o=request(req,['beneficiary_id']);requireModule(req,'tasks');return projection(req,submitCyclePerson(db.get(),positive(req.params.cycleId),{...o,beneficiaryId:beneficiary(req,req.body.beneficiary_id)}));}));
router.post('/:cycleId/confirm',handle(req=>{const o=request(req);requireModule(req,'tasks');requireModule(req,'shopping');return output(req,finalizeCycle(db.get(),positive(req.params.cycleId),o));}));
router.post('/:cycleId/acknowledge',handle(req=>{const o=request(req,['meal_ids']);requireModule(req,'tasks');requireModule(req,'shopping');return projection(req,acknowledgeCycleGaps(db.get(),positive(req.params.cycleId),{...o,mealIds:req.body.meal_ids}));}));
router.post('/:cycleId/reschedule-preview',handle(req=>{body(req,['schedule']);const c=record(req.params.cycleId);if(!reviewer(req,c))fail('Household review permission is required.',403);const s=req.body.schedule;if(!s||Object.keys(s).some(k=>!['creation','response','confirmation','shopping','finalization_mode'].includes(k)))fail('Invalid schedule.');const times=cycleInstants({...JSON.parse(c.settings_json),...s},c.period_start);return {schedule:times,due_now:times.response<=new Date().toISOString()||times.confirmation<=new Date().toISOString()};}));
router.post('/:cycleId/reschedule',handle(req=>{const o=request(req,['schedule','confirm_due_now']);requireModule(req,'tasks');requireModule(req,'shopping');return projection(req,rescheduleCycle(db.get(),positive(req.params.cycleId),{...o,schedule:req.body.schedule,confirmDueNow:req.body.confirm_due_now===true}));}));
router.post('/:cycleId/recover',handle(req=>{const o=request(req,['coordinator_id','shopping_assignee_id']);admin(req);requireModule(req,'tasks');requireModule(req,'shopping');return output(req,recoverCycleAssignments(db.get(),positive(req.params.cycleId),{...o,coordinatorId:positive(req.body.coordinator_id),shoppingAssigneeId:positive(req.body.shopping_assignee_id)}));}));
router.get('/:cycleId/adjustments/:proposalId',handle(req=>proposal(req,record(req.params.cycleId),req.params.proposalId,beneficiary(req,req.query.beneficiary_id))));
router.post('/:cycleId/adjustments/preview',handle(req=>{const o=request(req,['beneficiary_id','changes','base_proposal_id','acknowledge_meal_ids']);requireModule(req,'tasks');const c=record(req.params.cycleId);if(req.body.base_proposal_id)proposal(req,c,req.body.base_proposal_id);if(req.body.acknowledge_meal_ids?.length)requireModule(req,'shopping');const r=proposeCycleAdjustment(db.get(),c.id,{...o,beneficiaryId:beneficiary(req,req.body.beneficiary_id),changes:req.body.changes,baseProposalId:req.body.base_proposal_id,acknowledgeMealIds:req.body.acknowledge_meal_ids});return proposal(req,record(c.id),r.proposal_id,beneficiary(req,req.body.beneficiary_id));}));
router.post('/:cycleId/adjustments/apply',handle(req=>{const o=request(req,['proposal_id']);requireModule(req,'tasks');requireModule(req,'shopping');return output(req,applyCycleAdjustment(db.get(),positive(req.params.cycleId),{...o,proposalId:positive(req.body.proposal_id)}));}));
router.post('/:cycleId/adjustments/cancel',handle(req=>{const o=request(req,['proposal_id']);const c=record(req.params.cycleId);proposal(req,c,req.body.proposal_id);return output(req,cancelCycleAdjustment(db.get(),c.id,{...o,proposalId:positive(req.body.proposal_id)}));}));
router.post('/:cycleId/adjustments/submit',handle(req=>{const o=request(req,['proposal_id','beneficiary_id']);requireModule(req,'tasks');const c=record(req.params.cycleId);proposal(req,c,req.body.proposal_id);return output(req,submitCycleAdjustmentPerson(db.get(),c.id,{...o,proposalId:positive(req.body.proposal_id),beneficiaryId:beneficiary(req,req.body.beneficiary_id)}));}));
export default router;
