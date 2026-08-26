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

const router = express.Router();
const log = createLogger('Automation');

const VALID_PROFICIENCY = new Set(Object.values(PROFICIENCY));
const VALID_AGE_PROMOTION = new Set([PROFICIENCY.SUPERVISED, PROFICIENCY.NORMAL]);
const VALID_ASSIGNMENT = new Set(ASSIGNMENT_STRATEGIES);

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
    active: bool(body.active, existing ? !!existing.active : true),
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

function normalizeActivityInput(d, body, existing = null) {
  const name = text(body.name ?? existing?.name, { required: true, max: 120 });
  const titleTemplate = text(body.title_template ?? existing?.title_template ?? name, { required: true, max: 200 });
  const description = text(body.description ?? existing?.description, { max: 2000 });
  const category = text(body.category ?? existing?.category ?? 'misc', { required: true, max: 80 });
  const categoryExists = d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(category);
  if (!categoryExists) throw new Error('Unknown task category.');

  const assignmentStrategy = body.assignment_strategy ?? existing?.assignment_strategy ?? 'subject_skill';
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

  return {
    name,
    titleTemplate,
    description,
    category,
    assignmentStrategy,
    subjectRequired,
    fixedUserId: assignmentStrategy === 'fixed' ? fixedUserId : null,
    supervisionTitleTemplate: text(
      body.supervision_title_template ?? existing?.supervision_title_template ?? 'Supervise {subject}: {activity}',
      { max: 200 },
    ),
    active: bool(body.active, existing ? !!existing.active : true),
    skillIds,
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

function normalizeWorkflowInput(body, existing = null) {
  const name = text(body.name ?? existing?.name, { required: true, max: 120 });
  const description = text(body.description ?? existing?.description, { max: 2000 });
  const category = text(body.category ?? existing?.category ?? 'misc', { required: true, max: 80 });
  const inputSchema = Array.isArray(body.input_schema)
    ? body.input_schema
    : (existing?.input_schema ?? []);
  const steps = Array.isArray(body.steps)
    ? body.steps
    : (existing?.steps ?? []);
  if (!steps.length) throw new Error('A workflow needs at least one activity step.');

  const normalizedSteps = steps.map((step, index) => {
    const activityTemplateId = intOrNull(step.activity_template_id, { min: 1 });
    if (!activityTemplateId) throw new Error(`Step ${index + 1} needs an activity template.`);
    const stepKey = text(step.step_key || step.key || `step_${index + 1}`, { required: true, max: 80 })
      .replace(/[^a-zA-Z0-9_-]+/g, '_');
    return {
      stepKey,
      activityTemplateId,
      titleOverride: text(step.title_override, { max: 200 }),
      condition: step.condition && typeof step.condition === 'object' ? step.condition : null,
      dependsOn: Array.isArray(step.depends_on)
        ? [...new Set(step.depends_on.map(String).filter(Boolean))]
        : [],
    };
  });
  if (new Set(normalizedSteps.map((step) => step.stepKey)).size !== normalizedSteps.length) {
    throw new Error('Workflow step keys must be unique.');
  }
  const keys = new Set(normalizedSteps.map((step) => step.stepKey));
  const positions = new Map(normalizedSteps.map((step, index) => [step.stepKey, index]));
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

function replaceWorkflowSteps(d, workflowId, steps) {
  d.prepare('DELETE FROM workflow_template_steps WHERE workflow_template_id = ?').run(workflowId);
  const insert = d.prepare(`
    INSERT INTO workflow_template_steps (
      workflow_template_id, activity_template_id, step_key, sort_order,
      title_override, condition_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const ids = new Map();
  steps.forEach((step, index) => {
    const result = insert.run(
      workflowId,
      step.activityTemplateId,
      step.stepKey,
      index,
      step.titleOverride,
      step.condition ? JSON.stringify(step.condition) : null,
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

// Minimal reusable Activity Template catalogue for ordinary Task scheduling.
// Assignment still resolves server-side; the client only chooses the reusable
// definition and, when required, its subject.
router.get('/activity-options', (_req, res) => {
  try {
    const activities = listActivityTemplates(db.get(), { activeOnly: true }).map((activity) => ({
      id: activity.id,
      name: activity.name,
      assignment_strategy: activity.assignment_strategy,
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
    res.json({ data: templates, members: householdMembers(d) });
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
    const inUse = d.prepare('SELECT COUNT(*) AS n FROM activity_template_skills WHERE skill_id = ?').get(req.params.id)?.n ?? 0;
    if (inUse) return res.status(409).json({ error: 'This skill is required by an activity template.', code: 409 });
    const result = d.prepare('DELETE FROM skills WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Skill not found.', code: 404 });
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

router.get('/admin/activity-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    res.json({
      data: listActivityTemplates(d),
      skills: d.prepare('SELECT * FROM skills WHERE active = 1 ORDER BY name COLLATE NOCASE').all(),
      members: householdMembers(d),
      categories: d.prepare('SELECT key, name, label_key FROM task_categories ORDER BY sort_order, key').all(),
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
          subject_required, fixed_user_id, supervision_title_template, active, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name, input.titleTemplate, input.description, input.category,
        input.assignmentStrategy, input.subjectRequired, input.fixedUserId,
        input.supervisionTitleTemplate, input.active, currentUserId(req),
      );
      saveActivitySkills(d, result.lastInsertRowid, input.skillIds);
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
               supervision_title_template = ?, active = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(
        input.name, input.titleTemplate, input.description, input.category,
        input.assignmentStrategy, input.subjectRequired, input.fixedUserId,
        input.supervisionTitleTemplate, input.active, existing.id,
      );
      saveActivitySkills(d, existing.id, input.skillIds);
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
      categories: d.prepare('SELECT key, name, label_key FROM task_categories ORDER BY sort_order, key').all(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load workflow templates.', code: 500 });
  }
});

router.post('/admin/workflow-templates', requireAdmin, (req, res) => {
  try {
    const d = db.get();
    const input = normalizeWorkflowInput(req.body);
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
    const input = normalizeWorkflowInput(req.body, existing);
    if (!d.prepare('SELECT 1 FROM task_categories WHERE key = ?').get(input.category)) throw new Error('Unknown task category.');
    d.transaction(() => {
      d.prepare(`
        UPDATE workflow_templates
           SET name = ?, description = ?, category = ?, quick_add_enabled = ?,
               subject_required = ?, input_schema_json = ?, active = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?
      `).run(
        input.name, input.description, input.category, input.quickAddEnabled,
        input.subjectRequired, JSON.stringify(input.inputSchema), input.active,
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
