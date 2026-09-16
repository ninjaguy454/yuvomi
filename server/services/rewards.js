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

const REWARD_TX = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by)
  VALUES (@user_id, @delta, @type, @reason, @task_id, @redemption_id, @created_by)
`;

/** Aktueller Punktestand eines Mitglieds (Summe aller Ledger-Buchungen). */
export function getBalance(d, userId) {
  const row = d.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ?').get(userId);
  return row?.bal ?? 0;
}

/** IDs aller aktiv teilnehmenden Mitglieder. */
function enrolledIds(d) {
  return new Set(
    d.prepare('SELECT user_id FROM reward_participants WHERE enabled = 1').all().map((r) => r.user_id),
  );
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
  const enrolled = enrolledIds(d);
  const hasSupervision = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_supervision_actions'").get();
  let action = null;
  if (hasSupervision) {
    // Generated helper rows are views of the original action, not additional
    // point-bearing work. This also protects legacy rows with nonzero points.
    if (d.prepare(`SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=?
      UNION ALL SELECT 1 FROM task_activity_support_tasks WHERE task_id=? LIMIT 1`).get(taskId, taskId)) return [];
    action = d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(taskId);
    if (action?.execution_mode === 'delegated' && action.state !== 'not_required') {
      // A helper performs this action themselves. A stale structural learner
      // assignment must never credit the learner for prohibited work. A parent
      // occurrence's reward is not transferred to its helper by this projection.
      if (action.action_task_id === action.source_task_id) return [];
      return enrolled.has(action.supervisor_user_id) ? [action.supervisor_user_id] : [];
    }
  }
  const assignees = d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
    .all(taskId).map((r) => r.user_id);
  const targets = assignees.filter((id) => enrolled.has(id));
  if (targets.length) return targets;
  // A supervisor records completion for the learner. Checklist rows can
  // inherit that learner without a legacy assignment join of their own.
  if (hasSupervision) {
    const learner = action?.learner_user_id;
    if (learner) return enrolled.has(learner) ? [learner] : [];
    // Legacy parent occurrences may have assigned_to without the assignment
    // join. Finishing the helper's final action must not give it that reward.
    const source = d.prepare(`SELECT t.assigned_to FROM tasks t WHERE t.id=?
      AND EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.source_task_id=t.id)`).get(taskId);
    if (source?.assigned_to) return enrolled.has(source.assigned_to) ? [source.assigned_to] : [];
  }
  if (actingUserId && enrolled.has(actingUserId)) return [actingUserId];
  return [];
}

/** One award per occurrence, with the recipients frozen at the first award.
 * The claim and every ledger row commit together, including through callers
 * outside the Task lifecycle. Regenerated rows share their original logical
 * series/date/action claim; reopening, deletion and retries cannot award twice. */
export function awardForCompletion(d, taskId, actingUserId) {
  return d.transaction(() => {
    const task = d.prepare('SELECT id, points, title FROM tasks WHERE id = ?').get(taskId);
    if (!task || !Number.isInteger(task.points) || task.points <= 0) return false;
    if (taskWindowAncestors(d,taskId).some(row=>row.status==='expired')) return false;
    const targets = rewardTargets(d, taskId, actingUserId);
    if (!targets.length) return false;
    const provenance=rewardOccurrenceProvenance(d,taskId);
    if(provenance.retired)return false;
    const claim = d.prepare('INSERT OR IGNORE INTO reward_task_awards(task_id,logical_key) VALUES (?,?)').run(taskId,provenance.logicalKey);
    if (!claim.changes) return false;
    const ins = d.prepare(`INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, created_by)
      VALUES (?, ?, 'earn', ?, ?, ?)`);
    for (const uid of targets) ins.run(uid, task.points, task.title || null, taskId, actingUserId || null);
    return true;
  }).immediate();
}

/** Compatibility export: reopening is operational state, never ledger erasure.
 * An administrator can make an explicit, reasoned adjustment when needed. */
export function reverseTaskEarnings(_d, _taskId) {}

/**
 * Award the first rewardable completion. Historical earnings survive reopening.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId);
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
export function createRedemption(d, {actorId, userId, catalogId, note = null, requestKey}) {
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
    const item = d.prepare('SELECT * FROM reward_catalog WHERE id=? AND is_active=1').get(catalogId);
    if (!item) throw new RewardError('Reward not found.', 404);
    if (!isEnrolled(d, userId)) throw new RewardError('User does not participate in the reward system.');
    if (getBalance(d, userId) < item.cost) throw new RewardError('Insufficient points.');
    const autoFulfill = d.prepare("SELECT value FROM sync_config WHERE key='rewards_require_approval'").get()?.value === '0';
    const result = d.prepare(`INSERT INTO reward_redemptions
      (user_id,catalog_id,reward_name,reward_icon,cost,note,requested_by,status,decided_by,decided_at)
      VALUES (?,?,?,?,?,?,?, ?,?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END)`)
      .run(userId,item.id,item.name,item.icon,item.cost,note,actorId,autoFulfill?'fulfilled':'pending',
        autoFulfill?actorId:null,autoFulfill?1:0);
    postLedger(d, {userId,delta:-item.cost,type:'redeem',reason:item.name,
      redemptionId:result.lastInsertRowid,createdBy:actorId});
    d.prepare(`INSERT INTO reward_redemption_requests(actor_user_id,request_key,request_fingerprint,redemption_id)
      VALUES (?,?,?,?)`).run(actorId,key,fingerprint,result.lastInsertRowid);
    return {row:d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(result.lastInsertRowid),replayed:false};
  }).immediate();
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
