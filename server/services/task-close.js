/** Compatibility endpoints retain operation receipts and use ordinary completion. */
import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {assertTaskMutation,taskDevicePrincipal} from './task-access.js';
import {assertTaskRevision,assertTaskWindowAction,assertRecurringCompletionStarted,changeTaskStatus,TaskStateError} from './task-lifecycle.js';
import {retiredRecurrenceOccurrence} from './task-recurrence-frontier.js';
import {taskSkipScope} from './task-skip.js';
import {taskDeadlineMs} from './task-window.js';
import {authoritativeTaskRecurrence,taskSeriesState,seriesDefinitionForGeneration} from './task-series.js';

const coupledRotation=task=>task?.assignment_mode==='round_robin'||task?.rotation_group||JSON.parse(task?.rotation_bindings_json||'[]').length>0;
const coupledBinding=binding=>binding&&!(binding.assignment_override_user_id&&binding.snapshot?.allow_assignment_override)
  &&!['fixed','subject_skill'].includes(binding.snapshot?.assignment_strategy);

export function taskCloseUnsupportedReason(d,task,rows=taskSkipScope(d,task.id)) {
  if(task.parent_task_id||d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id,task.id))return 'Close the whole original activity from its details.';
  if(retiredRecurrenceOccurrence(d,task.id))return 'This occurrence is no longer materialized.';
  // An occurrence-only assignment exception does not replace its next series
  // definition. Check the configuration the recurrence generator will consume.
  const recurrence=authoritativeTaskRecurrence(d,task),state=taskSeriesState(d,task.id);
  const next=state?seriesDefinitionForGeneration(d,state.series_id,state.occurrence.generation+1)?.data:null;
  if(recurrence?.is_recurring&&(coupledRotation(recurrence)||next?.subtasks?.some(action=>coupledRotation(action.task))
    ||coupledBinding(state?.definition?.data.binding)||coupledBinding(next?.binding)))return 'Coupled rotation work must use its existing lifecycle.';
  for(const row of rows) {
    if(coupledRotation(row)
      ||d.prepare('SELECT 1 FROM task_rotation_occurrences WHERE task_id=? UNION SELECT 1 FROM task_rotation_periods WHERE task_id=?').get(row.id,row.id))return 'Coupled rotation work must use its existing lifecycle.';
    if(d.prepare('SELECT 1 FROM workflow_instance_tasks WHERE task_id=? UNION SELECT 1 FROM workflow_instances WHERE parent_task_id=? UNION SELECT 1 FROM workflow_task_dependencies WHERE task_id=? OR depends_on_task_id=?').get(row.id,row.id,row.id,row.id))return 'Coupled Workflow work must use its existing lifecycle.';
    if(d.prepare('SELECT 1 FROM reward_fulfillment_task_links WHERE task_id=?').get(row.id))return 'Prize deliveries must use their existing fulfillment or Undo action.';
    if(d.prepare('SELECT 1 FROM housekeeping_work_sessions WHERE payment_task_id=?').get(row.id))return 'Payment tasks must use their existing payment lifecycle.';
    if(row.external_source&&row.external_source!=='local'||row.target_caldav_account_id||row.target_caldav_list_url||row.external_account_id||row.external_uid)return 'Synced or pending-export work must use its existing provider lifecycle.';
  }
  return null;
}

function requestIdentity(d,task,principal,body,action) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['operation_id','expected_revision'].includes(key))
    ||typeof body.operation_id!=='string'||!body.operation_id.length||body.operation_id.length>128||/[^A-Za-z0-9_.:-]/.test(body.operation_id))
    throw new TaskStateError('Invalid activity closure request.',{reason:'invalid_request'},400);
  if(taskDevicePrincipal(principal))throw new TaskStateError('A signed-in household parent or administrator must manage activity closure.',{},403);
  assertTaskMutation(d,principal,task,{}, {operation:'close_incomplete'});
  const principalKey=`user:${actorId(principal)}`;
  const requestHash=createHash('sha256').update(JSON.stringify({action,task_id:task.id,expected_revision:body.expected_revision})).digest('hex');
  const receipt=d.prepare('SELECT * FROM task_close_receipts WHERE principal_key=? AND operation_id=?').get(principalKey,body.operation_id);
  if(receipt&&receipt.request_hash!==requestHash)throw new TaskStateError('This operation ID was used for a different request.');
  return {principalKey,requestHash,receipt};
}

function authorizeScope(d,principal,rows) {
  for(const row of rows) {
    if(row.archived_at||row.status==='done')continue;
    if(d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(row.id,row.id))continue;
    assertTaskMutation(d,principal,row,{}, {operation:'skip'});
  }
}

export function closeIncompleteTask(d,taskId,{principal,body={},now=new Date()}={}) {
  return d.transaction(()=>{
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if(!task)throw new TaskStateError('Task not found.',{},404);
    const identity=requestIdentity(d,task,principal,body,'close');
    const rows=taskSkipScope(d,taskId);authorizeScope(d,principal,rows);
    if(identity.receipt)return {task,replayed:true};
    assertTaskRevision(d,task,body,{required:true});
    const unsupported=taskCloseUnsupportedReason(d,task,rows);
    if(unsupported)throw new TaskStateError(unsupported,{reason:'close_incomplete_unsupported'});
    if(task.archived_at)throw new TaskStateError('Restore this activity from the archive before closing it.');
    if(!['open','in_progress'].includes(task.status))throw new TaskStateError('Only an active, unfinished activity can be closed without completing its remaining subtasks.');
    assertTaskWindowAction(d,taskId,now);assertRecurringCompletionStarted(d,taskId,now);
    const at=now.toISOString(),actor=actorId(principal);
    changeTaskStatus(d,taskId,'done',{actorId:actor,principal,body:{expected_revision:body.expected_revision,complete_remaining:false},now});
    d.prepare('INSERT INTO task_close_receipts(principal_key,operation_id,request_hash,task_id,action,created_at) VALUES(?,?,?,?,?,?)').run(identity.principalKey,body.operation_id,identity.requestHash,taskId,'close',at);
    return {task:d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),replayed:false};
  }).immediate();
}

/** Resume this occurrence only. Completion and explicit Reset keep their existing semantics. */
export function reopenIncompleteTask(d,taskId,{principal,body={},now=new Date()}={}) {
  return d.transaction(()=>{
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if(!task)throw new TaskStateError('Task not found.',{},404);
    const identity=requestIdentity(d,task,principal,body,'reopen');
    const rows=taskSkipScope(d,taskId);authorizeScope(d,principal,rows);
    if(identity.receipt)return {task,replayed:true};
    assertTaskRevision(d,task,body,{required:true});
    if(task.archived_at)throw new TaskStateError('Restore this activity from the archive before reopening it.');
    if(task.status!=='done'||!task.completion_kept_subtasks)
      throw new TaskStateError('Only an activity closed without completing its remaining subtasks can be reopened here.');
    const unsupported=taskCloseUnsupportedReason(d,task,rows);
    if(unsupported)throw new TaskStateError(unsupported,{reason:'close_incomplete_unsupported'});
    const progress=rows.some(row=>row.id!==taskId&&!row.archived_at&&['in_progress','done'].includes(row.status));
    const status=progress?'in_progress':'open';
    const deadline=taskDeadlineMs(d,task);
    const expiration=task.expiration_policy==='expire_incomplete'&&deadline!=null&&Number(now)>=deadline?'keep_overdue':task.expiration_policy;
    d.prepare('UPDATE tasks SET expiration_policy=? WHERE id=?').run(expiration,taskId);
    const actor=actorId(principal),at=now.toISOString();
    changeTaskStatus(d,taskId,status,{actorId:actor,principal,body:{expected_revision:task.revision},now,resumeProgress:true});
    d.prepare('INSERT INTO task_close_receipts(principal_key,operation_id,request_hash,task_id,action,created_at) VALUES(?,?,?,?,?,?)').run(identity.principalKey,body.operation_id,identity.requestHash,taskId,'reopen',at);
    return {task:d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),replayed:false};
  }).immediate();
}
