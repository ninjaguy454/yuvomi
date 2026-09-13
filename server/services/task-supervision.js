/** Linked supervision uses the source action's Task status as its only completion authority. */
import { effectiveSkillProficiency, householdMembers, sharedEligibleInterval } from './activity-eligibility.js';
import { activityPresenceWindow, evaluateAvailability, availabilityInstantMs } from './presence.js';
import { todayKey, householdTimeZone } from '../utils/timezone.js';
import { enqueueNotification } from './notification-inbox.js';
import { syncWorkflowInstanceForTask } from './activity-workflows.js';
import { taskCapabilities, taskSupervisionManagementAllowed } from './task-access.js';
import { createHash } from 'node:crypto';

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
export class TaskSupervisionError extends Error {
  constructor(message, details = {}) { super(message); this.status = 409; this.code = 'supervision_required'; this.details = details; }
}
function supported(d) { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_supervision_actions'").get(); }
function task(d, id) { return d.prepare('SELECT * FROM tasks WHERE id = ?').get(id); }
function memberName(member) { return member?.display_name || 'The assignee'; }

export function taskSupervisionRootId(d, taskId) {
  if (!supported(d)) return Number(taskId);
  const mapped = d.prepare('SELECT source_task_id FROM task_supervision_actions WHERE action_task_id = ? OR counterpart_task_id = ?').get(taskId, taskId)
    || d.prepare('SELECT source_task_id FROM task_activity_support_tasks WHERE task_id = ?').get(taskId);
  let own = task(d, mapped?.source_task_id || taskId);
  if (!own) return Number(taskId);
  const seen = new Set();
  while (own.parent_task_id && !seen.has(own.id)) {
    seen.add(own.id);
    // Each Activity occurrence in a Workflow keeps its own supervisor. Plain
    // checklist nesting does not introduce a second supervision boundary.
    if (d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id = ?').get(own.id)) break;
    const parent = task(d, own.parent_task_id);
    if (!parent || seen.has(parent.id)) break;
    own = parent;
  }
  return own.id;
}

function ordinaryTaskScope(d, sourceId) {
  return d.prepare(`WITH RECURSIVE scope(id) AS (
    SELECT id FROM tasks WHERE id=? UNION
    SELECT t.id FROM tasks t JOIN scope p ON t.parent_task_id=p.id
    WHERE NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM task_activity_bindings b WHERE b.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)
  ) SELECT t.* FROM tasks t JOIN scope s ON s.id=t.id ORDER BY t.id`).all(sourceId);
}

function explicitSkills(d, taskId) {
  const binding = d.prepare('SELECT activity_template_id FROM task_activity_bindings WHERE task_id = ?').get(taskId);
  return binding ? d.prepare(`SELECT s.* FROM activity_template_skills r JOIN skills s ON s.id = r.skill_id
    WHERE r.activity_template_id = ? ORDER BY r.sort_order,s.id`).all(binding.activity_template_id)
    : d.prepare(`SELECT s.* FROM task_skill_requirements r JOIN skills s ON s.id = r.skill_id
      WHERE r.task_id = ? ORDER BY r.sort_order,s.id`).all(taskId);
}

function context(d, source, action) {
  const chain = [action], seen = new Set([action.id]);
  let row = action;
  while (row.id !== source.id && row.parent_task_id && !seen.has(row.parent_task_id)) {
    row = row.parent_task_id === source.id ? source : task(d, row.parent_task_id);
    if (!row) break;
    chain.push(row); seen.add(row.id);
  }
  const pc = chain.map(item => d.prepare('SELECT * FROM task_planning_context WHERE task_id = ?').get(item.id)).find(Boolean) || {};
  const occurrence = { ...source, ...action };
  for (const key of ['due_date', 'due_time', 'start_date']) occurrence[key] = chain.find(item => item[key])?.[key] || null;
  const dateKey = occurrence.due_date || occurrence.start_date || todayKey(d);
  return { dateKey, learnerId: chain.find(item => item.assigned_to)?.assigned_to || null,
    archived: chain.some(item => item.archived_at), presence: { policy: pc.presence_policy || 'ignore', targetPlaceId: pc.place_id || null,
    ...activityPresenceWindow(d, { task: occurrence, dateKey, windowMode: pc.presence_window || 'due' }) } };
}

function availability(d, userId, presence) {
  try { return evaluateAvailability(d, { ...presence, userId }); }
  catch { return { eligible: false, reason: 'The Task completion window is invalid.', windows: [] }; }
}

/** Explicit exclusions remain a hard assignment boundary; supervised is valid with a visible gate. */
export function assertTaskSupervisionAssignee(d, taskId, userId) {
  const source = task(d, taskId), member = householdMembers(d).find(row => Number(row.id) === Number(userId));
  if (!source || !member) throw new TaskSupervisionError('Choose a current household member.');
  const actions = ordinaryTaskScope(d, source.id);
  for (const action of actions) {
    const { dateKey, learnerId, archived } = context(d, {...source,assigned_to:userId},
      action.id === source.id ? {...action,assigned_to:userId} : action);
    if (archived) continue;
    if (action.id !== source.id && learnerId && Number(learnerId) !== Number(userId)) continue;
    const excluded = explicitSkills(d, action.id).filter(skill => effectiveSkillProficiency(d, skill, member, dateKey).proficiency === 'excluded');
    if (excluded.length) throw new TaskSupervisionError(`${member.display_name} cannot perform one or more explicit Task or subtask requirements, even with supervision.`);
  }
}

/** Pure read: profile and Availability changes expose stale supervision without rewriting assignments. */
export function inspectTaskSupervision(d, taskId) {
  const sourceId = taskSupervisionRootId(d, taskId), source = task(d, sourceId);
  const empty = { source_task_id: sourceId, state: 'none', reason: null, support_task_id: null, actions: [],
    supervisor_user_id: null, supervisor_name: null, eligible_supervisors: [], qualified_supervisor_count: 0,
    supervisor_explanations: [], blocked_requirements: [] };
  if (!supported(d) || !source) return empty;
  const members = householdMembers(d), byId = new Map(members.map(m => [Number(m.id), m]));
  const saved = d.prepare('SELECT * FROM task_supervision_actions WHERE source_task_id = ?').all(sourceId);
  const rows = ordinaryTaskScope(d, sourceId);
  const support = d.prepare('SELECT task_id FROM task_activity_support_tasks WHERE source_task_id = ?').get(sourceId);
  const actions = [];
  for (const row of rows) {
    const prior = saved.find(item => Number(item.action_task_id) === Number(row.id))
      || d.prepare('SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(row.id);
    const { dateKey, presence, learnerId, archived } = context(d, source, row);
    // Archived work is not an operational obligation. Preserve its linkage so
    // restoring the original action restores the same helper projection.
    if (archived) {
      if (prior) actions.push({ ...prior, action_title: row.title, state: 'not_required',
        reason: 'The original Task or action is archived.', archived: true,
        learner_name: byId.get(Number(prior.learner_user_id))?.display_name || null,
        supervisor_name: byId.get(Number(prior.supervisor_user_id))?.display_name || null,
        required_skills: JSON.parse(prior.required_skill_ids_json || '[]').map(id => d.prepare('SELECT id,name FROM skills WHERE id=?').get(id)).filter(Boolean),
        eligible_supervisors: [], completed: row.status === 'done', status: row.status, task_revision: row.revision,
        counterpart_revision: prior.counterpart_task_id ? task(d, prior.counterpart_task_id)?.revision : null });
      continue;
    }
    // Historical completion without a linked record is not evidence that a
    // newly selected helper supervised it. Never manufacture that history.
    if (row.status === 'done' && !prior) continue;
    const learner = byId.get(Number(learnerId));
    // Assignment must resolve before there is a learner to supervise. Existing
    // mappings remain visible if a prior learner was removed, but new unassigned
    // work uses the ordinary assignment-needed state and creates no helper work.
    if (!learner && !prior) continue;
    const skills = explicitSkills(d, row.id);
    const assessed = learner ? skills.map(skill => ({ skill, ...effectiveSkillProficiency(d, skill, learner, dateKey) })) : [];
    const excluded = assessed.filter(item => item.proficiency === 'excluded');
    const required = assessed.filter(item => item.proficiency === 'supervised').map(item => item.skill);
    if (!prior && !excluded.length && !required.length && !(skills.length && !learner)) continue;
    // Completed actions retain their historical learner/supervisor snapshot. A profile edit must not rewrite it.
    if (row.status === 'done' && prior) {
      const ids = JSON.parse(prior.required_skill_ids_json || '[]');
      actions.push({ ...prior, action_title: row.title, learner_name: byId.get(Number(prior.learner_user_id))?.display_name || 'Former household member',
        supervisor_name: byId.get(Number(prior.supervisor_user_id))?.display_name || null,
        required_skills: ids.map(id => d.prepare('SELECT id,name FROM skills WHERE id = ?').get(id)).filter(Boolean),
        eligible_supervisors: [], completed: true, status: row.status, task_revision: row.revision,
        counterpart_revision: prior.counterpart_task_id ? task(d, prior.counterpart_task_id)?.revision : null });
      continue;
    }
    const requiredSkills = !learner ? skills : excluded.length ? excluded.map(item => item.skill) : required;
    const qualified = learner && required.length ? members.filter(candidate => Number(candidate.id) !== Number(learnerId)
      && required.every(skill => effectiveSkillProficiency(d, skill, candidate, dateKey).proficiency === 'normal')) : [];
    const learnerAvailability = learner ? availability(d, learner.id, presence) : null;
    const candidateAvailability = new Map();
    const eligible = qualified.filter(candidate => {
      if (presence.policy === 'ignore') return true;
      const own = availability(d, candidate.id, presence);
      candidateAvailability.set(candidate.id, own);
      return learnerAvailability?.eligible && own.eligible && sharedEligibleInterval([learnerAvailability, own], presence.requiredDurationMinutes);
    });
    const previousSupervisor = prior ? prior.supervisor_user_id : d.prepare(`SELECT user_id FROM task_responsibilities
      WHERE task_id = ? AND role = 'supervisor' AND status = 'active' ORDER BY user_id LIMIT 1`).get(sourceId)?.user_id ?? null;
    const assignedValid = eligible.some(candidate => Number(candidate.id) === Number(previousSupervisor));
    let state = 'not_required', reason = `${memberName(learner)} can perform this action independently.`;
    if (!learner && skills.length) { state = 'unresolved'; reason = 'Choose an assignee before supervision can be evaluated.'; }
    else if (excluded.length) { state = 'excluded'; reason = `${memberName(learner)} cannot currently perform ${excluded.map(item => item.skill.name).join(', ')}, even with supervision.`; }
    else if (required.length) {
      state = assignedValid ? 'assigned' : 'unresolved';
      const names = required.map(skill => skill.name).join(', ');
      if (assignedValid) reason = `${memberName(learner)} requires supervision for ${names}. ${byId.get(Number(previousSupervisor)).display_name} will supervise this action.`;
      else if (!qualified.length) reason = `${memberName(learner)} requires supervision for ${names}, but no qualified supervisor exists in the household.`;
      else if (!eligible.length) {
        reason = `${memberName(learner)} requires supervision for ${names}, but no qualified supervisor shares an eligible time in the Task's completion window.`;
        if (learnerAvailability?.eligible === false && learnerAvailability.reason) reason += ` ${memberName(learner)}: ${learnerAvailability.reason}`;
        else {
          const blocked = qualified.find(candidate => candidateAvailability.get(candidate.id)?.eligible === false);
          if (blocked && candidateAvailability.get(blocked.id)?.reason) reason += ` ${blocked.display_name}: ${candidateAvailability.get(blocked.id).reason}`;
        }
      }
      else if (previousSupervisor) reason = `The assigned supervisor can no longer supervise ${memberName(learner)} for ${names}. Assign an eligible supervisor.`;
      else reason = `${memberName(learner)} requires supervision for ${names}. Assign an eligible supervisor.`;
    }
    actions.push({ id: prior?.id || null, source_task_id: sourceId, action_task_id: row.id, action_title: row.title,
      counterpart_task_id: prior?.counterpart_task_id || null, learner_user_id: learnerId || null, learner_name: learner?.display_name || null,
      supervisor_user_id: previousSupervisor, supervisor_name: byId.get(Number(previousSupervisor))?.display_name || null,
      required_skills: requiredSkills.map(skill => ({ id: skill.id, name: skill.name })), state, reason,
      revision: prior?.revision || 0, task_revision: row.revision, counterpart_revision: prior?.counterpart_task_id ? task(d, prior.counterpart_task_id)?.revision : null,
      eligible_supervisors: eligible.map(({ id, display_name }) => ({ id, display_name })),
      supervisor_explanations: qualified.map(({id,display_name})=>{
        const canSupervise=eligible.some(candidate=>candidate.id===id), own=candidateAvailability.get(id);
        const explanation=presence.policy==='ignore'?'This Task does not restrict Availability or Presence.'
          : learnerAvailability?.eligible===false?`${memberName(learner)}: ${learnerAvailability.reason}`
            : own?.eligible===false?own.reason
              : !canSupervise?'No shared eligible time with the learner.':own?.reason;
        return {user_id:id,name:display_name,eligible:canSupervise,reason:explanation};
      }),
      qualified_supervisor_count: qualified.length, completed: false, status: row.status });
    actions[actions.length - 1].qualified_supervisor_ids = qualified.map(candidate => candidate.id);
  }
  const activeSupervisorIds = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'")
    .all(sourceId).map(row => row.user_id);
  const scope = singleSupervisorScope(actions, members, activeSupervisorIds);
  return { source_task_id: sourceId, source_revision: source.revision, support_task_id: support?.task_id || null,
    ...scope, actions };
}

/** One candidate must cover every remaining action; completed mappings are historical snapshots. */
function singleSupervisorScope(actions, members, activeSupervisorIds = []) {
  const pending = actions.filter(action => !action.completed && action.state !== 'not_required');
  if (!pending.length) return { state: 'none', reason: null, supervisor_user_id: null, supervisor_name: null,
    eligible_supervisors: [], qualified_supervisor_count: 0, supervisor_explanations: [], blocked_requirements: [] };
  const impossible = pending.some(action => action.state === 'excluded' || !action.learner_user_id);
  const qualified = impossible ? [] : members.filter(member => pending.every(action => action.qualified_supervisor_ids?.includes(member.id)));
  const eligible = qualified.filter(member => pending.every(action => action.eligible_supervisors.some(candidate => candidate.id === member.id)));
  const priorIds = [...new Set(pending.map(action => action.supervisor_user_id).filter(Boolean).map(Number))];
  const preferredIds = activeSupervisorIds.length ? activeSupervisorIds : priorIds;
  const selected = preferredIds.length === 1 && priorIds.length <= 1
    && (!priorIds.length || priorIds[0] === preferredIds[0])
    ? eligible.find(member => member.id === preferredIds[0]) : null;
  const required = [...new Set(pending.flatMap(action => action.required_skills.map(skill => skill.name)))];
  const candidates = members.filter(member => !pending.some(action => Number(action.learner_user_id) === Number(member.id)));
  const explanations = candidates.map(member => {
    const gaps = pending.filter(action => !action.qualified_supervisor_ids?.includes(member.id));
    const blocked = pending.filter(action => !action.eligible_supervisors.some(candidate => candidate.id === member.id));
    const details = gaps.length ? gaps.map(action => `${action.action_title} (${action.required_skills.map(skill => skill.name).join(', ')})`)
      : blocked.map(action => `${action.action_title}: ${action.supervisor_explanations.find(item => item.user_id === member.id)?.reason || action.reason}`);
    return { user_id: member.id, name: member.display_name, eligible: !gaps.length && !blocked.length,
      reason: gaps.length ? `Not independently qualified for ${details.join('; ')}.`
        : blocked.length ? details.join('; ') : 'Can supervise every remaining required action.',
      blocked_action_ids: (gaps.length ? gaps : blocked).map(action => action.action_task_id) };
  });
  let reason;
  if (impossible) reason = pending.find(action => action.state === 'excluded' || !action.learner_user_id).reason;
  else if (!qualified.length) reason = `No single qualified supervisor exists in the household for all remaining requirements: ${required.join(', ')}.`;
  else if (!eligible.length) reason = `No single qualified supervisor shares an eligible time with the learner for every remaining required action (${required.join(', ')}).`
    + (qualified.length === 1 ? ` ${explanations.find(item => item.user_id === qualified[0].id)?.reason || ''}` : '');
  else if (selected) reason = `${selected.display_name} will supervise all remaining required actions (${required.join(', ')}).`;
  else if (priorIds.length) reason = 'The previous supervision assignment can no longer cover the entire Task. One eligible supervisor must cover every remaining required action.';
  else reason = `Assign one eligible supervisor for all remaining requirements: ${required.join(', ')}.`;
  const state = impossible && pending.some(action => action.state === 'excluded') ? 'excluded' : selected ? 'assigned' : 'needed';
  const blockedRequirements = pending.filter(action => !selected).map(action => ({ action_task_id: action.action_task_id,
    action_title: action.action_title, required_skills: action.required_skills,
    qualified_supervisor_ids: action.qualified_supervisor_ids || [], eligible_supervisor_ids: action.eligible_supervisors.map(member => member.id) }));
  for (const action of pending) {
    action.previous_supervisor_user_id = action.supervisor_user_id || null;
    action.supervisor_user_id = selected?.id || null;
    action.supervisor_name = selected?.display_name || null;
    if (action.state !== 'excluded') action.state = selected ? 'assigned' : 'unresolved';
    action.reason = reason;
    action.eligible_supervisors = eligible.map(({ id, display_name }) => ({ id, display_name }));
    action.qualified_supervisor_count = qualified.length;
    action.supervisor_explanations = explanations;
    delete action.qualified_supervisor_ids;
  }
  return { state, reason, supervisor_user_id: selected?.id || null, supervisor_name: selected?.display_name || null,
    eligible_supervisors: eligible.map(({ id, display_name }) => ({ id, display_name })),
    qualified_supervisor_count: qualified.length, supervisor_explanations: explanations, blocked_requirements: blockedRequirements };
}

function insertProjection(d, source, title, parentId, assignedTo) {
  const id = Number(d.prepare(`INSERT INTO tasks(title,description,category,priority,status,start_date,due_date,due_time,
    assigned_to,created_by,parent_task_id,points,visibility) VALUES(?,NULL,?,'none','open',?,?,?,?,?,?,0,?)`)
    .run(title, source.category || 'misc', source.start_date, source.due_date, source.due_time,
      assignedTo || null, source.created_by, parentId, source.visibility || 'all').lastInsertRowid);
  d.prepare(`INSERT INTO task_planning_context(task_id,place_id,presence_policy,presence_window,source)
    SELECT ?,place_id,presence_policy,presence_window,source FROM task_planning_context WHERE task_id = ?`).run(id, source.id);
  return id;
}

function setProjectionAssignees(d, id, userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(Number))];
  const current = d.prepare('SELECT user_id FROM task_assignments WHERE task_id=? ORDER BY user_id').all(id).map(row => Number(row.user_id));
  if ((task(d, id)?.assigned_to || null) === (ids[0] || null)
    && current.length === ids.length && current.every(uid => ids.includes(uid))) return;
  d.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(ids[0] || null, id);
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(id);
  for (const uid of ids) d.prepare('INSERT INTO task_assignments(task_id,user_id) VALUES(?,?)').run(id, uid);
}

function syncProjectionArchive(d, id, archived) {
  if (Boolean(task(d, id)?.archived_at) === Boolean(archived)) return;
  d.prepare(`UPDATE tasks SET archived_at=${archived ? NOW : 'NULL'} WHERE id=?`).run(id);
}

export function taskSupervisionNotificationKey(view) {
  const pending = view.actions.filter(action => !action.completed && action.state !== 'not_required');
  const signature = [view.state, view.supervisor_user_id, pending.map(action => [action.id, action.revision, action.supervisor_user_id, action.state])];
  return `task-supervision-scope:${view.source_task_id}:${createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 24)}`;
}

function notifySupervision(d, source, view) {
  if (source.status === 'done' || view.state === 'none') return;
  const unresolved = ['needed', 'excluded'].includes(view.state);
  const recipients = unresolved ? [source.created_by, ...d.prepare("SELECT id FROM users WHERE role='admin'").all().map(row => row.id)]
    : view.state === 'assigned' ? [view.supervisor_user_id] : [];
  const pending = view.actions.filter(action => !action.completed && action.state !== 'not_required');
  for (const userId of new Set(recipients.filter(Boolean).map(Number))) enqueueNotification(d, {
    userId, sourceKey: taskSupervisionNotificationKey(view), category: 'automation',
    entityType: 'task', entityId: source.id, title: unresolved ? 'Supervision needed' : 'Supervision requested',
    body: pending.every(action => taskCapabilities(d, userId, { id: action.action_task_id }).view)
      ? `${source.title}: ${pending.map(action => action.action_title).join('; ')}. ${view.reason}`
      : 'This Task needs supervision. Review the parts you can access or contact the responsible member.',
  });
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
export function reconcileTaskSupervision(d, taskId, { actorId = null, supervisorUserId = undefined, actionTaskId = null, supervisorAssignments = null, notify = true } = {}) {
  if (!supported(d)) return inspectTaskSupervision(d, taskId);
  return d.transaction(() => {
    consolidateNestedSupervision(d,taskSupervisionRootId(d,taskId),actorId);
    let view = inspectTaskSupervision(d, taskId);
    const source = task(d, view.source_task_id);
    if (!source) return view;
    // Retained action-scoped API inputs now choose for the entire source Task.
    if (actionTaskId != null && !view.actions.some(action => Number(action.action_task_id) === Number(actionTaskId)))
      throw new TaskSupervisionError('Choose a supervised action belonging to this Task.');
    let requestedSupervisor = supervisorUserId;
    if (supervisorAssignments) {
      const choices = Object.values(supervisorAssignments).map(value => value == null ? null : Number(value));
      if (Object.keys(supervisorAssignments).some(id => !view.actions.some(action => action.action_task_id === Number(id)))
        || new Set(choices).size > 1 || (requestedSupervisor !== undefined && choices.some(value => value !== requestedSupervisor)))
        throw new TaskSupervisionError('A Task can have only one supervisor. Choose one person for all remaining requirements.');
      if (choices.length) requestedSupervisor = choices[0];
    }
    const previous = d.prepare('SELECT * FROM task_supervision_actions WHERE source_task_id = ?').all(source.id);
    if (requestedSupervisor != null && !view.eligible_supervisors.some(member => member.id === Number(requestedSupervisor)))
      throw new TaskSupervisionError('Choose one supervisor who is independently qualified and shares an eligible time for every remaining required action.');
    const attempted = new Set(d.prepare(`SELECT responsible_user_id FROM planning_obligations WHERE task_id=? AND role='supervisor'
      AND status IN ('declined','timed_out')`).all(source.id).map(row => row.responsible_user_id));
    const currentIds = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'")
      .all(source.id).map(row => row.user_id);
    const currentEligible = currentIds.length === 1 && !attempted.has(currentIds[0])
      ? view.eligible_supervisors.find(member => member.id === currentIds[0]) : null;
    const selectedId = requestedSupervisor !== undefined ? requestedSupervisor
      : view.supervisor_user_id || currentEligible?.id || view.eligible_supervisors.find(member => !attempted.has(member.id))?.id || null;
    const selected = view.eligible_supervisors.find(member => member.id === Number(selectedId));
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
      action.supervisor_user_id = selected && action.state !== 'not_required' ? selected.id : null;
      if (selected && action.state !== 'excluded' && action.state !== 'not_required') {
        action.state = 'assigned'; action.supervisor_name = selected.display_name;
        // Persist action-local facts. Completing another action must not create
        // a fresh assignment event/request just because the scope got shorter.
        action.reason = `${selected.display_name} will supervise this action (${action.required_skills.map(skill => skill.name).join(', ')}).`;
      } else if (action.state === 'assigned') { action.state = 'unresolved'; action.reason = 'Supervision is needed. Assign one eligible supervisor for the entire Task.'; }
      let counterpartId = old?.counterpart_task_id || null;
      if (!counterpartId && supportId && action.state !== 'not_required') counterpartId = insertProjection(d, source, `Supervise: ${action.action_title}`, supportId, action.supervisor_user_id);
      const snapshot = [action.learner_user_id, action.supervisor_user_id, JSON.stringify(action.required_skills.map(skill => skill.id)), action.state, action.reason];
      const changed = !old || [old.learner_user_id, old.supervisor_user_id, old.required_skill_ids_json, old.state, old.reason].some((value, index) => value !== snapshot[index]);
      if (!old) {
        action.id = Number(d.prepare(`INSERT INTO task_supervision_actions(source_task_id,action_task_id,counterpart_task_id,
          learner_user_id,supervisor_user_id,required_skill_ids_json,state,reason) VALUES(?,?,?,?,?,?,?,?)`)
          .run(source.id, action.action_task_id, counterpartId, ...snapshot).lastInsertRowid);
        action.revision = 1;
      } else if (changed || counterpartId !== old.counterpart_task_id) {
        d.prepare(`UPDATE task_supervision_actions SET counterpart_task_id=?,learner_user_id=?,supervisor_user_id=?,
          required_skill_ids_json=?,state=?,reason=?,revision=revision+1,updated_at=${NOW} WHERE id=?`)
          .run(counterpartId, ...snapshot, old.id);
        action.revision = old.revision + 1;
      }
      if (counterpartId) {
        setProjectionAssignees(d, counterpartId, action.state === 'assigned' ? [action.supervisor_user_id] : []);
        d.prepare('UPDATE tasks SET title=?,start_date=?,due_date=?,due_time=? WHERE id=?')
          .run(`Supervise: ${action.action_title}`, source.start_date, source.due_date, source.due_time, counterpartId);
        syncProjectionArchive(d, counterpartId, action.state === 'not_required');
      }
      // An event is visible through its own action. Keep its explanation local
      // so a shared Task-level candidate failure cannot reveal a private sibling.
      const actionSkills = action.required_skills.map(skill => skill.name).join(', ');
      const activityReason = action.state === 'assigned'
        ? `${action.supervisor_name} will supervise this action (${actionSkills}).`
        : action.state === 'not_required' ? 'This action no longer requires active supervision.'
          : action.state === 'excluded' ? `The assignee cannot currently perform this action's requirements (${actionSkills}), even with supervision.`
            : `One eligible supervisor is needed for the entire Task. This action requires ${actionSkills}.`;
      if (changed) d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,?,?)`).run(source.id, action.action_task_id, actorId,
          action.state === 'assigned' ? 'supervisor_assigned' : action.state === 'not_required' ? 'supervision_not_required' : 'supervision_needed',
          JSON.stringify({ title: action.action_title, learner_user_id: action.learner_user_id, supervisor_user_id: action.supervisor_user_id,
            previous_supervisor_user_id: old?.supervisor_user_id || null,
            required_skills: action.required_skills.map(skill => skill.name), reason: activityReason }));
      changedScope ||= changed;
    }
    const supervisors = selected && view.actions.some(action => !action.completed && action.state === 'assigned') ? [selected.id] : [];
    // This service owns supervisor role only, preserving learner and beneficiary obligations.
    const activeSupervisors = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'").all(source.id).map(row => row.user_id);
    for (const uid of activeSupervisors.filter(id => !supervisors.includes(id))) d.prepare(`UPDATE task_responsibilities SET status='superseded',updated_at=${NOW}
      WHERE task_id=? AND user_id=? AND role='supervisor' AND status='active'`).run(source.id, uid);
    for (const uid of supervisors.filter(id => !activeSupervisors.includes(id))) d.prepare(`INSERT INTO task_responsibilities(task_id,user_id,role,source)
      VALUES(?,?,'supervisor','task_supervision') ON CONFLICT(task_id,user_id,role)
      DO UPDATE SET status='active',source='task_supervision',updated_at=${NOW}`).run(source.id, uid);
    view = inspectTaskSupervision(d, source.id);
    const obligations = d.prepare(`SELECT * FROM planning_obligations WHERE task_id=? AND role='supervisor' AND status IN ('pending','accepted')
      ORDER BY CASE status WHEN 'accepted' THEN 0 ELSE 1 END,id DESC`).all(source.id);
    const dueInstant = source.due_date ? availabilityInstantMs(`${source.due_date}T${source.due_time || '23:59'}:00`, householdTimeZone(d)) : null;
    const due = dueInstant == null ? null : new Date(dueInstant).toISOString().replace('.000Z','Z');
    let retainedObligation = null;
    for (const obligation of obligations) if (!supervisors.includes(obligation.responsible_user_id) || retainedObligation) {
      d.prepare(`UPDATE planning_obligations SET status='superseded',updated_at=${NOW} WHERE id=?`).run(obligation.id);
    } else {
      retainedObligation = obligation;
      // Linked supervision is executable work, not a second approval deadline.
      // Retain separately authored deadlines, but never unassign a helper merely
      // because the learner's Task is overdue. Older rows used the Task due date.
      const deadline = obligation.response_deadline === obligation.due_at ? null : obligation.response_deadline;
      if (obligation.due_at !== due || obligation.response_deadline !== deadline)
        d.prepare(`UPDATE planning_obligations SET due_at=?,response_deadline=?,updated_at=${NOW} WHERE id=?`).run(due,deadline,obligation.id);
    }
    for (const uid of supervisors) if (!retainedObligation) {
      const attempt = d.prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM planning_obligations WHERE task_id=? AND role='supervisor'").get(source.id).n;
      d.prepare(`INSERT INTO planning_obligations(entity_type,entity_id,task_id,logical_key,role,responsible_user_id,due_at,response_deadline,attempt,metadata_json)
        VALUES('task',?,?,?,'supervisor',?,?,?,?,?)`).run(source.id, source.id, `task:${source.id}:supervisor:attempt:${attempt}`, uid, due, null, attempt, JSON.stringify({ source: 'task_supervision', actor_user_id: actorId }));
    }
    if (supportId) {
      setProjectionAssignees(d, supportId, supervisors);
      d.prepare('UPDATE tasks SET start_date=?,due_date=?,due_time=? WHERE id=?')
        .run(source.start_date, source.due_date, source.due_time, supportId);
      syncProjectionArchive(d, supportId, source.archived_at || view.actions.every(action => action.state === 'not_required'));
    }
    // These are zero-point generated views, never the source action. Repair
    // structural-change/legacy drift here so a no-status edit cannot leave a
    // contradictory helper checklist until the next operational click.
    for (const update of supervisionProjectionUpdates(d, source.id)) {
      const projection = task(d, update.id);
      if (!projection || projection.status === update.status) continue;
      d.prepare('UPDATE tasks SET status=? WHERE id=?').run(update.status, update.id);
      d.prepare(`INSERT INTO task_activity_events(task_id,action_task_id,actor_user_id,event_type,details_json)
        VALUES(?,?,?,'supervision_synchronized',?)`).run(source.id, update.id, actorId,
          JSON.stringify({ title: projection.title, from_status: projection.status, to_status: update.status }));
      syncWorkflowInstanceForTask(d, update.id, { syncParent: false });
    }
    view = inspectTaskSupervision(d, source.id);
    if (changedScope && notify) notifySupervision(d, source, view);
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
    row.supervision = actorId == null ? source : {...source, may_assign: taskSupervisionManagementAllowed(d, actorId, sourceId), actions:source.actions.map(action=>({...action,
      can_complete:action.completed || action.state === 'not_required'
        || (action.state === 'assigned' && Number(action.supervisor_user_id) === Number(actorId))}))};
    row.supervision_action = row.supervision.actions.find(action => action.action_task_id === row.id || action.counterpart_task_id === row.id) || null;
    row.is_supervision_projection = row.supervision.support_task_id === row.id || row.supervision_action?.counterpart_task_id === row.id;
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
    const privateReason = 'One qualified supervisor must cover the entire Task, including requirements you cannot view. Ask the creator or a household administrator to review supervision.';
    const actions = view.actions.filter(item => mayView(item.action_task_id)).map(item => ({
      ...item, source_task_id: mayView(view.source_task_id) ? view.source_task_id : null,
      counterpart_task_id: mayView(item.counterpart_task_id) ? item.counterpart_task_id : null,
      counterpart_revision: mayView(item.counterpart_task_id) ? item.counterpart_revision : null,
      ...(hiddenScope && !item.completed ? {reason:privateReason,supervisor_explanations:[]} : {}),
    }));
    const active = actions.filter(item => !item.completed && item.state !== 'not_required');
    const supervision = {
      source_task_id: mayView(view.source_task_id) ? view.source_task_id : null,
      source_revision: mayView(view.source_task_id) ? view.source_revision : null,
      support_task_id: mayView(view.support_task_id) ? view.support_task_id : null,
      state: active.some(item => item.state === 'excluded') ? 'excluded'
        : active.some(item => item.state === 'unresolved') ? 'needed' : active.length ? 'assigned' : 'none',
      reason: active.find(item => item.state !== 'assigned')?.reason || active[0]?.reason || null,
      actions,
    };
    throw new TaskSupervisionError(hiddenScope ? privateReason : action && !mayView(action.action_task_id)
      ? 'This Task has a supervision requirement that you cannot view. Ask a supervisor or household administrator for help.' : message,
    { supervision });
  };
  const requested = task(d, taskId);
  const source = task(d,view.source_task_id);
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
  const check = container ? view.actions.filter(row => !row.completed && row.state !== 'not_required') : action ? [action] : [];
  if (status === 'done') for (const item of check) {
    if (item.completed) continue;
    if ((container || Number(taskId) === Number(item.counterpart_task_id)) && item.action_task_id === view.source_task_id
      && d.prepare(`SELECT 1 FROM tasks t WHERE t.parent_task_id=? AND t.status!='done' AND t.archived_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM task_activity_support_tasks s WHERE s.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM task_supervision_actions a WHERE a.counterpart_task_id=t.id)`).get(view.source_task_id)) {
      fail("Complete the original Task's subtasks before completing its overall supervision.", item);
    }
    if (item.state === 'excluded' || item.state === 'unresolved') fail(item.reason, item);
    if (item.state === 'assigned' && Number(item.supervisor_user_id) !== Number(actorId)) {
      fail(`${item.supervisor_name || 'The assigned supervisor'} needs to complete this supervised action with ${item.learner_name || 'the assignee'}.`, item);
    }
  }
  return { taskId: action?.action_task_id || Number(taskId), projectionTaskIds: action?.counterpart_task_id ? [action.counterpart_task_id] : [], sourceTaskId: view.source_task_id,
    containerActionTaskIds: container ? view.actions.filter(row => row.state !== 'not_required').map(row => row.action_task_id) : [] };
}

export function supervisionProjectionUpdates(d, taskId) {
  const view = inspectTaskSupervision(d, taskId), updates = [];
  for (const action of view.actions) if (action.counterpart_task_id && action.state !== 'not_required') updates.push({ id: action.counterpart_task_id,
    status: task(d, action.action_task_id)?.status || 'open' });
  if (view.support_task_id) {
    const relevant = updates.filter(update => view.actions.some(action => action.counterpart_task_id === update.id && action.state !== 'not_required'));
    updates.push({ id: view.support_task_id, status: relevant.every(update => update.status === 'done') ? 'done'
      : relevant.some(update => update.status !== 'open') ? 'in_progress' : 'open' });
  }
  return updates;
}
