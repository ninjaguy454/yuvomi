/**
 * Reusable activity/workflow engine.
 *
 * Workflow templates compose activity templates. Instantiation creates one
 * parent task and concrete, individually assigned subtasks. The template graph
 * and generated-task graph are stored separately so the UI can explain why a
 * task exists and which earlier work it depends on.
 */

import { todayKey } from '../utils/timezone.js';
import {
  loadSkillRequirements,
  resolveActivityAssignment,
  renderActivityTitle,
} from './activity-eligibility.js';

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
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
  workflow.input_schema = parseJson(workflow.input_schema_json, []);
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
    input_schema: parseJson(row.input_schema_json, []),
    input_schema_json: undefined,
  }));
}

function normalizeRuntimeInputs(workflow, inputs) {
  if (inputs == null) return {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('Workflow inputs must be an object.');
  }
  const questions = new Map((workflow.input_schema ?? []).map((question) => [question.key, question]));
  for (const key of Object.keys(inputs)) {
    if (!questions.has(key)) throw new Error(`Unknown workflow input: ${key}.`);
  }
  const normalized = {};
  for (const question of workflow.input_schema ?? []) {
    if (!Object.hasOwn(inputs, question.key)) continue;
    const value = inputs[question.key];
    if (question.type === 'boolean') {
      if (value === true || value === false) normalized[question.key] = value;
      else if (value === 'true' || value === 'false') normalized[question.key] = value === 'true';
      else throw new Error(`Workflow input ${question.key} must be Yes or No.`);
    } else if (question.type === 'select') {
      const selected = value == null ? '' : String(value);
      const options = (question.options ?? []).map(String);
      if (!options.includes(selected)) {
        throw new Error(`Workflow input ${question.key} must use one of its configured choices.`);
      }
      normalized[question.key] = selected;
    } else {
      normalized[question.key] = value == null ? '' : String(value);
    }
  }
  return normalized;
}

function conditionMatches(condition, inputs) {
  if (!condition) return true;
  if (!condition.input) throw new Error('Invalid workflow condition.');
  if (Object.hasOwn(condition, 'equals')) return inputs?.[condition.input] === condition.equals;
  if (Array.isArray(condition.in)) return condition.in.includes(inputs?.[condition.input]);
  throw new Error('Invalid workflow condition.');
}

function userById(d, id) {
  if (id == null) return null;
  return d.prepare('SELECT id, display_name, family_role FROM users WHERE id = ?').get(id) ?? null;
}

function stepTitle(activity, subject, override = null) {
  if (override) {
    return String(override).replaceAll('{subject}', subject?.display_name || '').trim();
  }
  return renderActivityTitle(activity, subject);
}

function supervisorTitle(activity, subject) {
  const template = activity.supervision_title_template || 'Supervise {subject}: {activity}';
  return String(template)
    .replaceAll('{subject}', subject?.display_name || '')
    .replaceAll('{activity}', activity.name || 'activity')
    .trim();
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
  const runtimeInputs = normalizeRuntimeInputs(workflow, inputs);
  const activeSteps = workflow.steps.filter((step) => conditionMatches(step.condition, runtimeInputs));
  if (!activeSteps.length) throw new Error('No activities apply to these answers.');
  const activeStepKeys = new Set(activeSteps.map((step) => step.step_key));

  const output = [];
  for (const step of activeSteps) {
    const activity = getActivityTemplate(d, step.activity_template_id);
    if (!activity || !activity.active) throw new Error(`Activity template unavailable: ${step.activity_name}`);
    const resolution = resolveActivityAssignment(d, activity, {
      subjectUserId: subject?.id ?? null,
      commitRotation: false,
    });
    output.push({
      step_key: step.step_key,
      activity_template_id: activity.id,
      activity_name: activity.name,
      title: stepTitle(activity, subject, step.title_override),
      assigned_to: resolution.primary,
      supervisor: resolution.supervisor,
      supervisor_title: resolution.supervisor ? supervisorTitle(activity, subject) : null,
      subject_proficiency: resolution.subjectProficiency?.proficiency ?? null,
      depends_on: step.depends_on.filter((key) => activeStepKeys.has(key)),
      category: activity.category,
    });
  }

  return {
    workflow: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
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
  const runtimeInputs = normalizeRuntimeInputs(workflow, inputs);
  const activeSteps = workflow.steps.filter((step) => conditionMatches(step.condition, runtimeInputs));
  if (!activeSteps.length) throw new Error('No activities apply to these answers.');

  return d.transaction(() => {
    const instance = d.prepare(`
      INSERT INTO workflow_instances (
        workflow_template_id, subject_user_id, status, input_json, created_by
      ) VALUES (?, ?, 'open', ?, ?)
    `).run(workflow.id, subject?.id ?? null, JSON.stringify(runtimeInputs), createdBy);
    const instanceId = Number(instance.lastInsertRowid);

    const parentTitle = subject
      ? `${workflow.name}: ${subject.display_name}`
      : workflow.name;
    const parentTaskId = insertTask(d, {
      title: parentTitle,
      description: workflow.description,
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
      const resolution = resolveActivityAssignment(d, activity, {
        subjectUserId: subject?.id ?? null,
        commitRotation: true,
      });

      const primaryTaskId = insertTask(d, {
        title: stepTitle(activity, subject, step.title_override),
        description: activity.description,
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

      const stepTaskIds = [primaryTaskId];
      generated.push({
        task_id: primaryTaskId,
        role: 'primary',
        step_key: step.step_key,
        assigned_to: resolution.primary,
      });

      if (resolution.supervisor) {
        const supervisionTaskId = insertTask(d, {
          title: supervisorTitle(activity, subject),
          description: `Supervise ${subject?.display_name || 'the household member'} while they complete: ${activity.name}`,
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
        stepTaskIds.push(supervisionTaskId);
        generated.push({
          task_id: supervisionTaskId,
          role: 'supervisor',
          step_key: step.step_key,
          assigned_to: resolution.supervisor,
        });
      }

      generatedByStep.set(step.step_key, stepTaskIds);
      for (const predecessorKey of step.depends_on) {
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
    const participantIds = new Set(
      generated.map((item) => Number(item.assigned_to?.id)).filter((id) => Number.isInteger(id) && id > 0)
    );
    for (const userId of participantIds) parentParticipant.run(parentTaskId, userId);

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
