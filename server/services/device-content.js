/** Shared-display readers. No device is represented by, or borrows, a member ID.
 * Every returned object is an allowlisted projection, including Rotation values.
 * Layout choices never authorize data: modules and scope are checked first. */
import { getUpcomingEvents, expandRecurringEvents, loadEventExceptions } from './calendar-events.js';
import { publicCalendarEvent, wallMeal, wallShopping } from './wall.js';
import { normalizeDevicePreferences } from './devices.js';
import { householdTimeZone, todayKey, shiftDateKey } from '../utils/timezone.js';
import { previewSharedRotation, sharedGroupConfiguration } from './rotation-shared.js';

export const DEVICE_CONTENT_MODULES = Object.freeze(['dashboard','tasks','calendar','meals','shopping','rewards']);
export const DEVICE_UNSUPPORTED_MODULES = Object.freeze(['notes','contacts','pantry','inventory','budget','documents','housekeeping','health','schedule','search','reader','mcp']);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key,value[key]]));
const permits = (principal, module) => ['read','write'].includes(principal?.permissions?.modules?.[module]);
const capability = (principal, key) => principal?.permissions?.capabilities?.[key] === 'allow';
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
function assertPrincipal(principal) {
  if (principal?.kind !== 'device' || principal?.status === 'revoked') throw Object.assign(new Error('A valid paired device is required.'),{status:403});
}
function validHouseholdMembers(d) {
  return d.prepare(`SELECT u.id,u.display_name,u.avatar_color FROM users u
    WHERE NOT EXISTS(SELECT 1 FROM housekeeping_workers h WHERE h.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM split_expense_guest_users g WHERE g.user_id=u.id) ORDER BY u.display_name,u.id`).all();
}

export function assertDeviceModule(principal,module) {
  assertPrincipal(principal);
  if(!permits(principal,module))throw Object.assign(new Error('This module is not available on this display.'),{status:403});
}
export function deviceMembers(d,principal) {
  assertPrincipal(principal);
  const ids=principal.scope?.member_ids||[];
  return validHouseholdMembers(d).filter(member=>!ids.length||ids.includes(member.id));
}
export function deviceDateRange(d,query={},maximum=366) {
  const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
  const from=query.from||query.start||query.week||todayKey(d),to=query.to||query.end||shiftDateKey(from,6);
  if(!valid(from)||!valid(to)||to<from||(Date.parse(to)-Date.parse(from))/86400000>maximum)
    throw Object.assign(new Error('Choose a valid, bounded date range.'),{status:400});
  return {from,to};
}
/** Normal Calendar uses the existing recurrence expansion, but only the shared
 * projection. External private feeds and a member outside the scope stay out. */
export function deviceCalendar(d,principal,query={}) {
  assertDeviceModule(principal,'calendar');
  const {from,to}=deviceDateRange(d,query),ids=new Set(deviceMembers(d,principal).map(member=>member.id));
  const rows=d.prepare(`SELECT e.* FROM calendar_events e WHERE e.visibility='all'
    AND (e.external_source!='ics' OR EXISTS(SELECT 1 FROM ics_subscriptions s WHERE s.id=e.subscription_id AND s.shared=1))
    AND (e.recurrence_rule IS NOT NULL OR (substr(e.start_datetime,1,10)<=? AND substr(COALESCE(e.end_datetime,e.start_datetime),1,10)>=?))`)
    .all(to,from).filter(row=>(!row.assigned_to||ids.has(row.assigned_to))&&d.prepare('SELECT user_id FROM event_assignments WHERE event_id=?').all(row.id).every(item=>ids.has(item.user_id)));
  return expandRecurringEvents(rows,from,to,loadEventExceptions(d,rows.filter(row=>row.recurrence_rule).map(row=>row.id))).map(publicCalendarEvent);
}
export function deviceMeals(d,principal,query={}) {
  assertDeviceModule(principal,'meals');const {from,to}=deviceDateRange(d,query,62);
  return d.prepare(`SELECT id FROM meals WHERE date BETWEEN ? AND ? AND scope='household'
    AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND selection_status='selected' ORDER BY date,scheduled_time,meal_type,id`).all(from,to)
    .map(row=>({...wallMeal(d,row.id),scope:'household',can_decide:false,can_choose:false}));
}
export function deviceShopping(d,principal) {
  assertDeviceModule(principal,'shopping');
  return d.prepare('SELECT id FROM shopping_lists ORDER BY updated_at DESC,id').all().map(row=>{
    const list=wallShopping(d,row.id);
    list.items=d.prepare('SELECT id,list_id,name,quantity,category,is_checked,sort_order FROM shopping_items WHERE list_id=? ORDER BY is_checked,sort_order,id LIMIT 300').all(row.id);
    const open=list.items.filter(item=>!item.is_checked).length;
    return {...list,item_count:list.items.length,item_total:list.items.length,item_checked:list.items.length-open,open_count:open};
  });
}
export function deviceRewards(d,principal) {
  assertDeviceModule(principal,'rewards');const ids=new Set(deviceMembers(d,principal).map(member=>member.id));
  const balances=principal.scope?.show_points===true?d.prepare(`SELECT u.id,u.display_name,u.avatar_color,COALESCE(SUM(l.delta),0) AS balance FROM users u
    JOIN reward_participants p ON p.user_id=u.id AND p.enabled=1 LEFT JOIN reward_ledger l ON l.user_id=u.id
    GROUP BY u.id ORDER BY balance DESC,u.display_name`).all().filter(row=>ids.has(row.id)):[];
  let rank=0,last=null;balances.forEach((row,index)=>{if(row.balance!==last)rank=index+1;last=row.balance;row.rank=rank;});
  const catalog=d.prepare('SELECT id,name,cost,icon,description,is_active,sort_order FROM reward_catalog WHERE is_active=1 ORDER BY sort_order,cost,name').all();
  return {balances,catalog,pendingCount:0,isAdmin:false,me:null,setup:{participantCount:balances.length,catalogCount:catalog.length,pointedTaskCount:0}};
}

/** Current Group-owned order is intentionally shared, unlike its consuming Tasks.
 * Omitted Group scope permits shared Groups; [] explicitly permits none.
 * Do not include arbitrary stored occurrence context, eligibility explanations,
 * consumer names, recorded completion evidence, or history in this projection. */
export function deviceSharedRotations(d,principal,{now=new Date()}={}) {
  assertPrincipal(principal);
  if(!capability(principal,'rotations.view')) return [];
  const allowed=principal.scope?.rotation_group_ids;
  if(Array.isArray(allowed)&&!allowed.length)return [];
  const dateKey=todayKey(d,now),instant=new Date(now).toISOString();
  const groups=d.prepare(`SELECT g.id,g.name,g.description FROM rotation_groups g
    JOIN rotation_group_schedules s ON s.group_id=g.id WHERE g.active=1 AND g.household_key='household' ORDER BY g.name,g.id`).all()
    .filter(group=>allowed==null||allowed.map(Number).includes(group.id));
  // One bounded read finds all currently active periods (including overnight).
  const active=new Map(d.prepare(`SELECT s.group_id,p.period_date,o.* FROM rotation_group_periods p
    JOIN rotation_group_schedules s ON s.id=p.schedule_id JOIN rotation_occurrences o ON o.id=p.occurrence_id
    JOIN rotation_tracks t ON t.id=o.track_id WHERE p.starts_at<=? AND p.ends_at>?
      AND t.consumer_type='rotation_group_schedule' ORDER BY p.period_date`).all(instant,instant).map(row=>[row.group_id,row]));
  return groups.map(group=>{
    const current=active.get(group.id);
    const configuration=sharedGroupConfiguration(d,group.id,current?.period_date||dateKey);
    if(!configuration)return null;
    const value=current?{...current,order:parse(current.order_json,[])}:previewSharedRotation(d,group.id,{dateKey,now});
    if(!value)return null;
    const order=(Array.isArray(value.order)?value.order:[]).map((member,index)=>({
      ...pick(member,['id','display_name']),position:index+1,
    }));
    return {...pick(group,['id','name','description']),strategy:configuration.strategy,
      schedule:pick(configuration.schedule,['effective_date','weekdays','active_time','finalize_time','finalize_day_offset','timezone']),
      occurrence_id:value.id||null,period_date:value.period_date||dateKey,status:value.status,
      provisional:value.provisional===true,order,
      selected_member:configuration.strategy==='round_robin'?(order[0]||null):null,
      explanation:value.provisional?'Planned order; confirmed when this scheduled period begins.':order.length?null:'No shared order is available for this period.'};
  }).filter(Boolean);
}

/** Read-only dashboard data. The caller supplies canonical device Task projections. */
export function deviceDashboard(d,principal,{now=new Date()}={}) {
  assertPrincipal(principal);
  if(!permits(principal,'dashboard'))throw Object.assign(new Error('This device cannot access its dashboard.'),{status:403});
  const today=todayKey(d,now),scope=principal.scope||{},selected=new Set((scope.member_ids||[]).map(Number));
  const allMembers=validHouseholdMembers(d),members=allMembers.filter(member=>!selected.size||selected.has(member.id));
  const memberIds=new Set(members.map(member=>member.id));
  // Config is stored for the device, never read from a pairing administrator's
  // personal preferences or the legacy Wall's current hosting account.
  const preferences=normalizeDevicePreferences(d,principal.preferences||{});
  const result={today,timezone:householdTimeZone(d),members,preferences,
    calendar:[],meals:[],shopping:[],rewards:[],points:[],rotations:[],
    unsupported_modules:[...DEVICE_UNSUPPORTED_MODULES]};
  if(permits(principal,'calendar')) {
    result.calendar=getUpcomingEvents(d,{userId:null,fromToday:true,limit:100,includeBirthdays:false,now})
      .filter(event=>{
        const assigned=parse(event.assigned_users_json,[]);
        // A member filter is authorization: a mixed private-for-this-device
        // event cannot leak another member's title through a partial match.
        return assigned.every(member=>memberIds.has(Number(member.id)))&&(!event.assigned_to||memberIds.has(Number(event.assigned_to)));
      }).slice(0,30).map(publicCalendarEvent);
  }
  if(permits(principal,'meals'))result.meals=d.prepare(`SELECT id FROM meals WHERE date=? AND scope='household'
    AND parent_meal_id IS NULL AND superseded_by_id IS NULL AND selection_status='selected' ORDER BY scheduled_time,meal_type,id LIMIT 20`).all(today)
    .map(row=>wallMeal(d,row.id));
  if(permits(principal,'shopping'))result.shopping=d.prepare('SELECT id FROM shopping_lists ORDER BY updated_at DESC,id LIMIT 12').all()
    .map(row=>wallShopping(d,row.id));
  if(permits(principal,'rewards')) {
    result.rewards=d.prepare('SELECT id,name,cost,icon,description FROM reward_catalog WHERE is_active=1 ORDER BY sort_order,cost,name LIMIT 100').all();
    if(scope.show_points===true) result.points=d.prepare(`SELECT u.id AS user_id,u.display_name,COALESCE(SUM(l.delta),0) AS balance FROM users u
      JOIN reward_participants p ON p.user_id=u.id AND p.enabled=1 LEFT JOIN reward_ledger l ON l.user_id=u.id
      GROUP BY u.id ORDER BY u.display_name`).all().filter(row=>memberIds.has(row.user_id));
  }
  result.rotations=deviceSharedRotations(d,principal,{now});
  return result;
}
