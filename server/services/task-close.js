/** Closing an activity records an outcome, never a completion or checklist reset. */
import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {assertTaskMutation,taskDevicePrincipal} from './task-access.js';
import {assertTaskRevision,assertTaskWindowAction,assertRecurringCompletionStarted,advanceClosedTaskRecurrence,recordTaskActivity,TaskStateError} from './task-lifecycle.js';
import {retiredRecurrenceOccurrence} from './task-recurrence-frontier.js';
import {taskSkipScope} from './task-skip.js';
import {reconcileTaskSupervision} from './task-supervision.js';
import {taskDeadlineMs} from './task-window.js';
import {authoritativeTaskRecurrence} from './task-series.js';

export function taskCloseUnsupportedReason(d,task,rows=taskSkipScope(d,task.id)) {
  if(task.parent_task_id||d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=? UNION SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id,task.id))return 'Close the whole original activity from its details.';
  if(retiredRecurrenceOccurrence(d,task.id))return 'This occurrence is no longer materialized.';
  for(const row of rows) {
    if(row.assignment_mode==='round_robin'||row.rotation_group||(row.rotation_bindings_json&&row.rotation_bindings_json!=='[]')
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
    const recurring=!!authoritativeTaskRecurrence(d,task)?.is_recurring;
    d.prepare('INSERT OR IGNORE INTO task_incomplete_closures(task_id,first_closed_at,recurrence_closed_at) VALUES(?,?,?)').run(taskId,at,recurring?at:null);
    if(recurring)d.prepare('UPDATE task_incomplete_closures SET recurrence_closed_at=? WHERE task_id=? AND recurrence_closed_at IS NULL').run(at,taskId);
    d.prepare("UPDATE tasks SET status='closed_incomplete',closed_incomplete_at=? WHERE id=?").run(at,taskId);
    reconcileTaskSupervision(d,taskId,{actorId:actor});
    advanceClosedTaskRecurrence(d,taskId);
    recordTaskActivity(d,taskId,'closed_incomplete',actor,{title:task.title,from_status:task.status,to_status:'closed_incomplete',closed_incomplete_at:at,points_awarded:0,operation_id:body.operation_id});
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
    if(task.status!=='closed_incomplete'||!d.prepare('SELECT 1 FROM task_incomplete_closures WHERE task_id=?').get(taskId))
      throw new TaskStateError('Only an activity closed without completing its remaining subtasks can be reopened here.');
    const unsupported=taskCloseUnsupportedReason(d,task,rows);
    if(unsupported)throw new TaskStateError(unsupported,{reason:'close_incomplete_unsupported'});
    const progress=rows.some(row=>row.id!==taskId&&!row.archived_at&&['in_progress','done'].includes(row.status));
    const status=progress?'in_progress':'open';
    const deadline=taskDeadlineMs(d,task);
    const expiration=task.expiration_policy==='expire_incomplete'&&deadline!=null&&Number(now)>=deadline?'keep_overdue':task.expiration_policy;
    d.prepare('UPDATE tasks SET status=?,closed_incomplete_at=NULL,expiration_policy=? WHERE id=?').run(status,expiration,taskId);
    const actor=actorId(principal),at=now.toISOString();
    reconcileTaskSupervision(d,taskId,{actorId:actor});
    recordTaskActivity(d,taskId,'reopened',actor,{title:task.title,from_status:'closed_incomplete',to_status:status,previous_closed_incomplete_at:task.closed_incomplete_at,points_awarded:0,successors_preserved:true,expiration_policy:expiration,operation_id:body.operation_id});
    d.prepare('INSERT INTO task_close_receipts(principal_key,operation_id,request_hash,task_id,action,created_at) VALUES(?,?,?,?,?,?)').run(identity.principalKey,body.operation_id,identity.requestHash,taskId,'reopen',at);
    return {task:d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),replayed:false};
  }).immediate();
}
