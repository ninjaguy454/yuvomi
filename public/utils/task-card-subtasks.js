import { createSubtaskQueue } from './task-subtask-queue.js';

/** Per-card canonical snapshots plus provisional child intents. No shared auth cache. */
export function createTaskCardSubtasks({ children, canComplete, send, invalidateReads = () => {},
  onCanonical = () => {}, onPending = () => {}, onError = () => {}, refresh = () => {} }) {
  const records = new Map();
  let disposed = false;
  function requestRefresh(record) {
    if (!record.refreshing && !disposed) {
      record.refreshing = Promise.resolve().then(refresh).catch(() => {}).finally(() => { record.refreshing = null; });
    }
  }
  function recordFor(task) {
    const id = Number(task.id);
    if (records.has(id)) return records.get(id);
    const record = { task, liveEpoch: 0, sentEpoch: 0, saved: false, pending: new Map() };
    record.queue = createSubtaskQueue({
      getTask: () => record.task,
      getChild: childId => children(record.task).find(child => Number(child.id) === childId),
      canDispatch: child => canComplete(record.task, child),
      send: async (child, status) => {
        record.sentEpoch = record.liveEpoch;
        invalidateReads();
        const snapshot = await send(child, status, record.task);
        record.saved = true;
        invalidateReads();
        return snapshot;
      },
      accept: fresh => {
        if (Number(fresh.revision) < Number(record.task.revision)) return false;
        // A live read can change eligibility without incrementing the Task.
        // Its newer permissions must survive an equal-revision HTTP echo.
        if (!(record.liveEpoch > record.sentEpoch && fresh.revision === record.task.revision)) record.task = fresh;
        onCanonical(record.task);
        return true;
      },
      onPending: pending => {
        record.pending = pending;
        onPending(record.task, pending, record.queue);
      },
      onError: error => {
        if (!record.refreshing) onError(error);
        requestRefresh(record);
      },
      onDrain: () => {
        if (record.saved) { record.saved = false; requestRefresh(record); }
      },
    });
    records.set(id, record);
    return record;
  }
  return {
    enqueue(task, childId, status) {
      return !disposed && recordFor(task).queue.enqueue(childId, status);
    },
    /** Called only for authoritative list reads, before rendering their markup. */
    reconcile(tasks) {
      const present = new Set(tasks.map(task => Number(task.id)));
      for (const [id, record] of records) if (!present.has(id)) { record.queue.dispose(); records.delete(id); }
      return tasks.map(fresh => {
        const record = records.get(Number(fresh.id));
        if (!record) return fresh;
        if (Number(fresh.revision) >= Number(record.task.revision)) {
          record.task = fresh; record.liveEpoch++;
          record.queue.invalidate(fresh);
        }
        return record.task;
      });
    },
    repaint() {
      for (const record of records.values()) onPending(record.task, record.pending, record.queue);
    },
    dispose() {
      disposed = true;
      for (const record of records.values()) record.queue.dispose();
      records.clear();
    },
  };
}

/** Predict counts/start/reopen only; completion and every points field stay canonical. */
export function taskCardPendingProjection(task, pending, children) {
  const required = children(task).filter(child => !child.is_optional);
  let status = task.status;
  if (pending.size && !task.archived_at && task.status !== 'expired' && !task.is_supervision_projection) {
    const changed = required.filter(child => pending.has(Number(child.id)));
    if (status === 'open' && changed.some(child => {
      const supervision = child.supervision_action || task.supervision?.actions?.find(action => Number(action.action_task_id) === Number(child.id));
      return pending.get(Number(child.id)).status === 'done' && (!supervision || supervision.state === 'not_required');
    })) status = 'in_progress';
    if (status === 'done' && changed.some(child => pending.get(Number(child.id)).status !== 'done')) status = 'in_progress';
  }
  return { ...task, status, subtasks: (task.subtasks || []).map(child => pending.has(Number(child.id))
    ? { ...child, status: pending.get(Number(child.id)).status } : child) };
}
