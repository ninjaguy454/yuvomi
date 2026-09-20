/** Real authentication authorizes one displayed action, never a personal session. */
import crypto from 'node:crypto';
import {assertDeviceContext,readDeviceContext,contextKey,devicePrincipal,deviceError,auditDevice} from './devices.js';
import {deviceTaskVisible,assertTaskMutation} from './task-access.js';
import {assertTaskRevision,changeTaskStatus} from './task-lifecycle.js';
import {inspectTaskSupervision,reconcileTaskSupervision} from './task-supervision.js';
import {deviceTaskDetail} from './device-tasks.js';
import {flushOutbound} from './caldav-todo-outbound.js';

const fail=(message,status=409,reason='device_approval_invalid')=>{throw deviceError(message,status,reason);};
function clearProof(req) {delete req.session.pendingTwoFactor;delete req.session.oidc;}
function target(d,principal,id) {
  const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if(!task||!deviceTaskVisible(d,principal,task))fail('This Task is not available on this display.',404);
  assertTaskMutation(d,principal,task,{status:'done'},{operation:'status'});
  return task;
}
function protectedAction(d,task) {
  const view=inspectTaskSupervision(d,task.id);
  const action=view.actions.find(row=>row.action_task_id===task.id||row.counterpart_task_id===task.id);
  if(!action||action.state==='not_required'||action.completed||task.status==='done')
    fail('Choose an incomplete supervised or helper-owned step to approve.',400);
  return action;
}
export function beginDeviceApproval(d,req,taskId,body={}, {now=Date.now()}={}) {
  const result=d.transaction(()=>{
    const context=assertDeviceContext(d,req,{now});
    if(!context||context.credential.temporary_sid||context.credential.login_intent_at)
      fail('Return to the display before requesting approval.',409,'device_context_changed');
    if(!req.sessionID||!req.session)fail('Reload the display before requesting approval.',401);
    if(Object.keys(body).some(key=>!['status','expected_revision','expected_parent_revision'].includes(key))||body.status&&body.status!=='done')
      fail('Approval completes only this existing action.',400);
    const principal=devicePrincipal(context.device),task=target(d,principal,Number(taskId));
    assertTaskRevision(d,task,body,{required:true,requireParent:true});protectedAction(d,task);
    const id=crypto.randomBytes(24).toString('hex'),expiresAt=now+120_000;
    d.prepare("UPDATE device_task_approvals SET status='cancelled' WHERE credential_id=? AND status='pending'").run(context.credential.id);
    d.prepare(`INSERT INTO device_task_approvals(id,credential_id,session_id,context_key,task_id,task_revision,parent_task_id,parent_revision,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,context.credential.id,req.sessionID,context.credential.context_key,task.id,task.revision,
      task.parent_task_id,task.parent_task_id?body.expected_parent_revision:null,now,expiresAt);
    return {approval:{id,taskId:task.id,title:task.title,state:'pending',expiresAt}};
  }).immediate();
  clearProof(req);delete req.session.deviceApprovalError;req.session.deviceApprovalIntent={id:result.approval.id};return result;
}
export function validateDeviceApproval(d,req,{now=Date.now(),allowCompleted=false,expectedId}={}) {
  const id=req.session?.deviceApprovalIntent?.id;
  if(!id||expectedId&&id!==expectedId)fail('This approval changed. Request approval again.');
  const row=d.prepare('SELECT * FROM device_task_approvals WHERE id=?').get(id);
  const context=readDeviceContext(d,req,{now});
  if(!context||!row||row.session_id!==req.sessionID||row.credential_id!==context.credential.id||row.context_key!==context.credential.context_key
    ||context.credential.temporary_sid||context.credential.login_intent_at||contextKey(req)&&contextKey(req)!==row.context_key)
    fail('The display sign-in changed. Request approval again.',409,'device_context_changed');
  if(row.expires_at<=now)fail('Approval expired. Request approval again.',410,'device_approval_expired');
  if(row.status!=='pending'&&!(allowCompleted&&row.status==='completed'))fail('This approval was cancelled. Request approval again.');
  const principal=devicePrincipal(context.device);
  target(d,principal,row.task_id); // Fresh scope and capability checks also protect receipts.
  return {row,context,principal};
}
function receipt(d,validated) {
  const {row,principal}=validated;
  const approval={id:row.id,taskId:row.task_id,state:row.status,expiresAt:row.expires_at};
  if(row.status!=='completed')return {approval};
  const actor=d.prepare('SELECT display_name FROM users WHERE id=?').get(row.actor_user_id);
  const data=deviceTaskDetail(d,principal,row.task_id);
  if(data.parent_task_id&&deviceTaskVisible(d,principal,data.parent_task_id))data.parent_task=deviceTaskDetail(d,principal,data.parent_task_id);
  return {approval:{...approval,approved:true,actorName:actor?.display_name||'Supervisor'},data};
}
export function readDeviceApproval(d,req,options={}) {
  if(!req.session?.deviceApprovalIntent)return {approval:null};
  const result=receipt(d,validateDeviceApproval(d,req,{...options,allowCompleted:true}));
  if(result.approval.state==='pending') {
    result.approval.twoFactorRequired=req.session.pendingTwoFactor?.approvalId===result.approval.id
      && req.session.pendingTwoFactor.expiresAt>Date.now();
    if(req.session.deviceApprovalError?.id===result.approval.id)
      result.approval.error='Authentication could not be completed. Try again.';
  }
  return result;
}
export function cancelDeviceApproval(d,req,{expectedId=req.session?.deviceApprovalIntent?.id}={}) {
  const context=assertDeviceContext(d,req);
  if(!context)fail('Pair this display first.',403);
  const id=expectedId;
  if(id!==undefined&&(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id)))fail('Choose the approval to cancel.',400);
  if(id)d.prepare("UPDATE device_task_approvals SET status='cancelled' WHERE id=? AND credential_id=? AND session_id=? AND status='pending'")
    .run(id,context.credential.id,req.sessionID);
  // A late close from the preceding modal cannot cancel or clear a newer proof.
  if(req.session.deviceApprovalIntent?.id===id)delete req.session.deviceApprovalIntent;
  if(req.session.deviceApprovalError?.id===id)delete req.session.deviceApprovalError;
  if(req.session.pendingTwoFactor?.approvalId===id)delete req.session.pendingTwoFactor;
  if(req.session.oidc?.deviceApprovalId===id)delete req.session.oidc;
  return {cancelled:true};
}
export function completeDeviceApproval(d,req,user,{now=Date.now(),expectedId}={}) {
  let outbound=false;
  const result=d.transaction(()=>{
    const validated=validateDeviceApproval(d,req,{now,expectedId,allowCompleted:true}),{row,context,principal}=validated;
    const actor=d.prepare('SELECT id,display_name FROM users WHERE id=?').get(Number(user?.id)||0);
    if(!actor)fail('The authenticated supervisor is no longer available.',403);
    if(row.status==='completed') {
      if(row.actor_user_id!==actor.id)fail('This approval has already been completed.',409);
      return receipt(d,validated);
    }
    const task=target(d,principal,row.task_id),body={expected_revision:row.task_revision,
      ...(row.parent_task_id?{expected_parent_revision:row.parent_revision}:{})};
    assertTaskRevision(d,task,body,{required:true,requireParent:true});
    reconcileTaskSupervision(d,task.id,{actorId:actor.id});
    const action=protectedAction(d,task);
    if(action.state!=='assigned'||action.supervisor_user_id!==actor.id)
      fail('The currently assigned qualified supervisor or helper must approve this step.',403,'supervision_required');
    // One action is deliberate: no bulk confirmation or reset authority is carried by this proof.
    const claimed=d.prepare("UPDATE device_task_approvals SET status='completed',actor_user_id=?,completed_at=? WHERE id=? AND status='pending'")
      .run(actor.id,now,row.id);
    if(!claimed.changes)fail('This approval changed. Request approval again.');
    try {
      const changed=changeTaskStatus(d,task.id,'done',{actorId:actor.id,principal:actor.id,body,
        sourceDevice:{id:context.device.id,name:context.device.name},now:new Date(now)});
      outbound=!!(changed.pending||changed.undone);
    }catch(error) {
      const reason=error.reason||error.details?.reason;
      const safe=reason==='stale_revision'?'This Task changed. Refresh it and request approval again.'
        :reason==='task_expired'?'This Task has expired. An authorized editor must reopen it first.'
        :reason==='occurrence_not_started'?'This Task cannot be completed before its start time.'
        :'This step cannot currently be completed. Check its permissions, dependencies and supervision requirements.';
      fail(safe,error.status||409,'device_approval_rejected');
    }
    auditDevice(d,context.device.id,actor.id,'task_approved',{approval_id:row.id,task_id:row.task_id,status:'done'});
    validated.row={...row,status:'completed',actor_user_id:actor.id,completed_at:now};
    return receipt(d,validated);
  }).immediate();
  clearProof(req);
  if(outbound)flushOutbound().catch(()=>{});
  return result;
}
