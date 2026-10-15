import {readTaskAssigneePolicy} from './task-assignee-policy.js';
/** Canonical assignment relations and child-to-parent participation. */
export function setTaskAssignments(d, taskId, userIds) {
  if(readTaskAssigneePolicy(d,taskId)){
    const children=d.prepare(`SELECT DISTINCT p.user_id FROM task_responsibilities p WHERE p.task_id=? AND p.role='participant' AND p.source='subtasks' AND p.status='active'
      AND EXISTS(SELECT 1 FROM tasks c JOIN task_assignments a ON a.task_id=c.id WHERE c.parent_task_id=p.task_id AND c.archived_at IS NULL AND a.user_id=p.user_id)`).all(taskId).map(row=>row.user_id);
    userIds=[...new Set([...userIds,...children])];
  }
  // Trip step owners participate in the ordinary parent even when its
  // coordinator or direct assignees are edited separately.
  if (d.prepare("SELECT 1 FROM sqlite_master WHERE name='trip_task_groups' AND type='table'").get()
      && d.prepare('SELECT 1 FROM trip_task_groups WHERE parent_task_id=?').get(taskId)) {
    const childOwners = d.prepare(`SELECT DISTINCT ta.user_id FROM tasks child
      JOIN task_assignments ta ON ta.task_id=child.id
      WHERE child.parent_task_id=? AND child.archived_at IS NULL`).all(taskId).map(row=>row.user_id);
    userIds = [...new Set([...userIds,...childOwners])];
  }
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
    if (!otherRole&&!readTaskAssigneePolicy(d,task.parent_task_id)?.direct_assignee_ids.includes(uid)) d.prepare('DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?').run(task.parent_task_id, uid);
  }
}

