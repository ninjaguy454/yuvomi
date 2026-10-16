import {createHash} from 'node:crypto';
import {actorId,assertCapability,PermissionError} from '../permissions.js';
import {assertTaskMutation,taskCapabilities,taskDevicePrincipal} from './task-access.js';
import {resolveActivityTemplate} from './activity-workflows.js';
import {previewTaskActivityBinding} from './task-activity-bindings.js';
import {captureActivityTemplateDefinition} from './task-activity-snapshot.js';
import {categoryAssigneePolicy,assertAssigneeCount} from './task-assignee-policy.js';
import {resolveActivitySchedule} from './activity-schedule.js';
import {todayKey} from '../utils/timezone.js';

export class TemplateLaunchError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
const positive=id=>typeof id==='number'&&Number.isSafeInteger(id)&&id>0;
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function parse(body,{create=false}={}){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new TemplateLaunchError('Choose an Activity Template and people.');
  const allowed=new Set(['activity_template_id','recipient_user_ids','primary_user_id','mode','inputs','start_date',...(create?['request_key']:[])]);
  if(Object.keys(body).some(key=>!allowed.has(key)))throw new TemplateLaunchError('Unsupported template launch setting.');
  if(!positive(body.activity_template_id)||!['individual','shared'].includes(body.mode))throw new TemplateLaunchError('Choose a valid Activity Template and creation mode.');
  const ids=body.recipient_user_ids;
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||ids.some(id=>!positive(id))||new Set(ids).size!==ids.length)throw new TemplateLaunchError('Choose 1 to 100 distinct household members.');
  if(body.mode==='shared'&&(!positive(body.primary_user_id)||!ids.includes(body.primary_user_id)))throw new TemplateLaunchError('Choose a primary person from the selected people.');
  if(body.mode==='individual'&&body.primary_user_id!=null)throw new TemplateLaunchError('Each individual Activity has its own primary person.');
  if(body.inputs!=null&&(typeof body.inputs!=='object'||Array.isArray(body.inputs)))throw new TemplateLaunchError('Template inputs must be an object.');
  if(body.start_date!=null&&(typeof body.start_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)||Number.isNaN(Date.parse(body.start_date+'T00:00:00Z'))||new Date(body.start_date+'T00:00:00Z').toISOString().slice(0,10)!==body.start_date))throw new TemplateLaunchError('Choose a valid Start Date.');
  if(create&&(typeof body.request_key!=='string'||!body.request_key.trim()||body.request_key.length>128||/[^\x20-\x7e]/.test(body.request_key)))throw new TemplateLaunchError('A printable request key of 1 to 128 characters is required.');
  return {activity_template_id:body.activity_template_id,mode:body.mode,recipient_user_ids:[...ids].sort((a,b)=>a-b),primary_user_id:body.mode==='shared'?body.primary_user_id:null,inputs:body.inputs??{},start_date:body.start_date??null};
}
function authorize(d,actor){
  if(taskDevicePrincipal(actor)||!actorId(actor))throw new PermissionError('Use your signed-in personal view to create Activities for people.');
  assertCapability(d,actor,'tasks.create');assertCapability(d,actor,'activities.view');
  // Selecting people is an explicit assignment operation, even when a saved
  // template happens to resolve to one of the same people.
  assertCapability(d,actor,'tasks.change_assignment');
}
function plan(d,actor,request){
  const template=d.prepare('SELECT * FROM activity_templates WHERE id=? AND active=1').get(request.activity_template_id);
  if(!template)throw new TemplateLaunchError('That Activity Template is unavailable.');
  const policy=categoryAssigneePolicy(d,template.category),individual=policy.max_assignees===1;
  if(request.mode!==(individual?'individual':'shared'))throw new TemplateLaunchError('The category changed. Preview the Activity again with its current assignee limit.');
  const people=request.recipient_user_ids;
  for(const id of people)if(!d.prepare('SELECT 1 FROM users WHERE id=?').get(id))throw new TemplateLaunchError('A selected household member is unavailable.');
  if(!individual)assertAssigneeCount(policy,people);
  const selections=individual?people.map(id=>[id]):[[request.primary_user_id,...people.filter(id=>id!==request.primary_user_id)]];
  const activities=selections.map(ids=>{
    const primary=ids[0],override=template.allow_assignment_override?primary:null;
    const body={activity_template_id:template.id,activity_subject_user_id:primary,activity_inputs:request.inputs,...(request.start_date?{start_date:request.start_date}:{}),...(override?{assigned_to:[primary]}:{})};
    const draft=resolveActivityTemplate(d,template.id,{inputs:request.inputs,subjectUserId:primary,assignmentOverrideUserId:override,actorId:actorId(actor),task:body});
    const schedule=resolveActivitySchedule(template,body);
    let snapshot=null;
    if(!individual&&ids.length>1){
      if(!template.allow_assignment_override)throw new TemplateLaunchError('This Activity Template does not allow choosing co-assignees.');
      snapshot={...captureActivityTemplateDefinition(d,template.id),assignment_strategy:'fixed',assignment_policy:'fixed',fixed_user_id:primary,fixed_assignee_ids:ids,assignee_policy:policy};
    }
    const preview=previewTaskActivityBinding(d,{activityTemplateId:template.id,subjectUserId:primary,assignmentOverrideUserId:override,task:{...body,...schedule},dateKey:schedule.due_date||todayKey(d),activitySnapshot:snapshot});
    const actual=(preview.resolution.participants?.length?preview.resolution.participants:preview.resolution.primary?[preview.resolution.primary]:[]).map(row=>Number(row.id));
    if(actual.length!==ids.length||ids.some(id=>!actual.includes(id)))throw new TemplateLaunchError('This Activity Template cannot assign the selected people. Choose an allowed assignee or enable assignment override on the template.');
    assertTaskMutation(d,actor,null,{...body,assigned_to:ids,expiration_policy:template.expiration_policy},{operation:'create'});
    return {body,snapshot,recipient_user_ids:ids,primary_user_id:primary,title:draft.data.title,description:draft.data.description,checklist:draft.data.checklist,points:template.points,scoring_mode:template.scoring_mode,...schedule,is_recurring:!!template.recurrence_rule};
  });
  return {mode:request.mode,task_count:activities.length,assignee_policy:policy,activities};
}
export function previewTemplateLaunch(d,actor,body){authorize(d,actor);const result=plan(d,actor,parse(body));return {...result,activities:result.activities.map(({body,snapshot,...row})=>row)};}

/** The canonical creator, notifications and receipt share one SQLite transaction.
 * Only live authorized IDs are retained: no stale serialized Task response cache. */
export function createTemplateLaunch(d,actor,body,{createTask,hydrateTask}){
  authorize(d,actor);const request=parse(body,{create:true}),principal=`user:${actorId(actor)}`,key=body.request_key;
  const hash=createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
  return d.transaction(()=>{
    const saved=d.prepare('SELECT * FROM task_template_launch_requests WHERE principal_key=? AND request_key=?').get(principal,key);
    if(saved){
      if(saved.request_hash!==hash)throw new TemplateLaunchError('This request key already belongs to a different Activity launch.',409);
      const rows=d.prepare('SELECT task_id FROM task_template_launch_results WHERE request_id=? ORDER BY position').all(saved.id);
      const tasks=rows.map(row=>{
        const task=row.task_id&&d.prepare('SELECT * FROM tasks WHERE id=?').get(row.task_id);
        if(!task)throw new TemplateLaunchError('An Activity from this launch was deleted. It will not be recreated by retrying.',410);
        if(!taskCapabilities(d,actor,task).view)throw new PermissionError('A Task from this launch is no longer visible.',403);
        return hydrateTask(task);
      });
      return {replayed:true,tasks};
    }
    const resolved=plan(d,actor,request);
    const receipt=Number(d.prepare('INSERT INTO task_template_launch_requests(principal_key,request_key,request_hash,activity_template_id,mode) VALUES(?,?,?,?,?)').run(principal,key,hash,request.activity_template_id,request.mode).lastInsertRowid);
    const tasks=resolved.activities.map((activity,position)=>{
      const task=createTask(activity.body,activity.snapshot);
      d.prepare('INSERT INTO task_template_launch_results(request_id,position,task_id) VALUES(?,?,?)').run(receipt,position,task.id);
      return task;
    });
    return {replayed:false,tasks};
  }).immediate();
}
