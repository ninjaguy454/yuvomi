/** Opt-in device definition edits reuse the existing Task writer and validation. */
import {createTaskDefinition,updateTaskDefinition} from '../routes/tasks.js';
import {deviceTaskDetail} from './device-tasks.js';
import {deviceTaskVisible,assertTaskMutation} from './task-access.js';
import {assertTaskRevision} from './task-lifecycle.js';

const fields=new Set(['title','description','assigned_to','start_date','start_time','due_date','due_time','points',
  'is_recurring','recurrence_rule','recurrence_from_completion','expiration_policy','expected_revision','expected_parent_revision']);
const fail=(message,status=403)=>{throw Object.assign(new Error(message),{status,code:status});};
const ids=value=>[...new Set((Array.isArray(value)?value:value==null?[]:[value]).map(Number))].sort((a,b)=>a-b);
function validateRequest(d,principal,body,task) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!fields.has(key)))
    fail('This display supports plain Task text, assignments, dates and points. Use personal access for templates, Workflows, skills or structural checklist changes.');
  if(principal.kind!=='device'||principal.status!=='active'||!['read','write'].includes(principal.permissions?.modules?.tasks))fail('This device cannot change Tasks.');
  if(principal.permissions?.capabilities?.['tasks.view_household']!=='allow')fail('This device cannot change Tasks.');
  if(task) {
    const rows=d.prepare(`WITH RECURSIVE scope(id) AS (SELECT ? UNION SELECT t.id FROM tasks t JOIN scope s ON t.parent_task_id=s.id)
      SELECT t.* FROM tasks t JOIN scope s ON s.id=t.id WHERE t.archived_at IS NULL`).all(task.id);
    if(rows.some(row=>!deviceTaskVisible(d,principal,row)))fail('Use personal access to edit a Task containing work outside this display’s scope.');
    if(d.prepare('SELECT 1 FROM task_supervision_actions WHERE counterpart_task_id=? UNION ALL SELECT 1 FROM task_activity_support_tasks WHERE task_id=?').get(task.id,task.id))
      fail('Generated helper Tasks must be edited through their original Activity from personal access.');
  }
  assertTaskMutation(d,principal,task,body,{operation:task?'update':'create'});
}
function validateEffective(d,principal,body,task,effective) {
  const assigned=ids(effective.assigned_to),scope=principal.scope?.member_ids||[];
  if(scope.length && (!assigned.length || assigned.some(id=>!scope.includes(id))))fail('Choose only members permitted on this display.');
  if(assigned.some(id=>!Number.isSafeInteger(id)||!d.prepare(`SELECT 1 FROM users u WHERE u.id=?
    AND NOT EXISTS(SELECT 1 FROM housekeeping_workers w WHERE w.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)`).get(id)))fail('Choose valid household members.',400);
  if(body.assigned_to!==undefined && JSON.stringify(ids(body.assigned_to))!==JSON.stringify(assigned))
    fail('This Activity controls its assignment. Use personal access to change its assignment policy.');
  // Check the actual point value after household defaults/template resolution.
  // Omitting points cannot manufacture rewarded work without explicit permission.
  assertTaskMutation(d,principal,task,{...body,...effective},{operation:task?'update':'create'});
}
function execute(d,principal,body,id=null) {
  return d.transaction(()=>{
    const task=id==null?null:d.prepare('SELECT * FROM tasks WHERE id=?').get(Number(id));
    if(id!=null&&!task)fail('Task not found.',404);
    validateRequest(d,principal,body,task);
    if(task)assertTaskRevision(d,task,body,{required:true,requireParent:true});
    let response,status=200;
    const req={body:structuredClone(body),params:{id:String(id)},authUserId:null,authRole:null,session:{userId:null},devicePrincipal:principal,
      validateDeviceDefinition:effective=>validateEffective(d,principal,body,task,effective),
      projectDeviceTask:row=>deviceTaskDetail(d,principal,row.id)};
    const res={status(value){status=value;return this;},json(value){response=value;return this;}};
    (task?updateTaskDefinition:createTaskDefinition)(req,res);
    if(status>=400||!response?.data)fail(response?.error||'The Task could not be saved.',status>=400?status:500);
    const result=response.data;
    if(!deviceTaskVisible(d,principal,result))fail('The changed Task would leave this display’s permitted scope.');
    if(!task) {
      d.prepare('UPDATE tasks SET source_device_id=?,source_device_name=? WHERE id=?').run(principal.id,principal.name,result.id);
      for(const event of d.prepare("SELECT id,details_json FROM task_activity_events WHERE action_task_id=? AND event_type='created'").all(result.id)) {
        const details={...JSON.parse(event.details_json),source_device:{id:principal.id,name:principal.name}};
        d.prepare('UPDATE task_activity_events SET details_json=? WHERE id=? AND actor_user_id IS NULL').run(JSON.stringify(details),event.id);
      }
    }
    return result;
  }).immediate();
}
export const deviceTaskCreate=(d,principal,body)=>execute(d,principal,body);
export const deviceTaskUpdate=(d,principal,id,body)=>execute(d,principal,body,id);
