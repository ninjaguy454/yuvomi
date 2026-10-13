/** One transaction for a child purchase and the parents' ordinary delivery Task. */
import {createRedemption,decideRedemption,applyRedemptionDecision,postLedger,validateRedemptionKey,RewardError} from './rewards.js';
import {setTaskAssignments} from './task-assignments.js';
import {notifyTaskAssignments} from './notification-events.js';
import {assertRewardHuman,assertRewardParent,eligibleRewardParents,rewardHouseholdUser} from './reward-fulfillment-access.js';
import {changeTaskStatus,recordTaskActivity} from './task-lifecycle.js';
import {taskCapabilities} from './task-access.js';
import {tokenAllows} from '../scopes.js';

export function createParentPrizeRedemption(d,{actorId,userId,catalogId,note=null,requestKey,principal=actorId}) {
  return d.transaction(()=>{
    const authority=assertRewardHuman(d,principal);
    if(authority.id!==Number(actorId)||(Number(userId)!==authority.id&&authority.user.role!=='admin'))
      throw new RewardError('You cannot redeem points for this member.',403);
    const child=rewardHouseholdUser(d,userId);
    if(!child)throw new RewardError('Choose a household Rewards member.',403);
    const delivery=child?.family_role==='child';
    const result=createRedemption(d,{actorId,userId,catalogId,note,requestKey,pendingDelivery:delivery});
    if(result.replayed||!delivery)return result;
    createPrizeDelivery(d,result.row,child);
    return result;
  }).immediate();
}

/** Internal delivery writer shared by human and device purchase adapters. */
export function createPrizeDelivery(d,row,child) {
    if(!d.inTransaction)throw new RewardError('Prize delivery must be coordinated.',409);
    if(child.family_role!=='child')return;
    const parents=eligibleRewardParents(d);
    if(!parents.length)throw new RewardError('No household parent currently has permission to fulfill this prize.',409,'no_eligible_parent');
    const columns=new Set(d.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name));
    const scoring=columns.has('scoring_mode')?',scoring_mode,scoring_review_required':'';
    const scoringValues=scoring?",'whole_task',0":'';
    const taskId=Number(d.prepare(`INSERT INTO tasks(title,description,created_by,assigned_to,points,visibility,
      is_recurring,expiration_policy${scoring}) VALUES(?,?,NULL,?,0,'assignees',0,'keep_overdue'${scoringValues})`)
      .run(`Give ${child.display_name} ${row.reward_name}`,
        `Prize redemption #${row.id}: ${row.cost} points. Complete this Task after delivering the prize.`,parents[0]).lastInsertRowid);
    setTaskAssignments(d,taskId,parents);
    d.prepare('INSERT INTO reward_fulfillment_task_links(redemption_id,task_id) VALUES(?,?)').run(row.id,taskId);
    notifyTaskAssignments(d,taskId,[],{sourceKey:`task:${taskId}:assigned:reward-redemption:${row.id}`});
    return taskId;
}

const redemption=(d,id)=>{
  const row=d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(id);
  if(!row)throw new RewardError('Redemption not found.',404);
  return row;
};
const taskLink=(d,id)=>d.prepare('SELECT * FROM reward_fulfillment_task_links WHERE redemption_id=?').get(id);
const attempt=fn=>{try{fn();return true;}catch{return false;}};

export function redemptionRecord(d,row,principal) {
  const undo=d.prepare(`SELECT prior_status,prior_decided_by,prior_decided_at,actor_user_id,actor_name,reason,created_at
    FROM reward_redemption_undos WHERE redemption_id=?`).get(row.id)||null;
  const link=taskLink(d,row.id),task=link&&d.prepare('SELECT * FROM tasks WHERE id=?').get(link.task_id);
  let authority=null;try{authority=assertRewardHuman(d,principal);}catch{ /* read-only records carry no actions */ }
  const parentFulfill=task?attempt(()=>assertRewardParent(d,principal,{taskId:task.id})):authority?.user.role==='admin';
  const result={...row,display_status:undo?'undone':row.status,undo,requires_delivery:Boolean(link),
    can_fulfill:Boolean(authority&&row.status==='pending'&&parentFulfill),
    can_cancel:Boolean(authority&&row.status==='pending'&&(authority.id===row.user_id||authority.user.role==='admin')),
    can_reject:Boolean(authority?.user.role==='admin'&&row.status==='pending'),
    can_undo:Boolean(['pending','fulfilled'].includes(row.status)&&!undo&&attempt(()=>assertRewardParent(d,principal,{undo:true})))};
  if(task&&tokenAllows(principal?.authScopes,'tasks','read')&&taskCapabilities(d,principal,task).view)
    result.fulfillment_task_id=task.id;
  return result;
}

function assertActor(d,actorId,principal) {
  const authority=assertRewardHuman(d,principal);
  if(authority.id!==Number(actorId))throw new RewardError('Personal identity is required.',403);
  return authority;
}

function cancelDelivery(d,row,{actorId,event='archived',details={}}) {
  const link=taskLink(d,row.id);if(!link)return;
  if(!d.inTransaction||!['cancelled','rejected'].includes(row.status))throw new RewardError('Prize cancellation must be coordinated.',409);
  const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(link.task_id);
  if(!task)throw new RewardError('The prize delivery Task is unavailable.',409);
  if(task.status!=='done') {
    d.prepare("UPDATE tasks SET archived_at=COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%SZ','now')),revision=revision+1 WHERE id=?").run(task.id);
    d.prepare("UPDATE planning_obligations SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE task_id=? AND status IN ('pending','accepted')").run(task.id);
    d.prepare("UPDATE task_responsibilities SET status='cancelled' WHERE task_id=? AND status='active'").run(task.id);
    d.prepare("UPDATE task_assignment_context SET state='cancelled' WHERE task_id=? AND state!='fulfilled'").run(task.id);
  }else d.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(task.id);
  recordTaskActivity(d,task.id,event,actorId,{redemption_id:row.id,from_status:task.status,points_awarded:0,...details});
}

/** Called only within the existing authorized account-delete transaction.
 * Recipient-owned points/records follow its existing cascade; retained parent
 * Tasks and immutable Undo audits are history, not outstanding delivery work. */
export function cancelRewardDeliveriesForMemberDeletion(d,userId,{actorId}) {
  if(!d.inTransaction)throw new RewardError('Member deletion must be coordinated.',409);
  if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reward_fulfillment_task_links'").get())return;
  const rows=d.prepare(`SELECT r.* FROM reward_redemptions r JOIN reward_fulfillment_task_links l
    ON l.redemption_id=r.id WHERE r.user_id=? AND r.status='pending'`).all(userId);
  for(const row of rows){
    const cancelled=applyRedemptionDecision(d,{actorId,redemptionId:row.id,action:'cancel'});
    cancelDelivery(d,cancelled,{actorId,details:{reason:'Household member deleted'}});
  }
}

export function decideParentPrizeRedemption(d,{actorId,redemptionId,action,principal=actorId}) {
  return d.transaction(()=>{
    const authority=assertActor(d,actorId,principal),row=redemption(d,redemptionId),link=taskLink(d,row.id);
    if(!link)return decideRedemption(d,{actorId,isAdmin:authority.user.role==='admin',redemptionId,action});
    if(action==='fulfill') {
      assertRewardParent(d,principal,{taskId:link.task_id});
      const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(link.task_id);
      if(row.status==='fulfilled'&&task?.status==='done')return row;
      if(row.status!=='pending'||!task||task.archived_at)throw new RewardError('Redemption already decided.',409);
      changeTaskStatus(d,task.id,'done',{actorId,principal,body:{expected_revision:task.revision}});
      return redemption(d,row.id);
    }
    if(action==='reject'&&authority.user.role!=='admin')throw new RewardError('Admin access required.',403);
    if(action==='cancel'&&authority.user.role!=='admin'&&row.user_id!==actorId)throw new RewardError('Not allowed.',403);
    const updated=applyRedemptionDecision(d,{actorId,redemptionId,action});
    if(row.status==='pending')cancelDelivery(d,updated,{actorId,details:{reason:`Prize ${action}`}});
    return updated;
  }).immediate();
}

export function undoPrizeRedemption(d,{actorId,redemptionId,requestKey,expectedStatus,confirmDelivered=false,
  reason='Accidental redemption',principal=actorId}) {
  const key=validateRedemptionKey(requestKey,'undoing a redemption');
  if(!Number.isSafeInteger(redemptionId)||redemptionId<=0)throw new RewardError('Invalid redemption ID.');
  if(!['pending','fulfilled'].includes(expectedStatus))throw new RewardError('Refresh the redemption before undoing it.',428,'expected_status_required');
  if(typeof confirmDelivered!=='boolean'||typeof reason!=='string'||!reason.trim()||reason.trim().length>200)
    throw new RewardError('Explain the Undo in 1 to 200 characters and confirm its current status.');
  reason=reason.trim();
  const fingerprint=JSON.stringify([redemptionId,expectedStatus,confirmDelivered,reason]);
  return d.transaction(()=>{
    const authority=assertActor(d,actorId,principal);assertRewardParent(d,principal,{undo:true});
    const receipt=d.prepare('SELECT * FROM reward_redemption_undo_requests WHERE actor_user_id=? AND request_key=?').get(actorId,key);
    if(receipt) {
      if(receipt.request_fingerprint!==fingerprint)throw new RewardError('This request ID belongs to a different Undo.',409,'request_id_conflict');
      if(!receipt.redemption_id||!d.prepare('SELECT 1 FROM reward_redemptions WHERE id=?').get(receipt.redemption_id))
        throw new RewardError('The original Undo is no longer available. Its request ID cannot be reused.',410);
      return {row:redemption(d,receipt.redemption_id),replayed:true,outcome:receipt.outcome};
    }
    const row=redemption(d,redemptionId),oldUndo=d.prepare('SELECT * FROM reward_redemption_undos WHERE redemption_id=?').get(row.id);
    const saveReceipt=outcome=>d.prepare(`INSERT INTO reward_redemption_undo_requests
      (actor_user_id,request_key,request_fingerprint,redemption_id,outcome) VALUES(?,?,?,?,?)`).run(actorId,key,fingerprint,row.id,outcome);
    if(oldUndo){saveReceipt('undone');return {row,replayed:true,outcome:'undone'};}
    const debits=d.prepare("SELECT * FROM reward_ledger WHERE redemption_id=? AND type='redeem'").all(row.id);
    const reversal=d.prepare("SELECT * FROM reward_ledger WHERE redemption_id=? AND type='reversal'").get(row.id);
    if(debits.length!==1||debits[0].user_id!==row.user_id||debits[0].delta!==-row.cost||!Number.isSafeInteger(row.cost)||row.cost<0)
      throw new RewardError('This historical redemption needs a reasoned points adjustment before it can be undone.',409,'redemption_ledger_inconsistent');
    if(['cancelled','rejected'].includes(row.status)&&reversal?.user_id===row.user_id&&reversal.delta===row.cost) {
      saveReceipt('already_refunded');return {row,replayed:true,outcome:'already_refunded'};
    }
    if(reversal||!['pending','fulfilled'].includes(row.status))throw new RewardError('This redemption has an inconsistent refund history.',409,'redemption_ledger_inconsistent');
    if(row.status!==expectedStatus)throw new RewardError('This redemption changed. Review its delivery status before undoing it.',409,'redemption_status_changed');
    if(row.status==='fulfilled'&&!confirmDelivered)throw new RewardError('Confirm returning points for this already delivered prize.',409,'delivered_confirmation_required');
    const refund=postLedger(d,{userId:row.user_id,delta:row.cost,type:'reversal',reason:`Undo: ${row.reward_name} — ${reason}`,
      redemptionId:row.id,createdBy:actorId});
    d.prepare(`INSERT INTO reward_redemption_undos(redemption_id,prior_status,prior_decided_by,prior_decided_at,
      actor_user_id,actor_name,reason,refund_ledger_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(row.id,row.status,row.decided_by,row.decided_at,actorId,authority.user.display_name,reason,refund.lastInsertRowid);
    d.prepare(`UPDATE reward_redemptions SET status='cancelled',decided_by=?,
      decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(actorId,row.id);
    const updated=redemption(d,row.id);
    cancelDelivery(d,updated,{actorId,event:'redemption_undone',details:{reason,prior_redemption_status:row.status,refund_points:row.cost}});
    saveReceipt('undone');
    return {row:updated,replayed:false,outcome:'undone'};
  }).immediate();
}
