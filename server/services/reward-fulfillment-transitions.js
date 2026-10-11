/** Linked prize guard: loaded by the lifecycle, not by a particular HTTP route. */
import {assertRewardParent,rewardFulfillmentLink} from './reward-fulfillment-access.js';
import {applyRedemptionDecision,RewardError} from './rewards.js';

export function prizeTaskTransition(d,task,status,{actorId,principal}) {
  const link=rewardFulfillmentLink(d,task.id);
  if(!link)return;
  const authority=assertRewardParent(d,principal??actorId,{taskId:task.id});
  if(authority.id!==Number(actorId))throw new RewardError('Personal parent identity is required.',403);
  if(link.redemption_status==='fulfilled'&&task.status==='done'&&status==='done')return;
  if(link.redemption_status!=='pending'||task.archived_at||task.status==='done')
    throw new RewardError('This prize is already decided. Its delivery history cannot be reset.',409);
  if(status==='done')applyRedemptionDecision(d,{actorId,redemptionId:link.redemption_id,action:'fulfill'});
}
