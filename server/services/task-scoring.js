import {taskWindowAncestors} from './task-window.js';
import {peekRewardOccurrenceProvenance} from './task-recurrence-frontier.js';
import {visibilityWhere} from './visibility.js';

export class TaskScoringError extends Error {
  constructor(message,status=400,reason=null){super(message);this.status=status;this.reason=reason;}
}
const table=(d,name)=>!!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const readTask=(d,id)=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const unique=values=>[...new Set(values)].sort((a,b)=>a-b);
export function taskScoringAssignments(d,task){
  const ids=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(r=>r.user_id);
  return ids.length?ids:task.assigned_to?[task.assigned_to]:[];
}
function publicTaskAncestry(d,task){
  // Shared displays require the entire structural chain, including parents
  // above an independent Activity owner. Missing/cyclic evidence is unknown.
  let row=readTask(d,task.id);const seen=new Set();
  while(row){
    if(seen.has(row.id))return null;seen.add(row.id);
    if(row.visibility!=='all')return ['private','assignees'].includes(row.visibility)?false:null;
    if(row.parent_task_id==null)return true;
    row=readTask(d,row.parent_task_id);
  }
  return null;
}
function taskVisibilitySnapshot(d,task){
  // Visibility follows the Task creator and actual assignment joins. Reward
  // recipients may use scalar/inherited fallbacks that confer no read access.
  return {visibility:task.visibility||'all',created_by:task.created_by,
    assigned:d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(row=>row.user_id),public_ancestry:publicTaskAncestry(d,task)};
}
function workflowOwner(d,id){return table(d,'workflow_instance_tasks')&&!!d.prepare("SELECT 1 FROM workflow_instance_tasks WHERE task_id=? AND role='primary'").get(id);}
function workflowContainer(d,id){return table(d,'workflow_instances')&&!!d.prepare('SELECT 1 FROM workflow_instances WHERE parent_task_id=?').get(id);}
export function taskScoringProjection(d,id){
  return table(d,'task_activity_support_tasks')&&!!d.prepare(`SELECT 1 FROM task_activity_support_tasks WHERE task_id=?
    UNION ALL SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=? LIMIT 1`).get(id,id)
    ||table(d,'workflow_instance_tasks')&&!!d.prepare("SELECT 1 FROM workflow_instance_tasks WHERE task_id=? AND role='supervisor'").get(id);
}
/** Activity owners are independent work scopes below a Workflow container.
 * Ordinary nested structures remain one legacy scope until explicitly reviewed. */
export function taskScoringRoot(d,taskId){
  let task=readTask(d,taskId);if(!task)return null;
  if(table(d,'task_activity_support_tasks')){
    const source=d.prepare(`SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?
      UNION ALL SELECT source_task_id FROM task_supervision_actions WHERE counterpart_task_id=? LIMIT 1`).get(task.id,task.id);
    if(source)task=readTask(d,source.source_task_id)||task;
  }
  const seen=new Set();
  while(task.parent_task_id&&!workflowOwner(d,task.id)&&!seen.has(task.id)){
    seen.add(task.id);const parent=readTask(d,task.parent_task_id);if(!parent)break;task=parent;
  }
  return task;
}
export function taskScoringRows(d,root){
  const rows=d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN scope s ON t.parent_task_id=s.id)
    SELECT t.* FROM tasks t JOIN scope s ON s.id=t.id ORDER BY t.id`).all(root.id);
  return rows.filter(row=>!taskScoringProjection(d,row.id)&&taskScoringRoot(d,row.id)?.id===root.id);
}
export function taskScoringIdentity(d,id){return peekRewardOccurrenceProvenance(d,id).logicalKey;}
function scopeSettlements(d,root){
  if(!table(d,'task_scoring_settlements'))return [];
  return d.prepare(`SELECT s.*,EXISTS(SELECT 1 FROM task_scoring_settlement_releases r WHERE r.settlement_id=s.id) AS released
    FROM task_scoring_settlements s WHERE root_task_id=? OR root_logical_key=? ORDER BY id`).all(root.id,taskScoringIdentity(d,root.id));
}
function aggregate(recipients){
  const totals=new Map();for(const {user_id,points} of recipients)if(points>0)totals.set(user_id,(totals.get(user_id)||0)+points);
  return [...totals].sort(([a],[b])=>a-b).map(([user_id,points])=>({user_id,points}));
}
const recipients=row=>JSON.parse(row.recipients_json);
function everEarned(settlements){return settlements.some(row=>row.earned_once||recipients(row).some(member=>member.points>0));}
function blockedWindow(d,id){return taskWindowAncestors(d,id).some(row=>['expired','skipped'].includes(row.status));}
function enrolled(d){return new Set(d.prepare('SELECT user_id FROM reward_participants WHERE enabled=1').all().map(row=>row.user_id));}

/** One recipient/source resolver is shared by previews and every award caller.
 * The legacy branch intentionally retains the existing actor/learner fallback.
 * Explicit modes filter configured recipients without replacing them. */
export function taskRewardDefinition(d,taskOrId,{root=null,assigned=null,parentAssigned=null,actingUserId=null,executionFacts=undefined}={}){
  const task=typeof taskOrId==='object'?taskOrId:readTask(d,taskOrId);
  if(!task)return null;root??=taskScoringRoot(d,task.id);
  const mode=root?.scoring_mode||'legacy',points=task.points||0,eligible=enrolled(d);
  const own=assigned??taskScoringAssignments(d,task);
  const prospective=executionFacts!==undefined;
  const action=prospective?executionFacts.supervision:table(d,'task_supervision_actions')?d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(task.id):null;
  let payable=prospective?!['helper_projection','container'].includes(executionFacts.role):!taskScoringProjection(d,task.id)&&!workflowContainer(d,task.id);
  if(mode==='whole_task')payable&&=task.id===root.id;
  if(mode==='subtasks')payable&&=task.parent_task_id===root.id;
  if(!payable)return {task,root,mode,points,targets:[],outcome:'suppressed'};
  let targets;
  if(action?.execution_mode==='delegated'&&action.state!=='not_required'){
    targets=(prospective?executionFacts.role==='source_root':action.action_task_id===action.source_task_id)?[]:eligible.has(action.supervisor_user_id)?[action.supervisor_user_id]:[];
  }else if(mode==='legacy'){
    // The original resolver only used join assignments before its overrides.
    const join=assigned??d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(task.id).map(r=>r.user_id);
    targets=join.filter(id=>eligible.has(id));
    if(!targets.length){
      if(action?.learner_user_id)targets=eligible.has(action.learner_user_id)?[action.learner_user_id]:[];
      else if(!prospective&&table(d,'task_activity_support_tasks')&&task.assigned_to&&d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE source_task_id=?').get(task.id))targets=eligible.has(task.assigned_to)?[task.assigned_to]:[];
      else targets=actingUserId&&eligible.has(actingUserId)?[actingUserId]:[];
    }
  }else{
    let configured=own;
    if(!configured.length&&action?.learner_user_id)configured=[action.learner_user_id];
    else if(!configured.length&&mode==='subtasks')configured=parentAssigned??taskScoringAssignments(d,root);
    targets=configured.filter(id=>eligible.has(id));
  }
  targets=unique(targets);
  return {task,root,mode,points,targets,outcome:points<=0?'zero':targets.length?'earned':'no_recipients'};
}
function visible(d,task,viewerId){
  if(task.id<0)return viewerId==null||task.visibility==='all'||task.created_by===viewerId||task.visibility==='assignees'&&(task._assigned||[]).includes(viewerId);
  return viewerId==null||!!d.prepare(`SELECT 1 FROM tasks t WHERE t.id=@id AND ${visibilityWhere('t','task_assignments','task_id','@viewer')}`).get({id:task.id,viewer:viewerId});
}
function context(d,taskId,viewerId=null){
  const root=taskScoringRoot(d,taskId),task=readTask(d,taskId);
  if(!root||!task||!visible(d,task,viewerId)||!visible(d,root,viewerId))throw new TaskScoringError('Task not found.',404);
  const rows=taskScoringRows(d,root),settlements=scopeSettlements(d,root);
  return {root,rows,settlements,mode_locked:everEarned(settlements),review_required:!!root.scoring_review_required};
}
function potential(d,ctx,{fresh=false,viewerId=null,authorizedTaskIds=null}={}){
  if(workflowContainer(d,ctx.root.id)||!fresh&&blockedWindow(d,ctx.root.id))return [];
  const settled=new Set(ctx.settlements.filter(row=>!row.released).map(row=>row.logical_key));
  const members=[];for(const task of ctx.rows){
    if(authorizedTaskIds&&!authorizedTaskIds.has(task.id))continue;
    if(!visible(d,task,viewerId))continue;
    if(!fresh&&(settled.has(taskScoringIdentity(d,task.id))||task.status==='done'||task.archived_at||blockedWindow(d,task.id)))continue;
    const definition=taskRewardDefinition(d,task,{root:ctx.root,actingUserId:viewerId});
    if(definition.outcome==='earned')members.push(...definition.targets.map(user_id=>({user_id,points:definition.points})));
  }
  return aggregate(members);
}
function publicSettlements(d,ctx,viewerId,authorizedTaskIds,includeHistoricalSettlements,includeIds=false){
  return ctx.settlements.filter(row=>{
    const task=readTask(d,row.task_id);
    if(authorizedTaskIds&&!authorizedTaskIds.has(row.task_id)&&!(includeHistoricalSettlements&&(!task||task.archived_at)))return false;
    if(task){
      if(viewerId==null&&authorizedTaskIds&&publicTaskAncestry(d,task)!==true)return false;
      return viewerId==null&&authorizedTaskIds&&!authorizedTaskIds.has(task.id)?task.visibility==='all':visible(d,task,viewerId);
    }
    const snapshot=JSON.parse(row.visibility_json);
    // An explicit historical ID does not prove the deleted ancestor chain.
    // Old leaf-only snapshots remain unknown for shared reads, never repaired.
    if(viewerId==null)return authorizedTaskIds?snapshot.visibility==='all'&&snapshot.public_ancestry===true:true;
    return snapshot.visibility==='all'||snapshot.created_by===viewerId||snapshot.visibility==='assignees'&&snapshot.assigned.includes(viewerId);
  }).map(row=>({...(includeIds?{settlement_id:row.id}:{}),task_id:row.task_id,points:row.points,recipients:recipients(row),mode:row.mode,outcome:row.outcome,settled_at:row.settled_at}));
}
export function taskScoringSummary(d,taskId,{viewerId=null,authorizedTaskIds=null,includeHistoricalSettlements=false}={}){
  const authorized=authorizedTaskIds==null?null:new Set(authorizedTaskIds);
  const ctx=context(d,taskId,viewerId),settlements=publicSettlements(d,ctx,viewerId,authorized,includeHistoricalSettlements),earned=aggregate(settlements.flatMap(row=>row.recipients)),available=potential(d,ctx,{viewerId,authorizedTaskIds:authorized});
  return {mode:ctx.root.scoring_mode||'legacy',root_task_id:ctx.root.id,mode_locked:ctx.mode_locked,review_required:ctx.review_required,
    earned,potential:available,settled_task_ids:settlements.map(row=>row.task_id),personal_total:viewerId==null?null:[...earned,...available].filter(row=>row.user_id===viewerId).reduce((sum,row)=>sum+row.points,0),settlements};
}
function points(value){
  if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isInteger(Number(value))||Number(value)<0||Number(value)>10000)throw new TaskScoringError('Points must be an integer from 0 through 10000.',400,'invalid_points');return Number(value);
}
function assignmentIds(value){
  if(!Array.isArray(value)||value.some(id=>!Number.isSafeInteger(Number(id))||Number(id)<=0))throw new TaskScoringError('Assignments must contain valid member IDs.',400,'invalid_assignment');return unique(value.map(Number));
}
function proposedContext(d,ctx,taskId,proposed,{fresh=false,allowLegacy=false,childNamespace='task'}={}){
  let root={...ctx.root},rows=ctx.rows.map(row=>({...row}));
  if(Object.hasOwn(proposed,'scoring_mode')){
    if(!['whole_task','subtasks',...(allowLegacy?['legacy']:[])].includes(proposed.scoring_mode))throw new TaskScoringError('Choose Whole task or Each subtask.',400,'invalid_scoring_mode');root.scoring_mode=proposed.scoring_mode;root.scoring_review_required=0;
  }
  const edited=rows.find(row=>row.id===Number(taskId));
  if(!edited)throw new TaskScoringError('Review scoring on the original work Task.',409,'scoring_review_required');
  if(Object.hasOwn(proposed,'points'))edited.points=points(proposed.points);
  if(Object.hasOwn(proposed,'assigned_to'))edited._assigned=assignmentIds(proposed.assigned_to);
  if(edited.id===root.id)root={...root,...edited,scoring_mode:root.scoring_mode,scoring_review_required:root.scoring_review_required};
  if(Object.hasOwn(proposed,'subtasks')){
    if(!Array.isArray(proposed.subtasks))throw new TaskScoringError('Subtasks must be an array.');
    const children=rows.filter(row=>row.parent_task_id===edited.id&&(childNamespace!=='template'||row._template_id!=null)),existing=new Map(children.map(row=>[row._template_id??row.id,row])),seen=new Set();
    // Keep external future-template identity across both normalization passes.
    // New transient work gets an unused ID and never borrows a positional row.
    let transient=rows.reduce((lowest,row)=>Math.min(lowest,row.id),0)-1;
    const next=proposed.subtasks.map((child,index)=>{
      const given=child.id==null?null:Number(child.id);
      if(given!=null&&(!Number.isSafeInteger(given)||given<=0||!fresh&&!existing.has(given)||seen.has(given)))throw new TaskScoringError('Review scoring within one original work scope.',409,'scoring_review_required');
      const prior=given==null?null:existing.get(given),id=prior?.id??transient--;seen.add(given??id);
      const row=prior?{...prior}:{...edited,id,_template_id:given,parent_task_id:edited.id,points:0,status:'open',archived_at:null,assigned_to:null,_assigned:[]};
      row._draft_index=index;
      if(Object.hasOwn(child,'points'))row.points=points(child.points);
      const value=child.assigned_user_ids??child.assigned_to;
      if(value!==undefined)row._assigned=assignmentIds(value);
      return row;
    });
    rows=rows.filter(row=>row.parent_task_id!==edited.id).concat(next);
  }
  return {...ctx,root,rows};
}
function prospectiveTemplateId(task,root){return task.id===root.id?null:task._template_id??(task.id>0?task.id:null);}
function scoringUnitRef(task,root,fresh){
  if(fresh){
    if(task.id===root.id)return {kind:'definition_root'};
    const templateId=prospectiveTemplateId(task,root);if(templateId!=null)return {kind:'template',template_id:templateId};
  }else if(task.id>0)return {kind:'task',task_id:task.id};
  return {kind:'draft',draft_index:task._draft_index};
}
const projectionUnavailable=()=>new TaskScoringError('The prospective execution context cannot be prepared safely.',409,'scoring_projection_unavailable');
function executionRefKey(ref){
  if(ref?.kind==='definition_root'&&Object.keys(ref).length===1)return 'root';
  if(ref?.kind==='template'&&Object.keys(ref).length===2&&Number.isSafeInteger(ref.template_id)&&ref.template_id>0)return `template:${ref.template_id}`;
  throw projectionUnavailable();
}
function phaseExecutionFacts(d,ctx,prepared){
  const metadata=prepared?.context,date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value));
  if(metadata?.kind!=='next_occurrence'||!Number.isSafeInteger(metadata.generation)||metadata.generation<1||!date(metadata.as_of_date)
    ||metadata.assumed_completion_date!=null&&!date(metadata.assumed_completion_date)||!['fresh','existing_untouched'].includes(metadata.preparation)
    ||!Array.isArray(metadata.conditions)||metadata.conditions.some(value=>typeof value!=='string')||!Array.isArray(prepared.units)
    ||!Array.isArray(prepared.warnings)||prepared.warnings.some(warning=>warning?.reason!=='prospective_supervision_unresolved'))throw projectionUnavailable();
  const memberIds=new Set(d.prepare('SELECT id FROM users').all().map(row=>row.id)),safeMember=id=>Number.isSafeInteger(id)&&id>0&&memberIds.has(id);
  const expected=new Set(ctx.rows.map(task=>executionRefKey(scoringUnitRef(task,ctx.root,true)))),facts=new Map();
  for(const unit of prepared.units){
    if(!unit||typeof unit!=='object'||Array.isArray(unit))throw projectionUnavailable();
    const key=executionRefKey(unit.ref);
    if(!expected.has(key)||facts.has(key)||Object.keys(unit).some(field=>!['ref','role','assigned_user_ids','supervision'].includes(field))
      ||!['source_root','source_action','helper_projection','container'].includes(unit.role)||key==='root'&&unit.role==='source_action'||key!=='root'&&unit.role==='source_root'
      ||!Array.isArray(unit.assigned_user_ids)||unit.assigned_user_ids.some(id=>!safeMember(id))||new Set(unit.assigned_user_ids).size!==unit.assigned_user_ids.length
      ||!Object.hasOwn(unit,'supervision')||unit.supervision===undefined)throw projectionUnavailable();
    const action=unit.supervision;
    if(action!==null&&(!action||Object.keys(action).some(field=>!['execution_mode','state','learner_user_id','supervisor_user_id'].includes(field))
      ||!['delegated','supervised'].includes(action.execution_mode)||!['assigned','unresolved','not_required'].includes(action.state)
      ||!Object.hasOwn(action,'learner_user_id')||!Object.hasOwn(action,'supervisor_user_id')
      ||action.learner_user_id!==null&&!safeMember(action.learner_user_id)||action.supervisor_user_id!==null&&!safeMember(action.supervisor_user_id)
      ||action.state==='assigned'&&(!action.learner_user_id||!action.supervisor_user_id||action.learner_user_id===action.supervisor_user_id)||action.state==='unresolved'&&action.supervisor_user_id!==null))throw projectionUnavailable();
    facts.set(key,unit);
  }
  if(facts.size!==expected.size||workflowContainer(d,ctx.root.id)&&facts.get('root').role!=='container'
    ||taskScoringProjection(d,ctx.root.id)&&!['helper_projection','container'].includes(facts.get('root').role))throw projectionUnavailable();
  return facts;
}
function phaseWarnings(prepared){
  // Full canonical hidden work may block the scope. Return one generic reason,
  // never its references, labels, qualifications, candidates or unit count.
  return prepared.warnings.length||prepared.units.some(unit=>unit.supervision?.state==='unresolved')
    ?[{reason:'prospective_supervision_unresolved',message:'The prospective occurrence requires supervision that is not currently resolved.'}]:[];
}
function proposedPotential(d,ctx,options){
  // Resolve proposed assignments through the same recipient rules as awards.
  const settled=new Set(ctx.settlements.filter(row=>!row.released).map(row=>row.logical_key)),members=[],units=[];
  const rootFacts=options.executionFacts?.get('root');
  if(workflowContainer(d,ctx.root.id)||rootFacts&&['container','helper_projection'].includes(rootFacts.role)||!options.fresh&&blockedWindow(d,ctx.root.id))return {totals:[],units};
  for(const task of ctx.rows){
    if(options.authorizedTaskIds&&!options.authorizedTaskIds.has(task.id)&&!(task.id<0&&options.authorizedTaskIds.has(task.parent_task_id)))continue;
    if(options.fresh&&task.id!==ctx.root.id&&options.authorizedTemplateIds&&!options.authorizedTemplateIds.has(prospectiveTemplateId(task,ctx.root)))continue;
    if(!visible(d,task,options.viewerId))continue;
    if(!options.fresh&&task.id>0&&(settled.has(taskScoringIdentity(d,task.id))||task.status==='done'||task.archived_at||blockedWindow(d,task.id)))continue;
    const executionFacts=options.executionFacts?.get(executionRefKey(scoringUnitRef(task,ctx.root,true)));
    const definition=taskRewardDefinition(d,task,{root:ctx.root,assigned:executionFacts?.assigned_user_ids??task._assigned,parentAssigned:rootFacts?.assigned_user_ids??ctx.root._assigned,actingUserId:options.viewerId,executionFacts});
    if(definition.outcome==='suppressed')continue;
    const recipients=definition.targets.map(user_id=>({user_id,points:definition.points}));
    if(definition.outcome==='earned')members.push(...recipients);
    if(options.includeUnits)units.push({ref:scoringUnitRef(task,ctx.root,options.fresh),points:definition.points,recipients,outcome:definition.outcome});
  }
  return {totals:aggregate(members),units};
}
function validateMutation(d,ctx,next,proposed,scope){
  const changedMode=next.root.scoring_mode!==ctx.root.scoring_mode;
  const nested=ctx.rows.some(row=>row.id!==ctx.root.id&&row.parent_task_id!==ctx.root.id);
  if(Object.hasOwn(proposed,'scoring_mode')&&(workflowContainer(d,ctx.root.id)||nested))throw new TaskScoringError('Review scoring on each executable Activity or flatten this nested work scope.',409,'scoring_review_required');
  if(scope!=='future_only'){
    if(changedMode&&ctx.mode_locked)throw new TaskScoringError('This occurrence has already earned points. Its scoring mode is fixed.',409,'scoring_mode_locked');
    const byId=new Map(next.rows.map(row=>[row.id,row]));
    for(const settlement of ctx.settlements){const row=byId.get(settlement.task_id),before=ctx.rows.find(task=>task.id===settlement.task_id);
      if(row&&before&&row.points!==before.points)throw new TaskScoringError('Completed reward terms are already settled.',409,'settled_rewards');}
  }
  if(ctx.review_required&&!ctx.mode_locked&&next.root.scoring_mode==='legacy'&&next.rows.some(row=>row.points>0))throw new TaskScoringError('Choose a scoring mode before new rewards can be earned.',409,'scoring_review_required');
}
export function assertTaskScoringMutation(d,taskId,proposed={}, {scope='occurrence'}={}){
  const ctx=context(d,taskId),next=proposedContext(d,ctx,taskId,proposed,{fresh:scope==='future_only'});validateMutation(d,ctx,next,proposed,scope);return true;
}
export function previewTaskScoring(d,taskId,proposed={}, {viewerId=null,scope='occurrence',beforeDefinition=null,authorizedTaskIds=null,includeHistoricalSettlements=false,includeUnits=false,authorizedTemplateIds=null,beforeExecutionContext=undefined,afterExecutionContext=undefined}={}){
  const ctx=context(d,taskId,viewerId),fresh=scope==='future_only',authorized=authorizedTaskIds==null?null:new Set(authorizedTaskIds),templates=authorizedTemplateIds==null?null:new Set(authorizedTemplateIds),options={fresh,viewerId,authorizedTaskIds:authorized,authorizedTemplateIds:templates,includeUnits};
  const settlements=publicSettlements(d,ctx,viewerId,authorized,includeHistoricalSettlements,includeUnits),earned=aggregate(settlements.flatMap(row=>row.recipients));
  // Canonical template IDs are independent of current Task IDs. Only the
  // normalized template rows may supply omitted terms on the proposal pass.
  const childNamespace=fresh&&beforeDefinition?'template':'task';
  const prepared=beforeExecutionContext!==undefined||afterExecutionContext!==undefined;
  if(prepared&&(!fresh||!Array.isArray(beforeDefinition?.subtasks)||beforeExecutionContext===undefined||afterExecutionContext===undefined))throw projectionUnavailable();
  const base=fresh&&beforeDefinition?proposedContext(d,ctx,taskId,beforeDefinition,{fresh:true,allowLegacy:true,childNamespace}):ctx;
  const beforeFacts=prepared?phaseExecutionFacts(d,base,beforeExecutionContext):undefined,before=proposedPotential(d,base,{...options,executionFacts:beforeFacts});
  let next=base,warnings=[],valid=true;try{next=proposedContext(d,base,taskId,proposed,{fresh,childNamespace});validateMutation(d,ctx,next,proposed,scope);}catch(error){if(!(error instanceof TaskScoringError))throw error;warnings=[{reason:error.reason,message:error.message}];valid=false;}
  const afterFacts=prepared?phaseExecutionFacts(d,next,afterExecutionContext):undefined,after=proposedPotential(d,next,{...options,executionFacts:afterFacts});
  if(prepared){const guidance=[...phaseWarnings(beforeExecutionContext),...phaseWarnings(afterExecutionContext)];if(guidance.length)warnings.push(guidance[0]);}
  return {mode:next.root.scoring_mode||'legacy',mode_locked:ctx.mode_locked,review_required:!!next.root.scoring_review_required,earned,before:before.totals,after:after.totals,warnings,valid,scope,current_preserved:fresh,
    ...(includeUnits?{settlements,before_units:before.units,after_units:after.units}:{})};
}

/** Historical rows have no Task/User foreign keys. Deleting operational rows
 * cannot release the original occurrence/action or remove its frozen evidence. */
export function recordTaskScoringSettlement(d,definition,logicalKey,{outcome=definition.outcome,awardedRecipients=null,settledAt=null,earnedOnce=outcome==='earned',claimKey=null}={}){
  const {task,root,mode,points,targets}=definition;
  const frozen=awardedRecipients??(outcome==='earned'?targets.map(user_id=>({user_id,points})):[]);
  if(claimKey==null){const release=d.prepare('SELECT settlement_id FROM task_scoring_settlement_releases WHERE logical_key=? ORDER BY settlement_id DESC LIMIT 1').get(logicalKey);claimKey=release?JSON.stringify(['replacement',logicalKey,release.settlement_id]):logicalKey;}
  return d.prepare(`INSERT OR IGNORE INTO task_scoring_settlements(logical_key,claim_key,task_id,root_task_id,root_logical_key,mode,points,recipients_json,outcome,settled_at,visibility_json,earned_once)
    VALUES(?,?,?,?,?,?,?,?,?,COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')),?,?)`).run(logicalKey,claimKey,task.id,root.id,taskScoringIdentity(d,root.id),mode,points,JSON.stringify(frozen),outcome,settledAt,
      JSON.stringify(taskVisibilitySnapshot(d,task)),earnedOnce?1:0);
}
export function assertTaskScoringAward(d,definition){
  if(definition.root.scoring_review_required&&definition.mode==='legacy'&&definition.points>0&&definition.outcome==='earned'&&!everEarned(scopeSettlements(d,definition.root)))throw new TaskScoringError('Review this legacy scoring definition before earning new points.',409,'scoring_review_required');
}
