/** Task consumer adapter. Rotation algorithms and state belong to rotation.js.
 * A parent occurrence owns its purposes; ordinary descendants only read them. */
import { createHash } from 'node:crypto';
import { assertCapability, hasCapability } from '../permissions.js';
import { taskCapabilities } from './task-access.js';
import { registerRecurrenceOccurrence } from './task-recurrence-frontier.js';
import { normalizeRotationConfiguration, configureRotationTrack, findRotationTrack,
  resolveRotation, getRotationOccurrence, finalizeRotation } from './rotation.js';

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
      eligibility: normalized.eligibility };
  });
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
export function bindTaskRotations(d, taskId, { config, previousConfig, actorId = null, scope = 'materialize', consumer = null, occurrenceKey = null, onlyMissing = false } = {}) {
  const task = d.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) throw invalid('Task not found.');
  const bindings = config === undefined ? parseRotationBindings(task.rotation_bindings_json) : normalizeRotationBindings(d, config);
  const previous = d.prepare('SELECT * FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').all(task.id);
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
    const existing = previous.find(link => link.purpose_key === binding.purpose_key);
    if(onlyMissing && existing)continue;
    // Scope applies to changed purposes, not to every purpose in the editor.
    // Keep an unchanged binding's identity and historical decision intact.
    if(existing && scope === 'occurrence' && previousConfig !== undefined
      && json(parseRotationBindings(previousConfig).find(value=>value.purpose_key===binding.purpose_key))===json(binding))continue;
    const identity = { ...owner, purpose_key: binding.purpose_key };
    let track = findRotationTrack(d, identity);
    const ownSnapshot = existing ? getRotationOccurrence(d, existing.occurrence_id) : null;
    if (scope === 'occurrence' || scope === 'preserved') {
      // An existing binding may be edited without sharing new configuration
      // with its series. A deterministic exception identity makes retries safe.
      const signature = createHash('sha256').update(json(binding)).digest('hex').slice(0, 24);
      Object.assign(identity, { consumer_type: 'task_exception', consumer_id: `${task.id}:${signature}` });
      track = findRotationTrack(d, identity);
    }
    try {track = configureRotationTrack(d, { ...binding, ...identity, expected_revision: track?.revision }, { actorId, trusted: true });}
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
  const links = d.prepare('SELECT DISTINCT occurrence_id FROM task_rotation_occurrences WHERE owner_task_id=?').all(taskId);
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
    if (cache.has(row.id)) return cache.get(row.id);
    visited.add(row.id);
    const configuration = taskBindings(row);
    const own = configuration.length
      ? d.prepare('SELECT purpose_key,occurrence_id,owner_task_id FROM task_rotation_occurrences WHERE task_id=? AND retired_at IS NULL').all(row.id)
        .map(link => ({ purpose_key: link.purpose_key, label: configuration.find(binding=>binding.purpose_key===link.purpose_key)?.label || link.purpose_key,
          owner_task_id: link.owner_task_id, occurrence: getRotationOccurrence(d, link.occurrence_id) })) : [];
    for(const binding of configuration) if(!own.some(item=>item.purpose_key===binding.purpose_key))own.push({
      purpose_key:binding.purpose_key,label:binding.label,owner_task_id:row.id,pending:true,
      occurrence:{id:null,status:'pending',state:'needs_configuration',order:[],member_ids:[],selected_member:null},
      reason:'Rotation needs attention. Check its Group or finish the previous occurrence, then resolve this occurrence.'});
    const parentContexts = row.parent_task_id ? cache.has(row.parent_task_id) ? cache.get(row.parent_task_id)
      : contexts(d.prepare('SELECT * FROM tasks WHERE id=?').get(row.parent_task_id), visited) : [];
    const inherited = parentContexts.filter(item => !own.some(value => value.purpose_key === item.purpose_key));
    const result = [...inherited, ...own]; cache.set(row.id, result); return result;
  }
  const memberId = task.assigned_to || viewerMemberId;
  // Viewing a descendant does not grant access to the owning private Activity.
  // Canonical Task projections already provide mutation-invalidated, request-local
  // capability reuse; never retain permission decisions in the ancestry cache.
  return contexts(task).filter(item=>viewerMemberId==null||taskCapabilities(d,viewerMemberId,{id:item.owner_task_id||task.id}).view).map(item => ({ ...item,
    ...(viewerMemberId != null ? {occurrence:Object.fromEntries(['id','track_id','status','strategy','revision','state','order','member_ids','selected_member','advanced','overridden_at'].map(key=>[key,item.occurrence[key]]))} : {}),
    position: item.occurrence.order.find(member => Number(member.id) === Number(memberId))?.position ?? null }));
}
