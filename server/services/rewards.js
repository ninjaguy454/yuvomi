import { taskWindowAncestors } from './task-window.js';
/**
 * Modul: Rewards (Belohnungen)
 * Zweck: Punkte-Vergabe bei Aufgaben-Erledigung und Salden-Berechnung aus dem
 *        Ledger. Der Punktestand eines Mitglieds ist immer SUM(delta) über
 *        reward_ledger — es gibt keinen separat gepflegten Saldo, der driften
 *        könnte.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben.
 */

import { rewardOccurrenceProvenance } from './task-recurrence-frontier.js';
import {taskRewardDefinition,recordTaskScoringSettlement,assertTaskScoringAward} from './task-scoring.js';

const REWARD_TX = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by)
  VALUES (@user_id, @delta, @type, @reason, @task_id, @redemption_id, @created_by)
`;

/** Aktueller Punktestand eines Mitglieds (Summe aller Ledger-Buchungen). */
export function getBalance(d, userId) {
  const row = d.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ?').get(userId);
  return row?.bal ?? 0;
}

/** Nimmt ein Mitglied aktiv am Punkte-System teil? */
export function isEnrolled(d, userId) {
  if (!userId) return false;
  const row = d.prepare('SELECT enabled FROM reward_participants WHERE user_id = ?').get(userId);
  return !!row && row.enabled === 1;
}

/**
 * Wer verdient die Punkte einer Aufgabe? Zugewiesene, teilnehmende Mitglieder;
 * ist niemand zugewiesen (Kiosk-Tablet mit einem Account), die handelnde Person
 * — sofern selbst teilnehmend. Jedes zuständige Mitglied erhält den vollen Wert.
 */
export function rewardTargets(d, taskId, actingUserId) {
  return taskRewardDefinition(d,taskId,{actingUserId})?.targets||[];
}

/** One original award per occurrence, with recipients frozen at its first award.
 * The claim and every ledger row commit together, including through callers
 * outside the Task lifecycle. Regenerated rows share their original logical
 * series/date/action claim; reopening, deletion and retries cannot award twice. */
export function awardForCompletion(d, taskId, actingUserId) {
  return d.transaction(() => {
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task || !Number.isInteger(task.points) || task.points < 0) return false;
    if(task.parent_task_id && task.status!=='done')return false;
    if (taskWindowAncestors(d,taskId).some(row=>['expired','skipped','closed_incomplete'].includes(row.status))) return false;
    const provenance=rewardOccurrenceProvenance(d,taskId);
    if(provenance.retired)return false;
    const settled=d.prepare(`SELECT s.* FROM task_scoring_settlements s WHERE logical_key=?
      AND NOT EXISTS(SELECT 1 FROM task_scoring_settlement_releases r WHERE r.settlement_id=s.id) ORDER BY s.id DESC LIMIT 1`).get(provenance.logicalKey);
    if(settled)return syncSubtaskAwardState(d,task,settled,true,actingUserId);
    const definition=taskRewardDefinition(d,task,{actingUserId});
    assertTaskScoringAward(d,definition);
    if(definition.outcome!=='earned'){
      recordTaskScoringSettlement(d,definition,provenance.logicalKey);return false;
    }
    const claim = d.prepare('INSERT OR IGNORE INTO reward_task_awards(task_id,logical_key) VALUES (?,?)').run(taskId,provenance.logicalKey);
    if (!claim.changes) return false;
    if(!recordTaskScoringSettlement(d,definition,provenance.logicalKey).changes)return false;
    const ins = d.prepare(`INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by)
      VALUES (?, ?, 'earn', ?, ?, ?)`);
    for (const uid of definition.targets) ins.run(uid, definition.points, task.title || null, taskId, actingUserId || null);
    return true;
  }).immediate();
}

/** Compensate the original subtask award; never erase an earn, release its
 * occurrence claim, re-resolve recipients, or neutralize manual adjustments.
 * The immutable settlement and intact original earn row prove each amount.
 * Deletion detaches that earn's Task FK, so a reused Task ID cannot restore it. */
function syncSubtaskAwardState(d,task,settlement,active,actingUserId){
  if(!task.parent_task_id || settlement.task_id!==task.id || settlement.outcome!=='earned'
    || active!== (task.status==='done') || !['open','in_progress','done'].includes(task.status))return false;
  const claim=d.prepare('SELECT * FROM reward_task_awards WHERE task_id=?').get(task.id);
  if(!claim || claim.retired_at || claim.logical_key!==settlement.logical_key)return false;
  const previous=d.prepare('SELECT * FROM task_scoring_completion_events WHERE settlement_id=? ORDER BY sequence DESC LIMIT 1').get(settlement.id);
  if(Boolean(previous?previous.active:1)===active)return false;
  const frozen=new Map(JSON.parse(settlement.recipients_json).map(row=>[row.user_id,row.points]));
  const original=d.prepare("SELECT id,user_id,delta FROM reward_ledger WHERE task_id=? AND type='earn' ORDER BY id").all(task.id);
  const prior=active?JSON.parse(previous.entries_json):null;
  const entries=[];
  for(const earn of original){
    if(!Number.isSafeInteger(earn.delta)||earn.delta<=0||frozen.get(earn.user_id)!==earn.delta)continue;
    if(active&&!prior.some(row=>row.earn_ledger_id===earn.id&&row.user_id===earn.user_id&&row.delta===-earn.delta))continue;
    const delta=active?earn.delta:-earn.delta;
    const row=postLedger(d,{userId:earn.user_id,delta,type:'adjust',taskId:task.id,createdBy:actingUserId??null,
      reason:active?'Subtask completion credit restored':'Subtask completion credit reversed'});
    entries.push({earn_ledger_id:earn.id,ledger_id:Number(row.lastInsertRowid),user_id:earn.user_id,delta});
  }
  if(!entries.length)return false;
  d.prepare(`INSERT INTO task_scoring_completion_events(settlement_id,sequence,active,task_id,task_revision,actor_user_id,status,entries_json)
    VALUES(?,?,?,?,?,?,?,?)`).run(settlement.id,(previous?.sequence??0)+1,active?1:0,task.id,task.revision,actingUserId??null,task.status,JSON.stringify(entries));
  return true;
}

/** Root Task earnings retain their established lifetime policy. Only an actual
 * completed-subtask transition can suspend its proven completion credit. */
export function reverseTaskEarnings(d,taskId,actingUserId=null){
  return d.transaction(()=>{
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if(!task?.parent_task_id || !['open','in_progress'].includes(task.status))return false;
    const provenance=rewardOccurrenceProvenance(d,taskId);if(provenance.retired)return false;
    const settled=d.prepare(`SELECT s.* FROM task_scoring_settlements s WHERE logical_key=?
      AND NOT EXISTS(SELECT 1 FROM task_scoring_settlement_releases r WHERE r.settlement_id=s.id) ORDER BY s.id DESC LIMIT 1`).get(provenance.logicalKey);
    return settled?syncSubtaskAwardState(d,task,settled,false,actingUserId):false;
  }).immediate();
}

/**
 * Retain original history while subtask completion credit follows real progress.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId);
  else if(wasDone&&!isDone)reverseTaskEarnings(d,taskId,actingUserId);
}

export class RewardError extends Error {
  constructor(message, status = 400, reason = null) {
    super(message); this.status = status; this.reason = reason;
  }
}

/** A client must retain this key after a timeout. A new key means a deliberately
 * new redemption, not a retry. Durable records do not expire with the generic
 * API response cache. */
export function validateRedemptionKey(value, action = 'redeeming') {
  if (value == null || value === '') throw new RewardError(
    `Refresh Rewards before ${action}. A request ID is required to protect your points.`, 428, 'request_id_required');
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[^\x20-\x7E]/.test(value))
    throw new RewardError('Request ID must contain 1 to 255 printable characters.');
  return value.trim();
}

/** Manual corrections append a distinct ledger entry. The permanent request
 * claim and signed delta commit together under SQLite's write reservation;
 * neither a timeout nor a process restart turns the retry into another credit.
 * References are validated once, then retained as historical provenance. */
export function createPointAdjustment(d, {actorId, userId, delta, reason, taskId = null,
  catalogId = null, ledgerId = null, requestKey, entryKind = 'adjust'}) {
  const key = validateRedemptionKey(requestKey, 'adjusting points');
  const identifier = (value, label, optional = false) => {
    if (optional && (value == null || value === '')) return null;
    if (!['number','string'].includes(typeof value) || String(value).trim() === ''
        || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
      throw new RewardError(`${label} must be a valid record ID.`);
    return Number(value);
  };
  userId = identifier(userId, 'Member');
  taskId = identifier(taskId, 'Related Task', true);
  catalogId = identifier(catalogId, 'Related Reward', true);
  ledgerId = identifier(ledgerId, 'Related ledger entry', true);
  if (!['number','string'].includes(typeof delta) || !Number.isSafeInteger(Number(delta))
      || Number(delta) === 0 || Math.abs(Number(delta)) > 1_000_000)
    throw new RewardError('Enter a non-zero whole number of points between -1,000,000 and 1,000,000.');
  delta = Number(delta);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200)
    throw new RewardError('Explain the adjustment in 1 to 200 characters.');
  reason = reason.trim();
  const type=entryKind==='bonus'&&delta>0?'bonus':'adjust';
  const fingerprint = JSON.stringify([userId,delta,reason,taskId,catalogId,ledgerId,type]);
  return d.transaction(() => {
    if (d.prepare('SELECT role FROM users WHERE id=?').get(actorId)?.role !== 'admin')
      throw new RewardError('Only a household administrator can adjust points.',403);
    const existing=d.prepare('SELECT * FROM reward_adjustment_requests WHERE actor_user_id=? AND request_key=?').get(actorId,key);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint)
        throw new RewardError('This request ID already belongs to a different points adjustment.',409,'request_id_conflict');
      const row=d.prepare('SELECT * FROM reward_ledger WHERE id=?').get(existing.ledger_id);
      if (!row) throw new RewardError('The original adjustment is no longer available. Its request ID cannot be reused.',410);
      return {row, balance:getBalance(d,userId), replayed:true};
    }
    if (!isEnrolled(d,userId) || d.prepare('SELECT 1 FROM housekeeping_workers WHERE user_id=?').get(userId))
      throw new RewardError('Choose a household member who participates in Rewards.');
    if (taskId && !d.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId))
      throw new RewardError('Related Task not found.',404);
    if (catalogId && !d.prepare('SELECT 1 FROM reward_catalog WHERE id=?').get(catalogId))
      throw new RewardError('Related Reward not found.',404);
    const referenced=ledgerId ? d.prepare('SELECT * FROM reward_ledger WHERE id=?').get(ledgerId) : null;
    if (ledgerId && !referenced) throw new RewardError('Related ledger entry not found.',404);
    if (referenced && referenced.user_id!==userId)
      throw new RewardError('The related ledger entry belongs to a different member.');
    if (referenced?.task_id && taskId && referenced.task_id!==taskId)
      throw new RewardError('The selected Task does not match the related ledger entry.');
    if (referenced?.redemption_id && catalogId) {
      const redemption=d.prepare('SELECT catalog_id FROM reward_redemptions WHERE id=?').get(referenced.redemption_id);
      if (redemption?.catalog_id && redemption.catalog_id!==catalogId)
        throw new RewardError('The selected Reward does not match the related ledger entry.');
    }
    const relatedTask=taskId || referenced?.task_id || null;
    const result=postLedger(d,{userId,delta,type,reason,taskId:relatedTask,createdBy:actorId});
    d.prepare(`INSERT INTO reward_adjustment_requests
      (actor_user_id,request_key,request_fingerprint,ledger_id,related_task_id,related_catalog_id,related_ledger_id)
      VALUES (?,?,?,?,?,?,?)`).run(actorId,key,fingerprint,result.lastInsertRowid,relatedTask,catalogId,ledgerId);
    return {row:d.prepare('SELECT * FROM reward_ledger WHERE id=?').get(result.lastInsertRowid),
      balance:getBalance(d,userId),replayed:false};
  }).immediate();
}

/** Check the current balance while holding SQLite's write reservation, then
 * atomically persist the intent, redemption and its one deduction. */
export function createRedemption(d, {actorId, userId, catalogId, note = null, requestKey, pendingDelivery = false}) {
  const key = validateRedemptionKey(requestKey);
  const fingerprint = JSON.stringify([userId, catalogId, note]);
  return d.transaction(() => {
    const existing = d.prepare('SELECT * FROM reward_redemption_requests WHERE actor_user_id=? AND request_key=?')
      .get(actorId, key);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint)
        throw new RewardError('This request ID already belongs to a different redemption.', 409, 'request_id_conflict');
      const row = d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(existing.redemption_id);
      if (!row) throw new RewardError('This redemption is no longer available. Its request cannot be reused.', 410);
      return {row, replayed: true};
    }
    const row=createRedemptionRecord(d,{actorId,userId,catalogId,note,pendingDelivery});
    d.prepare(`INSERT INTO reward_redemption_requests(actor_user_id,request_key,request_fingerprint,redemption_id)
      VALUES (?,?,?,?)`).run(actorId,key,fingerprint,row.id);
    return {row,replayed:false};
  }).immediate();
}

/** Internal atomic writer. The authorized adapter owns the durable request
 * claim and any delivery Task in this same reserved write transaction. */
export function createRedemptionRecord(d,{actorId=null,userId,catalogId,note=null,pendingDelivery=false,expectedCost}) {
  if(!d.inTransaction)throw new RewardError('Purchase must be coordinated.',409);
  const item=d.prepare('SELECT * FROM reward_catalog WHERE id=? AND is_active=1').get(catalogId);
  if(!item)throw new RewardError('Reward not found.',404);
  if(!Number.isSafeInteger(item.cost)||item.cost<0)throw new RewardError('This prize has an invalid point price.',409);
  if(expectedCost!==undefined&&item.cost!==expectedCost)throw new RewardError('This prize price changed. Review it before redeeming.',409,'reward_price_changed');
  if(!isEnrolled(d,userId))throw new RewardError('User does not participate in the reward system.');
  if(getBalance(d,userId)<item.cost)throw new RewardError('Insufficient points.',400,'insufficient_points');
  const autoFulfill=!pendingDelivery&&d.prepare("SELECT value FROM sync_config WHERE key='rewards_require_approval'").get()?.value==='0';
  const result=d.prepare(`INSERT INTO reward_redemptions
    (user_id,catalog_id,reward_name,reward_icon,cost,note,requested_by,status,decided_by,decided_at)
    VALUES(?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END)`)
    .run(userId,item.id,item.name,item.icon,item.cost,note,actorId,autoFulfill?'fulfilled':'pending',autoFulfill?actorId:null,autoFulfill?1:0);
  postLedger(d,{userId,delta:-item.cost,type:'redeem',reason:item.name,redemptionId:result.lastInsertRowid,createdBy:actorId});
  return d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(result.lastInsertRowid);
}

/** Decisions and refunds share one transaction. Identical retries are a no-op;
 * conflicting decisions cannot refund a fulfilled or already refunded request. */
export function decideRedemption(d, {actorId, isAdmin, redemptionId, action}) {
  if (!['fulfill','reject','cancel'].includes(action)) throw new RewardError('Invalid action.');
  return d.transaction(() => {
    const row = d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(redemptionId);
    if (!row) throw new RewardError('Redemption not found.',404);
    if ((action==='fulfill'||action==='reject')&&!isAdmin) throw new RewardError('Admin access required.',403);
    if (action==='cancel'&&!isAdmin&&row.user_id!==actorId) throw new RewardError('Not allowed.',403);
    if(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reward_fulfillment_task_links'").get()
      &&d.prepare('SELECT 1 FROM reward_fulfillment_task_links WHERE redemption_id=?').get(redemptionId))
      throw new RewardError('Use the parent prize fulfillment action for this redemption.',409);
    return applyRedemptionDecision(d,{actorId,redemptionId,action});
  }).immediate();
}

/** Internal state writer. Public adapters must authorize before calling it;
 * linked delivery must also coordinate the Task in the same outer transaction. */
export function applyRedemptionDecision(d,{actorId,redemptionId,action}) {
  if(!['fulfill','reject','cancel'].includes(action))throw new RewardError('Invalid action.');
  return d.transaction(()=>{
    const row=d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(redemptionId);
    if(!row)throw new RewardError('Redemption not found.',404);
    const status = action==='fulfill'?'fulfilled':action==='reject'?'rejected':'cancelled';
    if (row.status===status) return row;
    if (row.status!=='pending') throw new RewardError('Redemption already decided.',409);
    if (action!=='fulfill') postLedger(d,{userId:row.user_id,delta:row.cost,type:'reversal',
      reason:row.reward_name,redemptionId:row.id,createdBy:actorId});
    d.prepare(`UPDATE reward_redemptions SET status=?,decided_by=?,
      decided_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
      .run(status,actorId,row.id);
    return d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(row.id);
  }).immediate();
}

/** Freie Buchung (Bonus/Korrektur/Reversal) — vom Route-Handler genutzt. */
export function postLedger(d, { userId, delta, type, reason = null, taskId = null, redemptionId = null, createdBy = null }) {
  return d.prepare(REWARD_TX).run({
    user_id: userId,
    delta,
    type,
    reason,
    task_id: taskId,
    redemption_id: redemptionId,
    created_by: createdBy,
  });
}
