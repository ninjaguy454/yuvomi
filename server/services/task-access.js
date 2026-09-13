/** One Task authorization boundary for REST, Reader, MCP and aggregate readers. */
import { actorId, actorPermissions, PermissionError } from '../permissions.js';
import { visibilityWhere } from './visibility.js';

const ids = value => [...new Set((Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(Number))].sort((a, b) => a - b);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const assignments = (d, task) => task?.id ? ids(d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(task.id).map(row => row.user_id).concat(task.assigned_to || [])) : ids(task?.assigned_to);
function ownSql(alias, me, projectionGuard = '') {
  return `(${alias}.created_by = ${me} OR ${alias}.assigned_to = ${me} OR EXISTS (SELECT 1 FROM task_assignments tp WHERE tp.task_id = ${alias}.id AND tp.user_id = ${me})
    OR (${alias}.parent_task_id IS NOT NULL AND ${alias}.assigned_to IS NULL AND NOT EXISTS (SELECT 1 FROM task_assignments tx WHERE tx.task_id = ${alias}.id) ${projectionGuard}
      AND EXISTS (SELECT 1 FROM tasks pp WHERE pp.id = ${alias}.parent_task_id AND (pp.created_by = ${me} OR pp.assigned_to = ${me} OR EXISTS (SELECT 1 FROM task_assignments pa WHERE pa.task_id = pp.id AND pa.user_id = ${me})))))`;
}

/** Adds no binds to the existing visibility fragment. Actor ID is strictly numeric. */
export function taskVisibilityWhere(d, actor, alias = 't', bind = '?') {
  const me = actorId(actor);
  const originalVisibility = visibilityWhere(alias, 'task_assignments', 'task_id', bind);
  const sourceVisible = visibilityWhere('mapped_source', 'task_assignments', 'task_id', String(Number.isSafeInteger(me) ? me : 0));
  const base = supervisionTable(d) ? `(${originalVisibility} AND NOT EXISTS (
    SELECT 1 FROM task_supervision_actions mapped JOIN tasks mapped_source ON mapped_source.id=mapped.action_task_id
    WHERE mapped.counterpart_task_id=${alias}.id AND NOT ${sourceVisible}))` : originalVisibility;
  if (actor == null) return base; // Shared Wall projections retain their existing public-visibility boundary.
  if (!Number.isSafeInteger(me) || me <= 0) return `(${base} AND 0)`;
  const p = actorPermissions(d, actor);
  if (p.capabilities['tasks.view_household'] === 'allow') return base;
  if (p.capabilities['tasks.view_own'] !== 'allow') return `(${base} AND 0)`;
  const projectionGuard = (supportTable(d) ? ` AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks os WHERE os.task_id=${alias}.id)` : '')
    + (supervisionTable(d) ? ` AND NOT EXISTS (SELECT 1 FROM task_supervision_actions oc WHERE oc.counterpart_task_id=${alias}.id)` : '');
  const supervision = supervisionTable(d) ? ` OR EXISTS (SELECT 1 FROM task_supervision_actions sa
    JOIN tasks supervised_action ON supervised_action.id=sa.action_task_id
    JOIN task_responsibilities current_helper ON current_helper.task_id=sa.source_task_id
      AND current_helper.user_id=sa.supervisor_user_id AND current_helper.role='supervisor' AND current_helper.status='active'
    WHERE sa.supervisor_user_id = ${me} AND sa.state = 'assigned'
      AND supervised_action.status!='done' AND supervised_action.archived_at IS NULL
      AND (${alias}.id = sa.source_task_id OR ${alias}.id = sa.action_task_id OR ${alias}.id = sa.counterpart_task_id))` : '';
  return `(${base} AND (${ownSql(alias, me, projectionGuard)}${supervision}))`;
}

export function taskCapabilities(d, actor, sourceTask) {
  const me = actorId(actor), p = actorPermissions(d, actor), allow = key => p.capabilities[`tasks.${key}`] === 'allow';
  const task = sourceTask?.id ? d.prepare('SELECT * FROM tasks WHERE id = ?').get(sourceTask.id) || sourceTask : sourceTask;
  const parent = task?.parent_task_id ? d.prepare('SELECT * FROM tasks WHERE id = ?').get(task.parent_task_id) : null;
  const assigned = assignments(d, task);
  const mappedSource = task?.id && supervisionTable(d) ? d.prepare(`SELECT t.* FROM task_supervision_actions a
    JOIN tasks t ON t.id=a.action_task_id WHERE a.counterpart_task_id=?`).get(task.id) : null;
  const projection = !!mappedSource || (task?.id && supportTable(d)
    && !!d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE task_id=?').get(task.id));
  const parentOwn = parent && (Number(parent.created_by) === me || assignments(d, parent).includes(me));
  const supervised = task?.id && supervisionTable(d) ? d.prepare(`SELECT sa.action_task_id, sa.counterpart_task_id, sa.source_task_id
    FROM task_supervision_actions sa JOIN tasks supervised_action ON supervised_action.id=sa.action_task_id
    JOIN task_responsibilities current_helper ON current_helper.task_id=sa.source_task_id
      AND current_helper.user_id=sa.supervisor_user_id AND current_helper.role='supervisor' AND current_helper.status='active'
    WHERE sa.supervisor_user_id = ? AND sa.state = 'assigned'
      AND supervised_action.status!='done' AND supervised_action.archived_at IS NULL
      AND (? = sa.action_task_id OR ? = sa.counterpart_task_id OR ? = sa.source_task_id)`)
    .all(me, task.id, task.id, task.id) : [];
  const own = Number(task?.created_by) === me || assigned.includes(me) || (!projection && parent && !assigned.length && parentOwn);
  const canSeeRow = row => row && (row.visibility === 'all' || !row.visibility || Number(row.created_by) === me
    || (row.visibility === 'assignees' && assignments(d,row).includes(me)));
  const visible = canSeeRow(task) && (!mappedSource || canSeeRow(mappedSource));
  const view = Boolean(visible && (allow('view_household') || ((own || supervised.length) && allow('view_own'))));
  const locked = task?.locked ? task : parent?.locked ? parent : null;
  const definition = view && !projection && (p.admin || !locked || Number(locked.created_by) === me);
  const result = { view, own: Boolean(own), create: allow('create'), edit: definition && allow(own ? 'edit_own' : 'edit_others'), complete: view && allow((own || supervised.some(row => row.action_task_id === task.id || row.counterpart_task_id === task.id)) ? 'complete_own' : 'complete_others') };
  for (const key of ['delete_archive', 'change_assignment', 'reassign', 'change_priority', 'change_points', 'change_category_tags', 'change_dates', 'change_required_skills']) result[key] = definition && allow(key);
  result.comment = view && allow('comment');
  result.claim = view && !projection && allow('claim');
  return result;
}
export function attachTaskCapabilities(d, actor, tasks) {
  for (const task of tasks) {
    task.permissions = taskCapabilities(d, actor, task);
    if (Array.isArray(task.subtasks)) attachTaskCapabilities(d, actor, task.subtasks);
  }
  return tasks;
}

/** Choosing a helper changes the canonical Task's whole supervised scope. */
export function taskSupervisionManagementAllowed(d, actor, sourceTaskId) {
  const source = d.prepare('SELECT * FROM tasks WHERE id = ?').get(sourceTaskId);
  if (!source) return false;
  const p = actorPermissions(d, actor), me = actorId(actor);
  const capabilities = taskCapabilities(d, actor, source);
  return Boolean((p.admin || Number(source.created_by) === me)
    && capabilities.view && capabilities.change_assignment && capabilities.reassign);
}

/** Operational status actions do not require permission to edit definitions. */
export function assertTaskMutation(d, actor, task, body = {}, { operation = task ? 'update' : 'create' } = {}) {
  const p = actorPermissions(d, actor);
  const requireKey = key => { if (p.capabilities[`tasks.${key}`] !== 'allow') throw new PermissionError('Your household permissions do not allow this Task action.'); };
  if (!task) {
    requireKey('create');
    if (body.parent_task_id) {
      const parent = d.prepare('SELECT * FROM tasks WHERE id = ?').get(body.parent_task_id);
      if (!parent) throw new PermissionError('Task not found.', 404);
      if (!taskCapabilities(d, actor, parent).edit) throw new PermissionError('You cannot change this Task’s subtasks.');
    }
    for (const [key, fields] of Object.entries(PROTECTED_FIELDS)) {
      if (fields.some(field => nonDefaultCreateValue(field, body[field]))) requireKey(key);
    }
    if ((body.activity_template_id || body.activity_binding) && p.capabilities['activities.view'] !== 'allow') throw new PermissionError('You cannot use Activity Templates.');
    for (const child of body.subtasks || []) if (Array.isArray(child.skill_ids) && child.skill_ids.length) requireKey('change_required_skills');
    return;
  }
  const c = taskCapabilities(d, actor, task);
  if (!c.view) throw new PermissionError('Task not found.', 404);
  const requireAction = key => { if (!c[key]) throw new PermissionError('Your household permissions do not allow this Task action.'); };
  if (['status', 'check'].includes(operation)) return requireAction('complete');
  if (['delete', 'archive'].includes(operation)) return requireAction('delete_archive');
  if (operation === 'comment') return requireAction('comment');
  if (operation === 'claim') return requireAction('claim');
  if (operation === 'assignment') { requireAction('change_assignment'); return requireAction('reassign'); }
  if (operation === 'documents') return requireAction('edit');
  const changed = field => {
    if (body[field] === undefined) return false;
    if (field === 'assigned_to') return !equal(ids(body[field]), assignments(d, task));
    if (field === 'skill_ids') return !equal(ids(body[field]), ids(d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id = ?').all(task.id).map(row => row.skill_id)));
    if (field === 'tags') return !equal(idsOrStrings(body[field]), idsOrStrings(d.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(task.id).map(row => row.tag)));
    if (field === 'location') return true;
    if (Array.isArray(body[field])) return !equal(body[field], task[field] || []);
    return String(body[field] ?? '') !== String(task[field] ?? '');
  };
  if (body.status === 'archived') requireAction('delete_archive');
  else if (changed('status')) requireAction('complete');
  const definitionFields = ['title', 'description', 'visibility', 'sync_target', 'locked', 'parent_task_id', 'location', 'countdown', 'subtasks', 'activity_template_id', 'activity_subject_user_id', 'activity_inputs', 'activity_binding'];
  if (definitionFields.some(changed)) requireAction('edit');
  const me = actorId(actor);
  // Joining/leaving only one's own assignment is the legacy claim interaction,
  // including on a locked instruction. It cannot remove or add another member.
  const selfAssignmentOnly = changed('assigned_to')
    && equal(ids(body.assigned_to).filter(id => id !== me), assignments(d, task).filter(id => id !== me))
    && !PROTECTED_FIELDS.change_assignment.filter(field => field !== 'assigned_to').some(changed);
  for (const [key, fields] of Object.entries(PROTECTED_FIELDS)) {
    if (!fields.some(changed)) continue;
    requireAction(key === 'change_assignment' && selfAssignmentOnly ? 'claim' : key);
  }
  if (PROTECTED_FIELDS.change_assignment.some(changed) && !selfAssignmentOnly) requireAction('reassign');
  if ((changed('activity_template_id') || changed('activity_binding')) && p.capabilities['activities.view'] !== 'allow') throw new PermissionError('You cannot use Activity Templates.');
}
const idsOrStrings = value => (Array.isArray(value) ? value : []).map(String).sort();
const PROTECTED_FIELDS = Object.freeze({
  change_assignment: ['assigned_to', 'assignment_mode', 'rotation_user_ids', 'rotation_group', 'rotation_slot', 'activity_template_id', 'activity_subject_user_id', 'activity_inputs', 'activity_binding'],
  change_priority: ['priority'], change_points: ['points'], change_category_tags: ['category', 'tags'],
  change_dates: ['start_date', 'due_date', 'due_time', 'is_recurring', 'recurrence_rule', 'recurrence_from_completion'],
  change_required_skills: ['skill_ids', 'activity_template_id', 'activity_binding'],
});
function nonDefaultCreateValue(field, value) {
  if (value == null || value === '' || value === false || value === 0 || (Array.isArray(value) && !value.length)) return false;
  if ((field === 'priority' && value === 'none') || (field === 'category' && value === 'misc') || (field === 'assignment_mode' && value === 'fixed')) return false;
  return true;
}

function supervisionTable(d) { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_supervision_actions'").get(); }
function supportTable(d) { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_activity_support_tasks'").get(); }
