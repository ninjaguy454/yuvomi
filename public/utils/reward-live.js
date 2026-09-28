import { deviceContext } from './device-context.js';
/** Rewards-authorized invalidation, without requiring Tasks access. No payload
 * containing private ledger data crosses the stream; reloads use canonical APIs. */
export function watchRewardChanges(callback) {
  let stream = null, timer = null, fallback = null, disposed = false, authEnded = false, version = null, attempt = 0;
  const refresh = () => {
    if (disposed || authEnded) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!disposed && !authEnded && !document.hidden && navigator.onLine !== false) callback(); }, 100);
  };
  const suspend = () => { stream?.close(); stream = null; clearTimeout(timer); clearTimeout(fallback); fallback = null; };
  const endAuth = () => { authEnded = true; suspend(); };
  const connect = () => {
    if (disposed || authEnded || document.hidden || navigator.onLine === false) { suspend(); return; }
    if (fallback) return;
    if (stream?.readyState === 2) { stream.close(); stream = null; }
    if (!stream && typeof EventSource === 'function') {
      const source = new EventSource(`/api/v1/rewards/changes${deviceContext() ? `?context=${encodeURIComponent(deviceContext())}` : ''}`);
      stream = source;
      const change = event => {
        if (stream !== source || authEnded || disposed) return;
        let next; try { next = JSON.parse(event.data)?.version; } catch { /* reconnect refreshes */ }
        if (next != null && next === version) return;
        version = next; refresh();
      };
      source.addEventListener('open', () => { if (stream === source) { attempt = 0; refresh(); } }); source.addEventListener('change', change);
      source.addEventListener('message', change); source.addEventListener('error', () => {
        if (stream !== source || authEnded || disposed) return;
        source.close(); stream = null;
        // One readback handles revoked permissions. Subsequent retries back
        // off instead of each native EventSource error triggering a reload.
        if (attempt === 0) refresh();
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
        fallback = setTimeout(() => { fallback = null; connect(); }, delay);
      });
    } else if (typeof EventSource !== 'function') {
      clearTimeout(fallback); fallback = setTimeout(() => { fallback = null; refresh(); connect(); }, 30_000);
    }
  };
  const resume = () => { connect(); refresh(); };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume); window.addEventListener('online', resume);
  window.addEventListener('offline', suspend); window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume); window.addEventListener('auth:expired', endAuth);
  window.addEventListener('auth:context-ending', endAuth);
  connect();
  return () => {
    disposed = true; suspend();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
    window.removeEventListener('offline', suspend); window.removeEventListener('pagehide', suspend);
    window.removeEventListener('pageshow', resume); window.removeEventListener('auth:expired', endAuth);
    window.removeEventListener('auth:context-ending', endAuth);
  };
}
