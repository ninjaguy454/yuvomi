/** Acceptance is narrower than editing/reassignment and never authenticates a picker. */
import {actorId,actorPermissions} from '../permissions.js';
import {taskCapabilities,taskDevicePrincipal,deviceTaskVisible} from './task-access.js';
import {devicePrincipal,deviceRequestStillValid} from './devices.js';
import {householdMembers} from './activity-eligibility.js';
import {taskOfferState,acceptanceError,hasTaskAssignees,generatedTask} from './task-offers.js';
import {assertTaskClaimMember,assertTaskAssignmentAvailability} from './assignment-responsibilities.js';
import {loadTaskSkillIds,assertTaskSkillAssignments} from './task-skills.js';
import {actionableSubtasks} from './task-lifecycle.js';
import {inspectTaskSupervision} from './task-supervision.js';
import {taskExpirationDue} from './task-window.js';
import {todayKey} from '../utils/timezone.js';

export function currentAcceptancePrincipal(d,principal){
  if(typeof principal==='object'&&(principal.deviceContext||principal.session?.deviceCredentialId)&&!deviceRequestStillValid(d,principal))throw acceptanceError('The display sign-in changed. Return to the display and try again.',409,'device_context_changed');
  const supplied=taskDevicePrincipal(principal);
  if(!supplied){actorPermissions(d,principal);return principal;}
  const row=d.prepare('SELECT * FROM household_devices WHERE id=?').get(supplied.id);
  if(!row||row.status!=='active')throw acceptanceError('This display is no longer authorized.',403,'device_access_denied');
  if(supplied.revision!==undefined&&supplied.revision!==row.revision)throw acceptanceError('The display permissions changed. Reload before accepting.',409,'device_context_changed');
  const current=devicePrincipal(row);
  if(principal===supplied)return current;
  return Object.assign(Object.create(principal),{devicePrincipal:current});
}
export function acceptanceAuthority(d,principal,id,{helpers=false}={}){
  const p=currentAcceptancePrincipal(d,principal),task=d.prepare('SELECT * FROM tasks WHERE id=?').get(id),device=taskDevicePrincipal(p);
  if(!task)throw acceptanceError('Task not found.',404,'not_found');
  const rights=taskCapabilities(d,p,task),permissions=device?.permissions||actorPermissions(d,p);
  if(!rights.view||permissions.modules.tasks==='none')throw acceptanceError('Task not found.',404,'not_found');
  if(!rights.claim)throw acceptanceError('Your permissions do not allow accepting this Task.',403,'claim_not_allowed');
  const definitionAllowed=!task.locked||!device&&(permissions.admin||Number(task.created_by)===actorId(p));
  const canHelpers=Boolean(definitionAllowed&&(rights.change_assignment&&rights.reassign||permissions.capabilities[device?'device_tasks.accept_with_helpers':'tasks.accept_with_helpers']==='allow'));
  if(helpers&&!canHelpers)throw acceptanceError('Adding co-assignees requires permission to accept with helpers.',403,'helpers_not_allowed');
  return {principal:p,task,device,canHelpers};
}
export function acceptanceMembers(d,p){
  const device=taskDevicePrincipal(p),scope=device?.scope?.member_ids||[];
  return householdMembers(d).filter(member=>!scope.length||scope.includes(member.id));
}
export function assertAcceptanceMember(d,p,task,userId){
  if(!Number.isSafeInteger(userId)||!acceptanceMembers(d,p).some(m=>m.id===userId))throw acceptanceError('Choose a permitted household member.',403,'member_not_allowed');
  try{assertTaskClaimMember(d,task.id,userId);}catch{throw acceptanceError('This member is not eligible for the Task with its current skills, supervision or availability.',409,'member_ineligible');}
}
export function authorizedAcceptanceChildren(d,p,task){
  return actionableSubtasks(d,task.id).filter(child=>taskCapabilities(d,p,child).view);
}
export function childAllocationReason(d,p,task,child,supervision=inspectTaskSupervision(d,task.id)){
  if(child.parent_task_id!==task.id||!taskCapabilities(d,p,child).view)return 'not_available';
  if(child.archived_at||!['open','in_progress'].includes(child.status)||taskExpirationDue(d,child))return 'not_open';
  if(child.locked||task.locked)return 'locked';
  if(generatedTask(d,child.id)||supervision.actions.some(a=>(a.action_task_id===child.id||a.counterpart_task_id===child.id)&&a.state!=='not_required'))return 'protected_action';
  if(hasTaskAssignees(d,child))return 'already_assigned';
  if(d.prepare('SELECT 1 FROM task_assignment_context WHERE task_id=?').get(child.id)||d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id=?').get(child.id)||child.assignment_mode==='round_robin')return 'managed_assignment';
  return null;
}
export function assertChildRecipient(d,child,userId){
  try{
    // Child editing permits delegated learners elsewhere. This bounded initial
    // allocation cannot grant excluded members ownership of protected actions.
    assertTaskSkillAssignments(d,loadTaskSkillIds(d,child.id),[userId],child.due_date||todayKey(d),{allowDelegation:false});
    assertTaskAssignmentAvailability(d,child.id,[userId]);
  }catch{throw acceptanceError('This subtask cannot be assigned to the selected member.',409,'subtask_ineligible');}
}
export function acceptanceOptions(d,principal,id,primaryUserId){
  const auth=acceptanceAuthority(d,principal,id),{task,device,canHelpers}=auth,p=auth.principal;
  const offer=taskOfferState(d,p,task);if(!offer.visible)throw acceptanceError('This Task is no longer available to accept.',409,'offer_unavailable');
  const allowed=acceptanceMembers(d,p);
  const eligible=allowed.filter(member=>{try{assertAcceptanceMember(d,p,task,member.id);return true;}catch{return false;}});
  const me=device?null:actorId(p);
  if(!device&&primaryUserId!==undefined&&Number(primaryUserId)!==me)throw acceptanceError('Accept this Task as your signed-in account.',403,'primary_not_self');
  const primary=device?(primaryUserId===undefined?null:Number(primaryUserId)):me;
  if(primary!==null)assertAcceptanceMember(d,p,task,primary);
  // Match existing human Tasks metadata (including scoped task tokens): it
  // exposes photos; anonymous paired displays receive only names and colors.
  // Add presentation only after acceptance eligibility has filtered the IDs.
  const appearance=d.prepare(device?'SELECT avatar_color FROM users WHERE id=?':'SELECT avatar_color,avatar_data FROM users WHERE id=?');
  const memberView=member=>({id:member.id,display_name:member.display_name,...appearance.get(member.id)});
  const candidates=canHelpers?eligible.filter(m=>m.id!==primary):[];
  const children=authorizedAcceptanceChildren(d,p,task),supervision=inspectTaskSupervision(d,task.id);
  return {expected_revision:task.revision,primary_mode:device?'choose':'self',primary_user_id:primary,
    primary_candidates:(device?eligible:eligible.filter(m=>m.id===me)).map(memberView),
    can_add_helpers:canHelpers,helpers_reason:canHelpers?null:'Permission to accept with helpers is required. Sign in with an authorized account or ask an administrator.',
    coassignee_candidates:candidates.map(memberView),
    subtasks:children.map(child=>{const reason=childAllocationReason(d,p,task,child,supervision);return {id:child.id,revision:child.revision,title:child.title,allocatable:!reason&&canHelpers,reason:reason||(!canHelpers?'helpers_not_allowed':null),
      eligible_assignee_ids:reason||!canHelpers?[]:[...new Set([primary,...candidates.map(m=>m.id)].filter(Boolean))].filter(userId=>{try{assertChildRecipient(d,child,userId);return true;}catch{return false;}})};}),
    subtask_snapshot:children.map(child=>({id:child.id,revision:child.revision}))};
}
