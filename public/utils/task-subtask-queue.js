/** Immediate child-only feedback with one revision-checked write in flight. */
export function createSubtaskQueue({ getTask, getChild, canDispatch = () => true, send, accept,
  onPending = () => {}, onError = () => {}, onDrain = () => {}, onUncertain = () => {} }) {
  const entries = new Map();
  let active = null, disposed = false, blocked = false, token = 0;
  let externalRevision = 0, drainNeeded = false;
  const failure = (message, reason = 'queue_changed') => Object.assign(new Error(message), { reason, outcome: reason === 'queue_ack_missing' ? 'unknown' : 'rejected' });
  const projection = () => new Map([...entries].map(([id, item]) => [id, { id, status: item.readbackStatus || item.status, token: item.token, ...(item.uncertain ? { uncertain: true } : {}) }]));
  const publish = () => { if (!disposed) onPending(projection()); };
  const report = (error, item, queued = true) => {
    if (!disposed) onError(error, { id: item.id, status: item.status, queued });
  };
  const drain = () => {
    if (!disposed && !active && !entries.size && drainNeeded) { drainNeeded = false; onDrain(); }
  };
  function gate(item, { checkParent = true } = {}) {
    const task = getTask(), child = getChild(item.id);
    if (!task || Number(task.id) !== item.taskId || !child || child.revision !== item.childRevision || child.status !== item.originalStatus)
      return failure('A queued step changed. Review its current state before trying again.');
    if (checkParent && task.revision !== item.parentRevision)
      return failure('This Task changed while steps were queued. Review it before trying again.');
    if (task.archived_at || task.status === 'expired' || child.archived_at || child.status === 'expired')
      return failure('This Task is no longer available for queued progress.');
    if (child.is_optional && task.status === 'done')
      return failure('Reopen the completed parent Task before changing an optional action.', 'optional_parent_completed');
    const allowed = canDispatch(child, item.status, task);
    return allowed === true ? null : failure(typeof allowed === 'string' ? allowed : 'You can no longer change this queued step.');
  }
  function cancelQueued(error, notify = true) {
    for (const item of [...entries.values()]) {
      if (item === active) continue;
      entries.delete(item.id); if (notify) report(error, item);
    }
  }
  const uncertain = error => error?.outcome === 'unknown' || error?.outcome !== 'rejected' && (!Number.isInteger(error?.status) || error.status >= 500);
  async function pump() {
    if (disposed || active || blocked || !entries.size) return;
    const item = entries.values().next().value;
    const invalid = gate(item);
    if (invalid) {
      entries.delete(item.id); report(invalid, item); cancelQueued(invalid); publish(); drain(); return;
    }
    active = item;
    try {
      // Re-read canonical metadata, retaining the original action revision and
      // intent. Only an accepted own acknowledgement may update parentRevision.
      const child = { ...getChild(item.id), revision: item.childRevision, parent_revision: item.parentRevision };
      const snapshot = await send(child, item.status);
      if (disposed) return;
      if (!snapshot || Number(snapshot.id) !== item.taskId || !Number.isSafeInteger(snapshot.revision)
        || snapshot.revision < item.parentRevision)
        throw failure('The step may have saved, but its current Task details are unavailable.', 'queue_ack_missing');
      const accepted = accept(snapshot) === true;
      const current = getTask();
      if (!accepted || current?.revision !== snapshot.revision || externalRevision > snapshot.revision) {
        cancelQueued(failure('Newer Task changes arrived while saving. Review them before continuing.'));
      } else {
        for (const queued of entries.values()) if (queued !== item) queued.parentRevision = snapshot.revision;
        // A final required action may close optional work. Do not send it just
        // because it was permissible when its optimistic feedback was painted.
        for (const queued of [...entries.values()]) {
          if (queued === item) continue;
          const changed = gate(queued);
          if (changed) { entries.delete(queued.id); report(changed, queued); }
        }
      }
    } catch (error) {
      if (disposed) return;
      blocked = true;
      // An interrupted response can follow a committed write. Preserve its
      // provisional feedback until a new canonical read, never resend it.
      item.uncertain = uncertain(error);
      if (!item.uncertain) entries.delete(item.id);
      cancelQueued(error, false); publish();
      if (item.uncertain) onUncertain(error);
      report(error, item, false);
    } finally {
      if (active === item) active = null;
      if (!disposed) {
        if (entries.get(item.id) === item && !item.uncertain) entries.delete(item.id);
        publish(); drain();
        if (!blocked) void pump();
      }
    }
  }
  return {
    enqueue(childId, status) {
      const id = Number(childId);
      if (disposed || blocked || active?.id === id || entries.has(id) || !['done', 'in_progress', 'open'].includes(status)) return false;
      const task = getTask(), child = getChild(id);
      if (!task || !child || !Number.isSafeInteger(task.revision) || !Number.isSafeInteger(child.revision) || child.status === status) return false;
      const item = { id, status, taskId: Number(task.id), childRevision: child.revision, originalStatus: child.status,
        parentRevision: task.revision, token: ++token };
      const invalid = gate(item);
      if (invalid) { report(invalid, item); return false; }
      entries.set(id, item); drainNeeded = true; publish(); void pump(); return true;
    },
    /** Call only after accepting an external canonical snapshot, never an ACK. */
    invalidate(fresh) {
      if (disposed || !fresh || Number(fresh.id) !== Number(getTask()?.id) || !Number.isSafeInteger(fresh.revision)) return;
      externalRevision = Math.max(externalRevision, fresh.revision);
      blocked = false;
      for (const item of [...entries.values()]) if (item.uncertain) {
        const child = getChild(item.id);
        // An unchanged read can precede the original request finishing. It
        // cannot prove rejection. A newer revision resolves the CAS attempt;
        // otherwise show canonical progress while keeping its result unknown.
        if (!child || fresh.revision > item.parentRevision || child.revision > item.childRevision
          || child.status === item.status || fresh.archived_at || fresh.status === 'expired'
          || canDispatch(child, item.status, getTask()) !== true) entries.delete(item.id);
        else { item.readbackStatus = child.status; blocked = true; }
      }
      if (active) {
        const child = getChild(active.id);
        // A newer reset, expiration or permission change outranks the visual
        // overlay too. The in-flight slot still prevents duplicate dispatch.
        if (!child || child.revision !== active.childRevision && child.status !== active.status
          || fresh.archived_at || fresh.status === 'expired' || child.archived_at || child.status === 'expired'
          || canDispatch(child, active.status, getTask()) !== true)
          entries.delete(active.id);
      }
      // During a request this may be its own SSE echo. The ACK revision will
      // distinguish that echo from a newer competing mutation before rebasing.
      for (const item of [...entries.values()]) {
        if (item === active || item.uncertain) continue;
        const invalid = gate(item, { checkParent: !active });
        if (invalid) { entries.delete(item.id); report(invalid, item); }
      }
      publish(); drain(); if (!active) void pump();
    },
    dispose() { disposed = true; entries.clear(); active = null; },
    get pending() { return projection(); },
    get busy() { return !disposed && (!!active || !!entries.size || blocked); },
    get blocked() { return !disposed && blocked; },
  };
}
