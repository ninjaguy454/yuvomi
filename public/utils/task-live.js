import { auth } from '/api.js';

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
  stream = new EventSource('/api/v1/tasks/changes');
  stream.addEventListener('open', notify);
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

function resume() {
  if (document.hidden) { stream?.close(); stream = null; return; }
  connect();
  notify();
}

export function watchTaskChanges(callback) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('task-data-changed', notify);
    connect();
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size) return;
    stream?.close(); stream = null; version = null;
    notificationGeneration++;
    clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = null;
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
    window.removeEventListener('online', resume);
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
