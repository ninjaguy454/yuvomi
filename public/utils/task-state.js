import { api } from '/api.js';
import { confirmOverModal } from '/components/modal.js';

import { actionableSubtasks, structuralSubtasks } from '/utils/task-progress.js';
export { actionableSubtasks } from '/utils/task-progress.js';

export function taskRevision(task) {
  return {
    ...(Number.isInteger(task?.revision) ? { expected_revision: task.revision } : {}),
    ...(Number.isInteger(task?.parent_revision) ? { expected_parent_revision: task.parent_revision } : {}),
  };
}

/** Confirmation decisions are derived from saved state, never a second progress field. */
export function taskStatusConfirmation(task, status) {
  const structural = structuralSubtasks(task);
  const supervisionOf = (child) => child.supervision_action
    || task.supervision?.actions?.find((action) => Number(action.action_task_id) === Number(child.id));
  const delegated = structural.filter((child) => {
    const action = supervisionOf(child);
    return action?.execution_mode === 'delegated' && action.state !== 'not_required';
  });
  const pendingDelegated = delegated.filter((child) => child.status !== 'done');
  // Progress belongs to the learner projection. A permitted helper's parent
  // completion can affect the original structure, so its confirmation must
  // explicitly include those direct responsibilities as well.
  const completesHelperWork = pendingDelegated.length > 0
    && pendingDelegated.every((child) => supervisionOf(child)?.can_complete === true && child.permissions?.complete !== false);
  const children = completesHelperWork ? structural : actionableSubtasks(task);
  if (status === 'done' && children.some((child) => child.status !== 'done')) {
    return { flag: 'complete_remaining', message: 'Complete this Task and its remaining subtasks?',
      detail: completesHelperWork
        ? 'Remaining subtasks, including direct helper responsibilities, will also be marked complete. Required supervision still applies.'
        : 'The remaining subtasks will also be marked complete. Required supervision still applies.',
      confirmLabel: 'Complete Task' };
  }
  if (status === 'open' && (task.status === 'done' || structural.some((child) => child.status === 'done'))) {
    return { flag: 'reset_progress', message: 'Resetting this Task will clear its subtask progress.',
      detail: `${delegated.some((child) => child.status === 'done') ? 'Completed helper actions will also be reset. ' : ''}Completion history is retained. Cancel keeps the current progress.`,
      confirmLabel: 'Reset Task', danger: true };
  }
  return null;
}

export async function changeTaskStatus(task, status, { confirm: requestConfirmation = confirmOverModal } = {}) {
  const confirmation = taskStatusConfirmation(task, status);
  const body = { status, ...taskRevision(task) };
  if (confirmation) {
    if (!await requestConfirmation(confirmation.message, { ...confirmation, closeOnConfirm: false })) return null;
    body[confirmation.flag] = true;
  }
  return api.patch(`/tasks/${task.id}/status`, body);
}
