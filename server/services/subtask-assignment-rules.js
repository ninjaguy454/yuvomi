/** Authoring storage only. Public editors do not expose these modes yet. */
import {hasCapability} from '../permissions.js';
import {householdMembers} from './activity-eligibility.js';
import {groupAssignmentMembers,normalizeGroupAssignment} from './group-assignment.js';
import {rotationGroupUsageVersion} from './rotation-shared.js';
import {taskCapabilities,taskSupervisionManagementAllowed} from './task-access.js';
import {todayKey} from '../utils/timezone.js';

const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status,code:'subtask_rule_invalid'});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

export function normalizeSubtaskRule(d,value,{dateKey=todayKey(d),deferUsageCheck=false}={}){
  if(!object(value))fail('Choose a Person or Group subtask rule.');
  if(value.kind==='fixed'){
    if(Object.keys(value).some(key=>!['kind','user_ids'].includes(key))||!Array.isArray(value.user_ids)
      ||value.user_ids.length<1||value.user_ids.length>50||value.user_ids.some(id=>!Number.isSafeInteger(id)||id<1)
      ||new Set(value.user_ids).size!==value.user_ids.length)fail('Choose distinct current household people.');
    const household=new Set(householdMembers(d).map(member=>member.id));
    if(value.user_ids.some(id=>!household.has(id)))fail('A selected subtask person is unavailable.');
    return {kind:'fixed',user_ids:[...value.user_ids]};
  }
  if(value.kind==='group'){
    if(Object.keys(value).some(key=>!['kind','group_id','mode','start_mode','direction','member_order'].includes(key))
      ||!['global','random','synced','smart'].includes(value.mode))fail('Choose a valid Group assignment mode.');
    const group=normalizeGroupAssignment(d,value,{allowInactive:false,allowImported:false});
    const shared=rotationGroupUsageVersion(d,group.group_id,dateKey)?.usage_mode==='shared';
    if(!deferUsageCheck&&shared!== (value.mode==='global'))
      fail('Choose Global for a universal Group or a task-specific mode for an independent Group.');
    return {kind:'group',...group,mode:value.mode};
  }
  fail('Choose a Person or Group subtask rule.');
}

export function normalizeSupervisorPool(d,value){
  if(value==null)return null;
  if(!object(value))fail('Choose a supervisor Person or Group.');
  if(value.kind==='person'&&Object.keys(value).every(key=>['kind','user_id'].includes(key))){
    if(!Number.isSafeInteger(value.user_id)||value.user_id<1
      ||!householdMembers(d).some(member=>member.id===value.user_id))fail('Choose a current household supervisor.');
    return {kind:'person',user_id:value.user_id};
  }
  if(value.kind==='group'&&Object.keys(value).every(key=>['kind','group_id'].includes(key))){
    const group=normalizeGroupAssignment(d,{group_id:value.group_id},{allowInactive:false,allowImported:false});
    return {kind:'group',group_id:group.group_id};
  }
  fail('Choose a supervisor Person or Group.');
}

function authorizeGroup(d,actorId,source,pool){
  if((source?.kind==='group'||pool?.kind==='group')&&!hasCapability(d,actorId,'rotations.view'))
    fail('This actor cannot choose Rotation Groups.',403);
}

export function assertSubtaskCandidatePool(d,encoded,source,previous){
  if(!source||!encoded)return;
  const pool=JSON.parse(encoded);
  if(source.kind==='group'){
    if(pool.group_ids?.includes(source.group_id)
      ||previous?.kind==='group'&&previous.group_id===source.group_id)return;
    fail('Select this Group in the Activity subtask choices first.');
  }
  if(previous?.kind==='fixed'&&JSON.stringify(previous.user_ids)===JSON.stringify(source.user_ids))return;
  const allowed=new Set(pool.person_ids||[]);
  for(const groupId of pool.group_ids||[])
    for(const id of groupAssignmentMembers(d,{group_id:groupId}))allowed.add(id);
  if(source.user_ids.some(id=>!allowed.has(id)))
    fail('Select these people in the Activity subtask choices first.');
}

/** Editing a source never rewrites an existing resolved occurrence. */
export function saveTaskSubtaskRule(d,{taskId,source,supervisorPool=undefined,actorId,expectedRevision}={}){
  if(!Number.isSafeInteger(expectedRevision))fail('Refresh the subtask before changing its rule.',409);
  return d.transaction(()=>{
    const child=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    const root=child?.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(child.parent_task_id):null;
    if(!root||root.parent_task_id||child.archived_at||root.archived_at
      ||!['open','unavailable'].includes(child.status)||!['open','unavailable'].includes(root.status))
      fail('Choose an open Activity subtask.');
    for(const row of [root,child]){
      const rights=taskCapabilities(d,actorId,row);
      if(!rights.view||!rights.change_assignment||!rights.reassign)
        fail('This actor cannot change this Activity subtask rule.',403);
    }
    if(!taskSupervisionManagementAllowed(d,actorId,root.id)&&supervisorPool!==undefined)
      fail('This actor cannot choose supervisors for this Activity.',403);
    if(child.revision!==expectedRevision)fail('This subtask changed. Refresh before saving.',409);
    const receipt=d.prepare('SELECT 1 FROM task_subtask_resolution_runs WHERE root_task_id=?').get(root.id);
    const decision=receipt?d.prepare('SELECT state FROM task_subtask_resolution_decisions WHERE task_id=? AND root_task_id=?')
      .get(child.id,root.id):null;
    // A failed decision is still editable. The next resolution attempt sees
    // the changed rule, while materialized decisions stay immutable.
    if(receipt&&decision?.state!=='unresolved')
      fail('This occurrence already has a saved assignment resolution.',409);
    if(decision?.state==='unresolved'&&source==null)
      fail('Resolve or explicitly cancel this unfinished subtask before removing its rule.',409);
    if(d.prepare('SELECT 1 FROM task_assignments WHERE task_id=?').get(child.id))
      fail('Use occurrence Reassign for a subtask that already has work assigned.',409);
    const existing=d.prepare('SELECT source_json,supervisor_pool_json FROM task_subtask_assignment_rules WHERE task_id=?').get(child.id);
    const normalized=source==null?null:normalizeSubtaskRule(d,source,{dateKey:child.due_date||root.due_date||todayKey(d)});
    assertSubtaskCandidatePool(d,root.subtask_candidate_pool_json,normalized,
      existing?.source_json?JSON.parse(existing.source_json):null);
    const pool=normalized?supervisorPool===undefined?existing?.supervisor_pool_json?JSON.parse(existing.supervisor_pool_json):null
      :normalizeSupervisorPool(d,supervisorPool):null;
    authorizeGroup(d,actorId,normalized,pool);
    if(normalized)d.prepare(`INSERT INTO task_subtask_assignment_rules(task_id,source_json,supervisor_pool_json)
      VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET source_json=excluded.source_json,
      supervisor_pool_json=excluded.supervisor_pool_json`).run(child.id,JSON.stringify(normalized),pool?JSON.stringify(pool):null);
    else d.prepare('DELETE FROM task_subtask_assignment_rules WHERE task_id=?').run(child.id);
    return {source:normalized,supervisor_pool:pool};
  }).immediate();
}

/** A Template definition is detached from any Task already materialized. */
export function saveTemplateSubtaskRule(d,{checklistItemId,source,supervisorPool=undefined,actorId}={}){
  return d.transaction(()=>{
    const item=d.prepare(`SELECT item.*,template.id template_id,template.subtask_candidate_pool_json candidate_pool_json
      FROM activity_template_checklist_items item
      JOIN activity_templates template ON template.id=item.activity_template_id WHERE item.id=?`).get(checklistItemId);
    if(!item)fail('Choose an Activity Template subtask.');
    if(!hasCapability(d,actorId,'activities.edit'))fail('This actor cannot edit Activity Templates.',403);
    const normalized=source==null?null:normalizeSubtaskRule(d,source);
    assertSubtaskCandidatePool(d,item.candidate_pool_json,normalized,
      item.assignment_rule_json?JSON.parse(item.assignment_rule_json):null);
    const pool=normalized?supervisorPool===undefined?item.supervisor_pool_json?JSON.parse(item.supervisor_pool_json):null
      :normalizeSupervisorPool(d,supervisorPool):null;
    authorizeGroup(d,actorId,normalized,pool);
    d.prepare(`UPDATE activity_template_checklist_items SET assignment_rule_json=?,supervisor_pool_json=?,
      fixed_user_id=CASE WHEN ? THEN NULL ELSE fixed_user_id END,
      assignment_group_json=CASE WHEN ? THEN NULL ELSE assignment_group_json END WHERE id=?`)
      .run(normalized?JSON.stringify(normalized):null,pool?JSON.stringify(pool):null,
        normalized?1:0,normalized?1:0,item.id);
    d.prepare("UPDATE activity_templates SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(item.template_id);
    return {source:normalized,supervisor_pool:pool};
  }).immediate();
}
