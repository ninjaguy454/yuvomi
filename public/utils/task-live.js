import { auth } from '/api.js';
import { deviceContext } from './device-context.js';

/** One session-authenticated invalidation stream per tab, shared by list and detail. */
const subscribers = new Set();
let stream = null;
let timer = null;
let retryTimer = null;
let version = null;
let notificationGeneration = 0;

function notify() {
  clearTimeout(timer);
  const generation = ++notificationGeneration;
  timer = setTimeout(async () => {
    try { await auth.me(); } catch { /* existing authentication handling owns expiry */ }
    if (generation !== notificationGeneration || !subscribers.size) return;
    for (const callback of subscribers) callback();
  }, 80);
}

function connect() {
  if (!subscribers.size || stream || retryTimer || document.hidden || navigator.onLine === false) return;
  if (typeof EventSource !== 'function') {
    // Reader remains server-rendered. Older SPA browsers use a bounded fallback.
    retryTimer = setTimeout(() => { notify(); retryTimer = null; connect(); }, 30_000);
    return;
  }
  stream = new EventSource(`/api/v1/tasks/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
  stream.addEventListener('open', notify);
  // Permission revocation closes an already-authorized stream. A reconnect
  // rejected with 403 will never emit open/change, so refresh on error too.
  stream.addEventListener('error', notify);
  const changed = (event) => {
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
}

function resume() {
  if (document.hidden || navigator.onLine === false) { suspend(); return; }
  // Native EventSource stops retrying after an HTTP authorization rejection.
  // A later resume may follow restored permissions; discard the closed object.
  if (stream?.readyState === 2) { stream.close(); stream = null; }
  connect();
  notify();
}

export function watchTaskChanges(callback) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', suspend);
    window.addEventListener('pagehide', suspend);
    window.addEventListener('pageshow', resume);
    window.addEventListener('auth:expired', suspend);
    window.addEventListener('auth:context-ending', suspend);
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
    window.removeEventListener('offline', suspend);
    window.removeEventListener('pagehide', suspend);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('auth:expired', suspend);
    window.removeEventListener('auth:context-ending', suspend);
    window.removeEventListener('task-data-changed', notify);
  };
}

/** Only the newest request in this mounted view may publish its snapshot. */
export function latestTaskLoader(read, accept) {
  let generation = 0;
  let disposed = false;
  return {
    async load() {
      const request = ++generation;
      let data;
      try { data = await read(); }
      catch (error) { if (disposed || request !== generation) return false; throw error; }
      if (disposed || request !== generation) return false;
      await accept(data);
      return true;
    },
    invalidate() { generation++; },
    dispose() { disposed = true; generation++; },
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
