/** A device adapter over the canonical Task lifecycle, never a member impersonation. */
import { deviceTaskVisible, deviceTaskCapabilities, assertTaskMutation } from './task-access.js';
import { actionableSubtasks, assertTaskRevision, changeTaskStatus, recordTaskActivity } from './task-lifecycle.js';
import { inspectTaskSupervision, reconcileTaskSupervision } from './task-supervision.js';
import { taskOptionalContext } from './task-optional.js';
import { taskRotationContexts } from './task-rotation.js';
import { claimTask } from './assignment-responsibilities.js';
import { flushOutbound } from './caldav-todo-outbound.js';
import { taskScopeWhere, taskStartProjection } from './task-scope.js';

const fail = (message, status=403) => {throw Object.assign(new Error(message),{status,code:status});};
const pick = (value, keys) => Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
const keys = ['id','title','description','status','priority','points','category','start_date','start_time','due_date','due_time',
  'revision','parent_task_id','assigned_to','is_optional','sort_order','is_recurring','expiration_policy','expired_at',
  'created_at','updated_at','completed_at','locked','recurrence_rule','recurrence_from_completion'];
const member = row => pick(row,['id','display_name','avatar_color']);
function requireTask(d, principal, id) {
  const row = d.prepare('SELECT * FROM tasks WHERE id=?').get(Number(id)||0);
  if(!row || !deviceTaskVisible(d,principal,row))fail('This Task is not available on this display.',404);
  return row;
}
function assignees(d,row) {
  let task=row; const seen=new Set();
  while(task && !seen.has(task.id)) {
    seen.add(task.id);
    const values=d.prepare(`SELECT u.id,u.display_name,u.avatar_color FROM users u WHERE u.id=?
      OR EXISTS(SELECT 1 FROM task_assignments a WHERE a.task_id=? AND a.user_id=u.id) ORDER BY u.id`).all(task.assigned_to,task.id);
    if(values.length)return values;
    task=task.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_task_id):null;
  }
  return [];
}
function protectedAction(d,row,view=inspectTaskSupervision(d,row.id)) {
  return view.support_task_id===row.id || view.actions.some(action=>(action.action_task_id===row.id || action.counterpart_task_id===row.id)
    && (action.counterpart_task_id===row.id || action.state!=='not_required'));
}
function project(d,principal,row,cache=new Map(),seen=new Set()) {
  if(seen.has(row.id))return null;
  seen.add(row.id);
  const out=pick(row,keys);
  out.assigned_users=assignees(d,row).map(member);
  out.assigned_name=out.assigned_users.find(user=>user.id===row.assigned_to)?.display_name || out.assigned_users[0]?.display_name || null;
  out.effective_assignee_id=row.assigned_to ?? out.assigned_users[0]?.id ?? null;
  out.effective_assignee_name=out.assigned_name;
  out.parent_revision=row.parent_task_id?d.prepare('SELECT revision FROM tasks WHERE id=?').get(row.parent_task_id)?.revision:null;
  out.permissions=deviceTaskCapabilities(d,principal,row);
  const supervision=inspectTaskSupervision(d,row.id), blocked=protectedAction(d,row,supervision), optional=taskOptionalContext(d,row.id).closed_parent;
  const action=supervision.actions.find(action=>action.action_task_id===row.id||action.counterpart_task_id===row.id);
  if(action)out.supervision_action={...pick(action,['execution_mode','state','completed']),can_complete:!blocked};
  out.is_supervision_projection=supervision.support_task_id===row.id||action?.counterpart_task_id===row.id;
  out.is_delegated_action=action?.execution_mode==='delegated'&&action?.action_task_id===row.id;
  const protectedLeaf=supervision.actions.some(action=>(action.action_task_id===row.id||action.counterpart_task_id===row.id)&&action.state!=='not_required'&&!action.completed);
  out.approval_required=Boolean(protectedLeaf && out.permissions.complete && !optional && !['done','expired'].includes(row.status));
  out.supervisor_approval=out.approval_required;
  out.permissions.supervisor_approval=out.approval_required;
  const assignment=d.prepare('SELECT strategy,state FROM task_assignment_context WHERE task_id=?').get(row.id);
  if(assignment) {
    out.activity_assignment_strategy=assignment.strategy;out.activity_assignment_state=assignment.state;
    if(out.permissions.claim&&assignment.strategy==='open_claimable'&&['open','unavailable'].includes(assignment.state)) {
      const allowed=principal.scope?.member_ids||[];
      out.claim_candidates=d.prepare(`SELECT u.id,u.display_name,u.avatar_color FROM users u
        WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)
        AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id) ORDER BY u.display_name`).all().filter(member=>!allowed.length||allowed.includes(member.id));
    }else out.permissions.claim=false;
  }else out.permissions.claim=false;
  if(blocked || optional || ['expired'].includes(row.status) || !out.assigned_users.length) {
    out.permissions.complete=false;out.permissions.reopen=false;out.permissions.reset=false;
    if(blocked)out.execution_notice='A qualified person must approve this supervised or helper-owned action.';
  }
  const children=supervision.support_task_id===row.id
    ? d.prepare('SELECT * FROM tasks WHERE parent_task_id=? AND archived_at IS NULL ORDER BY sort_order,id').all(row.id)
    : actionableSubtasks(d,row.id);
  out.subtasks=children.filter(child=>deviceTaskVisible(d,principal,child)).map(child=>project(d,principal,child,cache,new Set(seen)));
  // The board must not suggest a bulk completion that its canonical mutation
  // will reject. Approval is intentionally offered on the protected leaf only.
  if(out.subtasks.some(child=>!child.is_optional&&child.status!=='done'&&child.permissions?.complete===false))out.permissions.complete=false;
  out.tags=d.prepare('SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag_key').all(row.id).map(item=>item.tag);
  const required=out.subtasks.filter(child=>!child.is_optional), optionalRows=out.subtasks.filter(child=>child.is_optional);
  out.subtask_total=required.length;out.subtask_done=required.filter(child=>child.status==='done').length;
  out.optional_subtask_total=optionalRows.length;out.optional_subtask_done=optionalRows.filter(child=>child.status==='done').length;
  out.rotations=principal.permissions?.capabilities?.['rotations.view']==='allow'
    ? taskRotationContexts(d,row,null,cache).filter(context=>(context.shared || deviceTaskVisible(d,principal,context.owner_task_id))
      && (!Array.isArray(principal.scope?.rotation_group_ids) || principal.scope.rotation_group_ids.includes(context.occurrence.group_id))).map(context=>({
      ...pick(context,['purpose_key','label','shared','pending','position','reason']),
      occurrence:{...pick(context.occurrence,['id','status','state','strategy','provisional','period_date']),
        order:(context.occurrence.order||[]).map(item=>pick(item,['id','display_name','position'])),
        selected_member:context.occurrence.selected_member?member(context.occurrence.selected_member):null}})) : [];
  return out;
}
export function deviceTaskList(d,principal,{query=null,withVisibility=false}={}) {
  const cache=new Map();
  const values=value=>(value==null?[]:[value].flat()).filter(value=>typeof value==='string'&&value!=='').slice(0,50);
  const statuses=values(query?.status),priorities=values(query?.priority),assigned=values(query?.assigned_to).map(Number),categories=values(query?.category),tags=values(query?.tag).map(value=>value.toLocaleLowerCase());
  const includeFuture=query?.include_future==='1';
  // Use the same ordinary list scope as the human board. Visibility is checked
  // before projection; query filters can only narrow device authorization.
  const candidates = d.prepare(`SELECT t.* FROM tasks t WHERE ${taskScopeWhere('t',{includeFuture:true,includeSupervision:true})}
    AND t.archived_at IS NULL ORDER BY t.status='done',t.due_date IS NULL,t.due_date,t.due_time,t.id`).all()
    .filter(row=>deviceTaskVisible(d,principal,row) && (query
      ? (!statuses.length?row.status!=='expired':statuses.includes(row.status))
      : !['done','expired'].includes(row.status)))
    .filter(row=>(!priorities.length||priorities.includes(row.priority))&&(!categories.length||categories.includes(row.category))
      &&(!assigned.length||assignees(d,row).some(member=>assigned.includes(member.id)))
      && (!tags.length||tags.every(tag=>d.prepare('SELECT 1 FROM task_tags WHERE task_id=? AND LOWER(tag)=?').get(row.id,tag))))
    ;
  const startProjection=taskStartProjection(d,{tasks:candidates});
  const projected=(includeFuture?candidates:candidates.filter(startProjection.visible)).slice(0,500).map(row=>project(d,principal,row,cache));
  const data=includeFuture?projected:projected.map(startProjection.project);
  return withVisibility?{data,visibility:startProjection.metadata([...candidates,...projected],{includeFuture})}:data;
}
export function deviceTaskDetail(d,principal,id) {return project(d,principal,requireTask(d,principal,id));}
export function deviceTaskStatus(d,principal,id,body={}) {
  const result=d.transaction(()=>{
    const task=requireTask(d,principal,id);
    if(Object.keys(body).some(key=>!['status','expected_revision','expected_parent_revision','complete_remaining','reset_progress'].includes(key)))
      fail('This display can change existing progress only.');
    assertTaskMutation(d,principal,task,body,{operation:'status'});
    reconcileTaskSupervision(d,task.id,{actorId:null});
    const scope=[],seen=new Set();
    const collect=row=>{if(seen.has(row.id))return;seen.add(row.id);scope.push(row);
      if(['done','open'].includes(body.status))for(const child of actionableSubtasks(d,row.id)) {
        if(body.status==='done' && (child.is_optional || child.status==='done'))continue;collect(child);
      }};
    collect(task);
    for(const row of scope) {
      requireTask(d,principal,row.id);
      if(!assignees(d,row).length)fail('Claim this Task for a permitted member before completing it.');
      if(protectedAction(d,row))fail('A qualified person must sign in temporarily for supervised or helper-owned work.');
    }
    return changeTaskStatus(d,task.id,body.status,{actorId:null,principal,body});
  }).immediate();
  const out=deviceTaskDetail(d,principal,id);
  if(result.parent_task && deviceTaskVisible(d,principal,result.parent_task))out.parent_task=deviceTaskDetail(d,principal,result.parent_task.id);
  if(result.pending||result.undone)flushOutbound().catch(()=>{});
  return out;
}
export function deviceTaskClaim(d,principal,id,body={}) {
  d.transaction(()=>{
    const task=requireTask(d,principal,id),target=Number(body.user_id);
    assertTaskMutation(d,principal,task,body,{operation:'claim'});
    assertTaskRevision(d,task,body,{required:true,requireParent:true});
    if(!Number.isSafeInteger(target)||target<1)fail('Choose the member receiving this claim.',400);
    if(principal.scope?.member_ids?.length && !principal.scope.member_ids.map(Number).includes(target))fail('This display cannot claim work for that member.');
    if(protectedAction(d,task))fail('A qualified person must sign in temporarily for supervised or helper-owned work.');
    const sourceDevice={id:principal.id,name:principal.name};
    try {claimTask(d,task.id,target,{actorId:null,sourceDevice});}
    catch(error) {
      const safe=['This task is not claimable.','This task has already been claimed.','This task was claimed by someone else.'];
      fail(safe.includes(error.message)?error.message:'This member is not eligible for this Task with its current skills, supervision or Availability.',409);
    }
    recordTaskActivity(d,task.id,'claimed',null,{title:task.title,assigned_user_id:target,source_device:sourceDevice});
  }).immediate();
  return deviceTaskDetail(d,principal,id);
}
