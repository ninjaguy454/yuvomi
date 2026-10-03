/** Canonical assignment relations and child-to-parent participation. */
export function setTaskAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);

  const task = d.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(taskId);
  if (!task?.parent_task_id) return;
  d.prepare("DELETE FROM task_responsibilities WHERE task_id = ? AND role = 'subtask_assignee'").run(taskId);
  const responsibility = d.prepare(`
    INSERT OR IGNORE INTO task_responsibilities (task_id, user_id, role, source)
    VALUES (?, ?, ?, ?)
  `);
  for (const uid of userIds) responsibility.run(taskId, uid, 'subtask_assignee', 'subtask');

  const previous = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id = ? AND role = 'participant' AND source = 'subtasks'")
    .all(task.parent_task_id).map((row) => Number(row.user_id));
  d.prepare("DELETE FROM task_responsibilities WHERE task_id = ? AND role = 'participant' AND source = 'subtasks'")
    .run(task.parent_task_id);
  const current = d.prepare(`
    SELECT DISTINCT ta.user_id
      FROM tasks child
      JOIN task_assignments ta ON ta.task_id = child.id
     WHERE child.parent_task_id = ? AND child.archived_at IS NULL
  `).all(task.parent_task_id).map((row) => Number(row.user_id));
  for (const uid of current) {
    responsibility.run(task.parent_task_id, uid, 'participant', 'subtasks');
    ins.run(task.parent_task_id, uid);
  }
  for (const uid of previous.filter((id) => !current.includes(id))) {
    const otherRole = d.prepare("SELECT 1 FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND status = 'active'")
      .get(task.parent_task_id, uid);
    if (!otherRole) d.prepare('DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?').run(task.parent_task_id, uid);
  }
}

