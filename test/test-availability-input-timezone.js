process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'availability-input-timezone-test';
process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { get } from '../server/db.js';
import planningRouter from '../server/routes/planning.js';
import { saveTrip } from '../server/services/trips.js';
import { evaluateAvailability } from '../server/services/presence.js';
import { zonedFields, setDisplayTimeZone } from '../public/utils/timezone.js';

const d = get();
d.prepare("INSERT INTO sync_config(key,value) VALUES('household_timezone','America/New_York') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
const member = Number(d.prepare("INSERT INTO users(username,password_hash,role,display_name) VALUES('input-timezone','test','admin','Time zone member')").run().lastInsertRowid);
const app = express(); app.use(express.json());
app.use((req,_res,next) => { req.authUserId=member; req.authRole='admin'; req.session={userId:member,role:'admin'}; next(); });
app.use('/planning',planningRouter);
const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
test.after(()=>server.close());
const base=`http://127.0.0.1:${server.address().port}`;
async function call(path,body,method=body?'POST':'GET') {
  const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json()};
}
function uiHelpers() {
  const source=readFileSync(new URL('../public/components/activity-automation.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function localDateTimeValue('),source.indexOf('\nconst availabilityMounts'));
  return new Function('zonedFields',`${code}\nreturn {localDateTimeValue, preservePlanningInstant: typeof preservePlanningInstant === 'function' ? preservePlanningInstant : null};`)(zonedFields);
}
test('dated editor converts explicit instants using household zone, never UTC or browser preference',()=>{
  setDisplayTimeZone('Asia/Tokyo');
  const {localDateTimeValue}=uiHelpers();
  assert.equal(localDateTimeValue('2026-09-11T12:30:00Z','America/New_York'),'2026-09-11T08:30');
  assert.equal(localDateTimeValue('2026-09-11T08:30:00','America/New_York'),'2026-09-11T08:30');
  assert.equal(localDateTimeValue('2026-09-12T01:00:00+09:00','America/New_York'),'2026-09-11T12:00');
  setDisplayTimeZone(null);
});
test('admin context identifies the resolver household timezone for editors',async()=>{
  const response=await call('/planning/admin/context');
  assert.equal(response.status,200); assert.equal(response.body.timezone,'America/New_York');
});
test('unchanged datetime-local edits preserve the later DST occurrence and stored seconds',()=>{
  const {localDateTimeValue,preservePlanningInstant}=uiHelpers();
  const original='2026-11-01T06:30:45Z';
  const shown=localDateTimeValue(original,'America/New_York');
  assert.equal(shown,'2026-11-01T01:30');
  assert.equal(preservePlanningInstant(shown,original,'America/New_York'),original);
  assert.equal(preservePlanningInstant('2026-11-01T02:30',original,'America/New_York'),'2026-11-01T02:30');
});
test('dated period rejects a mixed-zone reversed range before it can silently disappear',async()=>{
  const response=await call('/planning/admin/periods',{user_id:member,source:'manual',state:'busy',starts_at:'2026-09-11T09:00:00',ends_at:'2026-09-11T12:00:00Z'});
  assert.equal(response.status,400); assert.match(response.body.error,/after start/);
});
test('dated period accepts a mixed-zone valid range and resolves exact exclusive end',async()=>{
  const response=await call('/planning/admin/periods',{user_id:member,source:'manual',state:'busy',starts_at:'2026-09-11T09:00:00Z',ends_at:'2026-09-11T06:00:00',note:'Offset exception'});
  assert.equal(response.status,201,JSON.stringify(response.body));
  const query=(value)=>evaluateAvailability(d,{userId:member,startAt:value,policy:'available_before_due',nowAt:value});
  assert.equal(query('2026-09-11T09:00:00Z').eligible,false);
  assert.match(query('2026-09-11T09:00:00Z').reason,/Offset exception.*busy/);
  assert.equal(query('2026-09-11T10:00:00Z').eligible,true);
  assert.match(query('2026-09-11T10:00:00Z').reason,/unknown.*no planned restriction/i);
});
test('Trip mixed-zone validation uses the same household clock as its Availability period',()=>{
  assert.throws(()=>saveTrip(d,{name:'Reversed offset Trip',participant_ids:[member],starts_at:'2026-09-12T09:00:00',ends_at:'2026-09-12T12:00:00Z'},member),/after departure/);
  const trip=saveTrip(d,{name:'Valid offset Trip',participant_ids:[member],starts_at:'2026-09-12T09:00:00Z',ends_at:'2026-09-12T06:00:00'},member);
  const inside=evaluateAvailability(d,{userId:member,startAt:'2026-09-12T09:30:00Z',policy:'available_before_due'});
  assert.equal(inside.eligible,false); assert.match(inside.reason,/Valid offset Trip.*away/);
  const end=evaluateAvailability(d,{userId:member,startAt:'2026-09-12T10:00:00Z',policy:'available_before_due'});
  assert.equal(end.eligible,true); assert.match(end.reason,/unknown.*no planned restriction/i);
  assert.ok(trip.id);
});
test('Trip stage and generated Task dates follow household dates for UTC departures',()=>{
  const trip=saveTrip(d,{name:'Midnight offset Trip',participant_ids:[member],starts_at:'2026-09-15T02:00:00Z',ends_at:'2026-09-15T14:00:00Z',
    tasks:[{phase:'departure',title:'Before local midnight'}]},member);
  const stage=d.prepare("SELECT starts_at FROM trip_stages WHERE trip_id=? AND phase='during_trip'").get(trip.id);
  assert.equal(stage.starts_at.slice(0,16),'2026-09-14T23:00');
  const task=d.prepare("SELECT due_date FROM tasks WHERE title='Before local midnight'").get();
  assert.equal(task.due_date,'2026-09-14');
});

test('mixed wall and UTC planning contexts store their actual overlap without violating lexical constraints',async()=>{
  const {savePlanningContext}=await import('../server/services/planning-contexts.js');
  const left=savePlanningContext(d,{context_key:'mixed-overlap-wall',name:'Wall context',context_type:'custom',
    starts_at:'2026-09-20T08:00:00',ends_at:'2026-09-20T10:00:00',member_ids:[member]},member);
  const right=savePlanningContext(d,{context_key:'mixed-overlap-utc',name:'UTC context',context_type:'custom',
    starts_at:'2026-09-20T13:00:00Z',ends_at:'2026-09-20T15:00:00Z',member_ids:[member]},member);
  const overlap=d.prepare('SELECT * FROM planning_context_conflicts WHERE first_context_id=? AND second_context_id=?').get(left.id,right.id);
  assert.equal(overlap.overlap_starts_at,'2026-09-20T13:00:00.000Z');
  assert.equal(overlap.overlap_ends_at,'2026-09-20T14:00:00.000Z');
  assert.equal(overlap.status,'open');
});

test('floating planning context overlaps retain their existing wall-clock representation',async()=>{
  const {savePlanningContext}=await import('../server/services/planning-contexts.js');
  const left=savePlanningContext(d,{context_key:'floating-overlap-one',name:'Floating one',context_type:'custom',
    starts_at:'2026-09-21T08:00:00',ends_at:'2026-09-21T10:00:00',member_ids:[member]},member);
  const right=savePlanningContext(d,{context_key:'floating-overlap-two',name:'Floating two',context_type:'custom',
    starts_at:'2026-09-21T09:00:00',ends_at:'2026-09-21T11:00:00',member_ids:[member]},member);
  const overlap=d.prepare('SELECT * FROM planning_context_conflicts WHERE first_context_id=? AND second_context_id=?').get(left.id,right.id);
  assert.equal(overlap.overlap_starts_at,'2026-09-21T09:00:00');
  assert.equal(overlap.overlap_ends_at,'2026-09-21T10:00:00');
});

test('linked Trips with mixed wall and UTC endpoints store their actual union window',()=>{
  const first=saveTrip(d,{name:'Wall union Trip',starts_at:'2026-09-22T09:00:00',ends_at:'2026-09-22T10:00:00',participant_ids:[member]},member);
  const second=saveTrip(d,{name:'UTC union Trip',starts_at:'2026-09-22T12:45:00Z',ends_at:'2026-09-22T13:15:00Z',
    participant_ids:[member],planning_context_id:first.planning_context_id},member);
  assert.equal(second.planning_context.starts_at,'2026-09-22T12:45:00.000Z');
  assert.equal(second.planning_context.ends_at,'2026-09-22T14:00:00.000Z');
  assert.equal(second.planning_context.id,first.planning_context_id);
});

test('linked floating Trips retain a floating union window',()=>{
  const first=saveTrip(d,{name:'Floating union one',starts_at:'2026-09-23T09:00:00',ends_at:'2026-09-23T10:00:00',participant_ids:[member]},member);
  const second=saveTrip(d,{name:'Floating union two',starts_at:'2026-09-23T08:45:00',ends_at:'2026-09-23T09:15:00',
    participant_ids:[member],planning_context_id:first.planning_context_id},member);
  assert.equal(second.planning_context.starts_at,'2026-09-23T08:45:00');
  assert.equal(second.planning_context.ends_at,'2026-09-23T10:00:00');
});

test('Trip range filtering uses household calendar dates for explicit UTC trips',async()=>{
  const {listTrips}=await import('../server/services/trips.js');
  const trip=saveTrip(d,{name:'Late household day Trip',starts_at:'2026-09-25T01:00:00Z',ends_at:'2026-09-25T02:00:00Z',participant_ids:[member]},member);
  assert.equal(listTrips(d,{from:'2026-09-24',to:'2026-09-24'}).some(row=>row.id===trip.id),true);
  assert.equal(listTrips(d,{from:'2026-09-25',to:'2026-09-25'}).some(row=>row.id===trip.id),false);
});
test('clearing a manual expiry and Place removes those saved values and their stale location belief',async()=>{
  const home=d.prepare("SELECT id FROM places WHERE type='home' ORDER BY id LIMIT 1").get();
  const response=await call('/planning/admin/periods',{user_id:member,source:'manual',state:'busy',place_id:home.id,
    starts_at:'2026-09-16T08:00:00',ends_at:'2026-09-16T09:00:00',note:'Clear optional fields'});
  assert.equal(response.status,201);
  const updated=await call(`/planning/admin/periods/${response.body.data.id}`,{ends_at:null,place_id:null},'PUT');
  assert.equal(updated.status,200); assert.equal(updated.body.data.ends_at,null); assert.equal(updated.body.data.place_id,null);
  const after=evaluateAvailability(d,{userId:member,startAt:'2026-09-17T10:00:00',nowAt:'2026-09-17T10:00:00',policy:'available_before_due'});
  assert.equal(after.eligible,false); assert.match(after.reason,/Clear optional fields.*busy/);
  assert.equal(after.current_presence.place,null); assert.match(after.current_presence.reason,/location is unknown/i);
});

test('UTC Trip itinerary groups departure, return, Tasks and meals on their household date',async()=>{
  const {tripItinerary}=await import('../server/services/trips.js');
  const trip=saveTrip(d,{name:'Evening UTC itinerary',starts_at:'2026-10-04T01:00:00Z',ends_at:'2026-10-04T02:00:00Z',participant_ids:[member],
    tasks:[{phase:'departure',title:'Evening departure Task'}]},member);
  const meal=Number(d.prepare("INSERT INTO meals(date,meal_type,title,created_by,planning_context_id) VALUES('2026-10-03','dinner','Evening travel dinner',?,?)")
    .run(member,trip.planning_context_id).lastInsertRowid);
  const itinerary=tripItinerary(d,trip.id);
  const evening=itinerary.days['2026-10-03'];
  assert.ok(evening.stages.some(row=>row.phase==='departure'));
  assert.ok(evening.stages.some(row=>row.phase==='return_home'));
  assert.ok(evening.tasks.some(row=>row.title==='Evening departure Task'));
  assert.ok(evening.meals.some(row=>row.id===meal));
  assert.equal(itinerary.days['2026-10-04']?.stages.some(row=>['departure','return_home'].includes(row.phase))||false,false);
});

test('Trip itinerary finds adjacent-UTC-day events and recurring instances without showing padded days',async()=>{
  const {tripItinerary}=await import('../server/services/trips.js');
  const trip=saveTrip(d,{name:'Household evening itinerary',starts_at:'2026-10-06T20:00:00',ends_at:'2026-10-06T23:00:00',participant_ids:[member]},member);
  const event=(title,start,end,rule=null)=>{
    const id=Number(d.prepare('INSERT INTO calendar_events(title,start_datetime,end_datetime,recurrence_rule,created_by) VALUES(?,?,?,?,?)')
      .run(title,start,end,rule,member).lastInsertRowid);
    d.prepare('INSERT INTO calendar_travel_details(calendar_event_id,planning_context_id) VALUES(?,?)').run(id,trip.planning_context_id);
    return id;
  };
  const evening=event('Evening train','2026-10-07T01:15:00Z','2026-10-07T01:45:00Z');
  const daily=event('Daily connection','2026-10-05T01:00:00Z','2026-10-05T01:10:00Z','FREQ=DAILY;COUNT=4');
  const nextDay=event('Next day outside this Trip','2026-10-07T16:00:00Z','2026-10-07T17:00:00Z');
  const allDay=event('All-day travel note','2026-10-06','2026-10-07');
  d.prepare('UPDATE calendar_events SET all_day=1 WHERE id=?').run(allDay);
  const itinerary=tripItinerary(d,trip.id);
  const events=itinerary.days['2026-10-06'].events;
  assert.ok(events.some(row=>row.id===evening));
  assert.ok(events.some(row=>row.id===allDay),'date-only all-day events retain their declared date');
  assert.equal(events.filter(row=>row.id===daily).length,1);
  assert.equal(events.find(row=>row.id===daily).start_datetime,'2026-10-07T01:00:00Z');
  assert.equal(Object.values(itinerary.days).flatMap(day=>day.events).some(row=>row.id===nextDay),false);
  assert.equal(Object.values(itinerary.days).flatMap(day=>day.events).filter(row=>row.id===daily).length,1);
});
