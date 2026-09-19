import { reconcileTaskSupervision, assertTaskSupervisionAssignee } from './task-supervision.js';
/**
 * Reusable activity/workflow engine.
 *
 * Workflow templates compose activity templates. Instantiation creates one
 * parent task and concrete, individually assigned subtasks. The template graph
 * and generated-task graph are stored separately so the UI can explain why a
 * task exists and which earlier work it depends on.
 */

import { todayKey } from '../utils/timezone.js';
import { createHash } from 'node:crypto';
import { assertCapability } from '../permissions.js';
import { configureRotationTrack, findRotationTrack, previewRotation, resolveRotation } from './rotation.js';
import { readRotationOccurrence } from './rotation-access.js';
import { taskCapabilities } from './task-access.js';
import { bindTaskRotations, taskRotationContexts, parseRotationBindings, settleTaskRotations } from './task-rotation.js';
import { initializeTaskRotationRendering } from './task-rotation-rendering.js';
import { addCalendarDays, resolveActivitySchedule } from './activity-schedule.js';
import { placeWithInheritedAddress, activityPresenceWindow } from './presence.js';
import {
  householdMembers,
  loadSkillRequirements,
  resolveActivityAssignment,
  renderActivityTitle,
} from './activity-eligibility.js';
import { recordTaskAssignment } from './assignment-responsibilities.js';
import { loadActivityChecklist, materializeActivityChecklist, renderActivityChecklistTitle } from './activity-template-checklist.js';
import { setTags } from '../utils/task-tags.js';
import { previewTaskActivityBinding } from './task-activity-bindings.js';
import { taskOptionalContext } from './task-optional.js';
import {
  hydrateWorkflowDefinitions, resolveVariables, substituteVariableTemplate, householdVariableRows, renderRotationVariableTemplates,
  templateReferences, expressionScope, expressionDependencies, definitionsForTemplates, variableInputSchema,
} from './variable-resolution.js';

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function workflowInputSchema(d, workflowTemplateId, rawSchema) {
  const row = d.prepare('SELECT * FROM workflow_templates WHERE id=?').get(workflowTemplateId);
  return hydrateWorkflowDefinitions(d, workflowTemplateId, parseJson(rawSchema, []), undefined, rotationBindingVariables(parseRotationBindings(row?.rotation_bindings_json))).filter(row => !row.rotation_context);
}

export function getActivityTemplate(d, id) {
  const row = d.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
  if (!row) return null;
  row.skills = loadSkillRequirements(d, row.id);
  row.checklist = loadActivityChecklist(d, row.id);
  row.tags = parseJson(row.tags_json, []);
  row.rotation_bindings = parseRotationBindings(row.rotation_bindings_json);
  return row;
}

export function listActivityTemplates(d, { activeOnly = false } = {}) {
  const rows = d.prepare(`
    SELECT * FROM activity_templates
    ${activeOnly ? 'WHERE active = 1' : ''}
    ORDER BY name COLLATE NOCASE, id
  `).all();
  return rows.map((row) => ({
    ...row,
    skills: loadSkillRequirements(d, row.id),
    checklist: loadActivityChecklist(d, row.id),
    tags: parseJson(row.tags_json, []),
    rotation_bindings: parseRotationBindings(row.rotation_bindings_json),
  }));
}

export function getWorkflowTemplate(d, id) {
  const workflow = d.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id);
  if (!workflow) return null;
  workflow.rotation_bindings = parseRotationBindings(workflow.rotation_bindings_json);
  workflow.input_schema = workflowInputSchema(d, workflow.id, workflow.input_schema_json);
  delete workflow.input_schema_json;

  const steps = d.prepare(`
    SELECT wts.*, at.name AS activity_name
      FROM workflow_template_steps wts
      JOIN activity_templates at ON at.id = wts.activity_template_id
     WHERE wts.workflow_template_id = ?
     ORDER BY wts.sort_order ASC, wts.id ASC
  `).all(id);
  const dependencies = d.prepare(`
    SELECT d.step_id, dep.step_key AS depends_on_step_key
      FROM workflow_step_dependencies d
      JOIN workflow_template_steps dep ON dep.id = d.depends_on_step_id
     WHERE d.step_id IN (
       SELECT id FROM workflow_template_steps WHERE workflow_template_id = ?
     )
     ORDER BY d.step_id, dep.sort_order, dep.id
  `).all(id);
  const byStep = new Map();
  for (const dep of dependencies) {
    if (!byStep.has(dep.step_id)) byStep.set(dep.step_id, []);
    byStep.get(dep.step_id).push(dep.depends_on_step_key);
  }

  workflow.steps = steps.map((step) => ({
    ...step,
    condition: parseJson(step.condition_json, null),
    depends_on: byStep.get(step.id) ?? [],
  }));
  return workflow;
}

export function listWorkflowTemplates(d, { quickAddOnly = false, activeOnly = false } = {}) {
  let where = [];
  if (quickAddOnly) where.push('quick_add_enabled = 1');
  if (activeOnly) where.push('active = 1');
  const sql = `SELECT * FROM workflow_templates${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY name COLLATE NOCASE, id`;
  return d.prepare(sql).all().map((row) => ({
    ...row,
    rotation_bindings: parseRotationBindings(row.rotation_bindings_json),
    input_schema: workflowInputSchema(d, row.id, row.input_schema_json),
    input_schema_json: undefined,
  }));
}

function workflowVariableId(question) {
  return question?.id ?? question?.key ?? null;
}

export function rotationBindingVariables(bindings = []) {
  return bindings.map(binding => ({ id: binding.purpose_key, label: binding.label || binding.purpose_key,
    type: 'rotation_occurrence', kind: 'value', default_value: null, rotation_context: true }));
}

export function assertRotationVariableAccess(d, actor, definitions = []) {
  if (definitions.some(row => row.type === 'rotation_group')) assertCapability(d, actor, 'rotations.view');
  if (definitions.some(row => row.type === 'rotation_occurrence' && !row.rotation_context)) assertCapability(d, actor, 'rotations.history');
}

/** A Workflow also exposes the Rotation purposes owned by its Activity steps. */
export function assertWorkflowRotationAccess(d, actor, workflow) {
  assertRotationVariableAccess(d, actor, workflow.input_schema);
  let hasRotations = !!workflow.rotation_bindings.length;
  const catalog = [...householdVariableRows(d), ...workflow.input_schema, ...rotationBindingVariables(workflow.rotation_bindings)];
  for (const step of workflow.steps) {
    const activity = getActivityTemplate(d, step.activity_template_id);
    if (!activity) continue;
    hasRotations ||= !!activity.rotation_bindings.length;
    assertRotationVariableAccess(d, actor, activityVariableSchema(d, activity, catalog).definitions);
  }
  if (hasRotations) assertCapability(d, actor, 'rotations.view');
  return hasRotations;
}

function workflowResultRotationCapabilities(d, result) {
  // The source template may have changed since this request was saved. Its
  // generated Tasks retain the authoritative ownership and copied purposes.
  const rows = d.prepare(`SELECT t.rotation_bindings_json,
      EXISTS(SELECT 1 FROM task_rotation_occurrences r WHERE r.task_id=t.id) AS has_rotation_history
    FROM tasks t WHERE t.id=? OR t.id IN (SELECT task_id FROM workflow_instance_tasks WHERE workflow_instance_id=?)`)
    .all(result.parent_task_id, result.id);
  const purposes = new Set(rows.flatMap(row => parseRotationBindings(row.rotation_bindings_json).map(binding => binding.purpose_key)));
  const capabilities = new Set();
  if (result.rotations?.length || purposes.size || rows.some(row => row.has_rotation_history)) capabilities.add('rotations.view');
  for (const row of result.resolved_variables || []) {
    if (row.type === 'rotation_group') capabilities.add('rotations.view');
    if (row.type === 'rotation_occurrence' && !purposes.has(row.key)) capabilities.add('rotations.history');
  }
  return [...capabilities];
}

function assertWorkflowResultVisibility(d,actor,result) {
  const ids=new Set([result.parent_task_id,...(result.tasks||[]).map(task=>task.task_id)].filter(Boolean));
  for(const id of ids) {
    const task=d.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if(!task||!taskCapabilities(d,actor,task).view)throw Object.assign(new Error('Workflow occurrence not found.'),{status:404});
  }
  // Cached display text can derive from another private consumer. Recheck its
  // current visibility as well as the generated Tasks before replaying a result.
  const occurrences=new Set((result.rotations||[]).map(value=>value.occurrence?.id).filter(Boolean));
  for(const value of result.resolved_variables||[])if(value.type==='rotation_occurrence'&&value.value)occurrences.add(Number(value.value));
  for(const id of occurrences)readRotationOccurrence(d,actor,id);
}

/** Generic HTTP retries must pass the same current capability boundary as the
 * durable Workflow retry before returning a previously saved response. */
export function assertWorkflowCachedAccess(d, actor, workflowId, requestKey, result) {
  for (const capability of ['workflows.view', 'workflows.run', 'tasks.create']) assertCapability(d, actor, capability);
  const workflow = getWorkflowTemplate(d, workflowId);
  if (workflow && assertWorkflowRotationAccess(d, actor, workflow)) assertCapability(d, actor, 'rotations.configure');
  const needed = new Set(workflowResultRotationCapabilities(d, result));
  if (requestKey) {
    const saved = d.prepare('SELECT response_json FROM rotation_workflow_requests WHERE workflow_template_id=? AND actor_user_id=? AND request_key=?')
      .get(workflowId, typeof actor === 'object' ? actor.authUserId || actor.id || actor.session?.userId : actor, requestKey);
    for (const capability of JSON.parse(saved?.response_json || '{}').rotation_capabilities || []) needed.add(capability);
  }
  for (const capability of needed) assertCapability(d, actor, capability);
  assertWorkflowResultVisibility(d,actor,result);
}

function resolveWorkflowVariables(d, workflow, inputs, subjectUserId, rotationOccurrences = {}, actor = null) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Workflow inputs must be an object.');
  const definitions = [...(workflow.input_schema ?? []), ...rotationBindingVariables(workflow.rotation_bindings)];
  const known = new Set(definitions.map(workflowVariableId));
  for (const key of Object.keys(inputs ?? {})) if (!known.has(key)) throw new Error(`Unknown workflow input: ${key}.`);
  const scope = expressionScope(definitions);
  const keys = new Set(definitions.filter(row => row.expression || row.default_value != null || Object.hasOwn(inputs, workflowVariableId(row))).map(workflowVariableId));
  const templates = [workflow.name, workflow.description];
  for (const step of workflow.steps) {
    const activity = getActivityTemplate(d, step.activity_template_id);
    const ownPurposes = new Set((activity?.rotation_bindings || []).map(binding => binding.purpose_key).filter(key => !definitions.some(row => workflowVariableId(row) === key)));
    // Activity-local purposes are rendered in that step's canonical context.
    // They are not Workflow-global values and cannot select another step's owner.
    const stepTemplates = [step.title_override ?? activity?.title_template, step.description_override ?? activity?.description,
      activity?.supervision_title_template, ...(activity?.checklist ?? []).map(item => item.title_template)];
    for (const template of stepTemplates) for (const reference of templateReferences(template)) {
      if (!ownPurposes.has(reference.split('.')[0])) templates.push(`{{${reference}}}`);
    }
    for (const key of [step.subject_variable_id, step.assignment_variable_id, step.assignment_policy_variable_id,
      step.location_mode === 'workflow' ? step.location_variable_id : activity?.location_mode === 'workflow' ? activity.location_variable_id : null]) {
      if (key) keys.add(key);
    }
  }
  for (const reference of templateReferences(templates)) for (const key of expressionDependencies(reference, scope)) keys.add(key);
  return resolveVariables(d, definitions, inputs, { keys: [...keys], subjectUserId, rotationOccurrences, actor });
}

export function activityVariableSchema(d, activity, catalog) {
  const result = definitionsForTemplates(d, [activity.title_template, activity.description, activity.supervision_title_template,
    ...(activity.checklist ?? []).map(item => item.title_template)], [...(catalog || householdVariableRows(d)), ...rotationBindingVariables(activity.rotation_bindings)]);
  return { ...result, input_schema: variableInputSchema(expressionScope(result.definitions), result.keys) };
}

/** Returns an ordinary editable Task draft; does not create Tasks or advance rotation. */
export function resolveActivityTemplate(d, activityId, { inputs = {}, subjectUserId = null, includeLabels = false,
  assignmentOverrideUserId = null, task = null, actorId = null } = {}) {
  const activity = getActivityTemplate(d, activityId);
  if (!activity?.active) throw new Error('Activity template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (subjectUserId != null && !subject) throw new Error('Choose a household member.');
  if (activity.subject_required && !subject) throw Object.assign(new Error('Choose a household member first.'), { code: 'missing_input' });
  const schema = activityVariableSchema(d, activity);
  if (actorId != null) {
    assertRotationVariableAccess(d, actorId, schema.definitions);
    if (activity.rotation_bindings.length) assertCapability(d, actorId, 'rotations.view');
  }
  const contextValues={};
  // The existing reusable Assignee value denotes this Activity occurrence's
  // resolved performer only when it has no authored expression or fixed value.
  // Do not reinterpret arbitrary member variables or overwrite configured data.
  const contextualAssignee=schema.definitions.find(row=>row.id==='assignee' && row.type==='household_member'
    && row.kind==='value' && !row.expression && row.default_value==null);
  if(contextualAssignee) {
    const occurrence=resolveActivitySchedule(activity,task);
    const resolvedAssignment=previewTaskActivityBinding(d,{activityTemplateId:activity.id,subjectUserId,
      assignmentOverrideUserId,task:occurrence,dateKey:occurrence.due_date||todayKey(d)}).resolution;
    if(resolvedAssignment.primary)contextValues.assignee=resolvedAssignment.primary.id;
  }
  const rotationOccurrences = Object.fromEntries((activity.rotation_bindings || []).map(binding => [binding.purpose_key,
    { ...previewRotation(d, binding, { context: task || {} }), id: 0, track_id: 0, status: 'preview' }]));
  const resolved = resolveVariables(d, schema.definitions, inputs, { keys: schema.keys, subjectUserId, contextValues, rotationOccurrences, actor:actorId });
  return {
    data: { title: stepTitle(activity, subject, null, resolved.labels), description: stepDescription(activity, subject, null, resolved.labels),
      expiration_policy: activity.expiration_policy ?? 'keep_overdue',
      due_date_offset_days: activity.due_date_offset_days ?? null,
      start_time: activity.start_time ?? null, due_time: activity.due_time ?? null,
      recurrence_rule: activity.recurrence_rule ?? null, recurrence_from_completion: activity.recurrence_from_completion || 0,
      is_recurring: activity.recurrence_rule ? 1 : 0,
      rotation_bindings: activity.rotation_bindings,
      checklist: activity.checklist.map(item => ({ ...item, title_template: renderActivityChecklistTitle(item, activity, subject, resolved.labels) })),
      inputs: resolved.persisted, resolved_variables: resolved.summary },
    input_schema: schema.input_schema,
    ...(includeLabels ? { variable_labels: resolved.labels } : {}),
  };
}

function conditionMatches(condition, inputs) {
  if (!condition) return true;
  const variableId = condition.variable_id ?? condition.input;
  if (!variableId) throw new Error('Invalid workflow condition.');
  if (Object.hasOwn(condition, 'equals')) return inputs?.[variableId] === condition.equals;
  if (Array.isArray(condition.in)) return condition.in.includes(inputs?.[variableId]);
  throw new Error('Invalid workflow condition.');
}

/**
 * Resolve dependencies through conditional steps that were skipped.
 * If C depends on optional B, and B is skipped but B depended on A,
 * C still waits for A instead of becoming accidentally unblocked.
 */
function activeDependencyKeys(workflow, activeStepKeys, step) {
  const byKey = new Map(workflow.steps.map((candidate) => [candidate.step_key, candidate]));
  const resolved = [];
  const visited = new Set();

  const visit = (key) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    if (activeStepKeys.has(key)) {
      resolved.push(key);
      return;
    }
    const skipped = byKey.get(key);
    for (const predecessor of skipped?.depends_on ?? []) visit(predecessor);
  };

  for (const predecessor of step.depends_on ?? []) visit(predecessor);
  return [...new Set(resolved)];
}

function userById(d, id) {
  if (id == null) return null;
  return householdMembers(d).find((member) => Number(member.id) === Number(id)) ?? null;
}

function stepTitle(activity, subject, override = null, variableLabels = {}) {
  const title = override
    ? String(override)
      .replaceAll('{subject}', subject?.display_name || '')
      .replaceAll('{activity}', activity.name || 'Activity')
      .trim()
    : renderActivityTitle(activity, subject);
  return substituteVariableTemplate(title, variableLabels)?.trim();
}

function stepDescription(activity, subject, override = null, variableLabels = {}) {
  const description = String(override ?? activity.description ?? '')
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity.name || 'Activity');
  return substituteVariableTemplate(description, variableLabels);
}

function supervisorTitle(activity, subject, variableLabels = {}) {
  const template = activity.supervision_title_template || 'Supervise {subject}: {activity}';
  return substituteVariableTemplate(String(template)
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity.name || 'activity')
    .trim(), variableLabels);
}

function stepSubject(d, step, defaultSubject, inputs) {
  if (!step.subject_variable_id) return defaultSubject;
  return userById(d, inputs[step.subject_variable_id]);
}

function stepPlanningContext(d, activity, step, inputs) {
  const mode = step.location_mode && step.location_mode !== 'inherit'
    ? step.location_mode
    : (activity.location_mode || 'none');
  let placeId = null;
  let variableId = null;
  if (mode === 'fixed') placeId = step.location_mode === 'fixed' ? step.place_id : activity.place_id;
  if (mode === 'workflow') {
    variableId = step.location_mode === 'workflow' ? step.location_variable_id : activity.location_variable_id;
    placeId = Number(inputs?.[variableId]) || null;
  }
  const place = placeId ? d.prepare('SELECT * FROM places WHERE id = ?').get(placeId) ?? null : null;
  return {
    location_mode: mode,
    location_variable_id: variableId,
    place_id: place?.id ?? null,
    place: placeWithInheritedAddress(d, place),
    presence_policy: step.presence_policy_override || activity.presence_policy || 'ignore',
    presence_window: activity.presence_window || 'due',
  };
}

function stepAssignment(activity, step, inputs) {
  const allowed = new Set(['subject_skill', 'eligible_round_robin', 'eligible_random', 'open_claimable', 'rotating_multi', 'fixed']);
  const runtimePolicy = step.assignment_policy_variable_id
    ? String(inputs?.[step.assignment_policy_variable_id] || '')
    : '';
  const policy = allowed.has(runtimePolicy)
    ? runtimePolicy
    : (step.assignment_policy_override || activity.assignment_policy || activity.assignment_strategy);
  const fixedUserId = step.assignment_variable_id
    ? Number(inputs?.[step.assignment_variable_id]) || null
    : (step.assignment_user_id || null);
  return { policy, fixedUserId };
}

function workflowActivitySchedule(activity, startDate) {
  if (!addCalendarDays(startDate, 0)) throw new Error('Choose a valid workflow Start Date.');
  // Untimed legacy definitions keep their existing workflow date behavior.
  // Configured relative schedules get a concrete occurrence Start Date even
  // when the reusable Start Time itself is intentionally blank.
  const legacy = activity.due_date_offset_days == null
    ? { start_date: activity.start_time ? startDate : null, due_date: startDate } : {};
  return resolveActivitySchedule(activity, legacy, { fallbackStartDate: startDate });
}

/** Pure preview. It intentionally does not advance any rotation cursor. */
export function previewWorkflow(d, workflowId, {
  subjectUserId = null,
  inputs = {},
  startDate = todayKey(d),
  actorId = null,
} = {}) {
  const workflow = getWorkflowTemplate(d, workflowId);
  if (!workflow || !workflow.active) throw new Error('Workflow template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (workflow.subject_required && !subject) throw new Error('Choose a household member first.');
  const rotations = Object.fromEntries(workflow.rotation_bindings.map(binding => {
    const track = findRotationTrack(d, { consumer_type: 'workflow', consumer_id: String(workflow.id), purpose_key: binding.purpose_key });
    const preview = previewRotation(d, { ...binding, ...(track ? { id: track.id, next_membership_id: track.next_membership_id } : {}) }, { context: { dateKey: startDate } });
    return [binding.purpose_key, { ...preview, id: 0, track_id: track?.id || 0, strategy: binding.strategy, status: 'preview' }];
  }));
  const resolvedVariables = resolveWorkflowVariables(d, workflow, inputs, subjectUserId, rotations, actorId);
  const runtimeInputs = resolvedVariables.ids;
  const variableLabels = resolvedVariables.labels;
  const activeSteps = workflow.steps.filter((step) => conditionMatches(step.condition, runtimeInputs));
  if (!activeSteps.length) throw new Error('No activities apply to these answers.');
  const activeStepKeys = new Set(activeSteps.map((step) => step.step_key));

  // Simulate the same sequence of rotation writes that Create will perform,
  // then roll them all back. This matters when one workflow uses the same
  // round-robin Activity Template more than once: a read-only resolution
  // would show the same person for every step even though Create advances
  // the cursor between those steps.
  const output = [];
  const rollbackPreview = new Error('ROLLBACK_WORKFLOW_PREVIEW');
  try {
    d.transaction(() => {
      for (const step of activeSteps) {
        const activity = getActivityTemplate(d, step.activity_template_id);
        if (!activity || !activity.active) throw new Error(`Activity template unavailable: ${step.activity_name}`);
        const activitySubject = stepSubject(d, step, subject, runtimeInputs);
        const planning = stepPlanningContext(d, activity, step, runtimeInputs);
        const assignment = stepAssignment(activity, step, runtimeInputs);
        const schedule = workflowActivitySchedule(activity, startDate);
        const resolution = resolveActivityAssignment(d, activity, {
          subjectUserId: activitySubject?.id ?? null,
          dateKey: schedule.due_date || startDate,
          commitRotation: true,
          assignmentPolicyOverride: assignment.policy,
          fixedUserIdOverride: assignment.fixedUserId,
          presence: {
            policy: planning.presence_policy,
            targetPlaceId: planning.place_id,
            ...activityPresenceWindow(d, { dateKey: schedule.due_date || startDate, windowMode: planning.presence_window,
              task: schedule }),
          },
        });
        const stepVariables = workflow.rotation_bindings.length ? resolveWorkflowVariables(d, workflow, inputs, activitySubject?.id || resolution.primary?.id || subjectUserId, rotations, actorId) : resolvedVariables;
        const ownBindings = activity.rotation_bindings || [];
        const previewContexts = [...Object.entries(rotations).map(([purpose_key, occurrence]) => ({purpose_key,occurrence})),
          ...ownBindings.map(binding => {
            const track = findRotationTrack(d,{consumer_type:'workflow_step',consumer_id:`${workflow.id}:${step.step_key}`,purpose_key:binding.purpose_key});
            return {purpose_key:binding.purpose_key,occurrence:{...previewRotation(d,{...binding,...(track?{id:track.id,next_membership_id:track.next_membership_id}:{})},{context:schedule}),id:0,track_id:track?.id||0,status:'preview'}};
          })];
        const bindings = [...new Map([...workflow.rotation_bindings,...ownBindings].map(binding=>[binding.purpose_key,binding])).values()];
        const rotationText = bindings.length ? renderRotationVariableTemplates(d,{templates:[step.title_override ?? activity.title_template,step.description_override ?? activity.description],bindings,
          rotations:previewContexts,inputs:runtimeInputs,subjectUserId:activitySubject?.id || resolution.primary?.id || subjectUserId,definitions:workflow.input_schema}) : null;
        output.push({
          step_key: step.step_key,
          activity_template_id: activity.id,
          activity_name: activity.name,
          title: stepTitle(activity, activitySubject, rotationText?.values[0] ?? step.title_override, stepVariables.labels),
          description: stepDescription(activity, activitySubject, rotationText?.values[1] ?? step.description_override, stepVariables.labels),
          subject: activitySubject,
          assigned_to: resolution.primary,
          supervisor: resolution.supervisor,
          supervision_needed: Boolean(resolution.supervisionNeeded),
          supervision_reason: resolution.supervisionReason || null,
          supervisor_title: resolution.supervisor ? supervisorTitle(activity, activitySubject, variableLabels) : null,
          subject_proficiency: resolution.subjectProficiency?.proficiency ?? null,
          assignment_policy: assignment.policy,
          depends_on: activeDependencyKeys(workflow, activeStepKeys, step),
          category: activity.category,
          expiration_policy: activity.expiration_policy ?? 'keep_overdue',
          ...schedule,
          ...planning,
        });
      }
      throw rollbackPreview;
    })();
  } catch (err) {
    if (err !== rollbackPreview) throw err;
  }

  return {
    workflow: {
      id: workflow.id,
      name: substituteVariableTemplate(workflow.name, variableLabels),
      description: substituteVariableTemplate(workflow.description, variableLabels),
      subject_required: workflow.subject_required,
    },
    subject,
    inputs: resolvedVariables.persisted,
    resolved_variables: resolvedVariables.summary,
    rotations,
    steps: output,
  };
}

function insertTask(d, {
  title,
  description = null,
  category = 'misc',
  assignedTo = null,
  createdBy,
  parentTaskId = null,
  dueDate = null,
  dueTime = null,
  startDate = null,
  startTime = null,
  dueDateOffsetDays = null,
  priority = 'none',
  points = 0,
  expirationPolicy = 'keep_overdue',
  tags = [],
}) {
  const result = d.prepare(`
    INSERT INTO tasks (
      title, description, category, priority, status, due_date, due_time,
      assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
      assignment_mode, rotation_index, points, visibility, countdown, locked, expiration_policy, start_date, start_time, due_date_offset_days
    ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 0, NULL, 'fixed', 0, ?, 'all', 0, 0, ?, ?, ?, ?)
  `).run(
    title,
    description,
    category || 'misc',
    priority,
    dueDate,
    dueTime,
    assignedTo,
    createdBy,
    parentTaskId,
    points,
    expirationPolicy,
    startDate,
    startTime,
    dueDateOffsetDays,
  );
  const taskId = Number(result.lastInsertRowid);
  setTags(d, taskId, tags);
  if (assignedTo) {
    d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)')
      .run(taskId, assignedTo);
  }
  return taskId;
}

/**
 * Create a workflow instance and concrete tasks atomically.
 * Each activity is a subtask of a human-readable event parent. Supervision is a
 * second subtask, not a second assignee, so the learner and supervisor each get
 * an explicit piece of work.
 */
function instantiateWorkflowTasks(d, workflowId, {
  subjectUserId = null,
  inputs = {},
  createdBy,
  startDate = todayKey(d),
  rotationOccurrences = {},
  rotationOccurrenceKey = null,
} = {}) {
  const workflow = getWorkflowTemplate(d, workflowId);
  if (!workflow || !workflow.active) throw new Error('Workflow template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (workflow.subject_required && !subject) throw new Error('Choose a household member first.');
  if (!createdBy) throw new Error('A creator is required.');
  const resolvedVariables = resolveWorkflowVariables(d, workflow, inputs, subjectUserId, rotationOccurrences, createdBy);
  const runtimeInputs = resolvedVariables.ids;
  const variableLabels = resolvedVariables.labels;
  const activeSteps = workflow.steps.filter((step) => conditionMatches(step.condition, runtimeInputs));
  if (!activeSteps.length) throw new Error('No activities apply to these answers.');
  const activeStepKeys = new Set(activeSteps.map((step) => step.step_key));

  return d.transaction(() => {
    const instance = d.prepare(`
      INSERT INTO workflow_instances (
        workflow_template_id, subject_user_id, status, input_json, created_by
      ) VALUES (?, ?, 'open', ?, ?)
    `).run(workflow.id, subject?.id ?? null, JSON.stringify(resolvedVariables.persisted), createdBy);
    const instanceId = Number(instance.lastInsertRowid);

    const workflowName = substituteVariableTemplate(workflow.name, variableLabels);
    const parentTitle = subject ? `${workflowName}: ${subject.display_name}` : workflowName;
    const parentTaskId = insertTask(d, {
      title: parentTitle,
      description: substituteVariableTemplate(workflow.description, variableLabels),
      category: workflow.category || 'misc',
      createdBy,
      dueDate: startDate,
    });
    d.prepare('UPDATE workflow_instances SET parent_task_id = ? WHERE id = ?')
      .run(parentTaskId, instanceId);
    if (workflow.rotation_bindings.length) {
      d.prepare('UPDATE tasks SET rotation_bindings_json=? WHERE id=?').run(JSON.stringify(workflow.rotation_bindings), parentTaskId);
      bindTaskRotations(d, parentTaskId, {
      config: workflow.rotation_bindings, actorId: createdBy,
      consumer: { consumer_type: 'workflow', consumer_id: String(workflow.id) }, occurrenceKey: rotationOccurrenceKey,
      });
    }

    const generatedByStep = new Map();
    const generated = [];

    for (const step of activeSteps) {
      const activity = getActivityTemplate(d, step.activity_template_id);
      if (!activity || !activity.active) throw new Error(`Activity template unavailable: ${step.activity_name}`);
      const activitySubject = stepSubject(d, step, subject, runtimeInputs);
      const planning = stepPlanningContext(d, activity, step, runtimeInputs);
      const assignment = stepAssignment(activity, step, runtimeInputs);
      const schedule = workflowActivitySchedule(activity, startDate);
      const resolution = resolveActivityAssignment(d, activity, {
        subjectUserId: activitySubject?.id ?? null,
        dateKey: schedule.due_date || startDate,
        commitRotation: true,
        assignmentPolicyOverride: assignment.policy,
        fixedUserIdOverride: assignment.fixedUserId,
        presence: {
          policy: planning.presence_policy,
          targetPlaceId: planning.place_id,
          ...activityPresenceWindow(d, { dateKey: schedule.due_date || startDate, windowMode: planning.presence_window,
            task: schedule }),
        },
      });

      const primaryTaskId = insertTask(d, {
        title: stepTitle(activity, activitySubject, step.title_override, variableLabels),
        description: stepDescription(activity, activitySubject, step.description_override, variableLabels),
        category: activity.category,
        priority: activity.priority,
        points: activity.points,
        expirationPolicy: activity.expiration_policy ?? 'keep_overdue',
        tags: activity.tags,
        assignedTo: resolution.primary?.id ?? null,
        createdBy,
        parentTaskId,
        dueDate: schedule.due_date,
        dueTime: schedule.due_time,
        startDate: schedule.start_date,
        startTime: schedule.start_time,
        dueDateOffsetDays: schedule.due_date_offset_days,
      });
      d.prepare(`
        INSERT INTO workflow_instance_tasks (
          workflow_instance_id, workflow_step_id, task_id, role
        ) VALUES (?, ?, ?, 'primary')
      `).run(instanceId, step.id, primaryTaskId);
      d.prepare(`
        INSERT INTO task_activity_bindings (task_id, activity_template_id, subject_user_id)
        VALUES (?, ?, ?)
      `).run(primaryTaskId, activity.id, activitySubject?.id ?? null);
      const checklistTaskIds = materializeActivityChecklist(d, {
        activity,
        parentTaskId: primaryTaskId,
        subject: activitySubject,
        variableLabels,
        createdBy,
      });
      if (activity.rotation_bindings?.length) {
        d.prepare('UPDATE tasks SET rotation_bindings_json=? WHERE id=?').run(JSON.stringify(activity.rotation_bindings), primaryTaskId);
        bindTaskRotations(d, primaryTaskId, { config: activity.rotation_bindings, actorId: createdBy,
          consumer: { consumer_type: 'workflow_step', consumer_id: `${workflow.id}:${step.step_key}` }, occurrenceKey: rotationOccurrenceKey });
      }
      const rotationConfig = [...new Map([...workflow.rotation_bindings, ...(activity.rotation_bindings || [])].map(binding => [binding.purpose_key, binding])).values()];
      if (rotationConfig.length) {
        const rendered = renderRotationVariableTemplates(d, { templates: [step.title_override ?? activity.title_template, step.description_override ?? activity.description,
          ...activity.checklist.map(item=>item.title_template)], bindings: rotationConfig, rotations: taskRotationContexts(d,primaryTaskId), inputs:runtimeInputs,
          subjectUserId: activitySubject?.id || resolution.primary?.id || subjectUserId, definitions:workflow.input_schema });
        d.prepare('UPDATE tasks SET title=?,description=? WHERE id=?').run(stepTitle(activity,activitySubject,rendered.values[0],variableLabels),
          stepDescription(activity,activitySubject,rendered.values[1],variableLabels),primaryTaskId);
        checklistTaskIds.forEach((taskId,index)=>d.prepare('UPDATE tasks SET title=? WHERE id=?').run(
          renderActivityChecklistTitle({...activity.checklist[index],title_template:rendered.values[index+2]},activity,activitySubject,variableLabels),taskId));
        initializeTaskRotationRendering(d,primaryTaskId,{inputs:runtimeInputs,definitions:workflow.input_schema,
          templates:{title:step.title_override??activity.title_template,description:step.description_override??activity.description}});
      }
      const requireChecklistItem = d.prepare(`
        INSERT OR IGNORE INTO workflow_task_dependencies (task_id, depends_on_task_id)
        VALUES (?, ?)
      `);
      checklistTaskIds.filter(id=>!taskOptionalContext(d,id).is_optional)
        .forEach((checklistTaskId) => requireChecklistItem.run(primaryTaskId, checklistTaskId));
      if (resolution.primary) assertTaskSupervisionAssignee(d, primaryTaskId, resolution.primary.id);
      if (planning.place_id || planning.presence_policy !== 'ignore') {
        d.prepare(`
          INSERT INTO task_planning_context (task_id, place_id, presence_policy, presence_window, source)
          VALUES (?, ?, ?, ?, 'workflow')
        `).run(primaryTaskId, planning.place_id, planning.presence_policy, planning.presence_window);
      }

      const stepTaskIds = [primaryTaskId];
      recordTaskAssignment(d, primaryTaskId, activity, resolution, {
        source: 'workflow',
        strategy: assignment.policy,
      });
      generated.push({
        task_id: primaryTaskId,
        checklist_task_ids: checklistTaskIds,
        role: 'primary',
        step_key: step.step_key,
        assigned_to: resolution.primary,
        participants: resolution.participants || [],
        subject: activitySubject,
        ...planning,
      });

      const supervision = reconcileTaskSupervision(d, primaryTaskId, { actorId: createdBy });
      if (supervision.support_task_id) {
        const supervisionTaskId = supervision.support_task_id;
        d.prepare(`INSERT OR IGNORE INTO workflow_instance_tasks(workflow_instance_id,workflow_step_id,task_id,role)
          VALUES(?,?,?,'supervisor')`).run(instanceId, step.id, supervisionTaskId);
        stepTaskIds.push(supervisionTaskId);
        const supervisionMembers = d.prepare(`SELECT u.id,u.display_name,u.avatar_color,u.avatar_data FROM task_assignments a
          JOIN users u ON u.id=a.user_id WHERE a.task_id=? ORDER BY u.id`).all(supervisionTaskId);
        generated.push({ task_id: supervisionTaskId, role: 'supervisor', step_key: step.step_key,
          assigned_to: supervisionMembers[0] || null, participants: supervisionMembers, supervision });
      }

      generatedByStep.set(step.step_key, stepTaskIds);
      for (const predecessorKey of activeDependencyKeys(workflow, activeStepKeys, step)) {
        for (const currentTaskId of stepTaskIds) {
          for (const predecessorTaskId of generatedByStep.get(predecessorKey) ?? []) {
            d.prepare(`
              INSERT OR IGNORE INTO workflow_task_dependencies (task_id, depends_on_task_id)
              VALUES (?, ?)
            `).run(currentTaskId, predecessorTaskId);
          }
        }
      }
    }

    // The top-level event must survive "Assigned to me" and person filters even
    // though the actual work lives on its subtasks. Treat every generated
    // assignee as a participant on the parent without setting the legacy
    // single-assignee column. This keeps filtering useful while the child rows
    // remain the authoritative individual assignments.
    const parentParticipant = d.prepare(
      'INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)'
    );
    const participantIds = new Set(generated.flatMap((item) => [
      Number(item.assigned_to?.id),
      ...(item.participants || []).map((participant) => Number(participant.id)),
    ]).filter((id) => Number.isInteger(id) && id > 0));
    const parentResponsibility = d.prepare(`
      INSERT OR IGNORE INTO task_responsibilities (task_id, user_id, role, source)
      VALUES (?, ?, 'participant', 'workflow')
    `);
    for (const userId of participantIds) {
      parentParticipant.run(parentTaskId, userId);
      parentResponsibility.run(parentTaskId, userId);
    }

    // The parent is an event container, not an independently completable piece
    // of work. Reuse the existing dependency guard so a user cannot manually
    // mark the event complete while generated activities are still open. The
    // sync function below will complete/reopen the parent as its children move.
    const parentDependency = d.prepare(`
      INSERT OR IGNORE INTO workflow_task_dependencies (task_id, depends_on_task_id)
      VALUES (?, ?)
    `);
    for (const item of generated) parentDependency.run(parentTaskId, item.task_id);

    return {
      id: instanceId,
      workflow_template_id: workflow.id,
      workflow_name: workflow.name,
      resolved_variables: resolvedVariables.summary,
      subject,
      parent_task_id: parentTaskId,
      tasks: generated,
      rotations: taskRotationContexts(d, parentTaskId),
      rotation_operations:workflow.rotation_bindings.map(binding=>({purpose_key:binding.purpose_key,label:binding.label,operations:binding.workflow_operations||['resolve']})),
    };
  })();
}

/** Optional work and its generated helper do not hold the workflow open. */
function requiredWorkflowDependency(d, taskId) {
  if(taskOptionalContext(d,taskId).is_optional)return false;
  const support=d.prepare('SELECT source_task_id FROM task_activity_support_tasks WHERE task_id=?').get(taskId);
  if(!support)return true;
  const actions=d.prepare(`SELECT a.action_task_id,a.state,t.status FROM task_supervision_actions a
    JOIN tasks t ON t.id=a.action_task_id WHERE a.source_task_id=?`).all(support.source_task_id);
  // Preserve the dependency of legacy helper rows without granular mappings.
  return !actions.length || actions.some(action=>action.state!=='not_required' && action.status!=='done'
    && !taskOptionalContext(d,action.action_task_id).is_optional);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** An explicit caller retry identity owns one atomic workflow and its rotations. */
export function instantiateWorkflow(d, workflowId, options = {}) {
  const workflow = getWorkflowTemplate(d, workflowId);
  if (!workflow?.active) throw new Error('Workflow template not found.');
  const hasRotations = assertWorkflowRotationAccess(d, options.createdBy, workflow);
  if (!hasRotations && !options.requestKey) return instantiateWorkflowTasks(d, workflowId, options);
  if (hasRotations) assertCapability(d, options.createdBy, 'rotations.configure');
  const key = String(options.requestKey || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('A stable request key is required to create this rotating Workflow. Refresh the preview and try again.');
  const inputHash = createHash('sha256').update(stableJson({ inputs: options.inputs || {}, subject: options.subjectUserId ?? null, start: options.startDate || todayKey(d) })).digest('hex');
  return d.transaction(() => {
    const previous = d.prepare('SELECT * FROM rotation_workflow_requests WHERE workflow_template_id=? AND actor_user_id=? AND request_key=?').get(workflowId, options.createdBy, key);
    if (previous) {
      if (previous.input_hash !== inputHash) throw Object.assign(new Error('This Workflow request was already used with different answers.'), { status: 409 });
      const saved = JSON.parse(previous.response_json), result = saved.result ?? saved;
      for (const capability of new Set([...(saved.rotation_capabilities || []), ...workflowResultRotationCapabilities(d, result)]))
        assertCapability(d, options.createdBy, capability);
      assertWorkflowResultVisibility(d,options.createdBy,result);
      return result;
    }
    const occurrenceKey = `workflow-request:${options.createdBy}:${key}`;
    const rotationOccurrences = Object.fromEntries(workflow.rotation_bindings.map(binding => {
      const identity = { consumer_type: 'workflow', consumer_id: String(workflow.id), purpose_key: binding.purpose_key };
      const previousTrack = findRotationTrack(d, identity);
      const track = configureRotationTrack(d, { ...binding, ...identity, expected_revision: previousTrack?.revision }, { actorId: options.createdBy, trusted: true });
      return [binding.purpose_key, resolveRotation(d, track.id, occurrenceKey, { actorId: options.createdBy, context: { dateKey: options.startDate || todayKey(d) } })];
    }));
    const result = instantiateWorkflowTasks(d, workflowId, { ...options, rotationOccurrences, rotationOccurrenceKey: occurrenceKey });
    d.prepare('INSERT INTO rotation_workflow_requests(workflow_template_id,actor_user_id,request_key,input_hash,workflow_instance_id,response_json) VALUES(?,?,?,?,?,?)')
      .run(workflowId, options.createdBy, key, inputHash, result.id, JSON.stringify({result, rotation_capabilities:workflowResultRotationCapabilities(d, result)}));
    return result;
  }).immediate();
}

export function unresolvedDependencies(d, taskId) {
  return d.prepare(`
    SELECT dep.id, dep.title, dep.status
      FROM workflow_task_dependencies wtd
      JOIN tasks dep ON dep.id = wtd.depends_on_task_id
     WHERE wtd.task_id = ? AND dep.status != 'done'
     ORDER BY dep.id
  `).all(taskId).filter(row=>requiredWorkflowDependency(d,row.id));
}

/** Keep workflow instance and event parent status in sync with generated work. */
export function syncWorkflowInstanceForTask(d, taskId, { syncParent = true } = {}) {
  const link = d.prepare(`
    SELECT wit.workflow_instance_id, wi.parent_task_id
      FROM workflow_instance_tasks wit
      JOIN workflow_instances wi ON wi.id = wit.workflow_instance_id
     WHERE wit.task_id = ?
  `).get(taskId);
  if (!link) return null;

  const remaining = d.prepare(`
    SELECT t.id
      FROM workflow_instance_tasks wit
      JOIN tasks t ON t.id = wit.task_id
     WHERE wit.workflow_instance_id = ? AND t.status != 'done'
  `).all(link.workflow_instance_id).filter(row=>requiredWorkflowDependency(d,row.id)).length;
  const status = remaining === 0 ? 'done' : 'open';
  d.prepare(`
    UPDATE workflow_instances
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(status, link.workflow_instance_id);
  if (syncParent && link.parent_task_id) {
    d.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, link.parent_task_id);
    if (status === 'done') settleTaskRotations(d, link.parent_task_id, 'completed');
  }
  return { workflowInstanceId: link.workflow_instance_id, status };
}
