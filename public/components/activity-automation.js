import { api } from '/api.js';
import { openModal, closeModal } from '/components/modal.js';
import { esc } from '/utils/html.js';

const h = (value) => esc(String(value ?? ''));

function toast(message, type = 'success') {
  window.yuvomi?.showToast?.(message, type);
}

function footer(primaryLabel = 'Save') {
  return `<div class="modal-panel__footer">
    <button type="button" class="btn btn--secondary" data-action="close-modal">Cancel</button>
    <button type="submit" class="btn btn--primary">${h(primaryLabel)}</button>
  </div>`;
}

function inputRow(label, control, hint = '') {
  return `<div class="form-group">
    <label class="label">${h(label)}</label>
    ${control}
    ${hint ? `<small class="form-hint">${h(hint)}</small>` : ''}
  </div>`;
}

function memberOptions(members, selected = null, emptyLabel = 'Choose…') {
  return `<option value="">${h(emptyLabel)}</option>${members.map((member) =>
    `<option value="${member.id}" ${Number(selected) === Number(member.id) ? 'selected' : ''}>${h(member.display_name)}</option>`
  ).join('')}`;
}

function categoryOptions(categories, selected = 'misc') {
  return categories.map((category) => {
    const label = category.name || category.key;
    return `<option value="${h(category.key)}" ${category.key === selected ? 'selected' : ''}>${h(label)}</option>`;
  }).join('');
}

function parseEquals(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Quick Add
// ---------------------------------------------------------------------------

export async function openQuickAdd({ isAdmin = false, onCreated = null } = {}) {
  try {
    const response = await api.get('/automation/quick-add');
    const templates = response.data ?? [];
    const members = response.members ?? [];
    const content = `
      <div style="display:grid;gap:var(--space-2)">
        ${templates.length ? templates.map((template) => `
          <button type="button" class="btn btn--secondary" data-quick-template="${template.id}"
                  style="justify-content:flex-start;text-align:left;min-height:var(--target-lg)">
            <i data-lucide="zap" class="icon-md" aria-hidden="true"></i>
            <span><strong>${h(template.name)}</strong>${template.description ? `<br><small>${h(template.description)}</small>` : ''}</span>
          </button>
        `).join('') : `<p class="form-hint">No Quick Add templates have been enabled yet.</p>`}
        ${isAdmin ? `
          <button type="button" class="btn btn--ghost" id="automation-manage-from-quick">
            <i data-lucide="settings-2" class="icon-md" aria-hidden="true"></i>
            Manage skills & templates
          </button>` : ''}
      </div>`;

    openModal({
      title: 'Quick Add',
      content,
      size: 'md',
      initialFocus: 'none',
      onSave(panel) {
        panel.querySelectorAll('[data-quick-template]').forEach((button) => {
          button.addEventListener('click', () => {
            const template = templates.find((row) => Number(row.id) === Number(button.dataset.quickTemplate));
            if (template) openQuickAddTemplate(template, members, onCreated);
          });
        });
        panel.querySelector('#automation-manage-from-quick')?.addEventListener('click', () => {
          openAutomationManager();
        });
      },
    });
  } catch (error) {
    toast(error.message || 'Could not load Quick Add templates.', 'danger');
  }
}

function renderRuntimeQuestion(question) {
  const key = h(question.key);
  const label = h(question.label || question.key);
  if (question.type === 'boolean') {
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="boolean">
      <option value="false">No</option><option value="true">Yes</option>
    </select>`);
  }
  if (question.type === 'select') {
    const options = Array.isArray(question.options) ? question.options : [];
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="select">
      ${options.map((option) => `<option value="${h(option)}">${h(option)}</option>`).join('')}
    </select>`);
  }
  return inputRow(label, `<input class="input" name="input_${key}" data-runtime-input="${key}" data-type="text">`);
}

function collectRuntimeInputs(form) {
  const inputs = {};
  form.querySelectorAll('[data-runtime-input]').forEach((field) => {
    const key = field.dataset.runtimeInput;
    if (field.dataset.type === 'boolean') inputs[key] = field.value === 'true';
    else inputs[key] = field.value;
  });
  return inputs;
}

function openQuickAddTemplate(template, members, onCreated) {
  const questions = Array.isArray(template.input_schema) ? template.input_schema : [];
  const content = `<form id="quick-add-form">
    ${template.description ? `<p class="form-hint" style="margin-bottom:var(--space-4)">${h(template.description)}</p>` : ''}
    ${template.subject_required ? inputRow(
      'Who is this for?',
      `<select class="input" id="quick-add-subject" required>${memberOptions(members)}</select>`,
    ) : ''}
    ${questions.map(renderRuntimeQuestion).join('')}
    <div id="quick-add-preview" style="margin-top:var(--space-4)"></div>
    ${footer('Preview')}
  </form>`;

  openModal({
    title: template.name,
    content,
    size: 'lg',
    onSave(panel) {
      const form = panel.querySelector('#quick-add-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const subjectUserId = template.subject_required
          ? Number(panel.querySelector('#quick-add-subject')?.value || 0)
          : null;
        if (template.subject_required && !subjectUserId) {
          toast('Choose a household member.', 'danger');
          return;
        }
        const inputs = collectRuntimeInputs(form);
        try {
          const response = await api.post(`/automation/quick-add/${template.id}/preview`, {
            subject_user_id: subjectUserId,
            inputs,
          });
          renderQuickPreview(panel, template, response.data, subjectUserId, inputs, onCreated);
        } catch (error) {
          toast(error.message || 'Could not preview this workflow.', 'danger');
        }
      });
    },
  });
}

function renderQuickPreview(panel, template, preview, subjectUserId, inputs, onCreated) {
  const target = panel.querySelector('#quick-add-preview');
  const form = panel.querySelector('#quick-add-form');
  if (!target || !form) return;
  target.innerHTML = `
    <div style="display:grid;gap:var(--space-2);padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-md)">
      ${preview.steps.map((step, index) => `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--space-2);align-items:start">
          <strong>${index + 1}.</strong>
          <div>
            <div>${h(step.title)}</div>
            <small class="form-hint">Assigned to ${h(step.assigned_to?.display_name || 'Unassigned')}${step.subject_proficiency ? ` · ${h(step.subject_proficiency)}` : ''}</small>
            ${step.supervisor ? `<br><small class="form-hint">+ ${h(step.supervisor_title)} → ${h(step.supervisor.display_name)}</small>` : ''}
            ${step.depends_on?.length ? `<br><small class="form-hint">After: ${h(step.depends_on.join(', '))}</small>` : ''}
          </div>
        </div>`).join('')}
    </div>
    <button type="button" class="btn btn--primary" id="quick-add-create" style="width:100%;margin-top:var(--space-3)">
      Create activities
    </button>`;
  form.querySelector('button[type="submit"]').textContent = 'Refresh preview';
  if (window.lucide) window.lucide.createIcons({ el: target });

  target.querySelector('#quick-add-create')?.addEventListener('click', async () => {
    try {
      const response = await api.post(`/automation/quick-add/${template.id}/create`, {
        subject_user_id: subjectUserId,
        inputs,
      });
      await closeModal({ force: true });
      toast(`${template.name} created.`);
      await onCreated?.(response.data);
    } catch (error) {
      toast(error.message || 'Could not create this workflow.', 'danger');
    }
  });
}

// ---------------------------------------------------------------------------
// Admin manager
// ---------------------------------------------------------------------------

export async function openAutomationManager(tab = 'skills') {
  const tabs = [
    ['skills', 'Skills'],
    ['activities', 'Activities'],
    ['workflows', 'Quick Add templates'],
  ];
  const content = `
    <div class="group-toggle" id="automation-tabs" role="tablist" style="margin-bottom:var(--space-4)">
      ${tabs.map(([key, label]) => `<button type="button" class="group-toggle__btn ${key === tab ? 'group-toggle__btn--active' : ''}" data-automation-tab="${key}">${h(label)}</button>`).join('')}
    </div>
    <div id="automation-manager-body"><p class="form-hint">Loading…</p></div>`;
  openModal({
    title: 'Household automation',
    content,
    size: 'xl',
    initialFocus: 'none',
    onSave(panel) {
      panel.querySelectorAll('[data-automation-tab]').forEach((button) => {
        button.addEventListener('click', () => openAutomationManager(button.dataset.automationTab));
      });
      loadManagerTab(panel, tab);
    },
  });
}

async function loadManagerTab(panel, tab) {
  const body = panel.querySelector('#automation-manager-body');
  if (!body) return;
  try {
    if (tab === 'skills') await renderSkillsManager(body);
    else if (tab === 'activities') await renderActivitiesManager(body);
    else await renderWorkflowsManager(body);
    if (window.lucide) window.lucide.createIcons({ el: body });
  } catch (error) {
    body.innerHTML = `<p class="form-hint">${h(error.message || 'Could not load automation settings.')}</p>`;
  }
}

function managerHeader(title, addId, addLabel) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);margin-bottom:var(--space-3)">
    <div><strong>${h(title)}</strong></div>
    <button type="button" class="btn btn--primary btn--sm" id="${h(addId)}"><i data-lucide="plus" class="icon-md"></i>${h(addLabel)}</button>
  </div>`;
}

async function renderSkillsManager(body) {
  const response = await api.get('/automation/admin/skills');
  const skills = response.data ?? [];
  body.innerHTML = `${managerHeader('Reusable skills', 'automation-add-skill', 'Add skill')}
    <p class="form-hint" style="margin-bottom:var(--space-3)">Age provides the automatic baseline. Admin overrides on each member take precedence, except adult-only safety rules.</p>
    <div style="display:grid;gap:var(--space-2)">
      ${skills.map((skill) => `
        <div style="padding:var(--space-3);border:1px solid var(--color-border);border-radius:var(--radius-md);display:flex;gap:var(--space-3);align-items:center;justify-content:space-between">
          <div><strong>${h(skill.name)}</strong><br><small class="form-hint">Min age: ${skill.minimum_age ?? 0} · age → ${h(skill.age_promotion)}${skill.adult_only ? ' · adult only' : ''}</small></div>
          <div style="display:flex;gap:var(--space-1)">
            <button type="button" class="btn btn--ghost btn--sm" data-skill-members="${skill.id}">Proficiency</button>
            <button type="button" class="btn btn--ghost btn--sm" data-edit-skill="${skill.id}">Edit</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No skills yet.</p>'}
    </div>`;
  body.querySelector('#automation-add-skill')?.addEventListener('click', () => openSkillForm());
  body.querySelectorAll('[data-edit-skill]').forEach((button) => {
    button.addEventListener('click', () => openSkillForm(skills.find((skill) => Number(skill.id) === Number(button.dataset.editSkill))));
  });
  body.querySelectorAll('[data-skill-members]').forEach((button) => {
    button.addEventListener('click', () => openSkillProficiency(skills.find((skill) => Number(skill.id) === Number(button.dataset.skillMembers))));
  });
}

function openSkillForm(skill = null) {
  const content = `<form id="automation-skill-form">
    ${inputRow('Skill name', `<input class="input" name="name" required maxlength="120" value="${h(skill?.name || '')}">`)}
    ${inputRow('Description', `<textarea class="input" name="description" rows="3">${h(skill?.description || '')}</textarea>`)}
    ${inputRow('Minimum age', `<input class="input" name="minimum_age" type="number" min="0" max="120" value="${skill?.minimum_age ?? 0}">`)}
    ${inputRow('When minimum age is reached', `<select class="input" name="age_promotion"><option value="supervised" ${skill?.age_promotion !== 'normal' ? 'selected' : ''}>Supervised</option><option value="normal" ${skill?.age_promotion === 'normal' ? 'selected' : ''}>Normal</option></select>`)}
    <label style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-3)"><input type="checkbox" name="adult_only" ${skill?.adult_only ? 'checked' : ''}> Adult only</label>
    ${footer(skill ? 'Save skill' : 'Create skill')}
  </form>`;
  openModal({
    title: skill ? 'Edit skill' : 'New skill',
    content,
    onSave(panel) {
      panel.querySelector('#automation-skill-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const payload = {
          name: data.get('name'),
          description: data.get('description'),
          minimum_age: Number(data.get('minimum_age') || 0),
          age_promotion: data.get('age_promotion'),
          adult_only: data.has('adult_only'),
          active: true,
        };
        try {
          if (skill) await api.put(`/automation/admin/skills/${skill.id}`, payload);
          else await api.post('/automation/admin/skills', payload);
          toast('Skill saved.');
          openAutomationManager('skills');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

function openSkillProficiency(skill) {
  if (!skill) return;
  const content = `<form id="automation-proficiency-form">
    <p class="form-hint" style="margin-bottom:var(--space-3)">Automatic follows age. A manual value stays in place until an admin returns it to Automatic.</p>
    ${skill.members.map((member) => inputRow(
      `${member.display_name}${member.age != null ? ` · age ${member.age}` : ''}`,
      `<select class="input" data-member-proficiency="${member.id}">
        <option value="auto" ${!member.manual ? 'selected' : ''}>Automatic (${h(member.proficiency)})</option>
        <option value="excluded" ${member.manual?.proficiency === 'excluded' ? 'selected' : ''}>Excluded</option>
        <option value="supervised" ${member.manual?.proficiency === 'supervised' ? 'selected' : ''}>Supervised</option>
        <option value="normal" ${member.manual?.proficiency === 'normal' ? 'selected' : ''}>Normal</option>
      </select>`,
      member.reason === 'adult_only' ? 'Adult-only safety rule currently forces Excluded.' : '',
    )).join('')}
    ${footer('Save proficiency')}
  </form>`;
  openModal({
    title: `${skill.name} · proficiency`,
    content,
    size: 'lg',
    onSave(panel) {
      panel.querySelector('#automation-proficiency-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          for (const select of panel.querySelectorAll('[data-member-proficiency]')) {
            await api.put(`/automation/admin/skills/${skill.id}/members/${select.dataset.memberProficiency}`, {
              proficiency: select.value,
            });
          }
          toast('Proficiency updated.');
          openAutomationManager('skills');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

async function renderActivitiesManager(body) {
  const response = await api.get('/automation/admin/activity-templates');
  const activities = response.data ?? [];
  body.innerHTML = `${managerHeader('Activity templates', 'automation-add-activity', 'Add activity')}
    <p class="form-hint" style="margin-bottom:var(--space-3)">Activities define work, required skills and how Yuvomi chooses an assignee.</p>
    <div style="display:grid;gap:var(--space-2)">
      ${activities.map((activity) => `
        <button type="button" class="btn btn--secondary" data-edit-activity="${activity.id}" style="justify-content:space-between;text-align:left">
          <span><strong>${h(activity.name)}</strong><br><small>${h(activity.assignment_strategy)} · ${(activity.skills ?? []).map((skill) => h(skill.name)).join(', ') || 'no skill requirement'}</small></span>
          <i data-lucide="chevron-right" class="icon-md"></i>
        </button>`).join('') || '<p class="form-hint">No activity templates yet.</p>'}
    </div>`;
  const context = { skills: response.skills ?? [], members: response.members ?? [], categories: response.categories ?? [] };
  body.querySelector('#automation-add-activity')?.addEventListener('click', () => openActivityForm(null, context));
  body.querySelectorAll('[data-edit-activity]').forEach((button) => {
    button.addEventListener('click', () => openActivityForm(
      activities.find((activity) => Number(activity.id) === Number(button.dataset.editActivity)),
      context,
    ));
  });
}

function openActivityForm(activity, context) {
  const selectedSkills = new Set((activity?.skills ?? []).map((skill) => Number(skill.id)));
  const strategy = activity?.assignment_strategy || 'subject_skill';
  const content = `<form id="automation-activity-form">
    ${inputRow('Activity name', `<input class="input" name="name" required value="${h(activity?.name || '')}">`)}
    ${inputRow('Task title', `<input class="input" name="title_template" required value="${h(activity?.title_template || activity?.name || '')}">`, 'Use {subject} where the selected household member name should appear.')}
    ${inputRow('Description / instructions', `<textarea class="input" name="description" rows="3">${h(activity?.description || '')}</textarea>`)}
    ${inputRow('Category', `<select class="input" name="category">${categoryOptions(context.categories, activity?.category || 'misc')}</select>`)}
    ${inputRow('Assignment strategy', `<select class="input" name="assignment_strategy" id="automation-assignment-strategy">
      <option value="subject_skill" ${strategy === 'subject_skill' ? 'selected' : ''}>Subject, based on proficiency</option>
      <option value="eligible_round_robin" ${strategy === 'eligible_round_robin' ? 'selected' : ''}>Eligible round robin</option>
      <option value="fixed" ${strategy === 'fixed' ? 'selected' : ''}>Fixed household member</option>
    </select>`)}
    <label style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-3)"><input type="checkbox" name="subject_required" ${activity?.subject_required !== 0 ? 'checked' : ''}> Requires a subject</label>
    <div id="automation-fixed-user" ${strategy === 'fixed' ? '' : 'hidden'}>${inputRow('Fixed assignee', `<select class="input" name="fixed_user_id">${memberOptions(context.members, activity?.fixed_user_id)}</select>`)}</div>
    <fieldset style="border:0;padding:0;margin:0 0 var(--space-3)"><legend class="label">Required skills</legend>
      <div style="display:grid;gap:var(--space-2)">${context.skills.map((skill) => `<label style="display:flex;gap:var(--space-2);align-items:center"><input type="checkbox" name="skill" value="${skill.id}" ${selectedSkills.has(Number(skill.id)) ? 'checked' : ''}> ${h(skill.name)}</label>`).join('') || '<small class="form-hint">Create skills first if this activity requires proficiency checks.</small>'}</div>
    </fieldset>
    ${inputRow('Supervision task title', `<input class="input" name="supervision_title_template" value="${h(activity?.supervision_title_template || 'Supervise {subject}: {activity}')}">`, 'Used only when the subject is Supervised.')}
    ${footer(activity ? 'Save activity' : 'Create activity')}
  </form>`;
  openModal({
    title: activity ? 'Edit activity template' : 'New activity template',
    content,
    size: 'lg',
    onSave(panel) {
      const strategySelect = panel.querySelector('#automation-assignment-strategy');
      const fixed = panel.querySelector('#automation-fixed-user');
      strategySelect?.addEventListener('change', () => { fixed.hidden = strategySelect.value !== 'fixed'; });
      panel.querySelector('#automation-activity-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const payload = {
          name: data.get('name'), title_template: data.get('title_template'),
          description: data.get('description'), category: data.get('category'),
          assignment_strategy: data.get('assignment_strategy'),
          subject_required: data.has('subject_required'),
          fixed_user_id: data.get('fixed_user_id') || null,
          skill_ids: data.getAll('skill').map(Number),
          supervision_title_template: data.get('supervision_title_template'),
          active: true,
        };
        try {
          if (activity) await api.put(`/automation/admin/activity-templates/${activity.id}`, payload);
          else await api.post('/automation/admin/activity-templates', payload);
          toast('Activity template saved.');
          openAutomationManager('activities');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

async function renderWorkflowsManager(body) {
  const response = await api.get('/automation/admin/workflow-templates');
  const workflows = response.data ?? [];
  body.innerHTML = `${managerHeader('Workflow templates', 'automation-add-workflow', 'Add workflow')}
    <p class="form-hint" style="margin-bottom:var(--space-3)">Workflows arrange reusable activities into an on-demand event. Enabled workflows appear in Quick Add.</p>
    <div style="display:grid;gap:var(--space-2)">
      ${workflows.map((workflow) => `
        <button type="button" class="btn btn--secondary" data-edit-workflow="${workflow.id}" style="justify-content:space-between;text-align:left">
          <span><strong>${h(workflow.name)}</strong><br><small>${workflow.steps?.length ?? 0} activities · ${workflow.quick_add_enabled ? 'Quick Add enabled' : 'hidden from Quick Add'}</small></span>
          <i data-lucide="chevron-right" class="icon-md"></i>
        </button>`).join('') || '<p class="form-hint">No workflow templates yet.</p>'}
    </div>`;
  const context = { activities: response.activities ?? [], categories: response.categories ?? [] };
  body.querySelector('#automation-add-workflow')?.addEventListener('click', () => openWorkflowForm(null, context));
  body.querySelectorAll('[data-edit-workflow]').forEach((button) => {
    button.addEventListener('click', () => openWorkflowForm(
      workflows.find((workflow) => Number(workflow.id) === Number(button.dataset.editWorkflow)),
      context,
    ));
  });
}

let workflowDraftStepSequence = 0;

function workflowStepHtml(step, index, activities) {
  const workflowKey = step?.step_key || `draft_${++workflowDraftStepSequence}`;
  const initialDependency = step?.depends_on?.[0] || '';
  return `<div data-workflow-step data-workflow-key="${h(workflowKey)}" data-initial-dependency="${h(initialDependency)}" style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-2)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2)"><strong>Step ${index + 1}</strong><button type="button" class="btn btn--ghost btn--sm" data-remove-step>Remove</button></div>
    <select class="input" data-step-activity required>${activities.map((activity) => `<option value="${activity.id}" ${Number(step?.activity_template_id) === Number(activity.id) ? 'selected' : ''}>${h(activity.name)}</option>`).join('')}</select>
    <input class="input" style="margin-top:var(--space-2)" data-step-title placeholder="Optional task title override" value="${h(step?.title_override || '')}">
    <select class="input" style="margin-top:var(--space-2)" data-step-dependency><option value="">No dependency</option></select>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-top:var(--space-2)">
      <input class="input" data-step-condition-key placeholder="Optional condition key" value="${h(step?.condition?.input || '')}">
      <input class="input" data-step-condition-value placeholder="Equals" value="${h(step?.condition && Object.hasOwn(step.condition, 'equals') ? step.condition.equals : '')}">
    </div>
  </div>`;
}

function questionHtml(question = {}) {
  return `<div data-workflow-question style="display:grid;grid-template-columns:1fr 1.5fr auto auto;gap:var(--space-2);align-items:center;margin-bottom:var(--space-2)">
    <input class="input" data-question-key placeholder="key" value="${h(question.key || '')}">
    <input class="input" data-question-label placeholder="Question label" value="${h(question.label || '')}">
    <select class="input" data-question-type><option value="boolean" ${question.type === 'boolean' ? 'selected' : ''}>Yes/No</option><option value="text" ${question.type === 'text' ? 'selected' : ''}>Text</option><option value="select" ${question.type === 'select' ? 'selected' : ''}>Choice</option></select>
    <button type="button" class="btn btn--ghost btn--sm" data-remove-question>Remove</button>
    <input class="input" style="grid-column:2 / -1" data-question-options placeholder="Choice options, comma separated" value="${h((question.options || []).join(', '))}">
  </div>`;
}

function openWorkflowForm(workflow, context) {
  const content = `<form id="automation-workflow-form">
    ${inputRow('Workflow name', `<input class="input" name="name" required value="${h(workflow?.name || '')}">`)}
    ${inputRow('Description', `<textarea class="input" name="description" rows="2">${h(workflow?.description || '')}</textarea>`)}
    ${inputRow('Category', `<select class="input" name="category">${categoryOptions(context.categories, workflow?.category || 'misc')}</select>`)}
    <label style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-2)"><input type="checkbox" name="subject_required" ${workflow?.subject_required !== 0 ? 'checked' : ''}> Ask which household member this is for</label>
    <label style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-4)"><input type="checkbox" name="quick_add_enabled" ${workflow?.quick_add_enabled !== 0 ? 'checked' : ''}> Show in Quick Add</label>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2)"><strong>Additional questions</strong><button type="button" class="btn btn--ghost btn--sm" id="workflow-add-question">Add question</button></div>
    <div id="workflow-questions">${(workflow?.input_schema || []).map(questionHtml).join('')}</div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin:var(--space-4) 0 var(--space-2)"><strong>Activities</strong><button type="button" class="btn btn--ghost btn--sm" id="workflow-add-step">Add activity</button></div>
    <div id="workflow-steps">${(workflow?.steps?.length ? workflow.steps : [{}]).map((step, index) => workflowStepHtml(step, index, context.activities)).join('')}</div>
    ${footer(workflow ? 'Save workflow' : 'Create workflow')}
  </form>`;

  openModal({
    title: workflow ? 'Edit workflow template' : 'New workflow template',
    content,
    size: 'xl',
    onSave(panel) {
      const steps = panel.querySelector('#workflow-steps');
      const questions = panel.querySelector('#workflow-questions');

      const refreshStepDependencies = () => {
  const rows = [...steps.querySelectorAll('[data-workflow-step]')];
  rows.forEach((row, index) => {
    row.querySelector('strong').textContent = `Step ${index + 1}`;
    const select = row.querySelector('[data-step-dependency]');
    const old = select.value;
    const existing = row.dataset.initialDependency || '';
    select.innerHTML = '<option value="">No dependency</option>' + rows.slice(0, index).map((priorRow, prior) =>
      `<option value="${h(priorRow.dataset.workflowKey)}">After step ${prior + 1}</option>`
    ).join('');
    const wanted = old || existing;
    if ([...select.options].some((option) => option.value === wanted)) select.value = wanted;
    delete row.dataset.initialDependency;
  });
};
refreshStepDependencies();

      panel.querySelector('#workflow-add-step')?.addEventListener('click', () => {
        steps.insertAdjacentHTML('beforeend', workflowStepHtml({}, steps.children.length, context.activities));
        refreshStepDependencies();
      });
      steps.addEventListener('click', (event) => {
        if (event.target.closest('[data-remove-step]')) {
          event.target.closest('[data-workflow-step]').remove();
          refreshStepDependencies();
        }
      });
      panel.querySelector('#workflow-add-question')?.addEventListener('click', () => {
        questions.insertAdjacentHTML('beforeend', questionHtml());
      });
      questions.addEventListener('click', (event) => event.target.closest('[data-remove-question]')?.closest('[data-workflow-question]')?.remove());

      panel.querySelector('#automation-workflow-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const inputSchema = [...questions.querySelectorAll('[data-workflow-question]')].map((row) => {
          const type = row.querySelector('[data-question-type]').value;
          return {
            key: row.querySelector('[data-question-key]').value.trim(),
            label: row.querySelector('[data-question-label]').value.trim(),
            type,
            options: type === 'select' ? row.querySelector('[data-question-options]').value.split(',').map((x) => x.trim()).filter(Boolean) : [],
          };
        }).filter((question) => question.key && question.label);

        const stepRows = [...steps.querySelectorAll('[data-workflow-step]')];
  const savedKeyByDraftKey = new Map(
    stepRows.map((row, index) => [row.dataset.workflowKey, `step_${index + 1}`])
  );
  const stepPayload = stepRows.map((row, index) => {
    const conditionKey = row.querySelector('[data-step-condition-key]').value.trim();
    const conditionValue = row.querySelector('[data-step-condition-value]').value;
    const dependencyDraftKey = row.querySelector('[data-step-dependency]').value;
    const dependency = dependencyDraftKey ? savedKeyByDraftKey.get(dependencyDraftKey) : null;
    return {
      step_key: `step_${index + 1}`,
      activity_template_id: Number(row.querySelector('[data-step-activity]').value),
      title_override: row.querySelector('[data-step-title]').value.trim() || null,
      depends_on: dependency ? [dependency] : [],
      condition: conditionKey ? { input: conditionKey, equals: parseEquals(conditionValue) } : null,
    };
  });

  const payload = {
          name: data.get('name'), description: data.get('description'), category: data.get('category'),
          subject_required: data.has('subject_required'), quick_add_enabled: data.has('quick_add_enabled'),
          active: true, input_schema: inputSchema, steps: stepPayload,
        };
        try {
          if (workflow) await api.put(`/automation/admin/workflow-templates/${workflow.id}`, payload);
          else await api.post('/automation/admin/workflow-templates', payload);
          toast('Workflow template saved.');
          openAutomationManager('workflows');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}
