/** Count direct performers; existing visibility participants remain independent. */
export function taskDirectAssigneeIds(task){return Array.isArray(task?.direct_assignee_ids)?[...task.direct_assignee_ids]:task?.assigned_users?.map(member=>Number(member.id))
  ??(Array.isArray(task?.assigned_to)?task.assigned_to.map(Number):task?.assigned_to?[Number(task.assigned_to)]:[]);}
const same=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
export function taskDraftAssigneePolicy(task,category,categories,ids){
  if(task&&task.category===category&&same(taskDirectAssigneeIds(task),ids))return task.assignee_policy??null;
  return {version:1,category_key:category,max_assignees:categories.find(row=>row.key===category)?.max_assignees??null};
}
export function assigneeCountError(policy,ids){return policy?.max_assignees!=null&&new Set(ids).size>policy.max_assignees?policy.max_assignees:null;}
export function assigneePolicyLabel(policy,t){return policy?.max_assignees==null?t('tasks.assigneeNoLimit'):t('tasks.categoryAssigneeLimit')+': '+policy.max_assignees;}
export function wireTaskAssigneePolicy(form,{task,categories,getIds,managed=()=>false,rotating=()=>false,rebasing=()=>false,t}){
  const category=form.querySelector('[name=category]'),hint=form.querySelector('[data-task-assignee-limit]');
  const original=()=>typeof task==='function'?task():task;
  const current=()=>taskDraftAssigneePolicy(original(),category?.value,categories,getIds());
  const validate=()=>{if(managed()||rotating())return null;const count=assigneeCountError(current(),getIds());return count===null?null:t('tasks.assigneeLimitExceeded',{count});};
  const update=()=>{if(!category||rebasing())return;category.setCustomValidity(validate()||'');if(hint)hint.textContent=original()&&!current()&&categories.find(row=>row.key===category.value)?.max_assignees!=null?t('tasks.assigneeExisting'):assigneePolicyLabel(current(),t);};
  form.addEventListener('change',update);form.addEventListener('input',update);update();return {validate,update};
}
