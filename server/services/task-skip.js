/** Human excusal is separate from completion and expiration. */
import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {assertTaskMutation,taskDevicePrincipal} from './task-access.js';
import {assertTaskRevision,recordTaskActivity,resumeExpiredTaskRecurrence,TaskStateError} from './task-lifecycle.js';
import {authoritativeTaskRecurrence,ensureSeriesDefinition} from './task-series.js';
import {retiredRecurrenceOccurrence} from './task-recurrence-frontier.js';

export function taskSkipScope(d,taskId) {
  return d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ?
    UNION SELECT t.id FROM tasks t JOIN scope p ON t.parent_task_id=p.id
    UNION SELECT s.task_id FROM task_activity_support_tasks s JOIN scope p ON s.source_task_id=p.id
    UNION SELECT a.counterpart_task_id FROM task_supervision_actions a JOIN scope p ON a.source_task_id=p.id
      WHERE a.counterpart_task_id IS NOT NULL)
    SELECT t.* FROM tasks t JOIN scope p ON p.id=t.id`).all(taskId);
}
export function taskSkipUnsupportedReason(d,task,rows=taskSkipScope(d,task.id)) {
  if(task.parent_task_id || d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id,task.id))return 'Only a whole recurring occurrence can be skipped.';
  const recurrence=authoritativeTaskRecurrence(d,task);
  if(!recurrence?.is_recurring||!recurrence.recurrence_rule||recurrence.recurrence_from_completion)return 'Only materialized calendar-based recurring Tasks can be skipped.';
  if(retiredRecurrenceOccurrence(d,task.id))return 'This occurrence is no longer materialized.';
  for(const row of rows) {
    if(row.assignment_mode==='round_robin'||row.rotation_group||row.rotation_bindings_json&&JSON.parse(row.rotation_bindings_json).length
      ||d.prepare('SELECT 1 FROM task_rotation_occurrences WHERE task_id=?').get(row.id))return 'Rotation work cannot be skipped here.';
    if(row.external_source&&row.external_source!=='local'||row.target_caldav_account_id||row.target_caldav_list_url||row.external_account_id||row.external_uid)return 'Synced or pending-export work cannot be skipped.';
    if(d.prepare(`SELECT 1 FROM workflow_instance_tasks WHERE task_id=? UNION SELECT 1 FROM workflow_instances WHERE parent_task_id=?
      UNION SELECT 1 FROM workflow_task_dependencies WHERE task_id=? OR depends_on_task_id=?`).get(row.id,row.id,row.id,row.id))return 'Workflow work cannot be skipped here.';
  }
  if(recurrence.assignment_mode==='round_robin'||recurrence.rotation_group||recurrence.rotation_bindings_json&&JSON.parse(recurrence.rotation_bindings_json).length)return 'Rotation work cannot be skipped here.';
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
    if(receipt){if(receipt.request_hash!==hash)throw new TaskStateError('This operation ID was used for a different request.');return {task,replayed:true,recurrencePending:false};}
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
