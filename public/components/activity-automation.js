import { api } from '/api.js';
import { openModal, closeModal, confirmOverModal } from '/components/modal.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const h = (value) => esc(String(value ?? ''));

function replaceHtml(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('afterbegin', html);
}

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
  return [...panel.querySelectorAll('[data-workflow-question]')].flatMap((row, index) => {
    const id = row.dataset.variableId;
    const label = row.querySelector('[data-question-label]')?.value.trim() || `Variable ${index + 1}`;
    if (!id) return [];
    const base = [{ id, label, detail: id, token: `{{${id}}}` }];
    if (row.querySelector('[data-question-type]')?.value === 'location') {
      base.push(
        { id: `${id}.name`, label: `${label} name`, detail: `${id}.name`, token: `{{${id}.name}}` },
        { id: `${id}.parent`, label: `${label} parent`, detail: `${id}.parent`, token: `{{${id}.parent}}` },
        { id: `${id}.address`, label: `${label} address`, detail: `${id}.address`, token: `{{${id}.address}}` },
      );
    }
    return base;
  });
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
    replaceHtml(menu, active.options.map((option, index) => `
      <button type="button" role="option" id="automation-mention-${index}"
              aria-selected="${index === active.index}" data-mention-index="${index}"
              class="automation-mention-option ${index === active.index ? 'automation-mention-option--active' : ''}">
        <span>${h(option.label)}</span>
        <small>${h(option.detail)}</small>
      </button>`).join(''));
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

function placeOptions(places, selected = null, emptyLabel = 'Choose a Place…') {
  return `<option value="">${h(emptyLabel)}</option>${places.map((place) =>
    `<option value="${place.id}" ${Number(selected) === Number(place.id) ? 'selected' : ''} ${!place.active && Number(selected) !== Number(place.id) ? 'disabled' : ''}>${h(place.path_label || place.name)}${place.active ? '' : ' (inactive)'}</option>`
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
  if (type === 'household_member' || type === 'location' || type === 'number') return Number(raw);
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
    const places = response.places ?? [];
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
            if (template) openQuickAddTemplate(template, members, places, onCreated);
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

function renderRuntimeQuestion(question, members, places) {
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
  if (question.type === 'location') {
    return inputRow(label, `<select class="input" name="input_${key}" data-runtime-input="${key}" data-type="location" required>
      ${placeOptions(places)}
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
    else if (['household_member', 'location', 'number'].includes(field.dataset.type)) inputs[key] = Number(field.value);
    else inputs[key] = field.value;
  });
  return inputs;
}

function openQuickAddTemplate(template, members, places, onCreated) {
  const questions = Array.isArray(template.input_schema) ? template.input_schema : [];
  const content = `<form id="quick-add-form">
    ${template.description ? `<p class="form-hint automation-form-intro">${h(template.description)}</p>` : ''}
    ${template.subject_required ? inputRow(
      'Who is this for?',
      `<select class="input" id="quick-add-subject" required>${memberOptions(members)}</select>`,
    ) : ''}
    ${questions.map((question) => renderRuntimeQuestion(question, members, places)).join('')}
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
  replaceHtml(target, `
    <div class="automation-preview">
      ${preview.steps.map((step, index) => `
        <div class="automation-preview__step">
          <strong>${index + 1}.</strong>
          <div>
            <div>${h(step.title)}</div>
            <small class="form-hint">Assigned to ${h(step.assigned_to?.display_name || 'Unassigned')}${step.subject_proficiency ? ` · ${h(step.subject_proficiency)}` : ''}</small>
            ${step.place ? `<br><small class="form-hint">Place: ${h(step.place.path_label || step.place.name)} · ${h(step.presence_policy || 'ignore')}</small>` : (step.presence_policy && step.presence_policy !== 'ignore' ? `<br><small class="form-hint">Presence: ${h(step.presence_policy)}</small>` : '')}
            ${step.supervisor ? `<br><small class="form-hint">+ ${h(step.supervisor_title)} → ${h(step.supervisor.display_name)}</small>` : ''}
            ${step.depends_on?.length ? `<br><small class="form-hint">After: ${h(step.depends_on.join(', '))}</small>` : ''}
          </div>
        </div>`).join('')}
    </div>
    <button type="button" class="btn btn--primary automation-preview-create" id="quick-add-create">
      Create activities
    </button>`);
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
  ['places', 'Places'],
  ['availability', 'Availability'],
  ['trips', 'Trips'],
];

function validAutomationTab(tab) {
  return AUTOMATION_TABS.some(([key]) => key === tab) ? tab : 'skills';
}

export async function renderAutomationManager(container, { tab = 'skills', onTabChange = null } = {}) {
  const activeTab = validAutomationTab(tab);
  replaceHtml(container, `
    <div class="automation-manager">
      <div class="group-toggle automation-tabs" role="tablist" aria-label="Household automation sections">
        ${AUTOMATION_TABS.map(([key, label]) => `<button type="button" role="tab" aria-selected="${key === activeTab}" class="group-toggle__btn ${key === activeTab ? 'group-toggle__btn--active' : ''}" data-automation-tab="${key}">${h(label)}</button>`).join('')}
      </div>
      <div class="automation-manager__body"><p class="form-hint">Loading…</p></div>
    </div>`);

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
    else if (tab === 'variables') await renderVariablesManager(body, manager);
    else if (tab === 'places') await renderPlacesManager(body, manager);
    else if (tab === 'availability') await renderAvailabilityManager(body, manager);
    else await renderTripsManager(body, manager);
    if (window.lucide) window.lucide.createIcons({ el: body });
  } catch (error) {
    replaceHtml(body, `<p class="form-hint">${h(error.message || 'Could not load automation settings.')}</p>`);
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
    ['household_member', 'Household member'], ['location', 'Place / location'],
  ].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

async function renderVariablesManager(body, manager) {
  const response = await api.get('/automation/admin/variables');
  const variables = response.data ?? [];
  const context = response.context ?? [];
  replaceHtml(body, `${managerHeader('Reusable variables', 'automation-add-variable', 'Add variable')}
    <p class="form-hint automation-manager__hint">Define values and reusable fields once, then use the same readable ID across household templates. IDs stay stable unless an admin deliberately renames one.</p>
    <div class="automation-list">
      ${variables.map((variable) => `
        <div class="list-row automation-list-row">
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
      <div class="list-row automation-list-row"><div class="automation-list-row__copy"><strong>${h(variable.label)}</strong> <code class="automation-variable-token automation-variable-token--inline">{{${h(variable.key)}}}</code><br><small class="form-hint">${h(variable.description)}</small></div></div>`).join('')}</div>`);

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

function placeTypeOptions(selected = 'custom') {
  return [['home', 'Home'], ['room', 'Room / area'], ['school', 'School'], ['work', 'Workplace'],
    ['restaurant', 'Restaurant'], ['store', 'Store'], ['hotel', 'Hotel'],
    ['destination', 'Destination'], ['custom', 'Custom']]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

async function renderPlacesManager(body, manager) {
  const [response, searchResponse] = await Promise.all([
    api.get('/planning/admin/context'),
    api.get('/planning/place-search/status').catch(() => ({ data: { configured: false } })),
  ]);
  const places = response.places ?? [];
  const searchStatus = searchResponse.data || { configured: false };
  replaceHtml(body, `${managerHeader('Places address book', 'automation-add-place', 'Add address manually')}
    <p class="form-hint automation-manager__hint">Save Home, Work, schools, shops, restaurants, hotels, and other reusable locations here. Rename them freely; Tasks, Calendar events, templates, and schedules keep their links by ID.</p>
    <div class="detail-inline-actions" style="margin-bottom:var(--space-3)"><button type="button" class="btn btn--secondary btn--sm" id="automation-find-place" ${searchStatus.configured ? '' : 'disabled'}><i data-lucide="search" class="icon-sm"></i>Find with Google</button><span class="form-hint">${searchStatus.configured ? 'Search deliberately by name or category; no coordinates are required.' : 'Google search is not configured. Manual address entry still works.'}</span></div>
    <div class="automation-list">${places.map((place) => {
      const usage = Object.values(place.usage || {}).reduce((sum, count) => sum + Number(count || 0), 0);
      return `<div class="list-row automation-list-row">
        <div class="automation-list-row__copy"><strong>${h(place.path_label || place.name)}</strong><br><small class="form-hint">${h(place.type)}${place.city ? ` · ${h(place.city)}` : ''}${place.active ? '' : ' · inactive'}${usage ? ` · ${usage} linked record${usage === 1 ? '' : 's'}` : ''}</small></div>
        <div class="automation-list-row__actions">${placeMapsUrl(place) ? `<a class="btn btn--ghost btn--sm" href="${h(placeMapsUrl(place))}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>` : ''}<button type="button" class="btn btn--ghost btn--sm" data-edit-place="${place.id}">Edit</button><button type="button" class="btn btn--danger-ghost btn--sm" data-delete-place="${place.id}">Delete</button></div>
      </div>`;
    }).join('') || '<p class="form-hint">No Places yet. Start with Home, then add rooms or recurring destinations.</p>'}</div>`);
  body.querySelector('#automation-add-place')?.addEventListener('click', () => openPlaceForm(null, places, manager));
  body.querySelector('#automation-find-place')?.addEventListener('click', () => openPlaceSearchForm(places, manager));
  body.querySelectorAll('[data-edit-place]').forEach((button) => button.addEventListener('click', () => openPlaceForm(places.find((row) => Number(row.id) === Number(button.dataset.editPlace)), places, manager)));
  body.querySelectorAll('[data-delete-place]').forEach((button) => button.addEventListener('click', async () => {
    const place = places.find((row) => Number(row.id) === Number(button.dataset.deletePlace));
    if (!place || !await confirmOverModal(`Delete ${place.name}?`, { danger: true, confirmLabel: 'Delete Place', detail: t('settings.placeDeleteConfirmDetail') })) return;
    try { await api.delete(`/planning/admin/places/${place.id}`); toast('Place deleted.'); await refreshAutomationManager(manager, 'places'); }
    catch (error) { toast(error.message, 'danger'); }
  }));
}

function googleAttributionHtml(result) {
  const thirdParty = (result.attributions || []).map((attribution) => {
    const name = attribution?.displayName || attribution?.provider || attribution?.name;
    const uri = attribution?.uri || attribution?.providerUri;
    if (!name) return '';
    return typeof uri === 'string' && /^https:\/\//i.test(uri)
      ? `<a href="${h(uri)}" target="_blank" rel="noopener noreferrer">${h(name)}</a>` : h(name);
  }).filter(Boolean);
  return `<small class="form-hint">Results from Google Maps${thirdParty.length ? ` · Attribution: ${thirdParty.join(', ')}` : ''}</small>`;
}

function openPlaceSearchForm(places, manager) {
  const origin = places.find((place) => place.type === 'home') || places[0];
  const content = `<form id="automation-place-search-form">
    ${inputRow('What are you looking for?', '<input class="input" name="query" minlength="3" maxlength="120" required placeholder="UPS Store, pharmacy, restaurant, dentist">')}
    ${inputRow('Search area', `<select class="input" name="origin_mode"><option value="saved">Near a saved Place</option><option value="text">Near an address, city, or ZIP</option><option value="anywhere">No specific origin</option></select>`)}
    <div data-place-search-origin="saved">${inputRow('Saved Place', `<select class="input" name="origin_place_id"><option value="">Choose a Place</option>${placeOptions(places, origin?.id)}</select>`)}</div>
    <div data-place-search-origin="text" hidden>${inputRow('Address, city, or ZIP', '<input class="input" name="origin_text" maxlength="160" placeholder="27513 or Raleigh, NC">')}</div>
    <p class="form-hint">Your search and selected origin are sent to Google only when you press Search. Results are not saved until you choose one.</p>
    <div class="detail-inline-actions"><button class="btn btn--primary" type="submit"><i data-lucide="search" class="icon-sm"></i>Search Google Places</button><button class="btn btn--secondary" type="button" data-action="close-modal">Cancel</button></div>
    <p class="form-hint" data-place-search-status></p><div class="automation-list" data-place-search-results></div>
  </form>`;
  openModal({ title: 'Find a Place', content, size: 'lg', onSave(panel) {
    const form = panel.querySelector('#automation-place-search-form');
    const mode = form.querySelector('[name="origin_mode"]');
    const refresh = () => form.querySelectorAll('[data-place-search-origin]').forEach((pane) => { pane.hidden = pane.dataset.placeSearchOrigin !== mode.value; });
    mode.addEventListener('change', refresh); refresh();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form); const status = form.querySelector('[data-place-search-status]');
      const submit = form.querySelector('[type="submit"]');
      const payload = { query: data.get('query') };
      if (mode.value === 'saved') payload.origin_place_id = Number(data.get('origin_place_id')) || null;
      else if (mode.value === 'text') payload.origin_text = String(data.get('origin_text') || '').trim() || null;
      submit.disabled = true; status.textContent = 'Searching Google Places…';
      try {
        const response = await api.post('/planning/place-search', payload); const results = response.data || [];
        const list = form.querySelector('[data-place-search-results]'); replaceHtml(list, results.map((result, index) => `<div class="list-row automation-list-row"><div class="automation-list-row__copy"><strong>${h(result.display_name)}</strong><br><small class="form-hint">${h(result.formatted_address || '')}${result.primary_type ? ` · ${h(result.primary_type)}` : ''}</small><br>${googleAttributionHtml(result)}<input class="input" data-place-name="${index}" maxlength="120" value="${h(result.display_name)}" aria-label="Saved Place name"></div><div class="automation-list-row__actions"><button class="btn btn--primary btn--sm" type="button" data-save-google-place="${index}">Save to address book</button></div></div>`).join('') || '<p class="form-hint">No matching places found.</p>');
        status.textContent = results.length ? `${results.length} live result${results.length === 1 ? '' : 's'} from Google.` : '';
        list.querySelectorAll('[data-save-google-place]').forEach((button) => button.addEventListener('click', async () => {
          const index = Number(button.dataset.saveGooglePlace); const result = results[index];
          const name = list.querySelector(`[data-place-name="${index}"]`)?.value.trim();
          if (!name) { status.textContent = 'Give this saved Place a name.'; return; }
          button.disabled = true;
          try {
            await api.post('/planning/admin/places/from-google', { external_place_id: result.external_place_id, name, type: 'custom', latitude: result.latitude, longitude: result.longitude });
            toast('Place saved to the address book.'); await closeModal({ force: true }); await refreshAutomationManager(manager, 'places');
          } catch (error) { status.textContent = error.message; button.disabled = false; }
        }));
      } catch (error) { status.textContent = error.message; }
      finally { submit.disabled = false; }
    });
  } });
}

function placeMapsUrl(place) {
  const params = new URLSearchParams({ api: '1' });
  if (place?.external_place_id) {
    params.set('query', place.name || 'Google Maps place'); params.set('query_place_id', place.external_place_id);
  } else if (place?.latitude != null && place?.longitude != null) params.set('query', `${place.latitude},${place.longitude}`);
  else {
    const address = [place?.street_address, place?.city, place?.region, place?.postal_code, place?.country].filter(Boolean).join(', ');
    if (!address) return null; params.set('query', address);
  }
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

const TRIP_TASKS = [
  ['before_departure', 'Pack clothing'], ['before_departure', 'Pack medications'],
  ['before_departure', 'Charge devices'], ['departure', 'Load the vehicle'],
  ['departure', 'Lock up and set the thermostat'], ['during_trip', 'Check in'],
  ['during_trip', "Review today's itinerary"], ['during_trip', 'Prepare for the next day'],
  ['before_return', 'Pack the lodging'], ['before_return', 'Check for forgotten items'],
  ['post_trip', 'Unpack'], ['post_trip', 'Start travel laundry'],
];

async function renderTripsManager(body, manager) {
  const [tripsResponse, context] = await Promise.all([api.get('/planning/trips'), api.get('/planning/admin/context')]);
  const trips = tripsResponse.data || [];
  replaceHtml(body, `${managerHeader('Trips and itineraries', 'automation-add-trip', 'Plan trip')}
    <p class="form-hint automation-manager__hint">Coordinate travelers, destination and lodging Places, Away periods, arrival/departure stages, and phase-relative Tasks. Trip stages also appear on the main Calendar.</p>
    <div class="automation-list">${trips.map((trip) => `<section class="list-row automation-list-row" data-trip-row="${trip.id}"><div class="automation-list-row__copy"><strong>${h(trip.name)}</strong><br><small class="form-hint">${h(trip.trip_type)} • ${h(trip.starts_at)} → ${h(trip.ends_at)}${trip.destination_name ? ` • ${h(trip.destination_name)}` : ''} • ${trip.participants.length} traveler${trip.participants.length === 1 ? '' : 's'} • ${h(trip.status)}</small><div data-trip-itinerary="${trip.id}"></div></div><div class="automation-list-row__actions"><button class="btn btn--ghost btn--sm" type="button" data-view-trip="${trip.id}">Itinerary</button><button class="btn btn--ghost btn--sm" type="button" data-edit-trip="${trip.id}">Edit</button><button class="btn btn--danger-ghost btn--sm" type="button" data-delete-trip="${trip.id}">Delete</button></div></section>`).join('') || '<p class="form-hint">No trips planned yet.</p>'}</div>`);
  body.querySelector('#automation-add-trip')?.addEventListener('click', () => openTripForm(null, context, manager));
  body.querySelectorAll('[data-edit-trip]').forEach((button) => button.addEventListener('click', () => openTripForm(trips.find((trip) => Number(trip.id) === Number(button.dataset.editTrip)), context, manager)));
  body.querySelectorAll('[data-delete-trip]').forEach((button) => button.addEventListener('click', async () => {
    const trip = trips.find((item) => Number(item.id) === Number(button.dataset.deleteTrip));
    if (!trip || !await confirmOverModal(`Delete ${trip.name}?`, { danger: true, confirmLabel: 'Delete trip', detail: t('settings.tripDeleteConfirmDetail') })) return;
    try { await api.delete(`/planning/admin/trips/${trip.id}`); toast('Trip deleted.'); await refreshAutomationManager(manager, 'trips'); }
    catch (error) { toast(error.message, 'danger'); }
  }));
  body.querySelectorAll('[data-view-trip]').forEach((button) => button.addEventListener('click', async () => {
    const target = body.querySelector(`[data-trip-itinerary="${button.dataset.viewTrip}"]`);
    if (target.dataset.loaded === '1') { target.hidden = !target.hidden; return; }
    button.disabled = true;
    try {
      const response = await api.get(`/planning/trips/${button.dataset.viewTrip}/itinerary`);
      const days = response.data?.days || {};
      target.insertAdjacentHTML('beforeend', `<div class="automation-workflow-condition" style="margin-top:var(--space-3)">${Object.entries(days).map(([date, day]) => `<div><strong>${h(date)}</strong><ul>${day.stages.map((item) => `<li>${h(item.title)}</li>`).join('')}${day.events.map((item) => `<li>Calendar: ${h(item.title)}</li>`).join('')}${day.meals.map((item) => `<li>Meal: ${h(item.title)}</li>`).join('')}${day.tasks.map((item) => `<li>Task: ${h(item.title)}</li>`).join('')}</ul></div>`).join('') || '<p class="form-hint">No itinerary items in the travel window.</p>'}</div>`);
      target.dataset.loaded = '1';
    } catch (error) { target.textContent = error.message; }
    finally { button.disabled = false; }
  }));
}

function openTripForm(trip, context, manager) {
  const members = context.members || []; const places = context.places || [];
  const selected = new Set((trip?.participant_ids || []).map(Number));
  const content = `<form id="automation-trip-form">
    ${inputRow('Trip name', `<input class="input" name="name" required maxlength="120" value="${h(trip?.name || '')}" placeholder="Summer vacation">`)}
    <div class="automation-workflow-condition">${inputRow('Trip type', `<select class="input" name="trip_type">${[['vacation','Vacation'],['business','Business'],['family','Family visit'],['road_trip','Road trip'],['other','Other']].map(([value,label]) => `<option value="${value}" ${trip?.trip_type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}${inputRow('Status', `<select class="input" name="status">${['planning','active','completed','cancelled'].map((value) => `<option value="${value}" ${trip?.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`)}</div>
    <fieldset class="automation-fieldset"><legend class="label">Travelers</legend>${members.map((member) => `<label class="automation-check-row"><input type="checkbox" name="participant_id" value="${member.id}" ${selected.has(Number(member.id)) ? 'checked' : ''}>${h(member.display_name)}</label>`).join('')}</fieldset>
    <div class="automation-workflow-condition">${inputRow('Destination Place', `<select class="input" name="destination_place_id">${placeOptions(places, trip?.destination_place_id, 'No saved destination')}</select>`)}${inputRow('Lodging Place', `<select class="input" name="lodging_place_id">${placeOptions(places, trip?.lodging_place_id, 'No saved lodging')}</select>`)}</div>
    <div class="automation-workflow-condition">${inputRow('Departure', `<input class="input" type="datetime-local" name="starts_at" required value="${h(localDateTimeValue(trip?.starts_at))}">`)}${inputRow('Return', `<input class="input" type="datetime-local" name="ends_at" required value="${h(localDateTimeValue(trip?.ends_at))}">`)}</div>
    ${inputRow('Notes', `<textarea class="input" name="notes" rows="3">${h(trip?.notes || '')}</textarea>`)}
    <label class="automation-check-row"><input type="checkbox" name="create_away_periods" ${trip?.create_away_periods !== 0 ? 'checked' : ''}> Create matching Away periods for travelers</label>
    <fieldset class="automation-fieldset"><legend class="label">Create optional trip Tasks</legend><p class="form-hint">Tasks are dated relative to the trip phase and linked to the relevant saved Place.</p>${TRIP_TASKS.map(([phase,title], index) => `<label class="automation-check-row"><input type="checkbox" name="trip_task" value="${index}">${h(title)} <small class="form-hint">(${h(phase.replaceAll('_',' '))})</small></label>`).join('')}</fieldset>
    ${footer(trip ? 'Save trip' : 'Create trip')}
  </form>`;
  openModal({ title: trip ? 'Edit trip' : 'Plan a trip', content, size: 'lg', onSave(panel) {
    panel.querySelector('#automation-trip-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      const payload = { name: data.get('name'), trip_type: data.get('trip_type'), status: data.get('status'), participant_ids: data.getAll('participant_id').map(Number), destination_place_id: Number(data.get('destination_place_id')) || null, lodging_place_id: Number(data.get('lodging_place_id')) || null, starts_at: data.get('starts_at'), ends_at: data.get('ends_at'), notes: data.get('notes'), create_away_periods: data.has('create_away_periods'), tasks: data.getAll('trip_task').map((index) => ({ phase: TRIP_TASKS[Number(index)][0], title: TRIP_TASKS[Number(index)][1] })) };
      try { if (trip) await api.put(`/planning/admin/trips/${trip.id}`, payload); else await api.post('/planning/admin/trips', payload); toast('Trip saved.'); await refreshAutomationManager(manager, 'trips'); }
      catch (error) { toast(error.message, 'danger'); }
    });
  }});
}

function openPlaceForm(place, places, manager) {
  const parents = places.filter((candidate) => Number(candidate.id) !== Number(place?.id));
  const content = `<form id="automation-place-form">
    ${inputRow('Name', `<input class="input" name="name" required maxlength="120" value="${h(place?.name || '')}">`)}
    ${inputRow('Type', `<select class="input" name="type">${placeTypeOptions(place?.type)}</select>`)}
    ${inputRow('Parent Place', `<select class="input" name="parent_place_id">${placeOptions(parents, place?.parent_place_id, 'No parent')}</select>`, 'Rooms and areas inherit missing address details from their parent.')}
    ${inputRow('Description', `<textarea class="input" name="description" rows="2">${h(place?.description || '')}</textarea>`)}
    <div class="automation-workflow-condition">${inputRow('Street address', `<input class="input" name="street_address" value="${h(place?.street_address || '')}">`)}${inputRow('City', `<input class="input" name="city" value="${h(place?.city || '')}">`)}</div>
    <div class="automation-workflow-condition">${inputRow('State / province', `<input class="input" name="region" value="${h(place?.region || '')}">`)}${inputRow('Postal code', `<input class="input" name="postal_code" value="${h(place?.postal_code || '')}">`)}</div>
    ${inputRow('Country', `<input class="input" name="country" value="${h(place?.country || '')}">`)}
    <details><summary class="form-hint">Advanced coordinates (optional)</summary><div class="automation-workflow-condition">${inputRow('Latitude', `<input class="input" name="latitude" type="number" min="-90" max="90" step="any" value="${h(place?.latitude ?? '')}">`)}${inputRow('Longitude', `<input class="input" name="longitude" type="number" min="-180" max="180" step="any" value="${h(place?.longitude ?? '')}">`)}</div></details>
    <label class="automation-check-row"><input type="checkbox" name="active" ${place?.active !== 0 ? 'checked' : ''}> Active and available for new schedules</label>${footer(place ? 'Save Place' : 'Create Place')}
  </form>`;
  openModal({ title: place ? 'Edit Place' : 'New Place', content, size: 'lg', onSave(panel) {
    panel.querySelector('#automation-place-form')?.addEventListener('submit', async (event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      const payload = Object.fromEntries(['name', 'type', 'description', 'street_address', 'city', 'region', 'postal_code', 'country'].map((key) => [key, data.get(key)]));
      payload.parent_place_id = Number(data.get('parent_place_id')) || null;
      payload.latitude = data.get('latitude') === '' ? null : Number(data.get('latitude'));
      payload.longitude = data.get('longitude') === '' ? null : Number(data.get('longitude'));
      payload.active = data.has('active');
      try { if (place) await api.put(`/planning/admin/places/${place.id}`, payload); else await api.post('/planning/admin/places', payload); toast('Place saved.'); await refreshAutomationManager(manager, 'places'); }
      catch (error) { toast(error.message, 'danger'); }
    });
  } });
}

const WEEKDAYS = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];

function availabilityStateOptions(selected = 'available') {
  return [['available', 'Available'], ['away', 'Away'], ['busy', 'Busy'], ['unknown', 'Unknown'], ['custom', 'Custom']]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function availabilityCategoryOptions(selected = 'general') {
  return [['general', 'General'], ['school', 'School'], ['work', 'Work'], ['custody', 'Custody'], ['vacation', 'Vacation'], ['travel', 'Travel']]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function localDateTimeValue(value) { return value ? String(value).slice(0, 16) : ''; }

async function renderAvailabilityManager(body, manager) {
  const response = await api.get('/planning/admin/context');
  const { rules = [], periods = [], members = [], places = [] } = response;
  const now = new Date().toISOString();
  const snapshots = await Promise.all(members.map(async (member) => {
    try { return { member, value: (await api.get(`/planning/presence/${member.id}?start_at=${encodeURIComponent(now)}&end_at=${encodeURIComponent(now)}`)).data }; }
    catch { return { member, value: null }; }
  }));
  replaceHtml(body, `${managerHeader('Availability and Presence', 'automation-add-rule', 'Add weekly rule')}
    <p class="form-hint automation-manager__hint">Manual overrides win over dated exceptions, workflow signals, recurring rules, and advisory Calendar events. Presence is evaluated for the activity’s useful time window—not merely where someone is now.</p>
    <div class="automation-manager__header automation-workflow-step__header--section"><strong>Current household snapshot</strong><span></span></div>
    <div class="automation-presence-grid">${snapshots.map(({ member, value }) => `<div class="automation-presence-card"><strong>${h(member.display_name)}</strong><span>${h(value?.effective?.custom_state || value?.effective?.state || 'Unknown')}</span><small>${h(value?.effective?.place?.path_label || value?.effective?.place_name || value?.effective?.source || 'No active signal')}</small></div>`).join('')}</div>
    <div class="automation-manager__header automation-workflow-step__header--section"><strong>Weekly schedules</strong><span></span></div>
    <div class="automation-list">${rules.map((rule) => `<div class="list-row automation-list-row"><div class="automation-list-row__copy"><strong>${h(rule.display_name)} · ${h(rule.name)}</strong><br><small class="form-hint">${rule.weekdays.map((day) => WEEKDAYS.find((item) => item[1] === day)?.[0]).filter(Boolean).join(', ')} · ${h(rule.start_time)}–${h(rule.end_time)} · ${h(rule.custom_state || rule.state)}${rule.place_name ? ` at ${h(rule.place_name)}` : ''}${rule.active ? '' : ' · inactive'}</small></div><div class="automation-list-row__actions"><button type="button" class="btn btn--ghost btn--sm" data-edit-rule="${rule.id}">Edit</button><button type="button" class="btn btn--danger-ghost btn--sm" data-delete-rule="${rule.id}">Delete</button></div></div>`).join('') || '<p class="form-hint">No recurring availability rules yet.</p>'}</div>
    <div class="automation-manager__header automation-workflow-step__header--section"><strong>Dated exceptions and manual overrides</strong><button type="button" class="btn btn--secondary btn--sm" id="automation-add-period"><i data-lucide="calendar-plus" class="icon-md"></i>Add dated period</button></div>
    <div class="automation-list">${periods.map((period) => `<div class="list-row automation-list-row"><div class="automation-list-row__copy"><strong>${h(period.display_name)} · ${h(period.custom_state || period.state)}</strong><br><small class="form-hint">${h(period.source)} · ${h(period.starts_at)}${period.ends_at ? ` → ${h(period.ends_at)}` : ' · until changed'}${period.place_name ? ` · ${h(period.place_name)}` : ''}</small></div><div class="automation-list-row__actions"><button type="button" class="btn btn--ghost btn--sm" data-edit-period="${period.id}">Edit</button><button type="button" class="btn btn--danger-ghost btn--sm" data-delete-period="${period.id}">Delete</button></div></div>`).join('') || '<p class="form-hint">No dated exceptions or manual overrides yet.</p>'}</div>`);
  body.querySelector('#automation-add-rule')?.addEventListener('click', () => openAvailabilityRuleForm(null, { members, places }, manager));
  body.querySelector('#automation-add-period')?.addEventListener('click', () => openAvailabilityPeriodForm(null, { members, places }, manager));
  body.querySelectorAll('[data-edit-rule]').forEach((button) => button.addEventListener('click', () => openAvailabilityRuleForm(rules.find((row) => Number(row.id) === Number(button.dataset.editRule)), { members, places }, manager)));
  body.querySelectorAll('[data-edit-period]').forEach((button) => button.addEventListener('click', () => openAvailabilityPeriodForm(periods.find((row) => Number(row.id) === Number(button.dataset.editPeriod)), { members, places }, manager)));
  const wireDelete = (selector, rows, dataKey, path) => body.querySelectorAll(selector).forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((item) => Number(item.id) === Number(button.dataset[dataKey]));
    if (!row || !await confirmOverModal('Delete this availability entry?', { danger: true, confirmLabel: 'Delete', detail: t('settings.availabilityDeleteConfirmDetail') })) return;
    try { await api.delete(`/planning/admin/${path}/${row.id}`); toast('Availability entry deleted.'); await refreshAutomationManager(manager, 'availability'); }
    catch (error) { toast(error.message, 'danger'); }
  }));
  wireDelete('[data-delete-rule]', rules, 'deleteRule', 'rules'); wireDelete('[data-delete-period]', periods, 'deletePeriod', 'periods');
}

function wireCustomState(panel) {
  const select = panel.querySelector('[name="state"]'); const row = panel.querySelector('[data-custom-state]');
  const refresh = () => { if (row) row.hidden = select?.value !== 'custom'; };
  select?.addEventListener('change', refresh); refresh();
}

function openAvailabilityRuleForm(rule, context, manager) {
  const selectedDays = new Set((rule?.weekdays || []).map(Number));
  const content = `<form id="automation-rule-form">
    ${inputRow('Household member', `<select class="input" name="user_id" required>${memberOptions(context.members, rule?.user_id)}</select>`)}${inputRow('Schedule name', `<input class="input" name="name" required value="${h(rule?.name || '')}" placeholder="School hours">`)}
    <fieldset class="automation-fieldset"><legend class="label">Days</legend><div class="automation-weekday-grid">${WEEKDAYS.map(([label, day]) => `<label class="automation-check-row"><input type="checkbox" name="weekday" value="${day}" ${selectedDays.has(day) ? 'checked' : ''}>${label}</label>`).join('')}</div></fieldset>
    <div class="automation-workflow-condition">${inputRow('Start time', `<input class="input" type="time" name="start_time" required value="${h(rule?.start_time || '09:00')}">`)}${inputRow('End time', `<input class="input" type="time" name="end_time" required value="${h(rule?.end_time || '17:00')}">`)}</div>
    <div class="automation-workflow-condition">${inputRow('State', `<select class="input" name="state">${availabilityStateOptions(rule?.state)}</select>`)}${inputRow('Category', `<select class="input" name="category">${availabilityCategoryOptions(rule?.category)}</select>`)}</div>
    <div data-custom-state>${inputRow('Custom state name', `<input class="input" name="custom_state" value="${h(rule?.custom_state || '')}">`)}</div>${inputRow('Place', `<select class="input" name="place_id">${placeOptions(context.places, rule?.place_id, 'No specific Place')}</select>`)}
    <label class="automation-check-row"><input type="checkbox" name="active" ${rule?.active !== 0 ? 'checked' : ''}> Active</label>${footer(rule ? 'Save weekly rule' : 'Create weekly rule')}</form>`;
  openModal({ title: rule ? 'Edit weekly availability' : 'New weekly availability', content, size: 'lg', onSave(panel) { wireCustomState(panel); panel.querySelector('#automation-rule-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const payload = { user_id: Number(data.get('user_id')), name: data.get('name'), weekdays: data.getAll('weekday').map(Number), start_time: data.get('start_time'), end_time: data.get('end_time'), state: data.get('state'), custom_state: data.get('custom_state'), category: data.get('category'), place_id: Number(data.get('place_id')) || null, active: data.has('active') };
    try { if (rule) await api.put(`/planning/admin/rules/${rule.id}`, payload); else await api.post('/planning/admin/rules', payload); toast('Weekly availability saved.'); await refreshAutomationManager(manager, 'availability'); } catch (error) { toast(error.message, 'danger'); }
  }); } });
}

function openAvailabilityPeriodForm(period, context, manager) {
  const content = `<form id="automation-period-form">${inputRow('Household member', `<select class="input" name="user_id" required>${memberOptions(context.members, period?.user_id)}</select>`)}
    <div class="automation-workflow-condition">${inputRow('Entry type', `<select class="input" name="source"><option value="explicit" ${period?.source !== 'manual' ? 'selected' : ''}>Dated exception</option><option value="manual" ${period?.source === 'manual' ? 'selected' : ''}>Manual override</option></select>`)}${inputRow('Category', `<select class="input" name="category">${availabilityCategoryOptions(period?.category)}</select>`)}</div>
    <div class="automation-workflow-condition">${inputRow('Starts', `<input class="input" type="datetime-local" name="starts_at" required value="${h(localDateTimeValue(period?.starts_at) || localDateTimeValue(new Date().toISOString()))}">`)}${inputRow('Ends / expires', `<input class="input" type="datetime-local" name="ends_at" value="${h(localDateTimeValue(period?.ends_at))}">`, 'Optional for a manual override.')}</div>
    <div class="automation-workflow-condition">${inputRow('State', `<select class="input" name="state">${availabilityStateOptions(period?.state || 'away')}</select>`)}${inputRow('Place', `<select class="input" name="place_id">${placeOptions(context.places, period?.place_id, 'No specific Place')}</select>`)}</div>
    <div data-custom-state>${inputRow('Custom state name', `<input class="input" name="custom_state" value="${h(period?.custom_state || '')}">`)}</div>${inputRow('Note', `<textarea class="input" name="note" rows="2">${h(period?.note || '')}</textarea>`)}
    <label class="automation-check-row"><input type="checkbox" name="active" ${period?.active !== 0 ? 'checked' : ''}> Active</label>${footer(period ? 'Save dated period' : 'Create dated period')}</form>`;
  openModal({ title: period ? 'Edit availability period' : 'New availability period', content, size: 'lg', onSave(panel) { wireCustomState(panel); panel.querySelector('#automation-period-form')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const payload = { user_id: Number(data.get('user_id')), source: data.get('source'), category: data.get('category'), state: data.get('state'), custom_state: data.get('custom_state'), place_id: Number(data.get('place_id')) || null, starts_at: data.get('starts_at'), ends_at: data.get('ends_at') || null, note: data.get('note'), active: data.has('active') };
    try { if (period) await api.put(`/planning/admin/periods/${period.id}`, payload); else await api.post('/planning/admin/periods', payload); toast('Availability period saved.'); await refreshAutomationManager(manager, 'availability'); } catch (error) { toast(error.message, 'danger'); }
  }); } });
}

async function renderSkillsManager(body, manager) {
  const response = await api.get('/automation/admin/skills');
  const skills = response.data ?? [];
  replaceHtml(body, `${managerHeader('Reusable skills', 'automation-add-skill', 'Add skill')}
    <p class="form-hint automation-manager__hint">Age provides the automatic baseline. Admin overrides on each member take precedence, except adult-only safety rules.</p>
    <div class="automation-list">
      ${skills.map((skill) => `
        <div class="list-row automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(skill.name)}</strong><br><small class="form-hint">Min age: ${skill.minimum_age ?? 0} · age → ${h(skill.age_promotion)}${skill.adult_only ? ' · adult only' : ''}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-skill-members="${skill.id}">Proficiency</button>
            <button type="button" class="btn btn--ghost btn--sm" data-edit-skill="${skill.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-skill="${skill.id}" aria-label="Delete ${h(skill.name)} skill">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No skills yet.</p>'}
    </div>`);
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
  replaceHtml(body, `${managerHeader('Activity templates', 'automation-add-activity', 'Add activity')}
    <p class="form-hint automation-manager__hint">Activities define work, required skills and how Yuvomi chooses an assignee.</p>
    <div class="automation-list">
      ${activities.map((activity) => `
        <div class="list-row automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(activity.name)}</strong><br><small class="form-hint">${h(activity.assignment_policy || activity.assignment_strategy)} · ${(activity.skills ?? []).map((skill) => h(skill.name)).join(', ') || 'no skill requirement'}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-edit-activity="${activity.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-activity="${activity.id}" aria-label="Delete ${h(activity.name)} activity template">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No activity templates yet.</p>'}
    </div>`);
  const context = { skills: response.skills ?? [], members: response.members ?? [], categories: response.categories ?? [], variables: response.variables ?? [], places: response.places ?? [] };
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
  const strategy = activity?.assignment_policy || activity?.assignment_strategy || 'subject_skill';
  const locationMode = activity?.location_mode || 'none';
  const content = `<form id="automation-activity-form">
    ${inputRow('Template name', `<input class="input" name="name" required value="${h(activity?.name || '')}">`, 'The reusable name shown in the Activity Template library.')}
    ${inputRow('Generated task title', `<input class="input" name="title_template" data-variable-mentions="activity-title" aria-autocomplete="list" aria-expanded="false" required value="${h(activity?.title_template || activity?.name || '')}">`, 'The title created on the actual task. Type @ to insert the person or Activity Template name.')}
    ${inputRow('Description / instructions', `<textarea class="input" name="description" rows="3" data-variable-mentions="activity-description" aria-autocomplete="list" aria-expanded="false">${h(activity?.description || '')}</textarea>`, 'Type @ to insert the person or Activity Template name.')}
    ${inputRow('Category', `<select class="input" name="category">${categoryOptions(context.categories, activity?.category || 'misc')}</select>`)}
    ${inputRow('Assignment strategy', `<select class="input" name="assignment_strategy" id="automation-assignment-strategy">
      <option value="subject_skill" ${strategy === 'subject_skill' ? 'selected' : ''}>Person or qualified helper, based on proficiency</option>
      <option value="eligible_round_robin" ${strategy === 'eligible_round_robin' ? 'selected' : ''}>Eligible round robin</option>
      <option value="eligible_random" ${strategy === 'eligible_random' ? 'selected' : ''}>Random eligible member</option>
      <option value="open_claimable" ${strategy === 'open_claimable' ? 'selected' : ''}>Open / claimable</option>
      <option value="rotating_multi" ${strategy === 'rotating_multi' ? 'selected' : ''}>Rotating group</option>
      <option value="fixed" ${strategy === 'fixed' ? 'selected' : ''}>Fixed household member</option>
    </select>`)}
    <label class="automation-check-row"><input type="checkbox" name="subject_required" ${activity?.subject_required !== 0 ? 'checked' : ''}> Requires a person this activity is for</label>
    <div id="automation-fixed-user" ${strategy === 'fixed' ? '' : 'hidden'}>${inputRow('Fixed assignee', `<select class="input" name="fixed_user_id">${memberOptions(context.members, activity?.fixed_user_id)}</select>`)}</div>
    <div id="automation-participant-count" ${strategy === 'rotating_multi' ? '' : 'hidden'}>${inputRow('People per occurrence', `<input class="input" type="number" name="participant_count" min="1" max="50" value="${Number(activity?.participant_count || 2)}">`, 'The first person owns the task; everyone selected is recorded as a participant.')}</div>
    <div id="automation-rotation-group" ${['eligible_round_robin', 'rotating_multi'].includes(strategy) ? '' : 'hidden'}>${inputRow('Rotation group', `<input class="input" name="rotation_group" maxlength="100" value="${h(activity?.rotation_group || '')}">`, 'Optional. Activities with the same group share one rotation cursor.')}</div>
    <label class="automation-check-row"><input type="checkbox" name="allow_assignment_override" ${activity?.allow_assignment_override !== 0 ? 'checked' : ''}> Allow an admin to reassign this activity</label>
    <fieldset class="automation-fieldset"><legend class="label">Required skills</legend>
      <div class="automation-skill-grid">${context.skills.map((skill) => `<label class="automation-check-row"><input type="checkbox" name="skill" value="${skill.id}" ${selectedSkills.has(Number(skill.id)) ? 'checked' : ''}> ${h(skill.name)}</label>`).join('') || '<small class="form-hint">Create skills first if this activity requires proficiency checks.</small>'}</div>
    </fieldset>
    ${inputRow('Location', `<select class="input" name="location_mode" id="automation-location-mode"><option value="none" ${locationMode === 'none' ? 'selected' : ''}>No required location</option><option value="fixed" ${locationMode === 'fixed' ? 'selected' : ''}>Fixed Place</option><option value="workflow" ${locationMode === 'workflow' ? 'selected' : ''}>Place chosen by a workflow variable</option></select>`)}
    <div id="automation-fixed-place" ${locationMode === 'fixed' ? '' : 'hidden'}>${inputRow('Fixed Place', `<select class="input" name="place_id">${placeOptions(context.places, activity?.place_id)}</select>`)}</div>
    <div id="automation-location-variable" ${locationMode === 'workflow' ? '' : 'hidden'}>${inputRow('Location variable', `<select class="input" name="location_variable_id"><option value="">Choose a reusable Location variable…</option>${context.variables.filter((variable) => variable.type === 'location').map((variable) => `<option value="${h(variable.variable_key)}" ${variable.variable_key === activity?.location_variable_id ? 'selected' : ''}>${h(variable.label)} · {{${h(variable.variable_key)}}}</option>`).join('')}</select>`, 'The workflow using this activity must include the same Location variable.')}</div>
    ${inputRow('Presence policy', `<select class="input" name="presence_policy"><option value="ignore" ${activity?.presence_policy === 'ignore' || !activity?.presence_policy ? 'selected' : ''}>Ignore location</option><option value="must_be_home" ${activity?.presence_policy === 'must_be_home' ? 'selected' : ''}>Must be home</option><option value="must_be_at_location" ${activity?.presence_policy === 'must_be_at_location' ? 'selected' : ''}>Must be at the activity location</option><option value="must_be_away" ${activity?.presence_policy === 'must_be_away' ? 'selected' : ''}>Must be away</option><option value="available_before_due" ${activity?.presence_policy === 'available_before_due' ? 'selected' : ''}>Expected available before due time</option></select>`, 'Existing activities default to Ignore location.')}
    ${inputRow('Presence evaluation time', `<select class="input" name="presence_window"><option value="start" ${activity?.presence_window === 'start' ? 'selected' : ''}>At task start</option><option value="due" ${activity?.presence_window === 'due' || !activity?.presence_window ? 'selected' : ''}>At task due time</option><option value="completion" ${activity?.presence_window === 'completion' ? 'selected' : ''}>Across the useful completion window</option></select>`)}
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
      const participantCount = panel.querySelector('#automation-participant-count');
      const rotationGroup = panel.querySelector('#automation-rotation-group');
      const refreshAssignment = () => {
        fixed.hidden = strategySelect.value !== 'fixed';
        participantCount.hidden = strategySelect.value !== 'rotating_multi';
        rotationGroup.hidden = !['eligible_round_robin', 'rotating_multi'].includes(strategySelect.value);
      };
      strategySelect?.addEventListener('change', refreshAssignment);
      const locationSelect = panel.querySelector('#automation-location-mode');
      const fixedPlace = panel.querySelector('#automation-fixed-place');
      const locationVariable = panel.querySelector('#automation-location-variable');
      const refreshLocation = () => { fixedPlace.hidden = locationSelect.value !== 'fixed'; locationVariable.hidden = locationSelect.value !== 'workflow'; };
      locationSelect?.addEventListener('change', refreshLocation);
      panel.querySelector('#automation-activity-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const payload = {
          name: data.get('name'), title_template: data.get('title_template'),
          description: data.get('description'), category: data.get('category'),
          assignment_strategy: data.get('assignment_strategy'),
          subject_required: data.has('subject_required'),
          fixed_user_id: data.get('fixed_user_id') || null,
          allow_assignment_override: data.has('allow_assignment_override'),
          participant_count: Number(data.get('participant_count')) || 1,
          rotation_group: data.get('rotation_group') || null,
          skill_ids: data.getAll('skill').map(Number),
          supervision_title_template: data.get('supervision_title_template'),
          location_mode: data.get('location_mode'),
          place_id: Number(data.get('place_id')) || null,
          location_variable_id: data.get('location_variable_id') || null,
          presence_policy: data.get('presence_policy'),
          presence_window: data.get('presence_window'),
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
  replaceHtml(body, `${managerHeader('Workflow templates', 'automation-add-workflow', 'Add workflow')}
    <p class="form-hint automation-manager__hint">Workflows arrange reusable activities into an on-demand event. Enabled workflows appear in Quick Add.</p>
    <div class="automation-list">
      ${workflows.map((workflow) => `
        <div class="list-row automation-list-row">
          <div class="automation-list-row__copy"><strong>${h(workflow.name)}</strong><br><small class="form-hint">${workflow.steps?.length ?? 0} activities · ${workflow.quick_add_enabled ? 'Quick Add enabled' : 'hidden from Quick Add'}</small></div>
          <div class="automation-list-row__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-edit-workflow="${workflow.id}">Edit</button>
            <button type="button" class="btn btn--danger-ghost btn--sm" data-delete-workflow="${workflow.id}" aria-label="Delete ${h(workflow.name)} Quick Add template">Delete</button>
          </div>
        </div>`).join('') || '<p class="form-hint">No workflow templates yet.</p>'}
    </div>`);
  const context = {
    activities: response.activities ?? [],
    members: response.members ?? [],
    categories: response.categories ?? [],
    variables: response.variables ?? [],
    places: response.places ?? [],
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

function workflowVariableOptions(questions, selected = '', { memberOnly = false, locationOnly = false } = {}) {
  return questions
    .filter((question) => (!memberOnly || question.type === 'household_member') && (!locationOnly || question.type === 'location'))
    .map((question) => `<option value="${h(workflowVariableId(question))}" ${workflowVariableId(question) === selected ? 'selected' : ''}>${h(question.label || workflowVariableId(question))}</option>`)
    .join('');
}

function conditionValueHtml(variableId, value, questions, members, places = []) {
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
  if (question?.type === 'location') {
    return `<select class="input" data-step-condition-value required>${placeOptions(places, Number(value))}</select>`;
  }
  const type = ['number', 'date', 'time'].includes(question?.type) ? question.type : 'text';
  const required = variableId && type !== 'text' ? 'required' : '';
  return `<input class="input" type="${type}" data-step-condition-value placeholder="Equals" value="${h(stringValue)}" ${required}>`;
}

function workflowStepHtml(step, index, activities, questions, members, places) {
  const workflowKey = step?.step_key || `draft_${++workflowDraftStepSequence}`;
  const initialDependency = step?.depends_on?.[0] || '';
  const subjectVariableId = step?.subject_variable_id || '';
  const locationMode = step?.location_mode || 'inherit';
  const locationVariableId = step?.location_variable_id || '';
  const assignmentPolicy = step?.assignment_policy_override || '';
  const assignmentVariableId = step?.assignment_variable_id || '';
  const assignmentPolicyVariableId = step?.assignment_policy_variable_id || '';
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
    <div class="automation-workflow-condition" data-step-assignment-controls>
      <select class="input" data-step-assignment-policy>
        <option value="" ${!assignmentPolicy ? 'selected' : ''}>Use Activity Template assignment</option>
        <option value="eligible_round_robin" ${assignmentPolicy === 'eligible_round_robin' ? 'selected' : ''}>Eligible round robin</option>
        <option value="eligible_random" ${assignmentPolicy === 'eligible_random' ? 'selected' : ''}>Random eligible member</option>
        <option value="open_claimable" ${assignmentPolicy === 'open_claimable' ? 'selected' : ''}>Open / claimable</option>
        <option value="rotating_multi" ${assignmentPolicy === 'rotating_multi' ? 'selected' : ''}>Rotating group</option>
        <option value="fixed" ${assignmentPolicy === 'fixed' ? 'selected' : ''}>Fixed household member</option>
        <option value="subject_skill" ${assignmentPolicy === 'subject_skill' ? 'selected' : ''}>Person or qualified helper</option>
      </select>
      <select class="input" data-step-assignment-user>${memberOptions(members, step?.assignment_user_id, 'No fixed member')}</select>
      <select class="input" data-step-assignment-variable><option value="">No member variable</option>${workflowVariableOptions(questions, assignmentVariableId, { memberOnly: true })}</select>
      <select class="input" data-step-assignment-policy-variable><option value="">No runtime policy question</option>${workflowVariableOptions(questions, assignmentPolicyVariableId)}</select>
    </div>
    <div class="automation-workflow-condition" data-step-location-controls>
      <select class="input" data-step-location-mode><option value="inherit" ${locationMode === 'inherit' ? 'selected' : ''}>Use Activity Template location</option><option value="none" ${locationMode === 'none' ? 'selected' : ''}>No location for this step</option><option value="fixed" ${locationMode === 'fixed' ? 'selected' : ''}>Use a fixed Place</option><option value="workflow" ${locationMode === 'workflow' ? 'selected' : ''}>Use a Location variable</option></select>
      <select class="input" data-step-place ${locationMode === 'fixed' ? '' : 'hidden'}>${placeOptions(places, step?.place_id)}</select>
      <select class="input" data-step-location-variable ${locationMode === 'workflow' ? '' : 'hidden'}><option value="">Choose a Location variable…</option>${workflowVariableOptions(questions, locationVariableId, { locationOnly: true })}</select>
      <select class="input" data-step-presence-policy><option value="" ${!step?.presence_policy_override ? 'selected' : ''}>Use Activity Template presence policy</option><option value="ignore" ${step?.presence_policy_override === 'ignore' ? 'selected' : ''}>Ignore location</option><option value="must_be_home" ${step?.presence_policy_override === 'must_be_home' ? 'selected' : ''}>Must be home</option><option value="must_be_at_location" ${step?.presence_policy_override === 'must_be_at_location' ? 'selected' : ''}>Must be at step location</option><option value="must_be_away" ${step?.presence_policy_override === 'must_be_away' ? 'selected' : ''}>Must be away</option><option value="available_before_due" ${step?.presence_policy_override === 'available_before_due' ? 'selected' : ''}>Available before due</option></select>
    </div>
    <select class="input automation-workflow-step__control" data-step-dependency><option value="">No dependency</option></select>
    <div class="automation-workflow-condition">
      <select class="input" data-step-condition-variable><option value="">Always include</option>${workflowVariableOptions(questions, conditionVariableId)}</select>
      <div data-condition-value-slot>${conditionValueHtml(conditionVariableId, conditionValue, questions, members, places)}</div>
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
      <option value="location" ${type === 'location' ? 'selected' : ''}>Place / Location</option>
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
    <div id="workflow-steps">${(workflow?.steps?.length ? workflow.steps : [{}]).map((step, index) => workflowStepHtml(step, index, context.activities, workflow?.input_schema || [], context.members, context.places)).join('')}</div>
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
          replaceHtml(select, '<option value="">No dependency</option>' + rows.slice(0, index).map((priorRow, prior) =>
            `<option value="${h(priorRow.dataset.workflowKey)}">After step ${prior + 1}</option>`
          ).join(''));
          const wanted = old || existing;
          if ([...select.options].some((option) => option.value === wanted)) select.value = wanted;
          delete row.dataset.initialDependency;
        });
      };

      const refreshStepVariables = () => {
        const drafts = readQuestionDrafts();
        steps.querySelectorAll('[data-workflow-step]').forEach((row) => {
          const subjectSelect = row.querySelector('[data-step-subject-variable]');
          const locationSelect = row.querySelector('[data-step-location-variable]');
          const conditionSelect = row.querySelector('[data-step-condition-variable]');
          const assignmentVariable = row.querySelector('[data-step-assignment-variable]');
          const assignmentPolicyVariable = row.querySelector('[data-step-assignment-policy-variable]');
          const oldSubject = subjectSelect.value;
          const oldLocation = locationSelect.value;
          const oldCondition = conditionSelect.value;
          const oldAssignmentVariable = assignmentVariable.value;
          const oldAssignmentPolicyVariable = assignmentPolicyVariable.value;
          const oldConditionValue = row.querySelector('[data-step-condition-value]')?.value ?? '';
          replaceHtml(subjectSelect, '<option value="">Use the workflow subject</option>'
            + workflowVariableOptions(drafts, oldSubject, { memberOnly: true }));
          replaceHtml(conditionSelect, '<option value="">Always include</option>'
            + workflowVariableOptions(drafts, oldCondition));
          replaceHtml(locationSelect, '<option value="">Choose a Location variable…</option>'
            + workflowVariableOptions(drafts, oldLocation, { locationOnly: true }));
          replaceHtml(assignmentVariable, '<option value="">No member variable</option>'
            + workflowVariableOptions(drafts, oldAssignmentVariable, { memberOnly: true }));
          replaceHtml(assignmentPolicyVariable, '<option value="">No runtime policy question</option>'
            + workflowVariableOptions(drafts, oldAssignmentPolicyVariable));
          if ([...subjectSelect.options].some((option) => option.value === oldSubject)) subjectSelect.value = oldSubject;
          if ([...conditionSelect.options].some((option) => option.value === oldCondition)) conditionSelect.value = oldCondition;
          if ([...locationSelect.options].some((option) => option.value === oldLocation)) locationSelect.value = oldLocation;
          if ([...assignmentVariable.options].some((option) => option.value === oldAssignmentVariable)) assignmentVariable.value = oldAssignmentVariable;
          if ([...assignmentPolicyVariable.options].some((option) => option.value === oldAssignmentPolicyVariable)) assignmentPolicyVariable.value = oldAssignmentPolicyVariable;
          replaceHtml(row.querySelector('[data-condition-value-slot]'), conditionValueHtml(
            conditionSelect.value, oldConditionValue, drafts, context.members, context.places,
          ));
        });
      };

      refreshStepDependencies();
      refreshStepVariables();

      panel.querySelector('#workflow-add-step')?.addEventListener('click', () => {
        steps.insertAdjacentHTML('beforeend', workflowStepHtml(
          {}, steps.children.length, context.activities, readQuestionDrafts(), context.members, context.places,
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
        const locationMode = event.target.closest('[data-step-location-mode]');
        if (locationMode) {
          const row = locationMode.closest('[data-workflow-step]');
          row.querySelector('[data-step-place]').hidden = locationMode.value !== 'fixed';
          row.querySelector('[data-step-location-variable]').hidden = locationMode.value !== 'workflow';
          return;
        }
        const select = event.target.closest('[data-step-condition-variable]');
        if (!select) return;
        const row = select.closest('[data-workflow-step]');
        replaceHtml(row.querySelector('[data-condition-value-slot]'), conditionValueHtml(
          select.value, '', readQuestionDrafts(), context.members, context.places,
        ));
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
            location_mode: row.querySelector('[data-step-location-mode]').value,
            place_id: Number(row.querySelector('[data-step-place]').value) || null,
            location_variable_id: row.querySelector('[data-step-location-variable]').value || null,
            presence_policy_override: row.querySelector('[data-step-presence-policy]').value || null,
            assignment_policy_override: row.querySelector('[data-step-assignment-policy]').value || null,
            assignment_user_id: Number(row.querySelector('[data-step-assignment-user]').value) || null,
            assignment_variable_id: row.querySelector('[data-step-assignment-variable]').value || null,
            assignment_policy_variable_id: row.querySelector('[data-step-assignment-policy-variable]').value || null,
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
