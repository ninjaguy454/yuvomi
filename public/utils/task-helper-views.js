/** Display-only bounty views. IDs, child capabilities and canonical state stay intact. */
const ids = values => [...new Set((values || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
export function explicitTaskAssigneeIds(task) {
  // Paired displays inherit parent participants for operational authorization.
  // An explicit empty array distinguishes that from an actual child allocation.
  return Array.isArray(task?.explicit_assignee_ids) ? ids(task.explicit_assignee_ids)
    : ids([...(task?.assigned_users || []).map(user => user.id), task?.assigned_to]);
}
const children = task => (task.subtasks || []).filter(child => !child.archived_at && !child.is_supervision_projection && !child.is_support_task);
const accepted = task => task?.is_accepted_bounty === true && !task.parent_task_id && !task.is_supervision_projection
  && !task.is_support_task && Number(task.assigned_to) > 0 && Array.isArray(task.direct_assignee_ids);

export function bountyHelperView(task, userId, users = []) {
  userId = Number(userId);
  if (!accepted(task) || !userId || userId === Number(task.assigned_to)) return null;
  const scope = children(task);
  if (!ids([...(task.direct_assignee_ids || []), ...scope.flatMap(explicitTaskAssigneeIds)]).includes(userId)) return null;
  const subtasks = scope.filter(child => { const assigned = explicitTaskAssigneeIds(child); return !assigned.length || assigned.includes(userId); });
  if (!subtasks.length) return null;
  const people = [...(task.assigned_users || []), ...scope.flatMap(child => child.assigned_users || []), ...users];
  const person = people.find(user => Number(user.id) === userId) || { id: userId, display_name: '' };
  const view = { ...task, helper_view_user_id: userId, assigned_to: userId, assigned_name: person.display_name,
    assigned_users: [{ ...person, id: userId }], activity_responsibilities: [], subtasks,
    permissions: { ...task.permissions, complete: false, reopen: false, reset: false, claim: false, accept: false, close_incomplete:false },
    can_close_incomplete:false,can_reopen_incomplete:false,
    // A display container has no reward of its own. Child scoring stays canonical.
    scoring: null, waiting_on_helper: false,
    subtask_total: subtasks.filter(child => !child.is_optional).length,
    subtask_done: subtasks.filter(child => !child.is_optional && child.status === 'done').length };
  // Root scheduled aggregates cannot be attributed to one helper from this read.
  for (const key of Object.keys(view)) if (key.startsWith('scheduled_')) delete view[key];
  return view;
}

/** Null preserves the existing grouping contract for every other Task type. */
export function bountyAssigneeViews(task, users = []) {
  if (!accepted(task)) return null;
  const scope = children(task), primary = Number(task.assigned_to);
  const people = [...(task.assigned_users || []), ...scope.flatMap(child => child.assigned_users || []), ...users];
  const person = id => people.find(user => Number(user.id) === id) || { id, display_name: id === primary ? task.assigned_name || '' : '' };
  return ids([primary, ...(task.direct_assignee_ids || []), ...scope.flatMap(explicitTaskAssigneeIds)])
    .map(id => ({ user: person(id), task: id === primary ? task : bountyHelperView(task, id, users) })).filter(entry => entry.task);
}

export function taskCardViewKey(task) {
  return task?.helper_view_user_id ? `helper-${task.id}-${task.helper_view_user_id}` : String(task?.id);
}
