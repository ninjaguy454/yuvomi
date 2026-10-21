/** Bounded maintenance of terminal Task occurrences; never called from a read. */
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { captureTaskListClock, recordTaskListDelta, trackableTaskListRoot } from './task-list-delta.js';
import { reconcileTaskSupervision } from './task-supervision.js';

const log = createLogger('TaskAutoArchive');
const DAY_MS = 86_400_000;
const TERMINAL = "('done','skipped','expired','closed_incomplete')";
let stop = null;
const closedAtSql = "CASE WHEN t.status='done' THEN c.completed_at ELSE t.skipped_at END";
const unfinishedSql = root => `WITH RECURSIVE linked(id) AS (
  SELECT ${root}
  UNION SELECT child.id FROM tasks child JOIN linked ON child.parent_task_id=linked.id
  UNION SELECT support.task_id FROM task_activity_support_tasks support JOIN linked ON support.source_task_id=linked.id
  UNION SELECT action.counterpart_task_id FROM task_supervision_actions action JOIN linked ON action.source_task_id=linked.id
    WHERE action.counterpart_task_id IS NOT NULL
) SELECT 1 FROM linked JOIN tasks work ON work.id=linked.id
  WHERE work.id!=${root} AND work.status NOT IN ${TERMINAL} LIMIT 1`;
const linkedProjectionSql = root => `WITH RECURSIVE source(id) AS (
  SELECT ${root}
  UNION SELECT child.id FROM tasks child JOIN source ON child.parent_task_id=source.id
), support(id) AS (
  SELECT link.task_id FROM task_activity_support_tasks link JOIN source ON link.source_task_id=source.id
  UNION SELECT action.counterpart_task_id FROM task_supervision_actions action JOIN source ON action.source_task_id=source.id
    WHERE action.counterpart_task_id IS NOT NULL
  UNION SELECT child.id FROM tasks child JOIN support ON child.parent_task_id=support.id
) SELECT work.id,work.archived_at,work.auto_archived_at FROM support JOIN tasks work ON work.id=support.id`;

const closure = (d, id) => d.prepare(`SELECT t.id,t.status,t.archived_at,t.auto_archive_after,t.parent_task_id,
  CASE WHEN t.status='done' THEN c.completed_at ELSE t.skipped_at END AS closed_at
  FROM tasks t LEFT JOIN task_completions c ON c.task_id=t.id WHERE t.id=?`).get(id);

function unfinishedLinkedWork(d, id) {
  return !!d.prepare(unfinishedSql('@root')).get({ root: id });
}
const linkedProjections=(d,id)=>d.prepare(linkedProjectionSql('@root')).all({root:id});
function hasLinkedSupport(d,id){
  return !!d.prepare(`WITH RECURSIVE source(id) AS (
    SELECT ? UNION SELECT child.id FROM tasks child JOIN source ON child.parent_task_id=source.id
  ) SELECT 1 FROM task_activity_support_tasks link JOIN source ON link.source_task_id=source.id LIMIT 1`).get(id);
}

/** One transaction per root bounds lock time; exact history rows are never altered. */
export function reconcileTaskAutoArchive(d, { now = new Date(), maxBatch = 20,
  cursor = null, onError = (error,id) => log.error(`Task ${id}:`,error.message) } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid archive time.');
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) throw new RangeError('Archive batch must be 1–100.');
  if (cursor != null && (typeof cursor.closedAt !== 'string' || !Number.isSafeInteger(cursor.id) || cursor.id < 1))
    throw new TypeError('Invalid archive cursor.');
  const cutoffMs = now.getTime() - 30 * DAY_MS;
  // Stored closure evidence can be second- or millisecond-precision. This
  // SQL upper bound includes the boundary second; the transaction compares
  // parsed instants to reject a fractionally younger row.
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 19) + 'Z';
  const stamp = now.toISOString().slice(0, 19) + 'Z';
  // A bounded scan moves past failed roots instead of retrying the same first
  // page forever. The scheduler keeps the keyset cursor and wraps after the end.
  const candidates = d.prepare(`SELECT t.id,${closedAtSql} AS closed_at FROM tasks t
    LEFT JOIN task_completions c ON c.task_id=t.id
    WHERE t.parent_task_id IS NULL AND t.archived_at IS NULL
      AND (t.auto_archive_after IS NULL OR t.auto_archive_after<=?)
      AND ((t.status='done' AND c.completed_at IS NOT NULL AND c.completed_at<=?)
        OR (t.status='skipped' AND t.skipped_at IS NOT NULL AND t.skipped_at<=?))
      AND NOT EXISTS (${unfinishedSql('t.id')})
      AND (? IS NULL OR ${closedAtSql}>? OR (${closedAtSql}=? AND t.id>?))
    ORDER BY ${closedAtSql},t.id LIMIT ?`)
    .all(stamp, cutoff, cutoff, cursor?.closedAt??null, cursor?.closedAt??null,
      cursor?.closedAt??null, cursor?.id??0, maxBatch*4);
  const archivedIds = [], failedIds = [];
  let scanned=0,last=null;
  for (const candidate of candidates) {
    if (archivedIds.length >= maxBatch) break;
    scanned++; last=candidate;
    try {
      const archived = d.transaction(() => {
        const task = closure(d, candidate.id);
        const closedMs = Date.parse(task?.closed_at ?? '');
        if (!task || task.parent_task_id !== null || task.archived_at || !['done', 'skipped'].includes(task.status)
          || !Number.isFinite(closedMs) || closedMs > cutoffMs || task.auto_archive_after > stamp
          || unfinishedLinkedWork(d, task.id)) return false;
        const before = captureTaskListClock(d);
        const listRoot = trackableTaskListRoot(d, task.id);
        const result = d.prepare('UPDATE tasks SET archived_at=?,auto_archived_at=? WHERE id=? AND archived_at IS NULL')
          .run(stamp,stamp,task.id);
        if (!result.changes) return false;
        if (task.status==='skipped') {
          // The standard supervisor reconciler intentionally exits for a
          // skipped source. Retire only terminal linked projections we find
          // in this transaction, marking exactly those this job changed.
          const archiveProjection=d.prepare('UPDATE tasks SET archived_at=?,auto_archived_at=? WHERE id=? AND archived_at IS NULL');
          for(const helper of linkedProjections(d,task.id)) if(!helper.archived_at)
            archiveProjection.run(stamp,stamp,helper.id);
        } else if (hasLinkedSupport(d,task.id))
          reconcileTaskSupervision(d, task.id, { notify: false });
        if (listRoot && listRoot === trackableTaskListRoot(d, task.id)) recordTaskListDelta(d, before, [listRoot]);
        return true;
      }).immediate();
      if (archived) archivedIds.push(candidate.id);
    } catch (error) { failedIds.push(candidate.id); onError(error,candidate.id); }
  }
  return { archivedIds, failedIds, scanned, limited: scanned===maxBatch*4 || archivedIds.length===maxBatch,
    nextCursor: last ? { closedAt: last.closed_at, id: last.id } : null };
}

/** Invoked only by the authorized explicit restore route, in its transaction. */
export function restoreAutoArchivedSkippedProjections(d,rootId){
  if(closure(d,rootId)?.status!=='skipped')return 0;
  const restore=d.prepare('UPDATE tasks SET archived_at=NULL,auto_archived_at=NULL WHERE id=? AND archived_at=? AND auto_archived_at=?');
  let changed=0;
  for(const helper of linkedProjections(d,rootId)) if(helper.auto_archived_at&&helper.auto_archived_at===helper.archived_at)
    changed+=restore.run(helper.id,helper.archived_at,helper.auto_archived_at).changes;
  return changed;
}

export function startTaskAutoArchive({ getDatabase = () => db.get(), now = () => new Date(), pollMs = 60_000 } = {}) {
  if (stop) return stop;
  let cursor=null;
  const tick = () => {
    try {
      const result=reconcileTaskAutoArchive(getDatabase(), { now: now(), cursor });
      cursor=result.nextCursor;
      return result;
    }
    catch (error) { log.error('Archive reconciliation failed:', error.message); }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  stop = () => { clearInterval(timer); stop = null; };
  return stop;
}
