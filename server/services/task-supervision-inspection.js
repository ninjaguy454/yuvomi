/** Pure operational supervision assessment shared by authorization and presentation. */
import {effectiveSkillProficiency,householdMembers,sharedEligibleInterval} from './activity-eligibility.js';
import {activityPresenceWindow,evaluateAvailability} from './presence.js';
import {todayKey} from '../utils/timezone.js';
import {taskReadRecord,taskReadStatement,taskReadTableExists} from './task-access.js';
import {createTaskOptionalContextReader} from './task-optional.js';
import {taskActivitySnapshot,activitySnapshotSkills} from './task-activity-snapshot.js';
import {configuredSubtaskSupervisorIdsForActions} from './subtask-supervisor-pool.js';
// Request-local presentation data; never serialized as an aggregate of private siblings.
const skillEligibilityByView = new WeakMap();
// Reconciliation reuses the windows evaluated in this inspection only. Keep
// them private: they are not new editable fields or cached eligibility facts.
const actionWindowsByView = new WeakMap();
const actionEligibleByView = new WeakMap();
const unassignedReasonByAction = new WeakMap();
export class TaskSupervisionError extends Error {
  constructor(message, details = {}) { super(message); this.status = 409; this.code = 'supervision_required'; this.details = details; }
}
function supported(d) { return taskReadTableExists(d,'task_supervision_actions'); }
function task(d, id) { return taskReadRecord(d,id); }
function memberName(member) { return member?.display_name || 'The assignee'; }

function describeSkillEligibility(assessed, action, learner) {
  return assessed.map(item => {
    const target = `“${action.title}” (${item.skill.name})`;
    const reason = item.proficiency === 'normal'
      ? `${memberName(learner)} can perform ${target} independently.`
      : item.proficiency === 'supervised'
        ? `${memberName(learner)} can perform ${target} with supervision.`
        : `${memberName(learner)} cannot perform ${target}, even with supervision. ${['under_age', 'adult_only'].includes(item.reason) ? 'Current age-based skill settings' : 'Current skill settings'} do not permit it.`;
    return { skill_id: item.skill.id, skill_name: item.skill.name, proficiency: item.proficiency, reason };
  });
}

/** Explain proficiency separately from who is responsible for doing the action. */
function describeSupervisionScope(scope, actions) {
  const pending = actions.filter(action => !action.completed && action.state !== 'not_required');
  scope.display_reason = scope.reason;
  for (const candidate of scope.supervisor_explanations) {
    candidate.display_reason = candidate.reason;
  }
  for (const action of pending) {
    if (!action.learner_user_id || !action.skill_eligibility.length) continue;
    const qualifications = action.skill_eligibility.map(skill => skill.reason).join(' ');
    const ownership = action.execution_mode === 'delegated'
      ? ` This action is the helper's responsibility; ${action.learner_name} must not perform it.` : '';
    if(action.is_optional){action.display_reason=`${qualifications}${ownership} ${action.reason}`;continue;}
    if (action.state === 'assigned') action.display_reason = `${qualifications}${ownership} ${scope.supervisor_scope==='per_action'?action.supervisor_name:scope.supervisor_name} will ${action.execution_mode === 'delegated' ? 'perform' : 'supervise'} this action.`;
    else if (scope.supervisor_scope==='per_action') action.display_reason = `${qualifications} ${action.reason}`;
    else if (!scope.qualified_supervisor_count) action.display_reason = `${qualifications} No single qualified supervisor can cover every remaining required skill on this Task.`;
    else if (!scope.eligible_supervisors.length) action.display_reason = `${qualifications} Qualified supervisors exist, but none can cover every required action during the Task's completion window. ${action.display_reason || ''}`;
    else action.display_reason = `${qualifications} Choose one supervisor who can cover all remaining helper actions.`;
    if (action.state !== 'assigned') action.display_reason += ownership;
  }
}

export function taskSupervisionRootId(d, taskId) {
  if (!supported(d)) return Number(taskId);
  const mapped = taskReadStatement(d,'SELECT source_task_id FROM task_supervision_actions WHERE action_task_id = ? OR counterpart_task_id = ?').get(taskId, taskId)
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
  const snapshot = binding ? taskActivitySnapshot(d, taskId) : null;
  if (snapshot) return activitySnapshotSkills(d, snapshot);
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
  const pc = chain.map(item => taskReadStatement(d,'SELECT * FROM task_planning_context WHERE task_id = ?').get(item.id)).find(Boolean) || {};
  const occurrence = { ...source, ...action };
  for (const key of ['due_date', 'due_time', 'start_date', 'start_time']) occurrence[key] = chain.find(item => item[key])?.[key] || null;
  const dateKey = occurrence.due_date || occurrence.start_date || todayKey(d);
  // Workflow/Activity bindings delimit eligibility scopes, but a terminal
  // ancestor still closes the useful completion window for every descendant.
  let expiredTask = chain.find(item => ['expired','skipped','closed_incomplete'].includes(item.status));
  let ancestor = source;
  const ancestorIds = new Set(chain.map(item => item.id));
  while (!expiredTask && ancestor?.parent_task_id && !ancestorIds.has(ancestor.parent_task_id)) {
    ancestor = task(d, ancestor.parent_task_id);
    if (!ancestor) break;
    ancestorIds.add(ancestor.id);
    if (['expired','skipped','closed_incomplete'].includes(ancestor.status)) expiredTask = ancestor;
  }
  return { occurrence, dateKey, learnerId: chain.find(item => item.assigned_to)?.assigned_to || null,
    archived: chain.some(item => item.archived_at), expired: expiredTask?.status==='expired', expired_at: expiredTask?.expired_at ?? null,
    skipped:expiredTask?.status==='skipped',skipped_at:expiredTask?.skipped_at??null,
    closed_incomplete:expiredTask?.status==='closed_incomplete',closed_incomplete_at:expiredTask?.closed_incomplete_at??null,
    presence: { policy: pc.presence_policy || 'ignore', targetPlaceId: pc.place_id || null,
    ...activityPresenceWindow(d, { task: occurrence, dateKey, windowMode: pc.presence_window || 'due' }) } };
}

function availability(d, userId, presence) {
  try { return evaluateAvailability(d, { ...presence, userId }); }
  catch { return { eligible: false, reason: 'The Task completion window is invalid.', windows: [] }; }
}

/** Checklist exclusions delegate the action; explicit whole-Task assignment requirements remain separate. */
export function assertTaskSupervisionAssignee(d, taskId, userId) {
  const source = task(d, taskId), member = householdMembers(d).find(row => Number(row.id) === Number(userId));
  if (!source || !member) throw new TaskSupervisionError('Choose a current household member.');
  // Assignment/claim/obligation acceptance still obey an Activity's explicit
  // whole-Task requirements. Descendant requirements describe its actions,
  // which can instead be delegated after resolving this actual learner.
  if (!source.parent_task_id || d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id=?').get(source.id)) {
    const {dateKey} = context(d,source,source);
    if (explicitSkills(d,source.id).some(skill => effectiveSkillProficiency(d,skill,member,dateKey).proficiency==='excluded'))
      throw new TaskSupervisionError(`${member.display_name} cannot perform one or more explicit Task requirements, even with supervision.`);
  }
  // The occurrence retains its learner. Reconciliation gives excluded
  // actions to the linked helper instead of treating the learner as capable.
  // Whole-Activity assignment/claim requirements are checked by their own
  // canonical skill policy before this resolved-assignee boundary.
}

function eligibilityReaders(d) {
  // This inspection is synchronous and read-only. Sibling actions commonly
  // share the same skills and inherited completion window. Resolve those facts
  // once here; every later inspection (including after a mutation) starts fresh.
  const proficiencies = new Map(), availabilityResults = new Map();
  const proficiencyFor = (skill, member, dateKey) => {
    const key = JSON.stringify([skill.id, member.id, dateKey]);
    if (!proficiencies.has(key)) proficiencies.set(key, effectiveSkillProficiency(d, skill, member, dateKey));
    return proficiencies.get(key);
  };
  const availabilityFor = (userId, presence) => {
    const key = JSON.stringify([userId, presence.policy, presence.targetPlaceId, presence.startAt,
      presence.endAt, presence.windowMode, presence.requiredDurationMinutes]);
    if (!availabilityResults.has(key)) availabilityResults.set(key, availability(d, userId, presence));
    return availabilityResults.get(key);
  };
  return { proficiencyFor, availabilityFor };
}

// Fresh operational assessment is shared by SQL inspection and virtual plans.
function assessTaskSupervisionAction({ row, sourceId, learnerId, learner, skills, assessed, excluded, required, prior, members, byId, dateKey, presence, proficiencyFor, availabilityFor, skillEligibility, previousSupervisorFor, counterpartRevisionFor }) {
    const executionMode = excluded.length ? 'delegated' : 'supervised';
    // A person doing the action themselves must cover ALL its explicit skills,
    // including any skills the learner happens to know independently.
    const requiredSkills = !learner || excluded.length ? skills : required;
    const qualified = learner && requiredSkills.length ? members.filter(candidate => Number(candidate.id) !== Number(learnerId)
      && requiredSkills.every(skill => proficiencyFor(skill, candidate, dateKey).proficiency === 'normal')) : [];
    // Ignored Availability cannot influence this decision. A delegated action
    // is performed by its helper, so it does not need a shared learner window.
    const learnerAvailability = learner && presence.policy !== 'ignore' && executionMode !== 'delegated'
      ? availabilityFor(learner.id, presence) : null;
    const candidateAvailability = new Map();
    const eligible = qualified.filter(candidate => {
      if (presence.policy === 'ignore') return true;
      const own = availabilityFor(candidate.id, presence);
      candidateAvailability.set(candidate.id, own);
      return own.eligible && (executionMode === 'delegated'
        || learnerAvailability?.eligible && sharedEligibleInterval([learnerAvailability, own], presence.requiredDurationMinutes));
    });
    const previousSupervisor = previousSupervisorFor();
    const assignedValid = eligible.some(candidate => Number(candidate.id) === Number(previousSupervisor));
    let state = 'not_required', reason = `${memberName(learner)} can perform this action independently.`;
    if (!learner && skills.length) { state = 'unresolved'; reason = 'Choose an assignee before supervision can be evaluated.'; }
    else if (requiredSkills.length) {
      state = assignedValid ? 'assigned' : 'unresolved';
      const names = requiredSkills.map(skill => skill.name).join(', ');
      if (assignedValid) reason = `${memberName(learner)} requires supervision for ${names}. ${byId.get(Number(previousSupervisor)).display_name} will supervise this action.`;
      else if (!qualified.length) reason = `${memberName(learner)} requires supervision for ${names}, but no qualified supervisor exists in the household.`;
      else if (!eligible.length) {
        reason = `${memberName(learner)} requires supervision for ${names}, but no qualified supervisor shares an eligible time in the Task's completion window.`;
        if (executionMode !== 'delegated' && learnerAvailability?.eligible === false && learnerAvailability.reason) reason += ` ${memberName(learner)}: ${learnerAvailability.reason}`;
        else {
          const blocked = qualified.find(candidate => candidateAvailability.get(candidate.id)?.eligible === false);
          if (blocked && candidateAvailability.get(blocked.id)?.reason) reason += ` ${blocked.display_name}: ${candidateAvailability.get(blocked.id).reason}`;
        }
      }
      else if (previousSupervisor) reason = `The assigned supervisor can no longer supervise ${memberName(learner)} for ${names}. Assign an eligible supervisor.`;
      else reason = `${memberName(learner)} requires supervision for ${names}. Assign an eligible supervisor.`;
      if (executionMode === 'delegated') {
        reason = `${memberName(learner)} must not perform ${names}, even with supervision. The helper must perform this action instead.`;
        if (!qualified.length) reason += ' No independently qualified helper exists in the household.';
        else if (!eligible.length) reason += ' No qualified helper is available during the Task’s completion window.'
          + qualified.map(candidate => ` ${candidate.display_name}: ${candidateAvailability.get(candidate.id)?.reason || 'No eligible time.'}`).join('');
      }
    }
    const action = { id: prior?.id || null, source_task_id: sourceId, action_task_id: row.id, action_title: row.title,
      counterpart_task_id: prior?.counterpart_task_id || null, learner_user_id: learnerId || null, learner_name: learner?.display_name || null,
      supervisor_user_id: previousSupervisor, supervisor_name: byId.get(Number(previousSupervisor))?.display_name || null,
      required_skills: requiredSkills.map(skill => ({ id: skill.id, name: skill.name })), execution_mode: executionMode, state, reason,
      skill_eligibility: skillEligibility, display_reason: `${row.title}: ${reason}`,
      revision: prior?.revision || 0, task_revision: row.revision, counterpart_revision: counterpartRevisionFor(),
      eligible_supervisors: eligible.map(({ id, display_name }) => ({ id, display_name })),
      supervisor_explanations: qualified.map(({id,display_name})=>{
        const canSupervise=eligible.some(candidate=>candidate.id===id), own=candidateAvailability.get(id);
        const explanation=presence.policy==='ignore'?'This Task does not restrict Availability or Presence.'
          : executionMode!=='delegated'&&learnerAvailability?.eligible===false?`${memberName(learner)}: ${learnerAvailability.reason}`
            : own?.eligible===false?own.reason
              : !canSupervise?'No shared eligible time with the learner.':own?.reason;
        return {user_id:id,name:display_name,eligible:canSupervise,reason:explanation};
      }),
      qualified_supervisor_count: qualified.length, completed: false, status: row.status };
    action.qualified_supervisor_ids = qualified.map(candidate => candidate.id);
    unassignedReasonByAction.set(action,state==='assigned'&&executionMode==='supervised'
      ? `${memberName(learner)} requires supervision for ${requiredSkills.map(skill=>skill.name).join(', ')}. Assign an eligible supervisor.`
      : reason);
    return action;
}

/** Pure read: profile and Availability changes expose stale supervision without rewriting assignments. */
export function inspectTaskSupervision(d, taskId) {
  const sourceId = taskSupervisionRootId(d, taskId), source = task(d, sourceId);
  const empty = { source_task_id: sourceId, state: 'none', reason: null, support_task_id: null, actions: [],
    supervisor_user_id: null, supervisor_name: null, eligible_supervisors: [], qualified_supervisor_count: 0,
    supervisor_explanations: [], blocked_requirements: [] };
  if (!supported(d) || !source) return empty;
  const saved = d.prepare('SELECT * FROM task_supervision_actions WHERE source_task_id = ?').all(sourceId);
  // Ordinary leaf Tasks without any skill source or saved helper cannot have
  // an action. Skip roster, presence and recursive scope work on list reads.
  if(!saved.length
    &&!d.prepare('SELECT 1 FROM tasks WHERE parent_task_id=? LIMIT 1').get(sourceId)
    &&!d.prepare('SELECT 1 FROM task_skill_requirements WHERE task_id=? LIMIT 1').get(sourceId)
    &&!d.prepare('SELECT 1 FROM task_activity_bindings WHERE task_id=? LIMIT 1').get(sourceId)
    &&!d.prepare('SELECT 1 FROM task_activity_support_tasks WHERE source_task_id=? LIMIT 1').get(sourceId))
    return {...empty,display_reason:null,source_revision:source.revision};
  const members = householdMembers(d), byId = new Map(members.map(m => [Number(m.id), m]));
  const rows = ordinaryTaskScope(d, sourceId);
  const optionalContextFor = createTaskOptionalContextReader(d, rows);
  const support = d.prepare('SELECT task_id,supervisor_scope FROM task_activity_support_tasks WHERE source_task_id = ?').get(sourceId);
  const actions = [], skillEligibility = new Map(), actionWindows = new Map();
  const { proficiencyFor, availabilityFor } = eligibilityReaders(d);
  for (const row of rows) {
    const prior = saved.find(item => Number(item.action_task_id) === Number(row.id))
      || taskReadStatement(d,'SELECT * FROM task_supervision_actions WHERE action_task_id=?').get(row.id);
    const { occurrence, dateKey, presence, learnerId, archived, expired, expired_at,skipped,skipped_at,closed_incomplete,closed_incomplete_at } = context(d, source, row);
    actionWindows.set(row.id, { start_date: occurrence.start_date, start_time: occurrence.start_time,
      due_date: occurrence.due_date, due_time: occurrence.due_time });
    const optional=optionalContextFor(row.id);
    if ((expired||skipped||closed_incomplete||optional.closed_parent) && row.status !== 'done') {
      if (prior) actions.push({ ...prior, action_title: row.title, state: 'not_required',
        reason: closed_incomplete?'The activity was closed without completing its remaining subtasks.':skipped?'The occurrence was skipped.':expired?'The original Task or action expired incomplete.':'The parent Task is complete; reopen it before performing this optional action.',
        expired, expired_at, skipped,skipped_at,closed_incomplete,closed_incomplete_at,closed_optional:Boolean(optional.closed_parent), archived,
        learner_name: byId.get(Number(prior.learner_user_id))?.display_name || null,
        supervisor_name: byId.get(Number(prior.supervisor_user_id))?.display_name || null,
        required_skills: JSON.parse(prior.required_skill_ids_json || '[]').map(id => d.prepare('SELECT id,name FROM skills WHERE id=?').get(id)).filter(Boolean),
        eligible_supervisors: [], completed: false, status: row.status, task_revision: row.revision,
        counterpart_revision: prior.counterpart_task_id ? task(d, prior.counterpart_task_id)?.revision : null });
      continue;
    }
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
    const assessed = learner ? skills.map(skill => ({ skill, ...proficiencyFor(skill, learner, dateKey) })) : [];
    if (row.status !== 'done' && learner) skillEligibility.set(row.id, describeSkillEligibility(assessed, row, learner));
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
    actions.push(assessTaskSupervisionAction({ row, sourceId, learnerId, learner, skills, assessed, excluded, required, prior, members, byId, dateKey, presence,
      proficiencyFor, availabilityFor, skillEligibility: skillEligibility.get(row.id) || [],
      previousSupervisorFor: () => prior ? prior.supervisor_user_id : d.prepare(`SELECT user_id FROM task_responsibilities
        WHERE task_id = ? AND role = 'supervisor' AND status = 'active' ORDER BY user_id LIMIT 1`).get(sourceId)?.user_id ?? null,
      counterpartRevisionFor: () => prior?.counterpart_task_id ? task(d, prior.counterpart_task_id)?.revision : null }));
  }
  for(const action of actions)action.is_optional=optionalContextFor(action.action_task_id).is_optional;
  const activeSupervisorIds = d.prepare("SELECT user_id FROM task_responsibilities WHERE task_id=? AND role='supervisor' AND status='active'")
    .all(sourceId).map(row => row.user_id);
  const activeActionIds=actions.filter(action=>!action.completed&&action.state!=='not_required')
    .map(action=>action.action_task_id);
  const hasAuthoredPool=activeActionIds.length&&d.prepare(`SELECT 1 FROM task_subtask_assignment_rules
    WHERE task_id IN (${activeActionIds.map(()=>'?').join(',')}) LIMIT 1`).get(...activeActionIds);
  const configuredPools=(support?.supervisor_scope==='per_action'||hasAuthoredPool)
    ?configuredSubtaskSupervisorIdsForActions(d,source,activeActionIds,members):null;
  if(configuredPools)for(const action of actions){
    if(action.completed||action.state==='not_required')continue;
    const allowed=new Set(configuredPools.get(action.action_task_id)||[]);
    action.eligible_supervisors=(action.eligible_supervisors||[]).filter(person=>allowed.has(person.id));
    action.supervisor_explanations=(action.supervisor_explanations||[]).filter(person=>allowed.has(person.user_id));
    action.qualified_supervisor_ids=(action.qualified_supervisor_ids||[]).filter(id=>allowed.has(id));
    action.qualified_supervisor_count=action.qualified_supervisor_ids.length;
    if(action.state==='unresolved'&&!action.eligible_supervisors.length)
      action.reason='No qualified and available helper is in this action’s configured supervisor Person or Group.';
    if(action.state==='assigned'&&!allowed.has(action.supervisor_user_id)){
      action.state='unresolved';action.supervisor_user_id=null;action.supervisor_name=null;
      action.reason='The configured supervisor Person or Group no longer includes this helper.';
    }
  }
  const localEligible=new Map(actions.map(action=>[action.action_task_id,[...(action.eligible_supervisors||[])]]));
  const scope = support?.supervisor_scope==='per_action'
    ? perActionSupervisorScope(actions,members):singleSupervisorScope(actions, members, activeSupervisorIds);
  describeSupervisionScope(scope, actions);
  const view = { source_task_id: sourceId, source_revision: source.revision, support_task_id: support?.task_id || null,
    ...scope, actions };
  skillEligibilityByView.set(view, skillEligibility);
  actionWindowsByView.set(view, actionWindows);
  actionEligibleByView.set(view,localEligible);
  return view;
}

/** Existing linked child assignments are authoritative in this opt-in scope. */
function perActionSupervisorScope(actions,members){
  const pending=actions.filter(action=>!action.completed&&action.state!=='not_required');
  const blocked=pending.filter(action=>action.state!=='assigned');
  const supervisors=[...new Set(pending.filter(action=>action.state==='assigned')
    .map(action=>action.supervisor_user_id).filter(Boolean))].sort((a,b)=>a-b);
  return {supervisor_scope:'per_action',state:pending.length?(blocked.length?'needed':'assigned'):'none',
    reason:blocked[0]?.reason||'Each supervision action has its own qualified helper.',
    supervisor_user_id:supervisors.length===1?supervisors[0]:null,
    supervisor_user_ids:supervisors,
    supervisor_name:supervisors.length===1?members.find(member=>member.id===supervisors[0])?.display_name||null:null,
    eligible_supervisors:[],qualified_supervisor_count:0,supervisor_explanations:[],
    blocked_requirements:blocked.map(action=>({action_task_id:action.action_task_id,
      action_title:action.action_title,required_skills:action.required_skills,
      qualified_supervisor_ids:action.qualified_supervisor_ids||[],
      eligible_supervisor_ids:action.eligible_supervisors.map(member=>member.id)}))};
}

/** One candidate must cover every remaining action; completed mappings are historical snapshots. */
function singleSupervisorScope(actions, members, activeSupervisorIds = []) {
  const allPending = actions.filter(action => !action.completed && action.state !== 'not_required');
  const requiredPending=allPending.filter(action=>!action.is_optional);
  // An optional skill gap must never invalidate the helper for required work.
  const pending=requiredPending.length?requiredPending:allPending;
  if (!pending.length) return { state: 'none', reason: null, supervisor_user_id: null, supervisor_name: null,
    eligible_supervisors: [], qualified_supervisor_count: 0, supervisor_explanations: [], blocked_requirements: [] };
  const impossible = pending.some(action => !action.learner_user_id);
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
  if (impossible) reason = pending.find(action => !action.learner_user_id).reason;
  else if (!qualified.length) reason = `No single qualified supervisor exists in the household for all remaining requirements: ${required.join(', ')}.`;
  else if (!eligible.length) reason = (pending.some(action => action.execution_mode === 'delegated')
    ? `No single qualified supervisor is available for all remaining helper work (${required.join(', ')}). Supervised actions also require an eligible time with the learner.`
    : `No single qualified supervisor shares an eligible time with the learner for every remaining required action (${required.join(', ')}).`)
    + (qualified.length === 1 ? ` ${explanations.find(item => item.user_id === qualified[0].id)?.reason || ''}` : '');
  else if (selected) reason = pending.some(action => action.execution_mode === 'delegated')
    ? `${selected.display_name} will cover all remaining helper work (${required.join(', ')}), performing delegated actions and helping the learner with supervised actions.`
    : `${selected.display_name} will supervise all remaining required actions (${required.join(', ')}).`;
  else if (priorIds.length) reason = 'The previous supervision assignment can no longer cover the entire Task. One eligible supervisor must cover every remaining required action.';
  else reason = `Assign one eligible supervisor for all remaining requirements: ${required.join(', ')}.`;
  const state = selected ? 'assigned' : 'needed';
  const blockedRequirements = pending.filter(action => !selected).map(action => ({ action_task_id: action.action_task_id,
    action_title: action.action_title, required_skills: action.required_skills,
    qualified_supervisor_ids: action.qualified_supervisor_ids || [], eligible_supervisor_ids: action.eligible_supervisors.map(member => member.id) }));
  for (const action of pending) {
    action.previous_supervisor_user_id = action.supervisor_user_id || null;
    action.supervisor_user_id = selected?.id || null;
    action.supervisor_name = selected?.display_name || null;
    action.state = selected ? 'assigned' : 'unresolved';
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

export {skillEligibilityByView,actionWindowsByView,actionEligibleByView,unassignedReasonByAction,
  supported,task,context,ordinaryTaskScope,explicitSkills,eligibilityReaders,assessTaskSupervisionAction,singleSupervisorScope};