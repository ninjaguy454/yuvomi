import { taskDirectAssigneeIds } from './task-assignee-policy.js';

const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

/** Read the recorded primary; never invent one for an old multi-person Task. */
export function ownerFromSavedTask(task) {
  const direct = taskDirectAssigneeIds(task).map(id).filter(Boolean);
  const primary = id(Array.isArray(task?.assigned_to) ? null : task?.assigned_to);
  if (primary && direct.includes(primary)) return primary;
  return direct.length === 1 ? direct[0] : null;
}

/** Keep co-assignees, but place the explicitly chosen Owner first for current APIs. */
export function orderedOwnerAssignees(owner, selected) {
  const ids = [...new Set((selected || []).map(id).filter(Boolean))];
  if (!ids.length) return [];
  const primary = id(owner) || (ids.length === 1 ? ids[0] : null);
  return primary && ids.includes(primary) ? [primary, ...ids.filter(person => person !== primary)] : null;
}
