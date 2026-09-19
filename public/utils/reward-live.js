import { deviceContext } from './device-context.js';
/** Rewards-authorized invalidation, without requiring Tasks access. No payload
 * containing private ledger data crosses the stream; reloads use canonical APIs. */
export function watchRewardChanges(callback) {
  let stream = null, timer = null, fallback = null, disposed = false, version = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!disposed && !document.hidden && navigator.onLine !== false) callback(); }, 100);
  };
  const suspend = () => { stream?.close(); stream = null; clearTimeout(timer); clearTimeout(fallback); };
  const connect = () => {
    if (disposed || document.hidden || navigator.onLine === false) { suspend(); return; }
    if (stream?.readyState === 2) { stream.close(); stream = null; }
    if (!stream && typeof EventSource === 'function') {
      stream = new EventSource(`/api/v1/rewards/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
      const change = event => {
        let next; try { next = JSON.parse(event.data)?.version; } catch { /* reconnect refreshes */ }
        if (next != null && next === version) return;
        version = next; refresh();
      };
      stream.addEventListener('open', refresh); stream.addEventListener('change', change);
      stream.addEventListener('message', change); stream.addEventListener('error', refresh);
    } else if (typeof EventSource !== 'function') {
      clearTimeout(fallback); fallback = setTimeout(() => { refresh(); connect(); }, 30_000);
    }
  };
  const resume = () => { connect(); refresh(); };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume); window.addEventListener('online', resume);
  window.addEventListener('offline', suspend); window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume); window.addEventListener('auth:expired', suspend);
  window.addEventListener('auth:context-ending', suspend);
  connect();
  return () => {
    disposed = true; suspend();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    window.removeEventListener('offline', suspend); window.removeEventListener('pagehide', suspend);
    window.removeEventListener('pageshow', resume); window.removeEventListener('auth:expired', suspend);
    window.removeEventListener('auth:context-ending', suspend);
  };
}
