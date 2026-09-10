/**
 * Reusable activity/workflow engine.
 *
 * Workflow templates compose activity templates. Instantiation creates one
 * parent task and concrete, individually assigned subtasks. The template graph
 * and generated-task graph are stored separately so the UI can explain why a
 * task exists and which earlier work it depends on.
 */

import { todayKey } from '../utils/timezone.js';
import { placeWithInheritedAddress } from './presence.js';
import {
  householdMembers,
  loadSkillRequirements,
  resolveActivityAssignment,
  renderActivityTitle,
} from './activity-eligibility.js';
import { recordTaskAssignment } from './assignment-responsibilities.js';
import { loadActivityChecklist, materializeActivityChecklist, renderActivityChecklistTitle } from './activity-template-checklist.js';
import { setTags } from '../utils/task-tags.js';
import {
  hydrateWorkflowDefinitions, resolveVariables, substituteVariableTemplate,
  templateReferences, expressionScope, expressionDependencies, definitionsForTemplates, variableInputSchema,
} from './variable-resolution.js';

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function workflowInputSchema(d, workflowTemplateId, rawSchema) {
  return hydrateWorkflowDefinitions(d, workflowTemplateId, parseJson(rawSchema, []));
}

export function getActivityTemplate(d, id) {
  const row = d.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
  if (!row) return null;
  row.skills = loadSkillRequirements(d, row.id);
  row.checklist = loadActivityChecklist(d, row.id);
  row.tags = parseJson(row.tags_json, []);
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
  }));
}

export function getWorkflowTemplate(d, id) {
  const workflow = d.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id);
  if (!workflow) return null;
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
    input_schema: workflowInputSchema(d, row.id, row.input_schema_json),
    input_schema_json: undefined,
  }));
}

function workflowVariableId(question) {
  return question?.id ?? question?.key ?? null;
}

function resolveWorkflowVariables(d, workflow, inputs, subjectUserId) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Workflow inputs must be an object.');
  const definitions = workflow.input_schema ?? [];
  const known = new Set(definitions.map(workflowVariableId));
  for (const key of Object.keys(inputs ?? {})) if (!known.has(key)) throw new Error(`Unknown workflow input: ${key}.`);
  const scope = expressionScope(definitions);
  const keys = new Set(definitions.filter(row => row.expression || row.default_value != null || Object.hasOwn(inputs, workflowVariableId(row))).map(workflowVariableId));
  const templates = [workflow.name, workflow.description];
  for (const step of workflow.steps) {
    const activity = getActivityTemplate(d, step.activity_template_id);
    templates.push(step.title_override ?? activity?.title_template, step.description_override ?? activity?.description,
      activity?.supervision_title_template, ...(activity?.checklist ?? []).map(item => item.title_template));
    for (const key of [step.subject_variable_id, step.assignment_variable_id, step.assignment_policy_variable_id,
      step.location_mode === 'workflow' ? step.location_variable_id : activity?.location_mode === 'workflow' ? activity.location_variable_id : null]) {
      if (key) keys.add(key);
    }
  }
  for (const reference of templateReferences(templates)) for (const key of expressionDependencies(reference, scope)) keys.add(key);
  return resolveVariables(d, definitions, inputs, { keys: [...keys], subjectUserId });
}

export function activityVariableSchema(d, activity, catalog) {
  const result = definitionsForTemplates(d, [activity.title_template, activity.description, activity.supervision_title_template,
    ...(activity.checklist ?? []).map(item => item.title_template)], catalog);
  return { ...result, input_schema: variableInputSchema(expressionScope(result.definitions), result.keys) };
}

/** Returns an ordinary editable Task draft; does not create Tasks or advance rotation. */
export function resolveActivityTemplate(d, activityId, { inputs = {}, subjectUserId = null, includeLabels = false } = {}) {
  const activity = getActivityTemplate(d, activityId);
  if (!activity?.active) throw new Error('Activity template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (subjectUserId != null && !subject) throw new Error('Choose a household member.');
  if (activity.subject_required && !subject) throw Object.assign(new Error('Choose a household member first.'), { code: 'missing_input' });
  const schema = activityVariableSchema(d, activity);
  const resolved = resolveVariables(d, schema.definitions, inputs, { keys: schema.keys, subjectUserId });
  return {
    data: { title: stepTitle(activity, subject, null, resolved.labels), description: stepDescription(activity, subject, null, resolved.labels),
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

/** Pure preview. It intentionally does not advance any rotation cursor. */
export function previewWorkflow(d, workflowId, {
  subjectUserId = null,
  inputs = {},
} = {}) {
  const workflow = getWorkflowTemplate(d, workflowId);
  if (!workflow || !workflow.active) throw new Error('Workflow template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (workflow.subject_required && !subject) throw new Error('Choose a household member first.');
  const resolvedVariables = resolveWorkflowVariables(d, workflow, inputs, subjectUserId);
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
        const resolution = resolveActivityAssignment(d, activity, {
          subjectUserId: activitySubject?.id ?? null,
          commitRotation: true,
          assignmentPolicyOverride: assignment.policy,
          fixedUserIdOverride: assignment.fixedUserId,
          presence: {
            policy: planning.presence_policy,
            targetPlaceId: planning.place_id,
            startAt: `${todayKey(d)}T00:00:00`,
            endAt: `${todayKey(d)}T23:59:00`,
          },
        });
        output.push({
          step_key: step.step_key,
          activity_template_id: activity.id,
          activity_name: activity.name,
          title: stepTitle(activity, activitySubject, step.title_override, variableLabels),
          description: stepDescription(activity, activitySubject, step.description_override, variableLabels),
          subject: activitySubject,
          assigned_to: resolution.primary,
          supervisor: resolution.supervisor,
          supervisor_title: resolution.supervisor ? supervisorTitle(activity, activitySubject, variableLabels) : null,
          subject_proficiency: resolution.subjectProficiency?.proficiency ?? null,
          assignment_policy: assignment.policy,
          depends_on: activeDependencyKeys(workflow, activeStepKeys, step),
          category: activity.category,
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
  priority = 'none',
  points = 0,
  tags = [],
}) {
  const result = d.prepare(`
    INSERT INTO tasks (
      title, description, category, priority, status, due_date, due_time,
      assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
      assignment_mode, rotation_index, points, visibility, countdown, locked
    ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 0, NULL, 'fixed', 0, ?, 'all', 0, 0)
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
export function instantiateWorkflow(d, workflowId, {
  subjectUserId = null,
  inputs = {},
  createdBy,
} = {}) {
  const workflow = getWorkflowTemplate(d, workflowId);
  if (!workflow || !workflow.active) throw new Error('Workflow template not found.');
  const subject = subjectUserId == null ? null : userById(d, subjectUserId);
  if (workflow.subject_required && !subject) throw new Error('Choose a household member first.');
  if (!createdBy) throw new Error('A creator is required.');
  const resolvedVariables = resolveWorkflowVariables(d, workflow, inputs, subjectUserId);
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
      dueDate: todayKey(d),
    });
    d.prepare('UPDATE workflow_instances SET parent_task_id = ? WHERE id = ?')
      .run(parentTaskId, instanceId);

    const generatedByStep = new Map();
    const generated = [];

    for (const step of activeSteps) {
      const activity = getActivityTemplate(d, step.activity_template_id);
      if (!activity || !activity.active) throw new Error(`Activity template unavailable: ${step.activity_name}`);
      const activitySubject = stepSubject(d, step, subject, runtimeInputs);
      const planning = stepPlanningContext(d, activity, step, runtimeInputs);
      const assignment = stepAssignment(activity, step, runtimeInputs);
      const resolution = resolveActivityAssignment(d, activity, {
        subjectUserId: activitySubject?.id ?? null,
        commitRotation: true,
        assignmentPolicyOverride: assignment.policy,
        fixedUserIdOverride: assignment.fixedUserId,
        presence: {
          policy: planning.presence_policy,
          targetPlaceId: planning.place_id,
          startAt: `${todayKey(d)}T00:00:00`,
          endAt: `${todayKey(d)}T23:59:00`,
        },
      });

      const primaryTaskId = insertTask(d, {
        title: stepTitle(activity, activitySubject, step.title_override, variableLabels),
        description: stepDescription(activity, activitySubject, step.description_override, variableLabels),
        category: activity.category,
        priority: activity.priority,
        points: activity.points,
        tags: activity.tags,
        assignedTo: resolution.primary?.id ?? null,
        createdBy,
        parentTaskId,
        dueDate: todayKey(d),
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
      const requireChecklistItem = d.prepare(`
        INSERT OR IGNORE INTO workflow_task_dependencies (task_id, depends_on_task_id)
        VALUES (?, ?)
      `);
      checklistTaskIds.forEach((checklistTaskId) => requireChecklistItem.run(primaryTaskId, checklistTaskId));
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

      if (resolution.supervisor) {
        const supervisionTaskId = insertTask(d, {
          title: supervisorTitle(activity, activitySubject, variableLabels),
          description: `Supervise ${activitySubject?.display_name || 'the household member'} while they complete: ${activity.name}`,
          category: activity.category,
          assignedTo: resolution.supervisor.id,
          createdBy,
          parentTaskId,
          dueDate: todayKey(d),
        });
        d.prepare(`
          INSERT INTO workflow_instance_tasks (
            workflow_instance_id, workflow_step_id, task_id, role
          ) VALUES (?, ?, ?, 'supervisor')
        `).run(instanceId, step.id, supervisionTaskId);
        if (planning.place_id || planning.presence_policy !== 'ignore') {
          d.prepare(`
            INSERT INTO task_planning_context (task_id, place_id, presence_policy, presence_window, source)
            VALUES (?, ?, ?, ?, 'workflow')
          `).run(supervisionTaskId, planning.place_id, planning.presence_policy, planning.presence_window);
        }
        stepTaskIds.push(supervisionTaskId);
        generated.push({
          task_id: supervisionTaskId,
          role: 'supervisor',
          step_key: step.step_key,
          assigned_to: resolution.supervisor,
        });
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
    };
  })();
}

export function unresolvedDependencies(d, taskId) {
  return d.prepare(`
    SELECT dep.id, dep.title, dep.status
      FROM workflow_task_dependencies wtd
      JOIN tasks dep ON dep.id = wtd.depends_on_task_id
     WHERE wtd.task_id = ? AND dep.status != 'done'
     ORDER BY dep.id
  `).all(taskId);
}

/** Keep workflow instance and event parent status in sync with generated work. */
export function syncWorkflowInstanceForTask(d, taskId) {
  const link = d.prepare(`
    SELECT wit.workflow_instance_id, wi.parent_task_id
      FROM workflow_instance_tasks wit
      JOIN workflow_instances wi ON wi.id = wit.workflow_instance_id
     WHERE wit.task_id = ?
  `).get(taskId);
  if (!link) return null;

  const remaining = d.prepare(`
    SELECT COUNT(*) AS n
      FROM workflow_instance_tasks wit
      JOIN tasks t ON t.id = wit.task_id
     WHERE wit.workflow_instance_id = ? AND t.status != 'done'
  `).get(link.workflow_instance_id)?.n ?? 0;
  const status = remaining === 0 ? 'done' : 'open';
  d.prepare(`
    UPDATE workflow_instances
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ?
  `).run(status, link.workflow_instance_id);
  if (link.parent_task_id) {
    d.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, link.parent_task_id);
  }
  return { workflowInstanceId: link.workflow_instance_id, status };
}
