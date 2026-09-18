/** A recurring Task's policy is independent from its reusable source template.
 * Skill definitions and member proficiency stay live; only required skill IDs
 * and the Activity's authored assignment/presence configuration are captured. */
export function parseTaskActivitySnapshot(value) {
  if (value == null) return null;
  const snapshot = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
  if (!snapshot || !Number.isInteger(Number(snapshot.id)) || !Array.isArray(snapshot.required_skill_ids)) {
    throw new Error('This recurring Activity definition is invalid. Reload before editing it.');
  }
  return snapshot;
}

export function captureActivityTemplateDefinition(d, activityTemplateId) {
  const activity = d.prepare('SELECT * FROM activity_templates WHERE id=?').get(activityTemplateId);
  if (!activity) throw new Error('Activity template not found.');
  const required_skill_ids = d.prepare('SELECT skill_id FROM activity_template_skills WHERE activity_template_id=? ORDER BY sort_order,skill_id')
    .all(activity.id).map(row => row.skill_id);
  const checklist = d.prepare('SELECT id,title_template,sort_order,is_optional FROM activity_template_checklist_items WHERE activity_template_id=? ORDER BY sort_order,id')
    .all(activity.id).map(item => ({ ...item, skill_ids: d.prepare('SELECT skill_id FROM activity_template_checklist_skills WHERE checklist_item_id=? ORDER BY sort_order,skill_id')
      .all(item.id).map(row => row.skill_id) }));
  return { ...activity, required_skill_ids, checklist };
}

export function readTaskActivityDefinition(d, taskId) {
  const binding = d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(taskId);
  if (!binding) return null;
  const activity = taskActivitySnapshot(d, taskId, binding)
    || d.prepare('SELECT * FROM activity_templates WHERE id=?').get(binding.activity_template_id);
  return activity ? { ...activity, subject_user_id: binding.subject_user_id } : null;
}

export function taskActivitySnapshot(d, taskId, binding = undefined) {
  binding ??= d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(taskId);
  if (!binding?.activity_template_id) return null;
  const own = parseTaskActivitySnapshot(binding.definition_snapshot_json);
  if (own) return own;
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_recurrence_definitions'").get()) return null;
  const definition = d.prepare(`SELECT def.definition_json FROM task_recurrence_occurrences occurrence
    JOIN task_recurrence_definitions def ON def.id=occurrence.definition_id WHERE occurrence.task_id=?`).get(taskId);
  const saved = definition ? JSON.parse(definition.definition_json).binding : null;
  if (Number(saved?.activity_template_id) !== Number(binding.activity_template_id)) return null;
  return parseTaskActivitySnapshot(saved?.snapshot ?? saved?.definition_snapshot_json);
}

export function captureTaskActivityBindingDefinition(d, taskId, { seriesId = null } = {}) {
  const binding = d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(taskId);
  if (!binding) return null;
  const snapshot = taskActivitySnapshot(d, taskId, binding)
    || captureActivityTemplateDefinition(d, binding.activity_template_id);
  if (seriesId != null) {
    snapshot.rotation_scope = `series:${seriesId}`;
    snapshot.rotation_cursor_user_id = d.prepare('SELECT assigned_to FROM tasks WHERE id=?').get(taskId)?.assigned_to ?? null;
  }
  return { activity_template_id: binding.activity_template_id, subject_user_id: binding.subject_user_id,
    assignment_override_user_id: binding.assignment_override_user_id, snapshot };
}

export function updateTaskActivitySnapshotSkills(d, taskId, skillIds) {
  const binding = d.prepare('SELECT * FROM task_activity_bindings WHERE task_id=?').get(taskId);
  const snapshot = taskActivitySnapshot(d, taskId, binding);
  if (!snapshot) return;
  if (JSON.stringify(snapshot.required_skill_ids) === JSON.stringify(skillIds)) return;
  snapshot.required_skill_ids = [...skillIds];
  d.prepare('UPDATE task_activity_bindings SET definition_snapshot_json=? WHERE task_id=?').run(JSON.stringify(snapshot), taskId);
}

export function activitySnapshotSkills(d, activity) {
  if (!Array.isArray(activity?.required_skill_ids)) return undefined;
  const ids=activity.required_skill_ids;
  if (!ids.length) return [];
  const skills=new Map(d.prepare(`SELECT * FROM skills WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(skill=>[Number(skill.id),skill]));
  return ids.map(id => {
    const skill = skills.get(Number(id));
    if (!skill) throw new Error('A required skill in this recurring Activity is unavailable.');
    return skill;
  });
}
