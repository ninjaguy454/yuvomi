/** Cart envelopes reuse durable device claims; every unit stays an ordinary prize. */
import {createHash} from 'node:crypto';
import {RewardError} from './rewards.js';
export const MAX_CART_UNITS=100;
export const isPrizeCart=body=>body!=null&&Object.hasOwn(body,'items');
const invalid=()=>{throw new RewardError('Choose unique rewards, positive whole quantities and their current point prices.',400,'invalid_cart');};
export function normalizePrizeCart(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['user_id','items','expected_cost','note'].includes(k))
    ||!Number.isSafeInteger(input.user_id)||input.user_id<=0||!Number.isSafeInteger(input.expected_cost)||input.expected_cost<0
    ||!Array.isArray(input.items)||!input.items.length||input.items.length>MAX_CART_UNITS
    ||input.note!=null&&(typeof input.note!=='string'||input.note.trim().length>200))invalid();
  const seen=new Set();let count=0,total=0;
  const items=input.items.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['catalog_id','quantity','expected_cost'].includes(k))
      ||!Number.isSafeInteger(item.catalog_id)||item.catalog_id<=0||seen.has(item.catalog_id)
      ||!Number.isSafeInteger(item.quantity)||item.quantity<=0||item.quantity>MAX_CART_UNITS
      ||!Number.isSafeInteger(item.expected_cost)||item.expected_cost<0)invalid();
    seen.add(item.catalog_id);count+=item.quantity;total+=item.quantity*item.expected_cost;
    if(count>MAX_CART_UNITS||!Number.isSafeInteger(total))invalid();
    return {catalog_id:item.catalog_id,quantity:item.quantity,expected_cost:item.expected_cost};
  }).sort((a,b)=>a.catalog_id-b.catalog_id);
  if(total!==input.expected_cost)invalid();
  return {user_id:input.user_id,items,expected_cost:total,note:input.note?.trim()||null};
}
export const cartUnitKey=(key,fingerprint,index)=>'cart-unit:'+createHash('sha256').update(JSON.stringify([key,fingerprint,index])).digest('hex');
export function cartUnits(body,key,fingerprint) {
  const result=[];
  for(const item of body.items)for(let n=0;n<item.quantity;n++)result.push({item,key:cartUnitKey(key,fingerprint,result.length),
    body:{catalog_id:item.catalog_id,user_id:body.user_id,expected_cost:item.expected_cost,note:body.note}});
  return result;
}
export function cartQuote(d,body) {
  const items=body.items.map(item=>{
    const row=d.prepare('SELECT * FROM reward_catalog WHERE id=? AND is_active=1').get(item.catalog_id);
    if(!row)throw new RewardError('A selected reward is no longer available. Review the cart.',404,'reward_unavailable');
    if(!Number.isSafeInteger(row.cost)||row.cost<0)throw new RewardError('A selected reward has an invalid point price.',409,'reward_price_changed');
    if(row.cost!==item.expected_cost)throw new RewardError('A prize price changed. Review the cart before redeeming.',409,'reward_price_changed');
    return {...item,name:row.name};
  });
  return {id:items[0].catalog_id,name:items.map(i=>`${i.quantity} × ${i.name}`).join(', '),cost:body.expected_cost};
}
export function cartReceipt(d,p,body,key,fingerprint,receipt,replayed) {
  const unavailable=()=>{throw new RewardError('This historical cart is no longer available. Its request ID cannot be reused.',410,'device_cart_unavailable');};
  if(!receipt.redemption_id)unavailable();
  const units=cartUnits(body,key,fingerprint).map(unit=>{
    const claim=d.prepare('SELECT * FROM device_prize_redemption_requests WHERE device_id=? AND request_key=?').get(p.id,unit.key);
    const row=claim?.redemption_id&&d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(claim.redemption_id);
    if(!claim||claim.outcome!=='purchased'||claim.request_fingerprint!==JSON.stringify(unit.body)||!row
      ||row.user_id!==body.user_id||row.cost!==unit.item.expected_cost
      ||claim.authenticated_user_id!==receipt.authenticated_user_id||claim.source_device_name!==receipt.source_device_name)unavailable();
    return {...unit,row,requires_delivery:!!d.prepare('SELECT 1 FROM reward_fulfillment_task_links WHERE redemption_id=?').get(row.id)};
  });
  if(units[0].row.id!==receipt.redemption_id)unavailable();
  const items=body.items.map(item=>{const found=units.filter(u=>u.item.catalog_id===item.catalog_id);return {catalog_id:item.catalog_id,quantity:item.quantity,
    unit_cost:item.expected_cost,total_cost:item.quantity*item.expected_cost,reward_name:found[0].row.reward_name,
    units:found.map(u=>({id:u.row.id,status:u.row.status,requires_delivery:u.requires_delivery}))};});
  const statuses=new Set(units.map(u=>u.row.status));
  return {data:{id:receipt.redemption_id,user_id:body.user_id,cost:body.expected_cost,unit_count:units.length,
    status:statuses.size===1?[...statuses][0]:'mixed',requires_delivery:units.some(u=>u.requires_delivery),items},replayed};
}
