import { householdTimeZone, shiftDateKey } from '../utils/timezone.js';
import { availabilityInstantMs } from './presence.js';

export const EXPIRATION_POLICIES = ['keep_overdue', 'expire_incomplete'];

/** Reuse Availability's DST policy: gaps move forward, overlaps choose the first instant. */
export function taskDeadlineMs(d, task) {
  if (!task?.due_date) return null;
  const local = task.due_time ? `${task.due_date}T${task.due_time}` : `${shiftDateKey(task.due_date, 1)}T00:00`;
  return availabilityInstantMs(local, householdTimeZone(d));
}
export function taskStartMs(d, task, timeZone = householdTimeZone(d)) {
  return task?.start_date ? availabilityInstantMs(`${task.start_date}T${task.start_time || '00:00'}`, timeZone) : null;
}
export function taskExpirationDue(d, task, now = new Date()) {
  const deadline = taskDeadlineMs(d, task);
  return task?.expiration_policy === 'expire_incomplete' && !task.archived_at
    && ['open','in_progress'].includes(task.status) && deadline != null && Number(now) >= deadline;
}
/** Include structural ancestors and authoritative sources of helper projections. */
export function taskWindowAncestors(d, taskId) {
  return d.prepare(`WITH RECURSIVE roots(id) AS (
      SELECT ? UNION SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?
      UNION SELECT source_task_id FROM task_supervision_actions WHERE counterpart_task_id=? OR action_task_id=?
    ), ancestry(id) AS (SELECT id FROM roots UNION SELECT t.parent_task_id FROM tasks t JOIN ancestry a ON t.id=a.id
      WHERE t.parent_task_id IS NOT NULL)
    SELECT t.* FROM tasks t JOIN ancestry a ON a.id=t.id`).all(taskId,taskId,taskId,taskId);
}
