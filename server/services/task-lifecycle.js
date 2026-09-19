/** One operational transition for REST and compatibility writers. */
import { syncTaskRewards } from './rewards.js';
import { retiredRecurrenceOccurrence, registerRecurrenceOccurrence } from './task-recurrence-frontier.js';
import { calendarDayOffset } from './activity-schedule.js';
import { authoritativeTaskRecurrence, ensureSeriesDefinition } from './task-series.js';
import { syncTaskCompletion } from './task-completions.js';
import { unresolvedDependencies, syncWorkflowInstanceForTask } from './activity-workflows.js';
import { markTodoOutbound } from './caldav-todo-outbound.js';
import { assertTaskMutation, taskCapabilities, taskDevicePrincipal } from './task-access.js';
import { reconcileTaskSupervision, inspectTaskSupervision, taskSupervisionTransition, supervisionProjectionUpdates, taskSupervisionRootId } from './task-supervision.js';
import * as v from '../middleware/validate.js';
import { todayKey } from '../utils/timezone.js';
import { taskDeadlineMs, taskStartMs, taskExpirationDue, taskWindowAncestors, EXPIRATION_POLICIES } from './task-window.js';
import { taskOptionalContext } from './task-optional.js';
import { settleTaskRotations } from './task-rotation.js';

let recurrenceHooks = null;
// Recurrence keeps its established anchored/group implementation in the Tasks
// adapter. No writer may silently complete a series without that adapter.
export function configureTaskRecurrence(hooks) { recurrenceHooks = hooks; }

export class TaskStateError extends Error {
  constructor(message, details = {}, status = 409) {
    super(message); this.status = status; this.code = status; this.details = details;
  }
}

/** A future recurring occurrence can be viewed, but none of its original or
 * linked helper actions may be completed before its household-local start day.
 * Use the structural ancestry too: a Workflow's Activity binding creates a
 * supervision boundary, not permission to bypass the enclosing occurrence. */
export function assertRecurringCompletionStarted(d, taskId, now = new Date()) {
  const day = todayKey(d, now);
  const mapped = d.prepare(`SELECT source_task_id FROM task_supervision_actions
    WHERE action_task_id=? OR counterpart_task_id=? UNION
    SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?`).all(taskId,taskId,taskId);
  const pending = [Number(taskId),...mapped.map(row=>row.source_task_id)], seen = new Set();
  while(pending.length) {
    const id = pending.pop();
    if(seen.has(id))continue;
    seen.add(id);
    const task = d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if(!task)continue;
    if(task.is_recurring && task.start_date && (task.start_date > day || taskStartMs(d,task) > Number(now)))
      throw new TaskStateError(`This occurrence starts on ${task.start_date}${task.start_time ? ` at ${task.start_time}` : ''}; it cannot be completed yet.`,
        {reason:'occurrence_not_started',task_id:task.id,start_date:task.start_date,start_time:task.start_time});
    if(task.parent_task_id)pending.push(task.parent_task_id);
  }
}

/** Shared by REST and compatibility writers, including changes to child actions. */
export function assertTaskWindowAction(d, taskId, now = new Date(), {optionalReopenScope=null}={}) {
  for (const task of taskWindowAncestors(d,taskId)) {
    if (task.status === 'expired' || taskExpirationDue(d,task,now))
      throw new TaskStateError('This Task has expired. An authorized editor must explicitly reopen it before progress can change.',
        {reason:'task_expired',task_id:task.id});
  }
  const optional=taskOptionalContext(d,taskId);
  if(optional.closed_parent&&!optionalReopenScope?.has(optional.closed_parent.id))throw new TaskStateError('Reopen the completed parent Task before changing an optional action.',
    {reason:'optional_parent_completed',task_id:optional.closed_parent.id});
}

export function assertTaskRevision(d, task, body = {}, {required = false, requireParent = false} = {}) {
  if ((required && body.expected_revision === undefined)
      || (requireParent && task.parent_task_id && body.expected_parent_revision === undefined))
    throw new TaskStateError('Refresh this Task before changing it. Older clients must update before saving Task changes.',
      {reason:'revision_required',task_id:task.id},428);
  for (const [key, actual] of [
    ['expected_revision', task.revision],
    ['expected_parent_revision', task.parent_task_id
      ? d.prepare('SELECT revision FROM tasks WHERE id = ?').get(task.parent_task_id)?.revision : null],
  ]) {
    if (body[key] === undefined) continue; // Explicit trusted/internal callers may omit CAS.
    if (!Number.isSafeInteger(body[key]) || body[key] < 1)
      throw new TaskStateError('Invalid Task revision.', {}, 400);
    if (body[key] !== actual)
      throw new TaskStateError('This Task changed on another device. Reload it before trying again.',
        { reason: 'stale_revision', task_id: task.id, revision: task.revision });
  }
}

export function actionableSubtasks(d, taskId) {
  // This is the structural completion scope, including transferred originals.
  // Learner progress is a separate read projection: removing helper-owned work
  // here would complete the overall occurrence before that work is finished.
  return d.prepare(`SELECT t.* FROM tasks t WHERE t.parent_task_id = ? AND t.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id = t.id)
    ORDER BY t.sort_order, t.created_at, t.id`).all(taskId);
}

export function recordTaskActivity(d, taskId, eventType, actorId, details = {}, actionTaskId = taskId) {
  const task = d.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
    VALUES (?,?,?,?,?)`).run(task.parent_task_id || taskId, actionTaskId, actorId ?? null, eventType, JSON.stringify(details));
}

export function taskActivity(d, taskId, limit = 60) {
  return d.prepare(`SELECT e.id,e.action_task_id,e.actor_user_id,e.event_type,e.created_at,e.details_json,
    u.display_name AS actor_name FROM task_activity_events e LEFT JOIN users u ON u.id=e.actor_user_id
    WHERE e.task_id=? ORDER BY e.id DESC LIMIT ?`).all(taskId, Math.max(1, Math.min(100, Number(limit)||60)))
    .map(({details_json, ...row}) => ({...row, details: JSON.parse(details_json)}));
}

function deviceResponsibilitySnapshot(d, task) {
  const seen=new Set();
  while(task && !seen.has(task.id)) {
    seen.add(task.id);
    const members=d.prepare(`SELECT u.id,u.display_name FROM users u WHERE u.id=?
      OR EXISTS(SELECT 1 FROM task_assignments a WHERE a.task_id=? AND a.user_id=u.id) ORDER BY u.id`).all(task.assigned_to,task.id);
    if(members.length)return members;
    task=task.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_task_id):null;
  }
  return [];
}

function applyTransition(d, task, status, actorId, effects, {preserveFollowup=false,now=new Date(),optionalReopenScope=null}={}) {
  if (task.status === status) return;
  assertTaskWindowAction(d,task.id,now,{optionalReopenScope});
  if (status === 'done') {
    assertRecurringCompletionStarted(d,task.id,now);
    const dependencies = unresolvedDependencies(d, task.id);
    if (dependencies.length) throw new TaskStateError('Complete required earlier activities first.',
      {dependencies: dependencies.filter(item => effects.authorizationActor != null && taskCapabilities(d,effects.authorizationActor,item).view)});
  }
  if (task.is_recurring && !task.parent_task_id && !recurrenceHooks)
    throw new TaskStateError('Recurring Task actions are temporarily unavailable. Please try again.', {}, 503);
  d.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, task.id);
  effects.changedTaskIds.add(task.id);
  effects.pending = markTodoOutbound('tasks', task, {...task, status}) || effects.pending;
  // Preserve the existing linked housekeeping payment projection.
  d.prepare(`UPDATE housekeeping_work_sessions SET paid_at = CASE WHEN ? = 'done'
    THEN COALESCE(paid_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')) ELSE NULL END
    WHERE payment_task_id = ?`).run(status, task.id);
  syncTaskRewards(d, task.id, task.status, status, actorId);
  syncTaskCompletion(d, task.id, task.status, status, actorId, {sourceDevice:effects.sourceDevice});
  recordTaskActivity(d, task.id, status === 'done' ? 'completed' : status === 'open' ? 'reset'
    : task.status === 'done' ? 'reopened' : 'started',
  actorId, {from_status:task.status,to_status:status,title:task.title,
    ...(effects.sourceDevice ? {source_device:effects.sourceDevice,assigned_members:deviceResponsibilitySnapshot(d,task)} : {}),
    ...(status==='done'?{assigned_user_id:task.assigned_to??null,completion_source:effects.bulkCompletion?'bulk':'individual'}:{})});
  if (status === 'done') {
    d.prepare(`UPDATE planning_obligations SET status='fulfilled',
      responded_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE task_id=? AND status IN ('pending','accepted')`).run(task.id);
    d.prepare("UPDATE task_responsibilities SET status='fulfilled' WHERE task_id=? AND status='active'").run(task.id);
    d.prepare("UPDATE task_assignment_context SET state='fulfilled' WHERE task_id=?").run(task.id);
    settleTaskRotations(d, task.id, 'completed', {actorId});
    recurrenceHooks?.spawn(d.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
  } else if (task.status === 'done') {
    // Historical supervisors are not all revived when an occurrence reopens.
    // The reconciler chooses one person for its new remaining scope below.
    d.prepare("UPDATE task_responsibilities SET status='active' WHERE task_id=? AND status='fulfilled' AND role!='supervisor'").run(task.id);
    d.prepare(`UPDATE task_assignment_context SET state=CASE WHEN strategy='open_claimable'
      AND (SELECT assigned_to FROM tasks WHERE id=?) IS NULL THEN 'open' ELSE 'assigned' END WHERE task_id=?`).run(task.id,task.id);
    if(!preserveFollowup)effects.undone += recurrenceHooks?.discard(task.id) || 0;
  }
  syncWorkflowInstanceForTask(d, task.id, {syncParent:false});
}

/** Atomic child/parent/projection transition, including recurrence and rewards. */
export function changeTaskStatus(d, taskId, status, {actorId=null, principal=actorId, body={}, authorize=true, requireRevision=authorize,now=null}={}) {
  const device = taskDevicePrincipal(principal);
  if (device) actorId = null; // Device IDs must never enter human actor or reward-recipient fields.
  if (!['open','in_progress','done'].includes(status)) throw new TaskStateError('Invalid Task status.',{},400);
  return d.transaction(() => {
    now ??= new Date();
    const requested = d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!requested) throw new TaskStateError('Task not found.',{},404);
    if (authorize) assertTaskMutation(d,principal,requested,device?{...body,status}:{status},{operation:'status'});
    assertTaskRevision(d,requested,body,{required:requireRevision,requireParent:requireRevision});
    assertTaskWindowAction(d,requested.id,now);
    if(retiredRecurrenceOccurrence(d,requested.id))throw new TaskStateError(
      'This historical occurrence was retired. Its recorded progress is preserved; use the current occurrence instead.',
      {reason:'occurrence_retired'});
    if(status==='done')assertRecurringCompletionStarted(d,requested.id,now);
    // Includes legacy Tasks whose mappings did not exist before this action.
    reconcileTaskSupervision(d,requested.id,{actorId});
    const gate = taskSupervisionTransition(d,requested.id,status,actorId);
    const task = d.prepare('SELECT * FROM tasks WHERE id=?').get(gate.taskId);
    if(status==='done'&&task.status!=='done') {
      const dependencies=unresolvedDependencies(d,task.id);
      if(dependencies.length)throw new TaskStateError('Complete required earlier activities first.',
        {dependencies:dependencies.filter(item=>principal!=null&&taskCapabilities(d,principal,item).view)});
    }
    const containerActions = (gate.containerActionTaskIds||[])
      .map(id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id)).filter(Boolean);
    const children = containerActions.length ? containerActions : actionableSubtasks(d,task.id);
    const descendants=[];
    const visited=new Set([task.id]);
    const collectDescendants = rows => {
      for(const child of rows) {
        if(visited.has(child.id))continue;
        visited.add(child.id);
        if(status==='done'&&child.is_optional&&!containerActions.length)continue;
        collectDescendants(actionableSubtasks(d,child.id));
        descendants.push(child);
      }
    };
    if(status==='open'||status==='done')collectDescendants(children);
    const incomplete = descendants.filter(child=>child.status!=='done');
    // Check authorization before disclosing counts for independently private
    // children in a parent completion/reset confirmation.
    if(authorize)for(const child of status==='done'?incomplete:status==='open'?descendants.filter(row=>row.status!=='open'):[])
      assertTaskMutation(d,principal,child,{status},{operation:'status'});
    if (status === 'done' && incomplete.length) {
      const incompleteIds = new Set(incomplete.map(child => child.id));
      const helperPending = inspectTaskSupervision(d, task.id).actions.some(action =>
        action.execution_mode === 'delegated' && action.state !== 'not_required' && !action.completed
        && incompleteIds.has(action.action_task_id) && Number(action.supervisor_user_id) !== Number(actorId));
      if (helperPending) throw new TaskStateError(
        'A helper must finish the transferred steps before this whole Task can be completed. Finish the steps you are responsible for in the checklist.',
        {reason: 'waiting_for_helper'});
    }
    if (status==='done' && incomplete.length && body.complete_remaining!==true)
      throw new TaskStateError('Completing this Task will also complete its remaining subtasks.',
        {confirmation_required:'complete_remaining',remaining:incomplete.length});
    if (status==='open' && ((task.status==='done'&&!task.parent_task_id)||descendants.some(child=>child.status==='done')) && body.reset_progress!==true)
      throw new TaskStateError('Resetting this Task will clear its subtask progress.',
        {confirmation_required:'reset_progress'});
    const effects={pending:false,undone:0,changedTaskIds:new Set(),bulkCompletion:status==='done'&&incomplete.length>0,
      authorizationActor:principal,sourceDevice:device ? {id:device.id,name:device.name} : null};
    const targets = status==='done' ? incomplete : status==='open' ? descendants.filter(child=>child.status!=='open') : [];
    // Validate every affected action before writing any progress.
    for (const child of targets) {
      if (authorize) assertTaskMutation(d,principal,child,{status},{operation:'status'});
      taskSupervisionTransition(d,child.id,status,actorId);
      if(containerActions.length && status==='done' && actionableSubtasks(d,child.id).some(row=>!row.is_optional&&row.status!=='done'))
        throw new TaskStateError('Complete the original Task’s independent steps before recording supervision of the whole Task.');
    }
    // Only an explicitly authorized, confirmed parent reset may reset optional
    // descendants while their old parent statuses still record completion.
    const optionalReopenScope=status==='open'?new Set([task.id,...targets.map(child=>child.id)]):null;
    const preserveFollowup=task.status==='done'&&actionableSubtasks(d,task.id).some(child=>child.is_optional);
    for (const child of targets) applyTransition(d,child,status,actorId,effects,{now,optionalReopenScope});
    applyTransition(d,task,status,actorId,effects,{preserveFollowup,now,optionalReopenScope});
    // A Workflow may depend on the linked supervision Task. Publish the
    // authoritative action to that projection before checking its parent.
    const syncProjections = sourceId => {
      for (const projection of supervisionProjectionUpdates(d,sourceId)) {
        const previous=d.prepare('SELECT * FROM tasks WHERE id=?').get(projection.id ?? projection.taskId);
        if (previous && projection.status !== 'expired') applyTransition(d,previous,projection.status,actorId,effects,{now});
      }
    };
    syncProjections(gate.sourceTaskId||task.parent_task_id||task.id);
    // A checklist can sit under an Activity Task inside a Workflow container.
    // Derive every ancestor from the leaves up, and retain each old status until
    // its canonical transition records rewards, completion history and recurrence.
    const parents=new Set();
    for(const id of [task.id,...targets.map(child=>child.id),...effects.changedTaskIds]) {
      const seen=new Set([id]);
      let parentId=d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(id)?.parent_task_id;
      while(parentId&&!seen.has(parentId)) {
        parents.add(parentId);seen.add(parentId);
        parentId=d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(parentId)?.parent_task_id;
      }
    }
    const depth = id => {
      const seen=new Set();
      while(id&&!seen.has(id)){seen.add(id);id=d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(id)?.parent_task_id;}
      return seen.size;
    };
    for (const parentId of [...parents].sort((a,b)=>depth(b)-depth(a))) {
      const parent = d.prepare('SELECT * FROM tasks WHERE id=?').get(parentId);
      const siblings = actionableSubtasks(d,parent.id);
      if (siblings.length) {
        const required=siblings.filter(child=>!child.is_optional);
        const allDone=required.length>0&&required.every(child=>child.status==='done');
        const someProgress=siblings.some(child=>child.status!=='open');
        const next=allDone?'done':parent.status==='done'?'in_progress':someProgress&&parent.status==='open'?'in_progress':parent.status;
        if (next!==parent.status) {
          // Derived progress must not roll back a valid child action while
          // another Workflow dependency is still outstanding.
          if(next==='done'&&unresolvedDependencies(d,parent.id).length) {
            if(parent.status==='open')applyTransition(d,parent,'in_progress',actorId,effects,{now});
            continue;
          }
          try { taskSupervisionTransition(d,parent.id,next,actorId); }
          catch(error) {
            // Completing an independent final step must not be rolled back
            // merely because the parent explicitly requires a supervisor.
            if(next==='done'&&error.code==='supervision_required') {
              if(parent.status==='open')applyTransition(d,parent,'in_progress',actorId,effects,{now});
              continue;
            }
            throw error;
          }
          applyTransition(d,parent,next,actorId,effects,{preserveFollowup:true,now});
        }
      }
      syncProjections(taskSupervisionRootId(d,parentId));
    }
    syncProjections(gate.sourceTaskId||task.parent_task_id||task.id);
    const supervisionRoots = new Set([gate.sourceTaskId, ...effects.changedTaskIds].filter(Boolean)
      .map(id => taskSupervisionRootId(d,id)));
    for (const sourceId of supervisionRoots) reconcileTaskSupervision(d,sourceId,{actorId});
    return {pending:effects.pending,undone:effects.undone,task:d.prepare('SELECT * FROM tasks WHERE id=?').get(requested.id),
      parent_task:task.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_task_id):null};
  }).immediate();
}

/** A terminal occurrence, never a completion. Original points and completed
 * children stay intact so history and the next occurrence retain their meaning. */
export function expireTask(d, taskId, {now=new Date()}={}) {
  return d.transaction(() => {
    const source=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!taskExpirationDue(d,source,now)) return {expired:false,task:source};
    if(!source.parent_task_id)ensureSeriesDefinition(d,source.id);
    const recurrence=authoritativeTaskRecurrence(d,source);
    if(recurrence.is_recurring&&!source.parent_task_id&&!recurrenceHooks)throw new TaskStateError('Recurring Task actions are temporarily unavailable.',{},503);
    // Retain a retryable frontier even if the adapter's successor transaction
    // rolls back before it can register the source's first occurrence.
    if(recurrence.is_recurring&&!source.parent_task_id)registerRecurrenceOccurrence(d,source.id);
    const at=new Date(taskDeadlineMs(d,source)).toISOString();
    const rows=d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ?
      UNION SELECT t.id FROM tasks t JOIN scope p ON t.parent_task_id=p.id
      UNION SELECT s.task_id FROM task_activity_support_tasks s JOIN scope p ON s.source_task_id=p.id
      UNION SELECT a.counterpart_task_id FROM task_supervision_actions a JOIN scope p ON a.source_task_id=p.id
        WHERE a.counterpart_task_id IS NOT NULL)
      SELECT t.* FROM tasks t JOIN scope p ON p.id=t.id`).all(taskId);
    for(const row of rows) {
      if(!['open','in_progress'].includes(row.status))continue;
      d.prepare("UPDATE tasks SET status='expired',expired_at=? WHERE id=? AND status IN ('open','in_progress')").run(at,row.id);
      d.prepare("UPDATE task_responsibilities SET status='cancelled' WHERE task_id=? AND status='active'").run(row.id);
      d.prepare("UPDATE planning_obligations SET status='cancelled',updated_at=? WHERE task_id=? AND status IN ('pending','accepted')").run(at,row.id);
      // No fulfillment, rewards, completion ledger, or successful workflow transition.
      d.prepare("UPDATE task_assignment_context SET state='cancelled' WHERE task_id=? AND state!='fulfilled'").run(row.id);
      d.prepare("UPDATE task_supervision_actions SET state='not_required',reason='The Task expired incomplete.',revision=revision+1,updated_at=? WHERE action_task_id=? AND state!='not_required'").run(at,row.id);
    }
    recordTaskActivity(d,source.id,'expired',null,{title:source.title,from_status:source.status,to_status:'expired',expired_at:at,points_awarded:0,
      recurrence_paused:!!(recurrence.is_recurring&&recurrence.recurrence_from_completion)});
    // The adapter's nested transaction rolls back a failed materialization,
    // while the expiration itself remains durable. Startup/timer reconciliation
    // retries this terminal frontier; a missing eligible assignee cannot keep
    // yesterday's Task actionable indefinitely.
    settleTaskRotations(d,source.id,'skipped');
    let recurrenceError=null;
    try { recurrenceHooks?.spawn(d.prepare('SELECT * FROM tasks WHERE id=?').get(source.id)); }
    catch(error) { recurrenceError=error; }
    return {expired:true,task:d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId),recurrenceError};
  }).immediate();
}

export function resumeExpiredTaskRecurrence(d,taskId) {
  const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  const recurrence=task?authoritativeTaskRecurrence(d,task):null;
  if(task?.status!=='expired'||!recurrence.is_recurring||recurrence.recurrence_from_completion||task.parent_task_id)return;
  if(!recurrenceHooks)throw new TaskStateError('Recurring Task actions are temporarily unavailable.',{},503);
  return recurrenceHooks.spawn(task);
}

/** Explicit authorized reactivation preserves partial progress and successors. */
export function reopenExpiredTask(d,taskId,{actorId,body={},now=new Date()}={}) {
  return d.transaction(()=>{
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if(!task)throw new TaskStateError('Task not found.',{},404);
    assertTaskMutation(d,actorId,task,body,{operation:'reopen'});
    assertTaskRevision(d,task,body,{required:true,requireParent:true});
    if(task.status!=='expired')throw new TaskStateError('Only expired Tasks can be reopened.');
    if(task.archived_at)throw new TaskStateError('Restore this Task from the archive before reopening it.');
    if(taskWindowAncestors(d,taskId).some(row=>row.id!==task.id&&row.status==='expired'))
      throw new TaskStateError('Reopen the expired parent Task first.',{reason:'parent_expired'});
    const errors=v.collectErrors([v.date(body.due_date,'due_date'),v.time(body.due_time,'due_time')]);
    if(errors.length)throw new TaskStateError(errors.join(' '),{},400);
    const policy=body.expiration_policy===undefined?task.expiration_policy:body.expiration_policy;
    if(!EXPIRATION_POLICIES.includes(policy))throw new TaskStateError('Invalid expiration policy.',{},400);
    const candidate={...task,expiration_policy:policy,due_date:body.due_date??task.due_date,due_time:body.due_time??task.due_time,status:'open'};
    if(candidate.due_date&&taskDeadlineMs(d,candidate)==null)throw new TaskStateError('Choose a valid deadline.',{},400);
    if(taskStartMs(d,candidate)!=null&&taskDeadlineMs(d,candidate)!=null&&taskStartMs(d,candidate)>=taskDeadlineMs(d,candidate))throw new TaskStateError('The deadline must be after the start.',{},400);
    if(policy==='expire_incomplete'&&(!candidate.due_date||taskExpirationDue(d,candidate,now)))
      throw new TaskStateError('Choose a future deadline or Keep overdue when reopening this occurrence.',{reason:'new_deadline_required'},400);
    const rows=d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ?
      UNION SELECT t.id FROM tasks t JOIN scope p ON t.parent_task_id=p.id
      UNION SELECT s.task_id FROM task_activity_support_tasks s JOIN scope p ON s.source_task_id=p.id
      UNION SELECT a.counterpart_task_id FROM task_supervision_actions a JOIN scope p ON a.source_task_id=p.id WHERE a.counterpart_task_id IS NOT NULL)
      SELECT t.* FROM tasks t JOIN scope p ON p.id=t.id`).all(taskId);
    for(const row of rows)if(row.status==='expired') {
      const projection=d.prepare(`SELECT 1 FROM task_activity_support_tasks WHERE task_id=?
        UNION ALL SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=? LIMIT 1`).get(row.id,row.id);
      if(!projection)assertTaskMutation(d,actorId,row,{}, {operation:'reopen'});
    }
    for(const row of rows)if(row.status==='expired') {
      const progress=d.prepare("SELECT 1 FROM tasks WHERE parent_task_id=? AND status='done'").get(row.id);
      d.prepare('UPDATE tasks SET status=?,expired_at=NULL WHERE id=?').run(progress?'in_progress':'open',row.id);
      d.prepare("UPDATE task_responsibilities SET status='active' WHERE task_id=? AND status='cancelled' AND role!='supervisor'").run(row.id);
      d.prepare("UPDATE task_assignment_context SET state=CASE WHEN strategy='open_claimable' AND (SELECT assigned_to FROM tasks WHERE id=?) IS NULL THEN 'open' ELSE 'assigned' END WHERE task_id=?").run(row.id,row.id);
      if(row.id!==taskId)d.prepare(`UPDATE tasks SET
        due_date=CASE WHEN due_date IS ? THEN ? ELSE due_date END,
        due_time=CASE WHEN due_time IS ? THEN ? ELSE due_time END WHERE id=?`)
        .run(task.due_date,candidate.due_date,task.due_time,candidate.due_time,row.id);
    }
    const dueDateOffset = task.due_date_offset_days == null ? null : calendarDayOffset(task.start_date, candidate.due_date);
    d.prepare('UPDATE tasks SET expiration_policy=?,due_date=?,due_time=?,due_date_offset_days=? WHERE id=?')
      .run(policy,candidate.due_date,candidate.due_time,dueDateOffset,taskId);
    reconcileTaskSupervision(d,taskId,{actorId});
    recordTaskActivity(d,taskId,'reopened',actorId,{title:task.title,from_status:'expired',to_status:d.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,
      expiration_policy:policy,previous_expired_at:task.expired_at});
    return d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  }).immediate();
}
