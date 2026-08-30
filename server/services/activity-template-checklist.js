/**
 * Activity Template checklist definitions are authoring-time data. When an
 * Activity creates a Task, these rows are copied into ordinary Task subtasks;
 * the generated Task owns those copies from then on.
 */

export function loadActivityChecklist(d, activityTemplateId) {
  return d.prepare(`
    SELECT id, title_template, sort_order
      FROM activity_template_checklist_items
     WHERE activity_template_id = ?
     ORDER BY sort_order ASC, id ASC
  `).all(activityTemplateId);
}

export function renderActivityChecklistTitle(item, activity, subject = null, variableLabels = {}) {
  const rendered = String(item?.title_template || '')
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity?.name || 'Activity')
    .replace(/\{\{([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?)\}\}/g, (token, key) => (
      Object.hasOwn(variableLabels, key) ? String(variableLabels[key] ?? '') : token
    ))
    .trim();
  return rendered || activity?.name || 'Checklist item';
}

export function materializeActivityChecklist(d, {
  activity,
  parentTaskId,
  subject = null,
  variableLabels = {},
  createdBy = null,
} = {}) {
  if (!activity?.id || !parentTaskId) return [];
  const parent = d.prepare('SELECT * FROM tasks WHERE id = ?').get(parentTaskId);
  if (!parent) return [];
  const items = activity.checklist ?? loadActivityChecklist(d, activity.id);
  if (!items.length) return [];
  const insert = d.prepare(`
    INSERT INTO tasks (
      title, description, category, priority, status, start_date, due_date, due_time,
      assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
      assignment_mode, rotation_index, points, visibility, countdown, locked
    ) VALUES (?, NULL, ?, 'none', 'open', ?, ?, ?, NULL, ?, ?, 0, NULL, 'fixed', 0, 0, ?, 0, 0)
  `);
  return items.map((item) => Number(insert.run(
    renderActivityChecklistTitle(item, activity, subject, variableLabels),
    activity.category || parent.category || 'misc',
    parent.start_date,
    parent.due_date,
    parent.due_time,
    createdBy || parent.created_by,
    parent.id,
    parent.visibility || 'all',
  ).lastInsertRowid));
}
