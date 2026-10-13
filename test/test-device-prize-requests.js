import test from 'node:test';
import assert from 'node:assert/strict';
import * as requests from '../public/utils/reward-request.js';
const storage=()=>{const values=new Map();return {get length(){return values.size;},key:index=>[...values.keys()][index]||null,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
test('device pending purchase restores exact original cost before permitting a changed-price retry',()=>{
  assert.equal(typeof requests.pendingDevicePrize,'function');
  const saved=storage(),area='device:7:member:3',body={operation:'device-prize',catalog_id:1,user_id:3,expected_cost:10};
  const first=requests.rewardRequest(area,body,saved),pending=requests.pendingDevicePrize(area,saved);
  assert.equal(pending.key,first.key);assert.deepEqual(pending.body,body);
  const retried=requests.rewardRequest(area,pending.body,saved);assert.equal(retried.key,first.key);
  first.finish();assert.equal(requests.pendingDevicePrize(area,saved),null);
  assert.notEqual(requests.rewardRequest(area,{...body,expected_cost:11},saved).key,first.key);
});
test('device-member namespaces isolate pending purchases even without usable storage',()=>{
  assert.equal(typeof requests.pendingDevicePrize,'function');
  const saved={getItem(){throw Error('denied');},setItem(){throw Error('denied');}},body={operation:'device-prize',catalog_id:1,user_id:3,expected_cost:10};
  const first=requests.rewardRequest('device:8:member:3',body,saved),other=requests.rewardRequest('device:9:member:3',body,saved);
  assert.notEqual(first.key,other.key);assert.equal(requests.pendingDevicePrize('device:8:member:3',saved).key,first.key);
  assert.equal(requests.rewardRequest('device:8:member:3',requests.pendingDevicePrize('device:8:member:3',saved).body,saved).key,first.key);
  first.finish();other.finish();
});
test('interleaved independent tabs retain every unresolved device purchase and finishing removes only its own receipt',async()=>{
  const firstTab=await import('../public/utils/reward-request.js?tab=first'),secondTab=await import('../public/utils/reward-request.js?tab=second'),reloaded=await import('../public/utils/reward-request.js?tab=reloaded');
  const saved=storage(),area='device:22:member:3',body={operation:'device-prize',catalog_id:1,user_id:3,expected_cost:10};
  const write=saved.setItem;let interleaved=false,second;
  saved.setItem=(key,value)=>{if(!interleaved){interleaved=true;second=secondTab.rewardRequest(area,body,saved);}write(key,value);};
  const first=firstTab.rewardRequest(area,body,saved);assert.notEqual(first.key,second.key);
  const recovered=[];
  for(let index=0;index<2;index++){
    const pending=reloaded.pendingDevicePrize(area,saved);assert.ok(pending,'every unresolved purchase must survive a reload');
    const attempt=reloaded.rewardRequest(area,pending.body,saved);assert.equal(attempt.key,pending.key);recovered.push(pending.key);attempt.finish();
  }
  assert.deepEqual(new Set(recovered),new Set([first.key,second.key]));assert.equal(reloaded.pendingDevicePrize(area,saved),null);
});
test('a captured Check previous intent keeps its exact key after another context removes the persistent slot',async()=>{
  const saved=storage(),area='device:33:member:3',body={operation:'device-prize',catalog_id:1,user_id:3,expected_cost:10};
  const first=requests.rewardRequest(area,body,saved),captured=requests.pendingDevicePrize(area,saved);first.finish();
  const replay=await requests.claimDevicePrize(area,captured.body,saved,{requestKey:captured.key});
  assert.equal(replay.key,first.key);assert.equal(replay.durable,true);assert.deepEqual(replay.body,body);replay.finish();
});
