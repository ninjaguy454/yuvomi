import { normalizeCategoryFilter, taskCategoryWhere, taskScopeWhere, taskStartProjection } from './task-scope.js';
import { taskUnskippedWhere } from './task-window.js';
import { taskVisibilityWhere } from './task-access.js';
import { normalizeTags, tagKey } from '../utils/task-tags.js';
import { orderTaskWindow, sliceTaskWindow, taskWindowQueryKey } from './task-window-order.js';
import { attachTaskLocations } from './task-locations.js';
import { todayKey } from '../utils/timezone.js';
import { captureTaskListClock } from './task-list-delta.js';

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
export function readTaskListDescriptors(d, actor, query = {}, { participants = false, location = false, tripDue = false, progress = false, now = new Date() } = {}) {
  const { where, values } = taskListWhere(d, actor, query);
  const candidates = d.prepare(`SELECT t.id,t.title,t.description,t.category,t.priority,t.status,
      t.due_date,t.due_time,t.start_date,t.start_time,t.archived_at,t.assigned_to,t.points
    FROM tasks t ${where}`).all(...values);
  const starts = taskStartProjection(d, { now, tasks: candidates, batched: true });
  const visible = query.include_future ? candidates : candidates.filter(starts.visible);
  // The full list's wake timer considers visible children even when the
  // parent itself is already visible. Read only authorized child IDs here;
  // names and other child data are unnecessary for boundary calculation.
  const children = new Map();
  for (let at = 0; at < candidates.length; at += 400) {
    const ids = candidates.slice(at, at + 400).map(row => row.id);
    if (!ids.length) continue;
    const childWhere = taskVisibilityWhere(d, actor, 's');
    for (const row of d.prepare(`SELECT s.id,s.parent_task_id,s.archived_at,s.status,s.is_optional,s.points FROM tasks s
      WHERE s.parent_task_id IN (${ids.map(() => '?').join(',')}) AND ${childWhere}`).all(...ids, actor, actor)) {
      const list = children.get(row.parent_task_id) || [];
      list.push(row); children.set(row.parent_task_id, list);
    }
  }
  const visibility = starts.metadata(candidates.map(row => ({ ...row, subtasks: children.get(row.id) || [] })),
    { includeFuture: !!query.include_future });
  const needle = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  const tags = new Map();
  for (let at = 0; needle && at < visible.length; at += 400) {
    const ids = visible.slice(at, at + 400).map(row => row.id);
    if (!ids.length) continue;
    for (const row of d.prepare(`SELECT task_id,tag FROM task_tags WHERE task_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      const values = tags.get(row.task_id) || [];
      values.push(row.tag); tags.set(row.task_id, values);
    }
  }
  const rows = !needle ? visible : visible.filter(row =>
    (row.title || '').toLowerCase().includes(needle) ||
    (row.description || '').toLowerCase().includes(needle) ||
    (tags.get(row.id) || []).some(tag => tag.toLowerCase().includes(needle))
  );
  if(progress)for(let at=0;at<rows.length;at+=400){
    const page=rows.slice(at,at+400),ids=page.map(row=>row.id);
    // A helper/delegated action changes the operational denominator. Do not
    // infer its progress from physical checkboxes until that projection has
    // full parity with hydrateTask's supervisor filtering.
    if(d.prepare(`SELECT 1 FROM task_supervision_actions WHERE source_task_id IN (${ids.map(()=>'?').join(',')}) LIMIT 1`).get(...ids)
      ||d.prepare(`SELECT 1 FROM task_activity_support_tasks WHERE task_id IN (${ids.map(()=>'?').join(',')}) LIMIT 1`).get(...ids)
      ||d.prepare(`SELECT 1 FROM workflow_instance_tasks WHERE task_id IN (${ids.map(()=>'?').join(',')}) LIMIT 1`).get(...ids))
      throw new RangeError('Supervised Task progress needs the full projection');
    for(const row of page){
      const scope=(children.get(row.id)||[]).filter(child=>!child.archived_at);
      row.subtask_total=scope.filter(child=>!child.is_optional).length;
      row.subtask_done=scope.filter(child=>!child.is_optional&&child.status==='done').length;
      const projected=starts.project({...row,subtasks:scope});
      const active=projected.subtasks.filter(child=>!child.is_optional);
      const total=active.length+projected.scheduled_subtask_total;
      const done=active.filter(child=>child.status==='done').length+projected.scheduled_subtask_done;
      row.progress=scope.length ? (total ? done/total : 0) : row.status==='done'?1:0;
    }
  }
  if (participants) for (let at = 0; at < rows.length; at += 400) {
    const page = rows.slice(at, at + 400), ids = page.map(row => row.id);
    const people = new Map(ids.map(id => [id, new Set()]));
    for (const entry of d.prepare(`SELECT task_id,user_id FROM task_assignments
      WHERE task_id IN (${ids.map(() => '?').join(',')}) ORDER BY task_id,user_id`).all(...ids))
      people.get(entry.task_id)?.add(entry.user_id);
    for (const entry of d.prepare(`SELECT task_id,user_id FROM task_responsibilities
      WHERE status='active' AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY task_id,user_id`).all(...ids))
      people.get(entry.task_id)?.add(entry.user_id);
    for (const row of page) {
      const members=people.get(row.id);
      if (!members.size && row.assigned_to) members.add(Number(row.assigned_to));
      row.participant_ids=[...members];
    }
  }
  if (location) for (let at = 0; at < rows.length; at += 400) {
    const page=rows.slice(at,at+400),ids=page.map(row=>row.id);
    attachTaskLocations(d,page);
    const planned=new Map(d.prepare(`SELECT pc.task_id,p.name FROM task_planning_context pc
      LEFT JOIN places p ON p.id=pc.place_id
      WHERE pc.task_id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(row=>[row.task_id,row.name]));
    for(const row of page){
      row.location_label=row.location?.label||row.location?.address||planned.get(row.id)||'';
      row.location_place_id=row.location?.place_id||null;
      delete row.location;
    }
  }
  if (tripDue) for (let at = 0; at < rows.length; at += 400) {
    const page=rows.slice(at,at+400),ids=page.map(row=>row.id);
    const childAccess=taskVisibilityWhere(d,actor,'c');
    const trips=d.prepare(`WITH scoped AS (
      SELECT g.parent_task_id,g.trip_id,g.state,g.revision,
        CASE WHEN g.state='active' THEN (SELECT c.id FROM tasks c
          WHERE c.parent_task_id=g.parent_task_id AND c.archived_at IS NULL
            AND c.status NOT IN ('done','expired','skipped','closed_incomplete')
            AND (c.start_date IS NULL OR c.start_date<=?)
            AND NOT EXISTS(SELECT 1 FROM trip_task_steps s WHERE s.task_id=c.id AND s.state!='active')
            AND ${childAccess}
          ORDER BY c.due_date IS NULL,c.due_date,COALESCE(c.due_time,'23:59:59'),c.sort_order,c.id LIMIT 1)
          ELSE NULL END AS next_id
      FROM trip_task_groups g WHERE g.parent_task_id IN (${ids.map(()=>'?').join(',')})
    ) SELECT scoped.*,c.due_date,c.due_time FROM scoped LEFT JOIN tasks c ON c.id=scoped.next_id`)
      .all(todayKey(d,now),actor,actor,...ids);
    const byId=new Map(trips.map(row=>[row.parent_task_id,row]));
    for(const row of page){
      const trip=byId.get(row.id);if(!trip)continue;
      row.trip_group={trip_id:trip.trip_id,state:trip.state,revision:trip.revision};
      row.display_due_date=trip.due_date??null;
      row.display_due_time=trip.due_time??null;
    }
  }
  return { rows, visibility };
}

/** Internal parity path, not an API. Full cards must be hydrated only after
 * the selected IDs have been checked against current authorization. Modes
 * requiring scoring/helper/progress projections intentionally fail closed. */
export function readOrderedTaskWindow(d,actor,query={},view={}) {
  const mode=view.groupMode || 'category',field=view.sort?.field || 'default';
  if (view.bucketSorts!==undefined && !(view.bucketSorts instanceof Map))
    throw new TypeError('Bucket sorts must be a Map');
  const fields=[field,...[...(view.bucketSorts?.values()||[])].map(sort=>sort?.field||'default')];
  if (!['category','none','due','status','location'].includes(mode)
    ||fields.some(value=>!['default','title','due','category','location','assignees'].includes(value)))
    throw new RangeError('Task window projection is not ready for this view');
  if (mode==='status' && !Array.isArray(view.statusOrder))
    throw new TypeError('Status order is required for a Task window');
  if ((mode==='category'||fields.includes('category')) && typeof view.categoryLabel!=='function')
    throw new TypeError('Localized category labels are required for a Task window');
  if (mode==='location' && typeof view.labels?.noLocation!=='string')
    throw new TypeError('Localized empty-location label is required for a Task window');
  const requiresDue=mode==='due'||fields.some(value=>value==='due'||value==='default');
  if (requiresDue && !view.timeZone)
    throw new TypeError('Viewer time zone is required for a Task window');
  const now=new Date();
  const day=todayKey(d,now),scopeKey=taskWindowQueryKey(query,{...view,today:day},{includeOffset:false});
  if (view.expectedScopeKey!==undefined && view.expectedScopeKey!==scopeKey)
    return {reset_required:true,reason:'query_changed'};
  const clock=captureTaskListClock(d);
  if (view.expectedClock!==undefined && view.expectedClock!==clock)
    return {reset_required:true,reason:'window_changed'};
  const {rows,visibility}=readTaskListDescriptors(d,actor,query,{location:mode==='location'||fields.includes('location'),
    participants:fields.includes('assignees'),tripDue:requiresDue,now});
  const groups=orderTaskWindow(rows,{...view,now,today:day});
  return {...sliceTaskWindow(groups,view),visibility,clock,
    query_key:taskWindowQueryKey(query,{...view,today:day}),
    scope_key:scopeKey};
}
