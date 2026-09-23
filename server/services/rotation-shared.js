/** Optional Group-owned temporal consumer of the canonical Rotation engine.
 * Reads only preview. Explicit writes/startup reconciliation own activation. */
import {createHash} from 'node:crypto';
import {assertCapability} from '../permissions.js';
import {householdTimeZone,todayKey,shiftDateKey,daysBetweenDateKeys,utcToWall} from '../utils/timezone.js';
import {availabilityInstantMs} from './presence.js';
import {getRotationGroup,saveRotationGroup,getRotationTrack,findRotationTrack,configureRotationTrack,
  normalizeRotationConfiguration,previewRotation,resolveRotation,getRotationOccurrence,finalizeRotation,correctRotationTrack,
  nextRotationMembership,orderedRotationSelection} from './rotation.js';
import {projectRotationTrack} from './rotation-access.js';

const callbacks=new Set();
const usageCollectors=new Set();
const forecastDays=366;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const json=value=>JSON.stringify(stable(value));
const fail=(message,status=400,code='rotation_shared_invalid')=>{throw Object.assign(new Error(message),{status,code});};
const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&daysBetweenDateKeys(value,value)===0;
const isTime=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(value||'');
const scheduleRow=(d,id)=>d.prepare('SELECT * FROM rotation_group_schedules WHERE group_id=?').get(id);
function versionRow(d,schedule,dateKey=null) {
  return schedule?d.prepare(`SELECT * FROM rotation_group_schedule_versions WHERE schedule_id=? ${dateKey?'AND effective_date<=?':''}
    ORDER BY ${dateKey?'effective_date DESC,':''}id DESC LIMIT 1`).get(...(dateKey?[schedule.id,dateKey]:[schedule.id])):null;
}
function configOf(version) {return version?{...(version.usage_mode==='shared'?{direction:'first_to_last'}:{}),...JSON.parse(version.config_json),effective_date:version.effective_date,timezone:version.timezone}:null;}
export function registerSharedRotationReconciler(fn) {callbacks.add(fn);return()=>callbacks.delete(fn);}
export function registerSharedRotationUsageCollector(fn) {usageCollectors.add(fn);return()=>usageCollectors.delete(fn);}
export function notifySharedRotationReconciliation(d,{groupId,dateKey,periodDate=dateKey,occurrence=null,reason,now=new Date()}={}) {
  if(!dateKey&&!periodDate&&occurrence?.id)dateKey=d.prepare('SELECT period_date FROM rotation_group_periods WHERE occurrence_id=?').get(occurrence.id)?.period_date;
  const preserved=[];
  for(const fn of callbacks) {
    const result=fn(d,{groupId,dateKey:dateKey||periodDate,periodDate:periodDate||dateKey,occurrence,
      occurrenceId:occurrence?.id??null,reason,now});
    preserved.push(...(result?.preserved||[]));
  }
  return {preserved};
}
export function sharedGroupConfiguration(d,groupId,dateKey=todayKey(d)) {
  const schedule=scheduleRow(d,groupId),version=versionRow(d,schedule,dateKey);
  if(!version||version.usage_mode!=='shared')return null;
  const c=configOf(version);
  return {...normalizeRotationConfiguration(d,{...c,group_id:groupId,advance_policy:'on_finalized'},{allowMissingReferences:true}),
    usage_mode:'shared',track_id:schedule.track_id,starting_member_id:c.starting_member_id,version_id:version.id,
    schedule:{effective_date:version.effective_date,weekdays:c.weekdays,active_time:c.active_time,finalize_time:c.finalize_time,
      finalize_day_offset:c.finalize_day_offset,timezone:version.timezone}};
}
export function independentGroupSeed(d,groupId,{consumer_type,consumer_id,purpose_key,dateKey=todayKey(d)}={}) {
  const version=versionRow(d,scheduleRow(d,groupId),dateKey);
  if(!version||version.usage_mode!=='independent')return null;
  return JSON.parse(version.independent_starts_json).find(item=>item.consumer_type===consumer_type&&String(item.consumer_id)===String(consumer_id)&&item.purpose_key===purpose_key)?.next_member_id??null;
}
/** Read-only provenance for consumer decisions after an explicit mode boundary. */
export function rotationGroupUsageVersion(d,groupId,dateKey=todayKey(d)) {
  const version=versionRow(d,scheduleRow(d,groupId),dateKey);
  return version?{id:version.id,usage_mode:version.usage_mode}:null;
}
function applyIndependentBoundary(d,schedule,version,now) {
  if(schedule.applied_version_id===version.id)return;
  for(const seed of JSON.parse(version.independent_starts_json)) {
    const track=findRotationTrack(d,seed);if(!track||track.group_id!==schedule.group_id)continue;
    if(d.prepare('SELECT 1 FROM rotation_group_independent_seeds WHERE version_id=? AND track_id=?').get(version.id,track.id))continue;
    correctRotationTrack(d,track.id,{next_member_id:seed.next_member_id,expected_revision:track.revision,
      actorId:version.actor_user_id,trusted:true,reason:'Confirmed return to independent Rotation'});
    d.prepare('INSERT INTO rotation_group_independent_seeds(version_id,track_id,next_member_id) VALUES(?,?,?)').run(version.id,track.id,seed.next_member_id);
  }
  d.prepare('UPDATE rotation_group_schedules SET applied_version_id=?,revision=revision+1 WHERE id=?').run(version.id,schedule.id);
  notifySharedRotationReconciliation(d,{groupId:schedule.group_id,dateKey:version.effective_date,reason:'independent_boundary',now});
}
function nominalWeekday(dateKey){return new Date(`${dateKey}T12:00:00Z`).getUTCDay();}
function period(d,groupId,dateKey) {
  if(!isDate(dateKey))fail('Choose a valid Rotation period date.');
  const schedule=scheduleRow(d,groupId),version=versionRow(d,schedule,dateKey);
  if(!version||version.usage_mode!=='shared')return null;
  const config=configOf(version);
  if(!config.weekdays.includes(nominalWeekday(dateKey)))return null;
  const starts=availabilityInstantMs(`${dateKey}T${config.active_time}`,version.timezone);
  const ends=availabilityInstantMs(`${shiftDateKey(dateKey,config.finalize_day_offset)}T${config.finalize_time}`,version.timezone);
  if(starts==null||ends==null||ends<=starts)fail('This shared Rotation period has an invalid local window.',409);
  return {schedule,version,config,dateKey,starts,ends,starts_at:new Date(starts).toISOString(),ends_at:new Date(ends).toISOString()};
}
function groupSnapshot(d,p) {
  const current=getRotationGroup(d,p.schedule.group_id);
  // The planned baseline is a versioned snapshot; current eligibility still
  // excludes users who have left and an inactive Group cannot resolve.
  return {...current,members:JSON.parse(p.version.members_json)};
}
function canonicalConfig(groupId,config) {
  return {...config,group_id:groupId,advance_policy:'on_finalized',consumer_type:'rotation_group_schedule',consumer_id:String(groupId),purpose_key:'shared'};
}
function trackForPreview(d,p) {
  const existing=p.schedule.track_id?getRotationTrack(d,p.schedule.track_id):null;
  const members=JSON.parse(p.version.members_json),start=members.find(member=>member.id===p.config.starting_member_id)?.membership_id;
  return {...existing,...canonicalConfig(p.schedule.group_id,p.config),id:existing?.id??null,
    next_membership_id:p.schedule.applied_version_id===p.version.id?existing?.next_membership_id:start};
}
export function previewSharedRotation(d,groupId,{dateKey=todayKey(d),now=new Date()}={}) {
  const p=period(d,groupId,dateKey);if(!p)return null;
  const existing=d.prepare('SELECT occurrence_id FROM rotation_group_periods WHERE schedule_id=? AND period_date=?').get(p.schedule.id,dateKey);
  if(existing)return {...getRotationOccurrence(d,existing.occurrence_id),period_date:dateKey};
  let track=trackForPreview(d,p);
  const last=d.prepare('SELECT * FROM rotation_group_periods WHERE schedule_id=? AND period_date<? ORDER BY period_date DESC LIMIT 1').get(p.schedule.id,dateKey);
  let from=p.version.effective_date;
  if(last&&last.version_id===p.version.id) {
    const occurrence=getRotationOccurrence(d,last.occurrence_id);
    if(!occurrence.advanced&&occurrence.status==='resolved'&&occurrence.order.length&&occurrence.strategy!=='fixed_order'
      &&occurrence.track_correction_revision===track.correction_revision)
      track={...track,next_membership_id:nextRotationMembership(d,occurrence,track)};
    from=shiftDateKey(last.period_date,1);
  }
  if(daysBetweenDateKeys(from,dateKey)>forecastDays) {
    const preview=previewRotation(d,track,{groupSnapshot:groupSnapshot(d,p),context:{dateKey,start_date:dateKey,start_time:p.config.active_time,
      due_date:shiftDateKey(dateKey,p.config.finalize_day_offset),due_time:p.config.finalize_time}});
    return {...preview,id:0,revision:0,status:'preview',order:[],member_ids:[],selected_member:null,next_membership_id:null,
      period_date:dateKey,starts_at:p.starts_at,ends_at:p.ends_at,provisional:true,forecast_pending:true,
      explanation:'Planned order is not yet available beyond the 366-day forecast horizon. It will be confirmed when this period activates.'};
  }
  for(let at=from;at<dateKey;at=shiftDateKey(at,1)) {
    const earlier=period(d,groupId,at);if(!earlier||earlier.version.id!==p.version.id)continue;
    const projected=previewRotation(d,track,{groupSnapshot:groupSnapshot(d,earlier),context:{dateKey:at,start_date:at,start_time:earlier.config.active_time,
      due_date:shiftDateKey(at,earlier.config.finalize_day_offset),due_time:earlier.config.finalize_time}});
    if(projected.order.length&&track.strategy!=='fixed_order')track={...track,next_membership_id:projected.next_membership_id};
  }
  const preview=previewRotation(d,track,{groupSnapshot:groupSnapshot(d,p),context:{dateKey,start_date:dateKey,start_time:p.config.active_time,
    due_date:shiftDateKey(dateKey,p.config.finalize_day_offset),due_time:p.config.finalize_time}});
  return {...preview,id:0,revision:0,status:'preview',period_date:dateKey,starts_at:p.starts_at,ends_at:p.ends_at,
    provisional:true,explanation:Number(now)<p.starts?'Planned order; confirmed when this scheduled period begins.':preview.explanation};
}
function applyVersion(d,p,{now=new Date()}={}) {
  if(p.schedule.applied_version_id===p.version.id)return;
  let track=p.schedule.track_id?getRotationTrack(d,p.schedule.track_id):null;
  track=configureRotationTrack(d,{...canonicalConfig(p.schedule.group_id,p.config),label:getRotationGroup(d,p.schedule.group_id).name,
    expected_revision:track?.revision},{trusted:true,sharedSchedule:true,actorId:p.version.actor_user_id});
  if(p.config.starting_member_id&&p.schedule.applied_version_id!=null)track=correctRotationTrack(d,track.id,{next_member_id:p.config.starting_member_id,
    expected_revision:track.revision,reason:'Confirmed shared schedule boundary',actorId:p.version.actor_user_id,trusted:true});
  else if(p.config.starting_member_id&&track.next_membership_id!==JSON.parse(p.version.members_json).find(member=>member.id===p.config.starting_member_id)?.membership_id)
    track=correctRotationTrack(d,track.id,{next_member_id:p.config.starting_member_id,expected_revision:track.revision,
      reason:'Configured shared starting member',actorId:p.version.actor_user_id,trusted:true});
  d.prepare('UPDATE rotation_group_schedules SET track_id=?,applied_version_id=?,revision=revision+1 WHERE id=?').run(track.id,p.version.id,p.schedule.id);
  p.schedule={...p.schedule,track_id:track.id,applied_version_id:p.version.id};
}
function activate(d,p,{now=new Date(),actorId=null}={}) {
  const existing=d.prepare('SELECT occurrence_id FROM rotation_group_periods WHERE schedule_id=? AND period_date=?').get(p.schedule.id,p.dateKey);
  if(existing)return getRotationOccurrence(d,existing.occurrence_id);
  applyVersion(d,p,{now});
  const track=getRotationTrack(d,p.schedule.track_id);
  const occurrence=resolveRotation(d,track.id,`group-period:${p.schedule.id}:${p.dateKey}`,{actorId,sharedSchedule:true,groupSnapshot:groupSnapshot(d,p),
    expectedTrackRevision:track.revision,context:{dateKey:p.dateKey,start_date:p.dateKey,start_time:p.config.active_time,
      due_date:shiftDateKey(p.dateKey,p.config.finalize_day_offset),due_time:p.config.finalize_time}});
  d.prepare('INSERT INTO rotation_group_periods(schedule_id,version_id,period_date,starts_at,ends_at,occurrence_id) VALUES(?,?,?,?,?,?)')
    .run(p.schedule.id,p.version.id,p.dateKey,p.starts_at,p.ends_at,occurrence.id);
  notifySharedRotationReconciliation(d,{groupId:p.schedule.group_id,dateKey:p.dateKey,occurrence,reason:'period_activated',now});
  return {...occurrence,period_date:p.dateKey};
}
export function resolveSharedRotation(d,groupId,{dateKey=todayKey(d),now=new Date(),actorId=null}={}) {
  return d.transaction(()=>{
    const p=period(d,groupId,dateKey);if(!p)return null;
    const existing=d.prepare('SELECT occurrence_id FROM rotation_group_periods WHERE schedule_id=? AND period_date=?').get(p.schedule.id,dateKey);
    if(existing)return {...getRotationOccurrence(d,existing.occurrence_id),period_date:dateKey};
    // A Task may activate the presently open period, never advance time or close
    // an earlier occurrence. Catch-up belongs exclusively to the scheduler.
    if(Number(now)<p.starts||Number(now)>=p.ends)return previewSharedRotation(d,groupId,{dateKey,now});
    const last=d.prepare('SELECT period_date FROM rotation_group_periods WHERE schedule_id=? ORDER BY period_date DESC LIMIT 1').get(p.schedule.id);
    const first=d.prepare('SELECT min(effective_date) value FROM rotation_group_schedule_versions WHERE schedule_id=?').get(p.schedule.id).value;
    const unprocessedFrom=last?shiftDateKey(last.period_date,1):first;
    // Long gaps must be recovered by the bounded background coordinator, not a
    // single Task materialization request. Never assume unscanned dates are clear.
    if(daysBetweenDateKeys(unprocessedFrom,dateKey)>forecastDays)return previewSharedRotation(d,groupId,{dateKey,now});
    for(let at=unprocessedFrom;at<dateKey;at=shiftDateKey(at,1)) {
      const missing=period(d,groupId,at);
      if(missing&&missing.starts<=Number(now))return previewSharedRotation(d,groupId,{dateKey,now});
    }
    const prior=p.schedule.track_id&&d.prepare("SELECT 1 FROM rotation_occurrences WHERE track_id=? AND status='resolved' LIMIT 1").get(p.schedule.track_id);
    if(prior)return previewSharedRotation(d,groupId,{dateKey,now});
    return activate(d,p,{now,actorId});
  }).immediate();
}
export function reconcileSharedRotationPeriods(d,{now=new Date(),limit=100,groupId=null,onError=()=>{}}={}) {
  const result={activated:0,finalized:0,failed:0,limited:false};let remaining=Math.min(1000,Math.max(1,Number(limit)||100));
  const schedules=d.prepare(`SELECT s.* FROM rotation_group_schedules s JOIN rotation_groups g ON g.id=s.group_id WHERE g.active=1 ${groupId?'AND s.group_id=?':''} ORDER BY s.id`).all(...(groupId?[groupId]:[]));
  for(const original of schedules) {
    try {
      const versions=d.prepare('SELECT * FROM rotation_group_schedule_versions WHERE schedule_id=? ORDER BY effective_date,id').all(original.id);
      if(!versions.length)continue;
      const last=d.prepare('SELECT period_date FROM rotation_group_periods WHERE schedule_id=? ORDER BY period_date DESC LIMIT 1').get(original.id);
      let date=last?.period_date||versions[0].effective_date;
      // Versions retain the zone in which their schedule was approved. A later
      // household-zone change must not defer an already-due configured period.
      const instant=new Date(now).toISOString();
      const finalDate=versions.map(version=>utcToWall(instant,version.timezone)?.date).filter(Boolean).sort().at(-1)??todayKey(d,now);
      const currentVersion=versionRow(d,original,finalDate);
      if(currentVersion?.usage_mode==='independent'&&original.applied_version_id===currentVersion.id
        &&!d.prepare("SELECT 1 FROM rotation_group_periods p JOIN rotation_occurrences o ON o.id=p.occurrence_id WHERE p.schedule_id=? AND o.status='resolved' LIMIT 1").get(original.id))continue;
      // Each committed period is its own bounded recovery unit. Restart resumes
      // the last period; uniqueness and canonical finalization make retry safe.
      for(let days=0;date<=finalDate&&days<36600;days++,date=shiftDateKey(date,1)) {
        if(remaining<=0){result.limited=true;break;}
        const currentSchedule=scheduleRow(d,original.group_id),version=versionRow(d,currentSchedule,date);
        if(version?.usage_mode==='independent') {
          if(availabilityInstantMs(`${date}T00:00`,version.timezone)>Number(now))break;
          d.transaction(()=>applyIndependentBoundary(d,currentSchedule,version,now)).immediate();continue;
        }
        const p=period(d,original.group_id,date);if(!p)continue;
        if(p.starts>Number(now))break;
        d.transaction(()=>{
          const before=d.prepare('SELECT occurrence_id FROM rotation_group_periods WHERE schedule_id=? AND period_date=?').get(original.id,date);
          const occurrence=activate(d,p,{now});if(!before){result.activated++;remaining--;}
          if(p.ends<=Number(now)&&occurrence.status==='resolved') {
            finalizeRotation(d,occurrence.id,{trusted:true,sharedSchedule:true,expectedRevision:occurrence.revision});result.finalized++;
            notifySharedRotationReconciliation(d,{groupId:original.group_id,dateKey:date,occurrence:getRotationOccurrence(d,occurrence.id),reason:'period_finalized',now});
          }
        }).immediate();
      }
    }catch(error){result.failed++;onError(error,original.group_id);}
    if(remaining<=0){result.limited=true;break;}
  }
  return result;
}
function normalizedInput(d,input,old,now) {
  const savedVersion=versionRow(d,scheduleRow(d,old?.id));
  const usage=input.usage_mode??savedVersion?.usage_mode??'independent';
  if(!['independent','shared'].includes(usage))fail('Choose independent or shared scheduled Rotation.');
  const raw={...(configOf(savedVersion)||{}),...(input.shared_config||{})};
  const effective=String(input.effective_date??input.shared_config?.effective_date??raw.effective_date??todayKey(d,now));
  if(!isDate(effective))fail('Choose a valid effective date.');
  const members=input.member_ids??old?.members.filter(member=>member.id).map(member=>member.id)??[];
  let config={effective_date:effective};
  if(usage==='shared') {
    const weekdays=[...new Set(raw.weekdays??[0,1,2,3,4,5,6])].sort((a,b)=>a-b);
    if(!weekdays.length||weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))fail('Choose at least one valid weekday.');
    const active_time=raw.active_time??'00:00',finalize_time=raw.finalize_time??'23:59',offset=raw.finalize_day_offset??0;
    if(!isTime(active_time)||!isTime(finalize_time)||![0,1].includes(offset)||(!offset&&finalize_time<=active_time))fail('The finalization time must follow the active time.');
    if(offset&&finalize_time>active_time)fail('A shared Rotation window cannot exceed one calendar day. Choose a finalization time at or before the next active time.');
    const starting_member_id=Number(raw.starting_member_id??members[0]);
    if(input.active!==false&&!members.includes(starting_member_id))fail('Choose a starting member in this Rotation Group.');
    const direction=raw.direction??'first_to_last';
    if(!['first_to_last','last_to_first'].includes(direction))fail('Choose First to last or Last to first for the rotation direction.');
    config={strategy:raw.strategy??'rotating_order',direction,starting_member_id,effective_date:effective,weekdays,active_time,finalize_time,finalize_day_offset:offset,
      advance_on_skip:raw.advance_on_skip??false,override_affects_next:raw.override_affects_next??true,
      eligibility:raw.eligibility??{},eligibility_behavior:raw.eligibility_behavior??'skip_unavailable'};
  }
  const starts=(input.independent_starts??[]).map(item=>({consumer_type:String(item.consumer_type),consumer_id:String(item.consumer_id),purpose_key:String(item.purpose_key),next_member_id:Number(item.next_member_id)}));
  if(new Set(starts.map(item=>json([item.consumer_type,item.consumer_id,item.purpose_key]))).size!==starts.length)fail('Choose one starting member per independent consumer.');
  if(starts.some(item=>!members.includes(item.next_member_id)))fail('Choose a valid next member for every independent consumer.');
  return {usage_mode:usage,shared_config:config,effective_date:effective,member_ids:members,independent_starts:starts};
}
function consumers(d,groupId,actor) {
  const tracks=d.prepare("SELECT * FROM rotation_tracks WHERE group_id=? AND consumer_type!='rotation_group_schedule' ORDER BY id").all(groupId);
  const visible=[],hidden=[],evidence=[];
  for(const track of tracks) {
    const projected=projectRotationTrack(d,actor,getRotationTrack(d,track.id));
    if(!projected){hidden.push(track.id);continue;}
    visible.push({track_id:track.id,consumer_type:track.consumer_type,consumer_id:track.consumer_id,purpose_key:track.purpose_key,
      label:projected.display_label,revision:track.revision,next_member_id:d.prepare('SELECT user_id FROM rotation_group_members WHERE id=?').get(track.next_membership_id)?.user_id??null});
  }
  for(const collect of usageCollectors)for(const item of collect(d,groupId,actor)||[]) {
    evidence.push(item);
    if(item.restricted){hidden.push(item.key??'restricted');continue;}
    const existing=visible.find(value=>value.consumer_type===item.consumer_type&&String(value.consumer_id)===String(item.consumer_id)&&value.purpose_key===item.purpose_key);
    if(existing)Object.assign(existing,{...item,next_member_id:item.next_member_id??existing.next_member_id});else visible.push(item);
  }
  return {visible,hidden,evidence};
}
function validateScheduleBoundary(d,groupId,normalized) {
  if(!groupId||normalized.usage_mode!=='shared')return;
  let first=normalized.effective_date;
  for(let days=0;days<7&&!normalized.shared_config.weekdays.includes(nominalWeekday(first));days++)first=shiftDateKey(first,1);
  const starts=availabilityInstantMs(`${first}T${normalized.shared_config.active_time}`,householdTimeZone(d));
  for(let days=1;days<=7;days++) {
    const previous=period(d,groupId,shiftDateKey(normalized.effective_date,-days));
    if(!previous)continue;
    if(previous.ends>starts)fail('The new schedule overlaps the previous scheduled period at this effective boundary. Choose a later active time or effective date.',409,'rotation_boundary_overlap');
    break;
  }
}
function proposal(d,groupId,input,actor,now) {
  const group=getRotationGroup(d,groupId);if(!group)fail('Rotation Group not found.',404);
  groupId=group.id;
  const normalized=normalizedInput(d,input,group,now),usage=consumers(d,groupId,actor),schedule=scheduleRow(d,groupId);
  validateScheduleBoundary(d,groupId,normalized);
  const refs=d.prepare('SELECT t.id,t.revision FROM tasks t WHERE EXISTS(SELECT 1 FROM task_rotation_occurrences r WHERE r.task_id=t.id AND r.track_id IN(SELECT id FROM rotation_tracks WHERE group_id=?)) ORDER BY t.id').all(groupId);
  const token=createHash('sha256').update(json({group_revision:group.revision,schedule,tracks:d.prepare('SELECT id,revision FROM rotation_tracks WHERE group_id=? ORDER BY id').all(groupId),refs,usage,normalized})).digest('hex');
  const members=normalized.member_ids.map(id=>group.members.find(member=>member.id===id)||{id,display_name:d.prepare('SELECT display_name FROM users WHERE id=?').get(id)?.display_name});
  const selected=orderedRotationSelection({memberIds:members.map(member=>member.id),nextMemberId:normalized.shared_config.starting_member_id,strategy:normalized.shared_config.strategy||'rotating_order',direction:normalized.shared_config.direction});
  const ordered=selected.member_ids.map((id,i)=>({...members.find(member=>member.id===id),position:i+1}));
  return {normalized,usage,group,confirmation_token:token,effective_date:normalized.effective_date,
    proposed_order:normalized.shared_config.strategy==='round_robin'?ordered.slice(0,1):ordered,consumers:usage.visible,
    exceptions:[...usage.visible.filter(item=>item.exception&&(!item.period_date||item.period_date>=normalized.effective_date)).map(item=>({consumer_type:item.consumer_type,consumer_id:item.consumer_id,purpose_key:item.purpose_key,reason:item.exception})),
      ...(usage.hidden.length?[{reason:'Some consumers are not visible. An administrator with access to every affected consumer must confirm this change.'}]:[])]};
}
export function previewRotationGroupUsage(d,groupId,input,{actorId,now=new Date()}={}) {
  assertCapability(d,actorId,'rotations.manage');
  const {normalized,usage,group,...result}=proposal(d,groupId,input,actorId,now);return result;
}
export function rotationGroupUsage(d,groupId,{now=new Date()}={}) {
  const schedule=scheduleRow(d,groupId),version=versionRow(d,schedule),config=configOf(version);
  const currentPeriod=schedule?d.prepare('SELECT period_date FROM rotation_group_periods WHERE schedule_id=? AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1')
    .get(schedule.id,new Date(now).toISOString(),new Date(now).toISOString()):null;
  const currentDate=currentPeriod?.period_date||todayKey(d,now);
  const current=version?.usage_mode==='shared'?previewSharedRotation(d,groupId,{dateKey:currentDate,now}):null;
  let next=null;
  if(version?.usage_mode==='shared') {
    const first=current?shiftDateKey(currentDate,1):currentDate<version.effective_date?version.effective_date:currentDate;
    for(let date=first,n=0;n<8&&!next;n++,date=shiftDateKey(date,1))next=previewSharedRotation(d,groupId,{dateKey:date,now});
  }
  return {usage_mode:version?.usage_mode??'independent',shared_config:version?.usage_mode==='shared'?config:null,
    usage_effective_date:version?.effective_date??null,shared:version?.usage_mode==='shared'?{
      track_id:schedule.track_id,schedule:config,current,next}:null};
}
export function saveRotationGroupUsage(d,input,{id:groupId=null,actorId,expectedRevision,now=new Date()}={}) {
  assertCapability(d,actorId,'rotations.manage');
  return d.transaction(()=>{
    const old=groupId?getRotationGroup(d,groupId):null;
    const normalized=normalizedInput(d,input,old,now),schedule=old?scheduleRow(d,old.id):null,prior=versionRow(d,schedule);
    const meaningful=input.active===false?false:(prior?.usage_mode??'independent')!==normalized.usage_mode
      ||normalized.usage_mode==='shared'&&(json({...configOf(prior),timezone:undefined})!==json(normalized.shared_config)
        ||json(old?.members.map(member=>member.id))!==json(normalized.member_ids));
    if(meaningful&&old) {
      const preview=proposal(d,old.id,input,actorId,now);
      if(preview.usage.hidden.length)fail('An administrator with access to every affected consumer must confirm this change.',403);
      if((preview.usage.visible.length||schedule)&&input.confirmation_token!==preview.confirmation_token)
        fail('Preview and confirm the affected Rotation consumers before applying this change.',409,'rotation_confirmation_required');
      if(normalized.effective_date<todayKey(d,now))fail('Choose today or a future effective date; historical periods are preserved.',409);
      if(schedule&&d.prepare('SELECT 1 FROM rotation_group_periods WHERE schedule_id=? AND period_date>=? LIMIT 1').get(schedule.id,normalized.effective_date))
        fail('A Rotation period already exists at this boundary. Choose a later effective date.',409,'rotation_boundary_active');
      if(prior?.usage_mode==='shared'&&normalized.usage_mode==='independent'&&preview.usage.visible.some(consumer=>!normalized.independent_starts.some(seed=>seed.consumer_type===consumer.consumer_type&&seed.consumer_id===consumer.consumer_id&&seed.purpose_key===consumer.purpose_key)))
        fail('Choose an explicit next member for every independent consumer.');
    }
    let group=saveRotationGroup(d,input,{id:groupId,actorId,expectedRevision});groupId=group.id;
    if(meaningful||(!old&&normalized.usage_mode==='shared')) {
      if(old&&group.revision===old.revision) {
        d.prepare("UPDATE rotation_groups SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(group.id);
        group=getRotationGroup(d,group.id);
      }
      if(normalized.usage_mode==='shared')normalizeRotationConfiguration(d,{...normalized.shared_config,group_id:group.id,advance_policy:'on_finalized'});
      const id=schedule?.id??Number(d.prepare('INSERT INTO rotation_group_schedules(group_id) VALUES(?)').run(group.id).lastInsertRowid);
      d.prepare('INSERT INTO rotation_group_schedule_versions(schedule_id,usage_mode,effective_date,timezone,config_json,members_json,independent_starts_json,actor_user_id) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,normalized.usage_mode,normalized.effective_date,householdTimeZone(d),json(normalized.shared_config),json(group.members),json(normalized.independent_starts),actorId);
      d.prepare('UPDATE rotation_group_schedules SET revision=revision+1 WHERE id=?').run(id);
      d.prepare("INSERT INTO rotation_events(group_id,actor_user_id,event_type,details_json) VALUES(?,?,'shared_usage_configured',?)")
        .run(group.id,actorId,json({previous_mode:prior?.usage_mode??'independent',usage_mode:normalized.usage_mode,effective_date:normalized.effective_date,
          config:normalized.shared_config,independent_starts:normalized.independent_starts}));
      notifySharedRotationReconciliation(d,{groupId:group.id,dateKey:normalized.effective_date,reason:'configuration_changed',now});
    }
    return {...group,...rotationGroupUsage(d,group.id,{now})};
  }).immediate();
}
