/**
 * Activity Template checklist definitions are authoring-time data. When an
 * Activity creates a Task, these rows are copied into ordinary Task subtasks;
 * the generated Task owns those copies from then on.
 */

import { setTaskSkills } from './task-skills.js';
import { substituteVariableTemplate } from './variable-resolution.js';

export function loadActivityChecklist(d, activityTemplateId) {
  const items = d.prepare(`
    SELECT id, title_template, sort_order
      FROM activity_template_checklist_items
     WHERE activity_template_id = ?
     ORDER BY sort_order ASC, id ASC
  `).all(activityTemplateId);
  const skills = d.prepare(`
    SELECT cs.checklist_item_id, s.*, cs.sort_order
      FROM activity_template_checklist_skills cs JOIN skills s ON s.id = cs.skill_id
      JOIN activity_template_checklist_items item ON item.id = cs.checklist_item_id
     WHERE item.activity_template_id = ? ORDER BY cs.sort_order, s.id
  `).all(activityTemplateId);
  return items.map((item) => {
    const required = skills.filter((skill) => skill.checklist_item_id === item.id)
      .map(({ checklist_item_id, ...skill }) => skill);
    return { ...item, skills: required, skill_ids: required.map((skill) => skill.id) };
  });
}

export function renderActivityChecklistTitle(item, activity, subject = null, variableLabels = {}) {
  const rendered = substituteVariableTemplate(String(item?.title_template || '')
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity?.name || 'Activity'), variableLabels, { preserveMissing: true })
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
  return items.map((item) => {
    const taskId = Number(insert.run(
      renderActivityChecklistTitle(item, activity, subject, variableLabels),
      activity.category || parent.category || 'misc',
      parent.start_date,
      parent.due_date,
      parent.due_time,
      createdBy || parent.created_by,
      parent.id,
      parent.visibility || 'all',
    ).lastInsertRowid);
    setTaskSkills(d, taskId, item.skill_ids || item.skills?.map((skill) => skill.id) || []);
    return taskId;
  });
}
