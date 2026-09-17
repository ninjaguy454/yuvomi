/** Optionality belongs to the action branch, including linked helper views. */
export function taskOptionalContext(d, taskId) {
  const mapping=d.prepare('SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?').get(taskId);
  const originalId=mapping?.action_task_id||Number(taskId);
  let row=d.prepare('SELECT * FROM tasks WHERE id=?').get(originalId);
  let optional=false,closedParent=null;
  const seen=new Set();
  while(row&&!seen.has(row.id)) {
    seen.add(row.id);
    optional ||= Boolean(row.parent_task_id&&row.is_optional);
    if(row.id!==originalId&&optional&&row.status==='done')closedParent??=row;
    row=row.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(row.parent_task_id):null;
  }
  return {is_optional:optional,closed_parent:closedParent};
}
