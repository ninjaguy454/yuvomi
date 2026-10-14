/** Pure local arithmetic and receipt validation; the server owns the purchase. */
export const CART_UNIT_LIMIT=100;
export function cartBudget(catalog,quantities,balance) {
  let units=0,total=0;
  for(const [id,quantity]of quantities){const item=catalog.find(i=>i.id===id);
    if(!item||!Number.isSafeInteger(quantity)||quantity<=0||!Number.isSafeInteger(item.cost)||item.cost<0)throw Error('Invalid reward quantity or price.');
    units+=quantity;total+=quantity*item.cost;if(!Number.isSafeInteger(total))throw Error('Invalid cart total.');
  }
  return {units,total,remaining:Number.isSafeInteger(balance)?balance-total:null};
}
export const canAddCartUnit=(item,budget,limit=CART_UNIT_LIMIT)=>Number.isSafeInteger(item?.cost)&&item.cost>=0&&budget.units<limit
  &&(budget.remaining===null||item.cost<=budget.remaining);
export function cartPurchaseBody(userId,catalog,quantities,limit=CART_UNIT_LIMIT) {
  const budget=cartBudget(catalog,quantities);
  if(!Number.isSafeInteger(userId)||userId<=0||!budget.units||budget.units>limit)throw Error('Choose a member and a valid reward quantity.');
  const items=[...quantities].map(([catalog_id,quantity])=>({catalog_id,quantity,expected_cost:catalog.find(i=>i.id===catalog_id).cost})).sort((a,b)=>a.catalog_id-b.catalog_id);
  return {operation:'device-prize-cart',user_id:userId,items,expected_cost:budget.total};
}
export function validPrizeReceipt(body,response) {
  const data=response?.data;
  if(!Number.isSafeInteger(data?.id)||data.id<=0||data.user_id!==body.user_id||data.cost!==body.expected_cost)return false;
  if(!Array.isArray(body.items))return true;
  if(!Array.isArray(data.items)||data.items.length!==body.items.length)return false;
  const ids=new Set(),catalogIds=new Set(),statuses=new Set();let count=0;
  for(const item of data.items){const expected=body.items.find(i=>i.catalog_id===item.catalog_id);
    if(!expected||catalogIds.has(item.catalog_id)||item.quantity!==expected.quantity||item.unit_cost!==expected.expected_cost
      ||item.total_cost!==expected.quantity*expected.expected_cost||typeof item.reward_name!=='string'||!Array.isArray(item.units)||item.units.length!==expected.quantity)return false;
    catalogIds.add(item.catalog_id);
    for(const unit of item.units){if(!Number.isSafeInteger(unit.id)||unit.id<=0||ids.has(unit.id)||!['pending','fulfilled','cancelled','rejected'].includes(unit.status))return false;ids.add(unit.id);statuses.add(unit.status);count++;}
  }
  return count===data.unit_count&&data.id===data.items[0]?.units[0]?.id&&data.status===(statuses.size===1?[...statuses][0]:'mixed');
}
