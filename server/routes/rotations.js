import express from 'express';
import * as db from '../db.js';
import {actorId,actorPermissions,assertCapability,hasCapability} from '../permissions.js';
import {householdMembers} from '../services/activity-eligibility.js';
import {createChangesStream} from '../services/change-stream.js';
import {refreshRotationTaskRendering} from '../services/task-rotation-rendering.js';
import {taskCapabilities,withTaskReadProjection} from '../services/task-access.js';
import {listRotationGroups,getRotationGroup,saveRotationGroup,getRotationTrack,inspectRotationTrack,
  rotationHistory,getRotationOccurrence,previewRotation,finalizeRotation,skipRotation,overrideRotation,correctRotationTrack,refreshRotationOccurrence} from '../services/rotation.js';

const router=express.Router();
function handle(capability,fn) {
  return (req,res)=>{
    try {const d=db.get();assertCapability(d,req,`rotations.${capability}`);fn(d,req,res);}
    catch(error) {const status=Number.isInteger(error.status)?error.status:400;res.status(status).json({error:error.message,code:error.code||status});}
  };
}
function found(value) {if(!value){const e=new Error('Rotation not found.');e.status=404;throw e;}return value;}
/** Read-only consumer names follow durable identities, never title/date matching.
 * Rotation access does not grant visibility into an otherwise private Task. */
function consumerProjection(d,req,track) {
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
        const task=historicalTask();label=visible(task)?task.title:'Previous consumer';status='previous';
      }
    }
  } else if(track.consumer_type==='meal_plan') {
    label='Meal Planning';status='restricted';
    if(actorPermissions(d,req).modules.meals!=='none') {
      const plan=ownerId?d.prepare('SELECT name,status FROM meal_plans WHERE id=?').get(ownerId):null;
      label=plan?.name||'Previous consumer';status=plan?.status==='active'?'active':plan?.status==='archived'?'archived':'previous';
    }
  }
  return {...track,consumer_label:label,consumer_status:status,display_label:`${label} · ${purpose}`};
}
const clock=createChangesStream({table:'rotation_change_clock',deniedMessage:'Rotation access is not enabled.',
  canRead:(d,req)=>hasCapability(d,req,'rotations.view')});
router.get('/rotation-changes',clock);
router.get('/rotation-groups',handle('view',(d,req,res)=>res.json({data:listRotationGroups(d,{includeInactive:req.query.include_inactive==='1'})})));
router.get('/rotation-members',handle('view',(d,_req,res)=>res.json({data:householdMembers(d).map(({id,display_name})=>({id,display_name}))})));
router.post('/rotation-groups',handle('manage',(d,req,res)=>res.status(201).json({data:saveRotationGroup(d,req.body,{actorId:actorId(req)})})));
router.get('/rotation-groups/:id',handle('view',(d,req,res)=>{
  const group=found(getRotationGroup(d,req.params.id));
  const tracks=withTaskReadProjection(d,req,()=>d.prepare('SELECT id FROM rotation_tracks WHERE group_id=? ORDER BY label,id').all(group.id).map(row=>{
    const track=consumerProjection(d,req,inspectRotationTrack(d,row.id));
    if(!hasCapability(d,req,'rotations.history'))delete track.latest;
    return track;
  }));
  res.json({data:{...group,tracks}});
}));
router.put('/rotation-groups/:id',handle('manage',(d,req,res)=>res.json({data:saveRotationGroup(d,req.body,{id:req.params.id,actorId:actorId(req),expectedRevision:req.body.expected_revision})})));
router.post('/rotation-groups/:id/preview',handle('view',(d,req,res)=>res.json({data:previewRotation(d,{...req.body,group_id:Number(req.params.id)},{context:req.body.context||{}})})));
router.get('/rotation-tracks/:id',handle('view',(d,req,res)=>{
  const track=withTaskReadProjection(d,req,()=>consumerProjection(d,req,found(inspectRotationTrack(d,req.params.id))));if(!hasCapability(d,req,'rotations.history'))delete track.latest;
  res.json({data:track});
}));
router.get('/rotation-tracks/:id/history',handle('history',(d,req,res)=>res.json({data:rotationHistory(d,req.params.id)})));
router.post('/rotation-tracks/:id/correct',handle('correct',(d,req,res)=>res.json({data:correctRotationTrack(d,req.params.id,
  {next_member_id:req.body.next_member_id,expected_revision:req.body.expected_revision,reason:req.body.reason,actorId:actorId(req)})})));
router.get('/rotation-occurrences/:id',handle('history',(d,req,res)=>res.json({data:found(getRotationOccurrence(d,req.params.id))})));
router.get('/rotation-occurrences/:id/history',handle('history',(d,req,res)=>{
  const occurrence=found(getRotationOccurrence(d,req.params.id));
  res.json({data:d.prepare('SELECT id,event_type,details_json,actor_user_id,created_at FROM rotation_events WHERE occurrence_id=? ORDER BY id')
    .all(occurrence.id).map(row=>({...row,details:JSON.parse(row.details_json)}))});
}));
router.post('/rotation-occurrences/:id/finalize',handle('advance',(d,req,res)=>res.json({data:finalizeRotation(d,req.params.id,
  {outcome:req.body.outcome||'finalized',expectedRevision:req.body.expected_revision,actorId:actorId(req),manual:req.body.manual===true})})));
router.post('/rotation-occurrences/:id/skip',handle('advance',(d,req,res)=>res.json({data:skipRotation(d,req.params.id,
  {expectedRevision:req.body.expected_revision,actorId:actorId(req)})})));
router.post('/rotation-occurrences/:id/override',handle('override',(d,req,res)=>res.json({data:d.transaction(()=>{
  const occurrence=overrideRotation(d,req.params.id,{member_ids:req.body.member_ids,expected_revision:req.body.expected_revision,actorId:actorId(req)});
  refreshRotationTaskRendering(d,occurrence.id);return occurrence;
}).immediate()})));
router.post('/rotation-occurrences/:id/recheck',handle('override',(d,req,res)=>res.json({data:d.transaction(()=>{
  const occurrence=refreshRotationOccurrence(d,req.params.id,{expected_revision:req.body.expected_revision,actorId:actorId(req)});
  refreshRotationTaskRendering(d,occurrence.id);return occurrence;
}).immediate()})));
export default router;
