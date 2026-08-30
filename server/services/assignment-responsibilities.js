import { todayKey } from '../utils/timezone.js';
import {
  assertEligibleActivityMember,
  eligibleMembersForActivity,
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

function taskWindow(d, taskId) {
  const task = d.prepare(`
    SELECT t.*, pc.place_id, pc.presence_policy
      FROM tasks t
      LEFT JOIN task_planning_context pc ON pc.task_id = t.id
     WHERE t.id = ?
  `).get(taskId);
  if (!task) throw new Error('Task not found.');
  const dateKey = task.due_date || task.start_date || todayKey(d);
  return {
    task,
    dateKey,
    presence: {
      policy: task.presence_policy || 'ignore',
      targetPlaceId: task.place_id || null,
      startAt: `${task.start_date || dateKey}T00:00:00`,
      endAt: `${dateKey}T${task.due_time || '23:59'}:00`,
    },
  };
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
  d.prepare(`
    INSERT INTO planning_obligation_events (obligation_id, event, actor_user_id, details_json)
    VALUES (?, ?, ?, ?)
  `).run(obligationId, name, actorUserId, details ? JSON.stringify(details) : null);
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

  d.prepare(`UPDATE task_responsibilities SET status = 'superseded', updated_at = ${nowSql()} WHERE task_id = ? AND status = 'active'`)
    .run(taskId);
  if (resolution.primary) addResponsibility(d, taskId, resolution.primary.id, 'primary', source);
  for (const participant of participants) addResponsibility(d, taskId, participant.id, 'participant', source);
  if (resolution.subject) addResponsibility(d, taskId, resolution.subject.id, 'beneficiary', source);
  if (resolution.supervisor) addResponsibility(d, taskId, resolution.supervisor.id, 'supervisor', source);
  replaceLegacyAssignments(d, taskId, participants.map((row) => row.id));

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
    if (resolution.supervisor) {
      createTaskObligation(d, taskId, resolution.supervisor.id, {
        role: 'supervisor', dueAt, metadata: { strategy: policy, activity_template_id: activity.id },
      });
    }
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
    if (context.state !== 'open') throw new Error('This task has already been claimed.');
    const activity = activityForTask(d, taskId);
    if (!activity) throw new Error('The Activity Template for this task is unavailable.');
    const window = taskWindow(d, taskId);
    const member = assertEligibleActivityMember(d, activity, userId, window);
    const changed = d.prepare(`
      UPDATE task_assignment_context SET state = 'assigned', updated_at = ${nowSql()}
       WHERE task_id = ? AND state = 'open'
    `).run(taskId);
    if (changed.changes !== 1) throw new Error('This task was claimed by someone else.');
    d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(member.id, taskId);
    replaceLegacyAssignments(d, taskId, [member.id]);
    addResponsibility(d, taskId, member.id, 'primary', 'claim');
    addResponsibility(d, taskId, member.id, 'participant', 'claim');
    const open = d.prepare("SELECT * FROM planning_obligations WHERE task_id = ? AND role = 'primary' AND status = 'pending' ORDER BY attempt DESC LIMIT 1").get(taskId);
    if (open) {
      d.prepare(`UPDATE planning_obligations SET responsible_user_id = ?, responsible_group = NULL, status = 'accepted', responded_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = ?`)
        .run(member.id, open.id);
      event(d, open.id, 'claimed', userId);
    }
    return { task_id: Number(taskId), assigned_to: member, state: 'assigned' };
  })();
}

export function overrideTaskAssignment(d, taskId, targetUserId, actorUserId) {
  return d.transaction(() => {
    const context = d.prepare('SELECT * FROM task_assignment_context WHERE task_id = ?').get(taskId);
    if (!context) throw new Error('This task is not managed by an assignment policy.');
    if (!context.override_allowed) throw new Error('Assignment overrides are disabled for this activity.');
    const activity = activityForTask(d, taskId);
    if (!activity) throw new Error('The Activity Template for this task is unavailable.');
    const member = assertEligibleActivityMember(d, activity, targetUserId, taskWindow(d, taskId));
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

    const activity = activityForTask(d, obligation.task_id);
    if (obligation.role !== 'primary') {
      const window = taskWindow(d, obligation.task_id);
      const used = new Set(d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id = ? AND status = 'active'")
        .all(obligation.task_id).map((row) => Number(row.user_id)));
      const attempted = new Set(d.prepare('SELECT responsible_user_id FROM planning_obligations WHERE task_id = ? AND role = ? AND responsible_user_id IS NOT NULL')
        .all(obligation.task_id, obligation.role).map((row) => Number(row.responsible_user_id)));
      const replacement = activity
        ? eligibleMembersForActivity(d, activity, window).find((member) => !used.has(Number(member.id)) && !attempted.has(Number(member.id)))
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
      return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: replacement, replacement_obligation_id: replacementId };
    }
    const previous = d.prepare("SELECT responsible_user_id FROM planning_obligations WHERE task_id = ? AND role = 'primary' AND responsible_user_id IS NOT NULL")
      .all(obligation.task_id).map((row) => Number(row.responsible_user_id));
    const window = taskWindow(d, obligation.task_id);
    const fallback = activity
      ? eligibleMembersForActivity(d, activity, window).find((member) => !previous.includes(Number(member.id)))
      : null;
    if (!fallback) {
      d.prepare(`UPDATE task_assignment_context SET state = 'unavailable', updated_at = ${nowSql()} WHERE task_id = ?`).run(obligation.task_id);
      d.prepare('UPDATE tasks SET assigned_to = NULL WHERE id = ?').run(obligation.task_id);
      replaceLegacyAssignments(d, obligation.task_id, []);
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
    return { ...d.prepare('SELECT * FROM planning_obligations WHERE id = ?').get(obligation.id), fallback: fallback, replacement_obligation_id: replacementId };
  })();
}

export function obligationInbox(d, userId, { includeAll = false } = {}) {
  const expired = d.prepare(`
    SELECT id, responsible_user_id FROM planning_obligations
     WHERE entity_type = 'task' AND status IN ('pending', 'accepted')
       AND response_deadline IS NOT NULL
       AND response_deadline <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     ORDER BY id
  `).all();
  for (const row of expired) {
    try { respondToTaskObligation(d, row.id, 'timeout', row.responsible_user_id || null); } catch { /* keep the inbox readable */ }
  }
  const where = includeAll ? '' : 'AND o.responsible_user_id = ?';
  return d.prepare(`
    SELECT o.*, t.title AS task_title, m.title AS meal_title, m.date AS meal_date,
           u.display_name AS responsible_name
      FROM planning_obligations o
      LEFT JOIN tasks t ON t.id = o.task_id
      LEFT JOIN meals m ON o.entity_type = 'meal' AND m.id = o.entity_id
      LEFT JOIN users u ON u.id = o.responsible_user_id
     WHERE o.status IN ('pending', 'accepted') ${where}
     ORDER BY COALESCE(o.response_deadline, o.due_at, '9999-12-31'), o.id
  `).all(...(includeAll ? [] : [userId]));
}
