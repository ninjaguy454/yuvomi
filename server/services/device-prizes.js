/** Scoped shared-display purchases. A name choice never establishes identity. */
import {assertDeviceContext,devicePrincipal,deviceError} from './devices.js';
import {assertDeviceModule,deviceMembers,deviceRewards} from './device-content.js';
import {assertRewardHuman,rewardHouseholdUser} from './reward-fulfillment-access.js';
import {getBalance,isEnrolled,validateRedemptionKey,createRedemptionRecord,RewardError} from './rewards.js';
import {createPrizeDelivery} from './reward-fulfillment.js';

const modes=new Set(['member_signin','trusted_display']);
function currentPrincipal(d,principal) {
  const row=principal?.kind==='device'&&d.prepare("SELECT * FROM household_devices WHERE id=? AND status='active'").get(principal.id);
  if(!row)throw deviceError('This display is no longer available.',403);
  if(row.revision!==principal.revision)throw deviceError('This display changed. Reload before redeeming.',409,'device_context_changed');
  const saved=devicePrincipal(row);assertDeviceModule(saved,'rewards');
  if(saved.permissions?.capabilities?.['device_rewards.redeem']!=='allow')throw deviceError('Prize redemption is not enabled on this display.',403);
  const mode=saved.permissions?.prize_redemption_mode??'member_signin';
  if(!modes.has(mode))throw deviceError('This display has an invalid prize policy.',403);
  return saved;
}
const modeOf=p=>p.permissions.prize_redemption_mode??'member_signin';
export function devicePrizeOptions(d,principal) {
  const p=currentPrincipal(d,principal),show=p.scope.show_points===true;
  const members=deviceMembers(d,p).filter(user=>isEnrolled(d,user.id)).map(user=>({...user,...(show?{balance:getBalance(d,user.id)}:{})}));
  return {device_id:p.id,device_revision:p.revision,mode:modeOf(p),members,catalog:deviceRewards(d,p).catalog};
}
function purchaseBody(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['catalog_id','user_id','expected_cost','note'].includes(key)))
    throw new RewardError('Choose a member and prize with its current point price.');
  for(const key of ['catalog_id','user_id'])if(!Number.isSafeInteger(input[key])||input[key]<=0)throw new RewardError('Choose a valid member and prize.');
  if(!Number.isSafeInteger(input.expected_cost)||input.expected_cost<0)throw new RewardError('Review the point price before redeeming.');
  if(input.note!=null&&(typeof input.note!=='string'||input.note.trim().length>200))throw new RewardError('Use at most 200 characters for a purchase note.');
  return {catalog_id:input.catalog_id,user_id:input.user_id,expected_cost:input.expected_cost,note:input.note?.trim()||null};
}
export function inspectDevicePrizeIntent(d,req,input,{requestKey,requireMode,checkCatalog=true,allowAbandoned=false,now=Date.now()}={}) {
  const context=assertDeviceContext(d,req,{now});
  if(!context||context.credential.temporary_sid||context.credential.login_intent_at||req.authUserId||req.session?.userId)
    throw deviceError('Return to shared display view before redeeming.',403);
  const supplied=req.devicePrincipal??devicePrincipal(context.device),principal=currentPrincipal(d,supplied);
  if(principal.id!==context.device.id||principal.revision!==context.device.revision)throw deviceError('This display changed.',409,'device_context_changed');
  if(requireMode&&modeOf(principal)!==requireMode)throw deviceError('This display prize policy changed. Review it again.',409,'device_prize_mode_changed');
  const body=purchaseBody(input),key=validateRedemptionKey(requestKey),fingerprint=JSON.stringify(body);
  const user=rewardHouseholdUser(d,body.user_id);
  if(!user||!isEnrolled(d,user.id)||!deviceMembers(d,principal).some(member=>member.id===user.id))
    throw deviceError('Choose an eligible member shown on this display.',403);
  const receipt=d.prepare('SELECT * FROM device_prize_redemption_requests WHERE device_id=? AND request_key=?').get(principal.id,key);
  if(receipt) {
    if(receipt.request_fingerprint!==fingerprint)throw new RewardError('This request ID belongs to a different purchase.',409,'request_id_conflict');
    if(receipt.outcome==='abandoned') {
      if(allowAbandoned)return {context,principal,user,body,key,fingerprint,receipt};
      throw new RewardError('This unpurchased request was cancelled. Choose the prize again.',410,'device_prize_abandoned');
    }
    const row=receipt.redemption_id&&d.prepare('SELECT * FROM reward_redemptions WHERE id=?').get(receipt.redemption_id);
    if(!row)throw new RewardError('This purchase is no longer available. Its request ID cannot be reused.',410);
    return {context,principal,user,body,key,fingerprint,receipt,row,item:{id:row.catalog_id,name:row.reward_name,cost:row.cost}};
  }
  if(!checkCatalog)return {context,principal,user,body,key,fingerprint};
  const item=d.prepare('SELECT * FROM reward_catalog WHERE id=? AND is_active=1').get(body.catalog_id);
  if(!item)throw new RewardError('Reward not found.',404);
  if(item.cost!==body.expected_cost)throw new RewardError('This prize price changed. Review it before redeeming.',409,'reward_price_changed');
  return {context,principal,user,item,body,key,fingerprint};
}
/** Cancel only an unpurchased request. The reserved database transaction fences
 * delayed submissions before the browser may forget this key. A recorded debit
 * always wins; the display must reconcile it instead of discarding its receipt. */
export function abandonDevicePrizeIntent(d,req,input,{requestKey,now=Date.now()}={}) {
  return d.transaction(()=>{
    const intent=inspectDevicePrizeIntent(d,req,input,{requestKey,now,checkCatalog:false,allowAbandoned:true});
    if(intent.receipt) {
      if(intent.receipt.outcome==='abandoned')return {abandoned:true};
      throw new RewardError('This request already recorded a purchase. Check its result before choosing again.',409,'device_prize_already_recorded');
    }
    d.prepare(`INSERT INTO device_prize_redemption_requests
      (device_id,request_key,request_fingerprint,outcome,source_device_name) VALUES(?,?,?,'abandoned',?)`)
      .run(intent.principal.id,intent.key,intent.fingerprint,intent.principal.name);
    return {abandoned:true};
  }).immediate();
}
function safeReceipt(d,p,row,replayed) {
  const requiresDelivery=!!d.prepare('SELECT 1 FROM reward_fulfillment_task_links WHERE redemption_id=?').get(row.id);
  return {data:{id:row.id,user_id:row.user_id,reward_name:row.reward_name,cost:row.cost,status:row.status,requires_delivery:requiresDelivery},
    replayed,...(p.scope.show_points===true?{balance:getBalance(d,row.user_id)}:{})};
}
export function createDevicePrizeRedemption(d,req,input,{requestKey,authenticatedUserId,now=Date.now()}={}) {
  return d.transaction(()=>{
    const intent=inspectDevicePrizeIntent(d,req,input,{requestKey,now});
    const {principal:p,user,body,key,fingerprint,receipt}=intent;
    const mode=modeOf(p);
    let actorId=null;
    if(mode==='member_signin') {
      if(!Number.isSafeInteger(authenticatedUserId))throw deviceError('Sign in as the selected member for this purchase.',409,'member_signin_required');
      const human=assertRewardHuman(d,authenticatedUserId);
      if(human.id!==user.id)throw deviceError('Sign in as the selected member for this purchase.',403,'device_prize_member_required');
      actorId=human.id;
    }else if(authenticatedUserId!==undefined&&authenticatedUserId!==null)
      throw deviceError('This display prize policy changed. Review it again.',409,'device_prize_mode_changed');
    if(receipt)return safeReceipt(d,p,intent.row,true);
    const row=createRedemptionRecord(d,{actorId,userId:user.id,catalogId:body.catalog_id,note:body.note,
      expectedCost:body.expected_cost,pendingDelivery:user.family_role==='child'});
    createPrizeDelivery(d,row,user);
    d.prepare(`INSERT INTO device_prize_redemption_requests
      (device_id,request_key,request_fingerprint,redemption_id,source_device_name,authenticated_user_id) VALUES(?,?,?,?,?,?)`)
      .run(p.id,key,fingerprint,row.id,p.name,actorId);
    return safeReceipt(d,p,row,false);
  }).immediate();
}
