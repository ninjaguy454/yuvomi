/** Human excusal is separate from completion and expiration. */
import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {assertTaskMutation,taskDevicePrincipal} from './task-access.js';
import {assertTaskRevision,recordTaskActivity,resumeExpiredTaskRecurrence,TaskStateError} from './task-lifecycle.js';
import {authoritativeTaskRecurrence,completionRelativeSkipUnsupportedReason,ensureSeriesDefinition,taskSeriesState,seriesDefinitionForGeneration,planSeriesOccurrence} from './task-series.js';
import {retiredRecurrenceOccurrence} from './task-recurrence-frontier.js';
import {sharedGroupConfiguration} from './rotation-shared.js';
import {sharedTaskPeriodDate} from './task-rotation.js';

export function taskSkipScope(d,taskId) {
  return d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ?
    UNION SELECT t.id FROM tasks t JOIN scope p ON t.parent_task_id=p.id
    UNION SELECT s.task_id FROM task_activity_support_tasks s JOIN scope p ON s.source_task_id=p.id
    UNION SELECT a.counterpart_task_id FROM task_supervision_actions a JOIN scope p ON a.source_task_id=p.id
      WHERE a.counterpart_task_id IS NOT NULL)
    SELECT t.* FROM tasks t JOIN scope p ON p.id=t.id`).all(taskId);
}
// A consumer may excuse its work without settling the Group's shared order.
// Retained independent decisions still belong to that consumer and stay out of scope.
function sharedRotationReferences(d,task) {
  const bindings=JSON.parse(task.rotation_bindings_json||'[]');
  const links=d.prepare(`SELECT l.*,t.consumer_type,t.group_id,p.period_date,p.schedule_id,
    s.group_id AS schedule_group_id,s.track_id AS schedule_track_id,v.usage_mode
    FROM task_rotation_occurrences l LEFT JOIN rotation_tracks t ON t.id=l.track_id
    LEFT JOIN rotation_group_periods p ON p.occurrence_id=l.occurrence_id
    LEFT JOIN rotation_group_schedules s ON s.id=p.schedule_id
    LEFT JOIN rotation_group_schedule_versions v ON v.id=p.version_id WHERE l.task_id=?`).all(task.id);
  const references=d.prepare('SELECT * FROM task_rotation_periods WHERE task_id=?').all(task.id);
  if(!bindings.length&&!links.length&&!references.length)return true;
  if(task.assignment_mode!=='fixed')return false;
  if(links.some(link=>link.consumer_type!=='rotation_group_schedule'||link.owner_task_id!==task.id
    ||link.group_id!==link.schedule_group_id||link.track_id!==link.schedule_track_id||link.usage_mode!=='shared'))return false;
  for(const reference of references) {
    if(!sharedGroupConfiguration(d,reference.group_id,reference.period_date))return false;
    if(reference.occurrence_id&&!links.some(link=>link.occurrence_id===reference.occurrence_id
      &&link.group_id===reference.group_id&&link.period_date===reference.period_date&&link.purpose_key===reference.purpose_key))return false;
    if(!reference.retired_at&&!bindings.some(binding=>binding.purpose_key===reference.purpose_key&&binding.group_id===reference.group_id))return false;
  }
  for(const binding of bindings) {
    const reference=references.find(row=>!row.retired_at&&row.purpose_key===binding.purpose_key&&row.group_id===binding.group_id);
    if(!reference)return false;
    if(reference.occurrence_id&&!links.some(link=>!link.retired_at&&link.purpose_key===binding.purpose_key&&link.occurrence_id===reference.occurrence_id))return false;
  }
  return true;
}
function sharedSuccessorPurposes(d,task,recurrence,sharedScope) {
  const bindings=JSON.parse(recurrence.rotation_bindings_json||'[]');
  if(!bindings.length&&!sharedScope)return true;
  if(recurrence.assignment_mode!=='fixed')return false;
  const state=taskSeriesState(d,task.id);if(!state)return false;
  const definition=seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1);
  // Fixed Tasks can also carry an independent template assignment cursor.
  const binding=definition?.data.binding,policy=binding?.snapshot?.assignment_strategy;
  if(binding&&!(binding.assignment_override_user_id&&binding.snapshot?.allow_assignment_override)
    &&!['fixed','subject_skill'].includes(policy))return false;
  if(!bindings.length)return true;
  let window;
  try {window=planSeriesOccurrence(d,definition,state.occurrence,{withoutCompletion:true,skipped:true});}
  catch {return false;}
  const successor={...recurrence,...(window||{start_date:state.occurrence.planned_start_date,due_date:state.occurrence.planned_due_date})};
  return bindings.every(purpose=>{
    const date=sharedTaskPeriodDate(d,successor,purpose);
    return Boolean(date&&sharedGroupConfiguration(d,purpose.group_id,date));
  });
}
// Use retained occurrence ownership as well as the next definition: an edit
// that removes future purposes must not let Skip consume an assignment turn.
export function taskSkipHasRotationScope(d,task,rows=taskSkipScope(d,task.id),recurrence=authoritativeTaskRecurrence(d,task)) {
  return Boolean(JSON.parse(recurrence?.rotation_bindings_json||'[]').length||rows.some(row=>
    JSON.parse(row.rotation_bindings_json||'[]').length
    ||d.prepare('SELECT 1 FROM task_rotation_occurrences WHERE task_id=? UNION SELECT 1 FROM task_rotation_periods WHERE task_id=?').get(row.id,row.id)));
}
export function taskSkipUnsupportedReason(d,task,rows=taskSkipScope(d,task.id)) {
  if(task.parent_task_id || d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id,task.id))return 'Only a whole recurring occurrence can be skipped.';
  const recurrence=authoritativeTaskRecurrence(d,task);
  if(!recurrence?.is_recurring||!recurrence.recurrence_rule)return 'Only materialized recurring Tasks can be skipped.';
  if(recurrence.recurrence_from_completion) {
    const nominal=taskSeriesState(d,task.id)?.occurrence;
    const anchor=recurrence.due_date_offset_days!=null?nominal?.planned_start_date||recurrence.start_date:nominal?.planned_due_date||recurrence.due_date;
    const unsupported=completionRelativeSkipUnsupportedReason(recurrence,anchor);if(unsupported)return unsupported;
  }
  if(retiredRecurrenceOccurrence(d,task.id))return 'This occurrence is no longer materialized.';
  const sharedScope=taskSkipHasRotationScope(d,task,rows,recurrence);
  for(const row of rows) {
    if(row.assignment_mode==='round_robin'||row.rotation_group||!sharedRotationReferences(d,row))return 'Rotation work cannot be skipped here.';
    if(row.external_source&&row.external_source!=='local'||row.target_caldav_account_id||row.target_caldav_list_url||row.external_account_id||row.external_uid)return 'Synced or pending-export work cannot be skipped.';
    if(d.prepare(`SELECT 1 FROM workflow_instance_tasks WHERE task_id=? UNION SELECT 1 FROM workflow_instances WHERE parent_task_id=?
      UNION SELECT 1 FROM workflow_task_dependencies WHERE task_id=? OR depends_on_task_id=?`).get(row.id,row.id,row.id,row.id))return 'Workflow work cannot be skipped here.';
  }
  if(recurrence.assignment_mode==='round_robin'||recurrence.rotation_group||!sharedSuccessorPurposes(d,task,recurrence,sharedScope))return 'Rotation work cannot be skipped here.';
  return null;
}
function authorize(d,principal,task,rows) {
  assertTaskMutation(d,principal,task,{}, {operation:'skip'});
  for(const row of rows) {
    if(row.archived_at||row.status==='done')continue;
    const projection=d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(row.id,row.id);
    // Helpers are projections of source actions, whose authority is checked above.
    if(!projection)assertTaskMutation(d,principal,row,{}, {operation:'skip'});
  }
}
function recurrencePending(d,taskId) {
  const state=taskSeriesState(d,taskId);if(!state||state.occurrence.state!=='materialized')return false;
  if(d.prepare("SELECT 1 FROM task_recurrence_occurrences WHERE series_id=? AND generation>? AND state='materialized'").get(state.series_id,state.occurrence.generation))return false;
  const definition=seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1);
  try{return Boolean(planSeriesOccurrence(d,definition,state.occurrence,{withoutCompletion:true,skipped:true}));}
  catch{return true;} // A committed Skip remains retryable when current settings cannot produce its successor.
}
export function skipTaskOccurrence(d,taskId,{principal,body={},now=new Date()}={}) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['operation_id','expected_revision'].includes(k))
    ||typeof body.operation_id!=='string'||!body.operation_id.length||body.operation_id.length>128||/[^A-Za-z0-9_.:-]/.test(body.operation_id))
    throw new TaskStateError('Invalid skip request.',{reason:'invalid_request'},400);
  return d.transaction(()=>{
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if(!task)throw new TaskStateError('Task not found.',{},404);
    if(taskDevicePrincipal(principal))throw new TaskStateError('A signed-in authorized manager must skip this occurrence.',{},403);
    const rows=taskSkipScope(d,taskId);authorize(d,principal,task,rows);
    const key=`user:${actorId(principal)}`,hash=createHash('sha256').update(JSON.stringify({task_id:taskId,expected_revision:body.expected_revision})).digest('hex');
    const receipt=d.prepare('SELECT * FROM task_skip_receipts WHERE principal_key=? AND operation_id=?').get(key,body.operation_id);
    if(receipt){if(receipt.request_hash!==hash)throw new TaskStateError('This operation ID was used for a different request.');return {task,replayed:true,recurrencePending:recurrencePending(d,taskId)};}
    assertTaskRevision(d,task,body,{required:true});
    const unsupported=taskSkipUnsupportedReason(d,task,rows);if(unsupported)throw new TaskStateError(unsupported,{reason:'skip_unsupported'});
    if(task.archived_at)throw new TaskStateError('Restore this occurrence from the archive before skipping it.');
    if(!['open','in_progress','expired'].includes(task.status))throw new TaskStateError(task.status==='skipped'?'This occurrence is already skipped.':'Completed occurrences cannot be skipped.');
    const state=ensureSeriesDefinition(d,task.id);
    if(!state||state.occurrence.state!=='materialized')throw new TaskStateError('This occurrence is no longer materialized.');
    const at=now.toISOString(),affected=[];
    for(const row of rows) {
      if(row.archived_at||!['open','in_progress','expired'].includes(row.status))continue;
      d.prepare("UPDATE tasks SET status='skipped',skipped_at=?,expired_at=NULL WHERE id=?").run(at,row.id);affected.push(row.id);
      d.prepare("UPDATE task_responsibilities SET status='cancelled' WHERE task_id=? AND status='active'").run(row.id);
      d.prepare("UPDATE planning_obligations SET status='cancelled',updated_at=? WHERE task_id=? AND status IN ('pending','accepted')").run(at,row.id);
      d.prepare("UPDATE task_assignment_context SET state='cancelled' WHERE task_id=? AND state!='fulfilled'").run(row.id);
      d.prepare("UPDATE task_supervision_actions SET state='not_required',reason='The occurrence was skipped.',revision=revision+1,updated_at=? WHERE action_task_id=? AND state NOT IN ('not_required','completed')").run(at,row.id);
    }
    recordTaskActivity(d,taskId,'skipped',actorId(principal),{title:task.title,from_status:task.status,to_status:'skipped',skipped_at:at,
      series_id:state.series_id,occurrence_key:state.occurrence.occurrence_key,affected_task_ids:affected,operation_id:body.operation_id,points_awarded:0});
    d.prepare('INSERT INTO task_skip_receipts(principal_key,operation_id,request_hash,task_id,created_at) VALUES(?,?,?,?,?)').run(key,body.operation_id,hash,taskId,at);
    let recurrenceError=null;
    try{d.transaction(()=>resumeExpiredTaskRecurrence(d,taskId))();}catch(error){recurrenceError=error;}
    return {task:d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),replayed:false,recurrencePending:!!recurrenceError,recurrenceError};
  }).immediate();
}
