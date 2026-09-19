// Authentication context is an in-memory nonce, never a device credential.
// The durable hint only selects the safe bootstrap. The server still authenticates.
export const PAIRED_DEVICE_HINT = 'vidamia-paired-device';
let context = null;
let epoch = 0;
let bootstrap = null;
const requests = new Set();

export function pairedDeviceHint() {
  try { return localStorage.getItem(PAIRED_DEVICE_HINT) === '1'; } catch { return false; }
}
export function deviceBootstrap() { return bootstrap; }
export function deviceContext() { return context; }
export function authenticationSnapshot() { return { context, epoch }; }
export function sameAuthentication(snapshot) { return snapshot.epoch === epoch && snapshot.context === context; }
export function trackContextRequest(controller) { requests.add(controller); return () => requests.delete(controller); }
export function invalidateAuthentication() {
  epoch++;
  for (const controller of requests) controller.abort();
  requests.clear();
}
export function acceptAuthentication(payload) {
  if (payload.device || payload.principal?.kind === 'device') {
    try { localStorage.setItem(PAIRED_DEVICE_HINT, '1'); } catch { /* cookies remain authoritative */ }
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'PAIRED_DEVICE', enabled: true });
      navigator.serviceWorker?.controller?.postMessage({ type: 'SET_SHARED_DISPLAY', enabled: true });
    } catch { /* no service worker required */ }
  }
  if (!payload?.authContext) return;
  const previous = context;
  if (previous && previous !== payload.authContext) invalidateAuthentication();
  context = payload.authContext;
  bootstrap = payload;
  window.dispatchEvent(new CustomEvent('vidamia:auth-context', { detail: payload }));
}

export function concealPersonalContext() {
  invalidateAuthentication();
  document.documentElement.style.visibility = 'hidden';
  window.dispatchEvent(new CustomEvent('auth:context-ending'));
}
