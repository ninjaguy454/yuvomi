/** Shared-display configuration and explicit, deliberately small public projections. */
import crypto from 'node:crypto';
import { resolvePermissions } from '../permissions.js';
import { taskCapabilities, taskVisibilityWhere } from './task-access.js';
import { getUpcomingEvents } from './calendar-events.js';
import { taskScopeWhere, taskStartProjection } from './task-scope.js';
import { todayKey, householdTimeZone } from '../utils/timezone.js';
import { evaluateAvailability, isPlaceWithin } from './presence.js';
import { listNotificationInbox } from './notification-inbox.js';

const KEY = 'wall_dashboard_v1';
export const WALL_WIDGETS = ['calendar','tasks','meals','shopping','presence','points','rewards','notes','weather'];
export const WALL_ACTIONS = ['task_complete','task_claim','reward_redeem'];
export const WALL_DEFAULTS = Object.freeze({
  widgets: WALL_WIDGETS.map((id,order) => ({id,visible:['calendar','tasks','meals','shopping','weather'].includes(id),size:id==='tasks'?'large':'medium',order})),
  appearance:{theme:'system',palette:'warm',font:'default',density:'comfortable',clock:true},
  interaction:{mode:'read_only',actions:[]},
  privacy:{notifications:'hidden',showPoints:false,showPresence:false},
});
export function wallError(message,status=400,reason=null) {return Object.assign(new Error(message),{status,reason});}
const choice=(value,valid,fallback) => value===undefined?fallback:valid.includes(value)?value:(()=>{throw wallError('Choose a supported Wall setting.');})();
const bool=(value,fallback) => value===undefined?fallback:typeof value==='boolean'?value:(()=>{throw wallError('Wall visibility settings must be true or false.');})();
export function normalizeWallConfig(input={}) {
  if(!input || typeof input!=='object' || Array.isArray(input))throw wallError('Invalid Wall configuration.');
  const a=input.appearance||{},i=input.interaction||{},p=input.privacy||{};
  const supplied=input.widgets??WALL_DEFAULTS.widgets;
  if(!Array.isArray(supplied)||supplied.length>WALL_WIDGETS.length)throw wallError('Invalid Wall widgets.');
  const seen=new Set();
  const widgets=supplied.map((row,index)=>{
    if(!row||!WALL_WIDGETS.includes(row.id)||seen.has(row.id))throw wallError('Unknown or duplicate Wall widget.');
    seen.add(row.id);
    return {id:row.id,visible:bool(row.visible,true),size:choice(row.size,['small','medium','large'],'medium'),order:Number.isSafeInteger(row.order)?row.order:index};
  }).sort((l,r)=>l.order-r.order);
  for(const row of WALL_DEFAULTS.widgets)if(!seen.has(row.id))widgets.push({...row,visible:false});
  widgets.forEach((row,index)=>row.order=index);
  const actions=i.actions??[];
  if(!Array.isArray(actions)||actions.some(action=>!WALL_ACTIONS.includes(action)))throw wallError('Unsupported Wall action.');
  return {widgets,
    appearance:{theme:choice(a.theme,['light','dark','system'],'system'),palette:choice(a.palette,['warm','neutral','cool'],'warm'),font:choice(a.font,['default','serif'],'default'),density:choice(a.density,['comfortable','compact'],'comfortable'),clock:bool(a.clock,true)},
    interaction:{mode:choice(i.mode,['read_only','interactive'],'read_only'),actions:[...new Set(actions)]},
    privacy:{notifications:choice(p.notifications,['hidden','generic','count'],'hidden'),showPoints:bool(p.showPoints,false),showPresence:bool(p.showPresence,false)}};
}
export function wallConfig(d) {
  try {const row=d.prepare('SELECT value FROM sync_config WHERE key=?').get(KEY);return normalizeWallConfig(row?JSON.parse(row.value):WALL_DEFAULTS);}
  catch {return structuredClone(WALL_DEFAULTS);}
}
export function saveWallConfig(d,input) {
  const config=normalizeWallConfig(input);
  d.prepare(`INSERT INTO sync_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(KEY,JSON.stringify(config));
  return config;
}
export function householdMember(d,id) {
  return d.prepare(`SELECT u.* FROM users u WHERE u.id=?
    AND NOT EXISTS(SELECT 1 FROM housekeeping_workers w WHERE w.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id)`).get(Number(id)||0);
}
export function wallPermissions(d,id) {
  const user=householdMember(d,id);
  if(!user)throw wallError('A household member session is required.',403);
  return resolvePermissions(d,user);
}
export function wallModuleAllowed(d,id,module,write=false) {
  const p=wallPermissions(d,id);
  const disabled=d.prepare("SELECT value FROM sync_config WHERE key='disabled_modules'").get();
  let hidden=[];try{hidden=JSON.parse(disabled?.value||'[]');}catch{}
  return !hidden.includes(module) && p.modules[module]!=='none' && (!write||p.modules[module]==='write');
}
export function assertWallModule(d,hostId,module,actorId=null,write=false) {
  if(!wallModuleAllowed(d,hostId,module,write)||(actorId&&!wallModuleAllowed(d,actorId,module,write)))throw wallError('This module is not available on this Wall.',403);
}
export function wallTaskVisible(d,id,hostId,actorId=null) {
  const row=d.prepare(`SELECT t.* FROM tasks t WHERE t.id=@id AND t.archived_at IS NULL
    AND ${taskVisibilityWhere(d,hostId,'t','@me')}
    AND ${taskVisibilityWhere(d,null,'t','0')}
    AND NOT EXISTS(WITH RECURSIVE parents(id,parent_task_id,visibility) AS (
      SELECT id,parent_task_id,visibility FROM tasks WHERE id=t.parent_task_id
      UNION SELECT p.id,p.parent_task_id,p.visibility FROM tasks p JOIN parents a ON p.id=a.parent_task_id
    ) SELECT 1 FROM parents WHERE visibility!='all')`).get({id:Number(id)||0,me:Number(hostId)});
  return row&&(!actorId||taskCapabilities(d,actorId,row).view)?row:null;
}
export const publicMember = row => ({id:row.id,display_name:row.display_name,avatar_color:row.avatar_color});
const taskKeys=['id','title','description','status','priority','points','due_date','due_time','start_date','start_time','revision','parent_revision','parent_task_id','assigned_to','assigned_name','subtask_total','subtask_done','waiting_on_helper','is_delegated_action','is_supervision_projection'];
const pick=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
/** Hydrate through the Tasks reader, then expose only shared operational fields. */
export function publicTaskProjection(d,task,hostId,actorId=null) {
  const out=pick(task,taskKeys);
  out.assigned_users=(task.assigned_users||[]).map(publicMember);
  out.tags=task.tags||[];
  out.subtasks=(task.subtasks||[]).filter(row=>wallTaskVisible(d,row.id,hostId,actorId)).map(row=>publicTaskProjection(d,row,hostId,actorId));
  const authority=actorId?taskCapabilities(d,actorId,task):null;
  out.permissions={complete:!!authority?.complete,claim:!!authority?.claim};
  const action=task.supervision_action;
  if(action&&action.can_complete===false)out.permissions.complete=false;
  if(action)out.supervision_action=pick(action,['action_task_id','counterpart_task_id','source_task_id','supervisor_user_id','execution_mode','state','completed']);
  const skillRows=d.prepare('SELECT s.id,s.name FROM task_skill_requirements r JOIN skills s ON s.id=r.skill_id WHERE r.task_id=? ORDER BY r.sort_order').all(task.id);
  out.required_skills=skillRows.length?skillRows:(action?.required_skills||[]).map(skill=>pick(skill,['id','name']));
  if(task.supervision) {
    const actions=(task.supervision.actions||[]).filter(a=>wallTaskVisible(d,a.action_task_id,hostId,actorId));
    out.supervision={state:task.supervision.state,supervisor_user_id:task.supervision.supervisor_user_id,
      supervisor_name:task.supervision.supervisor_name,
      actions:actions.map(a=>({...pick(a,['action_task_id','counterpart_task_id','supervisor_user_id','execution_mode','state','completed']),
        required_skills:(a.required_skills||[]).map(s=>pick(s,['id','name']))}))};
    // Build concise explanations from this visible action only. Canonical scope
    // explanations can mention another independently private sibling requirement.
    const name=action?.supervisor_user_id?d.prepare('SELECT display_name FROM users WHERE id=?').get(action.supervisor_user_id)?.display_name:null;
    out.supervision.explanation=action&&action.state!=='not_required'
      ? action.execution_mode==='delegated'
        ? `${name||'A qualified helper'} performs this step for the learner.${action.state==='unresolved'?' A single eligible helper is still needed.':''}`
        : `${name?`Complete this step with ${name}`:'This step requires a qualified supervisor'}.${action.state==='unresolved'?' A single eligible supervisor is still needed.':''}`
      : task.supervision.state==='needed'?'A single qualified helper is still needed for the remaining helper work.'
        : task.supervision.supervisor_name?`${task.supervision.supervisor_name} covers the remaining helper work.`:null;
  }
  return out;
}
export function publicCalendarEvent(row) {return pick(row,['id','title','description','start_datetime','end_datetime','all_day','location','color']);}
export function wallCalendarVisible(d,id) {
  return d.prepare(`SELECT e.* FROM calendar_events e WHERE e.id=? AND e.visibility='all'
    AND (e.external_source!='ics' OR EXISTS(SELECT 1 FROM ics_subscriptions s WHERE s.id=e.subscription_id AND s.shared=1))`).get(Number(id)||0);
}
export function wallMeal(d,id) {
  return d.prepare("SELECT id,title,date,meal_type,notes,selection_status,scheduled_time FROM meals WHERE id=? AND scope='household' AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND selection_status='selected'").get(Number(id)||0);
}
export function wallShopping(d,id) {
  const row=d.prepare('SELECT id,name FROM shopping_lists WHERE id=?').get(Number(id)||0);
  return row?{...row,items:d.prepare('SELECT id,name,quantity,is_checked FROM shopping_items WHERE list_id=? ORDER BY is_checked,id LIMIT 300').all(row.id)}:null;
}
export function wallDashboard(d,hostId,hydrateTask) {
  const config=wallConfig(d),p=wallPermissions(d,hostId),today=todayKey(d);
  const visible=id=>config.widgets.some(w=>w.id===id&&w.visible);
  const allows=(id,module=id)=>visible(id)&&p.widgets[id==='points'?'rewards':id==='presence'?'family':id]!=='none'&&wallModuleAllowed(d,hostId,module);
  const users=d.prepare(`SELECT u.id,u.display_name,u.avatar_color FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id) ORDER BY u.display_name`).all();
  const result={config,canConfigure:p.admin,today,timezone:householdTimeZone(d),users,
    urgentTasks:[],upcomingEvents:[],todayMeals:[],shoppingLists:[],pinnedNotes:[],points:[],rewardCatalog:[],presence:[],notification:{mode:config.privacy.notifications}};
  if(allows('tasks')) {
    const starts=taskStartProjection(d);
    const rows=d.prepare(`SELECT t.* FROM tasks t WHERE t.status NOT IN ('done','expired') AND t.archived_at IS NULL
      AND ${taskScopeWhere('t',{includeFuture:true,includeSupervision:true})} AND ${starts.where('t')}
      AND ${taskVisibilityWhere(d,hostId,'t','@me')} AND ${taskVisibilityWhere(d,null,'t','0')}
      ORDER BY t.due_date IS NULL,t.due_date,t.due_time,t.id LIMIT 24`).all({today,me:hostId});
    result.urgentTasks=rows.filter(row=>wallTaskVisible(d,row.id,hostId)).map(row=>starts.project(publicTaskProjection(d,hydrateTask(row,hostId),hostId)));
  }
  if(allows('calendar'))result.upcomingEvents=getUpcomingEvents(d,{userId:null,fromToday:true,limit:20,includeBirthdays:false}).map(publicCalendarEvent);
  if(allows('meals'))result.todayMeals=d.prepare("SELECT id FROM meals WHERE date=? AND scope='household' AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND selection_status='selected' ORDER BY scheduled_time,meal_type LIMIT 12").all(today).map(row=>wallMeal(d,row.id));
  if(allows('shopping'))result.shoppingLists=d.prepare('SELECT id FROM shopping_lists ORDER BY updated_at DESC LIMIT 8').all().map(row=>{const value=wallShopping(d,row.id);return {...value,open_count:value.items.filter(i=>!i.is_checked).length,items:value.items.filter(i=>!i.is_checked).slice(0,12)};});
  if(allows('notes'))result.pinnedNotes=d.prepare('SELECT id,title,content FROM notes WHERE pinned=1 ORDER BY updated_at DESC LIMIT 8').all();
  if(allows('rewards'))result.rewardCatalog=d.prepare('SELECT id,name,cost,icon,description FROM reward_catalog WHERE is_active=1 ORDER BY sort_order,cost,name').all();
  if(allows('points','rewards')&&config.privacy.showPoints)result.points=d.prepare(`SELECT u.id AS user_id,u.display_name,COALESCE(SUM(l.delta),0) AS balance FROM users u
    JOIN reward_participants p ON p.user_id=u.id AND p.enabled=1 LEFT JOIN reward_ledger l ON l.user_id=u.id
    WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id) GROUP BY u.id ORDER BY u.display_name`).all();
  if(allows('presence','calendar')&&config.privacy.showPresence) {
    const now=new Date().toISOString();
    const homes=d.prepare("SELECT id FROM places WHERE type='home' AND active=1").all();
    result.presence=users.map(user=>{const current=evaluateAvailability(d,{userId:user.id,startAt:now,nowAt:now}).current_presence;
      // Never publish private Calendar/Trip titles or exact addresses. Calendar-derived
      // location is withheld altogether because Calendar visibility is independent.
      const place=current.source==='calendar'?null:current.place;
      return {user_id:user.id,display_name:user.display_name,state:place?(homes.some(home=>isPlaceWithin(d,place.id,home.id))?'home':'away'):'unknown',inferred:true};});
  }
  // A count reveals no titles, recipients or deep links. It is an explicit admin opt-in.
  if(config.privacy.notifications==='count')result.notification.count=listNotificationInbox(d,hostId,{limit:1}).unreadCount;
  return result;
}

// Proofs are short lived, per browser tab, tied to the hosting session and current
// credentials. Restart/logout/password changes invalidate them. Never stored client-side.
const proofs=new Map();
export const WALL_IDENTITY_SECONDS=120;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const credentials=(d,user)=>digest(`${user.password_hash}|${JSON.stringify(d.prepare('SELECT secret,confirmed_at FROM user_totp WHERE user_id=?').get(user.id)||null)}`);
export function issueWallActor(d,{sessionId,hostId,user,now=Date.now()}) {
  for(const [key,value]of proofs)if(value.expires<=now)proofs.delete(key);
  while(proofs.size>=512)proofs.delete(proofs.keys().next().value);
  const token=crypto.randomBytes(32).toString('base64url');
  proofs.set(digest(token),{sessionId,hostId:Number(hostId),actorId:user.id,credentials:credentials(d,user),expires:now+WALL_IDENTITY_SECONDS*1000});
  return token;
}
export function verifiedWallActor(d,{sessionId,hostId,token,now=Date.now()}) {
  const value=typeof token==='string'&&token.length<=128?proofs.get(digest(token)):null;
  const user=value?householdMember(d,value.actorId):null;
  if(!value||value.sessionId!==sessionId||value.hostId!==Number(hostId)||value.expires<=now||!user||value.credentials!==credentials(d,user))throw wallError('Identify the household member again before this action.',403,'wall_identity_required');
  return user;
}
export function forgetWallActor(token) {if(typeof token==='string')proofs.delete(digest(token));}
