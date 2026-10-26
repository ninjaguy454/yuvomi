import { isValidTimeZone, storedToInstantMs } from '../utils/timezone.js';
import { createHash } from 'node:crypto';

const PRIORITY = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const FALLBACK_CATEGORY = 'misc';
const CLOSED = new Map([['expired','Expired'],['skipped','Skipped']]);

function dueTime(row, timeZone = null) {
  const date = row.trip_group ? row.display_due_date : row.due_date;
  const time = row.trip_group ? row.display_due_time : row.due_time;
  if (!date) return null;
  const wall = `${date}T${time || '23:59:59'}`;
  return timeZone ? storedToInstantMs(wall,timeZone) : new Date(wall).getTime();
}

function defaultCompare(a, b, now, timeZone) {
  const ad = dueTime(a,timeZone), bd = dueTime(b,timeZone);
  const ao = ad !== null && ad < now ? 1 : 0;
  const bo = bd !== null && bd < now ? 1 : 0;
  if (ao !== bo) return bo - ao;
  if (ad === null && bd === null) return (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4);
  if (ad === null) return 1;
  if (bd === null) return -1;
  return ad - bd || (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4);
}

/** Internal, fail-closed ordering foundation. Only modes with verified card
 * parity are accepted; callers must not quietly page an unsupported view. */
export function orderTaskWindow(rows, {
  groupMode = 'category', categories = [], locale = 'en', now = new Date(),
  sort = { field: 'default', direction: 'asc' }, categoryLabel = key => key,
  today = null, labels = {}, statusOrder = [], bucketSorts = new Map(), timeZone = null,
} = {}) {
  if (timeZone !== null && !isValidTimeZone(timeZone)) throw new RangeError('Invalid viewer time zone');
  if (!['category', 'none', 'due', 'status', 'location', 'assignee'].includes(groupMode))
    throw new RangeError('Unsupported window group mode');
  const supportedFields = ['default', 'title', 'due', 'assignees', 'points', 'subtasks', 'category', 'location', 'progress'];
  if (!supportedFields.includes(sort?.field || 'default')) throw new RangeError('Unsupported window sort field');
  const groups = new Map();
  const groupLabels = new Map();
  for (const row of rows) {
    // Migration10079 converts persisted closures to Done. Older descriptors
    // keep their row identity and provenance while sharing ordinary grouping.
    const status=row.status==='closed_incomplete'?'done':row.status;
    let ids;
    if (groupMode === 'category') ids = [row.category || FALLBACK_CATEGORY];
    else if (groupMode === 'none') ids = ['all'];
    else if (groupMode === 'status') ids = [row.archived_at ? 'archived' : status];
    else if (groupMode === 'due') {
      const date = row.trip_group ? row.display_due_date : row.due_date;
      if (CLOSED.has(status)) ids = [status];
      else if (!date) ids = ['noDate'];
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) throw new TypeError('Due groups need the viewer calendar day');
        // Calendar-day arithmetic, not the browser's local instant offset.
        const day = value => Date.UTC(...value.split('-').map((part,index) => Number(part) - (index === 1 ? 1 : 0)));
        const diff = Math.round((day(date) - day(today)) / 86400000);
        ids = [diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 3 ? 'thisWeek' : diff <= 7 ? 'nextWeek' : 'later'];
      }
    } else if (groupMode === 'location') {
      if (!Object.hasOwn(row, 'location_label')) throw new TypeError('Location descriptor missing');
      const label = row.location_label || labels.noLocation || '';
      ids = [row.location_place_id ? `place-${row.location_place_id}` : `location-${label.toLocaleLowerCase()}`];
    } else {
      if (!Array.isArray(row.participant_ids)) throw new TypeError('Assignee descriptor missing');
      ids = row.participant_ids.length ? row.participant_ids.map(id => `user-${id}`) : ['unassigned'];
    }
    for (const id of ids) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
      if (groupMode === 'location') groupLabels.set(id,row.location_label || labels.noLocation || '');
    }
  }
  const categoryOrder = new Map(categories.map((row, index) => [row.key, index]));
  const dueOrder = ['overdue','today','thisWeek','nextWeek','later','noDate','expired','skipped'];
  if(groupMode==='status' && [...groups.keys()].some(id=>!statusOrder.includes(id)))
    throw new RangeError('Status group order is incomplete');
  const ids = [...groups.keys()].sort((a, b) => {
    if (groupMode === 'category') return (categoryOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
      || categoryLabel(a).localeCompare(categoryLabel(b), locale) || String(a).localeCompare(String(b));
    if (groupMode === 'due') return dueOrder.indexOf(a) - dueOrder.indexOf(b);
    if (groupMode === 'status') return statusOrder.indexOf(a) - statusOrder.indexOf(b);
    if (groupMode === 'location') return String(groupLabels.get(a)).localeCompare(String(groupLabels.get(b)), locale, { sensitivity:'base' })
      || String(a).localeCompare(String(b));
    return 0;
  });
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const timestamp = now.getTime();
  return ids.map(id => {
    const selected = bucketSorts.get(`list:${groupMode}:${id}`) || sort;
    const field = selected?.field || 'default';
    if (!supportedFields.includes(field)) throw new RangeError('Unsupported window sort field');
    const direction = selected?.direction === 'desc' ? -1 : 1;
    const required = { assignees:'participant_ids',points:'completion_points',subtasks:'subtask_total',
      location:'location_label',progress:'progress' }[field];
    if (required && groups.get(id).some(row => !Object.hasOwn(row,required)))
      throw new TypeError(`${field} descriptor missing`);
    const ordered = groups.get(id).sort((a, b) => {
      const compared = field === 'default' ? defaultCompare(a, b, timestamp, timeZone)
        : field === 'due' ? (dueTime(a,timeZone) ?? Infinity) - (dueTime(b,timeZone) ?? Infinity)
        : field === 'title' ? collator.compare(String(a.title || ''), String(b.title || ''))
        : field === 'assignees' ? a.participant_ids.length - b.participant_ids.length
        : field === 'points' ? Number(a.completion_points) - Number(b.completion_points)
        : field === 'subtasks' ? Number(a.subtask_total || 0) - Number(b.subtask_total || 0)
        : field === 'category' ? collator.compare(categoryLabel(a.category), categoryLabel(b.category))
        : field === 'location' ? collator.compare(a.location_label, b.location_label)
        : Number(a.progress || 0) - Number(b.progress || 0);
      if (compared) return compared * direction;
      return String(a.title || '').localeCompare(String(b.title || ''), locale, { sensitivity: 'base' })
        || Number(a.id) - Number(b.id);
    });
    return { id, ids: ordered.map(row => row.id), total: ordered.length };
  });
}

/** Slice a freshly authorized and sorted snapshot. A caller must recompute the
 * snapshot after each clock change: reusing an old offset alone misses an
 * off-window row which entered ahead of the boundary. Group totals always
 * describe the complete matching snapshot, not just hydrated cards. */
export function sliceTaskWindow(groups, { offset = 0, limit = 30, collapsed = [] } = {},maxLimit=100) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit)
    throw new RangeError('Invalid Task window boundary');
  const closed = new Set(collapsed);
  let remaining = offset, capacity = limit;
  const pages = groups.map(group => {
    const ids = closed.has(group.id) ? [] : group.ids;
    const skip = Math.min(remaining, ids.length);
    remaining -= skip;
    const loaded = ids.slice(skip, skip + capacity);
    capacity -= loaded.length;
    return { id:group.id, total:group.total, loaded:loaded.length, ids:loaded };
  });
  const available = groups.reduce((sum,group)=>sum+(closed.has(group.id)?0:group.ids.length),0);
  return { groups:pages, ids:pages.flatMap(group=>group.ids), total:available,
    next_offset:offset + limit < available ? offset + limit : null };
}

/** Query identity for a future signed page cursor. Include every view setting
 * that changes row membership, order, group labels, or the visible boundary.
 * Actor and effective authorization remain separate cursor claims. */
export function taskWindowQueryKey(filters = {}, view = {}, { includeOffset = true } = {}) {
  const entries = Object.entries(filters).filter(([key])=>key!=='delta'&&key!=='cursor')
    .map(([key,value])=>[key,[value].flat().map(String).sort()]).sort(([a],[b])=>a.localeCompare(b));
  if(view.bucketSorts!==undefined && !(view.bucketSorts instanceof Map))throw new TypeError('Bucket sorts must be a Map');
  const buckets=[...(view.bucketSorts||new Map())].sort(([a],[b])=>a.localeCompare(b));
  const value={filters:entries,groupMode:view.groupMode||'category',sort:view.sort||null,
    bucketSorts:buckets,categories:(view.categories||[]).map(row=>[row.key,row.name,row.label_key]),
    categoryLabels:Object.entries(view.categoryLabels||{}).sort(([a],[b])=>a.localeCompare(b)),
    labels:Object.entries(view.labels||{}).sort(([a],[b])=>a.localeCompare(b)),
    locale:view.locale||'en',timeZone:view.timeZone||null,today:view.today||null,
    statusOrder:view.statusOrder||[],collapsed:[...(view.collapsed||[])].sort(),
    // The signed offset fixes where the next page begins. A caller may use a
    // larger bounded page for a refresh without changing membership/order.
    ...(includeOffset?{offset:view.offset||0}:{})};
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

/** ID-only reconciliation for one signed, authorized page. Never send an
 * off-page changed row merely because its ID appears in the global journal. */
export function diffAuthorizedTaskWindow(previous, current, changedIds = [], queryKey) {
  if (!previous || previous.query_key!==queryKey || !Array.isArray(previous.ids))
    return { reset_required:true, reason:'query_changed' };
  const old=new Set(previous.ids),next=new Set(current.ids),changed=new Set(changedIds);
  return {reset_required:false,removed:previous.ids.filter(id=>!next.has(id)),
    hydrate_ids:current.ids.filter(id=>!old.has(id)||changed.has(id)),
    ids:[...current.ids],groups:current.groups,total:current.total,next_offset:current.next_offset};
}
