/** Authored extra people are policy, independent of the resolved Owner or pool. */
export function additionalAssigneeIds(row){
  return row?.additional_assignee_ids ?? (row?.additional_assignee_ids_json ? JSON.parse(row.additional_assignee_ids_json) : []);
}
export function normalizeAdditionalAssignees(d,value,previous=[]){
  if(value===undefined)return [...previous];
  if(!Array.isArray(value)||value.length>50||value.some(id=>!Number.isSafeInteger(id)||id<1)){
    const error=new Error('Choose valid additional household assignees.');error.status=400;throw error;
  }
  const ids=[...new Set(value)];
  if(ids.some(id=>!d.prepare(`SELECT 1 FROM users u WHERE u.id=?
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)`).get(id))){
    const error=new Error('Choose available household people as additional assignees.');error.status=400;throw error;
  }
  return ids;
}
export function ownerAndAdditionalAssignees(owner,extras=[]){
  return [...new Set([...(owner?[Number(owner)]:[]),...extras])];
}
export function persistAdditionalAssignees(d,taskId,ids){
  const encoded=JSON.stringify(ids),saved=d.prepare('SELECT additional_assignee_ids_json FROM tasks WHERE id=?').get(taskId);
  if(saved?.additional_assignee_ids_json!==encoded)d.prepare('UPDATE tasks SET additional_assignee_ids_json=? WHERE id=?').run(encoded,taskId);
}
