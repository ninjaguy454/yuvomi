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
const samePeople=(a,b)=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((id,i)=>id===[...b].sort((x,y)=>x-y)[i]);
/** Old clients may echo the visibility union; only a direct marker promotes it. */
export function taskDirectAssignmentSelection(d,task,body){
  const visible=task?d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(row=>row.user_id):[];
  const saved=task?readTaskAssigneePolicy(d,task.id):null,previous=saved?.direct_assignee_ids??visible;
  const explicit=Object.hasOwn(body,'direct_assignee_ids'),value=explicit?body.direct_assignee_ids:body.assigned_to;
  const selected=value===undefined?previous:[...new Set((Array.isArray(value)?value:value==null||value===''?[]:[value]).map(Number))];
  if(task&&!explicit&&(body.assignment_mode??task.assignment_mode)==='round_robin'&&Array.isArray(value)&&!value.length)return {previous,selected:previous};
  return {previous,selected:saved&&!explicit&&samePeople(selected,visible)?previous:selected};
}
/** An unchanged full legacy editor payload is not an adoption/conversion. */
export function proposedTaskAssigneePolicy(d,task,body,{category=body.category??task?.category??'misc',directIds=null}={}){
  const saved=task?readTaskAssigneePolicy(d,task.id):null;
  const visible=task?d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(task.id).map(row=>row.user_id):[];
  const explicit=Object.hasOwn(body,'direct_assignee_ids');
  if(explicit&&(!Array.isArray(body.assigned_to)||!Array.isArray(body.direct_assignee_ids)||!samePeople(body.assigned_to,body.direct_assignee_ids)))
    throw new TaskAssigneePolicyError('Direct assignees must match the explicit assignment selection.');
  const rotationChanged=!!task&&(['assignment_mode','rotation_group','rotation_slot'].some(key=>body[key]!==undefined&&String(body[key]??'')!==String(task[key]??''))
    ||body.rotation_user_ids!==undefined&&JSON.stringify(body.rotation_user_ids)!==JSON.stringify(d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order').all(task.id).map(row=>row.user_id)));
  const selection=taskDirectAssignmentSelection(d,task,body);
  const ids=!task?directIds??selection.selected:rotationChanged&&(body.assignment_mode??task.assignment_mode)==='round_robin'&&directIds!==null?directIds:selection.selected;
  const changedCategory=!!task&&category!==task.category;
  const changedPeople=(explicit||body.assigned_to!==undefined||rotationChanged)&&!samePeople(ids,selection.previous);
  if(task&&!changedCategory&&!changedPeople)return null;
  if(task&&!saved&&changedCategory&&body.assigned_to===undefined)
    throw new TaskAssigneePolicyError('Choose the direct assignees explicitly before applying a category rule.','direct_assignees_required');
  const policy=categoryAssigneePolicy(d,category);assertAssigneeCount(policy,ids);return {...policy,direct_assignee_ids:ids};
}
export function persistNewTaskAssignees(d,taskId,directIds,policy=undefined){
  const row=d.prepare('SELECT category FROM tasks WHERE id=?').get(taskId);
  if(policy===null)return;
  persistTaskAssigneePolicy(d,taskId,policy??categoryAssigneePolicy(d,row.category),directIds);
}
export function assigneePolicyProjection(d,taskId){const saved=readTaskAssigneePolicy(d,taskId);if(!saved)return {assignee_policy:null,direct_assignee_ids:null};const {direct_assignee_ids,...policy}=saved;return {assignee_policy:policy,direct_assignee_ids};}
export function assertActivityAssigneePolicy(policy,activity,resolution){
  if(!policy)return;
  const ids=[...new Set((resolution.participants?.length?resolution.participants:resolution.primary?[resolution.primary]:[]).map(member=>Number(member.id)))];
  const requested=(resolution.strategy??activity.assignment_policy??activity.assignment_strategy)==='rotating_multi'?Number(activity.participant_count)||1:ids.length;
  if(policy.max_assignees!==null&&requested>policy.max_assignees)throw new TaskAssigneePolicyError(`This category permits at most ${policy.max_assignees} direct assignees; ${requested} requested.`,'category_assignee_limit',{category_key:policy.category_key,max_assignees:policy.max_assignees,selected_count:requested});
  assertAssigneeCount(policy,ids);
}
const bindingAssignmentConfiguration=binding=>binding?{
  ...Object.fromEntries(['activity_template_id','subject_user_id','assignment_override_user_id'].map(key=>[key,binding[key]??null])),
  ...Object.fromEntries(['assignment_policy','assignment_strategy','fixed_user_id','fixed_assignee_ids','participant_count','rotation_group'].map(key=>[key,binding.snapshot?.[key]??null]))
}:null;
function changedRootAssignmentConfiguration(before,after){
  return JSON.stringify(bindingAssignmentConfiguration(before.binding))!==JSON.stringify(bindingAssignmentConfiguration(after.binding))
    ||['assignment_mode','rotation_group','rotation_slot'].some(key=>(before.task[key]??(key==='rotation_slot'?0:key==='assignment_mode'?'fixed':null))!==(after.task[key]??(key==='rotation_slot'?0:key==='assignment_mode'?'fixed':null)))
    ||JSON.stringify(before.rotation_user_ids??[])!==JSON.stringify(after.rotation_user_ids??[]);
}
/** Pure validation/enrollment for an explicitly authored future definition. */
export function proposeDefinitionAssigneePolicies(d,before,after,{assignmentIntent=null,resolveRootDirectIds=null}={}){
  const oldActions=new Map(before?.subtasks?.map(action=>[action.action_key,action])||[]);
  for(const [old,row] of [[before,after],...after.subtasks.map(row=>[oldActions.get(row.action_key),row])]){
    const ids=row.assigned_user_ids||[],category=row.task.category||'misc';
    const fields=row===after?assignmentIntent?.fields??{}:(assignmentIntent?.actions?.update??[]).find(action=>action.action_key===row.action_key)?.fields??{};
    const assignmentField=row===after?'assigned_to':'assigned_user_ids',explicit=Object.hasOwn(fields,assignmentField),selected=explicit?fields[assignmentField]:ids;
    const previous=old?.assignee_policy?.direct_assignee_ids??old?.assigned_user_ids??[];
    const configurationChanged=row===after&&old&&changedRootAssignmentConfiguration(old,row);
    // A captured shared Activity may acquire child owners in its visibility
    // union while its authored direct roster and binding remain unchanged.
    const sharedDirect=row===after&&row.binding?.snapshot?.fixed_assignee_ids&&old?.binding?.snapshot?.fixed_assignee_ids
      ?row.assignee_policy?.direct_assignee_ids:null;
    if(old&&!configurationChanged&&old.task.category===category&&(explicit?samePeople(previous,selected):sharedDirect?samePeople(previous,sharedDirect):samePeople(old.assigned_user_ids||[],ids))){
      if(old.assignee_policy)row.assignee_policy=structuredClone(old.assignee_policy);else delete row.assignee_policy;
      if(row===after&&row.binding?.snapshot){
        if(old.binding?.snapshot?.assignee_policy)row.binding.snapshot.assignee_policy=structuredClone(old.binding.snapshot.assignee_policy);
        else delete row.binding.snapshot.assignee_policy;
      }
      continue;
    }
    const direct=explicit?selected:configurationChanged&&resolveRootDirectIds?resolveRootDirectIds():old?.assignee_policy&&samePeople(old.assigned_user_ids||[],ids)?previous:ids;
    const policy=categoryAssigneePolicy(d,category);assertAssigneeCount(policy,direct);row.assignee_policy={...policy,direct_assignee_ids:[...direct]};
    if(row===after&&after.binding?.snapshot)after.binding.snapshot.assignee_policy=policy;
  }
  return after;
}
export function persistCapturedTaskAssignees(d,taskId,captured,actualIds,{rotating=false}={}){
  if(!captured)return;
  const ids=rotating?actualIds:captured.direct_assignee_ids.filter(id=>actualIds.includes(id));
  persistTaskAssigneePolicy(d,taskId,captured,ids);
}
export function updateCapturedDirectAssignees(d,taskId,ids,{adoptCurrent=false}={}){const saved=readTaskAssigneePolicy(d,taskId);if(saved||adoptCurrent)persistTaskAssigneePolicy(d,taskId,adoptCurrent?categoryAssigneePolicy(d,d.prepare('SELECT category FROM tasks WHERE id=?').get(taskId).category):saved,ids);}
export function proposedBoundTaskCategoryPolicy(d,task,body,activity,binding){
  if(body.category===undefined||body.category===task.category)return null;
  const policy=categoryAssigneePolicy(d,body.category),saved=readTaskAssigneePolicy(d,task.id);
  if(!saved){if(policy.max_assignees===null)return null;throw new TaskAssigneePolicyError('Review the direct assignees explicitly before applying a category limit to this existing Activity.','direct_assignees_required');}
  assertActivityAssigneePolicy(policy,activity,{strategy:binding.assignment_override_user_id?'fixed':activity.assignment_policy||activity.assignment_strategy,participants:saved.direct_assignee_ids.map(id=>({id}))});
  return {...policy,direct_assignee_ids:saved.direct_assignee_ids};
}
