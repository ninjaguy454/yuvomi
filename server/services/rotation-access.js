import {actorPermissions,hasCapability} from '../permissions.js';
import {taskCapabilities,withTaskReadProjection} from './task-access.js';
import {getRotationTrack,getRotationOccurrence,getRotationGroup} from './rotation.js';
function found(value) {if(!value){const e=new Error('Rotation not found.');e.status=404;throw e;}return value;}
/** Read-only consumer names follow durable identities, never title/date matching.
 * Rotation access does not grant visibility into an otherwise private Task. */
export function projectRotationTrack(d,req,track) {
  // Shared state is deliberately Group-owned. Reading that shared order does
  // not require access to the private consumers that happen to reference it.
  if(track.consumer_type==='rotation_group_schedule') {
    if(!hasCapability(d,req,'rotations.view'))return null;
    const group=getRotationGroup(d,track.group_id);
    if(!group)return null;
    return {...track,consumer_label:group.name,consumer_status:group.active?'active':'inactive',
      display_label:`${group.name} · Shared across activities`};
  }
  const identity=String(track.consumer_id),scoped=['task_exception','workflow_step','meal_plan'].includes(track.consumer_type);
  const ownerId=Number(identity.match(scoped?/^([1-9]\d*):/:/^([1-9]\d*)$/)?.[1]);
  const purpose=track.label||track.purpose_key.replaceAll('_',' ');
  const taskById=id=>id?d.prepare('SELECT * FROM tasks WHERE id=?').get(id):null;
  const visible=task=>task&&taskCapabilities(d,req,task).view;
  const historicalTask=()=>d.prepare(`SELECT t.* FROM task_rotation_occurrences r JOIN tasks t ON t.id=COALESCE(r.owner_task_id,r.task_id)
    WHERE r.track_id=? ORDER BY r.id DESC LIMIT 1`).get(track.id);
  let label='Previous consumer',status='previous';
  if(track.consumer_type==='task_series') {
    const definition=ownerId?d.prepare('SELECT source_task_id,definition_json FROM task_recurrence_definitions WHERE series_id=? ORDER BY id DESC LIMIT 1').get(ownerId):null;
    const source=taskById(definition?.source_task_id);
    const task=source||(ownerId?d.prepare(`SELECT t.* FROM task_recurrence_occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.series_id=? ORDER BY o.generation DESC,o.task_id DESC LIMIT 1`).get(ownerId):null);
    if(task) {
      label='Recurring Activity';status='restricted';
      if(visible(task)) {
        label=(source&&definition?JSON.parse(definition.definition_json).task?.title:null)||task.title;
        status=task.archived_at?'archived':'active';
      }
    }
  } else if(track.consumer_type==='task'||track.consumer_type==='task_exception') {
    const task=taskById(ownerId);
    if(task){label='Activity';status='restricted';if(visible(task)){label=task.title;status=task.archived_at?'archived':'active';}}
  } else if(track.consumer_type==='workflow'||track.consumer_type==='workflow_step') {
    label='Workflow';status='restricted';
    if(hasCapability(d,req,'workflows.view')) {
      const workflow=ownerId?d.prepare('SELECT * FROM workflow_templates WHERE id=?').get(ownerId):null;
      if(workflow) {
        label=workflow.name;status=workflow.active?'active':'inactive';
        if(track.consumer_type==='workflow_step') {
          const key=identity.slice(identity.indexOf(':')+1);
          const step=d.prepare(`SELECT COALESCE(NULLIF(s.title_override,''),a.name) AS name FROM workflow_template_steps s
            JOIN activity_templates a ON a.id=s.activity_template_id WHERE s.workflow_template_id=? AND s.step_key=?`).get(ownerId,key);
          label+=` · ${step?.name||'Previous step'}`;if(!step)status='previous';
        }
      } else {
        // The source template may be deleted while its generated Task evidence survives.
        const task=historicalTask();if(task?!visible(task):!actorPermissions(d,req).admin)return null;label=visible(task)?task.title:'Previous consumer';status='previous';
      }
    }
  } else if(track.consumer_type==='meal_plan') {
    label='Meal Planning';status='restricted';
    if(actorPermissions(d,req).modules.meals!=='none') {
      const plan=ownerId?d.prepare('SELECT name,status FROM meal_plans WHERE id=?').get(ownerId):null;
      label=plan?.name||'Previous consumer';status=plan?.status==='active'?'active':plan?.status==='archived'?'archived':'previous';
    }
  }
  if(status==='restricted')return null;
  // A deleted private source has no canonical visible Task to authorize its
  // retained context. Only administrators can inspect orphaned Task history.
  if(status==='previous'&&['task','task_exception','task_series'].includes(track.consumer_type)&&!actorPermissions(d,req).admin)return null;
  // A template's visibility does not authorize the private instances it produced.
  // Check canonical owners before exposing any state: even preview order and the
  // Track cursor can reveal an inaccessible occurrence. This is a synchronous
  // request projection, never an authorization cache across requests/mutations.
  const owners=d.prepare(`SELECT DISTINCT t.* FROM tasks t WHERE t.id IN (
    SELECT json_extract(context_json,'$.task_id') FROM rotation_occurrences WHERE track_id=?
    UNION SELECT COALESCE(owner_task_id,task_id) FROM task_rotation_occurrences WHERE track_id=?
    UNION SELECT w.parent_task_id FROM rotation_occurrences o JOIN workflow_instances w
      ON w.id=json_extract(o.context_json,'$.workflow_instance_id') WHERE o.track_id=?)`).all(track.id,track.id,track.id);
  if(owners.some(task=>!visible(task)))return null;
  return {...track,consumer_label:label,consumer_status:status,display_label:`${label} · ${purpose}`};
}
export function readRotationTrack(d,req,trackId) {return found(projectRotationTrack(d,req,found(getRotationTrack(d,trackId))));}
export function readRotationOccurrence(d,req,occurrenceId) {
  const occurrence=found(getRotationOccurrence(d,occurrenceId)),track=readRotationTrack(d,req,occurrence.track_id);
  return projectRotationOccurrence(occurrence,track);
}

/** Defense in depth for every shared-history embedding. Consumer context is
 * never part of a Group-owned snapshot, even if an older adapter supplied it. */
export function projectRotationOccurrence(occurrence,track) {
  if(!occurrence||track?.consumer_type!=='rotation_group_schedule')return occurrence;
  const context=Object.fromEntries(Object.entries(occurrence.context||{}).filter(([key])=>[
    'dateKey','period_date','nominal_date','active_at','finalize_at','timezone','schedule_revision',
    'scheduled','recovered',
  ].includes(key)));
  return {...occurrence,context,context_json:JSON.stringify(context),consumer_eligibility:null,consumer_eligibility_json:null};
}

/** Group usage is separate from the intentionally shared state. Each entry
 * continues to honor its consumer's canonical visibility. No private dates,
 * subjects or progress are returned as side channels. */
export function sharedRotationUsage(d,actor,trackId) {
  return withTaskReadProjection(d,actor,()=>{
    const tasks=d.prepare(`SELECT DISTINCT t.* FROM task_rotation_occurrences r JOIN tasks t ON t.id=r.task_id
      WHERE r.track_id=? AND r.retired_at IS NULL ORDER BY t.id`).all(trackId);
    const result=tasks.filter(task=>taskCapabilities(d,actor,task).view).map(task=>({consumer_type:'task',consumer_id:task.id,
      consumer_label:task.title,consumer_status:task.archived_at?'archived':['done','expired'].includes(task.status)?'historical':'active'}));
    if(actorPermissions(d,actor).modules.meals!=='none') {
      const plans=d.prepare(`SELECT DISTINCT p.id,p.name,p.status FROM meal_plans p JOIN meal_plan_rules r ON r.meal_plan_id=p.id
        JOIN rotation_tracks t ON t.id=? WHERE r.chooser_rotation_group_id=t.group_id OR r.cook_rotation_group_id=t.group_id OR r.supervisor_rotation_group_id=t.group_id`).all(trackId);
      result.push(...plans.map(plan=>({consumer_type:'meal_plan',consumer_id:plan.id,consumer_label:plan.name,consumer_status:plan.status})));
    }
    return result;
  });
}

/** Read-only typed picker: filter complete owning consumers before exposing keys. */
export function rotationOccurrenceOptions(d,actor) {
 if(!hasCapability(d,actor,'rotations.history'))return [];
 return withTaskReadProjection(d,actor,()=>{
  const visible=new Map();
  return d.prepare('SELECT o.id,o.track_id,o.occurrence_key,t.label AS purpose_label FROM rotation_occurrences o JOIN rotation_tracks t ON t.id=o.track_id ORDER BY o.id DESC LIMIT 100').all().filter(row=>{
   if(!visible.has(row.track_id))visible.set(row.track_id,!!projectRotationTrack(d,actor,getRotationTrack(d,row.track_id)));
   return visible.get(row.track_id);
  }).map(({track_id,...row})=>row);
 });
}
