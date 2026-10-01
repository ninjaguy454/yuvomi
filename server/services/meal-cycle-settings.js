import { createHash } from 'node:crypto';
import { actorPermissions, PermissionError } from '../permissions.js';
import { householdTimeZone, isValidTimeZone } from '../utils/timezone.js';
import { cycleInstants, cycleTimingLocal, periodForStart, validateCycleDate, validateCycleTiming } from './meal-cycle-schedule.js';
import { isHouseholdMember } from './member-email.js';

const TIMINGS=['creation','response','confirmation','shopping'];
const IDS=['coordinator_id','shopping_assignee_id','shopping_list_id'];
const FIELDS=['enabled','timezone','cadence','first_period_start',...TIMINGS,...IDS,'finalization_mode'];
const REQUIRED_COORDINATOR_CAPABILITIES=['tasks.create','tasks.edit_others','tasks.change_assignment','tasks.change_dates'];
const cycleTimingDate=(rule,start,cadence)=>cycleTimingLocal(rule,start,cadence).date;
function error(message,status=400) {const err=new Error(message);err.status=status;throw err;}
function defaults(d) {
  return {revision:0,enabled:false,timezone:householdTimeZone(d),cadence:null,first_period_start:null,
    creation:null,response:null,confirmation:null,shopping:null,coordinator_id:null,shopping_assignee_id:null,
    shopping_list_id:null,finalization_mode:'manual'};
}
/** Read-only; household timezone is displayed even before first explicit setup. */
export function getCycleSettings(d) {
  const row=d.prepare("SELECT revision,enabled,settings_json FROM meal_cycle_settings WHERE household_key='household'").get();
  return row?{...JSON.parse(row.settings_json),revision:row.revision,enabled:!!row.enabled}:defaults(d);
}
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function validate(d,s) {
  if(typeof s.enabled!=='boolean') error('Cycle enabled must be boolean.');
  if(!['manual','automatic'].includes(s.finalization_mode)) error('Invalid cycle finalization_mode.');
  if(s.timezone!=null && (!isValidTimeZone(s.timezone)||s.timezone!==householdTimeZone(d))) error('Cycle timezone must match the household timezone.');
  if(s.cadence!=null) periodForStart('2026-01-01',s.cadence);
  if(s.first_period_start!=null) validateCycleDate(s.first_period_start);
  for(const key of TIMINGS) if(s[key]!=null) {
    if(!s.cadence) error('Choose cadence before setting cycle timings.');
    validateCycleTiming(s[key],s.cadence);
  }
  for(const key of IDS) if(s[key]!=null) {
    if(!Number.isSafeInteger(s[key])||s[key]<1) error(`Invalid ${key}.`);
    const table=key==='shopping_list_id'?'shopping_lists':'users';
    if(!d.prepare(`SELECT id FROM ${table} WHERE id=?`).get(s[key])) error(`Unknown ${key}.`);
    if(table==='users'&&!isHouseholdMember(s[key],{db:d})) error(`${key} must be a household member.`,403);
  }
  if(s.enabled) for(const key of ['timezone','cadence','first_period_start',...TIMINGS,...IDS]) if(s[key]==null) error(`Cycle activation requires ${key}.`);
  if(s.coordinator_id!=null) {
    const permissions=actorPermissions(d,s.coordinator_id);
    if(['meals','tasks','shopping'].some(key=>permissions.modules[key]!=='write') || REQUIRED_COORDINATOR_CAPABILITIES.some(key=>permissions.capabilities[key]!=='allow'))
      error('Coordinator lacks required Kitchen, Shopping or Task permissions.',403);
  }
  if(s.shopping_assignee_id!=null) {
    const permissions=actorPermissions(d,s.shopping_assignee_id);
    if(permissions.modules.shopping!=='write'||permissions.modules.tasks!=='write'||permissions.capabilities['tasks.complete_own']!=='allow')
      error('Shopping assignee lacks required Shopping or Task permissions.',403);
  }
  if(s.timezone && s.cadence && s.first_period_start && TIMINGS.every(key=>s[key])) {
    let start=s.first_period_start;
    // Preview four calendar years of anchored periods, including daily/weekly
    // and fortnightly DST transitions. Existing immutable ICU formatter caches
    // are reused; resolved instants are never cached across settings or tz changes.
    // Runtime cycleInstants still validates every later period independently.
    const count={daily:1462,weekly:210,fortnightly:106,monthly:48}[s.cadence];
    for(let n=0;n<count;n++) {
      const t=cycleInstants(s,start);
      // Settings have no occurrence context. Same-date times can precede an
      // evening meal; ensure/finalization must check the actual first meal.
      if(cycleTimingDate(s.response,start,s.cadence)>start || cycleTimingDate(s.confirmation,start,s.cadence)>start)
        error('Response and confirmation deadlines must not follow the first governed local date.');
      start=t.period.next_start;
    }
  }
}
/** Future settings only. Request identity binds actor + exact patch + expected revision.
 * Existing cycles retain their stored settings and instants; rescheduling is separate.
 */
export function saveCycleSettings(d,input,{actorId,expectedRevision,requestKey}={}) {
  if(!Number.isSafeInteger(actorId)||actorId<1) throw new PermissionError('A household administrator is required.');
  const permissions=actorPermissions(d,actorId);
  if(!permissions.admin||permissions.modules.meals!=='write'||!isHouseholdMember(actorId,{db:d})) throw new PermissionError('Household administrator permission is required to edit Kitchen cycle settings.');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) error('An expected settings revision is required.');
  if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>200) error('A stable settings requestKey is required.');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!FIELDS.includes(key)||input[key]===undefined)) error('Invalid cycle settings input.');
  const payloadHash=createHash('sha256').update(JSON.stringify(canonical({actorId,expectedRevision,input}))).digest('hex');
  return d.transaction(()=>{
    const receipt=d.prepare("SELECT actor_id,payload_hash,result_json FROM meal_cycle_requests WHERE scope_key='settings:household' AND operation='settings.save' AND request_key=?").get(requestKey);
    if(receipt) {
      if(receipt.actor_id!==actorId||receipt.payload_hash!==payloadHash) error('Settings requestKey was already used for a different request.',409);
      return JSON.parse(receipt.result_json);
    }
    const previous=getCycleSettings(d);
    if(previous.revision!==expectedRevision) error('Settings revision conflict.',409);
    const settings=Object.fromEntries(FIELDS.map(key=>[key,Object.hasOwn(input,key)?input[key]:previous[key]]));
    // A pause must remain available when an existing coordinator is no longer
    // eligible or the household timezone changed. Only the exact pause patch
    // preserves retained configuration without revalidating activation; edits
    // and resuming still pass the full settings contract above.
    const pauseOnly=input.enabled===false&&Object.keys(input).length===1;
    if(!pauseOnly) validate(d,settings);
    const result={...settings,revision:previous.revision+1};
    d.prepare(`INSERT INTO meal_cycle_settings(household_key,revision,enabled,settings_json,updated_by) VALUES('household',?,?,?,?)
      ON CONFLICT(household_key) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,settings_json=excluded.settings_json,
      updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(result.revision,Number(result.enabled),JSON.stringify(settings),actorId);
    d.prepare(`INSERT INTO meal_cycle_requests(scope_key,operation,request_key,actor_id,expected_revision,payload_hash,result_json)
      VALUES('settings:household','settings.save',?,?,?,?,?)`).run(requestKey,actorId,expectedRevision,payloadHash,JSON.stringify(result));
    return result;
  }).immediate();
}
