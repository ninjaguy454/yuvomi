import { todayKey, householdTimeZone } from '../utils/timezone.js';
import { activityPresenceWindow, evaluateAvailability, availabilityInstantMs } from './presence.js';
import { assertTaskMemberSkills } from './task-skills.js';
import { notifyTaskObligations, notifyTaskClaim } from './notification-events.js';
import { inspectTaskSupervision, reconcileTaskSupervision, assertTaskSupervisionAssignee, TaskSupervisionError } from './task-supervision.js';
import {
  assertEligibleActivityMember,
  eligibleMembersForActivity,
  sharedEligibleInterval,
} from './activity-eligibility.js';

function nowSql() {
  return "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
}

function activityForTask(d, taskId) {
  return d.prepare(`
    SELECT a.*, b.subject_user_id
      FROM task_activity_bindings b
      JOIN activity_templates a ON a.id = b.activity_template_id
     WHERE b.task_id = ?
  `).get(taskId) ?? null;
}

function taskWindow(d, taskId, taskOverride = null) {
  const stored = d.prepare(`
    SELECT t.*, pc.place_id, pc.presence_policy, pc.presence_window
      FROM tasks t
      LEFT JOIN task_planning_context pc ON pc.task_id = t.id
     WHERE t.id = ?
  `).get(taskId);
  if (!stored) throw new Error('Task not found.');
  const task = { ...stored, ...(taskOverride || {}) };
  const dateKey = task.due_date || task.start_date || todayKey(d);
  return {
    task,
    dateKey,
    presence: {
      policy: task.presence_policy || 'ignore',
      targetPlaceId: task.place_id || null,
      ...activityPresenceWindow(d, { task, dateKey, windowMode: task.presence_window || 'due' }),
    },
  };
}

export class TaskAssignmentAvailabilityError extends Error {}

/** Revalidate existing people without consuming a rotation or rewriting work.
 * Task planning context is the occurrence's policy, including Workflow overrides.
 * Beneficiaries and people visible only through their own subtasks are not
 * performers of this Task and must not block editing its time window.
 */
export function assertTaskAssignmentAvailability(d, taskId, userIds = null, { task = null } = {}) {
  const window = taskWindow(d, taskId, task);
  if (window.presence.policy === 'ignore') return;
  const performers = d.prepare(`SELECT user_id, role FROM task_responsibilities WHERE task_id = ?
    AND status = 'active' AND role IN ('primary', 'participant', 'supervisor')
    AND source != 'subtasks'`).all(taskId);
  const linkedSupervision = inspectTaskSupervision(d, taskId).actions.length > 0;
  const operationalPerformers = linkedSupervision ? performers.filter(row => row.role !== 'supervisor') : performers;
  const supervised = operationalPerformers.some((row) => row.role === 'supervisor');
  const selected = [...(userIds ?? [
    window.task.assigned_to,
    ...operationalPerformers.map((row) => row.user_id),
  ])];
  if (supervised) selected.push(...operationalPerformers.map((row) => row.user_id));
  const results = [];
  for (const userId of new Set(selected.filter(Boolean).map(Number))) {
    let result = null;
    try { result = evaluateAvailability(d, { ...window.presence, userId }); }
    catch { /* Invalid windows fail closed, using the same public requirement error. */ }
    if (!result?.eligible) {
      const requirement = window.presence.policy === 'available_before_due' ? 'availability' : 'location';
      throw new TaskAssignmentAvailabilityError(`The assignee does not meet this Task's ${requirement} requirement for its scheduled time.`);
    }
    results.push(result);
  }
  if (supervised && !sharedEligibleInterval(results, window.presence.requiredDurationMinutes)) {
    throw new TaskAssignmentAvailabilityError('The learner and supervisor do not share an available window for this Task.');
  }
}

function eligibleStandaloneClaimMember(d, taskId, userId) {
  const eligible = d.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.role, u.family_role
      FROM task_claim_eligibility tce
      JOIN users u ON u.id = tce.user_id
     WHERE tce.task_id = ? AND tce.user_id = ?
  `).get(taskId, userId);
  if (!eligible) {
    const trip = d.prepare(`
      SELECT tal.source_id AS planning_context_id, pc.status AS context_status
        FROM task_action_links tal
        LEFT JOIN planning_contexts pc ON pc.id = tal.source_id
       WHERE tal.task_id = ? AND tal.action_type = 'travel_meal_plan'
         AND tal.source_type = 'planning_context'
       LIMIT 1
    `).get(taskId);
    if (trip) {
      if (!trip.context_status || ['cancelled', 'completed'].includes(trip.context_status)) {
        d.prepare(`
          UPDATE task_assignment_context SET state = 'cancelled', updated_at = ${nowSql()}
           WHERE task_id = ? AND state != 'fulfilled'
        `).run(taskId);
        d.prepare(`
          UPDATE planning_obligations SET status = 'cancelled', responded_at = ${nowSql()},
            updated_at = ${nowSql()}
           WHERE task_id = ? AND status IN ('pending', 'accepted')
        `).run(taskId);
        throw new Error('This trip is no longer active, so this task cannot be claimed.');
      }
      throw new Error("You're not eligible because you're not on this trip. Only travelers on this trip can claim this task.");
    }
    throw new Error('You are not eligible for this task.');
  }
  return eligible;
}

function replaceLegacyAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const insert = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const id of new Set(userIds.filter(Boolean).map(Number))) insert.run(taskId, id);
}

function addResponsibility(d, taskId, userId, role, source = 'assignment') {
  if (!userId) return;
  d.prepare(`
    INSERT INTO task_responsibilities (task_id, user_id, role, source, updated_at)
    VALUES (?, ?, ?, ?, ${nowSql()})
    ON CONFLICT(task_id, user_id, role) DO UPDATE SET
      status = 'active', source = excluded.source, updated_at = excluded.updated_at
  `).run(taskId, userId, role, source);
}

function supersedeActiveTaskObligations(d, taskId, role = 'primary') {
  d.prepare(`
    UPDATE planning_obligations
       SET status = 'superseded', responded_at = ${nowSql()}, updated_at = ${nowSql()}
     WHERE task_id = ? AND role = ? AND status IN ('pending', 'accepted')
  `).run(taskId, role);
}

function nextAttempt(d, taskId, role) {
  return Number(d.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM planning_obligations WHERE task_id = ? AND role = ?')
    .get(taskId, role)?.n || 1);
}

function createTaskObligation(d, taskId, userId, {
  role = 'primary',
  group = null,
  dueAt = null,
  parentObligationId = null,
  fallbackSource = null,
  metadata = null,
  status = 'pending',
} = {}) {
  const attempt = nextAttempt(d, taskId, role);
  const logicalKey = `task:${taskId}:${role}:attempt:${attempt}`;
  const result = d.prepare(`
    INSERT INTO planning_obligations (
      entity_type, entity_id, task_id, logical_key, role, responsible_user_id,
      responsible_group, due_at, response_deadline, status, attempt,
      parent_obligation_id, fallback_source, metadata_json
    ) VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, taskId, logicalKey, role, userId || null, group, dueAt, dueAt, status,
    attempt, parentObligationId, fallbackSource, metadata ? JSON.stringify(metadata) : null,
  );
  return Number(result.lastInsertRowid);
}

function event(d, obligationId, name, actorUserId = null, details = null) {
  const result = d.prepare(`
    INSERT INTO planning_obligation_events (obligation_id, event, actor_user_id, details_json)
    VALUES (?, ?, ?, ?)
  `).run(obligationId, name, actorUserId, details ? JSON.stringify(details) : null);
  return Number(result.lastInsertRowid);
}

export function recordTaskAssignment(d, taskId, activity, resolution, {
  source = 'activity_template',
  strategy = null,
  createObligation = true,
} = {}) {
  const policy = strategy || resolution.strategy || activity.assignment_policy || activity.assignment_strategy;
  const participants = resolution.participants?.length
    ? resolution.participants
    : (resolution.primary ? [resolution.primary] : []);
  const state = resolution.unavailable ? 'unavailable' : (resolution.primary ? 'assigned' : 'open');
  // A first-class subtask can make somebody a participant of its parent even
  // when that person is not selected by the parent's Activity policy. Those
  // rows are authored by the Task/subtask model, not by this binding. Keep
  // them active while the Activity-owned responsibilities are refreshed and
  // retain the same people in the legacy visibility assignment table.
  const subtaskParticipantIds = d.prepare(`
    SELECT user_id
      FROM task_responsibilities
     WHERE task_id = ? AND role = 'participant'
       AND source = 'subtasks' AND status = 'active'
     ORDER BY user_id
  `).all(taskId).map((row) => Number(row.user_id));
  d.prepare(`
    INSERT INTO task_assignment_context (
      task_id, strategy, state, override_allowed, beneficiary_user_id, source, rotation_key, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ${nowSql()})
    ON CONFLICT(task_id) DO UPDATE SET
      strategy = excluded.strategy, state = excluded.state,
      override_allowed = excluded.override_allowed,
      beneficiary_user_id = excluded.beneficiary_user_id,
      source = excluded.source, rotation_key = excluded.rotation_key,
      updated_at = excluded.updated_at
  `).run(
    taskId, policy, state, activity.allow_assignment_override === 0 ? 0 : 1,
    resolution.subject?.id || null, source,
    activity.rotation_group || `activity:${activity.id}`,
  );

  d.prepare(`
    UPDATE task_responsibilities
       SET status = 'superseded', updated_at = ${nowSql()}
     WHERE task_id = ? AND status = 'active'
       AND NOT (role = 'participant' AND source = 'subtasks')
  `)
    .run(taskId);
  if (resolution.primary) addResponsibility(d, taskId, resolution.primary.id, 'primary', source);
  for (const participant of participants) addResponsibility(d, taskId, participant.id, 'participant', source);
  if (resolution.subject) addResponsibility(d, taskId, resolution.subject.id, 'beneficiary', source);
  // Template previews only know the parent requirements. The concrete Task's
  // linked resolver selects one helper after its entire checklist exists.
  replaceLegacyAssignments(d, taskId, [
    ...participants.map((row) => row.id),
    ...subtaskParticipantIds,
  ]);

  d.prepare(`UPDATE planning_obligations SET status = 'superseded', responded_at = ${nowSql()}, updated_at = ${nowSql()} WHERE task_id = ? AND status IN ('pending', 'accepted')`)
    .run(taskId);
  if (createObligation && (resolution.primary || policy === 'open_claimable')) {
    const dueAt = taskWindow(d, taskId).task.due_date
      ? `${taskWindow(d, taskId).task.due_date}T${taskWindow(d, taskId).task.due_time || '23:59'}:00`
      : null;
    const primaryId = createTaskObligation(d, taskId, resolution.primary?.id || null, {
      group: policy === 'open_claimable' ? `eligible:activity:${activity.id}` : null,
      dueAt,
      metadata: { strategy: policy, activity_template_id: activity.id },
    });
    for (const participant of participants.filter((row) => Number(row.id) !== Number(resolution.primary?.id))) {
      createTaskObligation(d, taskId, participant.id, {
        role: 'participant', dueAt, metadata: { strategy: policy, activity_template_id: activity.id },
      });
    }
    notifyTaskObligations(d, taskId, { eligibleIds: (resolution.eligible || []).map((member) => member.id) });
    return primaryId;
  }
  return null;
}

export function listTaskResponsibilities(d, taskIds) {
  if (!taskIds.length) return {};
  const rows = d.prepare(`
    SELECT tr.*, u.display_name, u.avatar_color, u.avatar_data
      FROM task_responsibilities tr
      JOIN users u ON u.id = tr.user_id
     WHERE tr.task_id IN (${taskIds.map(() => '?').join(',')}) AND tr.status = 'active'
     ORDER BY tr.task_id, tr.role, u.display_name COLLATE NOCASE
  `).all(...taskIds);
  return rows.reduce((out, row) => {
    (out[row.task_id] ||= []).push(row);
    return out;
  }, {});
}

export function claimTask(d, taskId, userId) {
  return d.transaction(() => {
    const context = d.prepare("SELECT * FROM task_assignment_context WHERE task_id = ? AND strategy = 'open_claimable'").get(taskId);
    if (!context) throw new Error('This task is not claimable.');
    if (!['open', 'unavailable'].includes(context.state)) throw new Error('This task has already been claimed.');
    const activity = activityForTask(d, taskId);
    let member;
    if (activity) {
      // Activity-backed claimability keeps its full skill, supervision and
      // presence checks. A stray standalone eligibility row must never weaken
      // those existing safety rules.
      const window = taskWindow(d, taskId);
      member = assertEligibleActivityMember(d, activity, userId, window);
    } else {
      if (!['planning_context', 'meal_execution'].includes(context.source)) {
        throw new Error('The Activity Template for this task is unavailable.');
      }
      // Planning contexts can intentionally create a claimable Task without an
      // Activity Template. Their explicit eligibility rows are the complete,
      // occurrence-local pool; absence from that pool is a hard denial.
      member = eligibleStandaloneClaimMember(d, taskId, userId);
      assertTaskMemberSkills(d, taskId, userId);
      assertTaskAssignmentAvailability(d, taskId, [userId]);
    }
    assertTaskSupervisionAssignee(d, taskId, member.id);
    const changed = d.prepare(`
      UPDATE task_assignment_context SET state = 'assigned', updated_at = ${nowSql()}
       WHERE task_id = ? AND state IN ('open', 'unavailable')
    `).run(taskId);
    if (changed.changes !== 1) throw new Error('This task was claimed by someone else.');
    d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(member.id, taskId);
    const subtaskParticipants = d.prepare(`SELECT user_id FROM task_responsibilities
      WHERE task_id = ? AND role = 'participant' AND source = 'subtasks' AND status = 'active'`)
      .all(taskId).map((row) => row.user_id);
    replaceLegacyAssignments(d, taskId, [member.id, ...subtaskParticipants]);
    d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()}
      WHERE task_id = ? AND role IN ('primary', 'participant') AND status = 'active'
      AND source != 'subtasks'`).run(taskId);
    addResponsibility(d, taskId, member.id, 'primary', 'claim');
    addResponsibility(d, taskId, member.id, 'participant', 'claim');
    const open = d.prepare("SELECT * FROM planning_obligations WHERE task_id = ? AND role = 'primary' AND status = 'pending' ORDER BY attempt DESC LIMIT 1").get(taskId);
    if (open) {
      d.prepare(`UPDATE planning_obligations SET responsible_user_id = ?, responsible_group = NULL, status = 'accepted', responded_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = ?`)
        .run(member.id, open.id);
      const eventId = event(d, open.id, 'claimed', userId);
      notifyTaskClaim(d, taskId, eventId, userId);
    } else {
      notifyTaskClaim(d, taskId, null, userId);
    }
    reconcileTaskSupervision(d, taskId, { actorId: userId });
    return { task_id: Number(taskId), assigned_to: member, state: 'assigned' };
  })();
}

export function overrideTaskAssignment(d, taskId, targetUserId, actorUserId) {
  return d.transaction(() => {
    const context = d.prepare('SELECT * FROM task_assignment_context WHERE task_id = ?').get(taskId);
    if (!context) throw new Error('This task is not managed by an assignment policy.');
    if (!context.override_allowed) throw new Error('Assignment overrides are disabled for this activity.');
    const activity = activityForTask(d, taskId);
    // Context-backed open Tasks have no Activity Template. Their explicit
    // claim pool is still a hard eligibility boundary for administrator
    // reassignment, just as Activity-backed Tasks retain their full checks.
    if (!activity && !['planning_context', 'meal_execution'].includes(context.source)) {
      throw new Error('The Activity Template for this task is unavailable.');
    }
    const member = activity
      ? assertEligibleActivityMember(d, activity, targetUserId, taskWindow(d, taskId))
      : eligibleStandaloneClaimMember(d, taskId, targetUserId);
    if (!activity) {
      assertTaskMemberSkills(d, taskId, targetUserId);
      assertTaskAssignmentAvailability(d, taskId, [targetUserId]);
    }
    assertTaskSupervisionAssignee(d, taskId, member.id);
    supersedeActiveTaskObligations(d, taskId);
    d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()} WHERE task_id = ? AND role IN ('primary', 'participant') AND status = 'active'`).run(taskId);
    d.prepare(`UPDATE task_assignment_context SET state = 'assigned', updated_at = ${nowSql()} WHERE task_id = ?`).run(taskId);
    d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(member.id, taskId);
    replaceLegacyAssignments(d, taskId, [member.id]);
    addResponsibility(d, taskId, member.id, 'primary', 'manual_override');
    addResponsibility(d, taskId, member.id, 'participant', 'manual_override');
    const id = createTaskObligation(d, taskId, member.id, {
      dueAt: taskWindow(d, taskId).task.due_date ? `${taskWindow(d, taskId).task.due_date}T${taskWindow(d, taskId).task.due_time || '23:59'}:00` : null,
      fallbackSource: 'manual_override', metadata: { actor_user_id: actorUserId },
    });
    event(d, id, 'override_assigned', actorUserId, { target_user_id: member.id });
    reconcileTaskSupervision(d, taskId, { actorId: actorUserId });
    notifyTaskObligations(d, taskId);
    return { task_id: Number(taskId), assigned_to: member, state: 'assigned' };
  })();
}

export function respondToTaskObligation(d, obligationId, action, actorUserId, note = null) {
  return d.transaction(() => {
    const obligation = d.prepare("SELECT * FROM planning_obligations WHERE id = ? AND entity_type = 'task'").get(obligationId);
    if (!obligation) throw new Error('Assignment request not found.');
    if (!['pending', 'accepted'].includes(obligation.status)) throw new Error('This assignment request is already closed.');
    if (action !== 'timeout' && obligation.responsible_user_id && Number(obligation.responsible_user_id) !== Number(actorUserId)) {
      throw new Error('This assignment request belongs to another household member.');
    }
    if (action === 'accept') {
      const supervision = inspectTaskSupervision(d, obligation.task_id);
      if (obligation.role === 'supervisor') {
        const pending = supervision.actions.filter(row => !row.completed && row.state !== 'not_required');
        if (Number(supervision.supervisor_user_id) !== Number(actorUserId) || !pending.length
          || pending.some(row => row.state !== 'assigned' || Number(row.supervisor_user_id) !== Number(actorUserId))) {
          throw new TaskSupervisionError('This supervision assignment is no longer current. Open the Task to review its supervision requirements.');
        }
      } else assertTaskSupervisionAssignee(d, obligation.task_id, obligation.responsible_user_id || actorUserId);
      if (obligation.role !== 'supervisor') assertTaskAssignmentAvailability(d, obligation.task_id, [obligation.responsible_user_id || actorUserId]);
      d.prepare(`UPDATE planning_obligations SET status = 'accepted', responded_at = ${nowSql()}, response_note = ?, updated_at = ${nowSql()} WHERE id = ?`)
        .run(note, obligation.id);
      event(d, obligation.id, 'accepted', actorUserId);
      return d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id);
    }
    if (!['decline', 'timeout'].includes(action)) throw new Error('Choose accept or decline.');
    const closedStatus = action === 'timeout' ? 'timed_out' : 'declined';
    d.prepare(`UPDATE planning_obligations SET status = ?, responded_at = ${nowSql()}, response_note = ?, updated_at = ${nowSql()} WHERE id = ?`)
      .run(closedStatus, note, obligation.id);
    event(d, obligation.id, closedStatus, actorUserId);

    if (obligation.role === 'supervisor' && inspectTaskSupervision(d, obligation.task_id).actions.length) {
      // One refusal applies to the entire remaining supervised scope. Never
      // select independent fallbacks that split a Task across several helpers.
      const supervision = inspectTaskSupervision(d, obligation.task_id);
      if (supervision.supervisor_user_id && Number(supervision.supervisor_user_id) !== Number(obligation.responsible_user_id)) {
        // A delayed response to an older request cannot replace the current
        // Task supervisor. Reconciliation retires any legacy duplicate role.
        reconcileTaskSupervision(d, obligation.task_id, { actorId: actorUserId });
        return { ...d.prepare('SELECT * FROM planning_obligations WHERE id=?').get(obligation.id), fallback: null };
      }
      const attempted = new Set(d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('declined','timed_out')")
        .all(obligation.task_id).map(row => Number(row.responsible_user_id)));
      const replacement = supervision.eligible_supervisors.find(member => !attempted.has(Number(member.id))) || null;
      reconcileTaskSupervision(d, obligation.task_id, { actorId: actorUserId,
        supervisorUserId: replacement?.id || null });
      return { ...d.prepare('SELECT * FROM planning_obligations WHERE id=?').get(obligation.id), fallback: replacement };
    }

    const activity = activityForTask(d, obligation.task_id);
    if (obligation.role !== 'primary') {
      const window = taskWindow(d, obligation.task_id);
      const used = new Set(d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id = ? AND status = 'active'")
        .all(obligation.task_id).map((row) => Number(row.user_id)));
      const attempted = new Set(d.prepare('SELECT responsible_user_id FROM planning_obligations WHERE task_id = ? AND role = ? AND responsible_user_id IS NOT NULL')
        .all(obligation.task_id, obligation.role).map((row) => Number(row.responsible_user_id)));
      const replacement = activity
        ? eligibleMembersForActivity(d, activity, { ...window,
          simultaneousUserIds: obligation.role === 'supervisor' ? [window.task.assigned_to] : [],
        }).find((member) => !used.has(Number(member.id)) && !attempted.has(Number(member.id)))
        : null;
      d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()} WHERE task_id = ? AND user_id = ? AND role = ? AND status = 'active'`)
        .run(obligation.task_id, obligation.responsible_user_id, obligation.role);
      if (!replacement) return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: null };
      addResponsibility(d, obligation.task_id, replacement.id, obligation.role, 'fallback');
      if (obligation.role === 'participant') {
        const visible = d.prepare("SELECT DISTINCT user_id FROM task_responsibilities WHERE task_id = ? AND role IN ('primary', 'participant') AND status = 'active'")
          .all(obligation.task_id).map((row) => row.user_id);
        replaceLegacyAssignments(d, obligation.task_id, visible);
      }
      const replacementId = createTaskObligation(d, obligation.task_id, replacement.id, {
        role: obligation.role, dueAt: obligation.due_at, parentObligationId: obligation.id,
        fallbackSource: `${closedStatus}:${obligation.responsible_user_id}`,
      });
      event(d, replacementId, 'fallback_assigned', actorUserId, { previous_obligation_id: obligation.id });
      notifyTaskObligations(d, obligation.task_id);
      return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: replacement, replacement_obligation_id: replacementId };
    }
    const previous = d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id = ? AND role = 'primary' AND responsible_user_id IS NOT NULL")
      .all(obligation.task_id).map((row) => Number(row.responsible_user_id));
    const window = taskWindow(d, obligation.task_id);
    const fallback = activity
      ? eligibleMembersForActivity(d, activity, window).find((member) => {
        if (previous.includes(Number(member.id))) return false;
        try { assertTaskSupervisionAssignee(d, obligation.task_id, member.id); return true; } catch { return false; }
      })
      : null;
    if (!fallback) {
      d.prepare(`UPDATE task_assignment_context SET state = 'unavailable', updated_at = ${nowSql()} WHERE task_id = ?`).run(obligation.task_id);
      d.prepare('UPDATE tasks SET assigned_to = NULL WHERE id = ?').run(obligation.task_id);
      // The declined person no longer performs the parent Task. Keep any
      // separately authored subtask visibility and other participants intact.
      d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()}
        WHERE task_id = ? AND user_id = ? AND role IN ('primary', 'participant')
          AND status = 'active' AND source != 'subtasks'`).run(obligation.task_id, obligation.responsible_user_id);
      const remainingParticipants = d.prepare(`SELECT DISTINCT user_id FROM task_responsibilities
        WHERE task_id = ? AND role IN ('primary', 'participant') AND status = 'active'`)
        .all(obligation.task_id).map((row) => row.user_id);
      replaceLegacyAssignments(d, obligation.task_id, remainingParticipants);
      reconcileTaskSupervision(d, obligation.task_id, { actorId: actorUserId });
      return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: null };
    }
    d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()} WHERE task_id = ? AND role IN ('primary', 'participant') AND status = 'active'`).run(obligation.task_id);
    d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(fallback.id, obligation.task_id);
    replaceLegacyAssignments(d, obligation.task_id, [fallback.id]);
    addResponsibility(d, obligation.task_id, fallback.id, 'primary', 'fallback');
    addResponsibility(d, obligation.task_id, fallback.id, 'participant', 'fallback');
    const replacementId = createTaskObligation(d, obligation.task_id, fallback.id, {
      dueAt: obligation.due_at, parentObligationId: obligation.id,
      fallbackSource: `${closedStatus}:${obligation.responsible_user_id || 'open'}`,
      metadata: { base_strategy: d.prepare('SELECT strategy FROM task_assignment_context WHERE task_id = ?').get(obligation.task_id)?.strategy },
    });
    event(d, replacementId, 'fallback_assigned', actorUserId, { previous_obligation_id: obligation.id });
    reconcileTaskSupervision(d, obligation.task_id, { actorId: actorUserId });
    notifyTaskObligations(d, obligation.task_id);
    return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: fallback, replacement_obligation_id: replacementId };
  })();
}

export function obligationInbox(d, userId, { includeAll = false, nowAt = new Date().toISOString() } = {}) {
  const timezone = householdTimeZone(d), nowMs = availabilityInstantMs(nowAt, timezone);
  const expired = d.prepare(`
    SELECT o.* FROM planning_obligations o
     WHERE o.entity_type = 'task' AND o.status IN ('pending', 'accepted')
       AND o.response_deadline IS NOT NULL
     ORDER BY o.id
  `).all().filter(row => {
    // Legacy linked helpers used the Task due time as an implicit response
    // deadline. Read-time timeout must not strip overdue supervision work.
    if (row.role === 'supervisor' && row.response_deadline === row.due_at
      && d.prepare('SELECT 1 FROM task_supervision_actions WHERE source_task_id=? AND supervisor_user_id=?').get(row.task_id,row.responsible_user_id)) return false;
    const deadlineMs = availabilityInstantMs(row.response_deadline, timezone);
    return deadlineMs != null && nowMs != null && deadlineMs <= nowMs;
  });
  for (const row of expired) {
    try { respondToTaskObligation(d, row.id, 'timeout', row.responsible_user_id || null); } catch { /* keep the inbox readable */ }
  }
  const where = includeAll ? '' : 'AND o.responsible_user_id = ?';
  return d.prepare(`
    SELECT o.*, t.title AS task_title, t.revision AS task_revision, m.title AS meal_title, m.date AS meal_date,
           u.display_name AS responsible_name
      FROM planning_obligations o
      LEFT JOIN tasks t ON t.id = o.task_id
      LEFT JOIN meals m ON o.entity_type = 'meal' AND m.id = o.entity_id
      LEFT JOIN users u ON u.id = o.responsible_user_id
     WHERE o.status IN ('pending', 'accepted') ${where}
     ORDER BY COALESCE(o.response_deadline, o.due_at, '9999-12-31'), o.id
  `).all(...(includeAll ? [] : [userId]));
}
