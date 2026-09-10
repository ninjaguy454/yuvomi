import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { EXPRESSION_FUNCTIONS, EXPRESSION_PROPERTIES, EXPRESSION_LIMITS, validateExpression, validateVariableDefinitions } from '/utils/variable-expressions.js';

const h = value => esc(String(value ?? ''));
const keyOf = value => value?.variable_key ?? value?.key ?? value?.id ?? '';
const replaceHtml = (element, html) => { element.replaceChildren(); element.insertAdjacentHTML('afterbegin', html); };
let fieldSequence = 0;

/** Shared typed input for saved values, preview samples and Activity inputs. */
export function renderVariableInput(variable, { members = [], places = [], value = variable.default_value, optional = false, attribute = 'data-variable-input' } = {}) {
  const type = variable.type === 'select' ? 'choice' : variable.type;
  const common = `${attribute}="${h(keyOf(variable))}" data-variable-type="${h(type)}" aria-label="${h(variable.label || keyOf(variable))}"`;
  let options;
  if (type === 'household_member') options = members.map(member => [member.id, member.display_name || member.name]);
  if (type === 'location') options = places.filter(place => place.active !== 0).map(place => [place.id, place.path_label || place.name]);
  if (type === 'boolean') options = [[false, 'No'], [true, 'Yes']];
  if (type === 'choice') options = (variable.options || []).map(option => [option, option]);
  if (options) return `<select class="input" ${common}>${optional || ['household_member', 'location'].includes(type) ? '<option value="">Choose…</option>' : ''}${options.map(([id, label]) => `<option value="${h(id)}" ${String(id) === String(value) ? 'selected' : ''}>${h(label)}</option>`).join('')}</select>`;
  const inputType = ['number', 'date', 'time'].includes(type) ? type : 'text';
  return `<input class="input" type="${inputType}" ${inputType === 'number' ? 'step="any"' : ''} ${common} value="${h(value)}">`;
}

export function readVariableInput(field) {
  if (!field || field.value === '') return null;
  if (field.dataset.variableType === 'boolean') return field.value === 'true';
  if (['household_member', 'location', 'number'].includes(field.dataset.variableType)) return Number(field.value);
  return field.value;
}

export function variableReferenceOptions(definitions = []) {
  return definitions.flatMap(variable => {
    const key = keyOf(variable);
    if (!key) return [];
    return [{ id: key, label: variable.label || key, detail: key, token: `{{${key}}}` },
      ...Object.keys(EXPRESSION_PROPERTIES[variable.type] || {}).map(property => ({
        id: `${key}.${property}`, label: `${variable.label || key} · ${property.replaceAll('_', ' ')}`,
        detail: `${key}.${property}`, token: `{{${key}.${property}}}`,
      }))];
  });
}

export function renderVariableValueEditor(variable = {}, { readOnly = false } = {}) {
  const id = `variable-expression-${++fieldSequence}`;
  const mode = variable.expression ? 'expression' : variable.kind === 'value' ? 'value' : 'field';
  return `<div class="variable-value-editor" data-variable-value-editor>
    ${readOnly ? `<p class="form-hint">Uses the household definition. Edit it in Variables to update its calculation for every linked workflow.</p>` : `<label class="label" for="${id}-source">Value source</label><select class="input" id="${id}-source" data-variable-source><option value="field" ${mode === 'field' ? 'selected' : ''}>Ask when it runs</option><option value="value" ${mode === 'value' ? 'selected' : ''}>Saved household value</option><option value="expression" ${mode === 'expression' ? 'selected' : ''}>Calculated value</option></select>`}
    <div data-variable-default ${mode === 'expression' || readOnly ? 'hidden' : ''}><label class="label" for="${id}-default">${mode === 'value' ? 'Value' : 'Default value (optional)'}</label><div data-variable-default-control></div></div>
    <div class="variable-expression" data-expression-section ${mode === 'expression' ? '' : 'hidden'}>
      <label class="label" for="${id}">Expression</label>
      <textarea class="input variable-expression__source" id="${id}" data-expression-source rows="3" maxlength="${EXPRESSION_LIMITS.source}" spellcheck="false" aria-describedby="${id}-hint ${id}-error" ${readOnly ? 'readonly' : ''}>${h(variable.expression?.source || '')}</textarea>
      <small class="form-hint" id="${id}-hint">Use the values and functions below. Results are calculated when the template runs.</small>
      <p class="variable-expression__error" id="${id}-error" data-expression-error role="status" aria-live="polite" hidden></p>
      ${readOnly ? '' : `<details class="variable-expression__reference"><summary>Available values and functions</summary><div data-expression-references></div><label class="label" for="${id}-member">Insert a household member ID</label><div class="variable-expression__insert"><select class="input" id="${id}-member" data-expression-member aria-label="Household member for a case"></select><button class="btn btn--secondary" type="button" data-expression-insert-member>Insert ID</button></div><small class="form-hint">Use IDs for member comparisons and switch cases. Renaming a person will not change the rule.</small></details>`}
      <div data-expression-samples></div>
      <button class="btn btn--secondary" type="button" data-expression-preview>Check and preview</button>
      <output class="variable-expression__result" data-expression-result aria-live="polite"></output>
    </div>
  </div>`;
}

export function bindVariableValueEditor(root, { variable = {}, getDefinition, getDefinitions = () => [], members = [], places = [], context = [], readOnly = false, onChange = () => {} } = {}) {
  const source = root.querySelector('[data-variable-source]');
  const field = root.querySelector('[data-expression-source]');
  const error = root.querySelector('[data-expression-error]');
  const result = root.querySelector('[data-expression-result]');
  const sampleArea = root.querySelector('[data-expression-samples]');
  const preview = root.querySelector('[data-expression-preview]');
  const mode = () => source?.value || (variable.expression ? 'expression' : variable.kind === 'value' ? 'value' : 'field');
  let version = 0;
  let previewRequested = false, previewTimer = null;
  let inputType;
  const invalidate = () => { version += 1; clearTimeout(previewTimer); result.textContent = ''; error.hidden = true; field.removeAttribute('aria-invalid'); };
  const value = () => ({
    kind: mode() === 'value' ? 'value' : mode() === 'field' ? 'field' : variable.kind || 'field',
    default_value: mode() === 'expression' ? null : readVariableInput(root.querySelector('[data-variable-default-control] .input')),
    expression: mode() === 'expression' ? { version: 1, source: field.value.trim() } : null,
  });
  const definitions = () => {
    const current = { ...getDefinition(), ...value() };
    return [...new Map([...getDefinitions(), ...context, current].map(item => [keyOf(item), item])).values()];
  };
  const showError = message => { error.textContent = message; error.hidden = false; field.setAttribute('aria-invalid', 'true'); };
  const validate = ({ focus = false } = {}) => {
    if (mode() !== 'expression') return true;
    try {
      const current = { ...getDefinition(), ...value() };
      validateExpression(current.expression.source, definitions(), { expectedType: current.type });
      validateVariableDefinitions(definitions());
      error.hidden = true; field.removeAttribute('aria-invalid'); return true;
    } catch (failure) { showError(failure.message); if (focus) field.focus(); return false; }
  };
  const insert = text => {
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    field.setRangeText(text, start, end, 'end'); field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
  };
  const refreshReferences = () => {
    const target = root.querySelector('[data-expression-references]');
    if (!target) return;
    const references = variableReferenceOptions([...getDefinitions(), ...context]);
    replaceHtml(target, `<div class="variable-expression__reference-list">${references.map(reference => `<button type="button" class="btn btn--ghost" data-expression-insert="${h(reference.id)}"><span>${h(reference.label)}</span><code>${h(reference.id)}</code></button>`).join('')}</div><div class="variable-expression__functions">${EXPRESSION_FUNCTIONS.map(fn => `<button type="button" class="btn btn--ghost" data-expression-insert="${h(fn.name)}("><code>${h(fn.signature)}</code><small>${h(fn.description)}</small></button>`).join('')}</div>`);
  };
  const refresh = () => {
    const definition = getDefinition();
    root.querySelector('[data-expression-section]').hidden = mode() !== 'expression';
    const defaultArea = root.querySelector('[data-variable-default]');
    defaultArea.hidden = mode() === 'expression' || readOnly;
    defaultArea.querySelector('label').textContent = mode() === 'value' ? 'Value' : 'Default value (optional)';
    const signature = JSON.stringify([definition.type, definition.options]);
    if (signature !== inputType) {
      const old = root.querySelector('[data-variable-default-control] .input');
      const defaultValue = old ? readVariableInput(old) : variable.default_value;
      replaceHtml(root.querySelector('[data-variable-default-control]'), renderVariableInput(definition, { members, places, value: defaultValue, optional: true }));
      root.querySelector('[data-variable-default-control] .input').id = defaultArea.querySelector('label').htmlFor;
      inputType = signature;
    }
    refreshReferences();
  };
  const readSamples = () => {
    const inputs = {};
    sampleArea.querySelectorAll('[data-variable-input]').forEach(input => { const val = readVariableInput(input); if (val !== null) inputs[input.dataset.variableInput] = val; });
    return { inputs, subject_user_id: Number(sampleArea.querySelector('[data-expression-subject]')?.value) || null };
  };
  const paintSamples = schema => {
    const previous = readSamples();
    const ordinary = (schema || []).filter(item => !item.expression && item.kind !== 'value');
    const graph = validateVariableDefinitions(definitions()).dependencies;
    const seen = new Set();
    const needsSubject = key => key === 'context.household_member' || (!seen.has(key) && (seen.add(key), (graph[key] || []).some(needsSubject)));
    const subjectInput = needsSubject(keyOf(getDefinition())) ? `<label class="label">Person this is for<select class="input" data-expression-subject><option value="">Choose…</option>${members.map(member => `<option value="${member.id}" ${Number(previous.subject_user_id) === Number(member.id) ? 'selected' : ''}>${h(member.display_name || member.name)}</option>`).join('')}</select></label>` : '';
    if (!ordinary.length && !subjectInput) { sampleArea.replaceChildren(); return; }
    replaceHtml(sampleArea, `<details open><summary>Try with these values</summary><div class="variable-expression__samples">${ordinary.map(item => `<label class="label">${h(item.label || keyOf(item))}${renderVariableInput(item, { members, places, value: previous.inputs[keyOf(item)] ?? item.default_value, optional: true })}</label>`).join('')}${subjectInput}</div></details>`);
  };
  source?.addEventListener('change', () => { invalidate(); refresh(); onChange(); });
  const changed = event => {
    invalidate(); onChange();
    if (previewRequested && sampleArea.contains(event.target)) previewTimer = setTimeout(() => { if (root.isConnected) runPreview(); }, 180);
  };
  root.addEventListener('input', changed);
  root.addEventListener('change', event => { if (event.target !== source) changed(event); });
  field.addEventListener('blur', event => {
    if (root.querySelector('.variable-expression__reference')?.contains(event.relatedTarget)) return;
    if (field.value.trim()) validate();
  });
  root.querySelector('[data-expression-references]')?.addEventListener('click', event => {
    const button = event.target.closest('[data-expression-insert]'); if (button) insert(button.dataset.expressionInsert);
  });
  const memberPicker = root.querySelector('[data-expression-member]');
  if (memberPicker) replaceHtml(memberPicker, `<option value="">Choose a member…</option>${members.map(member => `<option value="${member.id}">${h(member.display_name || member.name)}</option>`).join('')}`);
  root.querySelector('[data-expression-insert-member]')?.addEventListener('click', () => { if (memberPicker.value) insert(memberPicker.value); });
  const runPreview = async () => {
    previewRequested = true;
    if (!validate({ focus: true })) return;
    const attempt = ++version; preview.disabled = true; result.textContent = 'Checking…';
    try {
      const response = await api.post('/automation/admin/variables/preview', { variable: { ...getDefinition(), ...value() }, definitions: getDefinitions(), ...readSamples() });
      if (!root.isConnected || attempt !== version) return;
      result.textContent = response.data.display_value ?? String(response.data.value ?? 'No value');
      if (!sampleArea.hasChildNodes()) paintSamples(response.input_schema);
      error.hidden = true;
    } catch (failure) {
      if (!root.isConnected || attempt !== version) return;
      result.textContent = '';
      if (failure.data?.reason === 'missing_input') { paintSamples(failure.data.input_schema); showError('Choose sample values to preview the result.'); field.removeAttribute('aria-invalid'); }
      else showError(failure.message || 'Could not preview this value.');
    } finally { if (root.isConnected) preview.disabled = false; }
  };
  preview.addEventListener('click', runPreview);
  refresh();
  return { value, validate, refresh, invalidate, insert };
}

/** Resolve native Activity Template fields before copying them into a Task. */
export function bindActivityVariableInputs(host, { activity, members = [], places = [], subjectUserId = () => null, onResolved = () => {}, allowChange = () => true } = {}) {
  const templates = [activity?.title_template, activity?.description, ...(activity?.checklist || []).map(item => item.title_template)];
  const active = Boolean(activity && (activity.variable_error || templates.some(text => String(text || '').includes('{{'))));
  if (!active) { host.replaceChildren(); host.hidden = true; return null; }
  host.hidden = false;
  const schema = (activity.input_schema || []).filter(item => !item.expression && item.kind !== 'value');
  replaceHtml(host, `<div class="variable-expression"><strong>Template values</strong><div class="variable-expression__samples">${schema.map(item => `<label class="label">${h(item.label || keyOf(item))}${renderVariableInput(item, { members, places })}</label>`).join('')}</div><button class="btn btn--secondary" type="button" data-activity-values-apply>Apply values</button><p class="form-hint" data-activity-values-status aria-live="polite"></p></div>`);
  const content = host.firstElementChild;
  const status = host.querySelector('[data-activity-values-status]');
  const button = host.querySelector('[data-activity-values-apply]');
  let version = 0, resolvedSignature = null;
  const inputs = () => Object.fromEntries([...host.querySelectorAll('[data-variable-input]')].flatMap(field => {
    const value = readVariableInput(field); return value === null ? [] : [[field.dataset.variableInput, value]];
  }));
  const signature = () => JSON.stringify([subjectUserId(), inputs()]);
  const invalidate = () => { version += 1; resolvedSignature = null; status.textContent = 'Apply these values before saving the Task.'; };
  const resolve = async () => {
    if (!allowChange()) return false;
    if (activity.variable_error) { status.textContent = activity.variable_error; return false; }
    if (signature() === resolvedSignature) return true;
    const current = signature(), attempt = ++version;
    button.disabled = true; status.textContent = 'Applying values…';
    try {
      const response = await api.post(`/automation/activity-templates/${activity.id}/resolve`, { inputs: inputs(), subject_user_id: subjectUserId() });
      if (!content.isConnected || version !== attempt || current !== signature()) return false;
      onResolved(response.data); resolvedSignature = current;
      status.textContent = 'Values applied. You can still edit the Task instructions.'; return true;
    } catch (failure) {
      if (content.isConnected && version === attempt) status.textContent = failure.message || 'Could not apply template values.';
      return false;
    } finally { if (content.isConnected) button.disabled = false; }
  };
  content.addEventListener('input', invalidate);
  content.addEventListener('change', invalidate);
  button.addEventListener('click', resolve);
  if (!schema.some(item => item.default_value == null) && !activity.variable_error) resolve();
  else status.textContent = activity.variable_error || 'Choose the values, then apply them to the Task.';
  return { inputs, resolve, invalidate, ready: () => signature() === resolvedSignature };
}
