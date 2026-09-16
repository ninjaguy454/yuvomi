// Keep an uncertain redemption's intent across a reload. A retry reuses the
// durable server key; a confirmed success clears it for the next intentional use.
export function newRewardRequestKey(cryptoSource = globalThis.crypto) {
  if (cryptoSource?.randomUUID) return cryptoSource.randomUUID();
  // randomUUID is secure-context-only; the supported local HTTP fallback still
  // exposes getRandomValues in Android WebView and Chromium.
  const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
// The Wall creates a handle on each tap rather than retaining a dialog handle.
// Keep unresolved intents in memory as well when storage is denied/full. Scope
// the cache to the storage area and member, including a stable no-storage area.
const requestCaches = new WeakMap();
const noStorageCaches = new Map();
function pendingCache(storage, storageKey, useDefaultArea) {
  let caches = noStorageCaches;
  if (!useDefaultArea && storage && (typeof storage === 'object' || typeof storage === 'function')) {
    if (!requestCaches.has(storage)) requestCaches.set(storage, new Map());
    caches = requestCaches.get(storage);
  }
  if (!caches.has(storageKey)) caches.set(storageKey, { pending: new Map(), completed: new Set() });
  return caches.get(storageKey);
}

function requestStore(userId, storage) {
  const useDefaultArea = storage === undefined;
  if (useDefaultArea) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  const storageKey = `vidamia-reward-requests:${userId}`;
  // Keep the default area's identity stable even if its property getter starts
  // or stops throwing between two taps after browser storage settings change.
  const cache = pendingCache(storage, storageKey, useDefaultArea);
  const mergeStored = () => {
    try {
      const value = JSON.parse(storage?.getItem(storageKey));
      if (Array.isArray(value)) for (const item of value) {
        if (typeof item?.intent === 'string' && typeof item?.key === 'string' && item.key && !cache.completed.has(item.key)) {
          cache.pending.set(item.key, item);
        }
      }
    } catch { /* pending intents remain available from the in-memory cache */ }
  };
  const write = () => {
    try { storage?.setItem(storageKey, JSON.stringify([...cache.pending.values()])); } catch { /* the shared cache still retains every unresolved key */ }
  };
  mergeStored();
  return {cache,mergeStored,write};
}

/** Restore the oldest unresolved adjustment before allowing a different one.
 * Its stored intent is the original submitted snapshot, not current form data. */
export function pendingPointAdjustment(userId,storage) {
  const {cache}=requestStore(userId,storage);
  for(const request of cache.pending.values()) {
    let value;try{value=JSON.parse(request.intent);}catch{continue;}
    if(!Array.isArray(value)||value[0]!=='adjustment'||value.length!==7)continue;
    const [,user_id,delta,reason,related_task_id,related_reward_id,related_ledger_id]=value;
    if(!Number.isSafeInteger(user_id)||!Number.isSafeInteger(delta)||!delta||typeof reason!=='string')continue;
    return {key:request.key,body:{user_id,delta,reason,related_task_id,related_reward_id,related_ledger_id}};
  }
  return null;
}

export function rewardRequest(userId, body, storage) {
  const {cache,mergeStored,write}=requestStore(userId,storage);
  const intent = body.operation==='adjustment'
    ? JSON.stringify(['adjustment',body.user_id,body.delta,body.reason,body.related_task_id || null,body.related_reward_id || null,body.related_ledger_id || null])
    : JSON.stringify([body.catalog_id, body.user_id, body.note || '']);
  let request = [...cache.pending.values()].find(item => item.intent === intent);
  if (!request) { request = { intent, key: newRewardRequestKey() }; cache.pending.set(request.key, request); }
  write();
  return { key: request.key, finish() {
    // Merge at completion time, not from the snapshot captured when this handle
    // was created. Finishing A must never drop a later unresolved request B.
    mergeStored();
    cache.completed.add(request.key);
    cache.pending.delete(request.key);
    write();
  } };
}
