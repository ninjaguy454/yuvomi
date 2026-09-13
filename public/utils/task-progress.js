/** Original definitions remain editable even when the helper owns an action. */
export function structuralSubtasks(task) {
  return (task?.subtasks || []).filter((child) => !child.archived_at
    && (!child.is_supervision_projection || task.is_supervision_projection) && !child.is_support_task);
}

/** Each projection counts only the actions its assignee is responsible for. */
export function actionableSubtasks(task) {
  return structuralSubtasks(task).filter((child) => {
    const action = child.supervision_action || task?.supervision?.actions?.find((entry) => Number(entry.action_task_id) === Number(child.id));
    return child.is_supervision_projection || action?.execution_mode !== 'delegated' || action.state === 'not_required';
  });
}

export function helperWaitingLabel(task, userId) {
  if (!task?.waiting_on_helper) return '';
  const learnerId = task.assigned_to ?? task.supervision?.learner_user_id;
  return Number(userId) === Number(learnerId) && learnerId != null
    ? 'Your steps complete · waiting on supervisor'
    : 'Learner steps complete · waiting on supervisor';
}
