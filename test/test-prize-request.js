import test from 'node:test';
import assert from 'node:assert/strict';
import * as requests from '../public/utils/reward-request.js';
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};};
test('different redemption Undo intents cannot share a durable request key',()=>{
  const area=storage(),body={operation:'undo',redemption_id:7,expected_status:'pending',confirm_delivered:false,reason:'Accident'};
  const first=requests.rewardRequest('parent:undo',body,area),same=requests.rewardRequest('parent:undo',{...body},area);
  assert.equal(first.key,same.key);
  assert.notEqual(requests.rewardRequest('parent:undo',{...body,redemption_id:8},area).key,first.key);
  assert.notEqual(requests.rewardRequest('parent:undo',{...body,expected_status:'fulfilled',confirm_delivered:true},area).key,first.key);
});
test('an uncertain Undo restores its submitted state and reason after a record changes',()=>{
  const area=storage(),body={operation:'undo',redemption_id:7,expected_status:'pending',confirm_delivered:false,reason:'Original reason'};
  const first=requests.rewardRequest('parent:undo',body,area);
  assert.equal(typeof requests.pendingPrizeUndo,'function');
  const pending=requests.pendingPrizeUndo('parent:undo',7,area);
  assert.equal(pending.key,first.key);assert.deepEqual(pending.body,body);
  first.finish();assert.equal(requests.pendingPrizeUndo('parent:undo',7,area),null);
});
