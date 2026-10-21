import { normalizeCategoryFilter, taskCategoryWhere, taskScopeWhere, taskStartProjection } from './task-scope.js';
import { taskUnskippedWhere } from './task-window.js';
import { taskVisibilityWhere } from './task-access.js';
import { normalizeTags, tagKey } from '../utils/task-tags.js';

const asList = value => value === undefined ? [] : [value].flat().filter(item => item !== '');

/** Shared WHERE clause for full card hydration and lightweight window candidates.
 * `values` belongs to this WHERE only; the full-card SELECT binds its own
 * child-visibility arguments before these values. Do not expose raw candidates
 * without applying the start projection as the full route does. */
export function taskListWhere(d, actor, query = {}, { changedIds = null } = {}) {
  const { status, priority, assigned_to, category, tag, archived } = query;
  let where = `WHERE ${taskScopeWhere('t', { includeFuture: true, includeSupervision: true })}`;
  const values = [];
  const rawStatuses = asList(status);
  const statuses = rawStatuses.filter(value => value !== 'archived');
  const statusArchiv = rawStatuses.includes('archived');
  const archiveQuery = archived === 'only' ? 'only'
    : archived === '1' || archived === 'true' ? 'include' : null;
  if (statuses.length && statusArchiv) {
    where += ` AND (t.status IN (${statuses.map(() => '?').join(', ')}) OR t.archived_at IS NOT NULL)`;
    values.push(...statuses);
  } else {
    if (statuses.length) {
      where += ` AND t.status IN (${statuses.map(() => '?').join(', ')})`;
      values.push(...statuses);
    }
    if (statusArchiv || archiveQuery === 'only') where += ' AND t.archived_at IS NOT NULL';
    else if (!archiveQuery) where += ' AND t.archived_at IS NULL';
  }
  if (!rawStatuses.length && !archiveQuery) where += " AND t.status NOT IN ('expired','skipped')";
  if (!archiveQuery && !rawStatuses.some(value => ['done','expired','skipped','closed_incomplete'].includes(value)))
    where += ` AND ${taskUnskippedWhere(d)}`;

  const priorities = asList(priority);
  if (priorities.length) {
    where += ` AND t.priority IN (${priorities.map(() => '?').join(', ')})`;
    values.push(...priorities);
  }
  const assignees = asList(assigned_to).map(Number).filter(Number.isInteger);
  if (assignees.length) {
    where += ` AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id
      AND ta.user_id IN (${assignees.map(() => '?').join(', ')}))`;
    values.push(...assignees);
  }
  const categories = normalizeCategoryFilter(category);
  const categoryFragment = taskCategoryWhere('t', categories);
  if (categoryFragment) { where += ` AND ${categoryFragment}`; values.push(...categories); }
  for (const value of normalizeTags(tag === undefined ? [] : [tag].flat())) {
    where += ' AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_key = ?)';
    values.push(tagKey(value));
  }
  if (changedIds !== null) {
    if (!Array.isArray(changedIds) || !changedIds.length || changedIds.some(id => !Number.isSafeInteger(id) || id <= 0))
      throw new TypeError('Changed Task IDs must be a nonempty safe integer array.');
    where += ` AND t.id IN (${changedIds.map(() => '?').join(',')})`;
    values.push(...changedIds);
  }
  where += ` AND ${taskVisibilityWhere(d, actor, 't')}`;
  values.push(actor, actor);
  return { where, values };
}

/** Read only authorized root descriptors. This deliberately omits child/card
 * hydration; window ordering and counts can be computed from these rows once
 * the remaining derived fields have parity with the existing card projection.
 * Keep this within the caller's read snapshot. */
export function readTaskListDescriptors(d, actor, query = {}) {
  const { where, values } = taskListWhere(d, actor, query);
  const candidates = d.prepare(`SELECT t.id,t.title,t.description,t.category,t.priority,t.status,
      t.due_date,t.due_time,t.start_date,t.start_time,t.archived_at,t.assigned_to,t.points
    FROM tasks t ${where}`).all(...values);
  const starts = taskStartProjection(d, { tasks: candidates, bounded: true });
  const visible = query.include_future ? candidates : candidates.filter(starts.visible);
  // The full list's wake timer considers visible children even when the
  // parent itself is already visible. Read only authorized child IDs here;
  // names and other child data are unnecessary for boundary calculation.
  const children = new Map();
  for (let at = 0; at < candidates.length; at += 400) {
    const ids = candidates.slice(at, at + 400).map(row => row.id);
    if (!ids.length) continue;
    const childWhere = taskVisibilityWhere(d, actor, 's');
    for (const row of d.prepare(`SELECT s.id,s.parent_task_id,s.archived_at FROM tasks s
      WHERE s.parent_task_id IN (${ids.map(() => '?').join(',')}) AND ${childWhere}`).all(...ids, actor, actor)) {
      const list = children.get(row.parent_task_id) || [];
      list.push(row); children.set(row.parent_task_id, list);
    }
  }
  const visibility = starts.metadata(candidates.map(row => ({ ...row, subtasks: children.get(row.id) || [] })),
    { includeFuture: !!query.include_future });
  const needle = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  if (!needle) return { rows: visible, visibility };
  const tags = new Map();
  for (let at = 0; at < visible.length; at += 400) {
    const ids = visible.slice(at, at + 400).map(row => row.id);
    if (!ids.length) continue;
    for (const row of d.prepare(`SELECT task_id,tag FROM task_tags WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      const values = tags.get(row.task_id) || [];
      values.push(row.tag); tags.set(row.task_id, values);
    }
  }
  const rows = visible.filter(row =>
    (row.title || '').toLowerCase().includes(needle) ||
    (row.description || '').toLowerCase().includes(needle) ||
    (tags.get(row.id) || []).some(tag => tag.toLowerCase().includes(needle))
  );
  return { rows, visibility };
}
