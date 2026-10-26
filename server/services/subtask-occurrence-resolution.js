/** Internal, opt-in occurrence resolver. No route writes these rules yet. */
import {createHash} from 'node:crypto';
import {planSubtaskAssignments} from './subtask-assignment-plan.js';
import {householdMembers,effectiveSkillProficiency,sharedEligibleInterval} from './activity-eligibility.js';
import {activityPresenceWindow,evaluateAvailability} from './presence.js';
import {groupAssignmentMembers,normalizeGroupAssignment} from './group-assignment.js';
import {supervisorPool} from './subtask-supervisor-pool.js';
import {rotationGroupUsageVersion,previewSharedRotation} from './rotation-shared.js';
import {taskCapabilities,taskSupervisionManagementAllowed} from './task-access.js';
import {setTaskAssignmentsBatch} from './task-assignments.js';
import {updateCapturedDirectAssignees} from './task-assignee-policy.js';
import {inspectTaskSupervision,reconcileTaskSupervision} from './task-supervision.js';
import {todayKey} from '../utils/timezone.js';

const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status,code:'subtask_resolution_conflict'});};
const uniqueIds=value=>Array.isArray(value)?[...new Set(value.map(Number))].filter(id=>Number.isSafeInteger(id)&&id>0):[];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const childRows=(d,rootId)=>d.prepare(`SELECT t.*,r.source_json,r.supervisor_pool_json,
    p.place_id,p.presence_policy,p.presence_window
    FROM tasks t LEFT JOIN task_subtask_assignment_rules r ON r.task_id=t.id
    LEFT JOIN task_planning_context p ON p.task_id=t.id
    WHERE t.parent_task_id=? AND t.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)
    ORDER BY t.sort_order,t.id`).all(rootId);


function assignmentContext(d,root,row,policy){
  const dateKey=row.due_date||root.due_date||row.start_date||root.start_date||todayKey(d);
  const task={...root,...row,due_date:row.due_date||root.due_date,start_date:row.start_date||root.start_date,
    due_time:row.due_time||root.due_time,start_time:row.start_time||root.start_time};
  const pc={...policy,place_id:row.place_id??policy.place_id,
    presence_policy:row.presence_policy??policy.presence_policy,presence_window:row.presence_window??policy.presence_window};
  return {dateKey,presence:{policy:pc.presence_policy||'ignore',targetPlaceId:pc.place_id||null,
    ...activityPresenceWindow(d,{task,dateKey,windowMode:pc.presence_window||'due'})}};
}

function cursorKey(d,root,groupId){
  const recurring=d.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(root.id);
  const bound=d.prepare('SELECT activity_template_id FROM task_activity_bindings WHERE task_id=?').get(root.id);
  const owner=recurring?`series:${recurring.series_id}`:bound?`template:${bound.activity_template_id}`:`task:${root.id}`;
  return `subtask-synced:${owner}:group:${groupId}`;
}

/** Build the authoritative read snapshot only from stored rules and current household facts.
 * Supervised candidates are held unresolved until the scope's supervisor can be coordinated. */
export function buildSubtaskOccurrenceSnapshot(d,rootTaskId,{overrideSources=new Map(),reconsiderTaskIds=new Set(),allowInProgress=false,selectedTaskIds=null}={}){
  const root=d.prepare('SELECT * FROM tasks WHERE id=?').get(rootTaskId);
  if(!root||root.parent_task_id||root.archived_at
    ||!(allowInProgress?['open','unavailable','in_progress']:['open','unavailable']).includes(root.status))
    fail('Choose an open Activity occurrence.');
  const members=householdMembers(d),memberById=new Map(members.map(member=>[member.id,member]));
  const saved=childRows(d,root.id);
  if(saved.length>50)fail('This Activity has too many subtasks for automatic resolution.',400);
  if(!saved.some(row=>row.source_json)&&!overrideSources.size)fail('This Activity has no subtask rules to resolve.',400);
  if(d.prepare(`SELECT 1 FROM task_subtask_resolution_decisions r JOIN tasks t ON t.id=r.task_id
    WHERE t.parent_task_id=? AND r.root_task_id<>? LIMIT 1`).get(root.id,root.id))
    fail('A saved subtask decision belongs to a different Activity.');
  const assigned=new Map();
  for(const item of d.prepare(`SELECT a.task_id,a.user_id FROM task_assignments a
    JOIN tasks t ON t.id=a.task_id WHERE t.parent_task_id=? ORDER BY a.task_id,a.user_id`).all(root.id)){
    if(!assigned.has(item.task_id))assigned.set(item.task_id,[]);assigned.get(item.task_id).push(item.user_id);
  }
  const prior=new Set(d.prepare('SELECT task_id FROM task_subtask_resolution_decisions WHERE root_task_id=?')
    .all(root.id).map(item=>item.task_id));
  const rootPlanning=d.prepare('SELECT place_id,presence_policy,presence_window FROM task_planning_context WHERE task_id=?').get(root.id)||{};
  const skillRows=saved.length?d.prepare(`SELECT r.task_id,s.* FROM task_skill_requirements r JOIN skills s ON s.id=r.skill_id
    WHERE r.task_id IN (${saved.map(()=>'?').join(',')}) ORDER BY r.task_id,r.sort_order,s.id`).all(...saved.map(row=>row.id)):[];
  const skillsByTask=new Map();for(const skill of skillRows){if(!skillsByTask.has(skill.task_id))skillsByTask.set(skill.task_id,[]);skillsByTask.get(skill.task_id).push(skill);}
  const proficiency=new Map(),availability=new Map(),cursorKeys=new Map(),defaultPools=new Map(),
    usageByGroupDate=new Map(),periodByGroupDate=new Map(),cursorByKey=new Map(),memberOrderByRule=new Map();
  const rows=saved.map(row=>{
    const existing=assigned.get(row.id)||[];
    if(existing.length&&!reconsiderTaskIds.has(row.id)){
      const raw=row.source_json?JSON.parse(row.source_json):null;
      const synced=raw?.kind==='group'&&raw.mode==='synced';
      const source=synced?{...raw,kind:'group',group_id:Number(raw.group_id),
        member_order:groupAssignmentMembers(d,{group_id:Number(raw.group_id),member_order:raw.member_order}),
        direction:raw.direction||'first_to_last',start_mode:raw.start_mode||'first',shared:false}
        :{kind:'fixed',user_ids:existing};
      return {key:String(row.id),points:Number(row.points)||0,is_optional:!!row.is_optional,
      source,eligible_user_ids:existing,normal_user_ids:existing,
      supervised_candidates:[],locked:true,persisted_user_ids:existing,prior_decision:prior.has(row.id),
      skill_ids:[],task_revision:row.revision};
    }
    if(selectedTaskIds&&!selectedTaskIds.has(row.id))return null;
    if(!row.source_json&&!overrideSources.has(row.id))return null;
    if(!['open','unavailable',...(allowInProgress&&reconsiderTaskIds.has(row.id)?['in_progress']:[])].includes(row.status))
      fail('Started or completed subtasks cannot be resolved.');
    const storedSource=row.source_json?JSON.parse(row.source_json):null;
    const raw=overrideSources.get(row.id)??storedSource;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('Invalid stored subtask rule.');
    let source;
    if(raw.kind==='fixed'){
      const userIds=uniqueIds(raw.user_ids);
      if(!userIds.length||userIds.length!==raw.user_ids?.length)fail('Invalid fixed Person rule.');
      source={kind:'fixed',user_ids:userIds};
    }else if(raw.kind==='group'){
      if(!['global','random','synced','smart'].includes(raw.mode))fail('Invalid Group assignment mode.');
      const config=normalizeGroupAssignment(d,raw,{allowInactive:false,allowImported:false});
      const date=row.due_date||root.due_date||todayKey(d),groupDate=`${config.group_id}:${date}`;
      if(!usageByGroupDate.has(groupDate))usageByGroupDate.set(groupDate,rotationGroupUsageVersion(d,config.group_id,date));
      const usage=usageByGroupDate.get(groupDate);
      const shared=usage?.usage_mode==='shared';
      if(shared&&raw.mode!=='global'||!shared&&raw.mode==='global')fail('This Group mode conflicts with its shared or independent rotation policy.');
      const orderKey=JSON.stringify([config.group_id,config.member_order||null]);
      if(!memberOrderByRule.has(orderKey))memberOrderByRule.set(orderKey,groupAssignmentMembers(d,config));
      const memberOrder=memberOrderByRule.get(orderKey);
      const key=cursorKey(d,root,config.group_id);cursorKeys.set(config.group_id,key);
      if(!cursorByKey.has(key))cursorByKey.set(key,d.prepare('SELECT cursor_user_id FROM assignment_rotation_state WHERE rotation_key=?').get(key)??null);
      const cursor=cursorByKey.get(key);
      if(shared&&!periodByGroupDate.has(groupDate))periodByGroupDate.set(groupDate,previewSharedRotation(d,config.group_id,{dateKey:date}));
      const period=shared?periodByGroupDate.get(groupDate):null;
      source={...config,kind:'group',mode:raw.mode,member_order:memberOrder,shared,
        scheduled_user_id:shared&&!period?.forecast_pending?period?.member_ids?.[0]??null:null,
        cursor_user_id:cursor?.cursor_user_id??null};
    }else fail('Invalid stored subtask rule.');
    const {dateKey,presence}=assignmentContext(d,root,row,rootPlanning),skills=skillsByTask.get(row.id)||[];
    const candidateIds=source.kind==='fixed'?source.user_ids:source.member_order;
    const eligible=[],supervised=[];
    const defaultGroupId=storedSource?.kind==='group'?Number(storedSource.group_id):source.kind==='group'?source.group_id:null;
    if(defaultGroupId&&!defaultPools.has(defaultGroupId))defaultPools.set(defaultGroupId,
      d.prepare('SELECT pool_json FROM rotation_group_supervisor_defaults WHERE group_id=?').get(defaultGroupId)?.pool_json??null);
    const supervisorIds=supervisorPool(d,row.supervisor_pool_json??(defaultGroupId?defaultPools.get(defaultGroupId):null),
      members,memberById,dateKey);
    for(const id of candidateIds){
      const member=memberById.get(id);if(!member)continue;
      const capabilities=skills.map(skill=>{
        const key=`${skill.id}:${member.id}:${dateKey}`;
        if(!proficiency.has(key))proficiency.set(key,effectiveSkillProficiency(d,skill,member,dateKey));
        return proficiency.get(key).proficiency;
      });
      if(capabilities.includes('excluded'))continue;
      const key=JSON.stringify([id,presence]);
      if(!availability.has(key)){
        try{availability.set(key,evaluateAvailability(d,{...presence,userId:id}));}
        catch{availability.set(key,{eligible:false});}
      }
      const learnerAvailability=availability.get(key);
      if(!learnerAvailability.eligible)continue;
      if(capabilities.includes('supervised')){
        const required=skills.filter((_,index)=>capabilities[index]==='supervised');
        const qualified=supervisorIds.filter(supervisorId=>{
          if(supervisorId===id)return false;
          const supervisor=memberById.get(supervisorId);if(!supervisor)return false;
          if(required.some(skill=>{
            const pkey=`${skill.id}:${supervisor.id}:${dateKey}`;
            if(!proficiency.has(pkey))proficiency.set(pkey,effectiveSkillProficiency(d,skill,supervisor,dateKey));
            return proficiency.get(pkey).proficiency!=='normal';
          }))return false;
          const akey=JSON.stringify([supervisorId,presence]);
          if(!availability.has(akey)){
            try{availability.set(akey,evaluateAvailability(d,{...presence,userId:supervisorId}));}
            catch{availability.set(akey,{eligible:false});}
          }
          const available=availability.get(akey);
          return available.eligible&&(presence.policy==='ignore'||sharedEligibleInterval(
            [learnerAvailability,available],presence.requiredDurationMinutes));
        });
        if(qualified.length)supervised.push({user_id:id,supervisor_ids:qualified});
      }else eligible.push(id);
    }
    // Existing work created by older editors is a locked baseline, never
    // attributed to a newly added Group rule.
    // Linked helper actions represent one learner. A supervised second
    // performer in a fixed roster cannot be represented safely yet.
    const supportedSupervised=source.kind==='fixed'&&source.user_ids.length>1?[]:supervised;
    return {key:String(row.id),points:Number(row.points)||0,is_optional:!!row.is_optional,source,eligible_user_ids:eligible,
      normal_user_ids:eligible,supervised_candidates:supportedSupervised,
      prior_decision:prior.has(row.id),previous_user_ids:existing,skill_ids:skills.map(skill=>skill.id),task_revision:row.revision};
  }).filter(Boolean);
  const inputHash=hash({root_id:root.id,root_revision:root.revision,rows});
  return {root,rows,input_hash:inputHash,cursor_keys:cursorKeys};
}

export function planWithSupervisor(snapshot,d){
  const occurrenceKey=`task:${snapshot.root.id}`;
  const existing=inspectTaskSupervision(d,snapshot.root.id);
  const previous=new Map(existing.actions.map(action=>[String(action.action_task_id),action.supervisor_user_id]));
  const rows=snapshot.rows.map(row=>({...row,eligible_user_ids:[...row.normal_user_ids,
    ...(row.source?.kind==='fixed'&&row.source.user_ids?.length>1?[]
      :row.supervised_candidates.filter(item=>item.supervisor_ids.length).map(item=>item.user_id))]}));
  const plan=planSubtaskAssignments({snapshotVersion:snapshot.input_hash,occurrenceKey,rows});
  const supervisorAssignments={};
  for(const decision of plan.decisions){
    if(decision.state!=='assigned')continue;
    const row=snapshot.rows.find(item=>item.key===decision.key);
    const supervised=row?.supervised_candidates.find(item=>decision.assignee_ids.includes(item.user_id));
    if(!supervised)continue;
    const prior=previous.get(decision.key);
    supervisorAssignments[decision.key]=supervised.supervisor_ids.includes(prior)
      ?prior:supervised.supervisor_ids[0];
  }
  const unique=[...new Set(Object.values(supervisorAssignments))];
  return {...plan,supervisor_assignments:supervisorAssignments,
    supervisor_user_id:unique.length===1?unique[0]:null};
}

/** All writes, including cursor changes, happen inside one immediate SQLite transaction.
 * This is intentionally not wired to the public Task route while supervision
 * pools and an occurrence reassignment path are unfinished. */
export function resolveSubtaskOccurrence(d,{rootTaskId,idempotencyKey,actorId}={}){
  if(!Number.isSafeInteger(Number(rootTaskId))||!Number.isSafeInteger(Number(actorId))
    ||typeof idempotencyKey!=='string'||!idempotencyKey.trim()||idempotencyKey.length>128)
    fail('Provide an Activity, actor and idempotency key.',400);
  return d.transaction(()=>{
    const root=d.prepare('SELECT * FROM tasks WHERE id=?').get(rootTaskId);
    const rootRights=root&&taskCapabilities(d,actorId,root);
    if(!rootRights?.change_assignment||!rootRights.reassign)fail('This actor cannot change Activity assignments.',403);
    const children=d.prepare(`SELECT t.* FROM tasks t WHERE t.parent_task_id=? AND t.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)`).all(rootTaskId);
    const checked=new Set();
    for(const child of children){
      const rights=taskCapabilities(d,actorId,child);
      if(!rights.view||!rights.change_assignment||!rights.reassign)
        fail('This actor cannot change a subtask assignment.',403);
      checked.add(child.id);
    }
    const prior=d.prepare('SELECT * FROM task_subtask_resolution_runs WHERE root_task_id=?').get(rootTaskId);
    const earlier=d.prepare(`SELECT receipt_json FROM task_subtask_resolution_attempts
      WHERE root_task_id=? AND idempotency_key=?`).get(rootTaskId,idempotencyKey);
    if(earlier){
      const receipt=JSON.parse(earlier.receipt_json);
      // Historical decisions can outlive the current-child query when a Task
      // is archived or moved. Authorize each saved ID before replaying it.
      for(const decision of receipt.decisions||[]){
        const id=Number(decision.key);
        if(checked.has(id))continue;
        const child=Number.isSafeInteger(id)&&id>0
          ?d.prepare('SELECT * FROM tasks WHERE id=?').get(id):null;
        if(!child||Number(child.parent_task_id)!==Number(rootTaskId))
          fail('This occurrence receipt contains a child outside this Activity.',403);
        const rights=taskCapabilities(d,actorId,child);
        if(!rights.view||!rights.change_assignment||!rights.reassign)
          fail('This actor cannot read a saved subtask decision.',403);
      }
      return receipt;
    }
    if(prior&&!JSON.parse(prior.receipt_json).conflicts?.length)
      fail('This occurrence already has a complete saved resolution.');
    const snapshot=buildSubtaskOccurrenceSnapshot(d,rootTaskId);
    if(prior&&prior.recovery_hash===snapshot.input_hash)
      fail('The unresolved work has no changed eligibility or assignment inputs.');
    const plan=planWithSupervisor(snapshot,d);
    if(plan.decisions.some(decision=>decision.state==='assigned'&&snapshot.rows.find(row=>row.key===decision.key)?.supervised_candidates
      .some(item=>decision.assignee_ids.includes(item.user_id)))
      &&!taskSupervisionManagementAllowed(d,actorId,rootTaskId))
      fail('This actor cannot manage the Activity supervisor.',403);
    const materialized=[];
    for(const decision of plan.decisions){
      const row=snapshot.rows.find(item=>item.key===decision.key),id=Number(decision.key);
      const preserved=!!row.locked;
      if(preserved){
        // A person may have been assigned manually after an unresolved
        // receipt. Keep that work, but close its stale unresolved decision.
        if(row.prior_decision)d.prepare(`UPDATE task_subtask_resolution_decisions SET
          source_json=?,selected_user_ids_json=?,supervisor_user_id=NULL,state='preserved',
          reason=NULL,decision_key=NULL,input_hash=? WHERE task_id=? AND state='unresolved'`)
          .run(JSON.stringify({kind:'existing'}),JSON.stringify(row.persisted_user_ids),snapshot.input_hash,id);
        continue;
      }
      if(decision.state==='assigned'&&!preserved){
        // The tasks revision trigger observes assigned_to; incrementing the
        // revision explicitly would advance the parent/change clock twice.
        d.prepare('UPDATE tasks SET assigned_to=? WHERE id=? AND status IN (\'open\',\'unavailable\')')
          .run(decision.assignee_ids[0]??null,id);
        materialized.push({taskId:id,userIds:decision.assignee_ids});
      }
      d.prepare(`INSERT INTO task_subtask_resolution_decisions
        (task_id,root_task_id,source_json,selected_user_ids_json,supervisor_user_id,state,reason,decision_key,input_hash)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        source_json=excluded.source_json,selected_user_ids_json=excluded.selected_user_ids_json,
        supervisor_user_id=excluded.supervisor_user_id,state=excluded.state,reason=excluded.reason,
        decision_key=excluded.decision_key,input_hash=excluded.input_hash
        WHERE task_subtask_resolution_decisions.state='unresolved'`).run(id,rootTaskId,JSON.stringify(preserved?{kind:'existing'}:decision.source),
        JSON.stringify(decision.assignee_ids),!preserved?plan.supervisor_assignments[decision.key]??null:null,
        preserved?'preserved':decision.state,
        plan.conflicts.find(item=>item.key===decision.key)?.reason??null,decision.decision_key??null,snapshot.input_hash);
    }
    setTaskAssignmentsBatch(d,materialized);
    for(const {taskId,userIds} of materialized)updateCapturedDirectAssignees(d,taskId,userIds);
    for(const advance of plan.cursor_advances){
      const key=snapshot.cursor_keys.get(advance.group_id);
      d.prepare('INSERT INTO task_subtask_synced_advances(root_task_id,group_id,cursor_key,selected_user_id) VALUES(?,?,?,?)')
        .run(rootTaskId,advance.group_id,key,advance.user_id);
      d.prepare(`INSERT INTO assignment_rotation_state(rotation_key,cursor_user_id,occurrence_count,updated_at)
        VALUES(?,?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        ON CONFLICT(rotation_key) DO UPDATE SET cursor_user_id=excluded.cursor_user_id,
        occurrence_count=assignment_rotation_state.occurrence_count+1,updated_at=excluded.updated_at`).run(key,advance.user_id);
    }
    if(plan.decisions.some(decision=>decision.state==='assigned'&&snapshot.rows.find(row=>row.key===decision.key)?.supervised_candidates
      .some(item=>decision.assignee_ids.includes(item.user_id)))){
      const reconciled=reconcileTaskSupervision(d,rootTaskId,{actorId,
        supervisorAssignments:plan.supervisor_assignments,perActionPlanning:true,notify:false});
      if(reconciled.state!=='assigned')fail('The supervisor could not be linked to this occurrence.');
    }
    const receipt={...plan,input_hash:snapshot.input_hash};
    const recoveryHash=plan.conflicts.length?buildSubtaskOccurrenceSnapshot(d,rootTaskId).input_hash:null;
    d.prepare(`INSERT INTO task_subtask_resolution_runs
      (root_task_id,idempotency_key,input_hash,receipt_json,recovery_hash) VALUES(?,?,?,?,?)
      ON CONFLICT(root_task_id) DO UPDATE SET idempotency_key=excluded.idempotency_key,
      input_hash=excluded.input_hash,receipt_json=excluded.receipt_json,
      recovery_hash=excluded.recovery_hash`).run(rootTaskId,idempotencyKey,snapshot.input_hash,JSON.stringify(receipt),recoveryHash);
    d.prepare(`INSERT INTO task_subtask_resolution_attempts
      (root_task_id,idempotency_key,input_hash,receipt_json) VALUES(?,?,?,?)`)
      .run(rootTaskId,idempotencyKey,snapshot.input_hash,JSON.stringify(receipt));
    return receipt;
  }).immediate();
}
