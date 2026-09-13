/** Thin adapters from committed domain changes to user notification receipts. */
import { randomUUID } from 'node:crypto';
import { enqueueNotification } from './notification-inbox.js';
import { inspectTaskSupervision, taskSupervisionNotificationKey } from './task-supervision.js';

// A resolved request remains useful history, but should not be delivered as a
// new request after somebody has already answered it on another device.
export function isNotificationDeliveryCurrent(database, notification) {
  const scope = /^task-supervision-scope:(\d+):[a-f0-9]+$/.exec(notification.source_key || '');
  if (scope) {
    const view = inspectTaskSupervision(database, Number(scope[1]));
    return notification.source_key === taskSupervisionNotificationKey(view)
      && (['needed','excluded'].includes(view.state)
        || (view.state === 'assigned' && Number(view.supervisor_user_id) === Number(notification.user_id)));
  }
  const supervision = /^task-supervision:(\d+):revision:(\d+)$/.exec(notification.source_key || '');
  if (supervision) {
    const action = database.prepare(`SELECT a.*,t.status AS task_status FROM task_supervision_actions a
      JOIN tasks t ON t.id=a.action_task_id WHERE a.id=?`).get(Number(supervision[1]));
    if (action && database.prepare("SELECT 1 FROM notification_inbox WHERE entity_type='task' AND entity_id=? AND source_key LIKE ? LIMIT 1")
      .get(action.source_task_id,`task-supervision-scope:${action.source_task_id}:%`)) return false;
    const view = action ? inspectTaskSupervision(database, action.source_task_id) : null;
    return !!action && action.revision === Number(supervision[2]) && action.task_status !== 'done'
      && (['unresolved','excluded'].includes(action.state)
        || (view?.state === 'assigned' && Number(view.supervisor_user_id) === Number(notification.user_id)));
  }
  const obligationId = /^obligation:(\d+):assigned$/.exec(notification.source_key || '')?.[1];
  if (obligationId) {
    const obligation = database.prepare('SELECT status, responsible_user_id, task_id, role FROM planning_obligations WHERE id = ?').get(Number(obligationId));
    if (!obligation || obligation.status !== 'pending') return false;
    if (obligation.role === 'supervisor') {
      const view = inspectTaskSupervision(database, obligation.task_id);
      if (view.actions.some(action => action.id)) return false; // Linked supervision owns its one scope request.
      return view.state === 'assigned' && Number(view.supervisor_user_id) === Number(notification.user_id)
        && Number(obligation.responsible_user_id) === Number(notification.user_id)
        && !database.prepare('SELECT 1 FROM notification_inbox WHERE user_id=? AND source_key=?')
          .get(notification.user_id,taskSupervisionNotificationKey(view));
    }
    if (obligation.responsible_user_id) return Number(obligation.responsible_user_id) === Number(notification.user_id);
    return Boolean(obligation.task_id && database.prepare("SELECT 1 FROM task_assignment_context WHERE task_id = ? AND state = 'open'").get(obligation.task_id));
  }
  if (/^task:\d+:assigned:/.test(notification.source_key || '')) {
    if (delegatedLearner(database, notification.entity_id) === Number(notification.user_id)) return false;
    return Boolean(database.prepare(`SELECT 1 FROM task_assignments a JOIN tasks t ON t.id = a.task_id
      WHERE a.task_id = @task AND a.user_id = @user AND t.status != 'done' AND t.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM notification_inbox newer
          WHERE newer.user_id = @user AND newer.entity_type = 'task' AND newer.entity_id = @task
            AND newer.id > @receipt AND newer.source_key LIKE @assignmentPrefix)`)
      .get({ task: notification.entity_id, user: notification.user_id, receipt: notification.id,
        assignmentPrefix: `task:${notification.entity_id}:assigned:%` }));
  }
  if (/^task:\d+:claimable$/.test(notification.source_key || '')) {
    return Boolean(database.prepare(`SELECT 1 FROM task_assignment_context c JOIN task_claim_eligibility e ON e.task_id = c.task_id
      WHERE c.task_id = ? AND c.state = 'open' AND e.user_id = ?`).get(notification.entity_id, notification.user_id));
  }
  return true;
}

function taskCategory(database, taskId) {
  const source = database.prepare('SELECT source FROM task_assignment_context WHERE task_id = ?').get(taskId)?.source;
  return ['activity_template', 'workflow'].includes(source) ? 'automation' : 'tasks';
}

function delegatedLearner(database, taskId) {
  const action = inspectTaskSupervision(database, taskId).actions.find(row => Number(row.action_task_id) === Number(taskId));
  return action?.execution_mode === 'delegated' && action.state !== 'not_required' ? Number(action.learner_user_id) : null;
}

export function notifyTaskAssignments(database, taskId, previousIds = [], { managed = false, role = null } = {}) {
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  // Policy-managed requests carry an obligation ID, so they use the adapter
  // below. Parent participant rows summarize child work and are not more work.
  if (!managed && database.prepare('SELECT 1 FROM task_assignment_context WHERE task_id = ?').get(taskId)) return;
  const before = new Set(previousIds.map(Number));
  const recipients = database.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(taskId);
  const excludedLearner = delegatedLearner(database, taskId);
  const eventKey = `task:${taskId}:assigned:${randomUUID()}`;
  for (const { user_id: userId } of recipients) {
    if (before.has(Number(userId)) || Number(userId) === excludedLearner) continue;
    enqueueNotification(database, {
      userId, sourceKey: eventKey, category: taskCategory(database, taskId), entityType: 'task', entityId: taskId,
      title: role ? `New ${role} responsibility` : 'Task assigned to you', body: task.title,
    });
  }
}

export function notifyTaskObligations(database, taskId, { eligibleIds = [] } = {}) {
  const task = database.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  const obligations = database.prepare(`SELECT * FROM planning_obligations WHERE task_id = ?
    AND status = 'pending' ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, id DESC`).all(taskId);
  const notified = new Set();
  for (const obligation of obligations) {
    const recipients = obligation.responsible_user_id ? [obligation.responsible_user_id] : eligibleIds;
    for (const userId of recipients) {
      if (notified.has(Number(userId))) continue;
      notified.add(Number(userId));
      if (obligation.role === 'supervisor') {
        const view = inspectTaskSupervision(database, taskId);
        // Completing a step changes the scope key, but does not create a new
        // helper assignment. Never fall back to a second obligation request.
        if (view.actions.some(action => action.id)) continue;
        if (view.state !== 'assigned' || Number(view.supervisor_user_id) !== Number(userId)
          || database.prepare('SELECT 1 FROM notification_inbox WHERE user_id=? AND source_key=?')
            .get(userId,taskSupervisionNotificationKey(view))) continue;
      }
      enqueueNotification(database, {
        userId, sourceKey: `obligation:${obligation.id}:assigned`, category: taskCategory(database, taskId),
        entityType: 'task', entityId: taskId,
        title: obligation.responsible_user_id ? (obligation.role === 'supervisor' ? 'Supervision requested' : 'Assignment needs your response') : 'A task is available to claim',
        body: task.title,
      });
    }
  }
}

export function notifyTaskClaim(database, taskId, eventId, actorId) {
  const task = database.prepare('SELECT title, created_by FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  const recipients = new Set([task.created_by, ...database.prepare(`SELECT user_id FROM task_responsibilities
    WHERE task_id = ? AND role = 'supervisor' AND status = 'active'`).all(taskId).map((row) => row.user_id)]);
  const actor = database.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId);
  for (const userId of recipients) {
    if (Number(userId) === Number(actorId)) continue;
    enqueueNotification(database, {
      userId, sourceKey: eventId ? `obligation-event:${eventId}` : `task:${taskId}:claimed`, category: taskCategory(database, taskId), entityType: 'task', entityId: taskId,
      title: 'Task claimed', body: `${actor?.display_name || 'A household member'} claimed ${task.title}`,
    });
  }
}

export function notifyClaimableTask(database, taskId, eligibleIds) {
  const task = database.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  for (const userId of new Set(eligibleIds.map(Number))) enqueueNotification(database, {
    userId, sourceKey: `task:${taskId}:claimable`, category: taskCategory(database, taskId),
    entityType: 'task', entityId: taskId, title: 'A task is available to claim', body: task.title,
  });
}

export function notifyMealRequests(database, mealId) {
  const meal = database.prepare('SELECT title, date FROM meals WHERE id = ?').get(mealId);
  if (!meal) return;
  const obligations = database.prepare(`SELECT id, responsible_user_id FROM planning_obligations
    WHERE entity_type = 'meal' AND entity_id = ? AND role = 'chooser'
      AND status = 'pending' AND responsible_user_id IS NOT NULL`).all(mealId);
  for (const obligation of obligations) enqueueNotification(database, {
    userId: obligation.responsible_user_id, sourceKey: `obligation:${obligation.id}:assigned`, category: 'meals',
    entityType: 'meal', entityId: mealId, title: 'Meal choice requested', body: `${meal.title} · ${meal.date}`,
  });
}

export function notifyPlanningContext(database, contextId) {
  const context = database.prepare('SELECT name, revision FROM planning_contexts WHERE id = ?').get(contextId);
  if (!context) return;
  const recipients = database.prepare(`SELECT user_id FROM planning_context_members
    WHERE planning_context_id = ? AND membership_status IN ('active','conflict')`).all(contextId);
  for (const { user_id: userId } of recipients) enqueueNotification(database, {
    userId, sourceKey: `planning-context:${contextId}:revision:${context.revision}`, category: 'calendar',
    entityType: 'planning_context', entityId: contextId, title: 'Your plans changed', body: context.name,
  });
}

export function notifyPlanningConflict(database, conflict) {
  const first = database.prepare('SELECT name, revision FROM planning_contexts WHERE id = ?').get(conflict.first_context_id);
  const second = database.prepare('SELECT name, revision FROM planning_contexts WHERE id = ?').get(conflict.second_context_id);
  if (!first || !second) return;
  enqueueNotification(database, {
    userId: conflict.user_id, sourceKey: `planning-conflict:${conflict.id}:${first.revision}:${second.revision}`,
    category: 'calendar', entityType: 'planning_context', entityId: conflict.first_context_id,
    title: 'Planning dates overlap', body: `${first.name} overlaps ${second.name}. Review your plans.`,
  });
}

export function notifyGroceryPublished(database, runId) {
  const run = database.prepare(`SELECT r.*, l.name AS list_name FROM meal_grocery_runs r
    JOIN shopping_lists l ON l.id = r.shopping_list_id WHERE r.id = ?`).get(runId);
  if (!run?.added_to_shopping_at) return;
  for (const { id: userId } of database.prepare('SELECT id FROM users').all()) enqueueNotification(database, {
    userId, sourceKey: `grocery-run:${run.id}:published`, category: 'shopping', entityType: 'grocery_run', entityId: run.id,
    title: 'Groceries are ready to shop', body: `${run.list_name} · ${run.start_date} to ${run.end_date}`,
  });
}
