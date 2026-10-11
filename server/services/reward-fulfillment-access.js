/** Prize authority and link lookup; independent of Task lifecycle/Rewards writes. */
import {actorId,actorPermissions,PermissionError} from '../permissions.js';
import {tokenAllows} from '../scopes.js';

const parentRoles=new Set(['dad','mom','parent']);
export const rewardDevicePrincipal=actor=>actor?.devicePrincipal?.kind==='device'?actor.devicePrincipal:actor?.kind==='device'?actor:null;
export function rewardHouseholdUser(d,id) {
  return d.prepare(`SELECT u.id,u.role,u.family_role,u.display_name FROM users u WHERE u.id=?
    AND NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)`).get(id);
}
export function rewardFulfillmentLink(d,taskId) {
  if(!Number.isSafeInteger(Number(taskId))||Number(taskId)<=0)return null;
  if(!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reward_fulfillment_task_links'").get())return null;
  return d.prepare(`SELECT l.*,COALESCE(r.status,'cancelled') AS redemption_status FROM reward_fulfillment_task_links l
    LEFT JOIN reward_redemptions r ON r.id=l.redemption_id WHERE l.task_id=?`).get(taskId);
}

export function assertRewardTaskMutation(d,principal,task,body={},operation='update') {
  const link=rewardFulfillmentLink(d,task?.id||body.parent_task_id);
  if(!link)return;
  const visibleTask=task||d.prepare('SELECT * FROM tasks WHERE id=?').get(link.task_id),me=actorId(principal);
  if(rewardDevicePrincipal(principal)||(!visibleTask||Number(visibleTask.created_by)!==me
    &&!d.prepare('SELECT 1 FROM task_assignments WHERE task_id=? AND user_id=?').get(link.task_id,me)))
    throw new PermissionError('Task not found.',404);
  if(!task)throw new PermissionError('Prize delivery Tasks cannot have subtasks.',409);
  if(['comment','documents'].includes(operation))return;
  if(operation==='archive'&&task.status==='done')return;
  if(['status','check'].includes(operation)) {
    assertRewardParent(d,principal,{taskId:task.id});
    if(link.redemption_status==='fulfilled'&&task.status==='done'&&body.status==='done')return;
    if(link.redemption_status==='pending'&&!task.archived_at&&task.status!=='done')return;
    throw new PermissionError('This prize is already decided. Its delivery history cannot be reset.',409);
  }
  throw new PermissionError('Use the prize redemption record to fulfill or undo this delivery Task.',409);
}

export function rewardTaskCapabilities(d,principal,task,result) {
  const link=rewardFulfillmentLink(d,task?.id);
  if(!link)return result;
  for(const key of ['edit','claim','skip_occurrence','change_assignment','reassign','change_priority',
    'change_points','change_category_tags','change_dates','change_required_skills'])result[key]=false;
  result.delete_archive=Boolean(result.delete_archive&&task.status==='done');
  try{assertRewardParent(d,principal,{taskId:task.id});}
  catch{result.complete=false;}
  const completedReplay=link.redemption_status==='fulfilled'&&task.status==='done';
  if((link.redemption_status!=='pending'&&!completedReplay)||task.archived_at)result.complete=false;
  return result;
}
export function eligibleRewardParents(d) {
  return d.prepare("SELECT id FROM users WHERE family_role IN ('dad','mom','parent') ORDER BY id").all()
    .filter(({id})=>{if(!rewardHouseholdUser(d,id))return false;const p=actorPermissions(d,id);
      return p.modules.rewards==='write'&&p.modules.tasks==='write'
        &&p.capabilities['tasks.complete_own']==='allow'
        &&(p.capabilities['tasks.view_own']==='allow'||p.capabilities['tasks.view_household']==='allow');})
    .map(({id})=>id);
}
export function assertRewardHuman(d,principal,{write=true}={}) {
  if(rewardDevicePrincipal(principal))throw new PermissionError('Sign in personally for this prize action.');
  const id=actorId(principal),user=rewardHouseholdUser(d,id);
  if(!user)throw new PermissionError('This household account is no longer available.');
  const p=actorPermissions(d,id);
  if((write?p.modules.rewards!=='write':p.modules.rewards==='none')
    ||!tokenAllows(principal?.authScopes,'rewards',write?'write':'read'))
    throw new PermissionError('Your Rewards permissions do not allow this action.');
  return {id,user,permissions:p};
}
export function canViewHouseholdRedemptions(d,principal) {
  try {const {user}=assertRewardHuman(d,principal,{write:false});
    return user.role==='admin'||parentRoles.has(user.family_role);
  }catch{return false;}
}
export function assertRewardParent(d,principal,{taskId=null,undo=false}={}) {
  const authority=assertRewardHuman(d,principal),parent=parentRoles.has(authority.user.family_role);
  if(!(undo?(parent||authority.user.role==='admin'):parent))
    throw new PermissionError('A household parent or administrator must perform this prize action.');
  if(!undo&&(authority.permissions.modules.tasks!=='write'
    ||authority.permissions.capabilities['tasks.complete_own']!=='allow'
    ||!tokenAllows(principal?.authScopes,'tasks','write')
    ||(taskId&&!d.prepare('SELECT 1 FROM task_assignments WHERE task_id=? AND user_id=?').get(taskId,authority.id))))
    throw new PermissionError('An assigned household parent must fulfill this prize.');
  return authority;
}
