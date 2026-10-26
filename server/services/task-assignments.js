import {readTaskAssigneePolicy} from './task-assignee-policy.js';
/** Canonical assignment relations and child-to-parent participation. */
export function setTaskAssignments(d, taskId, userIds, {deferParentReconciliation=false}={}) {
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

  if(deferParentReconciliation)return;
  reconcileParentSubtaskAssignments(d,task.parent_task_id);
}

function reconcileParentSubtaskAssignments(d,parentTaskId){
  const previous = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id = ? AND role = 'participant' AND source = 'subtasks'")
    .all(parentTaskId).map((row) => Number(row.user_id));
  d.prepare("DELETE FROM task_responsibilities WHERE task_id = ? AND role = 'participant' AND source = 'subtasks'")
    .run(parentTaskId);
  const current = d.prepare(`
    SELECT DISTINCT ta.user_id
      FROM tasks child
      JOIN task_assignments ta ON ta.task_id = child.id
     WHERE child.parent_task_id = ? AND child.archived_at IS NULL
  `).all(parentTaskId).map((row) => Number(row.user_id));
  const responsibility=d.prepare(`INSERT OR IGNORE INTO task_responsibilities (task_id,user_id,role,source)
    VALUES (?,?,?,?)`);
  const ins=d.prepare('INSERT OR IGNORE INTO task_assignments (task_id,user_id) VALUES (?,?)');
  for (const uid of current) {
    responsibility.run(parentTaskId, uid, 'participant', 'subtasks');
    ins.run(parentTaskId, uid);
  }
  for (const uid of previous.filter((id) => !current.includes(id))) {
    const otherRole = d.prepare("SELECT 1 FROM task_responsibilities WHERE task_id = ? AND user_id = ? AND status = 'active'")
      .get(parentTaskId, uid);
    if (!otherRole&&!readTaskAssigneePolicy(d,parentTaskId)?.direct_assignee_ids.includes(uid)) d.prepare('DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?').run(parentTaskId, uid);
  }
}

/** Apply one occurrence's child decisions, then project its actual workers once. */
export function setTaskAssignmentsBatch(d,changes){
  if(!Array.isArray(changes))throw new TypeError('Choose subtask assignment changes.');
  return d.transaction(()=>{
    const parents=new Set(),seen=new Set();
    for(const {taskId,userIds} of changes){
      if(seen.has(taskId))throw new Error('Each subtask can change once per batch.');
      seen.add(taskId);
      const parent=d.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(taskId)?.parent_task_id;
      if(!parent)throw new Error('Choose a subtask belonging to an Activity.');
      setTaskAssignments(d,taskId,userIds,{deferParentReconciliation:true});
      parents.add(parent);
    }
    for(const parent of parents)reconcileParentSubtaskAssignments(d,parent);
  })();
}

