/** Read-only provenance and explicit assignment metadata for display-only helper views. */
export function attachTaskHelperViewMetadata(d, tasks) {
  const ids = [...new Set((tasks || []).map(task => Number(task.id)).filter(Number.isSafeInteger))];
  if (!ids.length) return tasks;
  const placeholders = ids.map(() => '?').join(',');
  const assignments = new Map(ids.map(id => [id, new Set()]));
  for (const row of d.prepare(`SELECT task_id,user_id FROM task_assignments WHERE task_id IN (${placeholders})`).all(...ids)) {
    assignments.get(row.task_id)?.add(row.user_id);
  }
  const accepted = new Set(d.prepare(`SELECT DISTINCT task_id FROM task_acceptance_receipts WHERE task_id IN (${placeholders})`).all(...ids).map(row => row.task_id));
  for (const task of tasks) {
    if (task.assigned_to) assignments.get(Number(task.id)).add(Number(task.assigned_to));
    task.explicit_assignee_ids = [...assignments.get(Number(task.id))].sort((a, b) => a - b);
    task.is_accepted_bounty = !task.parent_task_id && !task.is_supervision_projection && !task.is_support_task && accepted.has(Number(task.id));
  }
  return tasks;
}
