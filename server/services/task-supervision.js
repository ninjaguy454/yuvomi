import {assignNewTaskCardColor} from './task-card-colors.js';
import {persistNewTaskAssignees,updateCapturedDirectAssignees} from './task-assignee-policy.js';
/** Linked supervision uses the source action's Task status as its only completion authority. */
import { householdMembers } from './activity-eligibility.js';
import { activityPresenceWindow, availabilityInstantMs } from './presence.js';
import { todayKey, householdTimeZone } from '../utils/timezone.js';
import { enqueueNotification } from './notification-inbox.js';
import { syncWorkflowInstanceForTask } from './activity-workflows.js';
import { taskCapabilities, taskSupervisionManagementAllowed } from './task-access.js';
import { createHash } from 'node:crypto';
import { activitySnapshotSkills, parseTaskActivitySnapshot } from './task-activity-snapshot.js';
import { previewTaskActivityBinding } from './task-activity-bindings.js';
import { assertTaskSkillAssignments } from './task-skills.js';
import {actorPermissions} from '../permissions.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
import {inspectTaskSupervision,taskSupervisionRootId,assertTaskSupervisionAssignee,TaskSupervisionError,
  skillEligibilityByView,actionWindowsByView,actionEligibleByView,unassignedReasonByAction,
  supported,task,context,ordinaryTaskScope,explicitSkills,eligibilityReaders,assessTaskSupervisionAction,singleSupervisorScope}
  from './task-supervision-inspection.js';
export {inspectTaskSupervision,taskSupervisionRootId,assertTaskSupervisionAssignee,TaskSupervisionError}
  from './task-supervision-inspection.js';
// Reconciliation and prospective plans use the same fresh choice order.
function selectTaskSupervisor(view, { requestedSupervisor, currentIds = [], attempted = new Set() } = {}) {
  const currentEligible = currentIds.length === 1 && !attempted.has(currentIds[0])
    ? view.eligible_supervisors.find(member => member.id === currentIds[0]) : null;
  const selectedId = requestedSupervisor !== undefined ? requestedSupervisor
    : view.supervisor_user_id || currentEligible?.id || view.eligible_supervisors.find(member => !attempted.has(member.id))?.id || null;
  return view.eligible_supervisors.find(member => member.id === Number(selectedId));
}

function projectionUnavailable() {
  const error = new Error('The prospective execution context cannot be prepared safely.');
  error.status = 409; error.reason = 'scoring_projection_unavailable'; return error;
}
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const referenceKey = ref => ref?.kind === 'definition_root' && Object.keys(ref).length === 1 ? 'root'
  : ref?.kind === 'template' && Object.keys(ref).length === 2 && positiveId(ref.template_id) ? `template:${ref.template_id}`
  : ref?.kind === 'draft' && Object.keys(ref).length === 2 && Number.isSafeInteger(ref.draft_index) && ref.draft_index >= 0 ? `draft:${ref.draft_index}` : null;
function preparedIds(values, allowed) {
  if (!Array.isArray(values) || values.some(id => !positiveId(id) || !allowed.has(id)) || new Set(values).size !== values.length) throw projectionUnavailable();
  return [...values];
}
function preparationContext(value) {
  const date = input => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) && !Number.isNaN(Date.parse(input));
  const current = value?.kind === 'current_occurrence';
  if ((!current && value?.kind !== 'next_occurrence') || (current ? value.generation != null || value.assumed_completion_date != null || value.preparation !== 'existing_untouched' : !Number.isSafeInteger(value.generation) || value.generation < 1) || !date(value.as_of_date)
    || value.assumed_completion_date != null && !date(value.assumed_completion_date)
    || !['fresh','existing_untouched'].includes(value.preparation) || !Array.isArray(value.conditions)
    || value.conditions.some(condition => typeof condition !== 'string')) throw projectionUnavailable();
  return { kind: value.kind, generation: value.generation ?? null, as_of_date: value.as_of_date,
    assumed_completion_date: value.assumed_completion_date ?? null, preparation: value.preparation, conditions: [...value.conditions] };
}

/** Private, read-only execution facts for a complete proposed occurrence.
 * Operational assignments here never replace the definition's read joins.
 * References are definition identities; no Task lookup or helper projection is
 * created. Callers authorize and project the resulting facts separately. */
export function prepareProspectiveTaskExecution(d, input) {
  try {
    const ctx = preparationContext(input?.context), members = householdMembers(d), byId = new Map(members.map(member => [member.id, member]));
    const skillIds = new Set(d.prepare('SELECT id FROM skills').all().map(row => row.id));
    if (!Array.isArray(input.actions) || referenceKey(input.root?.ref) !== 'root') throw projectionUnavailable();
    const keys = new Set(), nodes = [input.root, ...input.actions].map((node, index) => {
      const key = referenceKey(node?.ref);
      if (!key || keys.has(key) || index > 0 && key === 'root' || !['source_root','source_action','helper_projection','container'].includes(node.role)
        || ctx.kind !== 'current_occurrence' && node.ref.kind === 'draft'
        || Object.hasOwn(node,'completed') && (ctx.kind !== 'current_occurrence' || typeof node.completed !== 'boolean')
        || index === 0 && node.role === 'source_action' || index > 0 && node.role === 'source_root'
        || !node.task || Object.hasOwn(node.task,'id') || Object.hasOwn(node.task,'parent_task_id') || node.task.status !== 'open' || node.task.archived_at != null
        || typeof node.is_optional !== 'boolean' || !node.window || typeof node.window !== 'object'
        || !Object.hasOwn(node,'primary_user_id') || node.primary_user_id !== null && (!positiveId(node.primary_user_id) || !byId.has(node.primary_user_id))) throw projectionUnavailable();
      keys.add(key);
      const assigned = preparedIds(node.assigned_user_ids, byId), required = preparedIds(node.skill_ids, skillIds);
      if (node.primary_user_id != null && assigned.length && !assigned.includes(node.primary_user_id)) throw projectionUnavailable();
      const hasSkillAssignees = Object.hasOwn(node,'skill_assignee_user_ids');
      if (hasSkillAssignees && (index !== 0 || ctx.preparation !== 'fresh' || node.role !== 'source_root' || node.binding != null)) throw projectionUnavailable();
      const skillAssigned = hasSkillAssignees ? preparedIds(node.skill_assignee_user_ids, byId) : assigned;
      return { ...node, ref: structuredClone(node.ref), key, assigned, required, skillAssigned, id: -index-1,
        task: { ...node.task, ...node.window, id: -index-1, revision: 0 } };
    });
    const root = nodes[0], selection = input.selection ?? {};
    if (Object.hasOwn(root,'skill_assignee_user_ids')) {
      const independent = new Set(root.skillAssigned), childParticipants = new Set(nodes.slice(1)
        .filter(node => node.role === 'source_action').flatMap(node => node.assigned));
      if (root.skillAssigned.some(id => !root.assigned.includes(id))
        || root.primary_user_id !== null && !independent.has(root.primary_user_id)
        || root.assigned.some(id => !independent.has(id) && !childParticipants.has(id))) throw projectionUnavailable();
    }
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.hasOwn(selection,'preferred_supervisor_user_ids') && !Array.isArray(selection.preferred_supervisor_user_ids)
      || Object.hasOwn(selection,'attempted_supervisor_user_ids') && !Array.isArray(selection.attempted_supervisor_user_ids)
      || Object.hasOwn(selection,'prior_units') && !Array.isArray(selection.prior_units)) throw projectionUnavailable();
    const selectedIds = preparedIds(selection.preferred_supervisor_user_ids || [], byId);
    const attempted = new Set(preparedIds(selection.attempted_supervisor_user_ids || [], byId));
    if (selection.requested_supervisor_user_id != null && !byId.has(selection.requested_supervisor_user_id)) throw projectionUnavailable();
    if (ctx.preparation === 'fresh' && (selectedIds.length || attempted.size || Object.hasOwn(selection,'requested_supervisor_user_id') || selection.prior_units?.length)) throw projectionUnavailable();
    if (ctx.preparation === 'existing_untouched' && (!Object.hasOwn(selection,'preferred_supervisor_user_ids')
      || !Object.hasOwn(selection,'attempted_supervisor_user_ids') || !Array.isArray(selection.prior_units))) throw projectionUnavailable();
    const priors = new Map();
    for (const prior of selection.prior_units || []) {
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)
        || !Object.hasOwn(prior,'learner_user_id') || !Object.hasOwn(prior,'supervisor_user_id')) throw projectionUnavailable();
      const key = referenceKey(prior.ref);
      if (!keys.has(key) || priors.has(key) || prior.learner_user_id !== null && (!positiveId(prior.learner_user_id) || !byId.has(prior.learner_user_id))
        || prior.supervisor_user_id !== null && (!positiveId(prior.supervisor_user_id) || !byId.has(prior.supervisor_user_id))) throw projectionUnavailable();
      priors.set(key, prior);
    }
    let rootSkills = root.required, planning = root.planning || {}, freshPreferred = [];
    if (root.binding) {
      const binding = root.binding;
      if (!positiveId(binding.activity_template_id) || !binding.snapshot) throw projectionUnavailable();
      let activity = parseTaskActivitySnapshot(binding.snapshot);
      if (Number(activity.id) !== binding.activity_template_id) throw projectionUnavailable();
      if (ctx.preparation === 'fresh') {
        // Random assignment is a condition, not a deterministic next recipient.
        if (!binding.assignment_override_user_id && ['eligible_random','random'].includes(activity.assignment_policy || activity.assignment_strategy)) throw projectionUnavailable();
        const planned = previewTaskActivityBinding(d, { activityTemplateId: binding.activity_template_id, subjectUserId: binding.subject_user_id,
          assignmentOverrideUserId: binding.assignment_override_user_id, activitySnapshot: activity,
          task: root.task, dateKey: root.task.due_date || root.task.start_date || ctx.as_of_date });
        activity = planned.activity;
        if ((planned.resolution.primary?.id ?? null) !== root.primary_user_id) throw projectionUnavailable();
        // Binding-owned participants are distinct from a helper and from extra
        // explicit child owners prepared by the Task participant service.
        const participants = planned.resolution.participants?.length ? planned.resolution.participants : planned.resolution.primary ? [planned.resolution.primary] : [];
        if (participants.some(member => !root.assigned.includes(member.id))) throw projectionUnavailable();
        freshPreferred = planned.resolution.supervisor?.id ? [planned.resolution.supervisor.id] : [];
      }
      // An untouched target already owns its operational assignment. Its
      // frozen requirements/presence remain live eligibility inputs, without
      // consuming or re-resolving the next-generation assignment cursor.
      rootSkills = activitySnapshotSkills(d, activity).map(skill => skill.id);
      planning = { place_id: activity.location_mode === 'fixed' ? activity.place_id : null,
        presence_policy: activity.presence_policy, presence_window: activity.presence_window };
    }
    if (ctx.preparation === 'fresh' && !root.binding && !['container','helper_projection'].includes(root.role)) assertTaskSkillAssignments(d,rootSkills,root.skillAssigned,
      root.task.due_date || root.task.start_date || ctx.as_of_date);
    const { proficiencyFor, availabilityFor } = eligibilityReaders(d), actions = [], facts = [];
    for (const node of nodes) {
      const fact = { ref: node.ref, role: node.role, assigned_user_ids: [...node.assigned], supervision: null }; facts.push(fact);
      if (node.completed) continue; // Settled/current history does not constrain the remaining helper choice.
      if (['container','helper_projection'].includes(root.role) || ['container','helper_projection'].includes(node.role)) continue;
      const learnerId = node.primary_user_id ?? root.primary_user_id ?? null, learner = byId.get(learnerId);
      const occurrence = { ...root.task, ...node.task };
      for (const field of ['start_date','start_time','due_date','due_time']) occurrence[field] = node.task[field] || root.task[field] || null;
      const dateKey = occurrence.due_date || occurrence.start_date || ctx.as_of_date, pc = node.planning || planning;
      const presence = { policy: pc.presence_policy || 'ignore', targetPlaceId: pc.place_id || null,
        ...activityPresenceWindow(d, { task: occurrence, dateKey, windowMode: pc.presence_window || 'due' }) };
      const skills = (node === root ? rootSkills : node.required).map(id => d.prepare('SELECT * FROM skills WHERE id=?').get(id));
      if (!learner) continue; // Unassigned work has the existing assignment-needed semantics.
      const assessed = skills.map(skill => ({ skill, ...proficiencyFor(skill, learner, dateKey) }));
      const excluded = assessed.filter(item => item.proficiency === 'excluded'), required = assessed.filter(item => item.proficiency === 'supervised').map(item => item.skill);
      const prior = priors.get(node.key);
      if (!prior && !excluded.length && !required.length) continue;
      const action = assessTaskSupervisionAction({ row: node.task, sourceId: root.id, learnerId, learner, skills, assessed, excluded, required,
        prior, members, byId, dateKey, presence, proficiencyFor, availabilityFor, skillEligibility: [],
        previousSupervisorFor: () => prior?.supervisor_user_id ?? freshPreferred[0] ?? null, counterpartRevisionFor: () => null });
      action.is_optional = node.is_optional; action.fact = fact; actions.push(action);
    }
    const currentIds = ctx.preparation === 'fresh' ? freshPreferred : selectedIds;
    const scope = singleSupervisorScope(actions, members, currentIds), view = { ...scope, actions };
    const requestedSupervisor = Object.hasOwn(selection,'requested_supervisor_user_id') ? selection.requested_supervisor_user_id : undefined;
    if (requestedSupervisor != null && !view.eligible_supervisors.some(member => member.id === requestedSupervisor)) throw projectionUnavailable();
    const selected = selectTaskSupervisor(view, { requestedSupervisor, currentIds, attempted });
    for (const action of actions) {
      const helper = selected && (!action.is_optional || action.eligible_supervisors.some(member => member.id === selected.id)) ? selected : null;
      action.fact.supervision = { execution_mode: action.execution_mode,
        state: action.state === 'not_required' ? 'not_required' : helper ? 'assigned' : 'unresolved',
        learner_user_id: action.learner_user_id, supervisor_user_id: action.state === 'not_required' ? null : helper?.id ?? null };
    }
    const unresolved = facts.some(fact => fact.supervision?.state === 'unresolved');
    return { context: ctx, units: facts, warnings: unresolved ? [{ reason: 'prospective_supervision_unresolved', message: 'The prospective occurrence requires supervision that is not currently resolved.' }] : [] };
  } catch (error) {
    if (error.reason === 'scoring_projection_unavailable') throw error;
    throw projectionUnavailable();
  }
}

function insertProjection(d, source, title, parentId, assignedTo) {
  const id = Number(d.prepare(`INSERT INTO tasks(title,description,category,priority,status,start_date,start_time,due_date,due_time,
    assigned_to,created_by,parent_task_id,points,visibility) VALUES(?,NULL,?,'none','open',?,?,?,?,?,?,?,0,?)`)
    .run(title, source.category || 'misc', source.start_date, source.start_time ?? null, source.due_date, source.due_time,
      assignedTo || null, source.created_by, parentId, source.visibility || 'all').lastInsertRowid);
  assignNewTaskCardColor(d,id,{inheritFrom:source.id});
  persistNewTaskAssignees(d,id,assignedTo?[Number(assignedTo)]:[]);
  d.prepare(`INSERT INTO task_planning_context(task_id,place_id,presence_policy,presence_window,source)
    SELECT ?,place_id,presence_policy,presence_window,source FROM task_planning_context WHERE task_id = ?`).run(id, source.id);
  return id;
}

function setProjectionAssignees(d, id, userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(Number))];
  const current = d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row => Number(row.user_id));
  if ((task(d, id)?.assigned_to || null) === (ids[0] || null)
    && current.length === ids.length && current.every(uid => ids.includes(uid))) return;
  updateCapturedDirectAssignees(d,id,ids);
  d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(ids[0] || null, id);
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(id);
  for (const uid of ids) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, uid);
}

function syncProjectionArchive(d, id, archived) {
  if (Boolean(task(d, id)?.archived_at) === Boolean(archived)) return;
  d.prepare(`UPDATE tasks SET archived_at=${archived ? NOW : 'NULL'} WHERE id=?`).run(id);
}

export function taskSupervisionNotificationKey(view,{userId=null,manager=false}={}) {
  const pending = view.actions.filter(action => !action.completed && action.state !== 'not_required');
  const local=view.supervisor_scope==='per_action'&&userId!=null;
  const relevant=local?pending.filter(action=>Number(action.supervisor_user_id)===Number(userId)
    ||manager&&action.state!=='assigned'):pending;
  const signature = local?['per_action',Number(userId),relevant.map(action=>[action.id,action.revision,action.supervisor_user_id,action.state])]
    :[view.state, view.supervisor_user_id, pending.map(action => [action.id, action.revision, action.supervisor_user_id, action.state])];
  return `task-supervision-scope:${view.source_task_id}:${createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 24)}`;
}

function notifySupervision(d, source, view, changedActionIds=null) {
  if (['done', 'expired','skipped','closed_incomplete'].includes(source.status) || view.state === 'none') return;
  const unresolved = ['needed', 'excluded'].includes(view.state);
  const pending = view.actions.filter(action => !action.completed && action.state !== 'not_required');
  const supervisors=view.supervisor_scope==='per_action'?[...new Set(pending.map(action=>action.supervisor_user_id).filter(Boolean))]
    :view.supervisor_user_id?[view.supervisor_user_id]:[];
  const recipients = unresolved ? [source.created_by, ...d.prepare("SELECT id FROM users WHERE role='admin'").all().map(row => row.id),...supervisors]
    : supervisors;
  for (const userId of new Set(recipients.filter(Boolean).map(Number))) {
    const manager=userId===source.created_by||d.prepare("SELECT role FROM users WHERE id=?").get(userId)?.role==='admin';
    const relevant=view.supervisor_scope==='per_action'
      ?pending.filter(action=>action.supervisor_user_id===userId||unresolved&&manager&&action.state!=='assigned')
      :pending;
    if(view.supervisor_scope==='per_action'&&!relevant.some(action=>changedActionIds?.has(action.action_task_id)))continue;
    const delegated=relevant.some(action=>action.execution_mode==='delegated');
    const recipientUnresolved=view.supervisor_scope==='per_action'
      ?relevant.some(action=>action.state!=='assigned'):unresolved;
    enqueueNotification(d,{
      userId, sourceKey: taskSupervisionNotificationKey(view,{userId,manager}), category: 'automation',
      entityType: 'task', entityId: taskCapabilities(d,userId,source).view?source.id:relevant[0]?.action_task_id, title: delegated ? (recipientUnresolved ? 'Helper needed' : 'Helper work assigned')
        : recipientUnresolved ? 'Supervision needed' : 'Supervision requested',
      body: relevant.every(action=>taskCapabilities(d,userId,{id:action.action_task_id}).view)
        ? `${taskCapabilities(d,userId,source).view?`${source.title}: `:''}${relevant.map(action=>`${action.execution_mode==='delegated'?'Perform':'Supervise'}: ${action.action_title}`).join('; ')}.${view.supervisor_scope==='per_action'?'':` ${view.display_reason||view.reason}`}`
        : 'This Task needs supervision. Review the parts you can access or contact the responsible member.',
    });
  }
}

/** Fold older ordinary nested scopes into one source without deleting their audit records. */
function consolidateNestedSupervision(d, sourceId, actorId) {
  const ids = ordinaryTaskScope(d, sourceId).map(row => row.id);
  if (ids.length < 2) return;
  const marks = ids.map(() => '?').join(',');
  const mappings = d.prepare(`SELECT * FROM task_supervision_actions WHERE action_task_id IN (${marks})`).all(...ids);
  const supports = d.prepare(`SELECT * FROM task_activity_support_tasks WHERE source_task_id IN (${marks}) ORDER BY task_id`).all(...ids);
  const primary = supports.find(row => row.source_task_id === sourceId) || supports[0];
  if (!primary) return;
  const previousSources = new Set(mappings.filter(row => row.source_task_id !== sourceId).map(row => row.source_task_id)
    .concat(supports.filter(row => row.source_task_id !== sourceId).map(row => row.source_task_id)));
  if (!previousSources.size) return;
  let changed = false;
  if (primary.source_task_id !== sourceId) {
    d.prepare('UPDATE task_activity_support_tasks SET source_task_id=? WHERE task_id=?').run(sourceId, primary.task_id);
    d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(sourceId, primary.task_id);
    changed = true;
  }
  for (const mapping of mappings) {
    if (mapping.source_task_id !== sourceId) {
      d.prepare(`UPDATE task_supervision_actions SET source_task_id=?,revision=revision+1,updated_at=${NOW} WHERE id=?`).run(sourceId, mapping.id);
      changed = true;
    }
    if (mapping.counterpart_task_id && task(d,mapping.counterpart_task_id)?.parent_task_id !== primary.task_id)
      d.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(primary.task_id, mapping.counterpart_task_id);
  }
  for (const previousId of previousSources) {
    d.prepare(`UPDATE task_responsibilities SET status='superseded',updated_at=${NOW}
      WHERE task_id=? AND role='supervisor' AND status='active'`).run(previousId);
    d.prepare(`UPDATE planning_obligations SET status='superseded',updated_at=${NOW}
      WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted')`).run(previousId);
  }
  for (const support of supports) if (support.task_id !== primary.task_id) {
    setProjectionAssignees(d,support.task_id,[]);
    syncProjectionArchive(d,support.task_id,true);
  }
  if (changed) d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
    VALUES(?,?,?,'supervision_consolidated',?)`).run(sourceId,sourceId,actorId,
      JSON.stringify({title:task(d,sourceId).title,reason:'Nested checklist supervision now uses one linked Task. Existing progress and history were retained.'}));
}

/** Persist only changed supervision facts. Read-time calls never invoke this function. */
export function reconcileTaskSupervision(d, taskId, { actorId = null, supervisorUserId = undefined, actionTaskId = null, supervisorAssignments = null, perActionPlanning = false, notify = true } = {}) {
  if (!supported(d)) return inspectTaskSupervision(d, taskId);
  return d.transaction(() => {
    const current=task(d,taskSupervisionRootId(d,taskId));
    if(current&&(context(d,current,current).skipped||context(d,current,current).closed_incomplete))return inspectTaskSupervision(d,taskId);
    consolidateNestedSupervision(d,taskSupervisionRootId(d,taskId),actorId);
    let view = inspectTaskSupervision(d, taskId);
    const actionWindows = actionWindowsByView.get(view);
    const projectionWindows = new Map();
    const source = task(d, view.source_task_id);
    if (!source) return view;
    // Retained action-scoped API inputs now choose for the entire source Task.
    if (actionTaskId != null && !view.actions.some(action => Number(action.action_task_id) === Number(actionTaskId)))
      throw new TaskSupervisionError('Choose a supervised action belonging to this Task.');
    const requestedIds=Object.values(supervisorAssignments||{}).map(Number);
    if(!perActionPlanning&&view.supervisor_scope!=='per_action'&&new Set(requestedIds).size>1)
      throw new TaskSupervisionError('A Task can have only one supervisor. Choose one person for all remaining requirements.');
    const perAction=view.supervisor_scope==='per_action'||perActionPlanning&&(new Set(requestedIds).size>1
      ||requestedIds.some(id=>!view.eligible_supervisors.some(member=>member.id===id)));
    if(perAction&&supervisorUserId!==undefined)
      throw new TaskSupervisionError('Choose the supervisor for each affected action.');
    const requestedSupervisor=supervisorUserId===undefined&&!perAction?requestedIds[0]:supervisorUserId;
    const localEligible=actionEligibleByView.get(view)||new Map();
    const actionChoices=new Map();
    if(supervisorAssignments){
      if(Object.keys(supervisorAssignments).some(id=>!view.actions.some(action=>action.action_task_id===Number(id))))
        throw new TaskSupervisionError('Choose a supervised action belonging to this Task.');
      for(const [id,value] of Object.entries(supervisorAssignments)){
        if(value!==null&&(!positiveId(Number(value))||!(localEligible.get(Number(id))||[]).some(member=>member.id===Number(value))))
          throw new TaskSupervisionError('Choose a qualified and available supervisor for each affected action.');
        if(value===null&&!perActionPlanning)throw new TaskSupervisionError('Choose a qualified supervisor for each affected action.');
        actionChoices.set(Number(id),value===null?null:Number(value));
      }
    }
    const previous = d.prepare('SELECT * FROM task_supervision_actions WHERE source_task_id = ?').all(source.id);
    const changedActionIds=new Set();
    if (!perAction&&requestedSupervisor != null && !view.eligible_supervisors.some(member => member.id === Number(requestedSupervisor)))
      throw new TaskSupervisionError('Choose one supervisor who is independently qualified and shares an eligible time for every remaining required action.');
    const attempted = new Set(d.prepare(`SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor'
      AND status IN ('declined','timed_out')`).all(source.id).map(row => row.responsible_user_id));
    const currentIds = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'")
      .all(source.id).map(row => row.user_id);
    const selected = perAction?null:selectTaskSupervisor(view, { requestedSupervisor, currentIds, attempted });
    let changedScope = false;
    let supportId = view.support_task_id;
    const needsWork = view.actions.some(action => action.state !== 'not_required' && !action.completed);
    if (!supportId && needsWork) {
      // Adopt a legacy Workflow supervisor rather than duplicating it.
      const legacy = d.prepare(`SELECT sibling.task_id FROM workflow_instance_tasks own JOIN workflow_instance_tasks sibling
        ON sibling.workflow_instance_id=own.workflow_instance_id AND sibling.workflow_step_id=own.workflow_step_id
        WHERE own.task_id=? AND own.role='primary' AND sibling.role='supervisor' LIMIT 1`).get(source.id);
      supportId = legacy?.task_id || insertProjection(d, source, `Supervise ${source.title}`, source.id, null);
      d.prepare("INSERT INTO task_activity_support_tasks(source_task_id,task_id,role) VALUES(?,?,'supervisor')").run(source.id, supportId);
    }
    if(supportId&&perAction&&view.supervisor_scope!=='per_action')
      d.prepare("UPDATE task_activity_support_tasks SET supervisor_scope='per_action' WHERE task_id=? AND supervisor_scope!='per_action'").run(supportId);
    for (const action of view.actions) {
      if (action.completed) {
        if (action.counterpart_task_id) {
          // The historical actor stays on the immutable action snapshot, not
          // in an additional active helper Task assignment.
          setProjectionAssignees(d, action.counterpart_task_id, []);
          syncProjectionArchive(d, action.counterpart_task_id, action.archived || action.state === 'not_required');
        }
        continue;
      }
      const old = previous.find(row => row.action_task_id === action.action_task_id);
      // Expiration retires work, preserving the historical responsible person.
      const eligibleForAction=perAction?localEligible.get(action.action_task_id)||[]:action.eligible_supervisors;
      const chosenId=actionChoices.has(action.action_task_id)?actionChoices.get(action.action_task_id):old?.supervisor_user_id??null;
      const actionSupervisor=perAction?eligibleForAction.find(member=>member.id===chosenId)||null
        :selected&&(!action.is_optional||eligibleForAction.some(member=>member.id===selected.id))?selected:null;
      action.supervisor_user_id = action.expired||action.closed_optional ? old?.supervisor_user_id ?? null
        : actionSupervisor && action.state !== 'not_required' ? actionSupervisor.id : null;
      if (actionSupervisor && action.state !== 'not_required') {
        action.state = 'assigned'; action.supervisor_name = actionSupervisor.display_name;
        // Persist action-local facts. Completing another action must not create
        // a fresh assignment event/request just because the scope got shorter.
        action.reason = `${actionSupervisor.display_name} will ${action.execution_mode === 'delegated' ? 'perform' : 'supervise'} this action (${action.required_skills.map(skill => skill.name).join(', ')}).`;
      } else if (action.state === 'assigned') { action.state = 'unresolved'; action.reason = perAction
        ? unassignedReasonByAction.get(action)
        : 'Supervision is needed. Assign one eligible supervisor for the entire Task.'; }
      let counterpartId = old?.counterpart_task_id || null;
      const projectionTitle = action.execution_mode === 'delegated' ? action.action_title : `Supervise: ${action.action_title}`;
      if (!counterpartId && supportId && action.state !== 'not_required') counterpartId = insertProjection(d, source, projectionTitle, supportId, action.supervisor_user_id);
      const snapshot = [action.learner_user_id, action.supervisor_user_id, JSON.stringify(action.required_skills.map(skill => skill.id)), action.state, action.reason, action.execution_mode];
      const changed = !old || [old.learner_user_id, old.supervisor_user_id, old.required_skill_ids_json, old.state, old.reason, old.execution_mode].some((value, index) => value !== snapshot[index]);
      if (!old) {
        action.id = Number(d.prepare(`INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,
          learner_user_id,supervisor_user_id,required_skill_ids_json,state,reason,execution_mode) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(source.id, action.action_task_id, counterpartId, ...snapshot).lastInsertRowid);
        action.revision = 1;
      } else if (changed || counterpartId !== old.counterpart_task_id) {
        d.prepare(`UPDATE task_supervision_actions SET counterpart_task_id=?,learner_user_id=?,supervisor_user_id=?,
          required_skill_ids_json=?,state=?,reason=?,execution_mode=?,revision=revision+1,updated_at=${NOW} WHERE id=?`)
          .run(counterpartId, ...snapshot, old.id);
        action.revision = old.revision + 1;
      }
      action.counterpart_task_id = counterpartId;
      if (counterpartId) {
        d.prepare('UPDATE tasks SET is_optional=? WHERE id=? AND is_optional!=?').run(action.is_optional?1:0,counterpartId,action.is_optional?1:0);
        setProjectionAssignees(d, counterpartId, action.state === 'assigned' ? [action.supervisor_user_id] : []);
        if (action.state !== 'not_required' && !action.expired && !action.archived)
          projectionWindows.set(counterpartId, { ...actionWindows.get(action.action_task_id), title: projectionTitle });
        if (!action.expired || action.archived) syncProjectionArchive(d, counterpartId, action.state === 'not_required');
      }
      // An event is visible through its own action. Keep its explanation local
      // so a shared Task-level candidate failure cannot reveal a private sibling.
      const actionSkills = action.required_skills.map(skill => skill.name).join(', ');
      const activityReason = action.state === 'assigned'
        ? `${action.supervisor_name} will ${action.execution_mode === 'delegated' ? 'perform' : 'supervise'} this action (${actionSkills}).`
        : action.state === 'not_required' ? 'This action no longer requires active supervision.'
          : action.state === 'excluded' ? `The assignee cannot currently perform this action's requirements (${actionSkills}), even with supervision.`
            : perAction?`A qualified supervisor is needed for this action (${actionSkills}).`
              : `One eligible supervisor is needed for the entire Task. This action requires ${actionSkills}.`;
      if (changed) d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,?,?)`).run(source.id, action.action_task_id, actorId,
          action.execution_mode === 'delegated' && old?.execution_mode !== 'delegated' ? 'action_delegated'
            : action.state === 'assigned' ? 'supervisor_assigned' : action.state === 'not_required' ? 'supervision_not_required' : 'supervision_needed',
          JSON.stringify({ title: action.action_title, learner_user_id: action.learner_user_id, supervisor_user_id: action.supervisor_user_id,
            execution_mode: action.execution_mode, previous_execution_mode: old?.execution_mode || null,
            previous_supervisor_user_id: old?.supervisor_user_id || null,
            required_skills: action.required_skills.map(skill => skill.name), reason: activityReason }));
      if(changed)changedActionIds.add(action.action_task_id);
      changedScope ||= changed;
    }
    const supervisors = perAction?[...new Set(view.actions.filter(action=>!action.completed&&action.state==='assigned')
      .map(action=>action.supervisor_user_id).filter(Boolean))].sort((a,b)=>a-b)
      :selected&&view.actions.some(action=>!action.completed&&action.state==='assigned')?[selected.id]:[];
    // This service owns supervisor role only, preserving learner and beneficiary obligations.
    const activeSupervisors = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(source.id).map(row => row.user_id);
    for (const uid of activeSupervisors.filter(id => !supervisors.includes(id))) d.prepare(`UPDATE task_responsibilities SET status='superseded',updated_at=${NOW}
      WHERE task_id=? AND user_id=? AND role='supervisor' AND status='active'`).run(source.id, uid);
    for (const uid of supervisors.filter(id => !activeSupervisors.includes(id))) d.prepare(`INSERT INTO task_responsibilities(task_id,user_id,role,source)
      VALUES(?,?,'supervisor','task_supervision') ON CONFLICT(task_id,user_id,role)
      DO UPDATE SET status='active',source='task_supervision',updated_at=${NOW}`).run(source.id, uid);
    // The persisted mappings now match these local actions. Projection status
    // needs their links and current source status, not another eligibility pass.
    view.support_task_id = supportId;
    const obligations = d.prepare(`SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted')
      ORDER BY CASE status WHEN 'accepted' THEN 0 ELSE 1 END,id DESC`).all(source.id);
    const dueInstant = source.due_date ? availabilityInstantMs(`${source.due_date}T${source.due_time || '23:59'}:00`, householdTimeZone(d)) : null;
    const due = dueInstant == null ? null : new Date(dueInstant).toISOString().replace('.000Z','Z');
    const retainedObligations=new Set();
    for (const obligation of obligations) if (!supervisors.includes(obligation.responsible_user_id)
      || retainedObligations.has(obligation.responsible_user_id)) {
      d.prepare(`UPDATE planning_obligations SET status='superseded',updated_at=${NOW} WHERE id=?`).run(obligation.id);
    } else {
      retainedObligations.add(obligation.responsible_user_id);
      // Linked supervision is executable work, not a second approval deadline.
      // Retain separately authored deadlines, but never unassign a helper merely
      // because the learner's Task is overdue. Older rows used the Task due date.
      const deadline = obligation.response_deadline === obligation.due_at ? null : obligation.response_deadline;
      if (obligation.due_at !== due || obligation.response_deadline !== deadline)
        d.prepare(`UPDATE planning_obligations SET due_at=?,response_deadline=?,updated_at=${NOW} WHERE id=?`).run(due,deadline,obligation.id);
    }
    for (const uid of supervisors) if (!retainedObligations.has(uid)) {
      const attempt = d.prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM planning_obligations WHERE task_id=? AND role='supervisor'").get(source.id).n;
      d.prepare(`INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,responsible_user_id,due_at,response_deadline,attempt,metadata_json)
        VALUES('task',?,?,?,'supervisor',?,?,?,?,?)`).run(source.id, source.id, `task:${source.id}:supervisor:attempt:${attempt}`, uid, due, null, attempt, JSON.stringify({ source: 'task_supervision', actor_user_id: actorId }));
      retainedObligations.add(uid);
    }
    if (supportId) {
      setProjectionAssignees(d, supportId, supervisors);
      projectionWindows.set(supportId, source);
      if (source.archived_at || !context(d, source, source).expired && !view.actions.some(action => action.expired)) {
        syncProjectionArchive(d, supportId, source.archived_at || view.actions.every(action => action.state === 'not_required'));
      }
    }
    // These are zero-point generated views, never the source action. Repair
    // structural-change/legacy drift here so a no-status edit cannot leave a
    // contradictory helper checklist until the next operational click.
    for (const update of projectionUpdatesForView(d, view)) {
      const projection = task(d, update.id);
      if (!projection || projection.status === update.status) continue;
      d.prepare(`UPDATE tasks SET status=?,expired_at=CASE WHEN ?='expired' THEN COALESCE(expired_at,?,${NOW}) ELSE NULL END WHERE id=?`)
        .run(update.status, update.status, update.expired_at ?? null, update.id);
      d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,'supervision_synchronized',?)`).run(source.id, update.id, actorId,
          JSON.stringify({ title: projection.title, from_status: projection.status, to_status: update.status }));
      syncWorkflowInstanceForTask(d, update.id, { syncParent: false });
    }
    // Synchronize only work that is actionable after status/archive repair.
    // This also handles explicit reopening in one pass without rewriting the
    // scheduling window recorded on completed, expired or archived helpers.
    for (const [id, window] of projectionWindows) {
      const title = id === supportId ? null : window.title;
      d.prepare(`UPDATE tasks SET start_date=@start,start_time=@startTime,due_date=@due,due_time=@time,
        title=COALESCE(@title,title) WHERE id=@id AND status NOT IN ('done','expired') AND archived_at IS NULL
        AND (start_date IS NOT @start OR start_time IS NOT @startTime OR due_date IS NOT @due OR due_time IS NOT @time
          OR (@title IS NOT NULL AND title IS NOT @title))`)
        .run({id,title,start:window.start_date ?? null,startTime:window.start_time ?? null,
          due:window.due_date ?? null,time:window.due_time ?? null});
    }
    view = inspectTaskSupervision(d, source.id);
    if (perAction) {
      // Only the assigned source action and its counterpart are executable
      // work. Their containers may carry independently private information.
      // The final inspection already assessed every linked action in this
      // transaction. Only module grants remain to check; repeating that full
      // assessment per checkbox would make split reconciliation quadratic.
      const grants=new Map();
      const canView = supervisor => {
        if(!grants.has(supervisor)){
          const p=actorPermissions(d,supervisor);
          grants.set(supervisor,p.capabilities['tasks.view_own']==='allow'||p.capabilities['tasks.view_household']==='allow');
        }
        return grants.get(supervisor);
      };
      for (const action of view.actions) {
        if (action.completed || action.state !== 'assigned') continue;
        const supervisor=action.supervisor_user_id;
        if (!action.action_task_id||!action.counterpart_task_id||!canView(supervisor))
          throw new TaskSupervisionError('A selected supervisor cannot access all of their linked work. Review Task visibility before assigning this helper.');
      }
    }
    if (changedScope && notify) notifySupervision(d, source, view, changedActionIds);
    return view;
  })();
}

// A caller may share this Map only while synchronously hydrating one response.
// It contains read projections, never action-time eligibility or permission
// decisions. The next request and every mutation resolve current facts again.
export function attachTaskSupervision(d, tasks, actorId = null, sourceViews = new Map()) {
  if (!supported(d)) return tasks;
  for (const row of tasks) {
    const sourceId = taskSupervisionRootId(d, row.id);
    if (!sourceViews.has(sourceId)) sourceViews.set(sourceId, inspectTaskSupervision(d, sourceId));
    const source = sourceViews.get(sourceId);
    // An empty scope has no helper to choose. Avoid a full permissions walk
    // for every ordinary Task in a list response.
    const mayAssign=actorId!=null&&source.actions.length>0&&taskSupervisionManagementAllowed(d,actorId,sourceId);
    row.supervision = actorId == null ? source : {...source, may_assign: mayAssign, actions:source.actions.map(action=>{
      const rights=source.supervisor_scope==='per_action'&&mayAssign?taskCapabilities(d,actorId,{id:action.action_task_id}):null;
      return {...action,
        ...(source.supervisor_scope==='per_action' ? {may_assign:!!(rights?.change_assignment&&rights.reassign)}:{}),
        can_complete:!action.expired && !action.skipped && !action.closed_incomplete && !action.closed_optional && ((action.execution_mode !== 'delegated' && action.completed) || action.state === 'not_required'
          || (action.state === 'assigned' && Number(action.supervisor_user_id) === Number(actorId)))};
    })};
    row.supervision_action = row.supervision.actions.find(action => action.action_task_id === row.id || action.counterpart_task_id === row.id) || null;
    row.skill_eligibility = row.supervision_action?.skill_eligibility || skillEligibilityByView.get(source)?.get(row.id) || [];
    row.is_supervision_projection = row.supervision.support_task_id === row.id || row.supervision_action?.counterpart_task_id === row.id;
    row.is_delegated_action = row.supervision_action?.execution_mode === 'delegated'
      && row.supervision_action.state !== 'not_required' && !row.is_supervision_projection;
    if (row.is_delegated_action && row.permissions && !row.supervision_action.can_complete)
      row.permissions = {...row.permissions, complete:false};
  }
  return tasks;
}

/** Delete only generated views of explicitly deleted source actions, before FK links disappear. */
export function deleteTaskSupervisionProjections(d, taskId) {
  if (!supported(d)) return [];
  const ids = d.prepare(`WITH RECURSIVE removed(id) AS (
    SELECT id FROM tasks WHERE id=? UNION ALL SELECT t.id FROM tasks t JOIN removed r ON t.parent_task_id=r.id
  ) SELECT id FROM removed`).all(taskId).map(row => row.id);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const actions = d.prepare(`SELECT * FROM task_supervision_actions WHERE action_task_id IN (${placeholders})`).all(...ids);
  const containers = d.prepare(`SELECT task_id FROM task_activity_support_tasks WHERE source_task_id IN (${placeholders})`).all(...ids);
  const projections = new Set([...actions.map(row => row.counterpart_task_id), ...containers.map(row => row.task_id)].filter(Boolean));
  for (const id of projections) if (!ids.includes(id)) d.prepare('DELETE FROM tasks WHERE id=?').run(id);
  return [...new Set(actions.map(row => row.source_task_id).filter(id => !ids.includes(id)))];
}

/** Root lifecycle applies these IDs in its one status/history/revision transaction. */
export function taskSupervisionTransition(d, taskId, status, actorId) {
  const view = inspectTaskSupervision(d, taskId);
  const knownActor = actorId != null && !!d.prepare('SELECT 1 FROM users WHERE id=?').get(actorId);
  const mayView = id => knownActor && !!id && taskCapabilities(d, actorId, { id }).view;
  const fail = (message, action = null) => {
    // Operational errors are API responses too: a visible action must never
    // disclose its separately private siblings or parent through diagnostics.
    const hiddenScope = view.actions.some(item => !item.completed && item.state !== 'not_required' && !mayView(item.action_task_id));
    const privateReason = view.supervisor_scope === 'per_action'
      ? 'This Task has other supervision requirements you cannot view. Ask the creator or a household administrator to review them.'
      : 'One qualified supervisor must cover the entire Task, including requirements you cannot view. Ask the creator or a household administrator to review supervision.';
    const actions = view.actions.filter(item => mayView(item.action_task_id)).map(item => ({
      ...item, source_task_id: mayView(view.source_task_id) ? view.source_task_id : null,
      counterpart_task_id: mayView(item.counterpart_task_id) ? item.counterpart_task_id : null,
      counterpart_revision: mayView(item.counterpart_task_id) ? item.counterpart_revision : null,
      ...(hiddenScope && !item.completed ? {reason:privateReason,display_reason:privateReason,supervisor_explanations:[]} : {}),
    }));
    const active = actions.filter(item => !item.completed && item.state !== 'not_required');
    const supervision = {
      source_task_id: mayView(view.source_task_id) ? view.source_task_id : null,
      source_revision: mayView(view.source_task_id) ? view.source_revision : null,
      support_task_id: mayView(view.support_task_id) ? view.support_task_id : null,
      state: active.some(item => item.state === 'excluded') ? 'excluded'
        : active.some(item => item.state === 'unresolved') ? 'needed' : active.length ? 'assigned' : 'none',
      reason: active.find(item => item.state !== 'assigned')?.reason || active[0]?.reason || null,
      display_reason: active.find(item => item.state !== 'assigned')?.display_reason || active[0]?.display_reason || null,
      actions,
    };
    throw new TaskSupervisionError(hiddenScope ? privateReason : action && !mayView(action.action_task_id)
      ? 'This Task has a supervision requirement that you cannot view. Ask a supervisor or household administrator for help.' : message,
    { supervision });
  };
  const requested = task(d, taskId);
  const source = task(d,view.source_task_id);
  if (requested && source && context(d, source, requested).expired) {
    throw new TaskSupervisionError('Reopen the expired original Task before changing its progress.');
  }
  const effectiveAssignee = requested && source ? context(d,source,requested).learnerId : null;
  if (status === 'done' && requested?.status !== 'done' && !effectiveAssignee && explicitSkills(d, taskId).length) {
    throw new TaskSupervisionError('Choose an assignee before completing a Task with required skills.');
  }
  const action = view.actions.find(row => row.action_task_id === Number(taskId) || row.counterpart_task_id === Number(taskId));
  if (task(d, view.source_task_id)?.archived_at || action?.archived) {
    throw new TaskSupervisionError('Restore the original Task or action from the archive before changing its progress.');
  }
  if (action?.counterpart_task_id === Number(taskId) && action.state === 'not_required') {
    fail('This supervision action is no longer required. Open the original Task to change its progress.', action);
  }
  const container = view.support_task_id === Number(taskId);
  if(container&&source?.status==='done'&&view.actions.some(row=>row.closed_optional))
    throw new TaskSupervisionError('Reopen the completed parent Task before changing optional helper work.');
  const check = container ? view.actions.filter(row => !row.completed && row.state !== 'not_required') : action ? [action] : [];
  for (const item of check) if (item.execution_mode === 'delegated' && item.state !== 'not_required'
    && Number(item.supervisor_user_id) !== Number(actorId)
    && !(status !== 'done' && taskSupervisionManagementAllowed(d, actorId, view.source_task_id))) {
    fail(`${item.supervisor_name || 'An eligible helper'} must perform “${item.action_title}” for ${item.learner_name || 'the learner'}. The learner must not perform this action, even with supervision.`, item);
  }
  if (status === 'done') for (const item of check) {
    if (item.completed) continue;
    if ((container || Number(taskId) === Number(item.counterpart_task_id)) && item.action_task_id === view.source_task_id
      && d.prepare(`SELECT 1 FROM tasks t WHERE t.parent_task_id=? AND t.status!='done' AND t.archived_at IS NULL AND t.is_optional=0
        AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)`).get(view.source_task_id)) {
      fail("Complete the original Task's subtasks before completing its overall supervision.", item);
    }
    if (item.state === 'excluded' || item.state === 'unresolved') fail(item.display_reason || item.reason, item);
    if (item.state === 'assigned' && Number(item.supervisor_user_id) !== Number(actorId)) {
      fail(item.execution_mode === 'delegated'
        ? `${item.supervisor_name || 'The assigned helper'} must perform this action for ${item.learner_name || 'the assignee'}.`
        : `${item.supervisor_name || 'The assigned supervisor'} needs to complete this supervised action with ${item.learner_name || 'the assignee'}.`, item);
    }
  }
  return { taskId: action?.action_task_id || Number(taskId), projectionTaskIds: action?.counterpart_task_id ? [action.counterpart_task_id] : [], sourceTaskId: view.source_task_id,
    containerActionTaskIds: container ? view.actions.filter(row => row.state !== 'not_required').map(row => row.action_task_id) : [] };
}

export function supervisionProjectionUpdates(d, taskId) {
  return projectionUpdatesForView(d, inspectTaskSupervision(d, taskId));
}

function projectionUpdatesForView(d, view) {
  const source=task(d,view.source_task_id);
  if(source&&context(d,source,source).closed_incomplete)return [];
  if(source&&context(d,source,source).skipped) {
    const ids=[...view.actions.map(action=>action.counterpart_task_id).filter(Boolean),view.support_task_id].filter(Boolean);
    return ids.map(id=>({id,status:task(d,id)?.status==='done'?'done':'skipped'}));
  }
  const updates = [];
  for (const action of view.actions) if (action.counterpart_task_id && (action.state !== 'not_required' || action.expired)) updates.push({ id: action.counterpart_task_id,
    status: action.expired ? 'expired' : task(d, action.action_task_id)?.status || 'open',
    ...(action.expired ? { expired_at: action.expired_at } : {}) });
  if (view.support_task_id) {
    const source = task(d, view.source_task_id), support = task(d, view.support_task_id);
    const relevant = updates.filter(update => view.actions.some(action => action.counterpart_task_id === update.id && (action.state !== 'not_required' || action.expired)));
    const sourceContext = source && context(d, source, source);
    const expired = sourceContext?.expired
      || relevant.some(update => update.status === 'expired') && relevant.every(update => ['done', 'expired'].includes(update.status));
    updates.push({ id: view.support_task_id, status: expired ? support?.status === 'done' ? 'done' : 'expired'
      : !relevant.length&&view.actions.some(action=>action.closed_optional) ? support?.status||'open'
      : relevant.every(update => update.status === 'done') ? 'done'
        : relevant.some(update => ['done', 'in_progress'].includes(update.status)) ? 'in_progress' : 'open',
      ...(expired ? { expired_at: sourceContext?.expired_at || relevant.find(update => update.expired_at)?.expired_at || null } : {}) });
  }
  return updates;
}
