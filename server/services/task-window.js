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
    && ['open','in_progress'].includes(task.status) && deadline != null && Number(now) >= deadline
    && !taskWindowAncestors(d,task.id).some(row=>row.status==='skipped');
}
/** Include structural ancestors and authoritative sources of helper projections. */
export function taskWindowAncestors(d, taskId) {
  return d.prepare(`${ancestrySql(d,'?')}
    SELECT t.* FROM tasks t JOIN ancestry a ON a.id=t.id`).all(taskId);
}

// Follow source edges at every level, including children of a retained helper.
// UNION deduplicates cycles. Small legacy reader fixtures may lack helper tables.
function ancestrySql(d, seed) {
  const exists=name=>!!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return `WITH RECURSIVE ancestry(id) AS (SELECT ${seed}
    UNION SELECT t.parent_task_id FROM tasks t JOIN ancestry a ON t.id=a.id WHERE t.parent_task_id IS NOT NULL
    ${exists('task_activity_support_tasks')?'UNION SELECT s.source_task_id FROM task_activity_support_tasks s JOIN ancestry a ON s.task_id=a.id':''}
    ${exists('task_supervision_actions')?'UNION SELECT s.source_task_id FROM task_supervision_actions s JOIN ancestry a ON s.counterpart_task_id=a.id OR s.action_task_id=a.id':''})`;
}

/** Active projections must also respect the outcome of their canonical source. */
export function taskUnskippedWhere(d, alias='t') {
  if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))throw new TypeError('Invalid Task SQL alias.');
  return `NOT EXISTS (${ancestrySql(d,`${alias}.id`)} SELECT 1 FROM tasks source JOIN ancestry a ON source.id=a.id WHERE source.status='skipped')`;
}
