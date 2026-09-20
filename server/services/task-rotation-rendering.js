/** Frozen, field-level provenance for Rotation expressions. Ordinary literal
 * Task fields keep their existing semantics; reads never render or mutate. */
import { renderRotationVariableTemplates, substituteVariableTemplate } from './variable-resolution.js';
import { captureActivityTemplateDefinition, taskActivitySnapshot } from './task-activity-snapshot.js';
import { registerRecurrenceAction } from './task-recurrence-frontier.js';
import { parseRotationBindings, taskRotationContexts, reconcileSharedTaskBindings } from './task-rotation.js';
import { registerSharedRotationReconciler } from './rotation-shared.js';
import { recordOccurrenceDefinition } from './task-series.js';
import { seriesOccurrencePreservationReason } from './task-series-edit.js';
import { ExpressionError } from '../../public/utils/variable-expressions.js';

const row=(d,id)=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const same=(left,right)=>String(left??'').trim()===String(right??'').trim();
const activeTarget=(target,bindings)=>!(target.purpose_keys||[]).some(key=>!bindings.some(binding=>binding.purpose_key===key));
/** Capture before any derived link/text mutation. The existing series predicate
 * rejects human edits/progress/evidence, so none can be absorbed into a baseline. */
function pristineDerivedBaselines(d,taskId,baselines=new Map()) {
  const occurrences=d.prepare(`WITH RECURSIVE ancestors(id,parent_task_id) AS (
    SELECT id,parent_task_id FROM tasks WHERE id=? UNION SELECT t.id,t.parent_task_id FROM tasks t JOIN ancestors a ON t.id=a.parent_task_id)
    SELECT o.* FROM task_recurrence_occurrences o JOIN ancestors a ON a.id=o.task_id`).all(taskId);
  for(const occurrence of occurrences)if(!baselines.has(occurrence.task_id)
    &&!seriesOccurrencePreservationReason(d,occurrence,row(d,occurrence.task_id)))baselines.set(occurrence.task_id,occurrence);
  return baselines;
}
function preserveDerivedBaselines(d,baselines) {
  for(const occurrence of baselines.values())recordOccurrenceDefinition(d,occurrence.task_id,{definitionId:occurrence.definition_id,
    startDate:occurrence.planned_start_date,dueDate:occurrence.planned_due_date,exceptionReason:occurrence.exception_reason,baseline:true});
}
function effectiveBindings(d,task) {
  const bindings=new Map(),seen=new Set();
  while(task&&!seen.has(task.id)) {
    seen.add(task.id);
    for(const binding of parseRotationBindings(task.rotation_bindings_json))if(!bindings.has(binding.purpose_key))bindings.set(binding.purpose_key,binding);
    task=task.parent_task_id?row(d,task.parent_task_id):null;
  }
  return [...bindings.values()];
}
function snapshot(d,taskId) {
  const binding=d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(taskId);
  if(!binding)return null;
  return {binding,activity:taskActivitySnapshot(d,taskId,binding)||captureActivityTemplateDefinition(d,binding.activity_template_id)};
}
function savePlan(d,taskId,saved,plan) {
  saved.activity.rotation_rendering=plan;
  const value=JSON.stringify(saved.activity);
  d.prepare('UPDATE task_activity_bindings SET definition_snapshot_json=? WHERE task_id=? AND definition_snapshot_json IS NOT ?').run(value,taskId,value);
}
function textTemplate(d,template,activity,subjectUserId) {
  const subject=subjectUserId?d.prepare('SELECT display_name FROM users WHERE id=?').get(subjectUserId):null;
  return template==null?null:String(template).replaceAll('{subject}',subject?.display_name||'').replaceAll('{activity}',activity.name||'Activity');
}
function render(d,task,target,{activity,bindings,rotations,subjectUserId,inputs,definitions,actor}) {
  return renderRotationVariableTemplates(d,{templates:[textTemplate(d,target.template,activity,subjectUserId)],bindings,rotations,
    subjectUserId:task.assigned_to||subjectUserId,inputs,definitions,actor});
}

/** Initial template authorship is explicit. Check both the template-item ID
 * and the authored draft value before giving a concrete field a live binding. */
export function initializeTaskRotationRendering(d,taskId,{draft=null,inputs={},templates={},definitions,authoredFields=new Map(),actor}={}) {
  const task=row(d,taskId),bindings=effectiveBindings(d,task);
  if(!bindings.length)return;
  const saved=snapshot(d,taskId);if(!saved)return;
  const rotations=taskRotationContexts(d,task),targets=[];
  const candidates=[{task,action_key:'root',field:'title',template:templates.title??saved.activity.title_template,expected:draft?.title},
    {task,action_key:'root',field:'description',template:templates.description??saved.activity.description,expected:draft?.description}];
  for(const child of d.prepare(`SELECT * FROM tasks WHERE parent_task_id=? AND activity_template_checklist_item_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=tasks.id)
    AND NOT EXISTS(SELECT 1 FROM task_supervision_actions s WHERE s.counterpart_task_id=tasks.id)`).all(taskId)) {
    const item=saved.activity.checklist?.find(item=>item.id===child.activity_template_checklist_item_id);
    if(!item)continue;
    candidates.push({task:child,action_key:registerRecurrenceAction(d,child.id)?.action_key||`action:${child.id}`,field:'title',template:item.title_template,
      expected:draft?.checklist?.find(value=>value.id===item.id)?.title_template});
  }
  // Creation already resolved draft actions to canonical IDs inside its
  // transaction. Capture newly authored expressions on those exact fields,
  // independently from the reusable source template's frozen definition.
  for(const [targetId,fields] of authoredFields)for(const [field,template] of Object.entries(fields)) {
    if(!['title','description'].includes(field)||!String(template??'').includes('{{'))continue;
    const concrete=row(d,targetId);
    if(!concrete||(concrete.id!==taskId&&concrete.parent_task_id!==taskId))
      throw Object.assign(new Error('Choose an action in this Task for the rotation text.'),{status:400});
    const candidate={task:concrete,action_key:concrete.id===taskId?'root':registerRecurrenceAction(d,concrete.id)?.action_key||`action:${concrete.id}`,
      field,template,expected:concrete[field]};
    const existing=candidates.findIndex(value=>value.task.id===concrete.id&&value.field===field);
    if(existing<0)candidates.push(candidate);else candidates[existing]=candidate;
  }
  for(const candidate of candidates) {
    if(!candidate.template || !String(candidate.template).includes('{{'))continue;
    const subjectUserId=candidate.task.id===taskId?saved.binding.subject_user_id||task.assigned_to:candidate.task.assigned_to||saved.binding.subject_user_id||task.assigned_to;
    let result;
    try {result=render(d,candidate.task,candidate,{activity:saved.activity,bindings,rotations,subjectUserId,inputs,definitions,actor});}
    catch(error) {
      if(error instanceof ExpressionError)throw Object.assign(error,{status:400,
        message:`Check the rotation text for “${candidate.task.title}”: ${error.message}`});
      throw error;
    }
    if(!result.usesRotation || !same(candidate.task[candidate.field],candidate.expected??result.values[0]))continue;
    const frozenInputs=Object.fromEntries(Object.entries(inputs).filter(([key])=>!bindings.some(binding=>binding.purpose_key===key)
      && !result.definitions.find(definition=>definition.id===key)?.expression));
    const value=result.values[0];
    d.prepare(`UPDATE tasks SET ${candidate.field}=? WHERE id=?`).run(value,candidate.task.id);
    const authoredText=[candidate.template,...result.definitions.map(definition=>definition.expression?.source||'')].join(' ');
    targets.push({action_key:candidate.action_key,field:candidate.field,template:candidate.template,
      purpose_keys:bindings.filter(binding=>new RegExp(`\\b${binding.purpose_key}\\b`).test(authoredText)).map(binding=>binding.purpose_key),
      definitions:result.definitions,inputs:frozenInputs,last_value:value});
  }
  if(targets.length)savePlan(d,taskId,saved,{version:1,targets});
}

/** Existing own snapshots prove the last generated value. A text edit detaches
 * only that field, without guessing identities from titles or row positions. */
export function captureTaskRotationRendering(d,root,binding,children) {
  const plan=binding?.snapshot?.rotation_rendering;
  if(!plan)return null;
  const keyed=new Map([['root',root],...children.map(child=>[registerRecurrenceAction(d,child.id)?.action_key,child])]);
  const bindings=parseRotationBindings(root.rotation_bindings_json);
  return {...structuredClone(plan),targets:plan.targets.filter(target=>activeTarget(target,bindings)&&keyed.has(target.action_key)&&same(keyed.get(target.action_key)[target.field],target.last_value))};
}

export function applyTaskRotationRendering(d,taskId,plan) {
  const saved=snapshot(d,taskId);if(!saved)return;
  const ownPlan=plan===undefined;plan??=saved.activity.rotation_rendering;if(!plan)return;
  const task=row(d,taskId),bindings=effectiveBindings(d,task),rotations=taskRotationContexts(d,task);
  if(ownPlan&&(task.archived_at||['done','expired'].includes(task.status)))return;
  const keyed=new Map([['root',task],...d.prepare(`SELECT t.*,COALESCE(a.action_key,'action:'||t.id) AS action_key FROM tasks t
    LEFT JOIN task_recurrence_actions a ON a.task_id=t.id
    WHERE (t.parent_task_id=? OR a.occurrence_task_id=?) AND t.id!=? AND t.archived_at IS NULL`)
    .all(taskId,taskId,taskId).map(value=>[value.action_key,value])]);
  const next={...structuredClone(plan),targets:[]};
  for(const target of plan.targets||[]) {
    if(!activeTarget(target,bindings))continue;
    if(!['title','description'].includes(target.field))continue;
    const concrete=keyed.get(target.action_key);if(!concrete)continue;
    if(ownPlan&&!same(concrete[target.field],target.last_value))continue;
    if(ownPlan&&['done','expired'].includes(concrete.status)){next.targets.push({...target});continue;}
    const subjectUserId=concrete.id===taskId?saved.binding.subject_user_id||task.assigned_to:concrete.assigned_to||saved.binding.subject_user_id||task.assigned_to;
    let value;
    try {value=render(d,concrete,target,{activity:saved.activity,bindings,rotations,subjectUserId,inputs:target.inputs,definitions:target.definitions}).values[0];}
    catch(error) {
      if(error.code!=='missing_input' || !rotations.some(item=>item.pending))throw error;
      // A pending rotation has no position. Keep authored words, never an old
      // occurrence's number, until an explicit reconciliation can resolve it.
      value=substituteVariableTemplate(textTemplate(d,target.template,saved.activity,subjectUserId),{}).replace(/[\s—–:-]+$/,'').trim();
    }
    d.prepare(`UPDATE tasks SET ${target.field}=? WHERE id=? AND ${target.field} IS NOT ?`).run(value,concrete.id,value);
    next.targets.push({...target,last_value:value});
  }
  savePlan(d,taskId,saved,next);
}

/** Called inside the occurrence command transaction. Historical Tasks and
 * completed child evidence keep their original rendered values. */
export function refreshRotationTaskRendering(d,occurrenceId) {
  const owners=d.prepare(`SELECT DISTINCT t.id FROM task_rotation_occurrences link JOIN tasks t ON t.id=link.owner_task_id
    WHERE link.occurrence_id=? AND link.retired_at IS NULL AND t.archived_at IS NULL AND t.status NOT IN ('done','expired')`).all(occurrenceId);
  for(const owner of owners)refreshTaskRotationRendering(d,owner.id);
}

/** Explicit mutation reconciliation. Descendant Activity snapshots preserve
 * their own authorship, including Workflow step overrides and frozen variables. */
export function refreshTaskRotationRendering(d,taskId) {
  const pristine=pristineDerivedBaselines(d,taskId);
  const targets=d.prepare(`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM tasks WHERE id=? UNION ALL SELECT t.id FROM tasks t JOIN descendants p ON t.parent_task_id=p.id
  ) SELECT id FROM descendants`).all(taskId);
  for(const target of targets)applyTaskRotationRendering(d,target.id);
  // A directly edited checklist participant may be rendered by its owner.
  const parent=row(d,taskId)?.parent_task_id;
  if(parent)applyTaskRotationRendering(d,parent);
  preserveDerivedBaselines(d,pristine);
}

registerSharedRotationReconciler((d,event)=>{
  const pristine=new Map();
  const changed=reconcileSharedTaskBindings(d,{...event,onBeforeTask:taskId=>pristineDerivedBaselines(d,taskId,pristine)});
  for(const taskId of changed)refreshTaskRotationRendering(d,taskId);
  preserveDerivedBaselines(d,pristine);
});
