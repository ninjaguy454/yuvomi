/**
 * Modul: Web Push (Client)
 * Zweck: Push-Subscription verwalten und Status zwischenspeichern.
 * Abhängigkeiten: /api.js
 */
import { api } from '/api.js';
import { isWallModeEnabled } from '/utils/wall-mode.js';

let _subscribedCache = false;
let _privacyListening = false;
let _generation = 0;
let _deliveryVerified = false;

function currentOperation(generation) {
  return generation === _generation && !isWallModeEnabled();
}

async function syncWorkerPrivacy(registration) {
  if (!('serviceWorker' in navigator)) return;
  const reg = registration || await navigator.serviceWorker.ready;
  const enabled = isWallModeEnabled() || !_deliveryVerified;
  (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'SET_SHARED_DISPLAY', enabled });
}

function invalidateDelivery() {
  _generation++;
  _subscribedCache = false;
  _deliveryVerified = false;
  void syncWorkerPrivacy().catch(() => {});
  return _generation;
}

async function syncSharedDisplay() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  await syncWorkerPrivacy(reg);
  if (isWallModeEnabled() && 'PushManager' in window) await disablePush();
}

function onWallModeChange() {
  invalidateDelivery();
  void syncSharedDisplay().catch(() => {});
}
function onWallStorage(event) { if (event.key === 'yuvomi-wall-mode') onWallModeChange(); }

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Synchron gecachter Status (für reminders.js). */
function isPushSubscribed() {
  return _subscribedCache;
}

async function pushStatus() {
  const generation = _generation;
  if (isWallModeEnabled()) {
    invalidateDelivery();
    return { supported: pushSupported(), permission: 'Notification' in window ? Notification.permission : 'unsupported', subscribed: false, shared: true };
  }
  if (!pushSupported()) {
    _subscribedCache = false;
    return { supported: false, permission: 'unsupported', subscribed: false };
  }
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!currentOperation(generation)) return { supported: true, subscribed: false, shared: isWallModeEnabled() };
    if (sub) {
      const response = await api.post('/push/status', { endpoint: sub.endpoint });
      if (!currentOperation(generation)) return { supported: true, subscribed: false, shared: isWallModeEnabled() };
      subscribed = response?.data?.subscribed === true;
      // A browser subscription can outlive a signed-in user. Never display another
      // person's notifications or silently transfer their device on session switch.
      if (!subscribed) await sub.unsubscribe();
    }
  } catch {
    subscribed = false;
  }
  if (!currentOperation(generation)) return { supported: true, subscribed: false, shared: isWallModeEnabled() };
  _subscribedCache = subscribed;
  _deliveryVerified = subscribed;
  await syncWorkerPrivacy();
  return { supported: true, permission: Notification.permission, subscribed: currentOperation(generation) && subscribed };
}

async function enablePush() {
  if (isWallModeEnabled()) return { subscribed: false, shared: true };
  if (!pushSupported()) throw new Error('unsupported');
  const generation = invalidateDelivery();
  const permission = await Notification.requestPermission();
  if (!currentOperation(generation)) return { subscribed: false, shared: isWallModeEnabled() };
  if (permission !== 'granted') {
    _subscribedCache = false;
    return { subscribed: false, permission };
  }
  const reg = await navigator.serviceWorker.ready;
  if (!currentOperation(generation)) return { subscribed: false, shared: isWallModeEnabled() };
  const { data } = await api.get('/push/vapid-public-key');
  if (!currentOperation(generation)) return { subscribed: false, shared: isWallModeEnabled() };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.key),
  });
  if (!currentOperation(generation)) { await sub.unsubscribe(); return { subscribed: false, shared: isWallModeEnabled() }; }
  try { await api.post('/push/subscribe', sub.toJSON()); }
  catch (error) { await sub.unsubscribe(); throw error; }
  if (!currentOperation(generation)) { await sub.unsubscribe(); return { subscribed: false, shared: isWallModeEnabled() }; }
  _subscribedCache = true;
  _deliveryVerified = true;
  await syncWorkerPrivacy(reg);
  return { subscribed: currentOperation(generation) && _subscribedCache, permission };
}

async function disablePush() {
  const generation = invalidateDelivery();
  if (!pushSupported()) return { subscribed: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (generation !== _generation) return { subscribed: false };
  if (sub) {
    // Revoke locally first: even an expired session/offline server must not keep
    // personal contents arriving on a device that has become a shared display.
    await sub.unsubscribe();
    try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* expired endpoint is removed on next delivery */ }
  }
  _subscribedCache = false;
  return { subscribed: false };
}

/** true, wenn das Abo mit genau diesem applicationServerKey erstellt wurde. */
function matchesServerKey(sub, serverKey) {
  const local = sub.options?.applicationServerKey;
  if (!local) return true; // Kein Vergleich möglich - Abo nicht wegwerfen.
  const bytes = new Uint8Array(local);
  if (bytes.length !== serverKey.length) return false;
  return bytes.every((b, i) => b === serverKey[i]);
}

/**
 * Verify the local subscription's owner. Restoring server registration is an
 * explicit repair action, since a browser can be shared between signed-in users.
 */
async function resyncSubscription() {
  if (isWallModeEnabled()) return false;
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  return (await pushStatus()).subscribed;
}

/**
 * Vollständige Reparatur nach erfolgloser Zustellung: legt das Abo neu an, wenn es
 * lokal fehlt oder auf einem anderen VAPID-Key läuft als der Server inzwischen nutzt
 * (z. B. nach DB-Restore ohne sync_config). Fragt nicht erneut nach der Berechtigung,
 * setzt eine bereits erteilte also voraus.
 */
async function repairPush() {
  if (isWallModeEnabled()) return false;
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const generation = invalidateDelivery();
  const reg = await navigator.serviceWorker.ready;
  if (!currentOperation(generation)) return false;
  const { data } = await api.get('/push/vapid-public-key');
  if (!currentOperation(generation)) return false;
  const serverKey = urlBase64ToUint8Array(data.key);

  let sub = await reg.pushManager.getSubscription();
  if (!currentOperation(generation)) return false;
  if (sub && !matchesServerKey(sub, serverKey)) {
    // Abo auf altem Key: serverseitig abmelden, damit keine Karteileiche bleibt.
    try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* egal */ }
    try { await sub.unsubscribe(); } catch { /* egal */ }
    sub = null;
  }
  if (!currentOperation(generation)) return false;
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  }
  if (!currentOperation(generation)) { await sub.unsubscribe(); return false; }
  try { await api.post('/push/subscribe', sub.toJSON()); }
  catch (error) { await sub.unsubscribe(); throw error; }
  if (!currentOperation(generation)) { await sub.unsubscribe(); return false; }
  _subscribedCache = true;
  _deliveryVerified = true;
  await syncWorkerPrivacy(reg);
  return currentOperation(generation) && _subscribedCache;
}

/** Verify device privacy and ownership at startup; never silently register it. */
async function initPush() {
  const generation = _generation;
  if (!_privacyListening) {
    window.addEventListener('yuvomi:wall-mode-change', onWallModeChange);
    window.addEventListener('storage', onWallStorage);
    _privacyListening = true;
  }
  try {
    await syncSharedDisplay();
    if (!currentOperation(generation)) return;
    await pushStatus();
  } catch { /* ignore */ }
}

function stopPush() {
  invalidateDelivery();
  // Logout closes the local delivery endpoint; a subsequent user must opt in.
  void disablePush().catch(() => {});
}

export {
  pushSupported, pushStatus, isPushSubscribed, enablePush, disablePush,
  resyncSubscription, repairPush, initPush, stopPush,
};
