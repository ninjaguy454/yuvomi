import express from 'express';
import * as db from '../db.js';
import {actorId,assertCapability,hasCapability,actorPermissions} from '../permissions.js';
import {householdMembers} from '../services/activity-eligibility.js';
import {createChangesStream} from '../services/change-stream.js';
import {refreshRotationTaskRendering} from '../services/task-rotation-rendering.js';
import {taskCapabilities,withTaskReadProjection} from '../services/task-access.js';
import {projectRotationTrack,readRotationTrack,readRotationOccurrence,projectRotationOccurrence,sharedRotationUsage} from '../services/rotation-access.js';
import {rotationGroupUsage,saveRotationGroupUsage,previewRotationGroupUsage,previewSharedRotation,sharedGroupConfiguration,notifySharedRotationReconciliation} from '../services/rotation-shared.js';
import {listRotationGroups,getRotationGroup,saveRotationGroup,getRotationTrack,inspectRotationTrack,
  rotationHistory,rotationTrackEvents,getRotationOccurrence,previewRotation,finalizeRotation,skipRotation,overrideRotation,correctRotationTrack,refreshRotationOccurrence} from '../services/rotation.js';

const router=express.Router();
function handle(capability,fn) {
  return (req,res)=>{
    try {const d=db.get();assertCapability(d,req,`rotations.${capability}`);withTaskReadProjection(d,req,()=>fn(d,req,res));}
    catch(error) {const status=Number.isInteger(error.status)?error.status:400;res.status(status).json({error:error.message,code:error.code||status});}
  };
}
function found(value) {if(!value){const e=new Error('Rotation not found.');e.status=404;throw e;}return value;}
function reconciliationSummary(d,req,result) {
  const visible=(result?.preserved||[]).filter(item=>item.consumer_type==='meal'?actorPermissions(d,req).modules.meals!=='none'
    :item.consumer_type==='task'&&taskCapabilities(d,req,{id:Number(item.consumer_id)}).view);
  return {preserved_count:visible.length};
}
function authorizedPreviewContext(d,req,context={}) {
  const taskIds=[context.task_id];
  if(context.workflow_instance_id)taskIds.push(d.prepare('SELECT parent_task_id FROM workflow_instances WHERE id=?').get(context.workflow_instance_id)?.parent_task_id);
  for(const taskId of taskIds.filter(value=>value!=null)) {
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    found(task&&taskCapabilities(d,req,task).view);
  }
  return context;
}
const clock=createChangesStream({table:'rotation_change_clock',deniedMessage:'Rotation access is not enabled.',
  canRead:(d,req)=>hasCapability(d,req,'rotations.view')});
router.get('/rotation-changes',clock);
router.get('/rotation-groups',handle('view',(d,req,res)=>res.json({data:listRotationGroups(d,{includeInactive:req.query.include_inactive==='1'}).map(group=>({...group,...rotationGroupUsage(d,group.id)}))})));
router.get('/rotation-members',handle('view',(d,_req,res)=>res.json({data:householdMembers(d).map(({id,display_name})=>({id,display_name}))})));
router.post('/rotation-groups',handle('manage',(d,req,res)=>res.status(201).json({data:saveRotationGroupUsage(d,req.body,{actorId:actorId(req)})})));
router.get('/rotation-groups/:id',handle('view',(d,req,res)=>{
  const group=found(getRotationGroup(d,req.params.id));
  const tracks=d.prepare('SELECT id FROM rotation_tracks WHERE group_id=? ORDER BY label,id').all(group.id).map(row=>{
    const visible=projectRotationTrack(d,req,getRotationTrack(d,row.id));if(!visible)return null;
    const track={...inspectRotationTrack(d,row.id),...visible};
    track.latest=projectRotationOccurrence(track.latest,track);
    if(track.consumer_type==='rotation_group_schedule')track.used_by=sharedRotationUsage(d,req,track.id);
    if(!hasCapability(d,req,'rotations.history'))delete track.latest;
    return track;
  }).filter(Boolean);
  res.json({data:{...group,...rotationGroupUsage(d,group.id),tracks}});
}));
router.put('/rotation-groups/:id',handle('manage',(d,req,res)=>res.json({data:saveRotationGroupUsage(d,req.body,{id:req.params.id,actorId:actorId(req),expectedRevision:req.body.expected_revision})})));
router.post('/rotation-groups/:id/usage-preview',handle('manage',(d,req,res)=>res.json({data:previewRotationGroupUsage(d,req.params.id,req.body,{actorId:actorId(req)})})));
router.post('/rotation-groups/:id/preview',handle('view',(d,req,res)=>{
  const dateKey=req.body.dateKey??req.body.context?.dateKey;
  const shared=sharedGroupConfiguration(d,Number(req.params.id),dateKey);
  res.json({data:shared?previewSharedRotation(d,Number(req.params.id),{dateKey}):previewRotation(d,{...req.body,group_id:Number(req.params.id)},{context:authorizedPreviewContext(d,req,req.body.context)})});
}));
router.get('/rotation-tracks/:id',handle('view',(d,req,res)=>{
  const visible=readRotationTrack(d,req,req.params.id),track={...inspectRotationTrack(d,req.params.id),...visible};if(!hasCapability(d,req,'rotations.history'))delete track.latest;
  track.latest=projectRotationOccurrence(track.latest,track);
  if(track.consumer_type==='rotation_group_schedule')track.used_by=sharedRotationUsage(d,req,track.id);
  res.json({data:track});
}));
router.get('/rotation-tracks/:id/history',handle('history',(d,req,res)=>{const track=readRotationTrack(d,req,req.params.id);res.json({data:rotationHistory(d,req.params.id).map(occurrence=>projectRotationOccurrence(occurrence,track)),events:rotationTrackEvents(d,req.params.id)});}));
router.post('/rotation-tracks/:id/correct',handle('correct',(d,req,res)=>res.json({data:d.transaction(()=>{
  readRotationTrack(d,req,req.params.id);const track=correctRotationTrack(d,req.params.id,
    {next_member_id:req.body.next_member_id,expected_revision:req.body.expected_revision,reason:req.body.reason,actorId:actorId(req)});
  if(track.consumer_type==='rotation_group_schedule')notifySharedRotationReconciliation(d,{groupId:track.group_id,reason:'track_corrected'});
  return track;
}).immediate()})));
router.get('/rotation-occurrences/:id',handle('history',(d,req,res)=>res.json({data:readRotationOccurrence(d,req,req.params.id)})));
router.get('/rotation-occurrences/:id/history',handle('history',(d,req,res)=>{
  const occurrence=readRotationOccurrence(d,req,req.params.id);
  res.json({data:d.prepare('SELECT id,event_type,details_json,actor_user_id,created_at FROM rotation_events WHERE occurrence_id=? ORDER BY id')
    .all(occurrence.id).map(row=>({...row,details:JSON.parse(row.details_json)}))});
}));
router.post('/rotation-occurrences/:id/finalize',handle('advance',(d,req,res)=>{readRotationOccurrence(d,req,req.params.id);res.json({data:finalizeRotation(d,req.params.id,
  {outcome:req.body.outcome||'finalized',expectedRevision:req.body.expected_revision,actorId:actorId(req),manual:req.body.manual===true})});}));
router.post('/rotation-occurrences/:id/skip',handle('advance',(d,req,res)=>res.json({data:d.transaction(()=>{
  const before=readRotationOccurrence(d,req,req.params.id),track=getRotationTrack(d,before.track_id),shared=track.consumer_type==='rotation_group_schedule';
  const occurrence=skipRotation(d,req.params.id,{expectedRevision:req.body.expected_revision,actorId:actorId(req),sharedSchedule:shared});
  const result=shared?notifySharedRotationReconciliation(d,{groupId:track.group_id,occurrence,reason:'period_skipped'}):null;
  return {...projectRotationOccurrence(occurrence,track),...(shared?{reconciliation:reconciliationSummary(d,req,result)}:{})};
}).immediate()})));
router.post('/rotation-occurrences/:id/override',handle('override',(d,req,res)=>res.json({data:d.transaction(()=>{
  readRotationOccurrence(d,req,req.params.id);
  const occurrence=overrideRotation(d,req.params.id,{member_ids:req.body.member_ids,expected_revision:req.body.expected_revision,actorId:actorId(req)});
  refreshRotationTaskRendering(d,occurrence.id);
  const track=getRotationTrack(d,occurrence.track_id),shared=track.consumer_type==='rotation_group_schedule';
  const result=shared?notifySharedRotationReconciliation(d,{groupId:track.group_id,occurrence,reason:'period_overridden'}):null;
  return {...projectRotationOccurrence(occurrence,track),...(shared?{reconciliation:reconciliationSummary(d,req,result)}:{})};
}).immediate()})));
router.post('/rotation-occurrences/:id/recheck',handle('override',(d,req,res)=>res.json({data:d.transaction(()=>{
  readRotationOccurrence(d,req,req.params.id);
  const occurrence=refreshRotationOccurrence(d,req.params.id,{expected_revision:req.body.expected_revision,actorId:actorId(req)});
  refreshRotationTaskRendering(d,occurrence.id);const track=getRotationTrack(d,occurrence.track_id);
  if(track.consumer_type==='rotation_group_schedule')notifySharedRotationReconciliation(d,{groupId:track.group_id,occurrence,reason:'eligibility_rechecked'});
  return projectRotationOccurrence(occurrence,track);
}).immediate()})));
export default router;
