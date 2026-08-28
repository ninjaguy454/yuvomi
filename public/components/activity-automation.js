import { api } from '/api.js';
import { openModal, closeModal, confirmOverModal } from '/components/modal.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const h = (value) => esc(String(value ?? ''));

function activityDescriptionTooltip(value) {
  const description = String(value ?? '').replace(/\s+/g, ' ').trim();
  return [...description].slice(0, 160).join('');
}

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

function workflowMentionOptions(panel) {
  return [...panel.querySelectorAll('[data-workflow-question]')].map((row, index) => {
    const id = row.dataset.variableId;
    const label = row.querySelector('[data-question-label]')?.value.trim() || `Variable ${index + 1}`;
    return { id, label, detail: id, token: `{{${id}}}` };
  }).filter((option) => option.id);
}

function mentionOptions(panel, field) {
  const context = field.dataset.variableMentions;
  const variables = context?.startsWith('workflow') ? workflowMentionOptions(panel) : [];
  const builtIns = [];
  if (['activity-title', 'activity-description', 'activity-supervision',
    'workflow-step-title', 'workflow-step-description'].includes(context)) {
    builtIns.push({
      id: 'subject',
      label: 'Person this activity is for',
      detail: 'Activity subject',
      token: '{subject}',
    });
  }
  if (['activity-title', 'activity-description', 'activity-supervision',
    'workflow-step-title', 'workflow-step-description'].includes(context)) {
    builtIns.push({ id: 'activity', label: 'Activity name', detail: 'Template name', token: '{activity}' });
  }
  return [...builtIns, ...variables];
}

function activeMention(field) {
  const caret = field.selectionStart;
  if (!Number.isInteger(caret)) return null;
  const before = field.value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const preceding = before[at - 1] || '';
  if (preceding && /[A-Za-z0-9_]/.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (/[^A-Za-z0-9 _-]/.test(query) || query.includes('\n')) return null;
  return { start: at, end: caret, query: query.trim().toLocaleLowerCase() };
}

/**
 * The stored syntax stays backwards-compatible ({subject}/{{variable_id}}),
 * while authors type @ and choose a human-readable variable name.
 */
function wireVariableMentions(panel) {
  const menu = document.createElement('div');
  menu.className = 'automation-mention-menu';
  menu.id = 'automation-mention-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  // A fixed-position child of .modal-panel is positioned against that panel
  // because the modal animation establishes a containing block. Mount the
  // picker on the full-screen overlay instead, whose origin matches the
  // viewport coordinates returned by getBoundingClientRect().
  (panel.closest('.modal-overlay') || document.body).appendChild(menu);
  let active = { field: null, mention: null, options: [], index: 0 };

  const close = () => {
    if (active.field) {
      active.field.setAttribute('aria-expanded', 'false');
      active.field.removeAttribute('aria-activedescendant');
    }
    menu.hidden = true;
    menu.replaceChildren();
    active = { field: null, mention: null, options: [], index: 0 };
  };

  const paint = () => {
    menu.innerHTML = active.options.map((option, index) => `
      <button type="button" role="option" id="automation-mention-${index}"
              aria-selected="${index === active.index}" data-mention-index="${index}"
              class="automation-mention-option ${index === active.index ? 'automation-mention-option--active' : ''}">
        <span>${h(option.label)}</span>
        <small>${h(option.detail)}</small>
      </button>`).join('');
    active.field?.setAttribute('aria-activedescendant', `automation-mention-${active.index}`);
  };

  const position = () => {
    if (!active.field) return;
    const rect = active.field.getBoundingClientRect();
    const gutter = 12;
    const gap = 4;
    const width = Math.min(Math.max(220, rect.width), window.innerWidth - (2 * gutter));
    const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter);
    menu.style.left = `${left}px`;
    menu.style.width = `${width}px`;

    const menuHeight = menu.offsetHeight;
    const below = rect.bottom + gap;
    const above = rect.top - gap - menuHeight;
    const top = below + menuHeight <= window.innerHeight - gutter || above < gutter
      ? Math.min(below, window.innerHeight - menuHeight - gutter)
      : above;
    menu.style.top = `${Math.max(gutter, top)}px`;
  };

  const open = (field, mention) => {
    const options = mentionOptions(panel, field).filter((option) => (
      !mention.query || `${option.label} ${option.id}`.toLocaleLowerCase().includes(mention.query)
    ));
    if (!options.length) { close(); return; }
    active = { field, mention, options, index: 0 };
    field.setAttribute('aria-expanded', 'true');
    field.setAttribute('aria-controls', menu.id);
    paint();
    menu.hidden = false;
    position();
  };

  const choose = (index = active.index) => {
    const option = active.options[index];
    const { field, mention } = active;
    if (!option || !field || !mention) return;
    const suffix = field.value.slice(mention.end);
    const spacer = suffix && !/^\s/.test(suffix) ? ' ' : '';
    field.value = `${field.value.slice(0, mention.start)}${option.token}${spacer}${suffix}`;
    const caret = mention.start + option.token.length + spacer.length;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    field.focus();
  };

  panel.addEventListener('input', (event) => {
    const field = event.target.closest('[data-variable-mentions]');
    if (!field) return;
    const mention = activeMention(field);
    if (mention) open(field, mention);
    else close();
  });
  panel.addEventListener('keydown', (event) => {
    if (menu.hidden || event.target !== active.field) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
    // The shared modal submits single-line inputs on Enter. Intercept picker
    // navigation during capture so choosing a variable cannot save the form.
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      active.index = (active.index + direction + active.options.length) % active.options.length;
      paint();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }, { capture: true });
  panel.addEventListener('focusin', (event) => {
    if (!menu.hidden && event.target !== active.field && !menu.contains(event.target)) close();
  });
  menu.addEventListener('mousedown', (event) => event.preventDefault());
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[data-mention-index]');
    if (option) choose(Number(option.dataset.mentionIndex));
  });
  panel.addEventListener('focusout', () => setTimeout(() => {
    if (!panel.contains(document.activeElement)) close();
  }, 0));
  panel.addEventListener('scroll', () => {
    if (!menu.hidden) position();
  }, { passive: true, capture: true });
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

function parseEquals(value, type = null) {
  const raw = String(value ?? '').trim();
  if (type === 'choice' || type === 'select' || type === 'text' || type === 'date' || type === 'time') return raw;
  if (type === 'household_member' || type === 'number') return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Quick Add
// ---------------------------------------------------------------------------

export async function openQuickAdd({ onCreated = null, onActivitySelected = null } = {}) {
  try {
    const response = await api.get('/automation/quick-add');
    const templates = response.data ?? [];
    const activities = response.activities ?? [];
    const members = response.members ?? [];
    const content = `
      <div class="automation-quick-section">
        <div class="automation-quick-section__heading">
          <strong>Activity templates</strong>
          <small class="form-hint">Create one task using its saved instructions and assignment rules.</small>
        </div>
        <div class="automation-quick-list">
          ${activities.length ? activities.map((activity) => `
            <button type="button" class="btn btn--secondary automation-quick-template" data-quick-activity="${activity.id}"
                    ${activity.description ? `title="${h(activityDescriptionTooltip(activity.description))}"` : ''}>
              <i data-lucide="list-plus" class="icon-md" aria-hidden="true"></i>
              <span><strong>${h(activity.name)}</strong></span>
            </button>
          `).join('') : '<p class="form-hint">No activity templates are available yet.</p>'}
        </div>
      </div>
      <div class="automation-quick-section">
        <div class="automation-quick-section__heading">
          <strong>Automated events</strong>
          <small class="form-hint">Run a multi-step Quick Add workflow.</small>
        </div>
        <div class="automation-quick-list">
        ${templates.length ? templates.map((template) => `
          <button type="button" class="btn btn--secondary automation-quick-template" data-quick-template="${template.id}">
            <i data-lucide="zap" class="icon-md" aria-hidden="true"></i>
            <span><strong>${h(template.name)}</strong>${template.description ? `<br><small>${h(template.description)}</small>` : ''}</span>
          </button>
        `).join('') : `<p class="form-hint">No Quick Add templates have been enabled yet.</p>`}
        </div>
      </div>`;

    openModal({
      title: 'Quick Add',
      content,
      size: 'md',
      initialFocus: 'none',
      onSave(panel) {
        panel.querySelectorAll('[data-quick-activity]').forEach((button) => {
          button.addEventListener('click', async () => {
            const activity = activities.find((row) => Number(row.id) === Number(button.dataset.quickActivity));
            if (!activity || typeof onActivitySelected !== 'function') return;
            await closeModal({ force: true });
            await onActivitySelected(activity);
          });
        });
        panel.querySelectorAll('[data-quick-template]').forEach((button) => {
          button.addEventListener('click', () => {
            const template = templates.find((row) => Number(row.id) === Number(button.dataset.quickTemplate));
            if (template) openQuickAddTemplate(template, members, onCreated);
          });
        });
      },
    });
  } catch (error) {
    toast(error.message || 'Could not load Quick Add templates.', 'danger');
  }
}

function workflowVariableId(question) {
  return question?.id ?? question?.key ?? '';
}

function renderRuntimeQuestion(question, members) {
  const key = h(workflowVariableId(question));
  const label = h(question.label || workflowVariableId(question));
  if (question.type === 'boolean') {
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="boolean">
      <option value="false">No</option><option value="true">Yes</option>
    </select>`);
  }
  if (question.type === 'select' || question.type === 'choice') {
    const options = Array.isArray(question.options) ? question.options : [];
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="choice">
      ${options.map((option) => `<option value="${h(option)}">${h(option)}</option>`).join('')}
    </select>`);
  }
  if (question.type === 'household_member') {
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="household_member" required>
      ${memberOptions(members)}
    </select>`);
  }
  const inputType = ['number', 'date', 'time'].includes(question.type) ? question.type : 'text';
  const required = ['number', 'date', 'time'].includes(inputType) ? 'required' : '';
  return inputRow(label, `<input class="input" type="${inputType}" name="input_${key}" data-runtime-input="${key}" data-type="${h(question.type || 'text')}" ${required}>`);
}

function collectRuntimeInputs(form) {
  const inputs = {};
  form.querySelectorAll('[data-runtime-input]').forEach((field) => {
    const key = field.dataset.runtimeInput;
    if (field.dataset.type === 'boolean') inputs[key] = field.value === 'true';
    else if (field.dataset.type === 'household_member' || field.dataset.type === 'number') inputs[key] = Number(field.value);
    else inputs[key] = field.value;
  });
  return inputs;
}

function openQuickAddTemplate(template, members, onCreated) {
  const questions = Array.isArray(template.input_schema) ? template.input_schema : [];
  const content = `<form id="quick-add-form">
    ${template.description ? `<p class="form-hint automation-form-intro">${h(template.description)}</p>` : ''}
    ${template.subject_required ? inputRow(
      'Who is this for?',
      `<select class="input" id="quick-add-subject" required>${memberOptions(members)}</select>`,
    ) : ''}
    ${questions.map((question) => renderRuntimeQuestion(question, members)).join('')}
    <div id="quick-add-preview" class="automation-quick-preview"></div>
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
    <div class="automation-preview">
      ${preview.steps.map((step, index) => `
        <div class="automation-preview__step">
          <strong>${index + 1}.</strong>
          <div>
            <div>${h(step.title)}</div>
            <small class="form-hint">Assigned to ${h(step.assigned_to?.display_name || 'Unassigned')}${step.subject_proficiency ? ` · ${h(step.subject_proficiency)}` : ''}</small>
            ${step.supervisor ? `<br><small class="form-hint">+ ${h(step.supervisor_title)} → ${h(step.supervisor.display_name)}</small>` : ''}
            ${step.depends_on?.length ? `<br><small class="form-hint">After: ${h(step.depends_on.join(', '))}</small>` : ''}
          </div>
        </div>`).join('')}
    </div>
    <button type="button" class="btn btn--primary automation-preview-create" id="quick-add-create">
      Create activities
    </button>`;
  const submitButton = panel.querySelector('button[type="submit"]');
  if (submitButton) submitButton.textContent = 'Refresh preview';
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

const AUTOMATION_TABS = [
  ['skills', 'Skills'],
  ['activities', 'Activities'],
  ['workflows', 'Quick Add templates'],
  ['variables', 'Variables'],
];

function validAutomationTab(tab) {
  return AUTOMATION_TABS.some(([key]) => key === tab) ? tab : 'skills';
}

export async function renderAutomationManager(container, { tab = 'skills', onTabChange = null } = {}) {
  const activeTab = validAutomationTab(tab);
  container.innerHTML = `
    <div class="automation-manager">
      <div class="group-toggle automation-tabs" role="tablist" aria-label="Household automation sections">
        ${AUTOMATION_TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === activeTab}" class="group-toggle__btn ${key === activeTab ? 'group-toggle__btn--active' : ''}" data-automation-tab="${key}">${h(label)}</button>`).join('')}
      </div>
      <div class="automation-manager__body"><p class="form-hint">Loading…</p></div>
    </div>`;

  const navigate = async (nextTab) => {
    if (typeof onTabChange === 'function') await onTabChange(validAutomationTab(nextTab));
    else await renderAutomationManager(container, { tab: nextTab });
  };
  container.querySelectorAll('[data-automation-tab]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.automationTab));
  });
  await loadManagerTab(container, activeTab, { navigate });
}

export async function openAutomationManager(tab = 'skills') {
  const activeTab = validAutomationTab(tab);
  openModal({
    title: 'Household automation',
    content: '<div id="automation-manager-root"></div>',
    size: 'xl',
    initialFocus: 'none',
    onSave(panel) {
      const root = panel.querySelector('#automation-manager-root');
      if (root) renderAutomationManager(root, { tab: activeTab, onTabChange: openAutomationManager });
    },
  });
}

async function loadManagerTab(panel, tab, manager) {
  const body = panel.querySelector('.automation-manager__body');
  if (!body) return;
  try {
    if (tab === 'skills') await renderSkillsManager(body, manager);
    else if (tab === 'activities') await renderActivitiesManager(body, manager);
    else if (tab === 'workflows') await renderWorkflowsManager(body, manager);
    else await renderVariablesManager(body, manager);
    if (window.lucide) window.lucide.createIcons({ el: body });
  } catch (error) {
    body.innerHTML = `<p class="form-hint">${h(error.message || 'Could not load automation settings.')}</p>`;
  }
}

function managerHeader(title, addId, addLabel) {
  return `<div class="automation-manager__header">
    <div><strong>${h(title)}</strong></div>
    <button type="button" class="btn btn--primary btn--sm" id="${h(addId)}"><i data-lucide="plus" class="icon-md"></i>${h(addLabel)}</button>
  </div>`;
}

function householdVariableTypeOptions(selected = 'text') {
  return [
    ['text', 'Text'], ['number', 'Number'], ['boolean', 'Yes/No'],
    ['choice', 'Choice'], ['date', 'Date'], ['time', 'Time'],
    ['household_member', 'Household member'],
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

async function renderVariablesManager(body, manager) {
  const response = await api.get('/automation/admin/variables');
  const variables = response.data ?? [];
  const context = response.context ?? [];
  body.innerHTML = `${managerHeader('Reusable variables', 'automation-add-variable', 'Add variable')}
    <p class="form-hint automation-manager__hint">Define values and reusable fields once, then use the same readable ID across household templates. IDs stay stable unless an admin deliberately renames one.</p>
    <div class="automation-list">
      ${variables.map((variable) => `
        <div class="automation-list-row">
          <div class="automation-list-row__copy">
            <strong>${h(variable.label)}</strong> <code class="automation-variable-token automation-variable-token--inline">{{${h(variable.variable_key)}}}</code><br>
            <small class="form-hint">${h(variable.type)} · ${variable.kind === 'value' ? 'Household value' : 'Reusable field'}${variable.usage_count ? ` · used by ${variable.usage_count} workflow variable${variable.usage_count === 1 ? '' : 's'}` : ''}</small>
          </div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-edit-variable="${variable.id}">Edit</button>
            <button type="button" class="btn btn--ghost btn--sm" data-rename-variable="${variable.id}">Rename ID</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-variable="${variable.id}">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No reusable variables yet.</p>'}
    </div>
    <div class="automation-workflow-step__header automation-workflow-step__header--section"><strong>System context</strong></div>
    <p class="form-hint automation-manager__hint">These values are supplied automatically when a template runs and do not need to be maintained.</p>
    <div class="automation-list">${context.map((variable) => `
      <div class="automation-list-row"><div class="automation-list-row__copy"><strong>${h(variable.label)}</strong> <code class="automation-variable-token automation-variable-token--inline">{{${h(variable.key)}}}</code><br><small class="form-hint">${h(variable.description)}</small></div></div>`).join('')}</div>`;

  body.querySelector('#automation-add-variable')?.addEventListener('click', () => openVariableForm(null, manager));
  body.querySelectorAll('[data-edit-variable]').forEach((button) => button.addEventListener('click', () => {
    openVariableForm(variables.find((row) => Number(row.id) === Number(button.dataset.editVariable)), manager);
  }));
  body.querySelectorAll('[data-rename-variable]').forEach((button) => button.addEventListener('click', () => {
    openVariableKeyForm(variables.find((row) => Number(row.id) === Number(button.dataset.renameVariable)), manager);
  }));
  body.querySelectorAll('[data-delete-variable]').forEach((button) => button.addEventListener('click', () => {
    const variable = variables.find((row) => Number(row.id) === Number(button.dataset.deleteVariable));
    if (!variable) return;
    deleteAutomationDefinition({
      name: variable.label, noun: 'reusable variable',
      path: `/automation/admin/variables/${variable.id}`, tab: 'variables', manager,
    });
  }));
}

function openVariableForm(variable = null, manager = null) {
  const content = `<form id="automation-variable-form">
    ${inputRow('Variable name', `<input class="input" name="label" required maxlength="120" value="${h(variable?.label || '')}">`, 'The friendly name shown in variable suggestions.')}
    ${variable ? inputRow('Variable ID', `<code class="automation-variable-token">{{${h(variable.variable_key)}}}</code>`, 'Use Rename ID only when every reference should change.') : inputRow('Variable ID', `<input class="input" name="variable_key" maxlength="80" placeholder="Generated from the name">`, 'Lowercase letters, numbers, and underscores. Leave blank to generate it from the name.')}
    ${inputRow('Description', `<textarea class="input" name="description" rows="2">${h(variable?.description || '')}</textarea>`)}
    ${inputRow('Type', `<select class="input" name="type" id="automation-variable-type">${householdVariableTypeOptions(variable?.type || 'text')}</select>`)}
    ${inputRow('Use', `<select class="input" name="kind"><option value="field" ${variable?.kind !== 'value' ? 'selected' : ''}>Ask when a template runs</option><option value="value" ${variable?.kind === 'value' ? 'selected' : ''}>Saved household value</option></select>`)}
    <div id="automation-variable-options" ${variable?.type === 'choice' ? '' : 'hidden'}>${inputRow('Choices', `<input class="input" name="options" value="${h((variable?.options || []).join(', '))}" placeholder="One, Two, Three">`)}</div>
    ${inputRow('Default value', `<input class="input" name="default_value" value="${h(variable?.default_value ?? '')}">`, 'Optional. The value can still be supplied or changed when used.')}
    ${footer(variable ? 'Save variable' : 'Create variable')}
  </form>`;
  openModal({
    title: variable ? 'Edit reusable variable' : 'New reusable variable', content,
    onSave(panel) {
      const type = panel.querySelector('#automation-variable-type');
      const options = panel.querySelector('#automation-variable-options');
      type?.addEventListener('change', () => { options.hidden = type.value !== 'choice'; });
      panel.querySelector('#automation-variable-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const payload = {
          label: data.get('label'), description: data.get('description'), type: data.get('type'),
          kind: data.get('kind'), variable_key: data.get('variable_key') || undefined,
          options: String(data.get('options') || '').split(',').map((item) => item.trim()).filter(Boolean),
          default_value: data.get('default_value') || null, active: true,
        };
        try {
          if (variable) await api.put(`/automation/admin/variables/${variable.id}`, payload);
          else await api.post('/automation/admin/variables', payload);
          toast('Reusable variable saved.');
          await refreshAutomationManager(manager, 'variables');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

function openVariableKeyForm(variable, manager = null) {
  if (!variable) return;
  const content = `<form id="automation-variable-key-form">
    <p class="form-hint">Renaming this ID updates linked definitions while preserving the variable's permanent identity. Existing plain text copied outside Yuvomi cannot be updated.</p>
    ${inputRow('New variable ID', `<input class="input" name="variable_key" required value="${h(variable.variable_key)}">`)}
    ${footer('Rename ID')}
  </form>`;
  openModal({ title: `Rename ${variable.label}`, content, onSave(panel) {
    panel.querySelector('#automation-variable-key-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const confirmed = await confirmOverModal('Rename this reusable variable ID?', {
        confirmLabel: 'Rename ID', detail: 'Yuvomi will keep database links intact. Use this only when the new ID is clearer.',
      });
      if (!confirmed) return;
      try {
        await api.put(`/automation/admin/variables/${variable.id}/key`, { variable_key: new FormData(event.currentTarget).get('variable_key') });
        toast('Variable ID renamed.');
        await refreshAutomationManager(manager, 'variables');
      } catch (error) { toast(error.message, 'danger'); }
    });
  }});
}

async function refreshAutomationManager(manager, tab) {
  await closeModal({ force: true });
  await manager?.navigate?.(tab);
}

async function deleteAutomationDefinition({ name, noun, path, tab, manager }) {
  const confirmed = await confirmOverModal(`Delete ${noun} “${name}”?`, {
    danger: true,
    confirmLabel: 'Delete',
    detail: t('settings.automationDefinitionDeleteConfirmDetail'),
  });
  if (!confirmed) return;

  try {
    await api.delete(path);
    toast(`${noun[0].toUpperCase()}${noun.slice(1)} deleted.`);
  } catch (error) {
    toast(error.message || `Could not delete this ${noun}.`, 'danger');
  }
  // A confirmation opened above a modal closes the parked manager only when
  // deletion is confirmed. Re-render in both success and dependency-error
  // cases so the user always returns to the definition list.
  await manager?.navigate?.(tab);
}

async function renderSkillsManager(body, manager) {
  const response = await api.get('/automation/admin/skills');
  const skills = response.data ?? [];
  body.innerHTML = `${managerHeader('Reusable skills', 'automation-add-skill', 'Add skill')}
    <p class="form-hint automation-manager__hint">Age provides the automatic baseline. Admin overrides on each member take precedence, except adult-only safety rules.</p>
    <div class="automation-list">
      ${skills.map((skill) => `
        <div class="automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(skill.name)}</strong><br><small class="form-hint">Min age: ${skill.minimum_age ?? 0} · age → ${h(skill.age_promotion)}${skill.adult_only ? ' · adult only' : ''}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-skill-members="${skill.id}">Proficiency</button>
            <button type="button" class="btn btn--ghost btn--sm" data-edit-skill="${skill.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-skill="${skill.id}" aria-label="Delete ${h(skill.name)} skill">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No skills yet.</p>'}
    </div>`;
  body.querySelector('#automation-add-skill')?.addEventListener('click', () => openSkillForm(null, manager));
  body.querySelectorAll('[data-edit-skill]').forEach((button) => {
    button.addEventListener('click', () => openSkillForm(skills.find((skill) => Number(skill.id) === Number(button.dataset.editSkill)), manager));
  });
  body.querySelectorAll('[data-skill-members]').forEach((button) => {
    button.addEventListener('click', () => openSkillProficiency(skills.find((skill) => Number(skill.id) === Number(button.dataset.skillMembers)), manager));
  });
  body.querySelectorAll('[data-delete-skill]').forEach((button) => {
    button.addEventListener('click', () => {
      const skill = skills.find((row) => Number(row.id) === Number(button.dataset.deleteSkill));
      if (!skill) return;
      deleteAutomationDefinition({
        name: skill.name,
        noun: 'skill',
        path: `/automation/admin/skills/${skill.id}`,
        tab: 'skills',
        manager,
      });
    });
  });
}

function openSkillForm(skill = null, manager = null) {
  const content = `<form id="automation-skill-form">
    ${inputRow('Skill name', `<input class="input" name="name" required maxlength="120" value="${h(skill?.name || '')}">`)}
    ${inputRow('Description', `<textarea class="input" name="description" rows="3">${h(skill?.description || '')}</textarea>`)}
    ${inputRow('Minimum age', `<input class="input" name="minimum_age" type="number" min="0" max="120" value="${skill?.minimum_age ?? 0}">`)}
    ${inputRow('When minimum age is reached', `<select class="input" name="age_promotion"><option value="supervised" ${skill?.age_promotion !== 'normal' ? 'selected' : ''}>Supervised</option><option value="normal" ${skill?.age_promotion === 'normal' ? 'selected' : ''}>Normal</option></select>`)}
    <label class="automation-check-row"><input type="checkbox" name="adult_only" ${skill?.adult_only ? 'checked' : ''}> Adult only</label>
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
          await refreshAutomationManager(manager, 'skills');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

function openSkillProficiency(skill, manager = null) {
  if (!skill) return;
  const content = `<form id="automation-proficiency-form">
    <p class="form-hint automation-manager__hint">Automatic follows age. A manual value stays in place until an admin returns it to Automatic.</p>
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
          await refreshAutomationManager(manager, 'skills');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

async function renderActivitiesManager(body, manager) {
  const response = await api.get('/automation/admin/activity-templates');
  const activities = response.data ?? [];
  body.innerHTML = `${managerHeader('Activity templates', 'automation-add-activity', 'Add activity')}
    <p class="form-hint automation-manager__hint">Activities define work, required skills and how Yuvomi chooses an assignee.</p>
    <div class="automation-list">
      ${activities.map((activity) => `
        <div class="automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(activity.name)}</strong><br><small class="form-hint">${h(activity.assignment_strategy)} · ${(activity.skills ?? []).map((skill) => h(skill.name)).join(', ') || 'no skill requirement'}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-edit-activity="${activity.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-activity="${activity.id}" aria-label="Delete ${h(activity.name)} activity template">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No activity templates yet.</p>'}
    </div>`;
  const context = { skills: response.skills ?? [], members: response.members ?? [], categories: response.categories ?? [] };
  body.querySelector('#automation-add-activity')?.addEventListener('click', () => openActivityForm(null, context, manager));
  body.querySelectorAll('[data-edit-activity]').forEach((button) => {
    button.addEventListener('click', () => openActivityForm(
      activities.find((activity) => Number(activity.id) === Number(button.dataset.editActivity)),
      context,
      manager,
    ));
  });
  body.querySelectorAll('[data-delete-activity]').forEach((button) => {
    button.addEventListener('click', () => {
      const activity = activities.find((row) => Number(row.id) === Number(button.dataset.deleteActivity));
      if (!activity) return;
      deleteAutomationDefinition({
        name: activity.name,
        noun: 'activity template',
        path: `/automation/admin/activity-templates/${activity.id}`,
        tab: 'activities',
        manager,
      });
    });
  });
}

function openActivityForm(activity, context, manager = null) {
  const selectedSkills = new Set((activity?.skills ?? []).map((skill) => Number(skill.id)));
  const strategy = activity?.assignment_strategy || 'subject_skill';
  const content = `<form id="automation-activity-form">
    ${inputRow('Template name', `<input class="input" name="name" required value="${h(activity?.name || '')}">`, 'The reusable name shown in the Activity Template library.')}
    ${inputRow('Generated task title', `<input class="input" name="title_template" data-variable-mentions="activity-title" aria-autocomplete="list" aria-expanded="false" required value="${h(activity?.title_template || activity?.name || '')}">`, 'The title created on the actual task. Type @ to insert the person or Activity Template name.')}
    ${inputRow('Description / instructions', `<textarea class="input" name="description" rows="3" data-variable-mentions="activity-description" aria-autocomplete="list" aria-expanded="false">${h(activity?.description || '')}</textarea>`, 'Type @ to insert the person or Activity Template name.')}
    ${inputRow('Category', `<select class="input" name="category">${categoryOptions(context.categories, activity?.category || 'misc')}</select>`)}
    ${inputRow('Assignment strategy', `<select class="input" name="assignment_strategy" id="automation-assignment-strategy">
      <option value="subject_skill" ${strategy === 'subject_skill' ? 'selected' : ''}>Person or qualified helper, based on proficiency</option>
      <option value="eligible_round_robin" ${strategy === 'eligible_round_robin' ? 'selected' : ''}>Eligible round robin</option>
      <option value="fixed" ${strategy === 'fixed' ? 'selected' : ''}>Fixed household member</option>
    </select>`)}
    <label class="automation-check-row"><input type="checkbox" name="subject_required" ${activity?.subject_required !== 0 ? 'checked' : ''}> Requires a person this activity is for</label>
    <div id="automation-fixed-user" ${strategy === 'fixed' ? '' : 'hidden'}>${inputRow('Fixed assignee', `<select class="input" name="fixed_user_id">${memberOptions(context.members, activity?.fixed_user_id)}</select>`)}</div>
    <fieldset class="automation-fieldset"><legend class="label">Required skills</legend>
      <div class="automation-skill-grid">${context.skills.map((skill) => `<label class="automation-check-row"><input type="checkbox" name="skill" value="${skill.id}" ${selectedSkills.has(Number(skill.id)) ? 'checked' : ''}> ${h(skill.name)}</label>`).join('') || '<small class="form-hint">Create skills first if this activity requires proficiency checks.</small>'}</div>
    </fieldset>
    ${inputRow('Supervision task title', `<input class="input" name="supervision_title_template" data-variable-mentions="activity-supervision" aria-autocomplete="list" aria-expanded="false" value="${h(activity?.supervision_title_template || 'Supervise {subject}: {activity}')}">`, 'Type @ to insert the person or Activity Template name. Used only when the person requires supervision.')}
    ${footer(activity ? 'Save activity' : 'Create activity')}
  </form>`;
  openModal({
    title: activity ? 'Edit activity template' : 'New activity template',
    content,
    size: 'lg',
    onSave(panel) {
      wireVariableMentions(panel);
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
          await refreshAutomationManager(manager, 'activities');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}

async function renderWorkflowsManager(body, manager) {
  const response = await api.get('/automation/admin/workflow-templates');
  const workflows = response.data ?? [];
  body.innerHTML = `${managerHeader('Workflow templates', 'automation-add-workflow', 'Add workflow')}
    <p class="form-hint automation-manager__hint">Workflows arrange reusable activities into an on-demand event. Enabled workflows appear in Quick Add.</p>
    <div class="automation-list">
      ${workflows.map((workflow) => `
        <div class="automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(workflow.name)}</strong><br><small class="form-hint">${workflow.steps?.length ?? 0} activities · ${workflow.quick_add_enabled ? 'Quick Add enabled' : 'hidden from Quick Add'}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-edit-workflow="${workflow.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-workflow="${workflow.id}" aria-label="Delete ${h(workflow.name)} Quick Add template">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No workflow templates yet.</p>'}
    </div>`;
  const context = {
    activities: response.activities ?? [],
    members: response.members ?? [],
    categories: response.categories ?? [],
    variables: response.variables ?? [],
  };
  body.querySelector('#automation-add-workflow')?.addEventListener('click', () => openWorkflowForm(null, context, manager));
  body.querySelectorAll('[data-edit-workflow]').forEach((button) => {
    button.addEventListener('click', () => openWorkflowForm(
      workflows.find((workflow) => Number(workflow.id) === Number(button.dataset.editWorkflow)),
      context,
      manager,
    ));
  });
  body.querySelectorAll('[data-delete-workflow]').forEach((button) => {
    button.addEventListener('click', () => {
      const workflow = workflows.find((row) => Number(row.id) === Number(button.dataset.deleteWorkflow));
      if (!workflow) return;
      deleteAutomationDefinition({
        name: workflow.name,
        noun: 'Quick Add template',
        path: `/automation/admin/workflow-templates/${workflow.id}`,
        tab: 'workflows',
        manager,
      });
    });
  });
}

let workflowDraftStepSequence = 0;
let workflowDraftVariableSequence = 0;

function newWorkflowVariableId() {
  workflowDraftVariableSequence += 1;
  return workflowDraftVariableSequence === 1 ? 'new_variable' : `new_variable_${workflowDraftVariableSequence}`;
}

function workflowVariableSlug(label) {
  const normalized = String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/g, '');
  if (!normalized) return 'new_variable';
  return /^[a-z]/.test(normalized) ? normalized : `value_${normalized}`;
}

function uniqueWorkflowVariableId(questions, currentRow, label) {
  const base = workflowVariableSlug(label);
  const used = new Set(
    [...questions.querySelectorAll('[data-workflow-question]')]
      .filter((row) => row !== currentRow)
      .map((row) => row.dataset.variableId),
  );
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function renameWorkflowDraftVariable(panel, row, nextId) {
  const previousId = row.dataset.variableId;
  if (!previousId || previousId === nextId) return;
  row.dataset.variableId = nextId;
  const token = row.querySelector('[data-variable-token]');
  if (token) token.textContent = `{{${nextId}}}`;

  panel.querySelectorAll('[data-variable-mentions]').forEach((field) => {
    const previousToken = `{{${previousId}}}`;
    if (!field.value.includes(previousToken)) return;
    field.value = field.value.replaceAll(previousToken, `{{${nextId}}}`);
  });
  panel.querySelectorAll('[data-step-subject-variable], [data-step-condition-variable]').forEach((select) => {
    [...select.options].forEach((option) => {
      if (option.value === previousId) option.value = nextId;
    });
  });
}

function workflowVariableOptions(questions, selected = '', { memberOnly = false } = {}) {
  return questions
    .filter((question) => !memberOnly || question.type === 'household_member')
    .map((question) => `<option value="${h(workflowVariableId(question))}" ${workflowVariableId(question) === selected ? 'selected' : ''}>${h(question.label || workflowVariableId(question))}</option>`)
    .join('');
}

function conditionValueHtml(variableId, value, questions, members) {
  const question = questions.find((item) => workflowVariableId(item) === variableId);
  const stringValue = value == null ? '' : String(value);
  if (question?.type === 'boolean') {
    return `<select class="input" data-step-condition-value><option value="false" ${stringValue === 'false' ? 'selected' : ''}>No</option><option value="true" ${stringValue === 'true' ? 'selected' : ''}>Yes</option></select>`;
  }
  if (question?.type === 'choice' || question?.type === 'select') {
    return `<select class="input" data-step-condition-value>${(question.options ?? []).map((option) => `<option value="${h(option)}" ${String(option) === stringValue ? 'selected' : ''}>${h(option)}</option>`).join('')}</select>`;
  }
  if (question?.type === 'household_member') {
    return `<select class="input" data-step-condition-value required>${memberOptions(members, Number(value), 'Choose a member…')}</select>`;
  }
  const type = ['number', 'date', 'time'].includes(question?.type) ? question.type : 'text';
  const required = variableId && type !== 'text' ? 'required' : '';
  return `<input class="input" type="${type}" data-step-condition-value placeholder="Equals" value="${h(stringValue)}" ${required}>`;
}

function workflowStepHtml(step, index, activities, questions, members) {
  const workflowKey = step?.step_key || `draft_${++workflowDraftStepSequence}`;
  const initialDependency = step?.depends_on?.[0] || '';
  const subjectVariableId = step?.subject_variable_id || '';
  const conditionVariableId = step?.condition?.variable_id || step?.condition?.input || '';
  const conditionValue = step?.condition && Object.hasOwn(step.condition, 'equals') ? step.condition.equals : '';
  return `<div class="automation-workflow-step" data-workflow-step data-workflow-key="${h(workflowKey)}" data-initial-dependency="${h(initialDependency)}">
    <div class="automation-workflow-step__header"><strong>Step ${index + 1}</strong><button type="button" class="btn btn--ghost btn--sm" data-remove-step>Remove</button></div>
    <select class="input" data-step-activity required>${activities.map((activity) => `<option value="${activity.id}" ${Number(step?.activity_template_id) === Number(activity.id) ? 'selected' : ''}>${h(activity.name)}</option>`).join('')}</select>
    <input class="input automation-workflow-step__control" data-step-title data-variable-mentions="workflow-step-title" aria-autocomplete="list" aria-expanded="false" placeholder="Optional task title override · type @ for variables" value="${h(step?.title_override || '')}">
    <textarea class="input automation-workflow-step__control" rows="2" data-step-description data-variable-mentions="workflow-step-description" aria-autocomplete="list" aria-expanded="false" placeholder="Optional task description override · type @ for variables">${h(step?.description_override || '')}</textarea>
    <select class="input automation-workflow-step__control" data-step-subject-variable>
      <option value="">Use the workflow subject</option>${workflowVariableOptions(questions, subjectVariableId, { memberOnly: true })}
    </select>
    <select class="input automation-workflow-step__control" data-step-dependency><option value="">No dependency</option></select>
    <div class="automation-workflow-condition">
      <select class="input" data-step-condition-variable><option value="">Always include</option>${workflowVariableOptions(questions, conditionVariableId)}</select>
      <div data-condition-value-slot>${conditionValueHtml(conditionVariableId, conditionValue, questions, members)}</div>
    </div>
  </div>`;
}

function questionHtml(question = {}, workflowId = null) {
  const existingVariableId = workflowVariableId(question);
  const variableId = existingVariableId || newWorkflowVariableId();
  const type = question.type === 'select' ? 'choice' : (question.type || 'text');
  return `<div class="automation-question-row" data-workflow-question data-variable-id="${h(variableId)}" data-variable-definition-id="${h(question.definition_id || '')}" data-reusable-definition-id="${h(question.reusable_definition_id || '')}" data-variable-id-auto="${existingVariableId ? 'false' : 'true'}">
    <code class="automation-variable-token" data-variable-token title="Readable key used by this workflow">{{${h(variableId)}}}</code>
    <input class="input" data-question-label placeholder="Question or variable name" aria-label="Question or variable name" value="${h(question.label || '')}">
    <select class="input" data-question-type>
      <option value="household_member" ${type === 'household_member' ? 'selected' : ''}>Household Member</option>
      <option value="boolean" ${type === 'boolean' ? 'selected' : ''}>Yes/No</option>
      <option value="choice" ${type === 'choice' ? 'selected' : ''}>Choice</option>
      <option value="text" ${type === 'text' ? 'selected' : ''}>Text</option>
      <option value="number" ${type === 'number' ? 'selected' : ''}>Number</option>
      <option value="date" ${type === 'date' ? 'selected' : ''}>Date</option>
      <option value="time" ${type === 'time' ? 'selected' : ''}>Time</option>
    </select>
    <div class="automation-question-actions">
      ${workflowId && question.definition_id && !question.reusable_definition_id ? `<button type="button" class="btn btn--ghost btn--sm btn--icon" data-promote-question title="Make reusable across the household" aria-label="Make ${h(question.label || variableId)} reusable"><i data-lucide="globe-2" class="icon-sm"></i></button>` : ''}
      ${question.reusable_definition_id ? '<span class="automation-variable-scope" title="Reusable household variable"><i data-lucide="globe-2" class="icon-sm"></i></span>' : ''}
      <button type="button" class="btn btn--ghost btn--sm" data-remove-question>Remove</button>
    </div>
    <input class="input automation-question-options" data-question-options placeholder="Choice options, comma separated" value="${h((question.options || []).join(', '))}" ${type === 'choice' ? '' : 'hidden'}>
  </div>`;
}

function openWorkflowForm(workflow, context, manager = null) {
  const content = `<form id="automation-workflow-form">
    ${inputRow('Workflow name', `<input class="input" name="name" data-variable-mentions="workflow" aria-autocomplete="list" aria-expanded="false" required value="${h(workflow?.name || '')}">`, 'Type @ to insert an answer from a workflow variable.')}
    ${inputRow('Description', `<textarea class="input" name="description" rows="2" data-variable-mentions="workflow" aria-autocomplete="list" aria-expanded="false">${h(workflow?.description || '')}</textarea>`, 'Type @ to insert an answer from a workflow variable.')}
    ${inputRow('Category', `<select class="input" name="category">${categoryOptions(context.categories, workflow?.category || 'misc')}</select>`)}
    <label class="automation-check-row"><input type="checkbox" name="subject_required" ${workflow?.subject_required !== 0 ? 'checked' : ''}> Ask which household member this is for</label>
    <label class="automation-check-row automation-check-row--section-end"><input type="checkbox" name="quick_add_enabled" ${workflow?.quick_add_enabled !== 0 ? 'checked' : ''}> Show in Quick Add</label>

    <div class="automation-workflow-step__header"><strong>Workflow questions and variables</strong><div class="automation-question-add"><select class="input" id="workflow-reusable-variable"><option value="">Reusable variable…</option>${(context.variables || []).map((variable) => `<option value="${variable.id}">${h(variable.label)} · {{${h(variable.variable_key)}}}</option>`).join('')}</select><button type="button" class="btn btn--ghost btn--sm" id="workflow-use-reusable">Use reusable</button><button type="button" class="btn btn--ghost btn--sm" id="workflow-add-question">Add local variable</button></div></div>
    <p class="form-hint automation-manager__hint">New IDs are generated from the variable name (for example, Day of Week becomes day_of_week). Duplicate names receive _2, _3, and so on. Once saved, IDs remain stable when display wording changes.</p>
    <div id="workflow-questions">${(workflow?.input_schema || []).map((question) => questionHtml(question, workflow?.id)).join('')}</div>

    <div class="automation-workflow-step__header automation-workflow-step__header--section"><strong>Activities</strong><button type="button" class="btn btn--ghost btn--sm" id="workflow-add-step">Add activity</button></div>
    <div id="workflow-steps">${(workflow?.steps?.length ? workflow.steps : [{}]).map((step, index) => workflowStepHtml(step, index, context.activities, workflow?.input_schema || [], context.members)).join('')}</div>
    ${footer(workflow ? 'Save workflow' : 'Create workflow')}
  </form>`;

  openModal({
    title: workflow ? 'Edit workflow template' : 'New workflow template',
    content,
    size: 'xl',
    onSave(panel) {
      wireVariableMentions(panel);
      const steps = panel.querySelector('#workflow-steps');
      const questions = panel.querySelector('#workflow-questions');

      const readQuestionDrafts = () => [...questions.querySelectorAll('[data-workflow-question]')].map((row) => {
        const type = row.querySelector('[data-question-type]').value;
        return {
          id: row.dataset.variableId,
          definition_id: Number(row.dataset.variableDefinitionId) || null,
          reusable_definition_id: Number(row.dataset.reusableDefinitionId) || null,
          label: row.querySelector('[data-question-label]').value.trim(),
          type,
          options: type === 'choice'
            ? row.querySelector('[data-question-options]').value.split(',').map((x) => x.trim()).filter(Boolean)
            : [],
        };
      });

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

      const refreshStepVariables = () => {
        const drafts = readQuestionDrafts();
        steps.querySelectorAll('[data-workflow-step]').forEach((row) => {
          const subjectSelect = row.querySelector('[data-step-subject-variable]');
          const conditionSelect = row.querySelector('[data-step-condition-variable]');
          const oldSubject = subjectSelect.value;
          const oldCondition = conditionSelect.value;
          const oldConditionValue = row.querySelector('[data-step-condition-value]')?.value ?? '';
          subjectSelect.innerHTML = '<option value="">Use the workflow subject</option>'
            + workflowVariableOptions(drafts, oldSubject, { memberOnly: true });
          conditionSelect.innerHTML = '<option value="">Always include</option>'
            + workflowVariableOptions(drafts, oldCondition);
          if ([...subjectSelect.options].some((option) => option.value === oldSubject)) subjectSelect.value = oldSubject;
          if ([...conditionSelect.options].some((option) => option.value === oldCondition)) conditionSelect.value = oldCondition;
          row.querySelector('[data-condition-value-slot]').innerHTML = conditionValueHtml(
            conditionSelect.value, oldConditionValue, drafts, context.members,
          );
        });
      };

      refreshStepDependencies();

      panel.querySelector('#workflow-add-step')?.addEventListener('click', () => {
        steps.insertAdjacentHTML('beforeend', workflowStepHtml(
          {}, steps.children.length, context.activities, readQuestionDrafts(), context.members,
        ));
        refreshStepDependencies();
      });
      steps.addEventListener('click', (event) => {
        if (event.target.closest('[data-remove-step]')) {
          event.target.closest('[data-workflow-step]').remove();
          refreshStepDependencies();
        }
      });
      panel.querySelector('#workflow-add-question')?.addEventListener('click', () => {
        questions.insertAdjacentHTML('beforeend', questionHtml({}, workflow?.id));
        refreshStepVariables();
      });
      panel.querySelector('#workflow-use-reusable')?.addEventListener('click', () => {
        const selectedId = Number(panel.querySelector('#workflow-reusable-variable')?.value);
        const variable = (context.variables || []).find((row) => Number(row.id) === selectedId);
        if (!variable) return;
        if ([...questions.querySelectorAll('[data-workflow-question]')].some((row) => row.dataset.variableId === variable.variable_key)) {
          toast('That reusable variable is already part of this workflow.', 'danger');
          return;
        }
        questions.insertAdjacentHTML('beforeend', questionHtml({
          id: variable.variable_key, label: variable.label, type: variable.type,
          options: variable.options || [], reusable_definition_id: variable.id,
        }, workflow?.id));
        refreshStepVariables();
        if (window.lucide) window.lucide.createIcons({ el: questions });
      });
      questions.addEventListener('click', (event) => {
        const promote = event.target.closest('[data-promote-question]');
        if (promote) {
          const row = promote.closest('[data-workflow-question]');
          const definitionId = Number(row?.dataset.variableDefinitionId);
          if (!workflow?.id || !definitionId) return;
          (async () => {
            const confirmed = await confirmOverModal('Make this a reusable household variable?', {
              confirmLabel: 'Make reusable',
              detail: 'The variable will appear in the Variable Manager and remain linked to this workflow. This promotion cannot be undone from the workflow editor.',
            });
            if (!confirmed) return;
            try {
              await api.post(`/automation/admin/workflow-templates/${workflow.id}/variables/${definitionId}/promote`, {});
              promote.outerHTML = '<span class="automation-variable-scope" title="Reusable household variable"><i data-lucide="globe-2" class="icon-sm"></i></span>';
              if (window.lucide) window.lucide.createIcons({ el: row });
              toast('Variable is now reusable across the household.');
            } catch (error) { toast(error.message, 'danger'); }
          })();
          return;
        }
        const remove = event.target.closest('[data-remove-question]');
        if (!remove) return;
        remove.closest('[data-workflow-question]')?.remove();
        refreshStepVariables();
      });
      questions.addEventListener('change', (event) => {
        const row = event.target.closest('[data-workflow-question]');
        if (!row) return;
        const type = row.querySelector('[data-question-type]').value;
        row.querySelector('[data-question-options]').hidden = type !== 'choice';
        refreshStepVariables();
      });
      questions.addEventListener('input', (event) => {
        if (event.target.matches('[data-question-label]')) {
          const row = event.target.closest('[data-workflow-question]');
          if (row?.dataset.variableIdAuto === 'true') {
            renameWorkflowDraftVariable(
              panel,
              row,
              uniqueWorkflowVariableId(questions, row, event.target.value),
            );
          }
          refreshStepVariables();
        }
      });
      steps.addEventListener('change', (event) => {
        const select = event.target.closest('[data-step-condition-variable]');
        if (!select) return;
        const row = select.closest('[data-workflow-step]');
        row.querySelector('[data-condition-value-slot]').innerHTML = conditionValueHtml(
          select.value, '', readQuestionDrafts(), context.members,
        );
      });

      panel.querySelector('#automation-workflow-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const inputSchema = readQuestionDrafts().filter((question) => question.id && question.label);

        const stepRows = [...steps.querySelectorAll('[data-workflow-step]')];
        const savedKeyByDraftKey = new Map(
          stepRows.map((row, index) => [row.dataset.workflowKey, `step_${index + 1}`]),
        );
        const questionsById = new Map(inputSchema.map((question) => [question.id, question]));
        const stepPayload = stepRows.map((row, index) => {
          const conditionVariableId = row.querySelector('[data-step-condition-variable]').value;
          const conditionValue = row.querySelector('[data-step-condition-value]').value;
          const dependencyDraftKey = row.querySelector('[data-step-dependency]').value;
          const dependency = dependencyDraftKey ? savedKeyByDraftKey.get(dependencyDraftKey) : null;
          return {
            step_key: `step_${index + 1}`,
            activity_template_id: Number(row.querySelector('[data-step-activity]').value),
            title_override: row.querySelector('[data-step-title]').value.trim() || null,
            description_override: row.querySelector('[data-step-description]').value.trim() || null,
            subject_variable_id: row.querySelector('[data-step-subject-variable]').value || null,
            depends_on: dependency ? [dependency] : [],
            condition: conditionVariableId ? {
              variable_id: conditionVariableId,
              equals: parseEquals(conditionValue, questionsById.get(conditionVariableId)?.type),
            } : null,
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
          await refreshAutomationManager(manager, 'workflows');
        } catch (error) { toast(error.message, 'danger'); }
      });
    },
  });
}
