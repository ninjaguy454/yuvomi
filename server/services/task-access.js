/** One Task authorization boundary for REST, Reader, MCP and aggregate readers. */
import { actorId, actorPermissions, PermissionError } from '../permissions.js';
import { visibilityWhere } from './visibility.js';
import { taskOptionalContext } from './task-optional.js';
import { taskWindowAncestors,taskCompletedScope } from './task-window.js';
import { assertRewardTaskMutation, rewardTaskCapabilities } from './reward-fulfillment-access.js';
import {taskDirectAssignmentSelection} from './task-assignee-policy.js';
import {inspectTaskSupervision} from './task-supervision-inspection.js';

// Only synchronous response hydration opts into this scope. It never survives
// a request, contains no lifecycle decisions, and is suspended for mutations.
const readProjections = new WeakMap();
const readSnapshots = new WeakMap();
const supervisionAccessProofs = new WeakMap();

/** A synchronous list projection shares one SQLite read snapshot. On an
 * encrypted Windows bind mount, thousands of separate reads otherwise repeat
 * filesystem lock acquisition. No lock survives response construction. */
export function withTaskReadSnapshot(d, actor, read) {
  // A caller-owned transaction may contain mutations/savepoints. Do not mark
  // it as read-only or change the existing no-cache rule for those callers.
  if (d.inTransaction) return withTaskReadProjection(d, actor, read);
  return d.transaction(() => {
    const owner = { changes:d.prepare('SELECT total_changes() AS count').get().count, invalid:false };
    const previous = readProjections.get(d);
    readProjections.delete(d);
    readSnapshots.set(d,owner);
    try { return withTaskReadProjection(d,actor,read); }
    finally {
      readSnapshots.delete(d);
      if(previous)readProjections.set(d,previous);
    }
  }).deferred();
}

export function withTaskReadProjection(d, actor, read) {
  const previous = readProjections.get(d), me = actorId(actor);
  const scope = previous?.actorId === me ? previous : {actorId:me, capabilities:new Map(), tables:new Map(), statements:new Map(), records:new Map(), facts:new Map(), factCount:0,
    changesStatement:d.prepare('SELECT total_changes() AS count')};
  if (scope.changes === undefined) scope.changes = scope.changesStatement.get().count;
  readProjections.set(d, scope);
  try {
    const result = read();
    if (result && typeof result.then === 'function') throw new TypeError('Task read projections must be synchronous.');
    return result;
  } finally {
    if (previous) readProjections.set(d, previous);
    else readProjections.delete(d);
  }
}
function currentReadProjection(d) {
  const scope = readProjections.get(d);
  // Never cache reads from an open transaction: rollback/savepoint rollback
  // can undo a write without advancing total_changes() a second time.
  const snapshot = readSnapshots.get(d);
  if (!scope || d.inTransaction && !snapshot || snapshot?.invalid) return null;
  // Callers are read-only. This inexpensive connection-local guard also makes
  // future accidental writes (even rolled-back ones) invalidate every snapshot.
  const changes = scope.changesStatement.get().count;
  // Unexpected writes (even later rolled back) permanently end reuse for an
  // owned snapshot; a savepoint rollback must not revive temporary decisions.
  if (snapshot && changes !== snapshot.changes) { snapshot.invalid=true; return null; }
  if (changes !== scope.changes) {
    scope.capabilities.clear(); scope.tables.clear(); scope.statements.clear(); scope.records.clear(); scope.facts.clear(); scope.factCount=0; scope.permissions = null; scope.changes = changes;
  }
  return scope;
}
function projectionFor(d, actor) {
  // Authority and visibility are row facts too. A plain projection can see
  // another connection's commit between reads, so it must recheck them.
  const scope = readSnapshots.has(d) ? currentReadProjection(d) : null;
  return scope?.actorId === actorId(actor) ? scope : null;
}
function readPermissions(d, actor) {
  const scope = projectionFor(d, actor);
  if (!scope) return actorPermissions(d, actor);
  scope.permissions ||= actorPermissions(d, actor);
  return scope.permissions;
}

/** Reuse compilation, never rows or bound values, during synchronous Task reads.
 * Handles leave scope with the response. Caller-owned transactions and any
 * unexpected owned-snapshot write retain the existing uncached read behavior.
 */
export function taskReadStatement(d, sql) {
  const scope = currentReadProjection(d);
  if (scope?.statements.has(sql)) return scope.statements.get(sql);
  const statement = d.prepare(sql);
  if (scope && statement.readonly && scope.statements.size < 64) scope.statements.set(sql, statement);
  return statement;
}

/** Internal immutable facts only, never a personalized response or lifecycle
 * decision. The namespace belongs to the reader. Entries share the statement
 * guard and are bounded/disposed with our owned synchronous read snapshot.
 * Another connection's commits do not advance total_changes(), so plain
 * projections may reuse compilation but must read facts again.
 */
export function taskReadFacts(d, namespace, key, read) {
  const scope=readSnapshots.has(d)?currentReadProjection(d):null, entries=scope?.facts.get(namespace);
  if(entries?.has(key))return entries.get(key);
  const changes=scope?.changes, value=read();
  if(value&&typeof value.then==='function')throw new TypeError('Task read facts must be synchronous.');
  if(scope&&currentReadProjection(d)===scope&&scope.changes===changes&&scope.factCount<256){
    const target=entries||new Map();target.set(key,value);scope.facts.set(namespace,target);scope.factCount++;
  }
  return value;
}

/** Canonical scalar Task columns within one guarded read only. Return a copy
 * so proposed edits/presentation cannot change another reader's facts. Unknown
 * object/blob columns disable reuse; no derived/authorized rows enter here.
 */
export function taskReadRecord(d, id) {
  // Row facts require our owned SQLite snapshot, including protection from
  // another connection's commits (which do not advance this total_changes).
  const scope=readSnapshots.has(d)?currentReadProjection(d):null, changes=scope?.changes;
  if(scope?.records.has(id)){const row=scope.records.get(id);return row?{...row}:row;}
  const row=taskReadStatement(d,'SELECT * FROM tasks WHERE id = ?').get(id);
  if(scope&&currentReadProjection(d)===scope&&scope.changes===changes&&scope.records.size<2048
    &&(!row||Object.values(row).every(value=>value===null||['string','number','bigint'].includes(typeof value))))scope.records.set(id,row?{...row}:row);
  return row?{...row}:row;
}

const ids = value => [...new Set((Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(Number))].sort((a, b) => a - b);
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const assignments = (d, task) => task?.id ? ids(taskReadStatement(d,'SELECT user_id FROM task_assignments WHERE task_id = ?').all(task.id).map(row => row.user_id).concat(task.assigned_to || [])) : ids(task?.assigned_to);
export const taskDevicePrincipal = actor => actor?.devicePrincipal?.kind === 'device' ? actor.devicePrincipal : actor?.kind === 'device' ? actor : null;
const deviceAllows = (principal, key) => principal.permissions?.capabilities?.[key] === 'allow';
/** A shared display has no personal visibility or inherited member identity. */
export function deviceTaskVisible(d, principal, taskOrId, visited=new Set()) {
  if (!principal || principal.kind !== 'device' || principal.status==='revoked' || !Number.isSafeInteger(principal.id) || principal.id<1
    || !['read','write'].includes(principal.permissions?.modules?.tasks) || !deviceAllows(principal, 'tasks.view_household')) return false;
  let task = d.prepare('SELECT * FROM tasks WHERE id=?').get(Number(taskOrId?.id ?? taskOrId) || 0);
  if (!task || task.archived_at || task.visibility && task.visibility !== 'all') return false;
  if(visited.has(task.id))return false;
  visited.add(task.id);
  const original=d.prepare('SELECT action_task_id FROM task_supervision_actions WHERE counterpart_task_id=?').get(task.id);
  if(original && !deviceTaskVisible(d,principal,original.action_task_id,visited))return false;
  const seen = new Set(), allowed = (principal.scope?.member_ids || []).map(Number);
  let assigned = assignments(d, task);
  while (task) {
    if (seen.has(task.id) || task.archived_at || task.visibility && task.visibility !== 'all') return false;
    seen.add(task.id);
    if (!assigned.length) assigned = assignments(d, task);
    task = task.parent_task_id ? d.prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_task_id) : null;
  }
  return !allowed.length || assigned.length > 0 && assigned.every(id => allowed.includes(id))
    || !assigned.length && deviceAllows(principal,'device_tasks.claim');
}
export function deviceTaskCapabilities(d, principal, task) {
  const view = deviceTaskVisible(d, principal, task), allow = key => deviceAllows(principal, `device_tasks.${key}`);
  const stored=task?.id?d.prepare('SELECT * FROM tasks WHERE id=?').get(task.id):task;
  const locked=stored?.locked || stored?.parent_task_id && d.prepare('SELECT locked FROM tasks WHERE id=?').get(stored.parent_task_id)?.locked;
  const skipped=stored?.id&&(taskWindowAncestors(d,stored.id).some(row=>['skipped','closed_incomplete'].includes(row.status))||taskCompletedScope(d,stored.id));
  const definition=view&&!locked&&!skipped&&!['done','expired','skipped','closed_incomplete'].includes(stored?.status);
  return {view, own:false, create:deviceAllows(principal,'tasks.create'), edit:definition&&deviceAllows(principal,'tasks.edit_others'), complete:view && !skipped && allow('complete'), reopen:view && !skipped && allow('reopen'),
    reset:view && !skipped && allow('reset'), claim:view && !skipped && allow('claim'), comment:false,
    ...Object.fromEntries(['delete_archive','change_assignment','reassign','change_priority','change_points','change_category_tags','change_dates','change_required_skills'].map(key=>[key,key==='delete_archive'?false:definition&&deviceAllows(principal,`tasks.${key}`)]))};
}
function ownSql(alias, me, projectionGuard = '') {
  return `(${alias}.created_by = ${me} OR ${alias}.assigned_to = ${me} OR EXISTS (SELECT 1 FROM task_assignments tp WHERE tp.task_id = ${alias}.id AND tp.user_id = ${me})
    OR (${alias}.parent_task_id IS NOT NULL AND ${alias}.assigned_to IS NULL AND NOT EXISTS (SELECT 1 FROM task_assignments tx WHERE tx.task_id = ${alias}.id) ${projectionGuard}
      AND EXISTS (SELECT 1 FROM tasks pp WHERE pp.id = ${alias}.parent_task_id AND (pp.created_by = ${me} OR pp.assigned_to = ${me} OR EXISTS (SELECT 1 FROM task_assignments pa WHERE pa.task_id = pp.id AND pa.user_id = ${me})))))`;
}

/** A saved assignment is a revocable operational link, never a visibility
 * grant on its Activity or helper container. Inspect current skills, presence,
 * learner, authored pool and lifecycle before admitting either linked row. */
export function taskAssignedSupervisionActions(d, actor) {
  const me=actorId(actor);
  if(!Number.isSafeInteger(me)||me<=0||taskDevicePrincipal(actor)||!supervisionTable(d))return [];
  return taskReadFacts(d,'assigned-supervision-access',me,()=>{
    const saved=taskReadStatement(d,`SELECT sa.* FROM task_supervision_actions sa
      JOIN tasks action ON action.id=sa.action_task_id
      JOIN tasks source ON source.id=sa.source_task_id
      JOIN task_responsibilities helper ON helper.task_id=sa.source_task_id
        AND helper.user_id=sa.supervisor_user_id AND helper.role='supervisor' AND helper.status='active'
      WHERE sa.supervisor_user_id=? AND sa.state='assigned'
        AND action.status NOT IN ('done','expired','skipped','closed_incomplete') AND action.archived_at IS NULL
        AND source.status NOT IN ('done','expired','skipped','closed_incomplete') AND source.archived_at IS NULL`).all(me);
    const views=new Map(),allowed=[];
    if(!saved.length)return allowed;
    // Scope a qualification assessment to this connection's exact database
    // state. data_version detects other connections; total_changes detects
    // local writes, including writes later rolled back.
    const proof=taskReadStatement(d,`SELECT total_changes() AS changes,
      (SELECT data_version FROM pragma_data_version) AS version`).get();
    for(const row of saved){
      if(!views.has(row.source_task_id))views.set(row.source_task_id,inspectTaskSupervision(d,row.source_task_id));
      const current=views.get(row.source_task_id).actions.find(action=>action.action_task_id===row.action_task_id);
      if(current?.state==='assigned'&&!current.completed&&!current.archived
        &&Number(current.supervisor_user_id)===me&&Number(current.learner_user_id)===Number(row.learner_user_id))allowed.push(row);
    }
    supervisionAccessProofs.set(allowed,proof);
    return allowed;
  });
}

/** Standalone board entries for linked work whose containers need not be visible. */
export function taskAssignedSupervisionWhere(d,actor,alias='t') {
  const assessed=taskAssignedSupervisionActions(d,actor),proof=supervisionAccessProofs.get(assessed);
  const actions=assessed.filter(row=>Number.isSafeInteger(row.id)&&row.id>0
    &&Number.isSafeInteger(row.revision)&&row.revision>0&&row.action_task_id!==row.source_task_id);
  if(!actions.length||!proof)return '0';
  // The caller can prepare/execute this fragment after another connection
  // commits. Recheck the saved assignment and responsibility in SQL too.
  const versions=actions.map(row=>`(live.id=${row.id} AND live.revision=${row.revision})`).join(' OR ');
  return `EXISTS (SELECT 1 FROM task_supervision_actions live
    JOIN task_responsibilities helper ON helper.task_id=live.source_task_id
      AND helper.user_id=live.supervisor_user_id AND helper.role='supervisor' AND helper.status='active'
    JOIN tasks live_action ON live_action.id=live.action_task_id
    JOIN tasks live_source ON live_source.id=live.source_task_id
    WHERE live.supervisor_user_id=${actorId(actor)} AND live.state='assigned' AND (${versions})
      AND total_changes()=${proof.changes} AND (SELECT data_version FROM pragma_data_version)=${proof.version}
      AND (${alias}.id=live.action_task_id OR ${alias}.id=live.counterpart_task_id)
      AND live_action.status NOT IN ('done','expired','skipped','closed_incomplete') AND live_action.archived_at IS NULL
      AND live_source.status NOT IN ('done','expired','skipped','closed_incomplete') AND live_source.archived_at IS NULL)`;
}

/** Adds no binds to the existing visibility fragment. Actor ID is strictly numeric. */
export function taskVisibilityWhere(d, actor, alias = 't', bind = '?', {legacyStoredFields=false}={}) {
  const me = actorId(actor);
  // Legacy Task rows can hold their only assignee in tasks.assigned_to. Match
  // taskCapabilities for callers that must decide visibility for a whole cohort.
  const rowVisibility=(name,user)=>legacyStoredFields?`(
    ${name}.visibility IN ('all','') OR ${name}.visibility IS NULL OR ${name}.created_by=${user}
    OR (${name}.visibility='assignees' AND (${name}.assigned_to=${user}
      OR EXISTS (SELECT 1 FROM task_assignments vx WHERE vx.task_id=${name}.id AND vx.user_id=${user}))))`
    :visibilityWhere(name,'task_assignments','task_id',user);
  const originalVisibility = rowVisibility(alias,bind);
  const sourceVisible = rowVisibility('mapped_source',String(Number.isSafeInteger(me) ? me : 0));
  const mappedVisibility = supervisionTable(d) ? `(${originalVisibility} AND NOT EXISTS (
    SELECT 1 FROM task_supervision_actions mapped JOIN tasks mapped_source ON mapped_source.id=mapped.action_task_id
    WHERE mapped.counterpart_task_id=${alias}.id AND NOT ${sourceVisible}))` : originalVisibility;
  if (actor == null) return mappedVisibility; // Shared Wall projections retain their existing public-visibility boundary.
  if (!Number.isSafeInteger(me) || me <= 0) return `(${mappedVisibility} AND 0)`;
  const p = readPermissions(d, actor);
  const household=p.capabilities['tasks.view_household']==='allow',own=p.capabilities['tasks.view_own']==='allow';
  const supportVisibility=supportTable(d)?` AND NOT EXISTS (
    SELECT 1 FROM task_activity_support_tasks support JOIN tasks support_source ON support_source.id=support.source_task_id
    WHERE support.task_id=${alias}.id AND NOT (${rowVisibility('support_source',String(me))}
      AND (${household?'1':own?ownSql('support_source',me):'0'})))`:'';
  const base=`(${mappedVisibility}${supportVisibility})`;
  if (!household&&!own) return `(${base} AND 0)`;
  const projectionGuard = (supportTable(d) ? ` AND NOT EXISTS (SELECT 1 FROM task_activity_support_tasks os WHERE os.task_id=${alias}.id)` : '')
    + (supervisionTable(d) ? ` AND NOT EXISTS (SELECT 1 FROM task_supervision_actions oc WHERE oc.counterpart_task_id=${alias}.id)` : '');
  const ordinaryOwn=`(${alias}.created_by=${me} OR (${ownSql(alias,me,projectionGuard)} ${projectionGuard}))`;
  return `((${base} AND (${household?'1':ordinaryOwn}))
    OR (${taskAssignedSupervisionWhere(d,actor,alias)}))`;
}

export function taskCapabilities(d, actor, sourceTask) {
  const device = taskDevicePrincipal(actor);
  if (device) return deviceTaskCapabilities(d, device, sourceTask);
  const scope = projectionFor(d, actor), id = sourceTask?.id == null ? null : Number(sourceTask.id);
  if (scope && id != null && scope.capabilities.has(id)) return {...scope.capabilities.get(id)};
  const me = actorId(actor), p = readPermissions(d, actor), allow = key => p.capabilities[`tasks.${key}`] === 'allow';
  const stored = sourceTask?.id ? taskReadRecord(d,sourceTask.id) : null;
  const task = stored || sourceTask;
  const parent = task?.parent_task_id ? taskReadRecord(d,task.parent_task_id) : null;
  const assigned = assignments(d, task);
  const mappedSource = task?.id && supervisionTable(d) ? taskReadStatement(d,`SELECT t.* FROM task_supervision_actions a
    JOIN tasks t ON t.id=a.action_task_id WHERE a.counterpart_task_id=?`).get(task.id) : null;
  const supportSource=task?.id&&supportTable(d)
    ?taskReadStatement(d,'SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?').get(task.id):null;
  const projection = !!mappedSource || !!supportSource;
  const parentOwn = parent && (Number(parent.created_by) === me || assignments(d, parent).includes(me));
  const linked=task?.id&&supervisionTable(d)&&taskReadStatement(d,`SELECT 1 FROM task_supervision_actions
    WHERE supervisor_user_id=? AND (action_task_id=? OR counterpart_task_id=?) LIMIT 1`).get(me,task.id,task.id);
  const supervised=linked?taskAssignedSupervisionActions(d,actor)
    .filter(row=>row.action_task_id===task.id||row.counterpart_task_id===task.id):[];
  const own = Number(task?.created_by) === me || (!supportSource&&assigned.includes(me)&&(!mappedSource||supervised.length>0))
    || (!projection && parent && !assigned.length && parentOwn);
  const canSeeRow = row => row && (row.visibility === 'all' || !row.visibility || Number(row.created_by) === me
    || (row.visibility === 'assignees' && assignments(d,row).includes(me)));
  const visible = canSeeRow(task) && (!mappedSource || canSeeRow(mappedSource)&&taskCapabilities(d,actor,mappedSource).view)
    &&(!supportSource||taskCapabilities(d,actor,{id:supportSource.source_task_id}).view);
  const ordinaryView=visible&&(allow('view_household')||own&&allow('view_own'));
  const childGrant=supervised.some(row=>row.action_task_id!==row.source_task_id);
  const view = Boolean(ordinaryView || childGrant&&(allow('view_household')||allow('view_own')));
  const locked = task?.locked ? task : parent?.locked ? parent : null;
  const definition = ordinaryView && !projection && (p.admin || !locked || Number(locked.created_by) === me);
  const result = { view, own: Boolean(own), create: allow('create'), edit: definition && allow(own ? 'edit_own' : 'edit_others'), complete: view && allow((own || supervised.some(row => row.action_task_id === task.id || row.counterpart_task_id === task.id)) ? 'complete_own' : 'complete_others') };
  for (const key of ['delete_archive', 'change_assignment', 'reassign', 'change_priority', 'change_points', 'change_category_tags', 'change_dates', 'change_required_skills']) result[key] = definition && allow(key);
  result.comment = view && allow('comment');
  result.claim = ordinaryView && !projection && allow('claim');
  result.skip_occurrence = definition && allow('skip_occurrence');
  // Missing/draft Tasks retain their existing input-based fallback. Two such
  // inputs need not mean the same thing, so only persisted records are cached.
  rewardTaskCapabilities(d,actor,task,result);
  const manager=taskReadStatement(d,'SELECT role,family_role FROM users WHERE id=?').get(me);
  result.close_incomplete=Boolean(manager&&(manager.role==='admin'||['dad','mom','parent'].includes(manager.family_role))
    &&p.modules.tasks==='write'&&result.skip_occurrence&&!task?.parent_task_id&&!projection);
  if (scope && stored) scope.capabilities.set(id, {...result});
  return result;
}
export function attachTaskCapabilities(d, actor, tasks) {
  for (const task of tasks) {
    task.permissions = taskCapabilities(d, actor, task);
    if(taskWindowAncestors(d,task.id).some(row=>['skipped','closed_incomplete'].includes(row.status))||taskCompletedScope(d,task.id)) {
      task.permissions.complete=false;task.permissions.claim=false;
    }
    // A closed optional branch is a lifecycle restriction, not a change to the
    // member's permissions. Hide its progress controls while retaining the
    // explicit parent-reopening error for attempted mutations.
    if (task.parent_task_id && taskOptionalContext(d, task.id).closed_parent) task.permissions.complete = false;
    if (Array.isArray(task.subtasks)) attachTaskCapabilities(d, actor, task.subtasks);
  }
  return tasks;
}

/** Choosing a helper changes the canonical Task's whole supervised scope. */
export function taskSupervisionManagementAllowed(d, actor, sourceTaskId) {
  const source = taskReadRecord(d,sourceTaskId);
  if (!source) return false;
  const p = readPermissions(d, actor), me = actorId(actor);
  const capabilities = taskCapabilities(d, actor, source);
  return Boolean((p.admin || Number(source.created_by) === me)
    && capabilities.view && capabilities.change_assignment && capabilities.reassign);
}

/** Operational status actions do not require permission to edit definitions. */
export function assertTaskMutation(d, actor, task, body = {}, { operation = task ? 'update' : 'create' } = {}) {
  const previous = readProjections.get(d);
  readProjections.delete(d);
  try { return assertCurrentTaskMutation(d, actor, task, body, {operation}); }
  finally { if (previous) readProjections.set(d, previous); }
}
function assertCurrentTaskMutation(d, actor, task, body, {operation}) {
  const rewardCompletionReplay=assertRewardTaskMutation(d,actor,task,body,operation)===true;
  const direct=task?taskDirectAssignmentSelection(d,task,body):null;
  const assignmentChanged=()=>!!direct&&!equal(ids(direct.selected),ids(direct.previous));
  const device = taskDevicePrincipal(actor);
  if (device) {
    const requireKey=key=>{if(!deviceAllows(device,`tasks.${key}`))throw new PermissionError('This display does not permit this Task setting.');};
    if(!task) {
      if(!deviceAllows(device,'tasks.create'))throw new PermissionError('This display cannot create Tasks.');
      for(const [key,fields] of Object.entries(PROTECTED_FIELDS))if(fields.some(field=>nonDefaultCreateValue(field,body[field])))requireKey(key);
      return;
    }
    const c = task && deviceTaskCapabilities(d, device, task);
    if (!c?.view) throw new PermissionError(task ? 'Task not found.' : 'This display cannot create Tasks.', task ? 404 : 403);
    if (operation === 'claim' && c.claim) return;
    if (operation === 'status') {
      // A checklist checkbox reopens exactly its completed leaf. Reset is a
      // separate grant for clearing a root/parent or explicitly resetting work.
      const leafReopen = body.status==='open' && task.status==='done' && task.parent_task_id && body.reset_progress!==true
        && !d.prepare(`SELECT 1 FROM tasks t WHERE t.parent_task_id=? AND t.archived_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
          AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id) LIMIT 1`).get(task.id);
      const allowed = body.status === 'done' ? c.complete
        : task.status === 'done' ? c.reopen && (body.status !== 'open' || leafReopen || c.reset)
          : body.status === 'open' ? c.reset : c.complete;
      if (allowed) return;
    }
    if(operation==='update' && c.edit) {
      for(const [key,fields] of Object.entries(PROTECTED_FIELDS))if(fields.some(field=>body[field]!==undefined
        && (['assigned_to','direct_assignee_ids'].includes(field)?assignmentChanged():String(body[field]??'')!==String(task[field]??'')))) {
        requireKey(key);if(key==='change_assignment')requireKey('reassign');
      }
      return;
    }
    throw new PermissionError('This display does not permit this Task action.');
  }
  const p = actorPermissions(d, actor);
  const requireKey = key => { if (p.capabilities[`tasks.${key}`] !== 'allow') throw new PermissionError('Your household permissions do not allow this Task action.'); };
  if (!task) {
    requireKey('create');
    if (body.parent_task_id) {
      const parent = d.prepare('SELECT * FROM tasks WHERE id = ?').get(body.parent_task_id);
      if (!parent) throw new PermissionError('Task not found.', 404);
      if (!taskCapabilities(d, actor, parent).edit) throw new PermissionError('You cannot change this Task’s subtasks.');
    }
    for (const [key, fields] of Object.entries(PROTECTED_FIELDS)) {
      if (fields.some(field => nonDefaultCreateValue(field, body[field]))) requireKey(key);
    }
    if ((body.activity_template_id || body.activity_binding) && p.capabilities['activities.view'] !== 'allow') throw new PermissionError('You cannot use Activity Templates.');
    for (const child of body.subtasks || []) if (Array.isArray(child.skill_ids) && child.skill_ids.length) requireKey('change_required_skills');
    return;
  }
  const c = taskCapabilities(d, actor, task);
  if (!c.view) throw new PermissionError('Task not found.', 404);
  const requireAction = key => { if (!c[key]) throw new PermissionError('Your household permissions do not allow this Task action.'); };
  if (operation === 'close_incomplete') return requireAction('close_incomplete');
  if (operation === 'reopen') { requireAction('edit'); return requireAction('change_dates'); }
  if (operation === 'skip') return requireAction('skip_occurrence');
  if (['status', 'check'].includes(operation)) {
    // The prize guard freshly authorizes this exact no-op. Keep it separate
    // from the displayed ability to change a completed delivery's status.
    if(rewardCompletionReplay)return;
    return requireAction('complete');
  }
  if (['delete', 'archive'].includes(operation)) return requireAction('delete_archive');
  if (operation === 'comment') return requireAction('comment');
  if (operation === 'claim') return requireAction('claim');
  if (operation === 'assignment') { requireAction('change_assignment'); return requireAction('reassign'); }
  if (operation === 'documents') return requireAction('edit');
  const changed = field => {
    if (body[field] === undefined) return false;
    if (field === 'assigned_to' || field === 'direct_assignee_ids') return assignmentChanged();
    if (field === 'rotation_user_ids') return !equal(body[field],d.prepare('SELECT user_id FROM task_rotation_members WHERE task_id=? ORDER BY sort_order').all(task.id).map(row=>row.user_id));
    if (field === 'skill_ids') return !equal(ids(body[field]), ids(d.prepare('SELECT skill_id FROM task_skill_requirements WHERE task_id = ?').all(task.id).map(row => row.skill_id)));
    if (field === 'tags') return !equal(idsOrStrings(body[field]), idsOrStrings(d.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(task.id).map(row => row.tag)));
    if (field === 'location') return true;
    if (Array.isArray(body[field])) return !equal(body[field], task[field] || []);
    return String(body[field] ?? '') !== String(task[field] ?? '');
  };
  if (body.status === 'archived') requireAction('delete_archive');
  else if (changed('status')) requireAction('complete');
  const definitionFields = ['card_color_choice','title', 'description', 'visibility', 'sync_target', 'locked', 'parent_task_id', 'location', 'countdown', 'subtasks', 'is_optional', 'activity_template_id', 'activity_subject_user_id', 'activity_inputs', 'activity_binding', 'expiration_policy', 'scoring_mode'];
  if (definitionFields.some(changed)) requireAction('edit');
  const me = actorId(actor);
  // Joining/leaving only one's own assignment is the legacy claim interaction,
  // including on a locked instruction. It cannot remove or add another member.
  const selfAssignmentOnly = assignmentChanged()
    && equal(ids(direct.selected).filter(id => id !== me), ids(direct.previous).filter(id => id !== me))
    && !PROTECTED_FIELDS.change_assignment.filter(field => !['assigned_to','direct_assignee_ids'].includes(field)).some(changed);
  for (const [key, fields] of Object.entries(PROTECTED_FIELDS)) {
    if (!fields.some(changed)) continue;
    requireAction(key === 'change_assignment' && selfAssignmentOnly ? 'claim' : key);
  }
  if (PROTECTED_FIELDS.change_assignment.some(changed) && !selfAssignmentOnly) requireAction('reassign');
  if ((changed('activity_template_id') || changed('activity_binding')) && p.capabilities['activities.view'] !== 'allow') throw new PermissionError('You cannot use Activity Templates.');
}
const idsOrStrings = value => (Array.isArray(value) ? value : []).map(String).sort();
const PROTECTED_FIELDS = Object.freeze({
  change_assignment: ['assigned_to', 'direct_assignee_ids', 'owner_user_id', 'assignment_mode', 'rotation_user_ids', 'rotation_group', 'rotation_slot', 'activity_template_id', 'activity_subject_user_id', 'activity_inputs', 'activity_binding'],
  change_priority: ['priority'], change_points: ['points','scoring_mode'], change_category_tags: ['category', 'tags'],
  change_dates: ['expiration_policy', 'start_time', 'start_date', 'due_date', 'due_time', 'is_recurring', 'recurrence_rule', 'recurrence_from_completion'],
  change_required_skills: ['skill_ids', 'activity_template_id', 'activity_binding'],
});
function nonDefaultCreateValue(field, value) {
  if (field === 'expiration_policy' && value === 'keep_overdue') return false;
  if (value == null || value === '' || value === false || value === 0 || (Array.isArray(value) && !value.length)) return false;
  if ((field === 'priority' && value === 'none') || (field === 'category' && value === 'misc') || (field === 'assignment_mode' && value === 'fixed')) return false;
  return true;
}

export function taskReadTableExists(d, name) {
  const scope = currentReadProjection(d);
  if (scope?.tables.has(name)) return scope.tables.get(name);
  const exists = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (scope) scope.tables.set(name, exists);
  return exists;
}
function supervisionTable(d) { return taskReadTableExists(d, 'task_supervision_actions'); }
function supportTable(d) { return taskReadTableExists(d, 'task_activity_support_tasks'); }
