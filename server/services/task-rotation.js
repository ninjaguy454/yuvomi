/** Task consumer adapter. Rotation algorithms and state belong to rotation.js.
 * A parent occurrence owns its purposes; ordinary descendants only read them. */
import { createHash } from 'node:crypto';
import { assertCapability, hasCapability } from '../permissions.js';
import { taskCapabilities } from './task-access.js';
import { registerRecurrenceOccurrence } from './task-recurrence-frontier.js';
import { shiftDateKey } from '../utils/timezone.js';
import { sharedGroupConfiguration, previewSharedRotation, resolveSharedRotation, registerSharedRotationUsageCollector } from './rotation-shared.js';
import { normalizeRotationConfiguration, configureRotationTrack, findRotationTrack,
  resolveRotation, getRotationOccurrence, finalizeRotation, supersedeRotationOccurrence } from './rotation.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const json = value => JSON.stringify(stable(value));
export const rotationBindingsEqual=(left,right)=>json(parseRotationBindings(left))===json(parseRotationBindings(right));
export function parseRotationBindings(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value ?? [];
  if (!Array.isArray(parsed)) throw invalid('Rotation purposes must be a list.');
  return parsed;
}
export function normalizeRotationBindings(d, input) {
  const values = parseRotationBindings(input);
  if (values.length > 12) throw invalid('Use at most 12 rotation purposes for one Activity.');
  const keys = new Set();
  return values.map(value => {
    const purpose_key = String(value?.purpose_key || '').trim();
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(purpose_key)) throw invalid('Each rotation purpose needs a stable key using letters, numbers or underscores.');
    if (keys.has(purpose_key)) throw invalid('Rotation purpose keys must be unique.');
    keys.add(purpose_key);
    const normalized = normalizeRotationConfiguration(d, value);
    return { purpose_key, label: String(value.label || purpose_key).trim().slice(0, 120),
      group_id: normalized.group_id, strategy: normalized.strategy, advance_policy: normalized.advance_policy,
      advance_on_skip: !!normalized.advance_on_skip, override_affects_next: !!normalized.override_affects_next,
      eligibility_behavior: normalized.eligibility_behavior,
      eligibility: normalized.eligibility,
      ...(value.period_date_offset_days===undefined?{}:{period_date_offset_days:normalizePeriodOffset(value.period_date_offset_days)}) };
  });
}
function normalizePeriodOffset(value) {
  if(![-1,0].includes(Number(value)))throw invalid('Choose the scheduled date or previous evening for this rotation.');
  return Number(value);
}
/** The intended local evening follows the occurrence's schedule, never a viewer
 * or materialization clock. A start after midnight before an overnight cutoff
 * belongs to the previous evening unless the binding explicitly chooses a date. */
export function sharedTaskPeriodDate(d,task,binding) {
  const date=task.start_date||task.due_date;
  if(!date)return null;
  if(binding.period_date_offset_days!==undefined)return shiftDateKey(date,normalizePeriodOffset(binding.period_date_offset_days));
  const config=sharedGroupConfiguration(d,binding.group_id,date)||sharedGroupConfiguration(d,binding.group_id,shiftDateKey(date,-1));
  const time=task.start_date?task.start_time:task.due_time;
  return config?.schedule.finalize_day_offset===1&&time&&time<config.schedule.finalize_time ?shiftDateKey(date,-1):date;
}
function retirePeriod(d,taskId,purpose) {
  d.prepare("UPDATE task_rotation_periods SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=? AND purpose_key=? AND retired_at IS NULL").run(taskId,purpose);
}
const unscheduledPeriod = dateKey => ({id:0,revision:0,status:'preview',state:'not_scheduled',period_date:dateKey,provisional:true,order:[],member_ids:[],selected_member:null,explanation:'This Group has no scheduled rotation on this evening.'});
function bindSharedTaskPurpose(d,task,binding,existing,{actorId,now,consumer}={}) {
  const dateKey=sharedTaskPeriodDate(d,task,binding);
  const config=sharedGroupConfiguration(d,binding.group_id,dateKey||undefined);
  if(!config)return null;
  if(!dateKey)throw invalid('Choose a Start Date for this shared rotation occurrence.');
  const previous=d.prepare('SELECT * FROM task_rotation_periods WHERE task_id=? AND purpose_key=? AND retired_at IS NULL').get(task.id,binding.purpose_key);
  if(previous&&(previous.group_id!==binding.group_id||previous.period_date!==dateKey))retirePeriod(d,task.id,binding.purpose_key);
  const occurrence=resolveSharedRotation(d,binding.group_id,{dateKey,actorId,now})||unscheduledPeriod(dateKey);
  if(existing&&existing.occurrence_id!==occurrence.id) {
    d.prepare("UPDATE task_rotation_occurrences SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND retired_at IS NULL").run(existing.id);
    const priorTrack=d.prepare('SELECT group_id,consumer_type FROM rotation_tracks WHERE id=?').get(existing.track_id);
    if(priorTrack.group_id===binding.group_id&&priorTrack.consumer_type!=='rotation_group_schedule')
      supersedeRotationOccurrence(d,existing.occurrence_id,{actorId,versionId:config.version_id,trusted:true,reason:'Consumer joined its confirmed Group-managed schedule.'});
  }
  let reference=d.prepare('SELECT id FROM task_rotation_periods WHERE task_id=? AND purpose_key=? AND retired_at IS NULL').get(task.id,binding.purpose_key);
  if(!reference) {
    const result=d.prepare('INSERT INTO task_rotation_periods(task_id,purpose_key,group_id,period_date,occurrence_id,consumer_type,consumer_id) VALUES(?,?,?,?,?,?,?)').run(task.id,binding.purpose_key,binding.group_id,dateKey,occurrence.id||null,consumer.consumer_type,String(consumer.consumer_id));
    reference={id:Number(result.lastInsertRowid)};
  } else d.prepare('UPDATE task_rotation_periods SET occurrence_id=? WHERE id=? AND occurrence_id IS NOT ?').run(occurrence.id||null,reference.id,occurrence.id||null);
  if(occurrence.id)d.prepare(`INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id)
    VALUES(?,?,?,?,?) ON CONFLICT(task_id,purpose_key,occurrence_id) DO UPDATE SET retired_at=NULL WHERE retired_at IS NOT NULL`)
    .run(task.id,binding.purpose_key,occurrence.track_id,occurrence.id,task.id);
  return {purpose_key:binding.purpose_key,occurrence_id:occurrence.id||null,period_date:dateKey,shared:true,...(!occurrence.id?{reason:'Shared rotation is provisional until its scheduled period activates.'}:{})};
}
export function assertRotationBindingsChange(d, actor, before, after) {
  if (json(parseRotationBindings(before)) !== json(parseRotationBindings(after))) assertCapability(d, actor, 'rotations.configure');
}
export function taskRotationContext(d, task) {
  const planning = d.prepare('SELECT place_id FROM task_planning_context WHERE task_id=?').get(task.id);
  return { task_id: task.id, start_date: task.start_date, start_time: task.start_time,
    due_date: task.due_date, due_time: task.due_time, dateKey: task.due_date || task.start_date,
    subject_user_id: task.assigned_to, place_id: planning?.place_id ?? null };
}
/** Caller has already authorized the consumer write and owns its transaction.
 * Retired links preserve the series' original decision when an occurrence gets
 * a one-off binding. Both are settled once by the owning Task's lifecycle. */
export function bindTaskRotations(d, taskId, { config, previousConfig, actorId = null, scope = 'materialize', consumer = null, occurrenceKey = null, onlyMissing = false, purposeKeys = null, now } = {}) {
  const task = d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) throw invalid('Task not found.');
  const bindings = config === undefined ? parseRotationBindings(task.rotation_bindings_json) : normalizeRotationBindings(d, config);
  const previous = d.prepare('SELECT * FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').all(task.id);
  if(!onlyMissing)for(const ref of d.prepare('SELECT purpose_key FROM task_rotation_periods WHERE task_id=? AND retired_at IS NULL').all(task.id))
    if(!bindings.some(binding=>binding.purpose_key===ref.purpose_key))retirePeriod(d,task.id,ref.purpose_key);
  if (!bindings.length && !previous.length) return { preserved: [] };
  const recurrence = task.parent_task_id ? null : registerRecurrenceOccurrence(d, task.id);
  const owner = consumer || { consumer_type: recurrence ? 'task_series' : 'task', consumer_id: String(recurrence?.series_id || task.id) };
  const key = occurrenceKey || (recurrence ? `recurrence:${recurrence.series_id}:${recurrence.occurrence_key}` : `task:${task.id}`);
  const preserved = [], pending = [], resolved = [];
  const retire = link => d.prepare("UPDATE task_rotation_occurrences SET retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND retired_at IS NULL").run(link.id);
  for (const link of previous) if (!onlyMissing && !bindings.some(binding => binding.purpose_key === link.purpose_key)) {
    retire(link);preserved.push({purpose_key:link.purpose_key,occurrence_id:link.occurrence_id});
  }
  for (const binding of bindings) {
    if(purposeKeys&&!purposeKeys.includes(binding.purpose_key))continue;
    let existing = previous.find(link => link.purpose_key === binding.purpose_key);
    const periodReference=d.prepare('SELECT * FROM task_rotation_periods WHERE task_id=? AND purpose_key=? AND retired_at IS NULL').get(task.id,binding.purpose_key);
    let identityOwner=periodReference?.consumer_type?{consumer_type:periodReference.consumer_type,consumer_id:periodReference.consumer_id}:owner;
    if(scope==='occurrence'&&previousConfig!==undefined&&json(parseRotationBindings(previousConfig).find(value=>value.purpose_key===binding.purpose_key))!==json(binding))
      identityOwner={consumer_type:'task_exception',consumer_id:`${task.id}:${createHash('sha256').update(json(binding)).digest('hex').slice(0,24)}`};
    const shared=bindSharedTaskPurpose(d,task,binding,existing,{actorId,now,consumer:identityOwner});
    if(shared){(shared.occurrence_id?resolved:pending).push(shared);continue;}
    retirePeriod(d,task.id,binding.purpose_key);
    if(periodReference&&existing){retire(existing);existing=null;}
    if(onlyMissing && existing)continue;
    // Scope applies to changed purposes, not to every purpose in the editor.
    // Keep an unchanged binding's identity and historical decision intact.
    if(existing && scope === 'occurrence' && previousConfig !== undefined
      && json(parseRotationBindings(previousConfig).find(value=>value.purpose_key===binding.purpose_key))===json(binding))continue;
    const identity = { ...identityOwner, purpose_key: binding.purpose_key };
    let track = findRotationTrack(d, identity);
    const ownSnapshot = existing ? getRotationOccurrence(d, existing.occurrence_id) : null;
    if (scope === 'occurrence' || scope === 'preserved') {
      // An existing binding may be edited without sharing new configuration
      // with its series. A deterministic exception identity makes retries safe.
      const signature = createHash('sha256').update(json(binding)).digest('hex').slice(0, 24);
      Object.assign(identity, { consumer_type: 'task_exception', consumer_id: `${task.id}:${signature}` });
      track = findRotationTrack(d, identity);
    }
    try {track = configureRotationTrack(d, { ...binding, ...identity, expected_revision: track?.revision }, { actorId, trusted: true,dateKey:task.start_date||task.due_date });}
    catch(error) {
      if(scope==='occurrence'||!['rotation_group_inactive','rotation_pending'].includes(error.code))throw error;
      pending.push({purpose_key:binding.purpose_key,reason:error.code});continue;
    }
    if (existing && scope !== 'occurrence') {
      // Resolution is a historical snapshot even while work remains open.
      // Reconfiguration governs subsequent resolution, never silently edits it.
      const configuration=normalizeRotationConfiguration(d,binding,{allowMissingReferences:true});
      const context=taskRotationContext(d,task);
      if(json(configuration)!==json(ownSnapshot.config) || Object.keys(context).some(key=>(context[key]??null)!==(ownSnapshot.context[key]??null)))
        preserved.push({ purpose_key: binding.purpose_key, occurrence_id: ownSnapshot.id });
      continue;
    }
    let occurrence;
    try { occurrence = resolveRotation(d, track.id, key, { actorId, context: taskRotationContext(d, task), expectedTrackRevision: track.revision }); }
    catch(error) {
      if(scope==='occurrence' || !['rotation_group_inactive','rotation_pending'].includes(error.code))throw error;
      pending.push({purpose_key:binding.purpose_key,reason:error.code});continue;
    }
    if (existing && existing.occurrence_id !== occurrence.id) retire(existing);
    d.prepare(`INSERT INTO task_rotation_occurrences(task_id,purpose_key,track_id,occurrence_id,owner_task_id)
      VALUES(?,?,?,?,?) ON CONFLICT(task_id,purpose_key,occurrence_id) DO UPDATE SET retired_at=NULL`)
      .run(task.id, binding.purpose_key, track.id, occurrence.id, task.id);
    resolved.push({purpose_key:binding.purpose_key,occurrence_id:occurrence.id});
  }
  return { preserved, pending, resolved };
}

/** Only links owned by this exact Task settle. Descendant checkbox transitions
 * do not finalize their parent's purposes; helpers are projections, not owners. */
export function settleTaskRotations(d, taskId, outcome, { actorId = null } = {}) {
  const links = d.prepare(`SELECT DISTINCT l.occurrence_id FROM task_rotation_occurrences l JOIN rotation_tracks t ON t.id=l.track_id
    WHERE l.owner_task_id=? AND t.consumer_type!='rotation_group_schedule'
      AND NOT EXISTS(SELECT 1 FROM rotation_occurrence_supersessions s WHERE s.occurrence_id=l.occurrence_id)`).all(taskId);
  for (const link of links) {
    const occurrence = getRotationOccurrence(d, link.occurrence_id);
    if (['completed', 'skipped'].includes(occurrence.status)) continue;
    finalizeRotation(d, occurrence.id, { outcome, actorId, expectedRevision: occurrence.revision, trusted: true });
  }
}

/** Read-only projection, reusable by Tasks, Workflow children and expressions.
 * A request-local cache avoids repeating ancestry/history reads for siblings. */
export function taskRotationContexts(d, taskOrId, viewerMemberId = null, cache = new Map()) {
  const task = typeof taskOrId === 'object' ? taskOrId : d.prepare('SELECT * FROM tasks WHERE id=?').get(taskOrId);
  if (!task) return [];
  cache.set(`rotation-task:${task.id}`,task);
  const cachedTask=id=>{
    const key=`rotation-task:${id}`;
    if(!cache.has(key))cache.set(key,d.prepare('SELECT * FROM tasks WHERE id=?').get(id));
    return cache.get(key);
  };
  const taskBindings=row=>parseRotationBindings(row.rotation_bindings_json??row.rotation_bindings);
  if (!task.parent_task_id && !taskBindings(task).length) { cache.set(task.id,[]); return []; }
  if(task.parent_task_id && cache.has(task.parent_task_id) && !cache.get(task.parent_task_id).length && !taskBindings(task).length) {cache.set(task.id,[]);return [];}
  if(viewerMemberId != null) {
    const key=`permission:${viewerMemberId}`;
    if(!cache.has(key))cache.set(key,hasCapability(d,viewerMemberId,'rotations.view'));
    if(!cache.get(key))return [];
  }
  function contexts(row, visited = new Set()) {
    if (!row || visited.has(row.id)) return [];
    cache.set(`rotation-task:${row.id}`,row);
    if (cache.has(row.id)) return cache.get(row.id);
    visited.add(row.id);
    const configuration = taskBindings(row);
    const own = configuration.length
      ? d.prepare(`SELECT l.purpose_key,l.occurrence_id,l.owner_task_id,t.consumer_type FROM task_rotation_occurrences l JOIN rotation_tracks t ON t.id=l.track_id WHERE l.task_id=? AND l.retired_at IS NULL`).all(row.id)
        .map(link => ({ purpose_key: link.purpose_key, label: configuration.find(binding=>binding.purpose_key===link.purpose_key)?.label || link.purpose_key,
          owner_task_id: link.owner_task_id, shared:link.consumer_type==='rotation_group_schedule', occurrence: getRotationOccurrence(d, link.occurrence_id) })) : [];
    if(configuration.length)for(const reference of d.prepare('SELECT * FROM task_rotation_periods WHERE task_id=? AND retired_at IS NULL').all(row.id)) {
      if(own.some(item=>item.purpose_key===reference.purpose_key))continue;
      const key=`shared-preview:${reference.group_id}:${reference.period_date}`;
      if(!cache.has(key))cache.set(key,previewSharedRotation(d,reference.group_id,{dateKey:reference.period_date})||unscheduledPeriod(reference.period_date));
      own.push({purpose_key:reference.purpose_key,label:configuration.find(binding=>binding.purpose_key===reference.purpose_key)?.label||reference.purpose_key,
        owner_task_id:row.id,shared:true,pending:true,period_date:reference.period_date,occurrence:cache.get(key),reason:'Provisional until this shared evening becomes active.'});
    }
    for(const binding of configuration) if(!own.some(item=>item.purpose_key===binding.purpose_key))own.push({
      purpose_key:binding.purpose_key,label:binding.label,owner_task_id:row.id,pending:true,
      occurrence:{id:null,status:'pending',state:'needs_configuration',order:[],member_ids:[],selected_member:null},
      reason:'Rotation needs attention. Check its Group or finish the previous occurrence, then resolve this occurrence.'});
    const parentContexts = row.parent_task_id ? cache.has(row.parent_task_id) ? cache.get(row.parent_task_id)
      : contexts(cachedTask(row.parent_task_id), visited) : [];
    const inherited = parentContexts.filter(item => !own.some(value => value.purpose_key === item.purpose_key));
    const result = [...inherited, ...own]; cache.set(row.id, result); return result;
  }
  const values=contexts(task);
  let performer=task,seen=new Set();
  while(!performer?.assigned_to&&performer?.parent_task_id&&!seen.has(performer.id)){
    seen.add(performer.id);performer=cachedTask(performer.parent_task_id);
  }
  const resolvedMemberId=performer?.assigned_to??null;
  const memberId = task.assigned_to || viewerMemberId;
  // Viewing a descendant does not grant access to the owning private Activity.
  // Canonical Task projections already provide mutation-invalidated, request-local
  // capability reuse; never retain permission decisions in the ancestry cache.
  return values.filter(item=>item.shared||viewerMemberId==null||taskCapabilities(d,viewerMemberId,{id:item.owner_task_id||task.id}).view).map(item => ({ ...item,
    ...(viewerMemberId != null ? {occurrence:Object.fromEntries(['id','track_id','status','strategy','revision','state','order','member_ids','selected_member','advanced','overridden_at','period_date','provisional','starts_at','ends_at'].map(key=>[key,item.occurrence[key]]))} : {}),
    position: item.occurrence.order.find(member => Number(member.id) === Number(item.shared?resolvedMemberId:memberId))?.position ?? null }));
}

/** Called only by an explicit/background shared lifecycle mutation. All normal
 * reads remain projections. The bounded callback returns changed active owners
 * so the existing frozen-expression renderer can reconcile them atomically. */
export function reconcileSharedTaskBindings(d,{groupId,dateKey,reason,now,onBeforeTask}={}) {
  groupId=Number(groupId);
  const conversion=['configuration_changed','independent_boundary'].includes(reason);
  const candidates=conversion?groupTaskConsumers(d,groupId):d.prepare(`SELECT DISTINCT t.* FROM task_rotation_periods p JOIN tasks t ON t.id=p.task_id
    WHERE p.group_id=? AND p.retired_at IS NULL AND (? IS NULL OR p.period_date>=?)
      AND t.archived_at IS NULL AND t.status NOT IN ('done','expired') ORDER BY t.id`).all(groupId,dateKey||null,dateKey||null);
  const changed=[];
  for(const task of candidates) {
    const purposes=parseRotationBindings(task.rotation_bindings_json).filter(binding=>binding.group_id===groupId&&(!dateKey||sharedTaskPeriodDate(d,task,binding)>=dateKey)).map(binding=>binding.purpose_key);
    if(!purposes.length)continue;
    if(conversion&&rotationBindingPreservationReason(d,task))continue;
    onBeforeTask?.(task.id);
    bindTaskRotations(d,task.id,{onlyMissing:true,purposeKeys:purposes,now});changed.push(task.id);
  }
  return changed;
}

function groupTaskConsumers(d,groupId) {
  return d.prepare(`SELECT DISTINCT t.* FROM tasks t JOIN json_each(t.rotation_bindings_json) binding
    WHERE json_extract(binding.value,'$.group_id')=? AND t.archived_at IS NULL AND t.status NOT IN ('done','expired') ORDER BY t.id`).all(groupId);
}
/** The Group editor never silently replaces a binding that already has human
 * evidence. Ordinary override/text refreshes are intentionally not conversions. */
function rotationBindingPreservationReason(d,task) {
  if(!task.start_date&&!task.due_date)return 'Choose a scheduled date before joining this Task to shared rotation.';
  const tree=d.prepare(`WITH RECURSIVE children(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN children p ON t.parent_task_id=p.id)
    SELECT t.id,t.status FROM tasks t JOIN children c ON c.id=t.id WHERE t.archived_at IS NULL`).all(task.id);
  if(tree.some(item=>item.status!=='open'))return 'Existing Task progress is preserved.';
  const marks=tree.map(()=>'?').join(','),ids=tree.map(item=>item.id);
  for(const table of ['task_comments','task_documents','task_completions','reward_task_awards'])
    if(d.prepare(`SELECT 1 FROM ${table} WHERE task_id IN (${marks}) LIMIT 1`).get(...ids))return 'Existing Task activity is preserved.';
  if(d.prepare(`SELECT 1 FROM planning_obligations WHERE task_id IN (${marks}) AND responded_at IS NOT NULL LIMIT 1`).get(...ids))return 'An assignment response is preserved.';
  if(d.prepare(`SELECT 1 FROM task_activity_events WHERE task_id IN (${marks}) AND event_type NOT IN
    ('created','recurrence_generated','supervisor_assigned','supervision_needed','supervision_not_required','action_delegated') LIMIT 1`).get(...ids))return 'Existing Task edits or evidence are preserved.';
  const recurrence=d.prepare('SELECT exception_reason FROM task_recurrence_occurrences WHERE task_id=?').get(task.id);
  return recurrence?.exception_reason?'An occurrence-specific edit is preserved.':null;
}

registerSharedRotationUsageCollector((d,groupId,actor)=>{
  groupId=Number(groupId);
  const entries=[];
  for(const task of groupTaskConsumers(d,groupId)) {
    if(!taskCapabilities(d,actor,task).view){entries.push({restricted:true,key:`task:${task.id}`});continue;}
    const recurrence=d.prepare('SELECT series_id FROM task_recurrence_occurrences WHERE task_id=?').get(task.id);
    for(const binding of parseRotationBindings(task.rotation_bindings_json).filter(binding=>binding.group_id===groupId)) {
      const reference=d.prepare('SELECT * FROM task_rotation_periods WHERE task_id=? AND purpose_key=? AND retired_at IS NULL').get(task.id,binding.purpose_key);
      const track=d.prepare(`SELECT t.* FROM task_rotation_occurrences l JOIN rotation_tracks t ON t.id=l.track_id
        WHERE l.task_id=? AND l.purpose_key=? AND l.retired_at IS NULL`).get(task.id,binding.purpose_key);
      const identity=reference?.consumer_type?reference:track&&track.consumer_type!=='rotation_group_schedule'?track:
        {consumer_type:recurrence?'task_series':'task',consumer_id:String(recurrence?.series_id||task.id)};
      const date=sharedTaskPeriodDate(d,task,binding),preview=date&&sharedGroupConfiguration(d,groupId,date)?previewSharedRotation(d,groupId,{dateKey:date}):null;
      entries.push({consumer_type:identity.consumer_type,consumer_id:String(identity.consumer_id),purpose_key:binding.purpose_key,
        label:`${task.title} · ${binding.label||binding.purpose_key}`,revision:task.revision,task_id:task.id,period_date:date,
        next_member_id:preview?.member_ids?.[0]??null,exception:rotationBindingPreservationReason(d,task)});
    }
  }
  return entries;
});
