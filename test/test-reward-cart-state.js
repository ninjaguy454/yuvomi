import test from 'node:test';import assert from 'node:assert/strict';
let helpers;try{helpers=await import('../public/utils/reward-cart.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;helpers={};}
const catalog=[{id:1,name:'Movie',cost:10},{id:2,name:'Book',cost:25},{id:3,name:'Free',cost:0}];
test('cart budget updates total and remaining synchronously as selected quantities change',()=>{
 assert.equal(typeof helpers.cartBudget,'function');const q=new Map([[1,2],[2,1]]);assert.deepEqual(helpers.cartBudget(catalog,q,50),{units:3,total:45,remaining:5});q.set(1,1);assert.deepEqual(helpers.cartBudget(catalog,q,50),{units:2,total:35,remaining:15});q.delete(2);assert.equal(helpers.cartBudget(catalog,q,50).remaining,40);
});
test('hidden balances yield no invented remaining amount while retaining public total',()=>{
 assert.equal(typeof helpers.cartBudget,'function');assert.deepEqual(helpers.cartBudget(catalog,new Map([[1,2]])),{units:2,total:20,remaining:null});
});
test('only additional units are gated by remaining budget and free-reward quantity bounds',()=>{
 assert.equal(typeof helpers.canAddCartUnit,'function');const q=new Map([[1,3]]),budget=helpers.cartBudget(catalog,q,30);assert.equal(helpers.canAddCartUnit(catalog[0],budget,100),false);assert.equal(helpers.canAddCartUnit(catalog[2],budget,100),true);assert.equal(helpers.canAddCartUnit(catalog[2],{...budget,units:100},100),false);q.set(1,2);assert.equal(helpers.canAddCartUnit(catalog[0],helpers.cartBudget(catalog,q,30),100),true);
});
test('confirmation has one member canonical sorted quantities and a frozen total',()=>{
 assert.equal(typeof helpers.cartPurchaseBody,'function');const body=helpers.cartPurchaseBody(7,catalog,new Map([[2,1],[1,2]]));assert.deepEqual(body,{operation:'device-prize-cart',user_id:7,items:[{catalog_id:1,quantity:2,expected_cost:10},{catalog_id:2,quantity:1,expected_cost:25}],expected_cost:45});assert.throws(()=>helpers.cartPurchaseBody(7,catalog,new Map([[3,101]])),/quantity/i);
});
test('invalid catalog arithmetic never produces a purchasable total',()=>{
 assert.equal(typeof helpers.cartBudget,'function');assert.throws(()=>helpers.cartBudget([{id:1,cost:NaN}],new Map([[1,1]]),30));assert.throws(()=>helpers.cartBudget(catalog,new Map([[99,1]]),30));
});
test('complete cart receipts are required before a persistent intent may be cleared',()=>{
 assert.equal(typeof helpers.validPrizeReceipt,'function');const body={user_id:7,items:[{catalog_id:1,quantity:2,expected_cost:10}],expected_cost:20},response={data:{id:9,user_id:7,cost:20,unit_count:2,status:'pending',items:[{catalog_id:1,quantity:2,unit_cost:10,total_cost:20,reward_name:'Movie',units:[{id:9,status:'pending',requires_delivery:true},{id:10,status:'pending',requires_delivery:true}]}]}};
 assert.equal(helpers.validPrizeReceipt(body,response),true);const partial=structuredClone(response);partial.data.items[0].units.pop();assert.equal(helpers.validPrizeReceipt(body,partial),false);const duplicate=structuredClone(response);duplicate.data.items[0].units[1].id=9;assert.equal(helpers.validPrizeReceipt(body,duplicate),false);
});
