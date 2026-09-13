/**
 * Modul: Rewards (Belohnungen)
 * Zweck: Punkte-Vergabe bei Aufgaben-Erledigung und Salden-Berechnung aus dem
 *        Ledger. Der Punktestand eines Mitglieds ist immer SUM(delta) über
 *        reward_ledger — es gibt keinen separat gepflegten Saldo, der driften
 *        könnte.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben.
 */

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

/**
 * Punkte für eine erledigte Aufgabe gutschreiben. Idempotent: der partielle
 * UNIQUE-Index (task_id, user_id) WHERE type='earn' verhindert Doppelvergabe,
 * falls der Statuswechsel mehrfach eintrifft.
 */
export function awardForCompletion(d, taskId, actingUserId) {
  const task = d.prepare('SELECT id, points, title FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId);
  if (!targets.length) return;
  const ins = d.prepare(`INSERT OR IGNORE INTO ${'reward_ledger'} (user_id, delta, type, reason, task_id, created_by)
    VALUES (?, ?, 'earn', ?, ?, ?)`);
  for (const uid of targets) {
    ins.run(uid, task.points, task.title || null, taskId, actingUserId || null);
  }
}

/**
 * Vergabe zurücknehmen, wenn eine Aufgabe von 'done' zurückgesetzt wird. Die
 * earn-Buchungen werden entfernt (nicht per Gegenbuchung), damit ein erneutes
 * Erledigen sauber neu vergibt und der Ledger nicht mit Toggle-Rauschen wächst.
 */
export function reverseTaskEarnings(d, taskId) {
  d.prepare("DELETE FROM reward_ledger WHERE task_id = ? AND type = 'earn'").run(taskId);
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und storniert beim Verlassen von 'done'. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId);
  else if (wasDone && !isDone) reverseTaskEarnings(d, taskId);
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
