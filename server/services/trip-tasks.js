import {createHash} from 'node:crypto';
import {setTaskAssignments} from './task-assignments.js';
import {setTaskLocation} from './task-locations.js';
import {recordTaskActivity,TaskStateError} from './task-lifecycle.js';
import {taskCapabilities} from './task-access.js';
import {availabilityInstantMs} from './presence.js';
import {householdTimeZone,utcToWall} from '../utils/timezone.js';

const PHASES={before_departure:['start',-1440],departure:['start',0],during_trip:['start',60],before_return:['end',-240],return_home:['end',0],post_trip:['end',720]};
const json=JSON.stringify;
function stable(value){return Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;}
export const tripRequestHash=body=>createHash('sha256').update(json(stable(body))).digest('hex');
export function replayTripRequest(d,body,actorId){
 if(!body.request_key)return null; // Older API clients remain compatible; the modern form always supplies a key.
 if(!/^[A-Za-z0-9_-]{8,128}$/.test(body.request_key))throw new TaskStateError('Use a valid Trip request key.',{},400);
 const prior=d.prepare('SELECT * FROM trip_task_requests WHERE actor_id=? AND request_key=?').get(actorId,body.request_key);
 if(!prior)return null;
 if(prior.input_hash!==tripRequestHash(body)||!prior.trip_id)throw new TaskStateError('This Trip request was already used with a different payload or deleted Trip.');
 return prior.trip_id;
}
export function rememberTripRequest(d,body,actorId,tripId){if(body.request_key)d.prepare('INSERT INTO trip_task_requests(actor_id,request_key,input_hash,trip_id) VALUES(?,?,?,?)').run(actorId,body.request_key,tripRequestHash(body),tripId);}

export function tripStepSchedule(d,trip,recipe){
 if(recipe.due_mode==='fixed')return {due_date:recipe.due_date||null,due_time:recipe.due_time||null};
 const [anchor,defaultOffset]=PHASES[recipe.phase],zone=householdTimeZone(d);
 const value=anchor==='start'?trip.starts_at:trip.ends_at;
 const wall=utcToWall(new Date(availabilityInstantMs(value,zone)).toISOString(),zone);
 const date=new Date(`${wall.date}T${wall.time}Z`);date.setUTCMinutes(date.getUTCMinutes()+(recipe.offset_minutes??defaultOffset));
 return {due_date:date.toISOString().slice(0,10),due_time:recipe.due_time||null};
}
function normalizeRecipe(d,item,defaultAssignee){
 if(!item||!PHASES[item.phase]||typeof item.title!=='string'||!item.title.trim()||item.title.trim().length>200)throw new TaskStateError('Choose a valid phase and step name.',{},400);
 const key=item.step_key||`compat-${createHash('sha256').update(`${item.phase}:${item.title.trim()}`).digest('hex').slice(0,24)}`;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw new TaskStateError('Choose a valid step identity.',{},400);
 const ids=item.assigned_user_ids??(item.assigned_to?[Number(item.assigned_to)]:[defaultAssignee]);
 if(!Array.isArray(ids)||ids.length>50||ids.some(id=>!Number.isSafeInteger(id)||!d.prepare('SELECT 1 FROM users WHERE id=?').get(id)))throw new TaskStateError('Choose valid step assignees.',{},400);
 if(item.due_mode&&!['phase','fixed'].includes(item.due_mode))throw new TaskStateError('Choose a valid step deadline mode.',{},400);
 if(item.due_date&&(!/^\d{4}-\d{2}-\d{2}$/.test(item.due_date)||new Date(`${item.due_date}T00:00:00Z`).toISOString().slice(0,10)!==item.due_date)||item.due_time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.due_time))throw new TaskStateError('Choose a valid step deadline.',{},400);
 if(!['none','low','medium','high','urgent'].includes(item.priority||'none'))throw new TaskStateError('Choose a valid step priority.',{},400);
 for(const field of ['offset_minutes','reminder_offset_minutes'])if(item[field]!=null&&(!Number.isSafeInteger(item[field])||Math.abs(item[field])>525600))throw new TaskStateError('Choose a valid step offset.',{},400);
 if(item.reminder_offset_minutes!=null&&item.reminder_offset_minutes<0)throw new TaskStateError('Reminder lead time cannot be negative.',{},400);
 if(item.place_id&&!d.prepare('SELECT 1 FROM places WHERE id=? AND active=1').get(item.place_id))throw new TaskStateError('Choose an active step Place.',{},400);
 return {...item,step_key:key,title:item.title.trim(),assigned_user_ids:[...new Set(ids)].sort((a,b)=>a-b),due_mode:item.due_mode||'phase',description:item.description||null,priority:item.priority||'none',is_optional:item.is_optional?1:0};
}
function desiredStep(d,trip,recipe){
 const placeId=['during_trip','before_return'].includes(recipe.phase)?trip.lodging_place_id||trip.destination_place_id:recipe.place_id;
 return {title:recipe.title,description:recipe.description,priority:recipe.priority,...tripStepSchedule(d,trip,recipe),assigned_user_ids:recipe.assigned_user_ids,is_optional:recipe.is_optional,location:placeId?{kind:'saved_place',placeId}:null};
}
function currentStep(d,t){
 const place=d.prepare('SELECT kind,place_id FROM task_locations WHERE task_id=?').get(t.id);
 return {title:t.title,description:t.description,priority:t.priority,due_date:t.due_date,due_time:t.due_time,is_optional:t.is_optional,assigned_user_ids:d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(t.id).map(r=>r.user_id),location:place?.kind==='saved_place'?{kind:'saved_place',placeId:place.place_id}:place?{kind:place.kind}:null};
}
export function retireTripTask(d,id,actorId,reason){
 const t=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!t||t.status==='done'||t.archived_at)return;
 d.prepare("UPDATE tasks SET archived_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?").run(id);
 d.prepare("UPDATE task_responsibilities SET status='cancelled' WHERE task_id=? AND status='active'").run(id);
 d.prepare("UPDATE planning_obligations SET status='cancelled' WHERE task_id=? AND status IN ('pending','accepted')").run(id);
 d.prepare("UPDATE task_assignment_context SET state='cancelled' WHERE task_id=? AND state!='fulfilled'").run(id);
 recordTaskActivity(d,id,'archived',actorId,{reason});
}
function syncReminders(d,trip,step,t,recipe){
 if(!t||['done','expired','skipped'].includes(t.status)||t.archived_at)return;
 const existing=d.prepare('SELECT m.*,r.remind_at,r.pushed_at,r.dismissed FROM trip_step_reminders m LEFT JOIN reminders r ON r.id=m.reminder_id WHERE m.trip_id=? AND m.step_key=?').all(trip.id,step.step_key);
 const recipients=new Set(recipe.reminder_offset_minutes==null?[]:d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(t.id).map(r=>r.user_id));
 for(const m of existing){
  if(!recipients.has(m.user_id)&&!m.pushed_at&&!m.dismissed&&m.reminder_id)d.prepare('UPDATE reminders SET dismissed=1 WHERE id=?').run(m.reminder_id);
 }
 if(!t.due_date||recipe.reminder_offset_minutes==null)return;
 const zone=householdTimeZone(d),at=availabilityInstantMs(`${t.due_date}T${t.due_time||'23:59:59'}`,zone)-recipe.reminder_offset_minutes*60000;
 const when=new Date(at).toISOString().replace(/Z$/,'');
 for(const userId of recipients){
  const saved=existing.find(m=>m.user_id===userId);
  if(saved){
   if(saved.pushed_at||saved.dismissed||!saved.reminder_id)continue;
   // Editing a personal reminder opts out of generated deadline movement.
   if(saved.generated_remind_at!=null&&saved.remind_at!==saved.generated_remind_at)continue;
   d.prepare('UPDATE reminders SET remind_at=?,dismissed=? WHERE id=?').run(when,at<=Date.now()?1:0,saved.reminder_id);
   d.prepare('UPDATE trip_step_reminders SET offset_minutes=?,generated_remind_at=? WHERE trip_id=? AND step_key=? AND user_id=?').run(recipe.reminder_offset_minutes,when,trip.id,step.step_key,userId);
  } else {
   const r=d.prepare("INSERT INTO reminders(entity_type,entity_id,remind_at,created_by,dismissed) VALUES('task',?,?,?,?)").run(t.id,when,userId,at<=Date.now()?1:0);
   d.prepare('INSERT INTO trip_step_reminders(trip_id,step_key,user_id,reminder_id,offset_minutes,generated_remind_at) VALUES(?,?,?,?,?,?)').run(trip.id,step.step_key,userId,Number(r.lastInsertRowid),recipe.reminder_offset_minutes,when);
  }
 }
}

export function createTripTaskGroup(d,trip,actorId,coordinatorId){
 const uid=coordinatorId||actorId;
 if(!d.prepare('SELECT 1 FROM users WHERE id=?').get(uid))throw new TaskStateError('Choose a valid Trip coordinator.',{},400);
 const parent=Number(d.prepare("INSERT INTO tasks(title,description,category,priority,status,created_by,assigned_to,points,visibility,is_recurring,expiration_policy) VALUES(?,?,'misc','none','open',?,?,0,'all',0,'keep_overdue')").run(`Trip: ${trip.name}`,trip.notes||null,actorId,uid).lastInsertRowid);
 setTaskAssignments(d,parent,[uid]);
 d.prepare('INSERT INTO trip_task_groups(trip_id,parent_task_id,coordinator_id) VALUES(?,?,?)').run(trip.id,parent,uid);
 recordTaskActivity(d,parent,'created',actorId,{source:'trip',trip_id:trip.id});
}
export function reconcileTripTasks(d,trip,body,actorId){
 const group=d.prepare('SELECT * FROM trip_task_groups WHERE trip_id=?').get(trip.id);if(!group)return;
 if(body.expected_revision!=null&&body.expected_revision!==group.revision)throw new TaskStateError('This Trip checklist changed. Reload before saving.',{reason:'stale_trip_revision'});
 const baseline=JSON.parse(group.generated_json);
 const definitionHash=tripRequestHash({name:trip.name,starts_at:trip.starts_at,ends_at:trip.ends_at,
  destination_place_id:trip.destination_place_id,lodging_place_id:trip.lodging_place_id,
  trip_type:trip.trip_type,status:trip.status,create_away_periods:trip.create_away_periods,notes:trip.notes,
  planning_context_id:trip.planning_context_id,calendar_event_id:trip.calendar_event_id,
  participant_ids:[...trip.participant_ids].sort((a,b)=>a-b),
  stages:d.prepare('SELECT phase,title,starts_at,place_id,notes,sort_order FROM trip_stages WHERE trip_id=? ORDER BY sort_order').all(trip.id)});
 const saveDefinitionOnly=()=>{if(baseline.definition_hash!==definitionHash)
  d.prepare('UPDATE trip_task_groups SET generated_json=?,revision=revision+1 WHERE trip_id=?').run(json({...baseline,definition_hash:definitionHash}),trip.id);};
 if(group.state==='deleted'||!group.parent_task_id){saveDefinitionOnly();return;}
 const prior=d.prepare('SELECT * FROM trip_task_steps WHERE trip_id=? ORDER BY rowid').all(trip.id);
 const parent=d.prepare('SELECT * FROM tasks WHERE id=?').get(group.parent_task_id);
 if(body.expected_parent_revision!=null&&body.expected_parent_revision!==parent.revision)throw new TaskStateError('This Trip Task changed. Reload before saving.',{reason:'stale_parent_revision'});
 const before=json(prior);
 if(trip.status==='cancelled'){
  if(group.state==='cancelled'){saveDefinitionOnly();return;}
  const remaining=d.prepare("SELECT id FROM tasks WHERE (id=? OR parent_task_id=?) AND archived_at IS NULL AND status NOT IN ('done','expired','skipped')").all(parent.id,parent.id).map(t=>t.id);
  for(const s of prior)if(s.state==='active'){retireTripTask(d,s.task_id,actorId,'Trip cancelled');d.prepare("UPDATE trip_task_steps SET state='cancelled' WHERE trip_id=? AND step_key=?").run(trip.id,s.step_key);}
  for(const id of remaining)retireTripTask(d,id,actorId,'Trip cancelled');
  d.prepare("UPDATE trip_task_groups SET state='cancelled',generated_json=?,revision=revision+1 WHERE trip_id=?").run(json({...baseline,definition_hash:definitionHash,cancelled_ids:remaining}),trip.id);return;
 }
 if(group.state==='cancelled'){
  if(body.restore_remaining!==true)throw new TaskStateError('Review and explicitly restore the remaining Trip steps before reactivating this Trip.',{reason:'trip_restore_required'});
  for(const id of JSON.parse(group.generated_json).cancelled_ids||[])d.prepare('UPDATE tasks SET archived_at=NULL WHERE id=?').run(id);
  d.prepare("UPDATE trip_task_steps SET state='active' WHERE trip_id=? AND state='cancelled'").run(trip.id);
  d.prepare("UPDATE trip_task_groups SET state='active' WHERE trip_id=?").run(trip.id);
  for(const s of prior)if(s.state==='cancelled')s.state='active';
 }
 const inaccessible=prior.filter(s=>s.state==='active'&&s.task_id&&!taskCapabilities(d,actorId,d.prepare('SELECT * FROM tasks WHERE id=?').get(s.task_id)).view);
 const recipes=Array.isArray(body.tasks)?body.tasks.map(r=>normalizeRecipe(d,r,trip.participant_ids[0]||actorId)):prior.filter(s=>s.state==='active').map(s=>JSON.parse(s.recipe_json));
 if(Array.isArray(body.tasks)){
  if(recipes.some(r=>inaccessible.some(s=>s.step_key===r.step_key)))throw new TaskStateError('You cannot edit a private Trip step.',{},403);
  recipes.push(...inaccessible.map(s=>JSON.parse(s.recipe_json)));
 }
 if(recipes.length>50||new Set(recipes.map(r=>r.step_key)).size!==recipes.length)throw new TaskStateError('Choose at most 50 uniquely identified Trip steps.',{},400);
 for(const s of prior.filter(s=>s.state==='active'&&!recipes.some(r=>r.step_key===s.step_key))){retireTripTask(d,s.task_id,actorId,'Trip step removed');d.prepare("UPDATE trip_task_steps SET state='removed' WHERE trip_id=? AND step_key=?").run(trip.id,s.step_key);}
 for(const [order,recipe] of recipes.entries()){
  let s=prior.find(r=>r.step_key===recipe.step_key),t=s?.task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(s.task_id):null;
  if(s&&s.state!=='active')continue; // tombstones never resurrect through another save
  const desired=desiredStep(d,trip,recipe);
  if(t&&(['done','expired','skipped'].includes(t.status)||t.archived_at))continue;
  if(!s){
   if(parent.status==='done')throw new TaskStateError('Reopen the completed Trip checklist before adding steps.');
   const id=Number(d.prepare("INSERT INTO tasks(title,description,category,priority,status,created_by,parent_task_id,points,visibility,is_recurring,expiration_policy) VALUES(?,?,'misc',?,'open',?,?,0,'all',0,'keep_overdue')").run(recipe.title,recipe.description,recipe.priority,actorId,parent.id).lastInsertRowid);
   d.prepare('INSERT INTO trip_task_steps(trip_id,step_key,task_id,phase,recipe_json) VALUES(?,?,?,?,?)').run(trip.id,recipe.step_key,id,recipe.phase,json(recipe));
   d.prepare('INSERT INTO trip_tasks(trip_id,task_id,phase) VALUES(?,?,?)').run(trip.id,id,recipe.phase);
   s={trip_id:trip.id,step_key:recipe.step_key,task_id:id,generated_json:'{}',overrides_json:'[]'};t=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  }
  const current=currentStep(d,t),old=JSON.parse(s.generated_json),overrides=new Set(JSON.parse(s.overrides_json));
  for(const key of Object.keys(old))if(json(current[key])!==json(old[key]))overrides.add(key);
  const previousRecipe=JSON.parse(s.recipe_json||'{}');
  for(const key of ['title','description','priority','assigned_user_ids','is_optional'])if(json(recipe[key])!==json(previousRecipe[key]))overrides.delete(key);
  if(['due_mode','due_date','due_time','phase','offset_minutes'].some(key=>json(recipe[key])!==json(previousRecipe[key]))){overrides.delete('due_date');overrides.delete('due_time');}
  const next={...current};for(const [key,value] of Object.entries(desired))if(!overrides.has(key))next[key]=value;
  if(json(current)!==json(next)||t.sort_order!==order)
   d.prepare('UPDATE tasks SET title=?,description=?,priority=?,due_date=?,due_time=?,assigned_to=?,is_optional=?,sort_order=? WHERE id=?').run(next.title,next.description,next.priority,next.due_date,next.due_time,next.assigned_user_ids[0]??null,next.is_optional,order,t.id);
  if(json(current.assigned_user_ids)!==json(next.assigned_user_ids)||group.state==='cancelled')setTaskAssignments(d,t.id,next.assigned_user_ids);
  if(!overrides.has('location')&&json(current.location)!==json(next.location))setTaskLocation(d,t.id,next.location,actorId);
  syncReminders(d,trip,s,d.prepare('SELECT * FROM tasks WHERE id=?').get(t.id),recipe);
  d.prepare('UPDATE trip_task_steps SET phase=?,recipe_json=?,generated_json=?,overrides_json=? WHERE trip_id=? AND step_key=?').run(recipe.phase,json(recipe),json(next),json([...overrides]),trip.id,recipe.step_key);
  d.prepare('UPDATE trip_tasks SET phase=? WHERE trip_id=? AND task_id=?').run(recipe.phase,trip.id,t.id);
 }
 // A shared parent deadline must not encode a private child's fixed date.
 // The saved envelope follows the Trip; operational deadlines stay on children.
 const latest=tripStepSchedule(d,trip,{phase:'post_trip'}).due_date;
 const title=baseline.title==null||parent.title===baseline.title?`Trip: ${trip.name}`:parent.title;
 const due=baseline.due_date===undefined||parent.due_date===baseline.due_date?latest||null:parent.due_date;
 const description=baseline.description===undefined||parent.description===baseline.description?trip.notes||null:parent.description;
 if(parent.title!==title||parent.due_date!==due||parent.description!==description)d.prepare('UPDATE tasks SET title=?,description=?,due_date=? WHERE id=?').run(title,description,due,parent.id);
 const generated=json({title:`Trip: ${trip.name}`,description:trip.notes||null,due_date:latest||null,starts_at:trip.starts_at,ends_at:trip.ends_at,status:trip.status,definition_hash:definitionHash});
 const changed=before!==json(d.prepare('SELECT * FROM trip_task_steps WHERE trip_id=? ORDER BY rowid').all(trip.id))||generated!==group.generated_json||body.coordinator_id!=null&&body.coordinator_id!==group.coordinator_id;
 if(body.coordinator_id!=null&&body.coordinator_id!==group.coordinator_id){
  if(!d.prepare('SELECT 1 FROM users WHERE id=?').get(body.coordinator_id))throw new TaskStateError('Choose a valid Trip coordinator.',{},400);
  d.prepare('UPDATE tasks SET assigned_to=? WHERE id=?').run(body.coordinator_id,parent.id);setTaskAssignments(d,parent.id,[body.coordinator_id]);
 }
 if(changed)d.prepare('UPDATE trip_task_groups SET generated_json=?,coordinator_id=COALESCE(?,coordinator_id),revision=revision+1 WHERE trip_id=?').run(generated,body.coordinator_id??null,trip.id);
}
export function tripTaskGroup(d,tripId){
 const g=d.prepare('SELECT * FROM trip_task_groups WHERE trip_id=?').get(tripId);
 if(!g)return {parent_task:null,task_group_revision:null,task_structure:'legacy'};
 return {parent_task:g.parent_task_id?d.prepare('SELECT * FROM tasks WHERE id=?').get(g.parent_task_id):null,coordinator_id:g.coordinator_id,task_group_revision:g.revision,task_structure:'grouped',task_group_state:g.state};
}

/** Personal edits use the same reminder reconciliation without rebuilding the checklist. */
export function refreshTripStepReminders(d,id){
 const s=d.prepare('SELECT * FROM trip_task_steps WHERE task_id=?').get(id);if(!s||s.state!=='active')return;
 const trip=d.prepare("SELECT t.* FROM trip_plans t JOIN trip_task_groups g ON g.trip_id=t.id WHERE t.id=? AND g.state='active'").get(s.trip_id);
 if(trip)syncReminders(d,trip,s,d.prepare('SELECT * FROM tasks WHERE id=?').get(id),JSON.parse(s.recipe_json));
}

export function retireDeletedTrip(d,tripId,actorId){
 const group=d.prepare('SELECT * FROM trip_task_groups WHERE trip_id=?').get(tripId);if(!group?.parent_task_id)return;
 for(const t of d.prepare('SELECT id FROM tasks WHERE id=? OR parent_task_id=?').all(group.parent_task_id,group.parent_task_id)){
  retireTripTask(d,t.id,actorId,'Trip deleted');
  d.prepare("INSERT OR IGNORE INTO retired_trip_tasks(task_id,reason) VALUES(?,'Trip deleted')").run(t.id);
 }
}
