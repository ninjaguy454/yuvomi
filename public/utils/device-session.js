import { api } from '/api.js';
import { deviceBootstrap, pairedDeviceHint, concealPersonalContext, acceptAuthentication, deviceContext, isDevicePrincipal } from './device-context.js';
import { broadcastSessionChange } from './session-lifecycle.js';
import { clearApiCache } from '/sw-register.js';
import { esc } from './html.js';
import { setPermissions } from '/permissions.js';

let timer, heartbeat = 0, leaving = false, installed = false, stopDeviceChanges, sessionSignature;
const LOGIN_INTENT = 'vidamia-temporary-login';
export function temporaryLoginPending() { try { return sessionStorage.getItem(LOGIN_INTENT) === '1'; } catch { return false; } }
export async function beginTemporarySignIn() {
  await api.post('/device/temporary/begin', {});
  try { sessionStorage.setItem(LOGIN_INTENT, '1'); localStorage.removeItem('yuvomi-wall-mode'); } catch {}
  clearApiCache();
  window.yuvomi?.clearSession();
  // The session action can be tapped while its initial data is loading. Retain this
  // explicit action while the router finishes a navigation already in flight.
  for(let attempt=0;attempt<40;attempt++){
    await window.yuvomi.navigate('/login');
    if(location.pathname==='/login')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
export async function returnToDevice() {
  if (leaving) return;
  leaving = true;
  concealPersonalContext();
  clearApiCache();
  try { sessionStorage.removeItem(LOGIN_INTENT); } catch {}
  try { await api.post('/device/return', {}); } catch { /* fresh launch also ends any privileged lease */ }
  broadcastSessionChange('device');
  location.replace('/device');
}

export async function prepareDeviceBoot() {
  if (!pairedDeviceHint()) return null;
  let resume = false;
  try { resume = sessionStorage.getItem('vidamia-context-resume') === '1'; sessionStorage.removeItem('vidamia-context-resume'); } catch {}
  const navigation = performance.getEntriesByType('navigation')[0]?.type;
  const handoff = new URL(location.href).searchParams.get('temporary_handoff') === '1' && navigation === 'navigate';
  const cleanUrl = new URL(location.href);
  if (cleanUrl.searchParams.has('temporary_handoff')) { cleanUrl.searchParams.delete('temporary_handoff'); history.replaceState(history.state, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`); }
  const result = resume
    ? await api.get('/device/context')
    : await api.post('/device/launch', { temporary_handoff: handoff });
  try { if(result.temporaryLoginPending) sessionStorage.setItem(LOGIN_INTENT,'1'); else sessionStorage.removeItem(LOGIN_INTENT); } catch {}
  acceptAuthentication(result);
  setPermissions({ ...result.permissions, principal_kind: result.principal?.kind || result.user?.kind || 'member' });
  try { localStorage.removeItem('yuvomi-wall-mode'); } catch {}
  return result;
}

export function installDeviceSession() {
  if (installed) return;
  installed = true;
  if(pairedDeviceHint()){const css=document.createElement('link');css.rel='stylesheet';css.href='/styles/device.css';document.head.append(css);}
  const update = () => {
    const data = deviceBootstrap();
    const signature = JSON.stringify([data?.authContext, data?.device?.revision, data?.temporary]);
    if (signature === sessionSignature) return;
    sessionSignature = signature;
    clearTimeout(timer);
    document.documentElement.toggleAttribute('data-device-principal', isDevicePrincipal());
    document.documentElement.toggleAttribute('data-paired-context', !!data?.device);
    if (isDevicePrincipal()) {
      if (!stopDeviceChanges) stopDeviceChanges = deviceChanges(() => window.dispatchEvent(new CustomEvent('task-data-changed')));
      return;
    }
    stopDeviceChanges?.(); stopDeviceChanges = null;
    if (!data?.temporary) return;
    try { sessionStorage.removeItem(LOGIN_INTENT); } catch {}
    const expiry = Math.min(new Date(data.temporary.idleExpiresAt).getTime(), new Date(data.temporary.expiresAt).getTime());
    timer = setTimeout(returnToDevice, Math.max(0, expiry - Date.now()));
  };
  window.addEventListener('vidamia:auth-context', update);
  window.addEventListener('auth:context-rejected', () => { if (pairedDeviceHint()) void returnToDevice(); });
  const activity = () => {
    if (!deviceBootstrap()?.temporary || Date.now() - heartbeat < 15_000 || leaving) return;
    heartbeat = Date.now();
    void api.post('/device/activity', {}).catch(() => returnToDevice());
  };
  document.addEventListener('pointerdown', activity, { passive: true });
  document.addEventListener('keydown', activity, { passive: true });
  // Freeze/BFCache and sleep are privacy boundaries. Never preserve privileged
  // HTML and hope an asynchronous expiry check finishes before first paint.
  window.addEventListener('pagehide', () => { if (deviceBootstrap()?.temporary) concealPersonalContext(); });
  window.addEventListener('pageshow', event => { if (event.persisted && pairedDeviceHint()) location.replace('/device'); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && deviceBootstrap()?.temporary) void returnToDevice();
  });
  window.addEventListener('offline', () => { if (deviceBootstrap()?.temporary) void returnToDevice(); });
  update();
}

export function deviceChanges(callback) {
  let stream, stopped = false, retryTimer, attempt = 0;
  const active = () => !stopped && !document.hidden && navigator.onLine !== false && deviceContext();
  const retry = () => {
    if (!active() || retryTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
  const connect = () => {
    if (!active()) { end(); return; }
    if (stream || retryTimer || typeof EventSource !== 'function') return;
    const source = new EventSource(`/api/v1/device/changes?context=${encodeURIComponent(deviceContext())}`);
    stream = source;
    const change = () => { if (stream === source && active()) callback(); };
    source.addEventListener('open', () => { if (stream === source) { attempt = 0; change(); } });
    source.addEventListener('change', change);
    source.addEventListener('context', () => { if (stream === source && active()) void returnToDevice(); });
    source.addEventListener('message', change);
    source.addEventListener('error', () => {
      if (stream !== source || !active()) return;
      source.close(); stream = null;
      // Probe the device context, not every Task view. A 502 must not fan out
      // full-board reloads; real revocation still uses canonical API handling.
      void api.get('/device/context').then(() => { if (active()) callback(); }).catch(error => {
        if (active() && (error.status === 401 || ['device_revoked', 'device_context_changed', 'temporary_session_expired'].includes(error.data?.reason))) void returnToDevice();
      });
      retry();
    });
  };
  const end = () => { stream?.close(); stream = null; clearTimeout(retryTimer); retryTimer = null; };
  const endAuth = () => { stopped = true; end(); };
  window.addEventListener('auth:context-ending', endAuth);
  window.addEventListener('auth:expired', endAuth);
  window.addEventListener('offline', end);
  window.addEventListener('pagehide', end);
  window.addEventListener('pageshow', connect);
  document.addEventListener('visibilitychange', connect);
  window.addEventListener('online', connect);
  connect();
  return () => {
    stopped = true; end();
    window.removeEventListener('auth:context-ending', endAuth); window.removeEventListener('auth:expired', endAuth);
    window.removeEventListener('offline', end); window.removeEventListener('pagehide', end); window.removeEventListener('pageshow', connect);
    document.removeEventListener('visibilitychange', connect); window.removeEventListener('online', connect);
  };
}
