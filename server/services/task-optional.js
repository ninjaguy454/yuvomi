/** Optionality belongs to the action branch, including linked helper views. */
export function taskOptionalContext(d, taskId) {
  const mapping=d.prepare('SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?').get(taskId);
  const originalId=mapping?.action_task_id||Number(taskId);
  return optionalAncestry(originalId,id=>d.prepare('SELECT * FROM tasks WHERE id=?').get(id));
}

/** Reuse authoritative ordinary rows during one synchronous, read-only
 * inspection only. Callers discard this reader before any mutation; lifecycle
 * guards continue to use the uncached taskOptionalContext above. */
export function createTaskOptionalContextReader(d, ordinaryRows) {
  const rows=new Map(ordinaryRows.map(row=>[Number(row.id),row]));
  const originalIds=new Set(rows.keys()),results=new Map();
  const rowFor=id=>{
    if(!rows.has(id))rows.set(id,d.prepare('SELECT * FROM tasks WHERE id=?').get(id));
    return rows.get(id);
  };
  return taskId=>{
    const id=Number(taskId);
    if(!results.has(id)){
      const originalId=originalIds.has(id)?id:
        d.prepare('SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?').get(id)?.action_task_id||id;
      results.set(id,optionalAncestry(originalId,rowFor));
    }
    return results.get(id);
  };
}

function optionalAncestry(originalId, rowFor) {
  let row=rowFor(originalId);
  let optional=false,closedParent=null;
  const seen=new Set();
  while(row&&!seen.has(row.id)) {
    seen.add(row.id);
    optional ||= Boolean(row.parent_task_id&&row.is_optional);
    if(row.id!==originalId&&optional&&row.status==='done')closedParent??=row;
    row=row.parent_task_id?rowFor(row.parent_task_id):null;
  }
  return {is_optional:optional,closed_parent:closedParent};
}
