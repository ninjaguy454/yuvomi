/** One operational transition for REST and compatibility writers. */
import { syncTaskRewards } from './rewards.js';
import { syncTaskCompletion } from './task-completions.js';
import { unresolvedDependencies, syncWorkflowInstanceForTask } from './activity-workflows.js';
import { markTodoOutbound } from './caldav-todo-outbound.js';
import { assertTaskMutation, taskCapabilities } from './task-access.js';
import { reconcileTaskSupervision, taskSupervisionTransition, supervisionProjectionUpdates, taskSupervisionRootId } from './task-supervision.js';

let recurrenceHooks = null;
// Recurrence keeps its established anchored/group implementation in the Tasks
// adapter. No writer may silently complete a series without that adapter.
export function configureTaskRecurrence(hooks) { recurrenceHooks = hooks; }

export class TaskStateError extends Error {
  constructor(message, details = {}, status = 409) {
    super(message); this.status = status; this.code = status; this.details = details;
  }
}

export function assertTaskRevision(d, task, body = {}) {
  for (const [key, actual] of [
    ['expected_revision', task.revision],
    ['expected_parent_revision', task.parent_task_id
      ? d.prepare('SELECT revision FROM tasks WHERE id = ?').get(task.parent_task_id)?.revision : null],
  ]) {
    if (body[key] === undefined) continue; // Compatibility clients may omit CAS.
    if (!Number.isSafeInteger(body[key]) || body[key] < 1)
      throw new TaskStateError('Invalid Task revision.', {}, 400);
    if (body[key] !== actual)
      throw new TaskStateError('This Task changed on another device. Reload it before trying again.',
        { reason: 'stale_revision', task_id: task.id, revision: task.revision });
  }
}

export function actionableSubtasks(d, taskId) {
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

function applyTransition(d, task, status, actorId, effects, {preserveFollowup=false}={}) {
  if (task.status === status) return;
  if (status === 'done') {
    const dependencies = unresolvedDependencies(d, task.id);
    if (dependencies.length) throw new TaskStateError('Complete required earlier activities first.',
      {dependencies: dependencies.filter(item => actorId != null && taskCapabilities(d,actorId,item).view)});
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
  syncTaskCompletion(d, task.id, task.status, status, actorId);
  recordTaskActivity(d, task.id, status === 'done' ? 'completed' : status === 'open' ? 'reset'
    : task.status === 'done' ? 'reopened' : 'started',
  actorId, {from_status:task.status,to_status:status,title:task.title});
  if (status === 'done') {
    d.prepare(`UPDATE planning_obligations SET status='fulfilled',
      responded_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE task_id=? AND status IN ('pending','accepted')`).run(task.id);
    d.prepare("UPDATE task_responsibilities SET status='fulfilled' WHERE task_id=? AND status='active'").run(task.id);
    d.prepare("UPDATE task_assignment_context SET state='fulfilled' WHERE task_id=?").run(task.id);
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
export function changeTaskStatus(d, taskId, status, {actorId=null, body={}, authorize=true}={}) {
  if (!['open','in_progress','done'].includes(status)) throw new TaskStateError('Invalid Task status.',{},400);
  return d.transaction(() => {
    const requested = d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!requested) throw new TaskStateError('Task not found.',{},404);
    if (authorize) assertTaskMutation(d,actorId,requested,{status},{operation:'status'});
    assertTaskRevision(d,requested,body);
    // Includes legacy Tasks whose mappings did not exist before this action.
    reconcileTaskSupervision(d,requested.id,{actorId});
    const gate = taskSupervisionTransition(d,requested.id,status,actorId);
    const task = d.prepare('SELECT * FROM tasks WHERE id=?').get(gate.taskId);
    if(status==='done'&&task.status!=='done') {
      const dependencies=unresolvedDependencies(d,task.id);
      if(dependencies.length)throw new TaskStateError('Complete required earlier activities first.',
        {dependencies:dependencies.filter(item=>actorId!=null&&taskCapabilities(d,actorId,item).view)});
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
        collectDescendants(actionableSubtasks(d,child.id));
        descendants.push(child);
      }
    };
    if(status==='open'||status==='done')collectDescendants(children);
    const incomplete = descendants.filter(child=>child.status!=='done');
    // Check authorization before disclosing counts for independently private
    // children in a parent completion/reset confirmation.
    if(authorize)for(const child of status==='done'?incomplete:status==='open'?descendants.filter(row=>row.status!=='open'):[])
      assertTaskMutation(d,actorId,child,{status},{operation:'status'});
    if (status==='done' && incomplete.length && body.complete_remaining!==true)
      throw new TaskStateError('Completing this Task will also complete its remaining subtasks.',
        {confirmation_required:'complete_remaining',remaining:incomplete.length});
    if (status==='open' && ((task.status==='done'&&!task.parent_task_id)||descendants.some(child=>child.status==='done')) && body.reset_progress!==true)
      throw new TaskStateError('Resetting this Task will clear its subtask progress.',
        {confirmation_required:'reset_progress'});
    const effects={pending:false,undone:0,changedTaskIds:new Set()};
    const targets = status==='done' ? incomplete : status==='open' ? descendants.filter(child=>child.status!=='open') : [];
    // Validate every affected action before writing any progress.
    for (const child of targets) {
      if (authorize) assertTaskMutation(d,actorId,child,{status},{operation:'status'});
      taskSupervisionTransition(d,child.id,status,actorId);
      if(containerActions.length && status==='done' && actionableSubtasks(d,child.id).some(row=>row.status!=='done'))
        throw new TaskStateError('Complete the original Task’s independent steps before recording supervision of the whole Task.');
    }
    for (const child of targets) applyTransition(d,child,status,actorId,effects);
    applyTransition(d,task,status,actorId,effects);
    // A Workflow may depend on the linked supervision Task. Publish the
    // authoritative action to that projection before checking its parent.
    const syncProjections = sourceId => {
      for (const projection of supervisionProjectionUpdates(d,sourceId)) {
        const previous=d.prepare('SELECT * FROM tasks WHERE id=?').get(projection.id ?? projection.taskId);
        if (previous) applyTransition(d,previous,projection.status,actorId,effects);
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
        const allDone=siblings.every(child=>child.status==='done');
        const someProgress=siblings.some(child=>child.status!=='open');
        const next=allDone?'done':parent.status==='done'?'in_progress':someProgress&&parent.status==='open'?'in_progress':parent.status;
        if (next!==parent.status) {
          // Derived progress must not roll back a valid child action while
          // another Workflow dependency is still outstanding.
          if(next==='done'&&unresolvedDependencies(d,parent.id).length) {
            if(parent.status==='open')applyTransition(d,parent,'in_progress',actorId,effects);
            continue;
          }
          try { taskSupervisionTransition(d,parent.id,next,actorId); }
          catch(error) {
            // Completing an independent final step must not be rolled back
            // merely because the parent explicitly requires a supervisor.
            if(next==='done'&&error.code==='supervision_required') {
              if(parent.status==='open')applyTransition(d,parent,'in_progress',actorId,effects);
              continue;
            }
            throw error;
          }
          applyTransition(d,parent,next,actorId,effects,{preserveFollowup:true});
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
  })();
}
