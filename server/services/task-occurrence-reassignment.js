/** An explicit occurrence override. Source rules and future cursors stay intact. */
import {createHash} from 'node:crypto';
import {buildSubtaskOccurrenceSnapshot,planWithSupervisor,isSubtaskOccurrenceRoot} from './subtask-occurrence-resolution.js';
import {taskCapabilities,taskSupervisionManagementAllowed,assertTaskMutation} from './task-access.js';
import {setTaskAssignmentsBatch} from './task-assignments.js';
import {updateCapturedDirectAssignees,proposedTaskAssigneePolicy} from './task-assignee-policy.js';
import {reconcileTaskSupervision} from './task-supervision.js';
import {recordTaskActivity} from './task-lifecycle.js';
import {notifyTaskAssignments} from './notification-events.js';
import {hasCapability} from '../permissions.js';

const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status,code:'subtask_reassignment_conflict'});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids=value=>Array.isArray(value)&&value.length>0&&value.length<=50
  &&value.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(value).size===value.length;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ordinaryChildren=d=>d.prepare(`SELECT t.* FROM tasks t WHERE t.parent_task_id=? AND t.archived_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
  AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)`);

function authorize(d,rootTaskId,actorId,taskIds){
  const root=d.prepare('SELECT * FROM tasks WHERE id=?').get(rootTaskId);
  if(!root||!isSubtaskOccurrenceRoot(d,root)||root.archived_at||!['open','unavailable','in_progress'].includes(root.status))
    fail('Choose an unfinished Activity occurrence.');
  const children=ordinaryChildren(d).all(root.id);
  if(!children.length||!taskIds.every(id=>children.some(child=>child.id===id)))
    fail('Choose unfinished subtasks on this Activity.',400);
  // The planner uses other work as its workload baseline. All of that work
  // must be visible to this actor; a candidate pool grants no access.
  for(const task of [root,...children]){
    const rights=taskCapabilities(d,actorId,task);
    if(!rights.view||!rights.change_assignment||!rights.reassign)
      fail('This actor cannot reassign this Activity and its subtasks.',403);
  }
  const byId=new Map(children.map(child=>[child.id,child]));
  for(const id of taskIds){
    const child=byId.get(id);
    if(!['open','unavailable','in_progress'].includes(child.status))fail('Completed work cannot be reassigned.');
    for(const table of ['task_completions','reward_task_awards','task_scoring_settlements'])
      if(d.prepare(`SELECT 1 FROM ${table} WHERE task_id=? LIMIT 1`).get(id))
        fail('A subtask with completed or awarded history cannot be reassigned.');
    if(d.prepare('SELECT 1 FROM task_assignment_context WHERE task_id=?').get(id)
      ||d.prepare("SELECT 1 FROM planning_obligations WHERE task_id=? AND status IN ('pending','accepted')").get(id))
      fail('This subtask has a managed assignment request. Resolve that request first.');
  }
  return {root,children,byId};
}

function authorizeSavedReceipt(d,rootTaskId,actorId,taskIds,changes=[]){
  const root=d.prepare('SELECT * FROM tasks WHERE id=?').get(rootTaskId);
  if(!root||!isSubtaskOccurrenceRoot(d,root)||!taskCapabilities(d,actorId,root).view)
    fail('This actor cannot read this Activity receipt.',403);
  for(const id of taskIds){
    const child=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if(!child||child.parent_task_id!==root.id||!taskCapabilities(d,actorId,child).view)
      fail('This actor cannot read a saved subtask receipt.',403);
  }
  if(changes.some(item=>item.source?.kind==='group'||item.source?.group_id)
    &&!hasCapability(d,actorId,'rotations.view'))
    fail('This actor cannot inspect this Group assignment.',403);
}

function validateRequest(request){
  const {mode,taskIds,fromUserId,replacementUserId}=request;
  if(!['replace','rebalance'].includes(mode)||!ids(taskIds)||!Number.isSafeInteger(fromUserId)||fromUserId<1)
    fail('Choose distinct unfinished subtasks and their current assignee.',400);
  if(mode==='replace'&&(!Number.isSafeInteger(replacementUserId)||replacementUserId<1||replacementUserId===fromUserId))
    fail('Choose a different household replacement.',400);
  if(mode==='rebalance'&&replacementUserId!=null)fail('Rebalance chooses from each saved Smart Group.',400);
}

function previewCore(d,request){
  validateRequest(request);
  const {rootTaskId,actorId,mode,taskIds,fromUserId,replacementUserId}=request;
  const {root,byId}=authorize(d,rootTaskId,actorId,taskIds);
  const selected=new Set(taskIds),before=new Map(),overrides=new Map();
  for(const id of taskIds){
    const current=d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row=>row.user_id);
    if(!current.includes(fromUserId))fail('The selected person no longer owns every selected subtask. Refresh first.');
    before.set(id,current);
    const raw=d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(id)?.source_json;
    const source=raw?JSON.parse(raw):null;
    const legacy=JSON.parse(byId.get(id).assignment_group_json||'null');
    if((source?.kind==='group'||legacy?.group_id)&&!hasCapability(d,actorId,'rotations.view'))
      fail('This actor cannot inspect this Group assignment.',403);
    if(mode==='rebalance'&&current.length!==1)
      fail('Rebalance currently requires one assigned person per selected subtask.',409);
    if(mode==='replace')overrides.set(id,{kind:'fixed',user_ids:[replacementUserId]});
    else{
      if(source?.kind!=='group'||source.mode!=='smart')fail('Rebalance requires saved Smart Group work.',400);
    }
  }
  const snapshot=buildSubtaskOccurrenceSnapshot(d,root.id,{overrideSources:overrides,
    reconsiderTaskIds:selected,allowInProgress:true,selectedTaskIds:selected});
  const relevant={...snapshot,rows:snapshot.rows.filter(row=>row.locked||selected.has(Number(row.key)))};
  const plan=planWithSupervisor(relevant,d);
  const decisions=new Map(plan.decisions.map(decision=>[Number(decision.key),decision]));
  const conflicts=plan.conflicts.filter(item=>selected.has(Number(item.key)));
  const changes=taskIds.map(taskId=>{
    const decision=decisions.get(taskId),original=before.get(taskId);
    const after=decision?.state==='assigned'?(mode==='replace'
      ?[...new Set([...original.filter(id=>id!==fromUserId),replacementUserId])]
      :decision.assignee_ids):[];
    return {task_id:taskId,title:byId.get(taskId).title,before_user_ids:original,after_user_ids:after,
      source:JSON.parse(d.prepare('SELECT source_json FROM task_subtask_assignment_rules WHERE task_id=?').get(taskId)?.source_json||'null')
        ||JSON.parse(byId.get(taskId).assignment_group_json||'null'),
      changed:decision?.state==='assigned'&&!same(original,after)};
  });
  const previewHash=digest({snapshot:snapshot.input_hash,mode,taskIds,fromUserId,replacementUserId,
    before:changes.map(item=>[item.task_id,item.before_user_ids]),plan:changes.map(item=>[item.task_id,item.after_user_ids]),
    supervisors:plan.supervisor_assignments});
  const supervised=taskIds.some(id=>{
    const row=relevant.rows.find(item=>item.key===String(id)),chosen=decisions.get(id)?.assignee_ids||[];
    return row?.supervised_candidates.some(item=>chosen.includes(item.user_id));
  });
  if(mode==='replace'&&supervised&&changes.some(item=>item.before_user_ids.length>1))
    fail('A supervised replacement of shared subtask work needs a separate supervisor plan.',409);
  if(supervised&&!taskSupervisionManagementAllowed(d,actorId,root.id))
    fail('This actor cannot manage the Activity supervisor.',403);
  return {mode,root_task_id:root.id,from_user_id:fromUserId,replacement_user_id:replacementUserId??null,
    preview_hash:previewHash,changes,conflicts,can_apply:conflicts.length===0,
    supervisor_user_id:plan.supervisor_user_id,supervisor_assignments:plan.supervisor_assignments,supervised};
}

function materialize(d,preview,{actorId,notify=false,idempotencyKey=null}={}){
  const changed=preview.changes.filter(item=>item.changed);
  for(const item of changed){
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(item.task_id);
    proposedTaskAssigneePolicy(d,task,{assigned_to:item.after_user_ids},{category:task.category});
    assertTaskMutation(d,actorId,task,{assigned_to:item.after_user_ids},{operation:'update'});
    d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(item.after_user_ids[0]??null,item.task_id);
  }
  setTaskAssignmentsBatch(d,changed.map(item=>({taskId:item.task_id,userIds:item.after_user_ids})));
  for(const item of changed)updateCapturedDirectAssignees(d,item.task_id,item.after_user_ids);
  if(changed.length){
    const view=reconcileTaskSupervision(d,preview.root_task_id,{actorId,
      supervisorAssignments:preview.supervised?preview.supervisor_assignments:null,perActionPlanning:true,notify:false});
    const unresolved=changed.some(item=>view.actions.some(action=>action.action_task_id===item.task_id
      &&action.state!=='not_required'&&!action.completed&&action.state!=='assigned'));
    if(unresolved)fail('A qualified supervisor cannot cover this reassignment.');
  }
  if(notify)for(const item of changed){
    d.prepare(`INSERT INTO task_subtask_occurrence_overrides
      (root_task_id,task_id,idempotency_key,actor_user_id,mode,before_user_ids_json,after_user_ids_json,source_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(preview.root_task_id,item.task_id,idempotencyKey,actorId,preview.mode,
        JSON.stringify(item.before_user_ids),JSON.stringify(item.after_user_ids),item.source?JSON.stringify(item.source):null);
    recordTaskActivity(d,preview.root_task_id,'reassigned',actorId,
      {occurrence_only:true,mode:preview.mode,before_user_ids:item.before_user_ids,after_user_ids:item.after_user_ids},item.task_id);
    notifyTaskAssignments(d,item.task_id,item.before_user_ids,
      {sourceKey:`subtask-override:${preview.root_task_id}:${idempotencyKey}:${item.task_id}`});
  }
  return changed;
}

function checkFeasible(d,preview,actorId){
  if(!preview.can_apply)return preview;
  d.exec('SAVEPOINT subtask_reassignment_preview');
  try{materialize(d,preview,{actorId});}
  catch(error){
    if(![400,409].includes(error.status)&&!['TaskSkillError','TaskSupervisionError','TaskAssignmentAvailabilityError'].includes(error.constructor.name))throw error;
    preview.can_apply=false;preview.conflicts=[...preview.conflicts,
      {reason:'assignment_or_supervision_conflict',message:error.message}];
  }
  finally{d.exec('ROLLBACK TO SAVEPOINT subtask_reassignment_preview');
    d.exec('RELEASE SAVEPOINT subtask_reassignment_preview');}
  return preview;
}

export function previewSubtaskReassignment(d,request){
  return d.transaction(()=>checkFeasible(d,previewCore(d,request),request.actorId)).deferred();
}

export function applySubtaskReassignment(d,request){
  if(typeof request.idempotencyKey!=='string'||!request.idempotencyKey.trim()||request.idempotencyKey.length>128
    ||typeof request.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(request.previewHash))
    fail('Preview this reassignment and provide one idempotency key.',400);
  return d.transaction(()=>{
    validateRequest(request);
    const saved=d.prepare(`SELECT actor_user_id,preview_hash,receipt_json FROM task_subtask_reassignment_runs
      WHERE root_task_id=? AND idempotency_key=?`).get(request.rootTaskId,request.idempotencyKey);
    if(saved){
      if(saved.actor_user_id!==request.actorId)fail('This reassignment key belongs to another actor.',403);
      const receipt=JSON.parse(saved.receipt_json),originalIds=receipt.changes.map(item=>item.task_id);
      if(saved.preview_hash!==request.previewHash||receipt.mode!==request.mode
        ||receipt.from_user_id!==request.fromUserId||receipt.replacement_user_id!==(request.replacementUserId??null)
        ||!same(originalIds,request.taskIds))fail('This reassignment key belongs to a different request.');
      authorizeSavedReceipt(d,request.rootTaskId,request.actorId,originalIds,receipt.changes);
      return receipt;
    }
    const preview=previewCore(d,request);
    if(preview.preview_hash!==request.previewHash)fail('This assignment preview is stale. Review it again.');
    if(!preview.can_apply)fail('This reassignment has an eligibility or supervision conflict.');
    const changed=materialize(d,preview,{actorId:request.actorId,notify:true,idempotencyKey:request.idempotencyKey});
    const receipt={...preview,changed_task_ids:changed.map(item=>item.task_id),idempotency_key:request.idempotencyKey};
    d.prepare(`INSERT INTO task_subtask_reassignment_runs
      (root_task_id,idempotency_key,actor_user_id,preview_hash,receipt_json) VALUES(?,?,?,?,?)`)
      .run(request.rootTaskId,request.idempotencyKey,request.actorId,request.previewHash,JSON.stringify(receipt));
    return receipt;
  }).immediate();
}
