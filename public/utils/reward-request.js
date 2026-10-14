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
  if(['device-prize','device-prize-cart'].includes(body.operation))return devicePrizeRequest(userId,body,storage);
  const {cache,mergeStored,write}=requestStore(userId,storage);
  const intent = body.operation==='undo'
    ? JSON.stringify(['undo',body.redemption_id,body.expected_status,body.confirm_delivered,body.reason])
    : body.operation==='adjustment'
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

// Device purchases use one durable record per request, so another tab cannot
// overwrite an unresolved purchase by writing a stale aggregate list.
function devicePrizeStore(area,storage) {
  const useDefaultArea=storage===undefined;
  if(useDefaultArea){try{storage=globalThis.sessionStorage;}catch{storage=null;}}
  const prefix=`vidamia-device-prize-requests:${area}:`,cache=pendingCache(storage,prefix,useDefaultArea);
  try {
    for(let index=0;index<storage.length;index++) {
      const name=storage.key(index);if(!name?.startsWith(prefix))continue;
      const request=JSON.parse(storage.getItem(name));
      if(typeof request?.key==='string'&&request.key&&name===prefix+request.key
        &&typeof request.intent==='string'&&!cache.completed.has(request.key))cache.pending.set(request.key,request);
    }
  }catch{/* The stable cache preserves known intent while storage is denied. */}
  return {cache,persist(request){
    const name=prefix+request.key,value=JSON.stringify(request);
    try{storage.setItem(name,value);return storage.getItem(name)===value;}catch{return false;}
  },remove(key){try{storage.removeItem(prefix+key);}catch{/* A future reload can safely replay its retained receipt. */}}};
}
function devicePrizeRequest(area,body,storage,requestKey=null) {
  const {cache,persist,remove}=devicePrizeStore(area,storage);
  const intent=Array.isArray(body.items)?JSON.stringify(['device-prize-cart',body.user_id,body.items,body.expected_cost,body.note||'']):JSON.stringify(['device-prize',body.catalog_id,body.user_id,body.expected_cost,body.note||'']);
  let request=requestKey?cache.pending.get(requestKey):[...cache.pending.values()].find(item=>item.intent===intent);
  if(request&&request.intent!==intent)throw new Error('The previous purchase intent changed.');
  if(!request)request={intent,key:requestKey||newRewardRequestKey()};
  // A Check dialog retains its exact key even if another handle confirmed and
  // removed that slot while the dialog was open. Restore only that receipt.
  cache.completed.delete(request.key);cache.pending.set(request.key,request);
  const durable=persist(request);
  return {key:request.key,durable,finish(){cache.completed.add(request.key);cache.pending.delete(request.key);remove(request.key);}};
}

/** Claim the pending member purchase before dispatch. Web Locks serialize tabs
 * when supported; individual records still retain all intents without locks. */
export async function claimDevicePrize(area,body,storage,{requestKey=null}={}) {
  const claim=()=>{
    const pending=requestKey?null:pendingDevicePrize(area,storage),original=pending?.body||body;
    const attempt=devicePrizeRequest(area,original,storage,requestKey);
    if(!attempt.durable){const error=new Error('Browser storage is unavailable. Allow storage before redeeming a prize.');error.reason='device_prize_storage_unavailable';throw error;}
    return {...attempt,body:original};
  };
  const locks=globalThis.navigator?.locks;
  return locks?.request?locks.request(`vidamia-device-prize:${area}`,claim):claim();
}

/** Shared displays must reconcile the original purchase before starting another
 * for this member. Never replace its submitted price after an uncertain result. */
export function pendingDevicePrize(area,storage) {
  const {cache}=devicePrizeStore(area,storage);
  for(const request of cache.pending.values()) {
    let value;try{value=JSON.parse(request.intent);}catch{continue;}
    if(!Array.isArray(value)||value.length!==5)continue;
    if(value[0]==='device-prize-cart') {
      const [,user_id,items,expected_cost,note]=value;
      if(!Number.isSafeInteger(user_id)||user_id<=0||!Array.isArray(items)||!items.length||typeof note!=='string'||!Number.isSafeInteger(expected_cost)||expected_cost<0)continue;
      const ids=new Set();let units=0,total=0;
      if(items.some(item=>{
        if(!Number.isSafeInteger(item?.catalog_id)||item.catalog_id<=0||ids.has(item.catalog_id)||!Number.isSafeInteger(item.quantity)||item.quantity<=0||!Number.isSafeInteger(item.expected_cost)||item.expected_cost<0)return true;
        ids.add(item.catalog_id);units+=item.quantity;total+=item.quantity*item.expected_cost;return units>100||!Number.isSafeInteger(total);
      })||total!==expected_cost)continue;
      return {key:request.key,body:{operation:'device-prize-cart',user_id,items,expected_cost,...(note?{note}:{})}};
    }
    if(value[0]!=='device-prize')continue;
    const [,catalog_id,user_id,expected_cost,note]=value;
    if(!Number.isSafeInteger(catalog_id)||catalog_id<=0||!Number.isSafeInteger(user_id)||user_id<=0
      ||!Number.isSafeInteger(expected_cost)||expected_cost<0||typeof note!=='string')continue;
    return {key:request.key,body:{operation:'device-prize',catalog_id,user_id,expected_cost,...(note?{note}:{})}};
  }
  return null;
}

/** Reconcile the submitted Undo after reload, using its original confirmation. */
export function pendingPrizeUndo(userId,redemptionId,storage) {
  const {cache}=requestStore(userId,storage);
  for(const request of cache.pending.values()) {
    let value;try{value=JSON.parse(request.intent);}catch{continue;}
    if(!Array.isArray(value)||value.length!==5||value[0]!=='undo')continue;
    const [,redemption_id,expected_status,confirm_delivered,reason]=value;
    if(redemption_id!==redemptionId||!['pending','fulfilled'].includes(expected_status)
      ||typeof confirm_delivered!=='boolean'||typeof reason!=='string')continue;
    return {key:request.key,body:{operation:'undo',redemption_id,expected_status,confirm_delivered,reason}};
  }
  return null;
}
