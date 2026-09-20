import { api } from '/api.js';
import { deviceBootstrap, pairedDeviceHint, concealPersonalContext, acceptAuthentication, deviceContext, isDevicePrincipal } from './device-context.js';
import { broadcastSessionChange } from './session-lifecycle.js';
import { clearApiCache } from '/sw-register.js';
import { esc } from './html.js';
import { setPermissions } from '/permissions.js';

let timer, heartbeat = 0, leaving = false, installed = false, bannerObserver, stopDeviceChanges, bannerSignature;
const LOGIN_INTENT = 'vidamia-temporary-login';
export function temporaryLoginPending() { try { return sessionStorage.getItem(LOGIN_INTENT) === '1'; } catch { return false; } }
export async function beginTemporarySignIn() {
  await api.post('/device/temporary/begin', {});
  try { sessionStorage.setItem(LOGIN_INTENT, '1'); localStorage.removeItem('yuvomi-wall-mode'); } catch {}
  clearApiCache();
  window.yuvomi?.clearSession();
  // The header can be tapped while its initial data is loading. Retain this
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
    const signature = JSON.stringify([data?.authContext, data?.device?.revision, data?.device?.name, data?.temporary]);
    if (signature === bannerSignature && document.querySelector('[data-device-access], [data-temporary-access]')) return;
    bannerSignature = signature;
    clearTimeout(timer);
    document.querySelector('[data-temporary-access]')?.remove();
    document.querySelector('[data-device-access]')?.remove();
    bannerObserver?.disconnect();
    document.documentElement.style.removeProperty('--auth-banner-height');
    document.documentElement.toggleAttribute('data-device-principal', isDevicePrincipal());
    document.documentElement.toggleAttribute('data-paired-context', !!data?.device);
    if (!data?.temporary && !isDevicePrincipal()) return;
    if (isDevicePrincipal()) {
      const banner = document.createElement('aside');
      banner.dataset.deviceAccess = '';
      banner.className = 'device-access-banner';
      banner.setAttribute('aria-label', 'Paired household device');
      banner.innerHTML = '<div><strong>' + esc(data.device?.name || data.user?.display_name || 'Household display') + '</strong><span>Shared display · device permissions apply</span></div><button type="button" class="btn btn--secondary" data-device-login>Sign in temporarily</button>';
      banner.querySelector('button').onclick = () => beginTemporarySignIn().catch(error => window.yuvomi?.showToast(error.message, 'danger'));
      document.body.prepend(banner);
      sizeBanner(banner);
      if (!stopDeviceChanges) stopDeviceChanges = deviceChanges(() => window.dispatchEvent(new CustomEvent('task-data-changed')));
      return;
    }
    stopDeviceChanges?.(); stopDeviceChanges = null;
    try { sessionStorage.removeItem(LOGIN_INTENT); } catch {}
    const banner = document.createElement('aside');
    banner.dataset.temporaryAccess = '';
    banner.className = 'device-temporary-banner';
    banner.setAttribute('aria-label', 'Temporary personal access');
    banner.innerHTML = `<strong>Signed in as ${esc(data.user?.display_name || data.user?.username || 'administrator')}</strong><button type="button" class="btn btn--secondary">Return to ${esc(data.device?.name || 'household display')}</button>`;
    banner.querySelector('button').onclick = returnToDevice;
    document.body.prepend(banner);
    sizeBanner(banner);
    const expiry = Math.min(new Date(data.temporary.idleExpiresAt).getTime(), new Date(data.temporary.expiresAt).getTime());
    timer = setTimeout(returnToDevice, Math.max(0, expiry - Date.now()));
  };
  function sizeBanner(banner) {
    const size = () => document.documentElement.style.setProperty('--auth-banner-height', banner.getBoundingClientRect().height + 'px');
    size();
    if (typeof ResizeObserver === 'function') { bannerObserver = new ResizeObserver(size); bannerObserver.observe(banner); }
  }
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
  let stream, stopped = false;
  const connect = () => {
    stream?.close();
    if (stopped || document.hidden || navigator.onLine === false || !deviceContext()) return;
    stream = new EventSource(`/api/v1/device/changes?context=${encodeURIComponent(deviceContext())}`);
    stream.addEventListener('change', callback);
    stream.addEventListener('context', () => { void returnToDevice(); });
    stream.addEventListener('message', callback);
    stream.addEventListener('error', callback);
  };
  const end = () => stream?.close();
  window.addEventListener('auth:context-ending', end);
  document.addEventListener('visibilitychange', connect);
  window.addEventListener('online', connect);
  connect();
  return () => { stopped = true; end(); window.removeEventListener('auth:context-ending', end); document.removeEventListener('visibilitychange', connect); window.removeEventListener('online', connect); };
}
