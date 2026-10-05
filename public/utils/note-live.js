import { deviceContext, authenticationSnapshot, sameAuthentication } from './device-context.js';

/** Payload-free invalidation. Every reconnect re-fetches the authorized projection. */
export function watchNoteChanges(refresh) {
  let source = null, stopped = false, timer = null;
  const auth = authenticationSnapshot();
  const current = () => !stopped && sameAuthentication(auth);
  const notify = () => {
    if (!current()) { stop(); return; }
    try { Promise.resolve(refresh()).catch(() => {}); } catch { /* refresh owns its error presentation */ }
  };
  function connect() {
    clearTimeout(timer);
    if (!current()) { stop(); return; }
    if (document.hidden || navigator.onLine === false) return;
    source?.close();
    if (typeof EventSource !== 'function') { notify(); timer = setTimeout(connect, 30000); return; }
    source = new EventSource(`/api/v1/notes/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
    const connected = source;
    source.addEventListener('open', notify);
    for (const event of ['message', 'change', 'notes']) source.addEventListener(event, notify);
    source.addEventListener('error', () => {
      if (!current() || source !== connected) return;
      source?.close(); source = null;
      // Revocation can close a stream before it emits another event.
      notify(); timer = setTimeout(connect, 5000);
    });
  }
  function resume() { if (!current()) { stop(); return; } if (document.hidden) { source?.close(); source = null; clearTimeout(timer); } else { notify(); connect(); } }
  function stop() { stopped = true; source?.close(); source = null; clearTimeout(timer); }
  function contextChanged() { if (!sameAuthentication(auth)) stop(); }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('auth:context-ending', stop);
  window.addEventListener('auth:expired', stop);
  window.addEventListener('auth:context-rejected', stop);
  window.addEventListener('vidamia:auth-context', contextChanged);
  connect();
  return () => {
    stop(); document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume); window.removeEventListener('focus', resume);
    window.removeEventListener('auth:context-ending', stop); window.removeEventListener('auth:expired', stop);
    window.removeEventListener('auth:context-rejected', stop); window.removeEventListener('vidamia:auth-context', contextChanged);
  };
}
