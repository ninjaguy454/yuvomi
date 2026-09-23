import {assertCapability} from '../permissions.js';
import {householdMembers, effectiveActivityProficiency} from './activity-eligibility.js';
import {activityPresenceWindow, evaluatePresence} from './presence.js';
import {todayKey} from '../utils/timezone.js';
import {orderedRotationSelection} from './rotation-order.js';
export {orderedRotationSelection} from './rotation-order.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HOUSEHOLD = 'household';
const STRATEGIES = ['round_robin','rotating_order','fixed_order'];
const DIRECTIONS = ['first_to_last','last_to_first'];
const POLICIES = ['manual','on_finalized','on_completed'];
const PRESENCE = ['ignore','must_be_home','must_be_at_location','must_be_away','available_before_due'];
export class RotationError extends Error {
  constructor(message, status=400, code='rotation_invalid') {super(message);this.status=status;this.code=code;}
}
function fail(message, status=400, code) {throw new RotationError(message,status,code);}
function text(value, name, max=160) {
  if(typeof value !== 'string' || !value.trim() || value.trim().length>max) fail(`Enter a valid ${name}.`);
  return value.trim();
}
function id(value,name='member') {
  const n=Number(value); if(!Number.isSafeInteger(n)||n<1)fail(`Choose a valid ${name}.`); return n;
}
function flag(value, fallback=false) {
  if(value===undefined)return fallback;
  if(![true,false,0,1].includes(value))fail('Choose a valid rotation setting.'); return !!value;
}
function ids(value) {
  if(!Array.isArray(value)||value.length>200)fail('Choose an ordered list of household members.');
  const result=value.map(n=>id(n));
  if(new Set(result).size!==result.length)fail('Each member can appear only once.');
  return result;
}
function revision(row,expected) {
  if(!Number.isSafeInteger(Number(expected))||Number(expected)!==Number(row.revision))
    fail('This rotation changed elsewhere. Refresh before applying your changes.',409,'rotation_stale');
}
function atomic(d,fn) {return d.transaction(fn).immediate();}
const schemaFeatures=new WeakMap();
function hasSharedSchema(d) {
  // Cache schema metadata only, invalidated by SQLite on every DDL change.
  // No household, permission, eligibility, or temporal decisions are cached.
  const version=d.pragma('schema_version',{simple:true}),cached=schemaFeatures.get(d);
  if(cached?.version===version)return cached.shared;
  const shared=!!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rotation_occurrence_supersessions'").get();
  schemaFeatures.set(d,{version,shared});return shared;
}
const supersessionProjection=`(SELECT json_object('occurrence_id',s.occurrence_id,'version_id',s.version_id,'actor_user_id',s.actor_user_id,'reason',s.reason,'created_at',s.created_at)
  FROM rotation_occurrence_supersessions s WHERE s.occurrence_id=o.id) AS supersession_json`;
function event(d,{groupId=null,trackId=null,occurrenceId=null,actorId=null,type,details={}}) {
  d.prepare('INSERT INTO rotation_events(group_id,track_id,occurrence_id,actor_user_id,event_type,details_json) VALUES(?,?,?,?,?,?)')
    .run(groupId,trackId,occurrenceId,actorId,type,JSON.stringify(details));
}
function memberships(d,groupId,{activeOnly=true}={}) {
  return d.prepare(`SELECT m.id membership_id,m.user_id id,m.sort_order,m.active,u.display_name,u.first_name,u.last_name,u.nickname
    FROM rotation_group_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.group_id=? ${activeOnly?'AND m.active=1':''}
    ORDER BY m.sort_order,m.id`).all(groupId).map(m=>({...m,display_name:m.display_name||'Former household member'}));
}
export function getRotationGroup(d,groupId) {
  const group=d.prepare('SELECT * FROM rotation_groups WHERE id=? AND household_key=?').get(id(groupId,'Rotation Group'),HOUSEHOLD);
  return group?{...group,members:memberships(d,group.id)}:null;
}
export function listRotationGroups(d,{includeInactive=false}={}) {
  return d.prepare(`SELECT id FROM rotation_groups WHERE household_key=? ${includeInactive?'':'AND active=1'} ORDER BY name COLLATE NOCASE,id`)
    .all(HOUSEHOLD).map(row=>getRotationGroup(d,row.id));
}
function survivingNext(previous, wanted, current, reverse=false) {
  const available=new Set(current.map(m=>m.membership_id));
  if(available.has(wanted))return wanted;
  const index=previous.findIndex(m=>m.membership_id===wanted);
  if(index>=0)for(let offset=1;offset<=previous.length;offset++) {
    const candidate=previous[(index+(reverse?-offset:offset)+previous.length)%previous.length].membership_id;
    if(available.has(candidate))return candidate;
  }
  return current[0]?.membership_id??null;
}
export function saveRotationGroup(d,input,{id:groupId=null,actorId,expectedRevision}={}) {
  assertCapability(d,actorId,'rotations.manage');
  return atomic(d,()=>{
    const old=groupId?getRotationGroup(d,groupId):null;
    if(groupId&&!old)fail('Rotation Group not found.',404);
    if(old)revision(old,expectedRevision??input.expected_revision);
    const name=text(input.name??old?.name,'Rotation Group name',120);
    const description=input.description===undefined?old?.description??null:String(input.description??'').trim()||null;
    if(description?.length>2000)fail('Description is limited to 2000 characters.');
    const active=flag(input.active,old?!!old.active:true);
    const memberIds=ids(input.member_ids??old?.members.filter(m=>m.id).map(m=>m.id)??[]);
    if(!memberIds.length&&(!old||active))fail('Add at least one household member.');
    if(memberIds.length>100)fail('A Rotation Group supports at most 100 household members.');
    const members=new Set(householdMembers(d).map(m=>m.id));
    if(memberIds.some(n=>!members.has(n)))fail('Choose members who currently belong to this household.');
    if(d.prepare('SELECT id FROM rotation_groups WHERE household_key=? AND name=? COLLATE NOCASE AND id!=?').get(HOUSEHOLD,name,groupId||0))
      fail('A Rotation Group already uses this name.');
    if(old&&old.name===name&&old.description===description&&!!old.active===active
      &&JSON.stringify(old.members.map(m=>m.id))===JSON.stringify(memberIds))return old;
    if(old)d.prepare(`UPDATE rotation_groups SET name=?,description=?,active=?,revision=revision+1,updated_at=${NOW} WHERE id=?`)
      .run(name,description,+active,old.id);
    else groupId=Number(d.prepare('INSERT INTO rotation_groups(name,description,active,created_by) VALUES(?,?,?,?)')
      .run(name,description,+active,actorId).lastInsertRowid);
    d.prepare(`UPDATE rotation_group_members SET active=0,removed_at=COALESCE(removed_at,${NOW}) WHERE group_id=? AND active=1`).run(groupId);
    memberIds.forEach((userId,order)=>d.prepare(`INSERT INTO rotation_group_members(group_id,user_id,sort_order) VALUES(?,?,?)
      ON CONFLICT(group_id,user_id) DO UPDATE SET active=1,removed_at=NULL,sort_order=excluded.sort_order`).run(groupId,userId,order));
    const saved=getRotationGroup(d,groupId);
    for(const track of d.prepare('SELECT * FROM rotation_tracks WHERE group_id=?').all(groupId)) {
      if(track.consumer_type==='rotation_group_schedule')continue;
      const next=survivingNext(old?.members||[],track.next_membership_id,saved.members,track.strategy==='rotating_order'&&track.direction==='last_to_first');
      d.prepare(`UPDATE rotation_tracks SET next_membership_id=?,group_revision=?,revision=revision+1,updated_at=${NOW} WHERE id=?`)
        .run(next,saved.revision,track.id);
    }
    event(d,{groupId,actorId,type:old?'group_updated':'group_created',details:{revision:saved.revision,member_ids:memberIds}});
    return saved;
  });
}
export function normalizeRotationConfiguration(d,input={}, {allowMissingReferences=false,group:resolvedGroup}={}) {
  const group=resolvedGroup||getRotationGroup(d,id(input.group_id,'Rotation Group'));
  if(!group)fail('Choose an existing Rotation Group.');
  const strategy=input.strategy??'round_robin',advance=input.advance_policy??'on_finalized',direction=input.direction??'first_to_last';
  if(!STRATEGIES.includes(strategy))fail('Choose Round Robin, Rotating Order, or Fixed Order.');
  if(!DIRECTIONS.includes(direction))fail('Choose First to last or Last to first for the rotation direction.');
  if(!POLICIES.includes(advance))fail('Choose when this rotation should advance.');
  const behavior=input.eligibility_behavior??'skip_unavailable';
  if(!['keep_position','skip_unavailable'].includes(behavior))fail('Choose how temporary unavailability affects this rotation.');
  const e=input.eligibility??{};
  if(!e||typeof e!=='object'||Array.isArray(e))fail('Invalid rotation eligibility settings.');
  const skillIds=ids(e.skill_ids??[]);
  if(!allowMissingReferences&&skillIds.some(n=>!d.prepare('SELECT 1 FROM skills WHERE id=?').get(n)))fail('Choose existing required Skills.');
  const presence=e.presence_policy??'ignore',window=e.presence_window??'completion';
  if(!PRESENCE.includes(presence)||!['start','due','completion'].includes(window))fail('Choose valid Availability / Presence settings.');
  const place=e.place_id==null?null:id(e.place_id,'Place');
  if(!allowMissingReferences&&place&&!d.prepare('SELECT 1 FROM places WHERE id=?').get(place))fail('Choose an existing Place.');
  return {group_id:group.id,strategy,direction,advance_policy:advance,advance_on_skip:flag(input.advance_on_skip),
    override_affects_next:flag(input.override_affects_next,true),eligibility_behavior:behavior,eligibility:{skill_ids:skillIds,
      include_supervised:flag(e.include_supervised),presence_policy:presence,presence_window:window,place_id:place}};
}
function hydrateTrack(row) {return row?{...row,eligibility:JSON.parse(row.eligibility_json)}:null;}
export function getRotationTrack(d,trackId,{usageDate}={}) {
  const withUsage=usageDate&&hasSharedSchema(d);
  return hydrateTrack(d.prepare(`SELECT t.*${withUsage?`,(SELECT v.usage_mode FROM rotation_group_schedule_versions v JOIN rotation_group_schedules s ON s.id=v.schedule_id
    WHERE s.group_id=t.group_id AND v.effective_date<=? ORDER BY v.effective_date DESC,v.id DESC LIMIT 1) AS _group_usage_mode`:''}
    FROM rotation_tracks t WHERE t.id=? AND t.household_key=?`).get(...(withUsage?[usageDate]:[]),id(trackId,'Rotation Track'),HOUSEHOLD));
}
export function findRotationTrack(d,{consumer_type,consumer_id,purpose_key}) {
  return hydrateTrack(d.prepare('SELECT * FROM rotation_tracks WHERE household_key=? AND consumer_type=? AND consumer_id=? AND purpose_key=?')
    .get(HOUSEHOLD,consumer_type,String(consumer_id),purpose_key));
}
function trackConfig(track) {return {group_id:track.group_id,strategy:track.strategy,direction:track.direction??'first_to_last',advance_policy:track.advance_policy,
  advance_on_skip:!!track.advance_on_skip,override_affects_next:!!track.override_affects_next,
  eligibility_behavior:track.eligibility_behavior,eligibility:track.eligibility};}
function groupUsageVersion(d,groupId,dateKey) {
  if(!hasSharedSchema(d))return null;
  return d.prepare(`SELECT v.id,v.usage_mode,v.independent_starts_json FROM rotation_group_schedule_versions v JOIN rotation_group_schedules s ON s.id=v.schedule_id
    WHERE s.group_id=? AND v.effective_date<=? ORDER BY v.effective_date DESC,v.id DESC LIMIT 1`).get(groupId,dateKey);
}
export function configureRotationTrack(d,input,{actorId=null,trusted=false,sharedSchedule=false,dateKey=todayKey(d)}={}) {
  if(!trusted)assertCapability(d,actorId,'rotations.configure');
  return atomic(d,()=>{
    const consumerType=text(input.consumer_type,'consumer type',80),consumerId=text(String(input.consumer_id??''),'consumer identity',512),purpose=text(input.purpose_key,'rotation purpose',120);
    if(consumerType==='rotation_group_schedule'&&!sharedSchedule)fail('Configure shared Rotation through its Group schedule.',409,'rotation_shared_owned');
    if(!/^[a-z][a-z0-9_]*$/.test(consumerType)||!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(purpose))fail('Use a stable rotation purpose key.');
    let old=findRotationTrack(d,{consumer_type:consumerType,consumer_id:consumerId,purpose_key:purpose});
    const config=normalizeRotationConfiguration(d,input,{allowMissingReferences:!!old});
    const label=input.label==null?old?.label??purpose:text(input.label,'rotation label',200);
    const unchanged=old&&JSON.stringify(trackConfig(old))===JSON.stringify(config)&&old.label===label;
    const usage=consumerType==='rotation_group_schedule'?null:groupUsageVersion(d,config.group_id,dateKey);
    let checkedRevision=false;
    const existingSeed=old?.group_id===config.group_id&&usage?.usage_mode==='independent'
      ?JSON.parse(usage.independent_starts_json).find(seed=>seed.consumer_type===consumerType&&String(seed.consumer_id)===consumerId&&seed.purpose_key===purpose):null;
    if(existingSeed&&!d.prepare('SELECT 1 FROM rotation_group_independent_seeds WHERE version_id=? AND track_id=?').get(usage.id,old.id)) {
      if(input.expected_revision!==undefined){revision(old,input.expected_revision);checkedRevision=true;}
      else if(!trusted)fail('Refresh this Rotation before applying its confirmed independent starting position.',409,'rotation_stale');
      old=correctRotationTrack(d,old.id,{next_member_id:existingSeed.next_member_id,expected_revision:old.revision,
        actorId,trusted:true,reason:'Confirmed return to independent Rotation'});
      d.prepare('INSERT INTO rotation_group_independent_seeds(version_id,track_id,next_member_id) VALUES(?,?,?)').run(usage.id,old.id,existingSeed.next_member_id);
    }
    if(unchanged)return old;
    if(usage?.usage_mode==='shared')fail('This Group owns the scheduled Rotation. Consumer-specific strategy and cursor settings cannot replace it.',409,'rotation_shared_owned');
    // Existing persisted references may become unavailable. New configuration
    // still validates strictly; reads/materialization fail closed below.
    normalizeRotationConfiguration(d,input);
    if(old&&!checkedRevision)revision(old,input.expected_revision);
    const group=getRotationGroup(d,config.group_id);
    if(!group.active)fail('Reactivate this Rotation Group before configuring new rotation work.',409,'rotation_group_inactive');
    let trackId=old?.id;
    let next=old?.group_id===group.id?old.next_membership_id:group.members[0]?.membership_id??null;
    let initialSeed=null;
    if((!old||old.group_id!==group.id)&&usage?.usage_mode==='independent') {
      initialSeed=JSON.parse(usage.independent_starts_json).find(seed=>seed.consumer_type===consumerType&&String(seed.consumer_id)===consumerId&&seed.purpose_key===purpose);
      if(initialSeed) {
        const member=group.members.find(value=>value.id===initialSeed.next_member_id);
        if(!member)fail('The confirmed independent starting member is no longer in the Group. Choose a new starting member.',409,'rotation_seed_unavailable');
        next=member.membership_id;
      }
    }
    if(old)d.prepare(`UPDATE rotation_tracks SET group_id=?,strategy=?,direction=?,advance_policy=?,advance_on_skip=?,override_affects_next=?,
      eligibility_json=?,eligibility_behavior=?,label=?,next_membership_id=?,group_revision=?,revision=revision+1,config_revision=config_revision+1,updated_at=${NOW} WHERE id=?`)
      .run(group.id,config.strategy,config.direction,config.advance_policy,+config.advance_on_skip,+config.override_affects_next,JSON.stringify(config.eligibility),config.eligibility_behavior,label,next,group.revision,old.id);
    else trackId=Number(d.prepare(`INSERT INTO rotation_tracks(consumer_type,consumer_id,purpose_key,label,group_id,strategy,direction,advance_policy,
      advance_on_skip,override_affects_next,eligibility_json,eligibility_behavior,next_membership_id,group_revision,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(consumerType,consumerId,purpose,label,group.id,config.strategy,config.direction,config.advance_policy,+config.advance_on_skip,+config.override_affects_next,
        JSON.stringify(config.eligibility),config.eligibility_behavior,next,group.revision,actorId).lastInsertRowid);
    if(initialSeed)d.prepare('INSERT INTO rotation_group_independent_seeds(version_id,track_id,next_member_id) VALUES(?,?,?)').run(usage.id,trackId,initialSeed.next_member_id);
    event(d,{groupId:group.id,trackId,actorId,type:old?'track_configured':'track_created',details:{purpose_key:purpose,config,...(initialSeed?{initial_next_member_id:initialSeed.next_member_id,seed_version_id:usage.id}: {})}});
    return getRotationTrack(d,trackId);
  });
}
function safeContext(context) {
  const result={};
  for(const key of ['task_id','dateKey','start_date','start_time','due_date','due_time','subject_user_id','place_id','workflow_instance_id','meal_id','label'])
    if(context[key]!=null&&['string','number'].includes(typeof context[key]))result[key]=context[key];
  return result;
}
// Prepared facts live only inside one synchronous operation. They never survive
// an intervening write or cross a request, and contain no cached authorization.
function prepareRotationPreview(d,track,{context={},eligibleUserIds,eligibilityExplanations={}}={},resolvedGroup) {
  const group=resolvedGroup||getRotationGroup(d,id(track.group_id,'Rotation Group'));
  const config=normalizeRotationConfiguration(d,track,{allowMissingReferences:!!track.id,group});
  const current=new Map(householdMembers(d).map(m=>[m.id,m]));
  const extra=eligibleUserIds===undefined?null:new Set(ids(eligibleUserIds));
  const dateKey=context.dateKey||context.due_date||context.start_date||todayKey(d);
  const skills=config.eligibility.skill_ids.map(n=>d.prepare('SELECT * FROM skills WHERE id=?').get(n));
  const configurationProblem=skills.some(skill=>!skill)?'A required Skill no longer exists. Reconfigure this rotation.'
    :config.eligibility.place_id&&!d.prepare('SELECT 1 FROM places WHERE id=?').get(config.eligibility.place_id)?'The configured Place no longer exists. Reconfigure this rotation.':null;
  const eligible=[],skipped=[];
  for(const member of group.members) {
    let reason=null;
    if(!group.active)reason='Rotation Group is inactive.';
    else if(configurationProblem)reason=configurationProblem;
    else if(!member.id||!current.has(member.id))reason='No longer a participating household member.';
    else if(extra&&!extra.has(member.id))reason=eligibilityExplanations[member.id]?.reason||'Not eligible in this consumer occurrence.';
    else if(eligibilityExplanations[member.id]?.eligible===false)reason=eligibilityExplanations[member.id].reason||'Not eligible for this occurrence.';
    else {
      const proficiency=effectiveActivityProficiency(d,null,current.get(member.id),dateKey,skills);
      if(proficiency.proficiency==='excluded'||proficiency.proficiency==='supervised'&&!config.eligibility.include_supervised)
        reason=proficiency.skills.filter(s=>s.proficiency!=='normal').map(s=>`${s.skill.name}: ${s.proficiency}`).join('; ')||'Required Skills are not met.';
      if(!reason&&config.eligibility.presence_policy!=='ignore') {
        const evaluated=evaluatePresence(d,{...activityPresenceWindow(d,{task:context,dateKey,windowMode:config.eligibility.presence_window}),
          userId:member.id,policy:config.eligibility.presence_policy,targetPlaceId:config.eligibility.place_id??context.place_id??null});
        if(!evaluated.eligible)reason=evaluated.reason||'The Availability / Presence requirement is not met.';
      }
    }
    if(reason)skipped.push({...member,reason});else eligible.push(member);
  }
  return {config,group,current,eligible,skipped,configurationProblem};
}
function selectRotationPreview(track,{config,group,current,eligible,skipped,configurationProblem}) {
  // Stable membership identity also preserves the ring when a user leaves the household.
  const next=track.next_membership_id??group.members[0]?.membership_id??null;
  const selection=orderedRotationSelection({memberIds:group.members.map(m=>m.membership_id),eligibleIds:eligible.map(m=>m.membership_id),nextMemberId:next,strategy:config.strategy,direction:config.direction});
  const nextMember=group.members.find(m=>m.membership_id===next);
  const waiting=config.eligibility_behavior==='keep_position'&&config.strategy!=='fixed_order'&&current.has(nextMember?.id)&&!eligible.some(m=>m.membership_id===next);
  if(waiting)selection.member_ids=[];
  const order=selection.member_ids.map((n,index)=>({...group.members.find(m=>m.membership_id===n),position:index+1}));
  return {track_id:track.id??null,group_id:group.id,group_revision:group.revision,strategy:config.strategy,config,
    members:group.members,eligible,skipped,order,member_ids:order.map(m=>m.id),selected_member:config.strategy==='round_robin'?order[0]??null:null,
    next_membership_id:selection.next_member_id,state:configurationProblem?'needs_configuration':order.length?'resolved':'unavailable',
    explanation:configurationProblem|| (waiting?'Keeping the next member’s position until they are eligible.':order.length?null:!group.active?'Rotation Group is inactive.':'No eligible household member is available.')};
}
export function previewRotation(d,trackOrConfig,options={}) {
  const track=typeof trackOrConfig==='number'?getRotationTrack(d,trackOrConfig):trackOrConfig;
  if(!track)fail('Rotation Track not found.',404);
  return selectRotationPreview(track,prepareRotationPreview(d,track,options,options.groupSnapshot));
}
function occurrenceRow(d,occurrenceId) {return d.prepare(`SELECT o.*${hasSharedSchema(d)?`,${supersessionProjection}`:''} FROM rotation_occurrences o JOIN rotation_tracks t ON t.id=o.track_id
  JOIN rotation_groups g ON g.id=o.group_id WHERE o.id=? AND t.household_key=? AND g.household_key=?`).get(id(occurrenceId,'Rotation Occurrence'),HOUSEHOLD,HOUSEHOLD);}
function hydrateOccurrence(row) {
  if(!row)return null;
  const {supersession_json,...value}=row;row=value;
  const order=JSON.parse(row.order_json),config=JSON.parse(row.config_json);
  return {...row,config,context:JSON.parse(row.context_json),members:JSON.parse(row.members_json),eligible:JSON.parse(row.eligible_json),
    skipped:JSON.parse(row.skipped_json),order,original_order:JSON.parse(row.original_order_json),member_ids:order.map(m=>m.id),
    selected_member:row.strategy==='round_robin'?order[0]??null:null,state:order.length?'resolved':'unavailable',
    ...(supersession_json?{supersession:JSON.parse(supersession_json)}:{})};
}
export function getRotationOccurrence(d,occurrenceId) {return hydrateOccurrence(occurrenceRow(d,occurrenceId));}
/** Explicit consumer conversion abandons a provisional decision without
 * claiming completion, skip, or advancement. Its original snapshot stays intact. */
export function supersedeRotationOccurrence(d,occurrenceId,{actorId=null,versionId=null,reason='Consumer changed to shared scheduled Rotation',trusted=false}={}) {
  if(!trusted)assertCapability(d,actorId,'rotations.configure');
  return atomic(d,()=>{
    const occurrence=getRotationOccurrence(d,occurrenceId);if(!occurrence)fail('Rotation Occurrence not found.',404);
    if(getRotationTrack(d,occurrence.track_id).consumer_type==='rotation_group_schedule')fail('A consumer conversion cannot supersede its Group-owned scheduled period.',409,'rotation_shared_owned');
    if(occurrence.supersession)return occurrence;
    if(occurrence.status!=='resolved')return occurrence;
    if(d.prepare('SELECT 1 FROM task_rotation_occurrences WHERE occurrence_id=? AND retired_at IS NULL LIMIT 1').get(occurrence.id))
      fail('This Rotation occurrence still has an active consumer.',409,'rotation_still_used');
    if(d.prepare('SELECT 1 FROM meal_occurrence_role_assignments WHERE rotation_occurrence_id=? LIMIT 1').get(occurrence.id)
      ||d.prepare('SELECT 1 FROM meal_occurrence_assignments WHERE rotation_occurrence_id=? LIMIT 1').get(occurrence.id))
      fail('This Rotation occurrence still has Meal assignment evidence.',409,'rotation_still_used');
    d.prepare('INSERT INTO rotation_occurrence_supersessions(occurrence_id,version_id,actor_user_id,reason) VALUES(?,?,?,?)').run(occurrence.id,versionId,actorId,text(reason,'supersession reason',1000));
    event(d,{groupId:occurrence.group_id,trackId:occurrence.track_id,occurrenceId:occurrence.id,actorId,type:'superseded',details:{version_id:versionId,reason}});
    return getRotationOccurrence(d,occurrence.id);
  });
}
export function resolveRotation(d,trackId,occurrenceKey,{context={},eligibleUserIds,eligibilityExplanations,expectedTrackRevision,actorId=null,sharedSchedule=false,groupSnapshot}={}) {
  return atomic(d,()=>{
    const dateKey=context.dateKey||context.due_date||context.start_date||todayKey(d);
    const loaded=getRotationTrack(d,trackId,{usageDate:dateKey});if(!loaded)fail('Rotation Track not found.',404);
    const {_group_usage_mode:usageMode,...track}=loaded;
    if(track.consumer_type==='rotation_group_schedule'&&!sharedSchedule)fail('Resolve shared Rotation through its scheduled period.',409,'rotation_shared_owned');
    const key=text(occurrenceKey,'occurrence identity',1000);
    const old=d.prepare('SELECT * FROM rotation_occurrences WHERE track_id=? AND occurrence_key=?').get(track.id,key);
    if(old)return hydrateOccurrence(old);
    if(track.consumer_type!=='rotation_group_schedule'&&usageMode==='shared')
      fail('This Group resolves through its shared scheduled period.',409,'rotation_shared_owned');
    const group=getRotationGroup(d,track.group_id);
    if(!group.active)fail('This Rotation Group is inactive. Reconfigure the consumer or reactivate the Group.',409,'rotation_group_inactive');
    if(expectedTrackRevision!==undefined)revision(track,expectedTrackRevision);
    const pending=d.prepare(`SELECT id,status,config_json FROM rotation_occurrences WHERE track_id=? AND
      (status='resolved' OR (status='finalized' AND json_extract(config_json,'$.advance_policy')='on_completed' AND advanced=0))
      ${hasSharedSchema(d)?'AND NOT EXISTS(SELECT 1 FROM rotation_occurrence_supersessions s WHERE s.occurrence_id=rotation_occurrences.id)':''} ORDER BY id LIMIT 1`).get(track.id);
    if(pending&&track.strategy!=='fixed_order')fail('Finalize or skip the previous rotation occurrence before resolving the next one.',409,'rotation_pending');
    const result=selectRotationPreview(track,prepareRotationPreview(d,track,{context:{...context,dateKey},eligibleUserIds,eligibilityExplanations},groupSnapshot||group));
    const occurrenceId=Number(d.prepare(`INSERT INTO rotation_occurrences(track_id,occurrence_key,group_id,group_revision,track_config_revision,track_correction_revision,
      strategy,config_json,context_json,consumer_eligibility_json,members_json,eligible_json,skipped_json,original_order_json,order_json,next_membership_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(track.id,key,result.group_id,result.group_revision,track.config_revision,track.correction_revision,result.strategy,
        JSON.stringify(result.config),JSON.stringify(safeContext(context)),eligibleUserIds!==undefined||eligibilityExplanations?JSON.stringify({eligibleUserIds,eligibilityExplanations}):null,JSON.stringify(result.members),JSON.stringify(result.eligible),
        JSON.stringify(result.skipped),JSON.stringify(result.order),JSON.stringify(result.order),result.next_membership_id).lastInsertRowid);
    d.prepare(`UPDATE rotation_tracks SET revision=revision+1,updated_at=${NOW} WHERE id=?`).run(track.id);
    event(d,{groupId:track.group_id,trackId:track.id,occurrenceId,actorId,type:'resolved'});
    return getRotationOccurrence(d,occurrenceId);
  });
}
export function overrideRotation(d,occurrenceId,{member_ids,expected_revision,actorId}={}) {
  assertCapability(d,actorId,'rotations.override');
  return atomic(d,()=>{
    const old=getRotationOccurrence(d,occurrenceId);if(!old)fail('Rotation Occurrence not found.',404);
    if(old.supersession)fail('This historical Rotation decision was superseded by a confirmed consumer conversion.',409,'rotation_superseded');
    revision(old,expected_revision);
    if(old.status!=='resolved')fail('Historical rotation results cannot be changed.',409,'rotation_historical');
    if(old.consumer_eligibility_json)fail('Override this selection through its owning consumer so its eligibility rules can be rechecked.',409);
    const owner=getRotationTrack(d,old.track_id);
    const groupSnapshot=owner.consumer_type==='rotation_group_schedule'?{...getRotationGroup(d,old.group_id),members:old.members}:undefined;
    const fresh=previewRotation(d,{...old.config,id:old.track_id},{context:old.context,groupSnapshot});
    const currentIds=new Set(fresh.eligible.map(member=>member.id));
    const selected=ids(member_ids),eligible=new Map(old.eligible.filter(member=>currentIds.has(member.id)).map(m=>[m.id,m]));
    if(!selected.length||selected.some(n=>!eligible.has(n))||(old.strategy==='round_robin'?selected.length!==1:selected.length!==eligible.size))
      fail('Choose the eligible member, or reorder every eligible member exactly once.');
    if(JSON.stringify(selected)===JSON.stringify(old.member_ids))return old;
    const order=selected.map((n,index)=>({...eligible.get(n),position:index+1}));
    d.prepare(`UPDATE rotation_occurrences SET order_json=?,override_actor_id=?,overridden_at=${NOW},revision=revision+1 WHERE id=?`)
      .run(JSON.stringify(order),actorId,old.id);
    event(d,{groupId:old.group_id,trackId:old.track_id,occurrenceId:old.id,actorId,type:'overridden',details:{previous_order:old.order,order}});
    return getRotationOccurrence(d,old.id);
  });
}
export function finalizeRotation(d,occurrenceId,{outcome='finalized',expectedRevision,actorId=null,trusted=false,manual=false,sharedSchedule=false}={}) {
  if(!trusted)assertCapability(d,actorId,'rotations.advance');
  if(!['finalized','completed','skipped'].includes(outcome))fail('Choose a valid rotation outcome.');
  return atomic(d,()=>{
    const old=getRotationOccurrence(d,occurrenceId);if(!old)fail('Rotation Occurrence not found.',404);
    if(old.supersession)fail('This historical Rotation decision was superseded by a confirmed consumer conversion.',409,'rotation_superseded');
    const shared=getRotationTrack(d,old.track_id).consumer_type==='rotation_group_schedule';
    if(shared&&!sharedSchedule)fail('This Rotation follows the Group schedule; individual consumers cannot finalize it.',409,'rotation_shared_owned');
    if(shared&&old.status!=='resolved'&&old.status!==outcome)fail('This rotation already has a different final outcome.',409,'rotation_finalized');
    if(old.status===outcome&&(!manual||old.advanced))return old;
    if(old.status==='completed'&&outcome==='finalized'&&!manual)return old;
    if(!trusted||expectedRevision!==undefined)revision(old,expectedRevision);
    if(old.status==='skipped'&&outcome!=='skipped'||old.status==='completed'&&outcome!=='completed'
      ||old.status==='finalized'&&outcome==='skipped'&&old.advanced)fail('This rotation already has a different final outcome.',409,'rotation_finalized');
    const track=getRotationTrack(d,old.track_id),config=old.config;
    const policyAllows=outcome==='skipped'?config.advance_on_skip
      :config.advance_policy==='on_finalized'||config.advance_policy==='on_completed'&&outcome==='completed'||config.advance_policy==='manual'&&manual;
    const mayAdvance=!old.advanced&&policyAllows&&old.order.length>0&&old.strategy!=='fixed_order'&&track.group_id===old.group_id
      &&track.correction_revision===old.track_correction_revision;
    if(mayAdvance&&d.prepare('SELECT 1 FROM rotation_occurrences WHERE track_id=? AND id>? LIMIT 1').get(track.id,old.id))
      fail('A later occurrence has already resolved. This earlier result cannot advance the current Track.',409,'rotation_stale');
    let reason=old.advance_reason||(!old.order.length?'no_eligible_members':old.strategy==='fixed_order'?'fixed_order':track.group_id!==old.group_id?'group_changed'
      :track.correction_revision!==old.track_correction_revision?'administrative_correction':policyAllows?'advanced':'policy_retained');
    if(mayAdvance) {
      const next=nextRotationMembership(d,old,track);
      d.prepare(`UPDATE rotation_tracks SET next_membership_id=?,advance_count=advance_count+1,revision=revision+1,updated_at=${NOW} WHERE id=?`)
        .run(next,track.id);
      reason='advanced';
    }
    if(old.status===outcome&&!mayAdvance)return old;
    d.prepare(`UPDATE rotation_occurrences SET status=?,advanced=?,advance_reason=?,finalized_at=COALESCE(finalized_at,${NOW}),revision=revision+1 WHERE id=?`)
      .run(outcome,old.advanced||mayAdvance?1:0,reason,old.id);
    if(old.status!==outcome)event(d,{groupId:old.group_id,trackId:track.id,occurrenceId:old.id,actorId,type:outcome,details:{advanced:!!(old.advanced||mayAdvance),reason}});
    else if(mayAdvance)event(d,{groupId:old.group_id,trackId:track.id,occurrenceId:old.id,actorId,type:'advanced',details:{manual:true}});
    return getRotationOccurrence(d,old.id);
  });
}
export function skipRotation(d,occurrenceId,options={}) {return finalizeRotation(d,occurrenceId,{...options,outcome:'skipped'});}
/** The same next-position rule is used for a provisional temporal forecast and
 * authoritative finalization. It never writes or advances a Track. */
export function nextRotationMembership(d,occurrence,track=getRotationTrack(d,occurrence.track_id)) {
  let wanted=occurrence.next_membership_id;
  if(occurrence.config.override_affects_next&&occurrence.overridden_at) {
    if(occurrence.strategy==='rotating_order'&&occurrence.config.direction==='last_to_first'&&occurrence.order.length)wanted=occurrence.order.at(-1).membership_id;
    else if(occurrence.strategy==='rotating_order'&&occurrence.order.length>1)wanted=occurrence.order[1].membership_id;
    else wanted=orderedRotationSelection({memberIds:occurrence.members.map(m=>m.membership_id),eligibleIds:occurrence.members.map(m=>m.membership_id),previousMemberId:occurrence.order[0]?.membership_id}).member_ids[0]??null;
  }
  const household=track.consumer_type==='rotation_group_schedule'?new Set(householdMembers(d).map(member=>member.id)):null;
  const current=household?occurrence.members.filter(member=>household.has(member.id)):memberships(d,track.group_id);
  return survivingNext(occurrence.members,wanted,current,occurrence.strategy==='rotating_order'&&occurrence.config.direction==='last_to_first');
}
export function rotationHistory(d,trackId,{limit=100}={}) {
  const track=getRotationTrack(d,trackId);if(!track)fail('Rotation Track not found.',404);
  const n=Math.min(200,Math.max(1,Number(limit)||100));
  return d.prepare(`SELECT o.*${hasSharedSchema(d)?`,${supersessionProjection}`:''} FROM rotation_occurrences o WHERE track_id=? ORDER BY id DESC LIMIT ?`).all(track.id,n).map(hydrateOccurrence);
}
export function rotationTrackEvents(d,trackId,{limit=100}={}) {
  const track=getRotationTrack(d,trackId);if(!track)fail('Rotation Track not found.',404);
  const n=Math.min(200,Math.max(1,Number(limit)||100));
  return d.prepare(`SELECT e.id,e.track_id,e.event_type,e.details_json,e.actor_user_id,e.created_at,u.display_name AS actor_name
    FROM rotation_events e LEFT JOIN users u ON u.id=e.actor_user_id
    WHERE e.track_id=? AND e.event_type='track_corrected' ORDER BY e.id DESC LIMIT ?`).all(track.id,n)
    .map(row=>({...row,details:JSON.parse(row.details_json)}));
}
export function inspectRotationTrack(d,trackId) {
  const track=getRotationTrack(d,trackId);if(!track)return null;
  const previews=previewSequence(track,prepareRotationPreview(d,track),3);
  const latest=hydrateOccurrence(d.prepare('SELECT * FROM rotation_occurrences WHERE track_id=? ORDER BY id DESC LIMIT 1').get(track.id));
  return {...track,next:previews[0],previews,latest};
}

/** Hypothetical successive successful/finalized uses; no records or writes. */
export function previewRotationSequence(d,trackId,{count=3,...options}={}) {
  const track=getRotationTrack(d,trackId);if(!track)fail('Rotation Track not found.',404);
  return previewSequence(track,prepareRotationPreview(d,track,options),count);
}
function previewSequence(track,prepared,count) {
  const result=[];
  for(let n=0;n<Math.min(10,Math.max(1,Number(count)||3));n++) {
    const preview=selectRotationPreview(track,prepared);result.push(preview);
    if(preview.order.length&&track.strategy!=='fixed_order')track={...track,next_membership_id:preview.next_membership_id};
  }
  return result;
}
export function correctRotationTrack(d,trackId,{next_member_id,expected_revision,reason=null,actorId,trusted=false}={}) {
  if(!trusted)assertCapability(d,actorId,'rotations.correct');
  return atomic(d,()=>{
    const track=getRotationTrack(d,trackId);if(!track)fail('Rotation Track not found.',404);
    revision(track,expected_revision);
    const members=memberships(d,track.group_id),member=members.find(m=>m.id===id(next_member_id));
    if(!member||!householdMembers(d).some(m=>m.id===member.id))fail('Choose a current member of this Rotation Group.');
    const note=reason==null?null:text(reason,'correction reason',1000);
    d.prepare(`UPDATE rotation_tracks SET next_membership_id=?,correction_revision=correction_revision+1,revision=revision+1,updated_at=${NOW} WHERE id=?`)
      .run(member.membership_id,track.id);
    const previous=members.find(m=>m.membership_id===track.next_membership_id);
    event(d,{groupId:track.group_id,trackId:track.id,actorId,type:'track_corrected',details:{previous_next_membership_id:track.next_membership_id,
      previous_next_member_id:previous?.id??null,previous_next_member_name:previous?.display_name??null,
      next_membership_id:member.membership_id,next_member_id:member.id,next_member_name:member.display_name,reason:note}});
    return getRotationTrack(d,track.id);
  });
}
/** An unavailable provisional result can be retried explicitly once facts change. */
export function refreshRotationOccurrence(d,occurrenceId,{expected_revision,expectedRevision,actorId,trusted=false,eligibleUserIds,eligibilityExplanations,context}={}) {
  if(!trusted)assertCapability(d,actorId,'rotations.override');
  return atomic(d,()=>{
    const old=getRotationOccurrence(d,occurrenceId);if(!old)fail('Rotation Occurrence not found.',404);
    revision(old,expected_revision??expectedRevision);
    if(old.status!=='resolved'||old.order.length)fail('Only an unresolved occurrence can have its eligibility checked again.',409);
    const track=getRotationTrack(d,old.track_id);
    if(track.group_id!==old.group_id||track.config_revision!==old.track_config_revision)fail('The consumer configuration changed. Reconfigure this occurrence explicitly.',409);
    if(!getRotationGroup(d,old.group_id).active)fail('Reactivate the Rotation Group before resolving this occurrence.',409);
    // Consumer-specific exclusions cannot be re-evaluated outside their owner.
    if(old.consumer_eligibility_json&&(!trusted||eligibleUserIds===undefined))fail('Recheck this occurrence from its Activity, Workflow or Meal consumer.',409);
    const resolvedContext=trusted&&context?context:old.context;
    const groupSnapshot=track.consumer_type==='rotation_group_schedule'?{...getRotationGroup(d,old.group_id),members:old.members}:undefined;
    const result=previewRotation(d,track,{context:resolvedContext,eligibleUserIds,eligibilityExplanations,groupSnapshot});
    d.prepare('UPDATE rotation_occurrences SET members_json=?,eligible_json=?,skipped_json=?,order_json=?,next_membership_id=?,context_json=?,consumer_eligibility_json=?,group_revision=?,revision=revision+1 WHERE id=?')
      .run(JSON.stringify(result.members),JSON.stringify(result.eligible),JSON.stringify(result.skipped),JSON.stringify(result.order),result.next_membership_id,
        JSON.stringify(safeContext(resolvedContext)),eligibleUserIds!==undefined||eligibilityExplanations?JSON.stringify({eligibleUserIds,eligibilityExplanations}):null,result.group_revision,old.id);
    event(d,{groupId:old.group_id,trackId:old.track_id,occurrenceId:old.id,actorId,type:'eligibility_rechecked',details:{member_ids:result.member_ids,group_revision:result.group_revision,
      previous:{group_revision:old.group_revision,members:old.members,eligible:old.eligible,skipped:old.skipped,order:old.order}}});
    return getRotationOccurrence(d,old.id);
  });
}
