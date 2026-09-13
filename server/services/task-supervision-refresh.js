/** Refresh already-linked supervision independently of open browser tabs. */
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { reconcileTaskSupervision, taskSupervisionRootId } from './task-supervision.js';

const log = createLogger('TaskSupervisionRefresh');
let stopObserver = null;

/** No discovery/backfill: only outstanding Tasks with existing supervision maps. */
export function refreshExistingTaskSupervision(database, {
  reconcile = reconcileTaskSupervision,
  onError = (error, sourceId) => log.error(`Could not refresh Task ${sourceId} supervision:`, error.message),
} = {}) {
  const sources = database.prepare(`SELECT DISTINCT a.source_task_id FROM task_supervision_actions a
    JOIN tasks source ON source.id=a.source_task_id
    WHERE source.status!='done' AND source.archived_at IS NULL ORDER BY a.source_task_id`).all();
  const result = { inspected: 0, reconciled: 0, failed: 0 };
  const canonicalSources = [...new Set(sources.map(row=>taskSupervisionRootId(database,row.source_task_id)))].filter(id=>{
    const source=database.prepare('SELECT status,archived_at FROM tasks WHERE id=?').get(id);
    return source && source.status!=='done' && source.archived_at===null;
  });
  for (const sourceId of canonicalSources) {
    try {
      // Reconciliation preserves a valid person and is idempotent. Even a
      // currently valid scope can have newly deficient steps without mappings;
      // a now-independent scope still needs its obsolete projections retired.
      reconcile(database, sourceId, { actorId: null });result.inspected++;result.reconciled++;
    } catch (error) { result.failed++;onError(error, sourceId); }
  }
  return result;
}

/** Deterministic clock gate, also used without timers by regression tests. */
export function createTaskSupervisionRefresher({
  getDatabase = () => db.get(), now = () => Date.now(), pollMs = 5000, timeRecheckMs = 60000,
  refresh = refreshExistingTaskSupervision,
  onError = error => log.error('Could not refresh Task supervision:', error.message),
} = {}) {
  let lastDatabase = null, lastVersion = null, lastPollAt = null, lastSweepAt = null;
  return function tick() {
    const at = now();
    if (lastPollAt != null && at >= lastPollAt && at - lastPollAt < pollMs) return { skipped: true };
    lastPollAt = at;
    try {
      const database = getDatabase();
      const version = database.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
      if (database === lastDatabase && version === lastVersion && lastSweepAt != null
        && at >= lastSweepAt && at - lastSweepAt < timeRecheckMs) return { skipped: true };
      const result = refresh(database);
      lastDatabase = database;lastSweepAt = at;
      // Reconciliation changes the same clock. Absorb our own committed writes
      // so they do not schedule another sweep five seconds later.
      lastVersion = result.failed ? null : database.prepare('SELECT version FROM task_change_clock WHERE id=1').get().version;
      return { skipped: false, ...result };
    } catch (error) { onError(error);return { skipped: false, failed: 1 }; }
  };
}

export function startTaskSupervisionRefresh() {
  if (stopObserver) return stopObserver;
  const tick = createTaskSupervisionRefresher();
  const timer = setInterval(tick, 5000);timer.unref?.();
  tick();
  stopObserver = () => { clearInterval(timer);stopObserver = null; };
  return stopObserver;
}
