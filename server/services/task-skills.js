/** Task and subtask skill requirements use the household's existing skill IDs. */
import { effectiveSkillProficiency, householdMembers } from './activity-eligibility.js';
import { todayKey } from '../utils/timezone.js';

export class TaskSkillError extends Error {}

export function normalizeSkillIds(d, value, fallback = []) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 100
      || value.some((id) => !['number', 'string'].includes(typeof id)
        || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new TaskSkillError('Choose valid household skills.');
  }
  const ids = [...new Set(value.map(Number))];
  if (ids.length) {
    const found = d.prepare(`SELECT COUNT(*) AS n FROM skills WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).n;
    if (found !== ids.length) throw new TaskSkillError('One or more required skills no longer exist.');
  }
  return ids;
}

export function loadTaskSkillIds(d, taskId) {
  return d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id = ? ORDER BY sort_order, skill_id')
    .all(taskId).map((row) => row.skill_id);
}

export function setTaskSkills(d, taskId, skillIds) {
  d.prepare('DELETE FROM task_skill_requirements WHERE task_id = ?').run(taskId);
  const insert = d.prepare('INSERT INTO task_skill_requirements(task_id,skill_id,sort_order) VALUES (?,?,?)');
  skillIds.forEach((id, order) => insert.run(taskId, id, order));
}

export function copyTaskSkills(d, sourceTaskId, targetTaskId) {
  setTaskSkills(d, targetTaskId, loadTaskSkillIds(d, sourceTaskId));
}

export function assertTaskSkillAssignments(d, skillIds, userIds, dateKey = todayKey(d)) {
  if (!skillIds.length || !userIds.length) return;
  const skills = d.prepare(`SELECT * FROM skills WHERE id IN (${skillIds.map(() => '?').join(',')})`).all(...skillIds);
  const members = householdMembers(d);
  for (const userId of userIds) {
    const member = members.find((item) => Number(item.id) === Number(userId));
    if (!member || skills.some((skill) => effectiveSkillProficiency(d, skill, member, dateKey).proficiency !== 'normal')) {
      throw new TaskSkillError('Choose someone who can independently perform every required skill.');
    }
  }
}

export function assertTaskMemberSkills(d, taskId, userId) {
  const task = d.prepare('SELECT due_date FROM tasks WHERE id = ?').get(taskId);
  assertTaskSkillAssignments(d, loadTaskSkillIds(d, taskId), [userId], task?.due_date || todayKey(d));
}

export function qualifiedTaskAssignees(d, taskId, userIds, dateKey) {
  const ids = loadTaskSkillIds(d, taskId);
  return userIds.filter((userId) => {
    try { assertTaskSkillAssignments(d, ids, [userId], dateKey); return true; }
    catch (error) { if (error instanceof TaskSkillError) return false; throw error; }
  });
}

export function attachTaskSkills(d, tasks) {
  if (!tasks.length) return tasks;
  const ids = tasks.map((task) => task.id);
  // Bound activities retain their existing live template requirements; copying
  // them into the Task relation would create two authorities for assignment.
  const rows = d.prepare(`
    SELECT ts.task_id, s.*, ts.sort_order FROM task_skill_requirements ts
      JOIN skills s ON s.id = ts.skill_id
     WHERE ts.task_id IN (${ids.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM task_activity_bindings b WHERE b.task_id = ts.task_id)
    UNION ALL
    SELECT b.task_id, s.*, ats.sort_order FROM task_activity_bindings b
      JOIN activity_template_skills ats ON ats.activity_template_id = b.activity_template_id
      JOIN skills s ON s.id = ats.skill_id
     WHERE b.task_id IN (${ids.map(() => '?').join(',')})
    ORDER BY sort_order, id
  `).all(...ids, ...ids);
  const byTask = new Map();
  for (const { task_id: taskId, ...skill } of rows) {
    if (!byTask.has(taskId)) byTask.set(taskId, []);
    byTask.get(taskId).push(skill);
  }
  for (const task of tasks) {
    task.skills = byTask.get(task.id) || [];
    task.skill_ids = task.skills.map((skill) => skill.id);
    task.skill_assignment_needed = task.skill_ids.length > 0 && task.assigned_to == null;
  }
  return tasks;
}
