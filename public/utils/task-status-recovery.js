const unknown = error => error?.outcome === 'unknown'
  || error?.outcome !== 'rejected' && (!Number.isInteger(error?.status) || error.status === 408 || error.status >= 500);
const failure = (message, status, reason) => Object.assign(new Error(message),
  { status, outcome: 'rejected', data: { reason, error: message } });
const stopped = () => failure('Status checking stopped.', 409, 'status_recovery_stopped');

function waitForConnection(delay, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); globalThis.removeEventListener?.('online', done); };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(stopped()); };
    const timer = setTimeout(done, delay);
    signal?.addEventListener('abort', abort, { once: true });
    globalThis.addEventListener?.('online', done, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Only this status endpoint has transactional task AND parent CAS guards.
 * Never adapt the payload to a newer occurrence/revision during recovery. */
export async function recoverTaskStatus({ task, body, write, read, signal, isCurrent = () => true,
  onUncertain = () => {}, wait = waitForConnection, requestTimeoutMs = 15_000 }) {
  const original = { id: Number(task.id), status: task.status, parent: task.parent_task_id };
  const request = Object.freeze({ ...body });
  const guarded = Number.isSafeInteger(request.expected_revision) && request.expected_revision > 0
    && (!original.parent || Number.isSafeInteger(request.expected_parent_revision) && request.expected_parent_revision > 0);
  const check = () => {
    if (signal?.aborted) throw stopped();
    if (!isCurrent()) throw failure('The signed-in context changed. Refresh before continuing.', 409, 'auth_context_changed');
  };
  async function bounded(operation) {
    check();
    const controller = new AbortController();
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(stopped()); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('The connection timed out. Checking current status.'), { status: 0, outcome: 'unknown' }));
      }, requestTimeoutMs);
    });
    try { const result = await Promise.race([operation({ signal: controller.signal }), interrupted]); check(); return result; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  try { return await bounded(options => write(request, options)); }
  catch (error) { check(); if (!guarded || !unknown(error)) throw error; onUncertain(error); }

  let attempt = 0, rejection = null;
  for (;;) {
    check();
    let fresh;
    try { fresh = (await bounded(read))?.data; }
    catch (error) {
      // apiFetch labels an HTTP read rejection as rejected even for 5xx.
      // That rejects the read, not the original mutation's unknown outcome.
      check();
      if (!unknown(error) && error?.outcome !== 'unavailable' && !error?.transient
        && error?.status !== 408 && error?.status !== 429 && !(error?.status >= 500)) throw error;
    }
    check();
    if (fresh && Number(fresh.id) === original.id && Number.isSafeInteger(fresh.revision)) {
      // This confirms current progress, not which request/person completed it.
      if (fresh.status === request.status) return { data: fresh, reconciled: true };
      if (fresh.revision !== request.expected_revision
        || original.parent && fresh.parent_revision !== request.expected_parent_revision
        || fresh.status !== original.status || fresh.archived_at || ['expired', 'skipped'].includes(fresh.status))
        throw failure('This Task changed. Its current status has been refreshed; review it before trying again.', 409, 'stale_revision');
      if (rejection) throw rejection;
      const permission = request.status === 'done' ? 'complete' : request.status === 'open' ? 'reset'
        : original.status === 'done' ? 'reopen' : 'complete';
      if (fresh.permissions?.[permission] === false || fresh.supervision_action?.can_complete === false)
        throw failure('You no longer have permission to change this Task.', 403, 'status_permission_changed');
      try { return await bounded(options => write(request, options)); }
      catch (error) {
        check();
        // A competing original may have committed between the read and retry.
        // Read once more before reporting a definite rejection.
        if (!unknown(error)) rejection = error;
      }
      if (rejection) continue;
    }
    await wait(Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)), signal);
  }
}
