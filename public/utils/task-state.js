import { api } from '/api.js';
import { confirmOverModal } from '/components/modal.js';

import { actionableSubtasks } from '/utils/task-progress.js';
export { actionableSubtasks } from '/utils/task-progress.js';

export function taskRevision(task) {
  return {
    ...(Number.isInteger(task?.revision) ? { expected_revision: task.revision } : {}),
    ...(Number.isInteger(task?.parent_revision) ? { expected_parent_revision: task.parent_revision } : {}),
  };
}

/** Confirmation decisions are derived from saved state, never a second progress field. */
export function taskStatusConfirmation(task, status) {
  const children = actionableSubtasks(task);
  if (status === 'done' && children.some((child) => child.status !== 'done')) {
    return { flag: 'complete_remaining', message: 'Complete this Task and its remaining subtasks?',
      detail: 'The remaining subtasks will also be marked complete. Required supervision still applies.',
      confirmLabel: 'Complete Task' };
  }
  if (status === 'open' && (task.status === 'done' || children.some((child) => child.status === 'done'))) {
    return { flag: 'reset_progress', message: 'Resetting this Task will clear its subtask progress.',
      detail: 'Completion history is retained. Cancel keeps the current progress.', confirmLabel: 'Reset Task', danger: true };
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
