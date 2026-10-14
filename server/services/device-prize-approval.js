/** Authentication authorizes one purchase; the browser remains a shared device. */
import crypto from 'node:crypto';
import {readDeviceContext,contextKey,deviceError,auditDevice} from './devices.js';
import {inspectDevicePrizeIntent,createDevicePrizeRedemption} from './device-prizes.js';
import {RewardError} from './rewards.js';

const fail=(message,status=409,reason='device_approval_invalid')=>{throw deviceError(message,status,reason);};
const purchaseFailures=Object.freeze({
  reward_price_changed:{status:409,message:'This prize price changed. Review it before redeeming.'},
  insufficient_points:{status:400,message:'Insufficient points.'},
  device_prize_abandoned:{status:410,message:'This unpurchased request was cancelled. Choose the prize again.'},
  reward_unavailable:{status:404,message:'A selected reward is no longer available. Review the cart.'},
});
export function devicePrizeApprovalFailureReason(req,error,expectedId=req.body?.approval_id){
  const intent=req.session?.deviceApprovalIntent;
  return intent?.kind==='prize'&&intent.id===expectedId&&Object.hasOwn(purchaseFailures,error?.reason)?error.reason:null;
}
function clearProof(req){delete req.session.pendingTwoFactor;delete req.session.oidc;}
function purchaseBody(row){
  try{return JSON.parse(row.request_fingerprint);}catch{fail('This purchase changed. Request approval again.');}
}
// Redirect callbacks have no context header. The durable proof has already
// checked its credential, session, revision and context before this adapter is used.
function purchaseRequest(req,row){
  if(contextKey(req))return req;
  const scoped=Object.create(req);scoped.headers={...req.headers,'x-auth-context':row.context_key};
  scoped.get=name=>name.toLowerCase()==='x-auth-context'?row.context_key:req.get?.(name)||req.headers?.[name.toLowerCase()];
  return scoped;
}
function approvalPayload(row){
  return {kind:'prize',id:row.id,catalogId:purchaseBody(row).catalog_id,userId:purchaseBody(row).user_id,
    rewardName:row.reward_name,recipientName:row.recipient_name,cost:row.expected_cost,state:row.status,expiresAt:row.expires_at};
}
export function beginDevicePrizeApproval(d,req,body={}, {requestKey,now=Date.now()}={}){
  if(!req.sessionID||!req.session)fail('Reload the display before requesting approval.',401);
  const result=d.transaction(()=>{
    const inspected=inspectDevicePrizeIntent(d,req,body,{requestKey,requireMode:'member_signin',now});
    const {context,user,item,key,fingerprint}=inspected,purchase=inspected.body;
    const id=crypto.randomBytes(24).toString('hex'),expiresAt=now+120_000;
    for(const table of ['device_task_approvals','device_prize_approvals'])
      d.prepare(`UPDATE ${table} SET status='cancelled' WHERE credential_id=? AND status='pending'`).run(context.credential.id);
    d.prepare(`INSERT INTO device_prize_approvals(id,credential_id,session_id,context_key,device_revision,request_key,request_fingerprint,
      recipient_user_id,catalog_id,expected_cost,note,recipient_name,reward_name,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,context.credential.id,req.sessionID,context.credential.context_key,context.device.revision,
        key,fingerprint,user.id,item.id,purchase.expected_cost,purchase.note,user.display_name,item.name,now,expiresAt);
    return {approval:approvalPayload(d.prepare('SELECT * FROM device_prize_approvals WHERE id=?').get(id))};
  }).immediate();
  clearProof(req);delete req.session.deviceApprovalError;req.session.deviceApprovalIntent={kind:'prize',id:result.approval.id};
  return result;
}
export function validateDevicePrizeApproval(d,req,{now=Date.now(),allowCompleted=false,expectedId}={}){
  const intent=req.session?.deviceApprovalIntent,id=intent?.id;
  if(intent?.kind!=='prize'||!id||expectedId&&id!==expectedId)fail('This approval changed. Request approval again.');
  const row=d.prepare('SELECT * FROM device_prize_approvals WHERE id=?').get(id),context=readDeviceContext(d,req,{now});
  if(!context||!row||row.session_id!==req.sessionID||row.credential_id!==context.credential.id||row.context_key!==context.credential.context_key
    ||row.device_revision!==context.device.revision||context.credential.temporary_sid||context.credential.login_intent_at
    ||contextKey(req)&&contextKey(req)!==row.context_key)
    fail('The display sign-in changed. Request approval again.',409,'device_context_changed');
  if(row.expires_at<=now)fail('Approval expired. Request approval again.',410,'device_approval_expired');
  if(row.status!=='pending'&&!(allowCompleted&&row.status==='completed'))fail('This approval was cancelled. Request approval again.');
  const scoped=purchaseRequest(req,row),body=purchaseBody(row);
  const inspected=inspectDevicePrizeIntent(d,scoped,body,{requestKey:row.request_key,requireMode:'member_signin',now});
  if(inspected.fingerprint!==row.request_fingerprint)fail('This purchase changed. Request approval again.');
  return {row,context,principal:inspected.principal,user:inspected.user,body,request:scoped};
}
export function assertDevicePrizeApprovalActor(d,req,user,options={}){
  const validated=validateDevicePrizeApproval(d,req,{...options,allowCompleted:true});
  if(Number(user?.id)!==validated.body.user_id||validated.row.status==='completed'&&validated.row.actor_user_id!==Number(user?.id))
    fail('Sign in as the member selected for this purchase.',403,'device_prize_member_required');
  return validated;
}
function receipt(d,validated,now){
  const {row,body,request}=validated,approval=approvalPayload(row);
  if(row.status!=='completed')return {approval};
  // The purchase service rechecks current actor permissions and device authority
  // before disclosing its durable receipt, including retries after an Undo.
  const result=createDevicePrizeRedemption(d,request,body,{requestKey:row.request_key,authenticatedUserId:row.actor_user_id,now});
  if(!result.replayed||result.data.id!==row.redemption_id)fail('This purchase receipt is no longer available.');
  return {approval:{...approval,approved:true},...result};
}
export function readDevicePrizeApproval(d,req,{now=Date.now()}={}){
  if(!req.session?.deviceApprovalIntent)return {approval:null};
  const result=d.transaction(()=>receipt(d,validateDevicePrizeApproval(d,req,{now,allowCompleted:true}),now)).immediate();
  if(result.approval.state==='pending'){
    const savedError=req.session.deviceApprovalError;
    const reason=savedError?.id===result.approval.id?devicePrizeApprovalFailureReason(req,savedError,result.approval.id):null;
    if(reason){const failure=purchaseFailures[reason];throw new RewardError(failure.message,failure.status,reason);}
    result.approval.twoFactorRequired=req.session.pendingTwoFactor?.approvalId===result.approval.id&&req.session.pendingTwoFactor.expiresAt>now;
    if(req.session.deviceApprovalError?.id===result.approval.id)result.approval.error='Authentication could not be completed. Try again.';
  }
  return result;
}
export function cancelDevicePrizeApproval(d,req,{expectedId=req.session?.deviceApprovalIntent?.id}={}){
  const context=readDeviceContext(d,req);if(!context)fail('Pair this display first.',403);
  if(contextKey(req)!==context.credential.context_key)fail('The display sign-in changed.',409,'device_context_changed');
  const id=expectedId;if(id!==undefined&&(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id)))fail('Choose the approval to cancel.',400);
  if(id)d.prepare("UPDATE device_prize_approvals SET status='cancelled' WHERE id=? AND credential_id=? AND session_id=? AND status='pending'").run(id,context.credential.id,req.sessionID);
  if(req.session.deviceApprovalIntent?.id===id)delete req.session.deviceApprovalIntent;
  if(req.session.deviceApprovalError?.id===id)delete req.session.deviceApprovalError;
  if(req.session.pendingTwoFactor?.approvalId===id)delete req.session.pendingTwoFactor;
  if(req.session.oidc?.deviceApprovalId===id)delete req.session.oidc;
  return {cancelled:true};
}
export function completeDevicePrizeApproval(d,req,user,{now=Date.now(),expectedId}={}){
  const result=d.transaction(()=>{
    const validated=assertDevicePrizeApprovalActor(d,req,user,{now,expectedId}),{row,body,request,context}=validated;
    if(row.status==='completed')return receipt(d,validated,now);
    const purchase=createDevicePrizeRedemption(d,request,body,{requestKey:row.request_key,authenticatedUserId:Number(user.id),now});
    const changed=d.prepare("UPDATE device_prize_approvals SET status='completed',actor_user_id=?,redemption_id=?,completed_at=? WHERE id=? AND status='pending'").run(user.id,purchase.data.id,now,row.id);
    if(!changed.changes)fail('This approval changed. Request approval again.');
    auditDevice(d,context.device.id,user.id,'prize_approved',{approval_id:row.id,redemption_id:purchase.data.id});
    return {approval:{...approvalPayload({...row,status:'completed'}),approved:true},...purchase};
  }).immediate();
  clearProof(req);return result;
}
