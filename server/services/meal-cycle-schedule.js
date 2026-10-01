import { isValidTimeZone, shiftDateKey, utcToWall, daysBetweenDateKeys } from '../utils/timezone.js';
import { availabilityInstantMs } from './presence.js';

const LENGTHS = {daily:1,weekly:7,fortnightly:14};
export function validateCycleDate(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value<'0100-01-01'
    || daysBetweenDateKeys(value,value)!==0) throw new TypeError('Invalid cycle calendar date.');
  return value;
}
export function validateCycleTiming(rule,cadence) {
  if(!rule || typeof rule!=='object' || Array.isArray(rule) || typeof rule.time!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time))
    throw new TypeError('Cycle timing requires an explicit HH:mm time.');
  const keys=cadence==='monthly'?['day','month_offset','time']:['day_offset','time'];
  if(Object.keys(rule).some(key=>!keys.includes(key))) throw new TypeError('Unexpected cycle timing field; monthly timings require day and month_offset.');
  if(cadence==='monthly') {
    if(!Number.isInteger(rule.day)||rule.day<1||rule.day>31||!Number.isInteger(rule.month_offset)||Math.abs(rule.month_offset)>12)
      throw new TypeError('Monthly timing requires numbered day 1-31 and explicit month_offset -12..12.');
  } else if(!Number.isInteger(rule.day_offset)||Math.abs(rule.day_offset)>366) throw new TypeError('Cycle day_offset must be an integer -366..366.');
  return rule;
}
function monthDate(start,offset,day) {
  const base=new Date(`${start}T00:00:00Z`);
  const first=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+offset,1));
  const end=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  first.setUTCDate(Math.min(day,end));
  return first.toISOString().slice(0,10);
}
/** Inclusive coverage; pass original anchorDay when chaining a clamped month. */
export function periodForStart(start,cadence,{anchorDay=Number(String(start).slice(8,10))}={}) {
  validateCycleDate(start);
  if(!Object.hasOwn(LENGTHS,cadence)&&cadence!=='monthly') throw new TypeError('Invalid cycle cadence.');
  if(!Number.isInteger(anchorDay)||anchorDay<1||anchorDay>31) throw new TypeError('Invalid monthly anchor day.');
  const next_start=cadence==='monthly'?monthDate(start,1,anchorDay):shiftDateKey(start,LENGTHS[cadence]);
  return {start,end:shiftDateKey(next_start,-1),next_start};
}
/** Resolve one persisted rule without replacing numbered monthly rules with offsets. */
export function cycleTimingLocal(rule,start,cadence) {
  validateCycleDate(start);validateCycleTiming(rule,cadence);
  return {date:cadence==='monthly'?monthDate(start,rule.month_offset,rule.day):shiftDateKey(start,rule.day_offset),time:rule.time};
}
/** Pure preview. UTC strings use the same gap-forward/fold-earlier policy as Tasks. */
export function cycleInstants(settings,start) {
  if(!isValidTimeZone(settings.timezone)) throw new TypeError('Invalid cycle timezone.');
  validateCycleDate(settings.first_period_start);
  const period=periodForStart(start,settings.cadence,{anchorDay:Number(settings.first_period_start.slice(8))});
  const result={period};
  for(const key of ['creation','response','confirmation','shopping']) {
    const local=cycleTimingLocal(settings[key],start,settings.cadence);
    const ms=availabilityInstantMs(`${local.date}T${local.time}`,settings.timezone);
    if(!Number.isFinite(ms)) throw new TypeError('Invalid cycle scheduled instant.');
    result[key]=new Date(ms).toISOString();
  }
  return result;
}
/** Return all due, unended periods, independent of completion or database state.
 * The generator filters already-created identities. An old anchor is skipped arithmetically.
 */
export function dueCyclePeriods(settings,now) {
  if(!settings.enabled) return [];
  const ms=now instanceof Date?now.getTime():typeof now==='number'?now:Date.parse(now);
  if(!Number.isFinite(ms)) throw new TypeError('Invalid cycle scheduler instant.');
  const today=utcToWall(new Date(ms).toISOString(),settings.timezone)?.date;
  if(!today) throw new TypeError('Invalid cycle timezone.');
  const anchor=validateCycleDate(settings.first_period_start),cadence=settings.cadence;
  validateCycleTiming(settings.creation,cadence);
  let index=0,start=anchor;
  if(cadence==='monthly') {
    index=Math.max(0,(Number(today.slice(0,4))-Number(anchor.slice(0,4)))*12+Number(today.slice(5,7))-Number(anchor.slice(5,7))-1);
    start=monthDate(anchor,index,Number(anchor.slice(8)));
  } else {
    periodForStart(anchor,cadence);
    index=Math.max(0,Math.floor(daysBetweenDateKeys(anchor,today)/LENGTHS[cadence])-1);
    start=shiftDateKey(anchor,index*LENGTHS[cadence]);
  }
  const results=[];
  // Rule bounds limit forward lead to 12 months / 366 dates. One extra period
  // handles month-end clamping and timezone boundaries.
  const limit=cadence==='monthly'?16:Math.ceil(368/LENGTHS[cadence])+3;
  for(let count=0;count<limit;count++) {
    const instants=cycleInstants(settings,start);
    if(instants.creation>new Date(ms).toISOString()) break;
    const ends=availabilityInstantMs(`${instants.period.next_start}T00:00`,settings.timezone);
    if(ends>ms) results.push(instants);
    start=instants.period.next_start;
  }
  return results;
}
