/**
 * Household automation API.
 *
 * Admins define skills, reusable activities and workflow templates. Any
 * authenticated household member can launch enabled Quick Add workflows; the
 * server resolves proficiency and round-robin assignment at creation time.
 */

import express from 'express';
import * as db from '../db.js';
import { requireAdmin } from '../auth.js';
import {
  PROFICIENCY,
  ASSIGNMENT_STRATEGIES,
  householdMembers,
  effectiveSkillProficiency,
} from '../services/activity-eligibility.js';
import {
  getActivityTemplate,
  listActivityTemplates,
  getWorkflowTemplate,
  listWorkflowTemplates,
  previewWorkflow,
  instantiateWorkflow,
} from '../services/activity-workflows.js';
import { createLogger } from '../logger.js';
import {
  claimTask,
  obligationInbox,
  overrideTaskAssignment,
  respondToTaskObligation,
} from '../services/assignment-responsibilities.js';

const router = express.Router();
const log = createLogger('Automation');

const VALID_PROFICIENCY = new Set(Object.values(PROFICIENCY));
const VALID_AGE_PROMOTION = new Set([PROFICIENCY.SUPERVISED, PROFICIENCY.NORMAL]);
const VALID_ASSIGNMENT = new Set(ASSIGNMENT_STRATEGIES);
const VALID_WORKFLOW_INPUT_TYPES = new Set([
  'household_member', 'location', 'boolean', 'choice', 'select', 'text', 'number', 'date', 'time',
]);
const VALID_LOCATION_MODES = new Set(['none', 'fixed', 'workflow']);
const VALID_STEP_LOCATION_MODES = new Set(['inherit', 'none', 'fixed', 'workflow']);
const VALID_PRESENCE_POLICIES = new Set(['ignore', 'must_be_home', 'must_be_at_location', 'must_be_away', 'available_before_due']);
const VALID_PRESENCE_WINDOWS = new Set(['start', 'due', 'completion']);
const SYSTEM_CONTEXT_VARIABLES = Object.freeze([
  { key: 'context.current_date', label: 'Current date', type: 'date', description: 'The date when the template runs.' },
  { key: 'context.day_of_week', label: 'Day of week', type: 'text', description: 'The local weekday when the template runs.' },
  { key: 'context.current_time', label: 'Current time', type: 'time', description: 'The local time when the template runs.' },
  { key: 'context.household_member', label: 'Selected household member', type: 'household_member', description: 'The person selected for the current activity or workflow.' },
]);

function text(value, { required = false, max = 200 } = {}) {
  const out = value == null ? '' : String(value).trim();
  if (required && !out) throw new Error('A required text field is empty.');
  if (out.length > max) throw new Error(`Text is limited to ${max} characters.`);
  return out || null;
}

function intOrNull(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
  return n;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback ? 1 : 0;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function currentUserId(req) {
  return Number(req.authUserId || req.session?.userId);
}

function skillRowsWithMembers(d) {
  const members = householdMembers(d);
  return d.prepare('SELECT * FROM skills ORDER BY name COLLATE NOCASE, id').all().map((skill) => ({
    ...skill,
    members: members.map((member) => ({
      ...member,
      ...effectiveSkillProficiency(d, skill, member),
      manual: d.prepare(`
        SELECT proficiency, source, updated_at
          FROM user_skill_proficiency
         WHERE user_id = ? AND skill_id = ?
      `).get(member.id, skill.id) ?? null,
    })),
  }));
}

function normalizeSkillInput(body, existing = null) {
  const name = text(body.name ?? existing?.name, { required: true, max: 120 });
  const description = text(body.description ?? existing?.description, { max: 1000 });
  const minimumAge = intOrNull(body.minimum_age ?? existing?.minimum_age, { min: 0, max: 120 });
  const agePromotion = body.age_promotion ?? existing?.age_promotion ?? PROFICIENCY.SUPERVISED;
  if (!VALID_AGE_PROMOTION.has(agePromotion)) throw new Error('age_promotion must be supervised or normal.');
  return {
    name,
    description,
    minimumAge,
    agePromotion,
    adultOnly: bool(body.adult_only, !!existing?.adult_only),
    active: existing?.system_key ? 1 : bool(body.active, existing ? !!existing.active : true),
  };
}

function validHouseholdUser(d, id) {
  if (!id) return false;
  return !!d.prepare(`
    SELECT 1 FROM users u
     WHERE u.id = ?
       AND NOT EXISTS (SELECT 1 FROM split_expense_guest_users g WHERE g.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
  `).get(id);
}

function validPlace(d, id, { activeOnly = false } = {}) {
  if (!id) return false;
  return !!d.prepare(`SELECT 1 FROM places WHERE id = ?${activeOnly ? ' AND active = 1' : ''}`).get(id);
}

function normalizeActivityInput(d, body, existing = null) {
  const name = text(body.name ?? existing?.name, { required: true, max: 120 });
  const titleTemplate = text(body.title_template ?? existing?.title_template ?? name, { required: true, max: 200 });
  const description = text(body.description ?? existing?.description, { max: 2000 });
  const category = text(body.category ?? existing?.category ?? 'misc', { required: true, max: 80 });
  const categoryExists = d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(category);
  if (!categoryExists) throw new Error('Unknown task category.');

  const assignmentStrategy = body.assignment_strategy ?? existing?.assignment_policy ?? existing?.assignment_strategy ?? 'subject_skill';
  if (!VALID_ASSIGNMENT.has(assignmentStrategy)) throw new Error('Unknown assignment strategy.');
  const subjectRequired = assignmentStrategy === 'subject_skill'
    ? 1
    : bool(body.subject_required, !!existing?.subject_required);
  const fixedUserId = intOrNull(body.fixed_user_id ?? existing?.fixed_user_id, { min: 1 });
  if (assignmentStrategy === 'fixed' && !validHouseholdUser(d, fixedUserId)) {
    throw new Error('Choose a valid fixed household member.');
  }
  const skillIds = Array.isArray(body.skill_ids)
    ? [...new Set(body.skill_ids.map(Number).filter(Number.isInteger))]
    : (existing?.skills ?? []).map((skill) => Number(skill.id));
  if (skillIds.length) {
    const placeholders = skillIds.map(() => '?').join(',');
    const found = d.prepare(`SELECT COUNT(*) AS n FROM skills WHERE id IN (${placeholders})`).get(...skillIds)?.n ?? 0;
    if (found !== skillIds.length) throw new Error('One or more required skills do not exist.');
  }

  const locationMode = body.location_mode ?? existing?.location_mode ?? 'none';
  if (!VALID_LOCATION_MODES.has(locationMode)) throw new Error('Unknown activity location mode.');
  const placeId = intOrNull(body.place_id ?? existing?.place_id, { min: 1 });
  if (locationMode === 'fixed' && (!validPlace(d, placeId)
      || (!validPlace(d, placeId, { activeOnly: true }) && Number(existing?.place_id) !== Number(placeId)))) {
    throw new Error('Choose an active fixed place.');
  }
  const locationVariableId = text(body.location_variable_id ?? existing?.location_variable_id, { max: 80 });
  if (locationMode === 'workflow' && !locationVariableId) throw new Error('Choose a Location workflow variable.');
  const presencePolicy = body.presence_policy ?? existing?.presence_policy ?? 'ignore';
  if (!VALID_PRESENCE_POLICIES.has(presencePolicy)) throw new Error('Unknown presence policy.');
  const presenceWindow = body.presence_window ?? existing?.presence_window ?? 'due';
  if (!VALID_PRESENCE_WINDOWS.has(presenceWindow)) throw new Error('Unknown presence evaluation window.');
  if (presencePolicy === 'must_be_at_location' && locationMode === 'none') {
    throw new Error('Must be at the activity location requires a fixed or workflow location.');
  }
  const rawChecklist = body.checklist ?? existing?.checklist ?? [];
  if (!Array.isArray(rawChecklist) || rawChecklist.length > 50) {
    throw new Error('An Activity Template checklist must contain at most 50 items.');
  }
  const checklist = rawChecklist.map((item, index) => ({
    titleTemplate: text(
      typeof item === 'string' ? item : item?.title_template,
      { required: true, max: 200 },
    ),
    sortOrder: index,
  }));

  return {
    name,
    titleTemplate,
    description,
    category,
    assignmentStrategy,
    legacyAssignmentStrategy: ['subject_skill', 'eligible_round_robin', 'fixed'].includes(assignmentStrategy)
      ? assignmentStrategy : 'eligible_round_robin',
    allowAssignmentOverride: bool(body.allow_assignment_override, existing ? !!existing.allow_assignment_override : true),
    participantCount: intOrNull(body.participant_count ?? existing?.participant_count ?? 1, { min: 1, max: 50 }),
    rotationGroup: text(body.rotation_group ?? existing?.rotation_group, { max: 100 }),
    subjectRequired,
    fixedUserId: assignmentStrategy === 'fixed' ? fixedUserId : null,
    supervisionTitleTemplate: text(
      body.supervision_title_template ?? existing?.supervision_title_template ?? 'Supervise {subject}: {activity}',
      { max: 200 },
    ),
    active: bool(body.active, existing ? !!existing.active : true),
    skillIds,
    locationMode,
    placeId: locationMode === 'fixed' ? placeId : null,
    locationVariableId: locationMode === 'workflow' ? locationVariableId : null,
    presencePolicy,
    presenceWindow,
    checklist,
  };
}

function saveActivitySkills(d, activityId, skillIds) {
  d.prepare('DELETE FROM activity_template_skills WHERE activity_template_id = ?').run(activityId);
  const insert = d.prepare(`
    INSERT INTO activity_template_skills (activity_template_id, skill_id, sort_order)
    VALUES (?, ?, ?)
  `);
  skillIds.forEach((skillId, index) => insert.run(activityId, skillId, index));
}

function normalizeWorkflowInputSchema(raw, existingQuestions = []) {
  if (!Array.isArray(raw)) throw new Error('input_schema must be an array.');
  const existingByDefinitionId = new Map(
    existingQuestions
      .filter((question) => Number.isInteger(Number(question?.definition_id)))
      .map((question) => [Number(question.definition_id), question]),
  );
  const existingByKey = new Map(
    existingQuestions.map((question) => [question?.id ?? question?.key, question]),
  );
  const questions = raw.map((question, index) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new Error(`Workflow question ${index + 1} must be an object.`);
    }
    const variableId = text(question.id ?? question.key, { required: true, max: 80 });
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(variableId)) {
      throw new Error(`Workflow question ${index + 1} has an invalid variable ID.`);
    }
    const label = text(question.label ?? variableId, { required: true, max: 200 });
    const requestedType = question.type ?? 'text';
    const type = requestedType === 'select' ? 'choice' : requestedType;
    if (!VALID_WORKFLOW_INPUT_TYPES.has(type)) {
      throw new Error(`Workflow question ${variableId} has an unsupported type.`);
    }
    const options = type === 'choice'
      ? [...new Set((Array.isArray(question.options) ? question.options : [])
          .map((value) => String(value).trim()).filter(Boolean))]
      : [];
    if (type === 'choice' && !options.length) {
      throw new Error(`Workflow question ${variableId} needs at least one choice.`);
    }
    const requestedDefinitionId = intOrNull(question.definition_id, { min: 1 });
    const existingDefinition = requestedDefinitionId
      ? existingByDefinitionId.get(requestedDefinitionId)
      : existingByKey.get(variableId);
    if (requestedDefinitionId && !existingDefinition) {
      throw new Error(`Workflow question ${variableId} has an invalid internal identity.`);
    }
    const existingKey = existingDefinition?.id ?? existingDefinition?.key;
    if (requestedDefinitionId && existingKey !== variableId) {
      throw new Error(`Workflow variable key "${existingKey}" cannot be changed during an ordinary edit.`);
    }
    const reusableDefinitionId = intOrNull(
      question.reusable_definition_id ?? existingDefinition?.reusable_definition_id,
      { min: 1 },
    );
    if (reusableDefinitionId) {
      const reusable = db.get().prepare('SELECT variable_key, type FROM household_variable_definitions WHERE id = ? AND active = 1').get(reusableDefinitionId);
      if (!reusable || reusable.variable_key !== variableId || reusable.type !== type) {
        throw new Error(`Reusable variable ${variableId} no longer matches its household definition.`);
      }
    }
    return {
      id: variableId,
      definition_id: existingDefinition ? Number(existingDefinition.definition_id) : null,
      reusable_definition_id: reusableDefinitionId,
      label,
      type,
      options,
      scope: 'workflow',
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error('Workflow variable IDs must be unique.');
  }
  return questions;
}

function normalizeWorkflowConditionValue(d, question, value) {
  if (question.type === 'boolean') {
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Condition for ${question.id} must be Yes or No.`);
  }
  const normalized = value == null ? '' : String(value);
  if (question.type === 'choice' && !question.options.includes(normalized)) {
    throw new Error(`Condition for ${question.id} must use one of its configured choices.`);
  }
  if (question.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Condition for ${question.id} must be a number.`);
    return number;
  }
  if (question.type === 'household_member') {
    const memberId = Number(value);
    if (!Number.isInteger(memberId) || memberId <= 0 || !validHouseholdUser(d, memberId)) {
      throw new Error(`Condition for ${question.id} must be a household member.`);
    }
    return memberId;
  }
  if (question.type === 'location') {
    const placeId = Number(value);
    if (!Number.isInteger(placeId) || placeId <= 0 || !validPlace(d, placeId)) {
      throw new Error(`Condition for ${question.id} must be a Place.`);
    }
    return placeId;
  }
  return normalized;
}

function saveActivityChecklist(d, activityId, checklist) {
  d.prepare('DELETE FROM activity_template_checklist_items WHERE activity_template_id = ?').run(activityId);
  const insert = d.prepare(`
    INSERT INTO activity_template_checklist_items (activity_template_id, title_template, sort_order)
    VALUES (?, ?, ?)
  `);
  checklist.forEach((item) => insert.run(activityId, item.titleTemplate, item.sortOrder));
}

function normalizeWorkflowCondition(d, condition, questionsByKey, stepKey) {
  if (condition == null) return null;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new Error(`Workflow step ${stepKey} has an invalid condition.`);
  }
  const variableId = text(condition.variable_id ?? condition.input, { required: true, max: 80 });
  const question = questionsByKey.get(variableId);
  if (!question) {
    throw new Error(`Workflow step ${stepKey} references unknown variable "${variableId}".`);
  }
  const hasEquals = Object.hasOwn(condition, 'equals');
  const hasIn = Array.isArray(condition.in);
  if ((hasEquals ? 1 : 0) + (hasIn ? 1 : 0) !== 1) {
    throw new Error(`Workflow step ${stepKey} condition must use exactly one comparison.`);
  }
  if (hasEquals) {
    return { variable_id: variableId, equals: normalizeWorkflowConditionValue(d, question, condition.equals) };
  }
  if (!condition.in.length) {
    throw new Error(`Workflow step ${stepKey} condition cannot have an empty choice list.`);
  }
  return {
    variable_id: variableId,
    in: [...new Set(condition.in.map((value) => normalizeWorkflowConditionValue(d, question, value)))],
  };
}

function validateVariableTemplate(value, questionsById, field) {
  if (!value) return;
  for (const match of String(value).matchAll(/\{\{([A-Za-z][A-Za-z0-9_-]*)(?:\.([A-Za-z][A-Za-z0-9_-]*))?\}\}/g)) {
    const question = questionsById.get(match[1]);
    if (!question) {
      throw new Error(`${field} references unknown variable "${match[1]}".`);
    }
    if (match[2] && (question.type !== 'location' || !['name', 'id', 'parent', 'address'].includes(match[2]))) {
      throw new Error(`${field} references unsupported property "${match[1]}.${match[2]}".`);
    }
  }
}

function normalizeWorkflowInput(d, body, existing = null) {
  const name = text(body.name ?? existing?.name, { required: true, max: 120 });
  const description = text(body.description ?? existing?.description, { max: 2000 });
  const category = text(body.category ?? existing?.category ?? 'misc', { required: true, max: 80 });
  const rawInputSchema = body.input_schema !== undefined
    ? body.input_schema
    : (existing?.input_schema ?? []);
  const inputSchema = normalizeWorkflowInputSchema(rawInputSchema, existing?.input_schema ?? []);
  const questionsByKey = new Map(inputSchema.map((question) => [question.id, question]));
  validateVariableTemplate(name, questionsByKey, 'Workflow name');
  validateVariableTemplate(description, questionsByKey, 'Workflow description');
  const steps = Array.isArray(body.steps)
    ? body.steps
    : (existing?.steps ?? []);
  if (!steps.length) throw new Error('A workflow needs at least one activity step.');

  const normalizedSteps = steps.map((step, index) => {
    const existingStep = existing?.steps?.find((candidate) => candidate.step_key === (step.step_key || step.key))
      ?? existing?.steps?.[index]
      ?? null;
    const activityTemplateId = intOrNull(step.activity_template_id, { min: 1 });
    if (!activityTemplateId) throw new Error(`Step ${index + 1} needs an activity template.`);
    const stepKey = text(step.step_key || step.key || `step_${index + 1}`, { required: true, max: 80 })
      .replace(/[^a-zA-Z0-9_-]+/g, '_');
    const subjectVariableId = text(step.subject_variable_id, { max: 80 });
    if (subjectVariableId) {
      const subjectQuestion = questionsByKey.get(subjectVariableId);
      if (!subjectQuestion) throw new Error(`Workflow step ${stepKey} references unknown subject variable "${subjectVariableId}".`);
      if (subjectQuestion.type !== 'household_member') {
        throw new Error(`Workflow step ${stepKey} subject must use a Household Member variable.`);
      }
    }
    const locationMode = step.location_mode ?? 'inherit';
    if (!VALID_STEP_LOCATION_MODES.has(locationMode)) throw new Error(`Workflow step ${stepKey} has an invalid location mode.`);
    const placeId = intOrNull(step.place_id, { min: 1 });
    if (locationMode === 'fixed' && (!validPlace(d, placeId)
        || (!validPlace(d, placeId, { activeOnly: true }) && Number(existingStep?.place_id) !== Number(placeId)))) {
      throw new Error(`Workflow step ${stepKey} needs an active fixed Place.`);
    }
    const locationVariableId = text(step.location_variable_id, { max: 80 });
    if (locationMode === 'workflow') {
      const locationQuestion = questionsByKey.get(locationVariableId);
      if (!locationQuestion || locationQuestion.type !== 'location') {
        throw new Error(`Workflow step ${stepKey} location must use a Location variable.`);
      }
    }
    const presencePolicyOverride = text(step.presence_policy_override, { max: 40 });
    if (presencePolicyOverride && !VALID_PRESENCE_POLICIES.has(presencePolicyOverride)) {
      throw new Error(`Workflow step ${stepKey} has an invalid presence policy.`);
    }
    const assignmentPolicyOverride = text(step.assignment_policy_override, { max: 40 });
    if (assignmentPolicyOverride && !VALID_ASSIGNMENT.has(assignmentPolicyOverride)) {
      throw new Error(`Workflow step ${stepKey} has an invalid assignment policy.`);
    }
    const assignmentUserId = intOrNull(step.assignment_user_id, { min: 1 });
    if (assignmentPolicyOverride === 'fixed' && assignmentUserId && !validHouseholdUser(d, assignmentUserId)) {
      throw new Error(`Workflow step ${stepKey} has an invalid fixed assignee.`);
    }
    const assignmentVariableId = text(step.assignment_variable_id, { max: 80 });
    if (assignmentVariableId && questionsByKey.get(assignmentVariableId)?.type !== 'household_member') {
      throw new Error(`Workflow step ${stepKey} assignment must use a Household Member variable.`);
    }
    const assignmentPolicyVariableId = text(step.assignment_policy_variable_id, { max: 80 });
    if (assignmentPolicyVariableId && !questionsByKey.has(assignmentPolicyVariableId)) {
      throw new Error(`Workflow step ${stepKey} references an unknown assignment-policy variable.`);
    }
    const titleOverride = text(step.title_override, { max: 200 });
    const descriptionOverride = text(step.description_override, { max: 2000 });
    validateVariableTemplate(titleOverride, questionsByKey, `Workflow step ${stepKey} title`);
    validateVariableTemplate(descriptionOverride, questionsByKey, `Workflow step ${stepKey} description`);
    return {
      stepKey,
      activityTemplateId,
      titleOverride,
      descriptionOverride,
      subjectVariableId,
      locationMode,
      placeId: locationMode === 'fixed' ? placeId : null,
      locationVariableId: locationMode === 'workflow' ? locationVariableId : null,
      presencePolicyOverride,
      assignmentPolicyOverride,
      assignmentUserId,
      assignmentVariableId,
      assignmentPolicyVariableId,
      condition: step.condition && typeof step.condition === 'object' ? step.condition : null,
      dependsOn: Array.isArray(step.depends_on)
        ? [...new Set(step.depends_on.map(String).filter(Boolean))]
        : [],
    };
  });
  if (new Set(normalizedSteps.map((step) => step.stepKey)).size !== normalizedSteps.length) {
    throw new Error('Workflow step keys must be unique.');
  }
  for (const step of normalizedSteps) {
    const activity = d.prepare(`
      SELECT name, title_template, description, supervision_title_template,
             location_mode, location_variable_id, place_id, presence_policy
        FROM activity_templates
       WHERE id = ?
    `).get(step.activityTemplateId);
    if (!activity) throw new Error('A workflow step references an unknown activity template.');
    validateVariableTemplate(activity.title_template, questionsByKey, `Activity ${activity.name} title`);
    validateVariableTemplate(activity.description, questionsByKey, `Activity ${activity.name} description`);
    validateVariableTemplate(
      activity.supervision_title_template,
      questionsByKey,
      `Activity ${activity.name} supervision title`,
    );
    const effectiveLocationMode = step.locationMode === 'inherit' ? activity.location_mode : step.locationMode;
    const effectiveVariableId = step.locationMode === 'inherit' ? activity.location_variable_id : step.locationVariableId;
    if (effectiveLocationMode === 'workflow') {
      const locationQuestion = questionsByKey.get(effectiveVariableId);
      if (!locationQuestion || locationQuestion.type !== 'location') {
        throw new Error(`Activity ${activity.name} requires the Location variable "${effectiveVariableId || ''}".`);
      }
    }
    const effectivePolicy = step.presencePolicyOverride || activity.presence_policy || 'ignore';
    if (effectivePolicy === 'must_be_at_location' && effectiveLocationMode === 'none') {
      throw new Error(`Workflow step ${step.stepKey} requires an activity location for its presence policy.`);
    }
  }
  const keys = new Set(normalizedSteps.map((step) => step.stepKey));
  const positions = new Map(normalizedSteps.map((step, index) => [step.stepKey, index]));
  for (const step of normalizedSteps) {
    step.condition = normalizeWorkflowCondition(d, step.condition, questionsByKey, step.stepKey);
  }
  for (const [index, step] of normalizedSteps.entries()) {
    if (step.dependsOn.some((key) => !keys.has(key) || key === step.stepKey)) {
      throw new Error(`Invalid dependency on workflow step ${step.stepKey}.`);
    }
    if (step.dependsOn.some((key) => positions.get(key) >= index)) {
      throw new Error(`Workflow step ${step.stepKey} may only depend on an earlier step.`);
    }
  }

  return {
    name,
    description,
    category,
    quickAddEnabled: bool(body.quick_add_enabled, existing ? !!existing.quick_add_enabled : true),
    subjectRequired: bool(body.subject_required, existing ? !!existing.subject_required : true),
    active: bool(body.active, existing ? !!existing.active : true),
    inputSchema,
    steps: normalizedSteps,
  };
}

function variableKey(value) {
  const key = text(value, { required: true, max: 80 });
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error('Variable key must start with a letter and use lowercase letters, numbers, and underscores.');
  }
  return key;
}

function availableHouseholdVariableKey(d, label) {
  const normalized = String(label || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 72).replace(/_+$/g, '');
  const base = /^[a-z]/.test(normalized) ? normalized : `value_${normalized || 'variable'}`;
  let candidate = base;
  let suffix = 2;
  const exists = d.prepare('SELECT 1 FROM household_variable_definitions WHERE variable_key = ? COLLATE NOCASE');
  while (exists.get(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function normalizeHouseholdVariable(body, existing = null) {
  const key = variableKey(body.variable_key ?? existing?.variable_key);
  const label = text(body.label ?? existing?.label, { required: true, max: 200 });
  const description = text(body.description ?? existing?.description, { max: 1000 });
  const requestedType = body.type ?? existing?.type ?? 'text';
  const type = requestedType === 'select' ? 'choice' : requestedType;
  if (!VALID_WORKFLOW_INPUT_TYPES.has(type)) throw new Error('Unsupported variable type.');
  const kind = body.kind ?? existing?.kind ?? 'field';
  if (!['value', 'field'].includes(kind)) throw new Error('Variable kind must be value or field.');
  const options = type === 'choice'
    ? [...new Set((Array.isArray(body.options) ? body.options : parseJsonSafe(existing?.options_json, []))
      .map((option) => String(option).trim()).filter(Boolean))]
    : [];
  if (type === 'choice' && !options.length) throw new Error('Choice variables need at least one option.');
  const defaultValue = body.default_value !== undefined
    ? body.default_value
    : parseJsonSafe(existing?.default_value_json, null);
  return { key, label, description, type, kind, options, defaultValue, active: bool(body.active, existing ? !!existing.active : true) };
}

function parseJsonSafe(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fallback; }
}

function householdVariableRows(d) {
  return d.prepare(`
    SELECT hv.*,
           (SELECT COUNT(*) FROM workflow_variable_definitions wv WHERE wv.reusable_definition_id = hv.id) AS usage_count
      FROM household_variable_definitions hv
     ORDER BY hv.active DESC, hv.label COLLATE NOCASE, hv.id
  `).all().map((row) => ({
    ...row,
    options: parseJsonSafe(row.options_json, []),
    default_value: parseJsonSafe(row.default_value_json, null),
    options_json: undefined,
    default_value_json: undefined,
  }));
}

function syncWorkflowVariableDefinitions(d, workflowId, questions) {
  const existing = d.prepare(`
    SELECT id, variable_key, reusable_definition_id
      FROM workflow_variable_definitions
     WHERE workflow_template_id = ?
  `).all(workflowId);
  const existingById = new Map(existing.map((row) => [Number(row.id), row]));
  const existingByKey = new Map(existing.map((row) => [row.variable_key, row]));
  const insert = d.prepare(`
    INSERT INTO workflow_variable_definitions (
      workflow_template_id, variable_key, label, type, options_json, scope, reusable_definition_id
    ) VALUES (?, ?, ?, ?, ?, 'workflow', ?)
  `);
  const update = d.prepare(`
    UPDATE workflow_variable_definitions
       SET label = ?, type = ?, options_json = ?, reusable_definition_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE id = ? AND workflow_template_id = ?
  `);
  const keptIds = [];
  const savedQuestions = questions.map((question) => {
    const requestedId = Number(question.definition_id);
    const stored = Number.isInteger(requestedId) && requestedId > 0
      ? existingById.get(requestedId)
      : existingByKey.get(question.id);
    let definitionId;
    if (stored) {
      if (stored.variable_key !== question.id) {
        throw new Error(`Workflow variable key "${stored.variable_key}" requires the dedicated Rename key action.`);
      }
      update.run(
        question.label,
        question.type,
        JSON.stringify(question.options ?? []),
        question.reusable_definition_id || stored.reusable_definition_id || null,
        stored.id,
        workflowId,
      );
      definitionId = Number(stored.id);
    } else {
      definitionId = Number(insert.run(
        workflowId,
        question.id,
        question.label,
        question.type,
        JSON.stringify(question.options ?? []),
        question.reusable_definition_id || null,
      ).lastInsertRowid);
    }
    keptIds.push(definitionId);
    return { ...question, definition_id: definitionId, scope: 'workflow' };
  });

  if (keptIds.length) {
    const placeholders = keptIds.map(() => '?').join(',');
    d.prepare(`
      DELETE FROM workflow_variable_definitions
       WHERE workflow_template_id = ? AND id NOT IN (${placeholders})
    `).run(workflowId, ...keptIds);
  } else {
    d.prepare('DELETE FROM workflow_variable_definitions WHERE workflow_template_id = ?').run(workflowId);
  }
  return savedQuestions;
}

function replaceWorkflowSteps(d, workflowId, steps) {
  d.prepare('DELETE FROM workflow_template_steps WHERE workflow_template_id = ?').run(workflowId);
  const insert = d.prepare(`
      INSERT INTO workflow_template_steps (
        workflow_template_id, activity_template_id, step_key, sort_order,
        title_override, description_override, subject_variable_id, condition_json,
        location_mode, place_id, location_variable_id, presence_policy_override
        , assignment_policy_override, assignment_user_id, assignment_variable_id,
        assignment_policy_variable_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = new Map();
  steps.forEach((step, index) => {
    const result = insert.run(
      workflowId,
      step.activityTemplateId,
      step.stepKey,
      index,
      step.titleOverride,
      step.descriptionOverride,
      step.subjectVariableId,
      step.condition ? JSON.stringify(step.condition) : null,
      step.locationMode,
      step.placeId,
      step.locationVariableId,
      step.presencePolicyOverride,
      step.assignmentPolicyOverride,
      step.assignmentUserId,
      step.assignmentVariableId,
      step.assignmentPolicyVariableId,
    );
    ids.set(step.stepKey, Number(result.lastInsertRowid));
  });
  const depInsert = d.prepare(`
    INSERT INTO workflow_step_dependencies (step_id, depends_on_step_id)
    VALUES (?, ?)
  `);
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      depInsert.run(ids.get(step.stepKey), ids.get(dependency));
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime endpoints
// ---------------------------------------------------------------------------

router.get('/obligations', (req, res) => {
  try {
    res.json({ data: obligationInbox(db.get(), currentUserId(req)) });
  } catch (err) {
    log.error('GET /obligations:', err);
    res.status(500).json({ error: 'Could not load assignment requests.', code: 500 });
  }
});

router.get('/admin/obligations', requireAdmin, (req, res) => {
  try {
    res.json({ data: obligationInbox(db.get(), currentUserId(req), { includeAll: true }) });
  } catch (err) {
    res.status(500).json({ error: 'Could not load household assignment requests.', code: 500 });
  }
});

router.post('/tasks/:id/claim', (req, res) => {
  try {
    res.json({ data: claimTask(db.get(), Number(req.params.id), currentUserId(req)) });
  } catch (err) {
    res.status(409).json({ error: err.message, code: 409 });
  }
});

router.put('/tasks/:id/assignment', requireAdmin, (req, res) => {
  try {
    const userId = intOrNull(req.body.user_id, { min: 1 });
    if (!userId) throw new Error('Choose a household member.');
    res.json({ data: overrideTaskAssignment(db.get(), Number(req.params.id), userId, currentUserId(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.post('/obligations/:id/respond', (req, res) => {
  try {
    const action = String(req.body.action || '');
    if (!['accept', 'decline'].includes(action)) throw new Error('Choose accept or decline.');
    res.json({ data: respondToTaskObligation(
      db.get(), Number(req.params.id), action, currentUserId(req), text(req.body.note, { max: 500 }),
    ) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

// Minimal reusable Activity Template catalogue for ordinary Task scheduling.
// Assignment still resolves server-side; the client only chooses the reusable
// definition and, when required, its subject.
router.get('/activity-options', (_req, res) => {
  try {
    const activities = listActivityTemplates(db.get(), { activeOnly: true }).map((activity) => ({
      id: activity.id,
      name: activity.name,
      title_template: activity.title_template,
      description: activity.description,
      category: activity.category,
      assignment_strategy: activity.assignment_strategy,
      assignment_policy: activity.assignment_policy || activity.assignment_strategy,
      subject_required: activity.subject_required,
    }));
    res.json({ data: { activities } });
  } catch (err) {
    log.error('GET /activity-options:', err);
    res.status(500).json({ error: 'Could not load activity templates.', code: 500 });
  }
});

router.get('/quick-add', (req, res) => {
  try {
    const d = db.get();
    const templates = listWorkflowTemplates(d, { quickAddOnly: true, activeOnly: true }).map((template) => ({
      ...template,
      step_count: d.prepare('SELECT COUNT(*) AS n FROM workflow_template_steps WHERE workflow_template_id = ?').get(template.id).n,
    }));
    const activities = listActivityTemplates(d, { activeOnly: true }).map((activity) => ({
      id: activity.id,
      name: activity.name,
      title_template: activity.title_template,
      description: activity.description,
      category: activity.category,
      assignment_strategy: activity.assignment_strategy,
      subject_required: activity.subject_required,
    }));
    res.json({
      data: templates,
      activities,
      members: householdMembers(d),
      places: d.prepare('SELECT * FROM places WHERE active = 1 ORDER BY name COLLATE NOCASE, id').all(),
    });
  } catch (err) {
    log.error('GET /quick-add:', err);
    res.status(500).json({ error: 'Could not load Quick Add templates.', code: 500 });
  }
});

router.post('/quick-add/:id/preview', (req, res) => {
  try {
    const data = previewWorkflow(db.get(), Number(req.params.id), {
      subjectUserId: req.body.subject_user_id ?? null,
      inputs: req.body.inputs ?? {},
    });
    res.json({ data });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.post('/quick-add/:id/create', (req, res) => {
  try {
    const data = instantiateWorkflow(db.get(), Number(req.params.id), {
      subjectUserId: req.body.subject_user_id ?? null,
      inputs: req.body.inputs ?? {},
      createdBy: currentUserId(req),
    });
    res.status(201).json({ data });
  } catch (err) {
    log.warn('POST /quick-add/:id/create:', err.message);
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.get('/member-skills/:userId', (req, res) => {
  try {
    const d = db.get();
    const member = householdMembers(d).find((row) => Number(row.id) === Number(req.params.userId));
    if (!member) return res.status(404).json({ error: 'Household member not found.', code: 404 });
    const skills = d.prepare('SELECT * FROM skills WHERE active = 1 ORDER BY name COLLATE NOCASE').all()
      .map((skill) => ({ ...skill, ...effectiveSkillProficiency(d, skill, member) }));
    res.json({ data: { member, skills } });
  } catch (err) {
    res.status(500).json({ error: 'Could not load member skills.', code: 500 });
  }
});

// ---------------------------------------------------------------------------
// Admin definition endpoints
// ---------------------------------------------------------------------------

router.get('/admin/skills', requireAdmin, (req, res) => {
  try { res.json({ data: skillRowsWithMembers(db.get()) }); }
  catch (err) { res.status(500).json({ error: 'Could not load skills.', code: 500 }); }
});

router.post('/admin/skills', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const input = normalizeSkillInput(req.body);
    const result = d.prepare(`
      INSERT INTO skills (
        name, description, minimum_age, age_promotion, adult_only, active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.name, input.description, input.minimumAge, input.agePromotion, input.adultOnly, input.active, currentUserId(req));
    const skill = d.prepare('SELECT * FROM skills WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ data: skill });
  } catch (err) {
    const code = String(err.message).includes('UNIQUE') ? 409 : 400;
    res.status(code).json({ error: err.message, code });
  }
});

router.put('/admin/skills/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const existing = d.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Skill not found.', code: 404 });
    const input = normalizeSkillInput(req.body, existing);
    d.prepare(`
      UPDATE skills
         SET name = ?, description = ?, minimum_age = ?, age_promotion = ?,
             adult_only = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(input.name, input.description, input.minimumAge, input.agePromotion, input.adultOnly, input.active, existing.id);
    res.json({ data: d.prepare('SELECT * FROM skills WHERE id = ?').get(existing.id) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.delete('/admin/skills/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const skill = d.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found.', code: 404 });
    if (skill.system_key) {
      return res.status(409).json({ error: 'Built-in household skills cannot be deleted.', code: 409 });
    }
    const inUse = d.prepare('SELECT COUNT(*) AS n FROM activity_template_skills WHERE skill_id = ?').get(req.params.id)?.n ?? 0;
    if (inUse) return res.status(409).json({ error: 'This skill is required by an activity template.', code: 409 });
    const result = d.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete skill.', code: 500 });
  }
});

router.put('/admin/skills/:skillId/members/:userId', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const skill = d.prepare('SELECT * FROM skills WHERE id = ?').get(req.params.skillId);
    const member = householdMembers(d).find((row) => Number(row.id) === Number(req.params.userId));
    if (!skill || !member) return res.status(404).json({ error: 'Skill or household member not found.', code: 404 });
    const requested = req.body.proficiency;
    if (requested === null || requested === 'auto' || requested === '') {
      d.prepare('DELETE FROM user_skill_proficiency WHERE user_id = ? AND skill_id = ?')
        .run(member.id, skill.id);
    } else {
      if (!VALID_PROFICIENCY.has(requested)) return res.status(400).json({ error: 'Invalid proficiency.', code: 400 });
      d.prepare(`
        INSERT INTO user_skill_proficiency (
          user_id, skill_id, proficiency, source, updated_by, updated_at
        ) VALUES (?, ?, ?, 'manual', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        ON CONFLICT(user_id, skill_id)
        DO UPDATE SET proficiency = excluded.proficiency, source = 'manual',
                      updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(member.id, skill.id, requested, currentUserId(req));
    }
    res.json({ data: { member_id: member.id, skill_id: skill.id, ...effectiveSkillProficiency(d, skill, member) } });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.get('/admin/variables', requireAdmin, (req, res) => {
  try {
    res.json({ data: householdVariableRows(db.get()), context: SYSTEM_CONTEXT_VARIABLES });
  } catch (err) {
    res.status(500).json({ error: 'Could not load reusable variables.', code: 500 });
  }
});

router.post('/admin/variables', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const input = normalizeHouseholdVariable({
      ...req.body,
      variable_key: req.body.variable_key || availableHouseholdVariableKey(d, req.body.label),
    });
    const result = d.prepare(`
      INSERT INTO household_variable_definitions (
        variable_key, label, description, type, kind, options_json,
        default_value_json, active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.key, input.label, input.description, input.type, input.kind,
      JSON.stringify(input.options), input.defaultValue == null ? null : JSON.stringify(input.defaultValue),
      input.active, currentUserId(req),
    );
    res.status(201).json({ data: householdVariableRows(d).find((row) => Number(row.id) === Number(result.lastInsertRowid)) });
  } catch (err) {
    const duplicate = /UNIQUE constraint failed/i.test(err.message);
    res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'That variable key is already in use.' : err.message, code: duplicate ? 409 : 400 });
  }
});

router.put('/admin/variables/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const existing = d.prepare('SELECT * FROM household_variable_definitions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Reusable variable not found.', code: 404 });
    const input = normalizeHouseholdVariable({ ...req.body, variable_key: existing.variable_key }, existing);
    d.prepare(`
      UPDATE household_variable_definitions
         SET label = ?, description = ?, type = ?, kind = ?, options_json = ?,
             default_value_json = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?
    `).run(
      input.label, input.description, input.type, input.kind, JSON.stringify(input.options),
      input.defaultValue == null ? null : JSON.stringify(input.defaultValue), input.active, existing.id,
    );
    res.json({ data: householdVariableRows(d).find((row) => Number(row.id) === Number(existing.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.put('/admin/variables/:id/key', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const existing = d.prepare('SELECT * FROM household_variable_definitions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Reusable variable not found.', code: 404 });
    const nextKey = variableKey(req.body.variable_key);
    d.transaction(() => {
      const linked = d.prepare(`
        SELECT id, workflow_template_id, variable_key
          FROM workflow_variable_definitions
         WHERE reusable_definition_id = ?
      `).all(existing.id);
      const replaceToken = (value) => value == null ? value : String(value).replaceAll(`{{${existing.variable_key}}}`, `{{${nextKey}}}`);
      for (const definition of linked) {
        const collision = d.prepare(`
          SELECT 1 FROM workflow_variable_definitions
           WHERE workflow_template_id = ? AND variable_key = ? COLLATE NOCASE AND id != ?
        `).get(definition.workflow_template_id, nextKey, definition.id);
        if (collision) throw new Error(`Workflow ${definition.workflow_template_id} already uses the variable ID ${nextKey}.`);
        const workflow = d.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(definition.workflow_template_id);
        const schema = parseJsonSafe(workflow.input_schema_json, []).map((question) => {
          const questionDefinitionId = Number(question.definition_id);
          const questionKey = question.id ?? question.key;
          if (questionDefinitionId === Number(definition.id) || questionKey === existing.variable_key) {
            return { ...question, id: nextKey, key: undefined };
          }
          return question;
        });
        d.prepare(`
          UPDATE workflow_templates
             SET name = ?, description = ?, input_schema_json = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
           WHERE id = ?
        `).run(replaceToken(workflow.name), replaceToken(workflow.description), JSON.stringify(schema), workflow.id);
        const steps = d.prepare('SELECT * FROM workflow_template_steps WHERE workflow_template_id = ?').all(workflow.id);
        for (const step of steps) {
          const condition = parseJsonSafe(step.condition_json, null);
          if (condition?.variable_id === existing.variable_key) condition.variable_id = nextKey;
          if (condition?.input === existing.variable_key) condition.input = nextKey;
          d.prepare(`
            UPDATE workflow_template_steps
               SET title_override = ?, description_override = ?, subject_variable_id = ?, condition_json = ?
             WHERE id = ?
          `).run(
            replaceToken(step.title_override), replaceToken(step.description_override),
            step.subject_variable_id === existing.variable_key ? nextKey : step.subject_variable_id,
            condition ? JSON.stringify(condition) : null, step.id,
          );
        }
        d.prepare('UPDATE workflow_variable_definitions SET variable_key = ? WHERE id = ?').run(nextKey, definition.id);
      }
      d.prepare(`
        UPDATE household_variable_definitions
           SET variable_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(nextKey, existing.id);
    })();
    res.json({ data: householdVariableRows(d).find((row) => Number(row.id) === Number(existing.id)) });
  } catch (err) {
    const duplicate = /UNIQUE constraint failed/i.test(err.message);
    res.status(duplicate ? 409 : 400).json({ error: duplicate ? 'That variable key is already in use.' : err.message, code: duplicate ? 409 : 400 });
  }
});

router.delete('/admin/variables/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const usage = d.prepare('SELECT COUNT(*) AS n FROM workflow_variable_definitions WHERE reusable_definition_id = ?').get(req.params.id)?.n ?? 0;
    if (usage) return res.status(409).json({ error: `This reusable variable is used by ${usage} workflow variable${usage === 1 ? '' : 's'}.`, code: 409 });
    const result = d.prepare('DELETE FROM household_variable_definitions WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Reusable variable not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete reusable variable.', code: 500 });
  }
});

router.post('/admin/workflow-templates/:workflowId/variables/:definitionId/promote', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const local = d.prepare(`
      SELECT * FROM workflow_variable_definitions
       WHERE id = ? AND workflow_template_id = ?
    `).get(req.params.definitionId, req.params.workflowId);
    if (!local) return res.status(404).json({ error: 'Workflow variable not found.', code: 404 });
    const promotedId = d.transaction(() => {
      let reusable = d.prepare('SELECT id, type FROM household_variable_definitions WHERE variable_key = ? COLLATE NOCASE').get(local.variable_key);
      if (reusable && reusable.type !== local.type) throw new Error('A reusable variable with this key has a different type.');
      if (!reusable) {
        const result = d.prepare(`
          INSERT INTO household_variable_definitions (
            variable_key, label, type, kind, options_json, created_by
          ) VALUES (?, ?, ?, 'field', ?, ?)
        `).run(local.variable_key, local.label, local.type, local.options_json, currentUserId(req));
        reusable = { id: Number(result.lastInsertRowid) };
      }
      d.prepare('UPDATE workflow_variable_definitions SET reusable_definition_id = ? WHERE id = ?')
        .run(reusable.id, local.id);
      return Number(reusable.id);
    })();
    res.json({ data: { reusable_definition_id: promotedId } });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.get('/admin/activity-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    res.json({
      data: listActivityTemplates(d),
      skills: d.prepare('SELECT * FROM skills WHERE active = 1 ORDER BY name COLLATE NOCASE').all(),
      members: householdMembers(d),
      categories: d.prepare('SELECT key, name, label_key FROM task_categories ORDER BY sort_order, key').all(),
      variables: householdVariableRows(d).filter((variable) => variable.active),
      places: d.prepare('SELECT * FROM places ORDER BY active DESC, name COLLATE NOCASE, id').all(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load activity templates.', code: 500 });
  }
});

router.post('/admin/activity-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const input = normalizeActivityInput(d, req.body);
    const id = d.transaction(() => {
      const result = d.prepare(`
        INSERT INTO activity_templates (
          name, title_template, description, category, assignment_strategy,
          subject_required, fixed_user_id, supervision_title_template, active, created_by,
          location_mode, place_id, location_variable_id, presence_policy, presence_window,
          assignment_policy, allow_assignment_override, participant_count, rotation_group
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name, input.titleTemplate, input.description, input.category,
        input.legacyAssignmentStrategy, input.subjectRequired, input.fixedUserId,
        input.supervisionTitleTemplate, input.active, currentUserId(req),
        input.locationMode, input.placeId, input.locationVariableId,
        input.presencePolicy, input.presenceWindow, input.assignmentStrategy,
        input.allowAssignmentOverride, input.participantCount, input.rotationGroup,
      );
      saveActivitySkills(d, result.lastInsertRowid, input.skillIds);
      saveActivityChecklist(d, result.lastInsertRowid, input.checklist);
      return Number(result.lastInsertRowid);
    })();
    res.status(201).json({ data: getActivityTemplate(d, id) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.put('/admin/activity-templates/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const existing = getActivityTemplate(d, Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Activity template not found.', code: 404 });
    const input = normalizeActivityInput(d, req.body, existing);
    d.transaction(() => {
      d.prepare(`
        UPDATE activity_templates
           SET name = ?, title_template = ?, description = ?, category = ?,
               assignment_strategy = ?, subject_required = ?, fixed_user_id = ?,
               supervision_title_template = ?, active = ?, location_mode = ?,
               place_id = ?, location_variable_id = ?, presence_policy = ?, presence_window = ?,
               assignment_policy = ?, allow_assignment_override = ?, participant_count = ?, rotation_group = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(
        input.name, input.titleTemplate, input.description, input.category,
        input.legacyAssignmentStrategy, input.subjectRequired, input.fixedUserId,
        input.supervisionTitleTemplate, input.active, input.locationMode,
        input.placeId, input.locationVariableId, input.presencePolicy,
        input.presenceWindow, input.assignmentStrategy, input.allowAssignmentOverride,
        input.participantCount, input.rotationGroup, existing.id,
      );
      saveActivitySkills(d, existing.id, input.skillIds);
      saveActivityChecklist(d, existing.id, input.checklist);
    })();
    res.json({ data: getActivityTemplate(d, existing.id) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.delete('/admin/activity-templates/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const workflowUse = d.prepare('SELECT COUNT(*) AS n FROM workflow_template_steps WHERE activity_template_id = ?').get(req.params.id)?.n ?? 0;
    if (workflowUse) return res.status(409).json({ error: 'This activity is used by a workflow template.', code: 409 });
    const taskUse = d.prepare('SELECT COUNT(*) AS n FROM task_activity_bindings WHERE activity_template_id = ?').get(req.params.id)?.n ?? 0;
    if (taskUse) return res.status(409).json({ error: 'This activity is attached to a scheduled task.', code: 409 });
    const result = d.prepare('DELETE FROM activity_templates WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Activity template not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete activity template.', code: 500 });
  }
});

router.get('/admin/workflow-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const workflows = listWorkflowTemplates(d).map((row) => getWorkflowTemplate(d, row.id));
    res.json({
      data: workflows,
      activities: listActivityTemplates(d, { activeOnly: true }),
      members: householdMembers(d),
      categories: d.prepare('SELECT key, name, label_key FROM task_categories ORDER BY sort_order, key').all(),
      variables: householdVariableRows(d).filter((variable) => variable.active),
      places: d.prepare('SELECT * FROM places ORDER BY active DESC, name COLLATE NOCASE, id').all(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load workflow templates.', code: 500 });
  }
});

router.post('/admin/workflow-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const input = normalizeWorkflowInput(d, req.body);
    if (!d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(input.category)) throw new Error('Unknown task category.');
    for (const step of input.steps) {
      if (!d.prepare('SELECT 1 FROM activity_templates WHERE id = ?').get(step.activityTemplateId)) {
        throw new Error('A workflow step references an unknown activity template.');
      }
    }
    const id = d.transaction(() => {
      const result = d.prepare(`
        INSERT INTO workflow_templates (
          name, description, category, quick_add_enabled, subject_required,
          input_schema_json, active, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name, input.description, input.category, input.quickAddEnabled,
        input.subjectRequired, JSON.stringify(input.inputSchema), input.active,
        currentUserId(req),
      );
      const savedInputSchema = syncWorkflowVariableDefinitions(d, Number(result.lastInsertRowid), input.inputSchema);
      d.prepare('UPDATE workflow_templates SET input_schema_json = ? WHERE id = ?')
        .run(JSON.stringify(savedInputSchema), result.lastInsertRowid);
      replaceWorkflowSteps(d, result.lastInsertRowid, input.steps);
      return Number(result.lastInsertRowid);
    })();
    res.status(201).json({ data: getWorkflowTemplate(d, id) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.put('/admin/workflow-templates/:id', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const existing = getWorkflowTemplate(d, Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Workflow template not found.', code: 404 });
    const input = normalizeWorkflowInput(d, req.body, existing);
    if (!d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(input.category)) throw new Error('Unknown task category.');
    d.transaction(() => {
      const savedInputSchema = syncWorkflowVariableDefinitions(d, existing.id, input.inputSchema);
      d.prepare(`
        UPDATE workflow_templates
           SET name = ?, description = ?, category = ?, quick_add_enabled = ?,
               subject_required = ?, input_schema_json = ?, active = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(
        input.name, input.description, input.category, input.quickAddEnabled,
        input.subjectRequired, JSON.stringify(savedInputSchema), input.active,
        existing.id,
      );
      replaceWorkflowSteps(d, existing.id, input.steps);
    })();
    res.json({ data: getWorkflowTemplate(d, existing.id) });
  } catch (err) {
    res.status(400).json({ error: err.message, code: 400 });
  }
});

router.delete('/admin/workflow-templates/:id', requireAdmin, (req, res) => {
  try {
    const result = db.get().prepare('DELETE FROM workflow_templates WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Workflow template not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'Could not delete workflow template.', code: 500 });
  }
});

export default router;
