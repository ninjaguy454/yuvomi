import { deviceContext } from './device-context.js';

/** Payload-free invalidation. Every reconnect re-fetches the authorized projection. */
export function watchNoteChanges(refresh) {
  let source = null, stopped = false, timer = null;
  const notify = () => { if (!stopped) Promise.resolve(refresh()).catch(() => {}); };
  function connect() {
    clearTimeout(timer);
    if (stopped || document.hidden || navigator.onLine === false) return;
    source?.close();
    if (typeof EventSource !== 'function') { notify(); timer = setTimeout(connect, 30000); return; }
    source = new EventSource(`/api/v1/notes/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
    source.addEventListener('open', notify);
    for (const event of ['message', 'change', 'notes']) source.addEventListener(event, notify);
    source.addEventListener('error', () => {
      source?.close(); source = null;
      // Revocation can close a stream before it emits another event.
      notify(); timer = setTimeout(connect, 5000);
    });
  }
  function resume() { if (document.hidden) { source?.close(); source = null; clearTimeout(timer); } else { notify(); connect(); } }
  function stop() { stopped = true; source?.close(); source = null; clearTimeout(timer); }
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('auth:context-ending', stop);
  window.addEventListener('auth:expired', stop);
  connect();
  return () => {
    stop(); document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume); window.removeEventListener('focus', resume);
    window.removeEventListener('auth:context-ending', stop); window.removeEventListener('auth:expired', stop);
  };
}
