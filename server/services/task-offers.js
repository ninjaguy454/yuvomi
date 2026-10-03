/** Read-only offer eligibility over regular Tasks; never another Task type. */
import {taskCapabilities,taskDevicePrincipal} from './task-access.js';
import {taskStartProjection,normalizeCategoryFilter,taskCategoryWhere} from './task-scope.js';
import {normalizeTags,tagKey} from '../utils/task-tags.js';
import {taskExpirationDue} from './task-window.js';
import {actorPermissions} from '../permissions.js';

export const acceptanceError=(message,status=409,reason='task_acceptance_conflict')=>Object.assign(new Error(message),{status,code:status,reason});
export function hasTaskAssignees(d,task){
  return Boolean(task.assigned_to||d.prepare('SELECT 1 FROM task_assignments WHERE task_id=? LIMIT 1').get(task.id)
    ||d.prepare("SELECT 1 FROM task_responsibilities WHERE task_id=? AND status='active' AND role IN ('primary','participant','supervisor','subtask_assignee') LIMIT 1").get(task.id));
}
export function generatedTask(d,id){return Boolean(d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=?').get(id)||d.prepare('SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(id));}
export function taskOfferState(d,principal,task,{starts,includeFuture=false}={}){
  if(!task)return {visible:false,claimable:false,reason:'not_found'};
  const device=taskDevicePrincipal(principal),permissions=taskCapabilities(d,principal,task);
  const module=device?device.permissions?.modules?.tasks:actorPermissions(d,principal).modules.tasks;
  if(module==='none'||!permissions.view)return {visible:false,claimable:false,reason:'not_found'};
  let reason=null;
  if(task.parent_task_id||generatedTask(d,task.id))reason='not_ordinary_root';
  else if(task.archived_at||!['open','in_progress'].includes(task.status)||taskExpirationDue(d,task))reason='not_active';
  else if(!includeFuture&&!(starts||taskStartProjection(d,{tasks:[task]})).visible(task))reason='not_started';
  else if(hasTaskAssignees(d,task))reason='already_assigned';
  else {
    const context=d.prepare('SELECT * FROM task_assignment_context WHERE task_id=?').get(task.id);
    if(context){if(context.strategy!=='open_claimable'||!['open','unavailable'].includes(context.state))reason='managed_assignment';}
    else if(task.assignment_mode==='round_robin'
      ||d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id=?').get(task.id)
      ||d.prepare('SELECT 1 FROM task_claim_eligibility WHERE task_id=?').get(task.id)
      ||d.prepare("SELECT 1 FROM task_action_links WHERE task_id=? AND action_type='travel_meal_plan'").get(task.id)
      ||d.prepare('SELECT 1 FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').get(task.id)
      ||d.prepare('SELECT 1 FROM task_rotation_periods WHERE task_id=? AND retired_at IS NULL').get(task.id)
      ||(task.rotation_bindings_json&&task.rotation_bindings_json!=='[]'))reason='managed_assignment';
  }
  return {visible:!reason,claimable:!reason&&permissions.claim,reason:reason||(!permissions.claim?'claim_not_allowed':null)};
}
export function listTaskOffers(d,principal,{includeFuture=false,query={}}={}){
  // Filters only narrow the canonical offer set, including wake-up candidates.
  const values=value=>(value==null?[]:[value].flat()).filter(value=>typeof value==='string'&&value!=='').slice(0,50);
  const assignees=values(query.assigned_to).map(Number).filter(Number.isInteger);
  if(query.archived==='only'||assignees.length)return [];
  let sql="SELECT t.* FROM tasks t WHERE t.parent_task_id IS NULL AND t.archived_at IS NULL AND t.status IN ('open','in_progress')";
  const params=[];
  for(const column of ['status','priority']){const selected=values(query[column]);if(selected.length){sql+=` AND t.${column} IN (${selected.map(()=>'?').join(',')})`;params.push(...selected);}}
  const categories=normalizeCategoryFilter(query.category),categoryWhere=taskCategoryWhere('t',categories);
  if(categoryWhere){sql+=` AND ${categoryWhere}`;params.push(...categories);}
  for(const tag of normalizeTags(values(query.tag))){sql+=' AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id=t.id AND tt.tag_key=?)';params.push(tagKey(tag));}
  sql+=' ORDER BY t.due_date IS NULL,t.due_date,t.priority,t.id';
  const rows=d.prepare(sql).all(...params);
  const starts=taskStartProjection(d,{tasks:rows});
  return rows.filter(task=>taskOfferState(d,principal,task,{starts,includeFuture}).visible);
}
