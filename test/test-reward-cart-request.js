import test from 'node:test';import assert from 'node:assert/strict';
import {claimDevicePrize,pendingDevicePrize} from '../public/utils/reward-request.js';
const area='device:cart-fixture:member:2';
const backing=()=>{const values=new Map();return {values,storage:{get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};};
const body=()=>({operation:'device-prize-cart',user_id:2,items:[{catalog_id:1,quantity:2,expected_cost:10},{catalog_id:3,quantity:1,expected_cost:5}],expected_cost:25});
test('confirmed cart preserves its exact quantities and price snapshot across a fresh storage instance',async()=>{
 const {storage,values}=backing(),first=await claimDevicePrize(area,body(),storage);const reload=backing();for(const [k,v]of values)reload.values.set(k,v);
 const pending=pendingDevicePrize(area,reload.storage);assert.ok(pending,'Cart intent must survive reload');assert.equal(pending.key,first.key);assert.deepEqual(pending.body,body());
 const changed=body();changed.items[0].expected_cost=20;changed.expected_cost=45;const retry=await claimDevicePrize(area,changed,reload.storage);assert.equal(retry.key,first.key);assert.deepEqual(retry.body,body());
});
test('old single-item intent blocks replacing it with a new cart until its receipt is resolved',async()=>{
 const {storage}=backing(),old={operation:'device-prize',catalog_id:1,user_id:2,expected_cost:10};const first=await claimDevicePrize(area,old,storage),cart=await claimDevicePrize(area,body(),storage);assert.equal(cart.key,first.key);assert.deepEqual(cart.body,old);cart.finish();assert.equal(pendingDevicePrize(area,storage),null);
});
test('a captured completed cart key is reconciled as itself even after another handle removes the slot',async()=>{
 const {storage}=backing(),first=await claimDevicePrize(area,body(),storage);first.finish();const check=await claimDevicePrize(area,body(),storage,{requestKey:first.key});assert.equal(check.key,first.key);assert.deepEqual(pendingDevicePrize(area,storage).body,body());
});
test('unavailable durable storage prevents dispatch of a confirmed cart',async()=>{
 const storage={get length(){return 0;},key(){return null;},getItem(){return null;},setItem(){throw Error('denied');},removeItem(){}};await assert.rejects(()=>claimDevicePrize(area,body(),storage),e=>e.reason==='device_prize_storage_unavailable');
});
