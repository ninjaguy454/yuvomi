/** Direct performers are distinct from the legacy parent visibility union. */
export class TaskAssigneePolicyError extends Error {
  constructor(message,reason='invalid_assignee_policy',details={}){super(message);this.name='TaskAssigneePolicyError';this.status=400;this.reason=reason;this.details={reason,...details};}
}
export function parseCategoryAssigneeLimit(value){
  if(value===null)return null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new TaskAssigneePolicyError('Choose a positive whole-number assignee limit, or no limit.');
  return value;
}
export function assigneePolicySchemaAvailable(d){return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_assignee_policies'").get();}
export function categoryAssigneePolicy(d,key){
  const category_key=key||'misc';
  const max_assignees=assigneePolicySchemaAvailable(d)?d.prepare('SELECT max_assignees FROM task_categories WHERE key=?').get(category_key)?.max_assignees??null:null;
  return {version:1,category_key,max_assignees};
}
export function assertAssigneeCount(policy,directIds){
  if(!policy||policy.version!==1||typeof policy.category_key!=='string')throw new TaskAssigneePolicyError('Invalid captured assignee policy.');
  const max=parseCategoryAssigneeLimit(policy.max_assignees);
  if(!Array.isArray(directIds)||directIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(directIds).size!==directIds.length)
    throw new TaskAssigneePolicyError('Choose distinct valid direct assignees.');
  if(max!==null&&directIds.length>max)throw new TaskAssigneePolicyError(`This category permits at most ${max} direct assignee${max===1?'':'s'}; ${directIds.length} selected.`,'category_assignee_limit',{category_key:policy.category_key,max_assignees:max,selected_count:directIds.length});
}
export function readTaskAssigneePolicy(d,taskId){
  if(!assigneePolicySchemaAvailable(d))return null;
  const row=d.prepare('SELECT * FROM task_assignee_policies WHERE task_id=?').get(taskId);if(!row)return null;
  return {version:row.policy_version,category_key:row.category_key,max_assignees:row.max_assignees,direct_assignee_ids:d.prepare('SELECT user_id FROM task_direct_assignees WHERE task_id=? ORDER BY user_id').all(taskId).map(row=>row.user_id)};
}
export function persistTaskAssigneePolicy(d,taskId,policy,directIds){
  if(!assigneePolicySchemaAvailable(d))return;
  assertAssigneeCount(policy,directIds);
  if(directIds.some(id=>!d.prepare('SELECT 1 FROM users WHERE id=?').get(id)))throw new TaskAssigneePolicyError('Choose valid household members.');
  d.prepare(`INSERT INTO task_assignee_policies(task_id,policy_version,category_key,max_assignees) VALUES(?,1,?,?)
    ON CONFLICT(task_id) DO UPDATE SET policy_version=1,category_key=excluded.category_key,max_assignees=excluded.max_assignees`).run(taskId,policy.category_key,policy.max_assignees);
  d.prepare('DELETE FROM task_direct_assignees WHERE task_id=?').run(taskId);
  const insert=d.prepare('INSERT INTO task_direct_assignees(task_id,user_id) VALUES(?,?)');for(const id of directIds)insert.run(taskId,id);
}
