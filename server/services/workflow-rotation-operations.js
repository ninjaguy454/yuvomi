/** Authored, explicit run actions reuse the existing Workflow and Rotation
 * lifecycle. They neither execute arbitrary code nor create another scheduler. */
import { assertCapability, hasCapability } from '../permissions.js';
import { assertTaskMutation, taskCapabilities } from './task-access.js';
import { assertTaskRevision } from './task-lifecycle.js';
import { parseRotationBindings, bindTaskRotations, taskRotationContexts } from './task-rotation.js';
import { finalizeRotation, getRotationTrack } from './rotation.js';
import { sharedGroupConfiguration } from './rotation-shared.js';
import { refreshTaskRotationRendering } from './task-rotation-rendering.js';

export function normalizeWorkflowRotationOperations(values=['resolve']) {
  if(!Array.isArray(values)||values.some(value=>!['resolve','finalize','skip'].includes(value)))
    throw Object.assign(new Error('Choose valid Workflow Rotation operations.'),{status:400});
  return ['resolve',...['finalize','skip'].filter(value=>values.includes(value))];
}

function authoredOperations(d,instance,task) {
  const request=d.prepare('SELECT response_json FROM rotation_workflow_requests WHERE workflow_instance_id=?').get(instance.id);
  const saved=JSON.parse(request?.response_json||'{}');
  return (saved.result??saved).rotation_operations??parseRotationBindings(task.rotation_bindings_json)
    .map(binding=>({purpose_key:binding.purpose_key,label:binding.label,operations:binding.workflow_operations||['resolve']}));
}

export function workflowRotationOperations(d,task,actor) {
  if(!hasCapability(d,actor,'workflows.view')||!hasCapability(d,actor,'rotations.view')||!taskCapabilities(d,actor,task).view)return null;
  const instance=d.prepare('SELECT id FROM workflow_instances WHERE parent_task_id=?').get(task.id);
  if(!instance)return null;
  const editable=taskCapabilities(d,actor,task).complete&&hasCapability(d,actor,'workflows.run')&&!task.archived_at&&!['done','expired'].includes(task.status);
  const configuration=parseRotationBindings(task.rotation_bindings_json);
  return {instance_id:instance.id,purposes:authoredOperations(d,instance,task).map(binding=>{
    const configured=configuration.find(value=>value.purpose_key===binding.purpose_key);
    const shared=configured&&sharedGroupConfiguration(d,configured.group_id,task.start_date||task.due_date);
    return {...binding,shared:!!shared,operations:normalizeWorkflowRotationOperations(binding.operations).filter(operation=>
      (!shared||operation==='resolve')&&editable&&hasCapability(d,actor,operation==='resolve'?'rotations.configure':'rotations.advance'))};
  })};
}

export function executeWorkflowRotationOperation(d,instanceId,purpose,operation,{actor,actorId,expectedTaskRevision,expectedOccurrenceRevision}={}) {
  assertCapability(d,actor,'workflows.view');assertCapability(d,actor,'workflows.run');assertCapability(d,actor,'rotations.view');
  assertCapability(d,actor,operation==='resolve'?'rotations.configure':'rotations.advance');
  return d.transaction(()=>{
    const instance=d.prepare('SELECT * FROM workflow_instances WHERE id=?').get(instanceId);
    const task=instance&&d.prepare('SELECT * FROM tasks WHERE id=?').get(instance.parent_task_id);
    if(!task||!taskCapabilities(d,actor,task).view)throw Object.assign(new Error('Workflow occurrence not found.'),{status:404});
    assertTaskMutation(d,actor,task,{}, {operation:'status'});
    if(task.archived_at||['done','expired'].includes(task.status))throw Object.assign(new Error('This historical Workflow occurrence is preserved.'),{status:409});
    const binding=authoredOperations(d,instance,task).find(value=>value.purpose_key===purpose);
    if(!binding||!normalizeWorkflowRotationOperations(binding.operations).includes(operation))
      throw Object.assign(new Error('This operation is not configured for this Workflow occurrence.'),{status:400});
    const context=taskRotationContexts(d,task).find(value=>value.purpose_key===purpose&&value.owner_task_id===task.id);
    const configured=parseRotationBindings(task.rotation_bindings_json).find(value=>value.purpose_key===purpose);
    if(operation!=='resolve'&&((configured&&sharedGroupConfiguration(d,configured.group_id,task.start_date||task.due_date))
      ||(context?.occurrence.track_id&&getRotationTrack(d,context.occurrence.track_id)?.consumer_type==='rotation_group_schedule')))
      throw Object.assign(new Error('This shared rotation follows the Group schedule. Manage this evening in Rotation Groups.'),{status:409,code:'rotation_shared_consumer_operation'});
    // Resolve/reuse is a read once this logical request owns a snapshot. A retry
    // must not write rendering provenance or require the pre-resolution revision.
    if(operation==='resolve'&&context?.occurrence.id)return taskRotationContexts(d,task,actorId);
    assertTaskRevision(d,task,{expected_revision:expectedTaskRevision},{required:true});
    if(operation==='resolve') {
      const request=d.prepare('SELECT * FROM rotation_workflow_requests WHERE workflow_instance_id=?').get(instance.id);
      if(!request)throw Object.assign(new Error('This Workflow occurrence has no stable Rotation request identity.'),{status:409});
      bindTaskRotations(d,task.id,{actorId,onlyMissing:true,config:parseRotationBindings(task.rotation_bindings_json).filter(value=>value.purpose_key===purpose),consumer:{consumer_type:'workflow',consumer_id:String(instance.workflow_template_id)},
        occurrenceKey:`workflow-request:${request.actor_user_id}:${request.request_key}`});
      refreshTaskRotationRendering(d,task.id);
    } else {
      if(!context?.occurrence.id)throw Object.assign(new Error('Resolve this Rotation occurrence first.'),{status:409});
      finalizeRotation(d,context.occurrence.id,{actorId,outcome:operation==='skip'?'skipped':'finalized',expectedRevision:expectedOccurrenceRevision,manual:true});
    }
    return taskRotationContexts(d,task,actorId);
  }).immediate();
}
