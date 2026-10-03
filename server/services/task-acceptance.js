/** One transaction accepts regular work, optional co-assignees and allocations. */
import {createHash} from 'node:crypto';
import {actorId} from '../permissions.js';
import {taskDevicePrincipal} from './task-access.js';
import {taskOfferState,acceptanceError} from './task-offers.js';
import {acceptanceAuthority,assertAcceptanceMember,authorizedAcceptanceChildren,childAllocationReason,assertChildRecipient} from './task-acceptance-policy.js';
import {assertTaskRevision,recordTaskActivity} from './task-lifecycle.js';
import {claimTask,assertTaskAssignmentAvailability} from './assignment-responsibilities.js';
import {setTaskAssignments} from './task-assignments.js';
import {reconcileTaskSupervision,inspectTaskSupervision} from './task-supervision.js';
import {notifyTaskClaim,notifyTaskAssignments} from './notification-events.js';
import {markTodoOutbound} from './caldav-todo-outbound.js';
import {auditDevice} from './devices.js';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const validId=id=>Number.isSafeInteger(id)&&id>0;
function validateBody(body){
  const allowed=['operation_id','expected_revision','expected_parent_revision','primary_user_id','coassignee_ids','subtask_snapshot','subtask_assignments'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))throw acceptanceError('Invalid acceptance request.',400,'invalid_request');
  if(typeof body.operation_id!=='string'||!body.operation_id.length||body.operation_id.length>128||/[^A-Za-z0-9_.:-]/.test(body.operation_id))throw acceptanceError('Choose a valid operation ID.',400,'invalid_request');
  if(body.primary_user_id!==undefined&&!validId(body.primary_user_id))throw acceptanceError('Choose a valid recipient.',400,'invalid_request');
  if(!Array.isArray(body.coassignee_ids)||body.coassignee_ids.length>100||body.coassignee_ids.some(id=>!validId(id))||new Set(body.coassignee_ids).size!==body.coassignee_ids.length)throw acceptanceError('Choose distinct co-assignees.',400,'invalid_request');
  for(const [key,fields] of [['subtask_snapshot',['id','revision']],['subtask_assignments',['id','user_id']]]){
    if(!Array.isArray(body[key])||body[key].length>500||new Set(body[key].map(row=>row?.id)).size!==body[key].length
      ||body[key].some(row=>!row||typeof row!=='object'||Object.keys(row).some(k=>!fields.includes(k))||!validId(row.id)
        ||(key==='subtask_snapshot'?!validId(row.revision):row.user_id!==null&&!validId(row.user_id))))throw acceptanceError('Choose a valid, complete subtask snapshot and distinct allocations.',400,'invalid_request');
  }
}
function receiptKey(p){
  const device=taskDevicePrincipal(p),context=p?.deviceContext?.credential;
  return `${device?'device':'user'}:${device?.id||actorId(p)}:${context?`${context.id}:${context.context_key}`:device?`revision:${device.revision}`:'personal'}`;
}
function responsibility(d,taskId,userId,role){
  d.prepare(`INSERT INTO task_responsibilities(task_id,user_id,role,source) VALUES(?,?,?,'claim')
    ON CONFLICT(task_id,user_id,role) DO UPDATE SET status='active',source=CASE WHEN task_responsibilities.source='subtasks' THEN 'subtasks' ELSE 'claim' END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(taskId,userId,role);
}
export function acceptTask(d,principal,taskId,body){
  if(!validId(taskId))throw acceptanceError('Task not found.',404,'not_found');
  validateBody(body);
  const hash=createHash('sha256').update(JSON.stringify(stable({task_id:taskId,...body}))).digest('hex');
  return d.transaction(()=>{
    // Permission checks precede receipt lookup; a replay never lends old rights.
    const auth=acceptanceAuthority(d,principal,taskId),{task,device}=auth,p=auth.principal,key=receiptKey(p);
    const receipt=d.prepare('SELECT request_hash,task_id FROM task_acceptance_receipts WHERE principal_key=? AND operation_id=?').get(key,body.operation_id);
    if(receipt&&receipt.request_hash!==hash)throw acceptanceError('This operation ID was already used for a different acceptance.');
    if(body.coassignee_ids.length)acceptanceAuthority(d,p,taskId,{helpers:true});
    if(receipt){if(receipt.task_id!==taskId)throw acceptanceError('The accepted Task is no longer available.',404,'not_found');return {task_id:taskId,replayed:true};}
    const offer=taskOfferState(d,p,task);if(!offer.visible)throw acceptanceError('This Task is no longer available to accept.',409,'offer_unavailable');
    assertTaskRevision(d,task,body,{required:true,requireParent:true});
    const primary=device?body.primary_user_id:actorId(p);
    if(!device&&body.primary_user_id!==undefined&&body.primary_user_id!==primary)throw acceptanceError('Accept this Task as your signed-in account.',403,'primary_not_self');
    if(body.coassignee_ids.includes(primary))throw acceptanceError('The primary recipient cannot also be a co-assignee.',400,'invalid_request');
    const selected=[primary,...body.coassignee_ids];for(const member of selected)assertAcceptanceMember(d,p,task,member);
    const children=authorizedAcceptanceChildren(d,p,task),snapshot=children.map(c=>({id:c.id,revision:c.revision})).sort((a,b)=>a.id-b.id);
    if(JSON.stringify(snapshot)!==JSON.stringify([...body.subtask_snapshot].sort((a,b)=>a.id-b.id)))throw acceptanceError('The subtasks changed. Reload the Task before accepting.',409,'stale_subtasks');
    if(body.subtask_assignments.some(row=>row.user_id!==null)&&!body.coassignee_ids.length)throw acceptanceError('Subtask allocation is available when accepting with co-assignees.',400,'invalid_request');
    const supervision=inspectTaskSupervision(d,taskId),byId=new Map(children.map(child=>[child.id,child]));
    const allocations=body.subtask_assignments.map(row=>{
      const child=byId.get(row.id);if(!child)throw acceptanceError('A subtask is outside this acceptance snapshot.',400,'invalid_request');
      // Null is an explicit no-op, never a command to clear an assignment.
      if(row.user_id===null)return null;
      if(!selected.includes(row.user_id))throw acceptanceError('Assign subtasks only to the selected assignees.',400,'invalid_request');
      if(childAllocationReason(d,p,task,child,supervision))throw acceptanceError('This subtask cannot be allocated during acceptance.',409,'subtask_not_allocatable');
      assertChildRecipient(d,child,row.user_id);return {child,userId:row.user_id};
    }).filter(Boolean);
    const actor=device?null:actorId(p),sourceDevice=device?{id:device.id,name:device.name}:null;
    const managed=d.prepare('SELECT 1 FROM task_assignment_context WHERE task_id=?').get(taskId);
    if(managed)claimTask(d,taskId,primary,{actorId:actor,sourceDevice});
    else d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(primary,taskId);
    const existing=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=?').all(taskId).map(r=>r.user_id);
    setTaskAssignments(d,taskId,[...new Set([...existing,...selected])]);
    responsibility(d,taskId,primary,'primary');for(const member of selected)responsibility(d,taskId,member,'participant');
    for(const {child,userId} of allocations){
      d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(userId,child.id);
      setTaskAssignments(d,child.id,[userId]);
      markTodoOutbound('tasks',child,d.prepare('SELECT * FROM tasks WHERE id=?').get(child.id));
    }
    reconcileTaskSupervision(d,taskId,{actorId:actor});
    assertTaskAssignmentAvailability(d,taskId,selected);
    recordTaskActivity(d,taskId,'claimed',actor,{title:task.title,assigned_user_id:primary,coassignee_ids:body.coassignee_ids,...(sourceDevice?{source_device:sourceDevice}:{})});
    if(!managed)notifyTaskClaim(d,taskId,null,actor,{sourceDevice,targetUserId:primary});
    // Assignment notifications are queued transactionally by the established service.
    if(body.coassignee_ids.length)notifyTaskAssignments(d,taskId,[primary,...existing],{managed:true});
    markTodoOutbound('tasks',task,d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
    if(device)auditDevice(d,device.id,null,'task_accepted',{task_id:taskId,primary_user_id:primary,coassignee_ids:body.coassignee_ids});
    d.prepare('INSERT INTO task_acceptance_receipts(principal_key,operation_id,request_hash,task_id) VALUES(?,?,?,?)').run(key,body.operation_id,hash,taskId);
    return {task_id:taskId,replayed:false};
  }).immediate();
}
