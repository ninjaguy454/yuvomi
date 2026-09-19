/** Frozen, field-level provenance for Rotation expressions. Ordinary literal
 * Task fields keep their existing semantics; reads never render or mutate. */
import { renderRotationVariableTemplates, substituteVariableTemplate } from './variable-resolution.js';
import { captureActivityTemplateDefinition, taskActivitySnapshot } from './task-activity-snapshot.js';
import { registerRecurrenceAction } from './task-recurrence-frontier.js';
import { parseRotationBindings, taskRotationContexts } from './task-rotation.js';

const row=(d,id)=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const same=(left,right)=>String(left??'').trim()===String(right??'').trim();
const activeTarget=(target,bindings)=>!(target.purpose_keys||[]).some(key=>!bindings.some(binding=>binding.purpose_key===key));
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
function render(d,task,target,{activity,bindings,rotations,subjectUserId,inputs,definitions}) {
  return renderRotationVariableTemplates(d,{templates:[textTemplate(d,target.template,activity,subjectUserId)],bindings,rotations,
    subjectUserId,inputs,definitions});
}

/** Initial template authorship is explicit. Check both the template-item ID
 * and the authored draft value before giving a concrete field a live binding. */
export function initializeTaskRotationRendering(d,taskId,{draft=null,inputs={}}={}) {
  const task=row(d,taskId),bindings=parseRotationBindings(task?.rotation_bindings_json);
  if(!bindings.length)return;
  const saved=snapshot(d,taskId);if(!saved)return;
  const rotations=taskRotationContexts(d,task),targets=[];
  const candidates=[{task,action_key:'root',field:'title',template:saved.activity.title_template,expected:draft?.title},
    {task,action_key:'root',field:'description',template:saved.activity.description,expected:draft?.description}];
  for(const child of d.prepare(`SELECT * FROM tasks WHERE parent_task_id=? AND activity_template_checklist_item_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=tasks.id)
    AND NOT EXISTS(SELECT 1 FROM task_supervision_actions s WHERE s.counterpart_task_id=tasks.id)`).all(taskId)) {
    const item=saved.activity.checklist?.find(item=>item.id===child.activity_template_checklist_item_id);
    if(!item)continue;
    candidates.push({task:child,action_key:registerRecurrenceAction(d,child.id)?.action_key||`action:${child.id}`,field:'title',template:item.title_template,
      expected:draft?.checklist?.find(value=>value.id===item.id)?.title_template});
  }
  for(const candidate of candidates) {
    if(!candidate.template || !String(candidate.template).includes('{{'))continue;
    const subjectUserId=candidate.task.id===taskId?saved.binding.subject_user_id||task.assigned_to:candidate.task.assigned_to||saved.binding.subject_user_id||task.assigned_to;
    const result=render(d,candidate.task,candidate,{activity:saved.activity,bindings,rotations,subjectUserId,inputs});
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
  const task=row(d,taskId),bindings=parseRotationBindings(task.rotation_bindings_json),rotations=taskRotationContexts(d,task);
  if(ownPlan&&(task.archived_at||['done','expired'].includes(task.status)))return;
  const keyed=new Map([['root',task],...d.prepare(`SELECT t.*,a.action_key FROM task_recurrence_actions a JOIN tasks t ON t.id=a.task_id
    WHERE a.occurrence_task_id=? AND t.archived_at IS NULL`).all(taskId).map(value=>[value.action_key,value])]);
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
  for(const owner of owners)applyTaskRotationRendering(d,owner.id);
}
