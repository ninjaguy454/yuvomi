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

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function workflowInputSchema(d, workflowTemplateId, rawSchema) {
  const definitions = d.prepare(`
    SELECT id, variable_key, scope, reusable_definition_id
      FROM workflow_variable_definitions
     WHERE workflow_template_id = ?
     ORDER BY id
  `).all(workflowTemplateId);
  const byKey = new Map(definitions.map((definition) => [definition.variable_key, definition]));
  return parseJson(rawSchema, []).map((question) => {
    const variableKey = question?.id ?? question?.key;
    const definition = byKey.get(variableKey);
    return definition ? {
      ...question,
      id: variableKey,
      definition_id: definition.id,
      scope: definition.scope,
      reusable_definition_id: definition.reusable_definition_id,
    } : question;
  });
}

export function getActivityTemplate(d, id) {
  const row = d.prepare('SELECT * FROM activity_templates WHERE id = ?').get(id);
  if (!row) return null;
  row.skills = loadSkillRequirements(d, row.id);
  return row;
}

export function listActivityTemplates(d, { activeOnly = false } = {}) {
  const rows = d.prepare(`
    SELECT * FROM activity_templates
    ${activeOnly ? 'WHERE active = 1' : ''}
    ORDER BY name COLLATE NOCASE, id
  `).all();
  return rows.map((row) => ({ ...row, skills: loadSkillRequirements(d, row.id) }));
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

function normalizeRuntimeInputs(d, workflow, inputs) {
  if (inputs == null) return {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('Workflow inputs must be an object.');
  }
  const questions = new Map((workflow.input_schema ?? []).map((question) => [workflowVariableId(question), question]));
  for (const key of Object.keys(inputs)) {
    if (!questions.has(key)) throw new Error(`Unknown workflow input: ${key}.`);
  }
  const normalized = {};
  for (const question of workflow.input_schema ?? []) {
    const variableId = workflowVariableId(question);
    if (!Object.hasOwn(inputs, variableId)) continue;
    const value = inputs[variableId];
    if (question.type === 'boolean') {
      if (value === true || value === false) normalized[variableId] = value;
      else if (value === 'true' || value === 'false') normalized[variableId] = value === 'true';
      else throw new Error(`Workflow input ${variableId} must be Yes or No.`);
    } else if (question.type === 'select' || question.type === 'choice') {
      const selected = value == null ? '' : String(value);
      const options = (question.options ?? []).map(String);
      if (!options.includes(selected)) {
        throw new Error(`Workflow input ${variableId} must use one of its configured choices.`);
      }
      normalized[variableId] = selected;
    } else if (question.type === 'household_member') {
      const memberId = Number(value);
      const validMember = householdMembers(d).some((member) => Number(member.id) === memberId);
      if (!Number.isInteger(memberId) || !validMember) {
        throw new Error(`Workflow input ${variableId} must be a valid household member.`);
      }
      normalized[variableId] = memberId;
    } else if (question.type === 'location') {
      const placeId = Number(value);
      const validPlace = d.prepare('SELECT 1 FROM places WHERE id = ? AND active = 1').get(placeId);
      if (!Number.isInteger(placeId) || !validPlace) {
        throw new Error(`Workflow input ${variableId} must be an active Place.`);
      }
      normalized[variableId] = placeId;
    } else if (question.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || value === '') {
        throw new Error(`Workflow input ${variableId} must be a number.`);
      }
      normalized[variableId] = number;
    } else if (question.type === 'date') {
      const date = value == null ? '' : String(value);
      const [year, month, day] = date.split('-').map(Number);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
        && parsedDate.getUTCFullYear() === year
        && parsedDate.getUTCMonth() === month - 1
        && parsedDate.getUTCDate() === day;
      if (!validDate) {
        throw new Error(`Workflow input ${variableId} must be a date.`);
      }
      normalized[variableId] = date;
    } else if (question.type === 'time') {
      const time = value == null ? '' : String(value);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        throw new Error(`Workflow input ${variableId} must be a time.`);
      }
      normalized[variableId] = time;
    } else {
      const string = value == null ? '' : String(value);
      if (string.length > 2000) throw new Error(`Workflow input ${variableId} is too long.`);
      normalized[variableId] = string;
    }
  }
  return normalized;
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

function workflowVariableLabels(d, workflow, inputs) {
  const labels = {};
  for (const question of workflow.input_schema ?? []) {
    const variableId = workflowVariableId(question);
    if (!Object.hasOwn(inputs, variableId)) continue;
    const value = inputs[variableId];
    if (question.type === 'household_member') labels[variableId] = userById(d, value)?.display_name ?? '';
    else if (question.type === 'location') {
      const place = placeWithInheritedAddress(d, d.prepare('SELECT * FROM places WHERE id = ?').get(value));
      labels[variableId] = place?.name ?? '';
      labels[`${variableId}.name`] = place?.name ?? '';
      labels[`${variableId}.id`] = place?.id == null ? '' : String(place.id);
      labels[`${variableId}.parent`] = place?.path?.length > 1 ? place.path.at(-2)?.name ?? '' : '';
      labels[`${variableId}.address`] = [place?.street_address, place?.city, place?.region, place?.postal_code, place?.country].filter(Boolean).join(', ');
    }
    else if (question.type === 'boolean') labels[variableId] = value ? 'Yes' : 'No';
    else labels[variableId] = String(value ?? '');
  }
  return labels;
}

function substituteWorkflowVariables(value, labels) {
  if (value == null) return null;
  return String(value).replace(/\{\{([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)?)\}\}/g, (_match, variableId) => (
    Object.hasOwn(labels, variableId) ? labels[variableId] : ''
  ));
}

function stepTitle(activity, subject, override = null, variableLabels = {}) {
  const title = override
    ? String(override)
      .replaceAll('{subject}', subject?.display_name || '')
      .replaceAll('{activity}', activity.name || 'Activity')
      .trim()
    : renderActivityTitle(activity, subject);
  return substituteWorkflowVariables(title, variableLabels)?.trim();
}

function stepDescription(activity, subject, override = null, variableLabels = {}) {
  const description = String(override ?? activity.description ?? '')
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity.name || 'Activity');
  return substituteWorkflowVariables(description, variableLabels);
}

function supervisorTitle(activity, subject, variableLabels = {}) {
  const template = activity.supervision_title_template || 'Supervise {subject}: {activity}';
  return substituteWorkflowVariables(String(template)
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
  const runtimeInputs = normalizeRuntimeInputs(d, workflow, inputs);
  const variableLabels = workflowVariableLabels(d, workflow, runtimeInputs);
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
      name: substituteWorkflowVariables(workflow.name, variableLabels),
      description: substituteWorkflowVariables(workflow.description, variableLabels),
      subject_required: workflow.subject_required,
    },
    subject,
    inputs: runtimeInputs,
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
}) {
  const result = d.prepare(`
    INSERT INTO tasks (
      title, description, category, priority, status, due_date, due_time,
      assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule,
      assignment_mode, rotation_index, points, visibility, countdown, locked
    ) VALUES (?, ?, ?, 'none', 'open', ?, ?, ?, ?, ?, 0, NULL, 'fixed', 0, 0, 'all', 0, 0)
  `).run(
    title,
    description,
    category || 'misc',
    dueDate,
    dueTime,
    assignedTo,
    createdBy,
    parentTaskId,
  );
  const taskId = Number(result.lastInsertRowid);
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
  const runtimeInputs = normalizeRuntimeInputs(d, workflow, inputs);
  const variableLabels = workflowVariableLabels(d, workflow, runtimeInputs);
  const activeSteps = workflow.steps.filter((step) => conditionMatches(step.condition, runtimeInputs));
  if (!activeSteps.length) throw new Error('No activities apply to these answers.');
  const activeStepKeys = new Set(activeSteps.map((step) => step.step_key));

  return d.transaction(() => {
    const instance = d.prepare(`
      INSERT INTO workflow_instances (
        workflow_template_id, subject_user_id, status, input_json, created_by
      ) VALUES (?, ?, 'open', ?, ?)
    `).run(workflow.id, subject?.id ?? null, JSON.stringify(runtimeInputs), createdBy);
    const instanceId = Number(instance.lastInsertRowid);

    const workflowName = substituteWorkflowVariables(workflow.name, variableLabels);
    const parentTitle = subject ? `${workflowName}: ${subject.display_name}` : workflowName;
    const parentTaskId = insertTask(d, {
      title: parentTitle,
      description: substituteWorkflowVariables(workflow.description, variableLabels),
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
