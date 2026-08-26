/**
 * Connects ordinary Tasks to the reusable Activity Template / skill engine.
 *
 * A binding is deliberately separate from tasks.assignment_mode. The existing
 * fixed / round-robin modes remain the manual scheduler; a binding says that an
 * Activity Template owns assignment for this task occurrence. That keeps old
 * tasks backwards-compatible while letting scheduled and recurring activities
 * use the same proficiency rules as Quick Add workflows.
 */

import { resolveActivityAssignment } from './activity-eligibility.js';
import { todayKey } from '../utils/timezone.js';

export class TaskActivityBindingError extends Error {}

function asPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function activityTemplate(d, id) {
  return d.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id) ?? null;
}

function taskRow(d, id) {
  return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const insert = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const userId of userIds) insert.run(taskId, userId);
}

function supervisorTitle(activity, subject) {
  const template = activity.supervision_title_template || 'Supervise {subject}: {activity}';
  return String(template)
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity.name || 'activity')
    .trim();
}

export function getTaskActivityBinding(d, taskId) {
  return d.prepare(`
    SELECT b.task_id, b.activity_template_id, b.subject_user_id,
           a.name AS activity_template_name,
           a.assignment_strategy AS activity_assignment_strategy,
           a.subject_required AS activity_subject_required,
           a.active AS activity_template_active,
           u.display_name AS activity_subject_name
      FROM task_activity_bindings b
      JOIN activity_templates a ON a.id = b.activity_template_id
      LEFT JOIN users u ON u.id = b.subject_user_id
     WHERE b.task_id = ?
  `).get(taskId) ?? null;
}

/** Attach flattened binding metadata to task API rows without N+1 queries. */
export function attachTaskActivityBindings(d, tasks) {
  if (!tasks?.length) return tasks;
  const ids = tasks.map((task) => Number(task.id)).filter(Number.isInteger);
  if (!ids.length) return tasks;
  const placeholders = ids.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT b.task_id, b.activity_template_id, b.subject_user_id,
           a.name AS activity_template_name,
           a.assignment_strategy AS activity_assignment_strategy,
           a.subject_required AS activity_subject_required,
           a.active AS activity_template_active,
           u.display_name AS activity_subject_name
      FROM task_activity_bindings b
      JOIN activity_templates a ON a.id = b.activity_template_id
      LEFT JOIN users u ON u.id = b.subject_user_id
     WHERE b.task_id IN (${placeholders})
  `).all(...ids);
  const byTask = new Map(rows.map((row) => [Number(row.task_id), row]));
  for (const task of tasks) {
    const binding = byTask.get(Number(task.id));
    task.activity_template_id = binding?.activity_template_id ?? null;
    task.activity_template_name = binding?.activity_template_name ?? null;
    task.activity_assignment_strategy = binding?.activity_assignment_strategy ?? null;
    task.activity_subject_required = binding?.activity_subject_required ?? null;
    task.activity_template_active = binding?.activity_template_active ?? null;
    task.activity_subject_user_id = binding?.subject_user_id ?? null;
    task.activity_subject_name = binding?.activity_subject_name ?? null;
  }
  return tasks;
}

export function activitySupportTasks(d, sourceTaskId) {
  return d.prepare(`
    SELECT t.*, s.role
      FROM task_activity_support_tasks s
      JOIN tasks t ON t.id = s.task_id
     WHERE s.source_task_id = ?
     ORDER BY t.id
  `).all(sourceTaskId);
}

export function isActivitySupportTask(d, taskId) {
  return !!d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id = ?').get(taskId);
}

/** Human-authored/checklist subtasks, excluding system-generated supervision. */
export function ordinaryActivitySubtasks(d, sourceTaskId) {
  return d.prepare(`
    SELECT t.*
      FROM tasks t
     WHERE t.parent_task_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id = t.id
       )
     ORDER BY t.id ASC
  `).all(sourceTaskId);
}

function deleteSupportTasks(d, sourceTaskId) {
  const rows = activitySupportTasks(d, sourceTaskId);
  if (!rows.length) return;
  const placeholders = rows.map(() => '?').join(',');
  d.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...rows.map((row) => row.id));
}

/**
 * Validate/preview a binding without consuming an Activity Template rotation.
 */
export function previewTaskActivityBinding(d, {
  activityTemplateId,
  subjectUserId = null,
  dateKey = todayKey(d),
  allowInactive = false,
} = {}) {
  const id = asPositiveInt(activityTemplateId);
  if (!id) throw new TaskActivityBindingError('Choose a valid activity template.');
  const activity = activityTemplate(d, id);
  if (!activity) throw new TaskActivityBindingError('Activity template not found.');
  if (!allowInactive && !activity.active) {
    throw new TaskActivityBindingError('That activity template is inactive.');
  }
  const subjectId = subjectUserId == null || subjectUserId === '' ? null : asPositiveInt(subjectUserId);
  if (subjectUserId != null && subjectUserId !== '' && !subjectId) {
    throw new TaskActivityBindingError('Choose a valid household member subject.');
  }
  try {
    const resolution = resolveActivityAssignment(d, activity, {
      subjectUserId: subjectId,
      commitRotation: false,
      dateKey,
    });
    return { activity, subjectUserId: subjectId, resolution };
  } catch (err) {
    throw new TaskActivityBindingError(err.message);
  }
}

/**
 * Apply a binding to one concrete task occurrence.
 *
 * The parent task becomes fixed from the Task module's point of view because
 * the Activity Template, rather than a hand-maintained roster, now owns its
 * assignee. A supervised learner gets a separate generated supervision subtask.
 */
export function applyTaskActivityBinding(d, taskId, {
  activityTemplateId,
  subjectUserId = null,
  commitRotation = true,
  dateKey = null,
  allowInactive = false,
  supportOriginTaskId = null,
} = {}) {
  const task = taskRow(d, taskId);
  if (!task) throw new TaskActivityBindingError('Task not found.');
  if (task.parent_task_id) {
    throw new TaskActivityBindingError('Activity templates can only be attached to top-level tasks.');
  }

  const preview = previewTaskActivityBinding(d, {
    activityTemplateId,
    subjectUserId,
    dateKey: dateKey || task.due_date || todayKey(d),
    allowInactive,
  });

  let resolution;
  try {
    resolution = resolveActivityAssignment(d, preview.activity, {
      subjectUserId: preview.subjectUserId,
      commitRotation,
      dateKey: dateKey || task.due_date || todayKey(d),
    });
  } catch (err) {
    throw new TaskActivityBindingError(err.message);
  }

  d.prepare(`
    INSERT INTO task_activity_bindings (
      task_id, activity_template_id, subject_user_id, updated_at
    ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(task_id) DO UPDATE SET
      activity_template_id = excluded.activity_template_id,
      subject_user_id = excluded.subject_user_id,
      updated_at = excluded.updated_at
  `).run(task.id, preview.activity.id, preview.subjectUserId);

  // Manual task rotation is intentionally cleared. Future occurrences resolve
  // from current proficiency and Activity Template rotation state instead.
  d.prepare(`
    UPDATE tasks SET
      assigned_to = ?, assignment_mode = 'fixed', rotation_index = 0,
      rotation_group = NULL, rotation_slot = 0, rotation_cycle = 0
     WHERE id = ?
  `).run(resolution.primary?.id ?? null, task.id);
  d.prepare('DELETE FROM task_rotation_members WHERE task_id = ?').run(task.id);
  setAssignments(d, task.id, resolution.primary?.id ? [resolution.primary.id] : []);

  deleteSupportTasks(d, task.id);
  let supportTaskId = null;
  if (resolution.supervisor) {
    const support = d.prepare(`
      INSERT INTO tasks (
        title, description, category, priority, status,
        start_date, due_date, due_time, assigned_to, created_by, parent_task_id,
        is_recurring, recurrence_rule, assignment_mode, rotation_index,
        points, visibility, countdown, recurrence_origin_id
      ) VALUES (?, ?, ?, 'none', 'open', ?, ?, ?, ?, ?, ?, 0, NULL, 'fixed', 0, 0, ?, 0, ?)
    `).run(
      supervisorTitle(preview.activity, resolution.subject),
      `Supervise ${resolution.subject?.display_name || 'the household member'} while they complete: ${preview.activity.name}`,
      preview.activity.category || task.category || 'misc',
      task.start_date,
      task.due_date,
      task.due_time,
      resolution.supervisor.id,
      task.created_by,
      task.id,
      task.visibility,
      supportOriginTaskId || null,
    );
    supportTaskId = Number(support.lastInsertRowid);
    setAssignments(d, supportTaskId, [resolution.supervisor.id]);
    d.prepare(`
      INSERT INTO task_activity_support_tasks (source_task_id, task_id, role)
      VALUES (?, ?, 'supervisor')
    `).run(task.id, supportTaskId);
  }

  return {
    binding: getTaskActivityBinding(d, task.id),
    resolution,
    support_task_id: supportTaskId,
  };
}

export function clearTaskActivityBinding(d, taskId) {
  deleteSupportTasks(d, taskId);
  d.prepare('DELETE FROM task_activity_bindings WHERE task_id = ?').run(taskId);
}

/**
 * Carry a recurring series binding to its next occurrence and resolve assignment
 * against the proficiency state that applies to the new occurrence date.
 */
export function copyTaskActivityBinding(d, sourceTaskId, targetTaskId, {
  commitRotation = true,
  dateKey = null,
} = {}) {
  const sourceBinding = getTaskActivityBinding(d, sourceTaskId);
  if (!sourceBinding) return null;
  const sourceSupport = activitySupportTasks(d, sourceTaskId).find((row) => row.role === 'supervisor') ?? null;
  const target = taskRow(d, targetTaskId);
  return applyTaskActivityBinding(d, targetTaskId, {
    activityTemplateId: sourceBinding.activity_template_id,
    subjectUserId: sourceBinding.subject_user_id,
    commitRotation,
    dateKey: dateKey || target?.due_date || todayKey(d),
    // Existing series continue even if an admin later deactivates the template;
    // deactivation blocks new bindings, not already-scheduled household work.
    allowInactive: true,
    supportOriginTaskId: sourceSupport?.id ?? null,
  });
}
