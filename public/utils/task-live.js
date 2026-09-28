import { auth } from '/api.js';
import { deviceContext } from './device-context.js';

/** One session-authenticated invalidation stream per tab, shared by list and detail. */
const subscribers = new Set();
let stream = null;
let timer = null;
let retryTimer = null;
let version = null;
let notificationGeneration = 0;
let authEnded = false;
let retryAttempt = 0;
let refreshing = false;
let refreshAgain = false;
let verifySession = false;
let connectionState = 'connected';

export function taskConnectionState() { return connectionState; }
function setConnectionState(state) {
  if (state === connectionState) return;
  connectionState = state;
  window.dispatchEvent(new CustomEvent('task-connection-state', { detail: { state } }));
}
const available = () => subscribers.size && !authEnded && !document.hidden && navigator.onLine !== false;

function notify(checkSession = false) {
  if (!available()) return;
  verifySession ||= checkSession === true;
  if (refreshing) { refreshAgain = true; return; }
  clearTimeout(timer);
  const generation = notificationGeneration;
  timer = setTimeout(async () => {
    timer = null;
    if (generation !== notificationGeneration || !available()) return;
    refreshing = true;
    const check = verifySession; verifySession = false;
    try {
      if (check) await auth.me();
      if (generation !== notificationGeneration || !available()) return;
      if (stream?.readyState === 1) setConnectionState('connected');
      for (const callback of subscribers) {
        // Subscribers own view-specific errors. One failed observer must not
        // interrupt other views or create an unhandled rejection.
        try { Promise.resolve(callback()).catch(() => {}); } catch { /* isolated observer */ }
      }
    } catch {
      // Authentication handles genuine expiry. An unavailable /auth/me must
      // not cause another wave of doomed list/detail/dashboard reads.
      if (generation === notificationGeneration && available()) {
        verifySession = true; refreshAgain = false;
        setConnectionState('reconnecting');
      }
    } finally {
      if (generation === notificationGeneration) {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; notify(); }
      }
    }
  }, 80);
}

function retry() {
  if (!available() || retryTimer) return;
  // Own reconnection rather than EventSource's fixed, unbounded retry cadence.
  const delay = Math.min(30_000, 1000 * (2 ** Math.min(retryAttempt++, 5))) * (0.8 + Math.random() * 0.4);
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
}

function connect() {
  if (!available() || stream || retryTimer) return;
  if (typeof EventSource !== 'function') {
    // Reader remains server-rendered. Older SPA browsers use a bounded fallback.
    retryTimer = setTimeout(() => { notify(); retryTimer = null; connect(); }, 30_000);
    return;
  }
  const source = new EventSource(`/api/v1/tasks/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
  stream = source;
  source.addEventListener('open', () => {
    if (stream !== source || !available()) return;
    retryAttempt = 0; notify(true);
  });
  // Permission revocation closes an already-authorized stream. A reconnect
  // rejected with 403 will never emit open/change, so refresh on error too.
  source.addEventListener('error', () => {
    if (stream !== source || !available()) return;
    source.close(); stream = null;
    setConnectionState('reconnecting');
    // One canonical permissions check per connection attempt, never per
    // native retry event. A successful read also clears revoked content.
    notify(true); retry();
  });
  const changed = (event) => {
    if (stream !== source || !available()) return;
    let next;
    try { next = JSON.parse(event.data)?.version; } catch { /* reconnect still refreshes */ }
    if (next != null && next === version) return;
    version = next;
    notify();
  };
  stream.addEventListener('message', changed);
  stream.addEventListener('change', changed);
  stream.addEventListener('tasks', changed);
}

function suspend() {
  stream?.close(); stream = null;
  notificationGeneration++;
  clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = null;
  refreshing = refreshAgain = verifySession = false;
}

function endAuthentication() { authEnded = true; suspend(); }
function offline() { setConnectionState('offline'); suspend(); }

function resume() {
  if (authEnded) return;
  if (document.hidden || navigator.onLine === false) { suspend(); return; }
  // Native EventSource stops retrying after an HTTP authorization rejection.
  // A later resume may follow restored permissions; discard the closed object.
  if (stream?.readyState === 2) { stream.close(); stream = null; }
  connect();
  notify(true);
}

export function watchTaskChanges(callback) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    authEnded = false; retryAttempt = 0;
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    window.addEventListener('auth:expired', endAuthentication);
    window.addEventListener('auth:context-ending', endAuthentication);
    window.addEventListener('task-data-changed', notify);
    connect();
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size) return;
    suspend(); version = null;
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('offline', offline);
    window.removeEventListener('pagehide', suspend);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('auth:expired', endAuthentication);
    window.removeEventListener('auth:context-ending', endAuthentication);
    window.removeEventListener('task-data-changed', notify);
  };
}

/** One read in flight per mounted view, with one coalesced catch-up. Only the
 * latest request may publish; mutations and context teardown invalidate reads. */
export function latestTaskLoader(read, accept) {
  let generation = 0, disposed = false, requested = false, running = null;
  async function run() {
    let accepted = false;
    while (requested && !disposed) {
      requested = false;
      const request = generation;
      let data;
      try { data = await read(); }
      catch (error) { if (disposed || request !== generation) continue; throw error; }
      if (disposed || request !== generation) continue;
      await accept(data); accepted = true;
    }
    return accepted;
  }
  return {
    load() {
      if (disposed) return Promise.resolve(false);
      generation++; requested = true;
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    invalidate() { generation++; requested = false; },
    dispose() { disposed = true; generation++; requested = false; },
  };
}

/** Re-read a board when its next authorized Task starts. The server supplies
 * both instants: client timezone/clock settings never decide visibility. */
export function createTaskStartRefresh(refresh) {
  let timer = null, stopped = false, authEnded = false, paused = false, generation = 0;
  const clear = () => { generation++; clearTimeout(timer); timer = null; };
  const active = () => !stopped && !authEnded && !paused && !document.hidden && navigator.onLine !== false;
  const schedule = delay => {
    if (!active()) return;
    const current = generation;
    timer = setTimeout(async () => {
      if (!active() || current !== generation) return;
      timer = null;
      try { await refresh(); }
      catch { if (active() && current === generation) schedule(30_000); }
    }, Math.max(100, Math.min(2_147_483_647, delay)));
  };
  const suspend = () => { paused = true; clear(); };
  // watchTaskChanges already refreshes on resume; its fresh response rearms us.
  const resume = () => { paused = false; if (document.hidden || navigator.onLine === false) suspend(); };
  const endAuth = () => { authEnded = true; clear(); };
  const visibility = () => { if (document.hidden) suspend(); else resume(); };
  document.addEventListener('visibilitychange', visibility);
  for (const name of ['pagehide', 'offline']) window.addEventListener(name, suspend);
  for (const name of ['pageshow', 'online']) window.addEventListener(name, resume);
  for (const name of ['auth:expired', 'auth:context-ending']) window.addEventListener(name, endAuth);
  return {
    update(value) {
      clear();
      if (!Number.isFinite(value?.server_now) || !Number.isFinite(value?.next_start_at)) return;
      schedule(value.next_start_at - value.server_now);
    },
    dispose() {
      stopped = true; clear();
      document.removeEventListener('visibilitychange', visibility);
      for (const name of ['pagehide', 'offline']) window.removeEventListener(name, suspend);
      for (const name of ['pageshow', 'online']) window.removeEventListener(name, resume);
      for (const name of ['auth:expired', 'auth:context-ending']) window.removeEventListener(name, endAuth);
    },
  };
}
