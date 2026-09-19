/** Transactional reconciliation of already materialized series occurrences.
 * The existing recurrence generator remains the only generator. */
import { randomUUID } from 'node:crypto';
import { planSeriesOccurrence, recordOccurrenceDefinition, registerSeriesAction, normalizeSeriesDefinition } from './task-series.js';
import { assertTaskMutation, taskCapabilities } from './task-access.js';
import { actorPermissions } from '../permissions.js';
import { TaskStateError } from './task-lifecycle.js';
import { setTaskSkills, assertTaskSkillAssignments } from './task-skills.js';
import { setTags } from '../utils/task-tags.js';
import { applyTaskActivityBinding, clearTaskActivityBinding } from './task-activity-bindings.js';
import { reconcileTaskSupervision, assertTaskSupervisionAssignee } from './task-supervision.js';
import { assertTaskAssignmentAvailability } from './assignment-responsibilities.js';
import { setTaskLocation } from './task-locations.js';
import { bindTaskRotations, assertRotationBindingsChange } from './task-rotation.js';
import { applyTaskRotationRendering } from './task-rotation-rendering.js';

const ROOT_FIELDS = ['title','description','category','priority','start_date','start_time','due_date','due_time',
  'due_date_offset_days','is_recurring','recurrence_rule','recurrence_from_completion','assignment_mode',
  'rotation_group','rotation_slot','rotation_bindings_json','points','visibility','countdown','locked','expiration_policy'];
const ACTION_FIELDS = ['title','description','category','priority','start_date','start_time','due_date','due_time',
  'points','visibility','locked','expiration_policy','is_optional','sort_order'];
const actorId = actor => typeof actor === 'number' ? actor : actor.authUserId || actor.session?.userId;
const read = (d,id) => d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const clone = value => JSON.parse(JSON.stringify(value));

export function proposedSeriesDefinition(before, { fields, editedSubtasks, assigned, rotation, skills, tags, binding, location }) {
  const after=clone(before);
  Object.assign(after.task, fields);
  after.assigned_user_ids=[...assigned];after.rotation_user_ids=[...rotation];after.skill_ids=[...skills];
  if(tags!==undefined)after.tags=[...tags];
  if(binding!==undefined)after.binding=binding;
  if(location!==undefined)after.location=location;
  if(after.binding?.snapshot) {
    after.binding.snapshot.required_skill_ids=[...skills];
  }
  if(editedSubtasks)after.subtasks=editedSubtasks.next.map((step,order)=>{
    const existing=before.subtasks.find(child=>child.source_task_id===step.id);
    const row=existing?clone(existing):{action_key:`series-action:${randomUUID()}`,source_task_id:null,
      task:{description:null,category:fields.category,priority:'none',start_date:fields.start_date,start_time:fields.start_time,
        due_date:fields.due_date,due_time:fields.due_time,points:0,visibility:fields.visibility,locked:0,
        expiration_policy:'keep_overdue',is_recurring:0,recurrence_rule:null,recurrence_from_completion:0,
        assignment_mode:'fixed',rotation_group:null,rotation_slot:0,countdown:0,due_date_offset_days:null},
      assigned_user_ids:[],tags:[]};
    Object.assign(row.task,{title:step.title,sort_order:order,is_optional:step.isOptional});
    if(step.assignedUsers!==undefined)row.assigned_user_ids=[...step.assignedUsers];
    row.skill_ids=[...step.skillIds];return row;
  });
  if(after.rotation_rendering)after.rotation_rendering.targets=after.rotation_rendering.targets.filter(target=>{
    if(target.action_key==='root')return before.task[target.field]===after.task[target.field];
    const prior=before.subtasks.find(child=>child.action_key===target.action_key),next=after.subtasks.find(child=>child.action_key===target.action_key);
    return prior&&next&&prior.task[target.field]===next.task[target.field];
  });
  return after;
}

export function assertSeriesEdit(d,actor,task,state,expectedRevision) {
  if(!state || task.parent_task_id)throw new TaskStateError('Choose a recurring Activity occurrence.',{},400);
  const permissions=taskCapabilities(d,actor,task);
  if(!permissions.edit||!permissions.change_dates)throw new TaskStateError('Your household permissions do not allow editing this recurring Activity.',{},403);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)
    throw new TaskStateError('Refresh this recurring Activity before saving its future occurrences.',{reason:'series_revision_required'},428);
  if(state.revision!==expectedRevision)throw new TaskStateError('This recurring Activity changed on another device. Reload it before trying again.',
    {reason:'series_revision_conflict',series_revision:state.revision});
}

/** An occurrence may contain an authorized one-off exception. Promoting that
 * exception also changes the durable policy, even if the submitted field is
 * unchanged on the selected occurrence. Check both boundaries explicitly. */
export function assertSeriesDefinitionMutation(d,actor,task,before,after) {
  assertRotationBindingsChange(d, actor, before.task.rotation_bindings_json, after.task.rotation_bindings_json);
  const previous=normalizeSeriesDefinition(before),next=normalizeSeriesDefinition(after);
  const rootCapabilities=taskCapabilities(d,actor,task);
  const same=(left,right)=>JSON.stringify(left??null)===JSON.stringify(right??null);
  const assertCanonicalLock=(locked,concrete)=>{
    if(locked&&!actorPermissions(d,actor).admin&&Number(concrete.created_by)!==Number(actorId(actor)))
      throw new TaskStateError('This recurring Activity definition is locked. Only its creator or a household administrator can change it.',
        {reason:'series_definition_locked'},403);
  };
  assertCanonicalLock(previous.task.locked,task);
  const requireCapability=(capabilities,key)=>{
    if(!capabilities[key])throw new TaskStateError('Your household permissions do not allow changing this recurring Activity setting.',
      {reason:'series_definition_permission',capability:`tasks.${key}`},403);
  };
  const fields={change_points:['points'],change_priority:['priority'],change_category_tags:['category'],
    change_dates:['calendar_lead_days','due_date_offset_days','start_time','due_time','expiration_policy','is_recurring','recurrence_rule','recurrence_from_completion'],
    change_assignment:['assignment_mode','rotation_group','rotation_slot']};
  const assertConfiguration=(old,newValue,capabilities)=>{
    for(const [permission,names] of Object.entries(fields))if(names.some(name=>!same(old.task?.[name],newValue.task?.[name]))) {
      requireCapability(capabilities,permission);
      if(permission==='change_assignment')requireCapability(capabilities,'reassign');
    }
    if(!same(old.binding?.snapshot?.required_skill_ids??old.skill_ids,newValue.binding?.snapshot?.required_skill_ids??newValue.skill_ids))
      requireCapability(capabilities,'change_required_skills');
    if(!same(old.tags,newValue.tags))requireCapability(capabilities,'change_category_tags');
    const dynamicAssignment=old.binding&&newValue.binding||old.task?.assignment_mode==='round_robin'&&newValue.task?.assignment_mode==='round_robin';
    if(!dynamicAssignment&&!same(old.assigned_user_ids,newValue.assigned_user_ids)||!same(old.rotation_user_ids,newValue.rotation_user_ids)) {
      requireCapability(capabilities,'change_assignment');requireCapability(capabilities,'reassign');
    }
  };
  assertConfiguration(previous,next,rootCapabilities);
  const bindingPolicy=binding=>{
    if(!binding)return null;
    const policy=clone(binding);
    if(policy.snapshot){delete policy.snapshot.required_skill_ids;delete policy.snapshot.checklist;delete policy.snapshot.rotation_rendering;}
    return policy;
  };
  if(!same(bindingPolicy(previous.binding),bindingPolicy(next.binding))) {
    requireCapability(rootCapabilities,'change_assignment');requireCapability(rootCapabilities,'reassign');
    if(previous.binding?.activity_template_id!==next.binding?.activity_template_id) {
      requireCapability(rootCapabilities,'change_required_skills');
      if(next.binding&&actorPermissions(d,actor).capabilities['activities.view']!=='allow')
        throw new TaskStateError('You cannot use Activity Templates.',{reason:'series_definition_permission'},403);
    }
  }
  const oldActions=new Map(previous.subtasks.map(action=>[action.action_key,action]));
  const newKeys=new Set(next.subtasks.map(action=>action.action_key));
  for(const action of previous.subtasks)if(!newKeys.has(action.action_key)) {
    const concrete=d.prepare(`SELECT t.* FROM task_recurrence_actions a JOIN tasks t ON t.id=a.task_id
      WHERE a.occurrence_task_id=? AND a.action_key=?`).get(task.id,action.action_key);
    assertCanonicalLock(action.task.locked,concrete||task);
    requireCapability(concrete?taskCapabilities(d,actor,concrete):rootCapabilities,'delete_archive');
  }
  for(const action of next.subtasks) {
    const old=oldActions.get(action.action_key);
    if(!old) {
      requireCapability(rootCapabilities,'create');
      if(action.skill_ids?.length)requireCapability(rootCapabilities,'change_required_skills');
      if(action.assigned_user_ids?.length){requireCapability(rootCapabilities,'change_assignment');requireCapability(rootCapabilities,'reassign');}
      if(action.task.points)requireCapability(rootCapabilities,'change_points');
      continue;
    }
    const concrete=d.prepare(`SELECT t.* FROM task_recurrence_actions a JOIN tasks t ON t.id=a.task_id
      WHERE a.occurrence_task_id=? AND a.action_key=?`).get(task.id,action.action_key);
    if(!same(old,action))assertCanonicalLock(old.task.locked,concrete||task);
    assertConfiguration(old,action,concrete?taskCapabilities(d,actor,concrete):rootCapabilities);
  }
}

export function normalizedSeriesLocation(location) {
  if(!location)return null;
  return {kind:location.kind,placeId:location.place_id,provider:location.external_provider,
    externalPlaceId:location.external_place_id,userLabel:location.user_label,manualAddress:location.manual_address,
    latitude:location.latitude,longitude:location.longitude};
}

function assignments(d,id,users) {
  d.prepare('DELETE FROM task_assignments WHERE task_id=?').run(id);
  for(const user of users)d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id,user);
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(users[0]??null,id);
}

function treeState(d,id) {
  return d.prepare(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id)
    SELECT t.id,t.revision,t.status,t.archived_at FROM tasks t JOIN tree ON tree.id=t.id ORDER BY t.id`).all(id);
}

export function seriesOccurrencePreservationReason(d,occurrence,task) {
  if(task.archived_at||['done','expired'].includes(task.status))return 'historical';
  if(task.status!=='open')return 'activity';
  if(occurrence.exception_reason)return 'manual_edit';
  if(!occurrence.materialized_state_json)return 'unverified_legacy_occurrence';
  const current=treeState(d,task.id),saved=JSON.parse(occurrence.materialized_state_json);
  if(JSON.stringify(current)!==JSON.stringify(saved.tasks))return 'activity';
  const ids=current.map(row=>row.id),marks=ids.map(()=>'?').join(',');
  if(current.some(row=>row.status!=='open'&&!row.archived_at))return 'progress';
  for(const table of ['task_comments','task_documents','task_completions','reward_task_awards'])
    if(d.prepare(`SELECT 1 FROM ${table} WHERE task_id IN (${marks}) LIMIT 1`).get(...ids))return 'activity';
  if(d.prepare(`SELECT 1 FROM planning_obligations WHERE task_id IN (${marks}) AND responded_at IS NOT NULL LIMIT 1`).get(...ids))return 'assignment_response';
  if(d.prepare(`SELECT 1 FROM task_activity_events WHERE task_id IN (${marks}) AND event_type NOT IN
    ('created','recurrence_generated','supervisor_assigned','supervision_needed','supervision_not_required','action_delegated') LIMIT 1`).get(...ids))return 'activity';
  return null;
}

function shiftDate(date,oldAnchor,newAnchor) {
  if(!date||!oldAnchor||!newAnchor)return date??null;
  return new Date(Date.parse(`${date}T00:00:00Z`)+Date.parse(`${newAnchor}T00:00:00Z`)-Date.parse(`${oldAnchor}T00:00:00Z`)).toISOString().slice(0,10);
}

function reconcileOccurrence(d,task,definition,window,actor) {
  const data=definition.data,fields={...data.task,rotation_bindings_json:data.task.rotation_bindings_json||'[]',start_date:window.start_date,due_date:window.due_date};
  const roster=data.rotation_user_ids;
  const assigned=!data.binding&&fields.assignment_mode==='round_robin'&&roster.length
    ? [roster[((task.rotation_index||0)+(fields.rotation_group?fields.rotation_slot||0:0))%roster.length]] : data.assigned_user_ids;
  const body={...fields,assigned_to:assigned,skill_ids:data.skill_ids,tags:data.tags,subtasks:[]};
  assertTaskMutation(d,actor,task,body,{operation:'update'});
  const capabilities=taskCapabilities(d,actor,task);
  if(!capabilities.edit||!capabilities.change_dates)throw new TaskStateError('This future occurrence cannot be edited with your permissions.',{},403);
  if(!data.binding)assertTaskSkillAssignments(d,data.skill_ids,assigned,window.due_date);
  assertTaskAssignmentAvailability(d,task.id,assigned,{task:fields});
  d.prepare(`UPDATE tasks SET ${ROOT_FIELDS.map(key=>`${key}=?`).join(',')} WHERE id=?`)
    .run(...ROOT_FIELDS.map(key=>fields[key]??null),task.id);
  assignments(d,task.id,assigned);setTaskSkills(d,task.id,data.skill_ids);setTags(d,task.id,data.tags);
  d.prepare('DELETE FROM task_rotation_members WHERE task_id=?').run(task.id);
  data.rotation_user_ids.forEach((id,order)=>d.prepare('INSERT INTO task_rotation_members(task_id,user_id,sort_order) VALUES(?,?,?)').run(task.id,id,order));
  const children=d.prepare(`SELECT t.*,a.action_key FROM tasks t LEFT JOIN task_recurrence_actions a ON a.task_id=t.id
    WHERE t.parent_task_id=? AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM task_supervision_actions s WHERE s.counterpart_task_id=t.id)`).all(task.id);
  const wanted=new Set(data.subtasks.map(child=>child.action_key));
  for(const child of children.filter(row=>!row.archived_at&&!wanted.has(row.action_key))) {
    assertTaskMutation(d,actor,child,{}, {operation:'delete'});
    d.prepare("UPDATE tasks SET archived_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(child.id);
  }
  const oldAnchor=data.task.due_date_offset_days!=null?data.task.start_date:data.task.due_date;
  const newAnchor=data.task.due_date_offset_days!=null?window.start_date:window.due_date;
  for(const [order,action] of data.subtasks.entries()) {
    const existing=children.find(row=>row.action_key===action.action_key&&!row.archived_at);
    const value={...action.task,start_date:shiftDate(action.task.start_date,oldAnchor,newAnchor),
      due_date:shiftDate(action.task.due_date,oldAnchor,newAnchor),sort_order:order};
    assertTaskMutation(d,actor,existing||null,{...value,parent_task_id:task.id,skill_ids:action.skill_ids,assigned_to:action.assigned_user_ids},
      {operation:existing?'update':'create'});
    assertTaskSkillAssignments(d,action.skill_ids,action.assigned_user_ids,value.due_date,{allowDelegation:true});
    let id=existing?.id;
    if(id)d.prepare(`UPDATE tasks SET ${ACTION_FIELDS.map(key=>`${key}=?`).join(',')} WHERE id=?`).run(...ACTION_FIELDS.map(key=>value[key]??null),id);
    else id=Number(d.prepare(`INSERT INTO tasks(${ACTION_FIELDS.join(',')},status,parent_task_id,created_by)
      VALUES(${ACTION_FIELDS.map(()=>'?').join(',')},'open',?,?)`).run(...ACTION_FIELDS.map(key=>value[key]??null),task.id,actorId(actor)).lastInsertRowid);
    registerSeriesAction(d,id,task.id,action.action_key);
    assignments(d,id,action.assigned_user_ids);setTaskSkills(d,id,action.skill_ids);setTags(d,id,action.tags);
  }
  if(data.binding)applyTaskActivityBinding(d,task.id,{activityTemplateId:data.binding.activity_template_id,
    subjectUserId:data.binding.subject_user_id,assignmentOverrideUserId:data.binding.assignment_override_user_id,
    activitySnapshot:data.binding.snapshot,commitRotation:false,allowInactive:true,
    materializeChecklist:false,dateKey:window.due_date});
  else if(d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id=?').get(task.id))clearTaskActivityBinding(d,task.id);
  const dueAt=window.due_date?`${window.due_date}T${fields.due_time||'23:59'}:00`:null;
  d.prepare(`UPDATE planning_obligations SET due_at=?,
    response_deadline=CASE WHEN response_deadline=due_at THEN ? ELSE response_deadline END,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE task_id=? AND status IN ('pending','accepted')`).run(dueAt,dueAt,task.id);
  setTaskLocation(d,task.id,normalizedSeriesLocation(data.location),actorId(actor));
  const rotations=bindTaskRotations(d,task.id,{actorId:actorId(actor),scope:'future'});
  if(rotations.preserved?.length)throw new TaskStateError('This future occurrence already has a resolved rotation snapshot.',{reason:'rotation_snapshot'});
  applyTaskRotationRendering(d,task.id,data.rotation_rendering);
  reconcileTaskSupervision(d,task.id,{actorId:actorId(actor)});
  const resultingAssignee=read(d,task.id).assigned_to;if(resultingAssignee)assertTaskSupervisionAssignee(d,task.id,resultingAssignee);
  return rotations;
}

/** Caller owns an IMMEDIATE transaction covering the selected Task, series CAS
 * and all these writes. A future exception rolls back only its own savepoint. */
export function reconcileSeriesFuture(d,state,{actor,definition=state.definition}={}) {
  const updated=[],preserved=[],pending_rotations=[];
  let previous={...state.occurrence};
  const selected=read(d,state.occurrence.task_id);
  if(!selected.archived_at&&!['done','expired'].includes(selected.status))
    previous={...previous,definition_id:definition.id};
  const future=d.prepare(`SELECT o.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
    WHERE o.series_id=? AND o.generation>? AND o.state='materialized' ORDER BY o.generation,o.task_id`).all(state.series_id,state.occurrence.generation);
  for(const occurrence of future) {
    const task=read(d,occurrence.task_id);
    const preserve=reason=>{preserved.push({...(taskCapabilities(d,actor,task).view?{task_id:task.id}:{}),reason});previous=occurrence;};
    const reason=seriesOccurrencePreservationReason(d,occurrence,task);
    if(reason){preserve(reason);continue;}
    // Existing completion-relative dates were already materialized from an
    // actual completion. Reuse that occurrence start, never invent a new one.
    let window=definition.data.task.recurrence_from_completion
      ? {start_date:occurrence.planned_start_date,due_date:occurrence.planned_due_date}
      : planSeriesOccurrence(d,definition,previous,{expired:false});
    if(!window){preserve('schedule_ended');continue;}
    if(definition.data.task.due_date_offset_days!=null && window.start_date)
      window.due_date=new Date(Date.parse(`${window.start_date}T00:00:00Z`)+definition.data.task.due_date_offset_days*86400000).toISOString().slice(0,10);
    const key=window.due_date||window.start_date||`task:${task.id}`;
    if(d.prepare("SELECT 1 FROM task_recurrence_occurrences WHERE series_id=? AND occurrence_key=? AND state='materialized' AND task_id!=?").get(state.series_id,key,task.id)) {
      preserve('schedule_conflict');continue;
    }
    try {
      const rotations=d.transaction(()=>{
        d.prepare('UPDATE task_recurrence_occurrences SET occurrence_key=? WHERE task_id=?').run(key,task.id);
        const rotations=reconcileOccurrence(d,task,definition,window,actor);
        recordOccurrenceDefinition(d,task.id,{definitionId:definition.id,startDate:window.start_date,dueDate:window.due_date,baseline:true});
        return rotations;
      })();
      updated.push(task.id);
      if(rotations.pending?.length)pending_rotations.push({task_id:task.id,purposes:rotations.pending});
      previous={...occurrence,planned_start_date:window.start_date,planned_due_date:window.due_date,definition_id:definition.id};
    } catch(error) {
      if(![400,403,409].includes(error.status)&&!['TaskSkillError','TaskSupervisionError','TaskActivityBindingError','TaskAssignmentAvailabilityError'].includes(error.constructor.name))throw error;
      preserve(error.details?.reason==='rotation_snapshot'?'rotation_snapshot':'eligibility_or_permission');
    }
  }
  return {scope:'future',series_id:state.series_id,revision:state.revision,updated,preserved,pending_rotations};
}
