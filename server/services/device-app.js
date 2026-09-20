/** Device principals use the ordinary application URLs and view contracts.
 * This boundary deliberately terminates every device request: human routers
 * must never infer a member from a device, a null ID, or its pairing parent.
 * Consumers reuse the existing lifecycle and shared-content projections. */
import * as db from '../db.js';
import { deviceTaskList,deviceTaskDetail,deviceTaskStatus,deviceTaskClaim } from './device-tasks.js';
import { deviceTaskCreateOnce,deviceTaskUpdate } from './device-task-definitions.js';
import { deviceTaskVisible } from './task-access.js';
import { taskActivity } from './task-lifecycle.js';
import { occurrenceFeed,seriesRootOf } from './task-completions.js';
import { assertDeviceModule,deviceMembers,deviceCalendar,deviceMeals,deviceShopping,deviceRewards,deviceSharedRotations,deviceDateRange } from './device-content.js';
import { normalizeDevicePreferences,deviceRequestStillValid } from './devices.js';
import { householdTimeZone,todayKey } from '../utils/timezone.js';

const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row?.[key]!==undefined).map(key=>[key,row[key]]));
const fail=(message='This action requires personal sign-in.',status=403)=>{throw Object.assign(new Error(message),{status});};
import {canonicalPath,deviceAppRouteSupported} from './device-app-paths.js';
export {deviceAppRouteSupported} from './device-app-paths.js';
function task(d,p,id){return deviceTaskDetail(d,p,Number(id));}
function requireTaskRead(p){assertDeviceModule(p,'tasks');if(p.permissions?.capabilities?.['tasks.view_household']!=='allow')fail();}
function categoryRows(d){return d.prepare('SELECT key,name,label_key,sort_order FROM task_categories ORDER BY sort_order,key').all();}
function visibleTags(d,p) {
  const counts=new Map();
  for(const row of d.prepare('SELECT task_id,tag,tag_key FROM task_tags').all())if(deviceTaskVisible(d,p,row.task_id)){
    const value=counts.get(row.tag_key)||{tag:row.tag,count:0};value.count++;counts.set(row.tag_key,value);
  }
  return [...counts.values()].sort((a,b)=>a.tag.localeCompare(b.tag));
}
export function deviceAppPreferences(d,p) {
  const value=normalizeDevicePreferences(d,p.preferences||{}),a=value.appearance;
  // Only benign household formatting values are inherited. Never read the
  // pairing parent's user_config, private locations, credentials or feeds.
  const setting=(key,fallback)=>d.prepare('SELECT value FROM sync_config WHERE key=?').get(key)?.value??fallback;
  const widgets=new Map();
  for(const row of value.widgets){
    const id=row.id==='points'?'rewards':row.id;
    const allowed=id==='rotations'?p.permissions?.capabilities?.['rotations.view']==='allow':['read','write'].includes(p.permissions?.modules?.[id]);
    if(!widgets.has(id)||row.visible)widgets.set(id,{...row,id,visible:row.visible&&allowed,options:{}});
  }
  return {timezone:householdTimeZone(d),language:setting('language','en'),date_format:setting('date_format','locale'),
    time_format:setting('time_format','12h'),week_start:setting('week_start','monday'),currency:setting('currency','USD'),
    theme:a.theme,color_theme:a.palette,heading_font:a.font==='serif'?'serif':'default',density:a.density,
    dashboard_widgets:[...widgets.values()],dashboard_today_glance:true,dashboard_follows_default:false,
    disabled_modules:Object.entries(p.permissions?.modules||{}).filter(([,level])=>level==='none').map(([key])=>key),
    hidden_modules:[],tasks_subtasks_expanded:true,tasks_template_switch_warning:true,visible_meal_types:['breakfast','lunch','dinner','snack']};
}
function dashboard(d,p,query) {
  assertDeviceModule(p,'dashboard');const permits=key=>['read','write'].includes(p.permissions?.modules?.[key]),today=todayKey(d);
  const tasks=permits('tasks')?deviceTaskList(d,p,{query:{...query,status:['open','in_progress']}}):[];
  const shopping=permits('shopping')?deviceShopping(d,p):[],rewards=permits('rewards')?deviceRewards(d,p):{balances:[],catalog:[]};
  return {today,timezone:householdTimeZone(d),users:deviceMembers(d,p),urgentTasks:tasks.slice(0,24),
    openTaskCount:tasks.length,overdueTaskCount:tasks.filter(row=>row.due_date&&row.due_date<today).length,
    upcomingEvents:permits('calendar')?deviceCalendar(d,p,{from:today}).slice(0,20):[],
    todayMeals:permits('meals')?deviceMeals(d,p,{from:today,to:today}):[],
    shoppingLists:shopping,shoppingOpenCount:shopping.reduce((count,row)=>count+row.open_count,0),shoppingOpenLists:shopping.filter(row=>row.open_count).length,
    rewards:{standings:rewards.balances,participantCount:rewards.balances.length,pending:0},rewardCatalog:rewards.catalog,
    rotations:deviceSharedRotations(d,p),pinnedNotes:[],pinnedNotesCount:0,birthdays:[],birthdayCount:0,birthdaySoonCount:0,
    countdowns:[],countdownTotal:0,quicklinks:[],memberTodayTasks:[],tasksDoneToday:0};
}
function eventProjection(d,p,id,limit) {
  task(d,p,id);const members=new Set(deviceMembers(d,p).map(member=>member.id));
  return taskActivity(d,Number(id),limit).filter(event=>event.action_task_id&&deviceTaskVisible(d,p,event.action_task_id)).map(event=>{
    const details=event.details||{},result={...pick(event,['id','action_task_id','event_type','created_at']),
      actor_user_id:members.has(event.actor_user_id)?event.actor_user_id:null,actor_name:members.has(event.actor_user_id)?event.actor_name:null,
      details:pick(details,['title','from','to','status','previous_status','automatic','reason_code'])};
    if(details.source_device)result.details.source_device=pick(details.source_device,['id','name']);
    if(Array.isArray(details.assigned_members))result.details.assigned_members=details.assigned_members.filter(member=>members.has(member.id)).map(member=>pick(member,['id','display_name']));
    return result;
  });
}
function completions(d,p,{taskId=null,query={}}={}) {
  if(taskId)task(d,p,taskId);
  const ids=new Set(deviceMembers(d,p).map(row=>row.id)),limit=Math.max(1,Math.min(100,Number(query.limit)||40));
  // Apply canonical device visibility before paging. A scan-limit cursor over
  // hidden rows would disclose their existence, IDs and completion dates.
  const taskIds=d.prepare(`SELECT task_id FROM task_completions UNION
    SELECT action_task_id FROM task_activity_events WHERE event_type='expired'`).all()
    .map(row=>row.task_id).filter(id=>deviceTaskVisible(d,p,id));
  const result=occurrenceFeed(d,{me:null,limit,taskIds,userId:query.user_id?Number(query.user_id):null,
    beforeAt:query.before_at||null,beforeId:query.before_id||null,seriesId:taskId?seriesRootOf(d,Number(taskId)):null});
  const entries=result.entries.map(row=>({...pick(row,['id','task_id','series_id','completed_at','expired_at','occurred_at','event_type','title','category','points','is_recurring','source_device_id','source_device_name']),
    user_id:ids.has(row.user_id)?row.user_id:null,user_name:ids.has(row.user_id)?row.user_name:row.user_id?'Household member':null,user_color:ids.has(row.user_id)?row.user_color:null}));
  const last=entries.at(-1);
  return {data:entries,has_more:result.hasMore,next_cursor:result.hasMore&&last?{before_at:last.occurred_at,before_id:last.id}:null};
}
function sharedGroups(d,p) {
  if(p.permissions?.capabilities?.['rotations.view']!=='allow')fail();
  return deviceSharedRotations(d,p).map(value=>({...value,active:true,usage_mode:'shared',members:value.order,
    shared_config:{strategy:value.strategy,schedule:value.schedule},tracks:[]}));
}
function changes(req,res,table,allowed) {
  const d=db.get();allowed(d,req.devicePrincipal);
  res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'private, no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  let version=null,timer=null;const close=()=>{if(timer)clearInterval(timer);timer=null;res.end();};
  const tick=()=>{try{
    if(!deviceRequestStillValid(db.get(),req))return close();
    const current=db.get().prepare(`SELECT version FROM ${table} WHERE id=1`).get()?.version||0;
    if(current!==version){version=current;res.write(`event: change\ndata: ${JSON.stringify({version})}\n\n`);}else res.write(': keepalive\n\n');
  }catch{close();}};
  timer=setInterval(tick,1000);timer.unref?.();req.on('close',()=>{if(timer)clearInterval(timer);timer=null;});tick();
}

/** Must run after authentication and CSRF, before human routers/idempotency. */
export function deviceAppMiddleware(req,res,next) {
  const p=req.devicePrincipal;if(!p)return next();
  const path=canonicalPath(req.originalUrl||req.url),method=req.method,d=db.get(),query=req.query||{};
  // Bootstrap/context management already use their own device-aware handlers.
  if(path.startsWith('/device/')||['/auth/me','/auth/logout','/version'].includes(path))return next();
  res.set('Cache-Control','private, no-store');
  try {
    if(!deviceAppRouteSupported(method,path))fail();
    if(path==='/preferences')return res.json({data:deviceAppPreferences(d,p)});
    if(path==='/auth/users')return res.json({data:deviceMembers(d,p)});
    if(path==='/dashboard')return res.json(dashboard(d,p,query));
    if(path==='/module-counts')return res.json({tasks:0,calendar:0,meals:0,shopping:0,rewards:0});
    if(path==='/tasks'||path.startsWith('/tasks/')) {
      requireTaskRead(p);
      if(path==='/tasks'&&method==='GET')return res.json({data:deviceTaskList(d,p,{query})});
      if(path==='/tasks'&&method==='POST'){
        const result=deviceTaskCreateOnce(d,p,req.body,req.get('Idempotency-Key'));
        if(result.replayed)res.set('Idempotent-Replayed','true');
        return res.status(201).json({data:result.data});
      }
      if(path==='/tasks/changes')return changes(req,res,'task_change_clock',(_d,p)=>requireTaskRead(p));
      if(path==='/tasks/meta/options')return res.json({users:deviceMembers(d,p),categories:categoryRows(d),tags:visibleTags(d,p),priorities:['low','medium','high','urgent'],statuses:['open','in_progress','done','expired'],default_points:0});
      if(path==='/tasks/categories')return res.json({data:categoryRows(d)});
      if(path==='/tasks/tags')return res.json({data:visibleTags(d,p)});
      if(path==='/tasks/sync-targets')return res.json({data:{caldav:[]}});
      if(path==='/tasks/completions')return res.json(completions(d,p,{query}));
      const [,id,action]=path.match(/^\/tasks\/(\d+)(?:\/([^/]+))?$/)||[];
      if(action==='status')return res.json({data:deviceTaskStatus(d,p,Number(id),req.body)});
      if(method==='PUT')return res.json({data:deviceTaskUpdate(d,p,Number(id),req.body)});
      if(!action)return res.json({data:task(d,p,id)});
      if(action==='activity')return res.json({data:eventProjection(d,p,id,query.limit)});
      if(action==='completions')return res.json(completions(d,p,{taskId:id,query}));
      const value=task(d,p,id);
      // Documents have their own personal ACL. A Task being shared grants no
      // device document access. Comments are part of the shared Task itself.
      const data=action==='comments'?d.prepare('SELECT id,task_id,comment,created_at,updated_at FROM task_comments WHERE task_id=? ORDER BY id').all(Number(id)):[];
      return res.json({data,revision:value.revision,parent_revision:value.parent_revision});
    }
    const claim=path.match(/^\/automation\/tasks\/(\d+)\/claim$/);
    if(claim)return res.json({data:deviceTaskClaim(d,p,Number(claim[1]),req.body)});
    if(path==='/calendar'||path.startsWith('/calendar/')) {
      assertDeviceModule(p,'calendar');
      if(path==='/calendar/holidays')return res.json({data:[]});
      if(path==='/calendar/sync-targets')return res.json({data:{caldav:[]}});
      if(path==='/calendar/search')return res.json({data:deviceCalendar(d,p,{from:todayKey(d)}).filter(row=>row.title.toLowerCase().includes(String(query.q||'').toLowerCase()))});
      if(path==='/calendar')return res.json({data:deviceCalendar(d,p,query)});
      const id=Number(path.split('/').at(-1)),row=d.prepare('SELECT start_datetime FROM calendar_events WHERE id=?').get(id);
      const data=row&&deviceCalendar(d,p,{from:row.start_datetime.slice(0,10),to:row.start_datetime.slice(0,10)}).find(value=>value.id===id);
      if(!data)fail('Event not found.',404);return res.json({data});
    }
    if(path==='/shopping'||path.startsWith('/shopping/')) {
      const lists=deviceShopping(d,p);
      if(path==='/shopping/categories')return res.json({data:d.prepare('SELECT id,name,sort_order FROM shopping_categories ORDER BY sort_order,id').all()});
      if(path==='/shopping')return res.json({data:lists});
      const list=lists.find(row=>row.id===Number(path.split('/')[2]));if(!list)fail('Shopping list not found.',404);
      return res.json({data:list.items,list:pick(list,['id','name']),categories:[]});
    }
    if(path==='/meals'||path.startsWith('/meals/')) {
      assertDeviceModule(p,'meals');
      if(path==='/meals/selection-requests')return res.json({data:[]});
      if(path==='/meals/planning')return res.json({data:{members:deviceMembers(d,p),slots:[],timing_defaults:{}}});
      const rows=deviceMeals(d,p,query),range=deviceDateRange(d,query,62);
      if(path==='/meals')return res.json({data:rows,weekStart:range.from,weekEnd:range.to});
      return res.json({data:{start:range.from,end:range.to,members:deviceMembers(d,p).map(member=>({...member,can_act_for:false})),
        member:null,selected_member_id:null,can_act_for:false,contexts:[],occurrences:rows.map(row=>({...row,participants:[],menu_items:[],decisions:[],can_act_for:false}))},weekStart:range.from,weekEnd:range.to});
    }
    if(path.startsWith('/rewards/')) {
      assertDeviceModule(p,'rewards');
      if(path==='/rewards/changes')return changes(req,res,'reward_change_clock',(_d,p)=>assertDeviceModule(p,'rewards'));
      const value=deviceRewards(d,p);
      return res.json({data:path==='/rewards/overview'?value:path==='/rewards/catalog'?value.catalog:[]});
    }
    if(path==='/automation/rotation-changes')return changes(req,res,'rotation_change_clock',(_d,p)=>{if(p.permissions?.capabilities?.['rotations.view']!=='allow')fail();});
    if(path==='/automation/rotation-members'){if(p.permissions?.capabilities?.['rotations.view']!=='allow')fail();return res.json({data:deviceMembers(d,p)});}
    if(path.startsWith('/automation/rotation-groups')){
      const rows=sharedGroups(d,p);if(path==='/automation/rotation-groups')return res.json({data:rows});
      const row=rows.find(value=>value.id===Number(path.split('/').at(-1)));if(!row)fail('Rotation Group not found.',404);return res.json({data:row});
    }
    requireTaskRead(p);
    if(path==='/automation/activity-options')return res.json({data:{activities:[],skills:[]}});
    if(path==='/planning/place-search/status')return res.json({data:{configured:false}});
    // Optional personal planning/catalogue panels are absent on a device. They
    // do not make the normal Task board fail or weaken their original ACLs.
    return res.json({data:[]});
  }catch(error){return res.status(error.status||500).json({error:error.status?error.message:'This application view could not be loaded.',code:error.status||500,reason:error.reason||'device_access_denied',...error.details});}
}
