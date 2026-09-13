/** Operational children only: support projections have their own source state. */
export function actionableSubtasks(task) {
  return (task?.subtasks || []).filter((child) => !child.archived_at
    && (!child.is_supervision_projection || task.is_supervision_projection) && !child.is_support_task);
}
