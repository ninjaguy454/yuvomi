import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { openModal, confirmOverModal, refreshDirtySnapshot } from '/components/modal.js';
import { createPipelineDraft, validatePipeline } from '/utils/recipe-pipeline.js';
import { newOperation, addOutput, removeOutput, removeOperation, reorderOperation, readyStateChoices, divideResource, bindIngredient } from '/utils/recipe-pipeline-edit.js';
import { mountPipelineGraph } from '/components/recipe-pipeline-view.js';
import { makeSortable } from '/utils/sortable.js';

const copy = value => JSON.parse(JSON.stringify(value));
const resourceLabel = resource => [resource.quantity, resource.name || 'Unnamed resource'].filter(Boolean).join(' · ');
const emptyDivision = () => ({ resourceId: '', portions: [{ name: '', quantity: '' }, { name: '', quantity: '' }] });
function setHTML(element, html) {
  element.replaceChildren();
  element.insertAdjacentHTML('beforeend', html);
}

function writtenRecipe(recipe) {
  return `<section class="pipeline-written" aria-label="Written recipe"><h3>Ingredients</h3>
    <ul>${(recipe.ingredients || []).map(item => `<li>${esc([item.quantity, item.name].filter(Boolean).join(' · '))}</li>`).join('')}</ul>
    <h3>Instructions</h3><p>${esc(recipe.notes || 'No written instructions saved.')}</p></section>`;
}

function readyChoicesHTML(document, operationId) {
  return readyStateChoices(document, operationId).map(({ resource, producer, selected, later }) =>
    `<label class="form-check"><input type="checkbox" data-input-kind="requires" value="${esc(resource.id)}" ${selected ? 'checked' : ''}><span>${esc(resourceLabel(resource))}
      ${producer ? `<small>${later ? 'Shown later in the list' : 'Prepared by'}: ${esc(producer.label || 'Unnamed operation')}.${later ? ' This prerequisite is kept; the Cooking Map follows its connection.' : ''}</small>` : ''}</span></label>`).join('');
}

export function operationFields(document, operationId) {
  const operation = document.operations.find(item => item.id === operationId);
  if (!operation) return '<p>Add an operation to begin. Choose what it uses and what it makes.</p>';
  const resources = document.resources.filter(resource => !operation.produces.includes(resource.id));
  const inputs = (kind, field) => resources.filter(resource => (resource.kind === 'readiness') === (kind === 'readiness')).map(resource => {
    const other = field === 'consumes' && document.operations.find(item => item.id !== operation.id && item.consumes.includes(resource.id));
    return `<label class="form-check"><input type="checkbox" data-input-kind="${field}" value="${esc(resource.id)}" ${operation[field].includes(resource.id) ? 'checked' : ''} ${other ? 'disabled' : ''}><span>${esc(resourceLabel(resource))}${other ? `<small>Used by ${esc(other.label || 'another operation')} — divide into portions to share.</small>` : ''}</span></label>`;
  }).join('');
  return `<div class="pipeline-fields">
    <label class="form-group">Operation / instruction<textarea class="form-input" data-operation-field="label" rows="2" maxlength="500" placeholder="e.g. Whisk dry ingredients">${esc(operation.label)}</textarea></label>
    <fieldset class="pipeline-options"><legend>Consumes · ingredients and food</legend><div class="pipeline-checks">${inputs('material', 'consumes') || '<p>No material inputs available.</p>'}</div></fieldset>
    <fieldset class="pipeline-options"><legend>Requires · ready states</legend><p class="pipeline-help">Choose ready states made by earlier operations, such as a preheated oven. Choices update when you reorder operations. An operation cannot require its own output.</p><div class="pipeline-checks" data-pipeline-ready-choices>${readyChoicesHTML(document, operationId) || '<p>No ready states from earlier operations yet.</p>'}</div></fieldset>
    <fieldset class="pipeline-options"><legend>Produces</legend><div class="pipeline-outputs">${operation.produces.map(resourceId => {
      const resource = document.resources.find(item => item.id === resourceId);
      return `<div class="pipeline-output"><span class="pipeline-kind">${resource.kind === 'readiness' ? 'Ready state' : 'Food / component'}</span>
        <label class="form-group">Output name<input class="form-input" data-resource-name="${esc(resource.id)}" maxlength="500" value="${esc(resource.name)}" placeholder="e.g. Dry mixture"></label>
        ${resource.kind !== 'readiness' ? `<label class="form-group">Quantity (optional)<input class="form-input" data-resource-quantity="${esc(resource.id)}" maxlength="100" value="${esc(resource.quantity)}"></label>` : ''}
        <button type="button" class="btn btn--ghost" data-command="remove-output" data-resource-id="${esc(resource.id)}">Remove output</button></div>`;
    }).join('')}</div><div class="pipeline-inline-actions"><button type="button" class="btn btn--secondary" data-command="output-food">Add food output</button><button type="button" class="btn btn--secondary" data-command="output-ready">Add ready state</button></div></fieldset>
    <details class="pipeline-details"><summary>Time, temperature and equipment</summary>
      <div class="pipeline-field-row"><label class="form-group">Duration (minutes)<input type="number" class="form-input" data-time="min" min="0" step="any" value="${operation.duration ? operation.duration.min_seconds / 60 : ''}" placeholder="Unknown"></label>
      <label class="form-group">Up to (optional)<input type="number" class="form-input" data-time="max" min="0" step="any" value="${operation.duration && operation.duration.max_seconds !== operation.duration.min_seconds ? operation.duration.max_seconds / 60 : ''}" placeholder="Same duration"></label></div>
      <div class="pipeline-field-row"><label class="form-group">Temperature<input type="number" class="form-input" data-temperature="value" step="any" value="${operation.temperature?.value ?? ''}" placeholder="Not specified"></label>
      <label class="form-group">Unit<select class="form-input" data-temperature="unit"><option value="F" ${operation.temperature?.unit !== 'C' ? 'selected' : ''}>°F</option><option value="C" ${operation.temperature?.unit === 'C' ? 'selected' : ''}>°C</option></select></label></div>
      <label class="form-group">Equipment (one per line)<textarea class="form-input" data-operation-field="equipment" rows="2" placeholder="Mixing bowl&#10;Whisk">${esc(operation.equipment.join('\n'))}</textarea></label>
      <p class="pipeline-help">Equipment is a list of tools, not a consumed ingredient or a reservation.</p>
    </details>
  </div>`;
}

export function operationPicker(document, selectedId) {
  return `<ol data-pipeline-operations>${document.operations.map((operation, index) => `<li data-operation-row="${esc(operation.id)}">
    <button type="button" data-operation="${esc(operation.id)}" aria-pressed="${operation.id === selectedId}" aria-label="${esc(operation.label || 'Unnamed operation')}"></button>
    <span class="pipeline-operation-handle" role="img" aria-label="Drag to reorder operation"><i data-lucide="grip-vertical" aria-hidden="true"></i></span>
    <span class="pipeline-operation-moves"><button type="button" class="btn btn--ghost btn--icon" data-command="up" data-move-operation="${esc(operation.id)}" aria-label="Move operation ${index + 1} up" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up" aria-hidden="true"></i></button><button type="button" class="btn btn--ghost btn--icon" data-command="down" data-move-operation="${esc(operation.id)}" aria-label="Move operation ${index + 1} down" ${index === document.operations.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down" aria-hidden="true"></i></button></span>
    <span class="pipeline-operation-label" data-operation-label="${esc(operation.id)}" aria-hidden="true">${esc(operation.label || 'Unnamed operation')}</span>
  </li>`).join('')}</ol>`;
}

function editorHTML(document, selectedId, recipe, division) {
  const index = document.operations.findIndex(operation => operation.id === selectedId);
  return `<div class="pipeline-editor"><aside class="pipeline-operation-picker" aria-label="Operations">
    <h3>Operations</h3><p class="pipeline-help">Inputs and outputs determine order. Moving a card only changes its display order.</p>
    ${operationPicker(document, selectedId)}
    <button type="button" class="btn btn--secondary" data-command="add" ${document.operations.length >= 100 ? 'disabled' : ''}>Add operation</button>
    <button type="button" class="btn btn--ghost" data-command="remove" ${index < 0 ? 'disabled' : ''}>Remove operation</button>
  </aside><section aria-label="Selected operation">${operationFields(document, selectedId)}</section></div>
  <details class="pipeline-details"><summary>Divide an ingredient or component into portions</summary>
    <p class="pipeline-help">Create two separate outputs. If this material is already used, its existing operation will receive the first portion. Enter the portions yourself; quantities are not calculated.</p>
    <label class="form-group">Material to divide<select class="form-input" data-divide-resource><option value="">Choose an ingredient or component</option>${document.resources.filter(resource => resource.kind !== 'readiness').map(resource => `<option value="${esc(resource.id)}" ${division.resourceId === resource.id ? 'selected' : ''}>${esc(resourceLabel(resource))}</option>`).join('')}</select></label>
    ${[1, 2].map(number => `<div class="pipeline-field-row"><label class="form-group">Portion ${number} name<input class="form-input" data-portion-name="${number}" maxlength="500" value="${esc(division.portions[number - 1].name)}"></label><label class="form-group">Portion ${number} quantity<input class="form-input" data-portion-quantity="${number}" maxlength="100" placeholder="Optional" value="${esc(division.portions[number - 1].quantity)}"></label></div>`).join('')}
    <button type="button" class="btn btn--secondary" data-command="divide">Create portions</button>
  </details>
  <details class="pipeline-details"><summary>Link ingredients to the current recipe</summary><p class="pipeline-help">Each ingredient appears once. Relinking a changed ingredient preserves its Cooking Map connections. To use it in several places, divide it into portions.</p>
    ${document.resources.filter(resource => resource.kind === 'ingredient').map(resource => `<div class="pipeline-ingredient-link"><p>${esc(resourceLabel(resource))}</p><label class="form-group">Current recipe ingredient<select class="form-input" data-bind-ingredient="${esc(resource.id)}"><option value="">Choose the matching ingredient</option>${(recipe.ingredients || []).map((ingredient, i) => `<option value="${i}" ${i === resource.source_index && ingredient.name === resource.name && (ingredient.quantity || '') === resource.quantity ? 'selected' : ''}>${esc([ingredient.quantity, ingredient.name].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><button type="button" class="btn btn--ghost" data-command="remove-output" data-resource-id="${esc(resource.id)}">Remove unused ingredient</button></div>`).join('')}
    <label class="form-group">Add an ingredient from the current recipe<select class="form-input" data-add-ingredient><option value="">Choose an ingredient</option>${(recipe.ingredients || []).map((ingredient, i) => `<option value="${i}" ${document.resources.some(resource => resource.kind === 'ingredient' && resource.source_index === i) ? 'disabled' : ''}>${esc([ingredient.quantity, ingredient.name].filter(Boolean).join(' · '))}</option>`).join('')}</select></label><button type="button" class="btn btn--secondary" data-command="ingredient">Add ingredient</button>
  </details><details class="pipeline-details"><summary>Compare with written recipe</summary>${writtenRecipe(recipe)}</details>`;
}

export function openRecipePipeline(initialRecipe, { onSaved = () => {}, onDuplicate = () => {} } = {}) {
  let recipe = initialRecipe, panel, draft = null, selectedId = null;
  let view = 'pipeline', editing = false, dirty = false, busy = true, reviewConfirmed = false;
  let revision, sourceHash, message = '', graphCleanup = () => {};
  let closed = false, busyMessage = 'Loading recipe…', division = emptyDivision();
  let sortable = null, sortableGeneration = 0;
  const isLive = () => !closed && panel?.isConnected;
  const hasDivisionDraft = () => Boolean(division.resourceId || division.portions.some(portion => portion.name || portion.quantity));
  const hasUnsavedChanges = () => dirty || hasDivisionDraft();
  const dirtyValue = () => hasUnsavedChanges() ? JSON.stringify({ pipeline: draft, division }) : '';

  const showError = value => {
    if (!isLive()) return;
    const target = panel.querySelector('[data-pipeline-error]');
    target.textContent = value || ''; target.hidden = !value;
    // Save lives in a fixed footer; bring an error above a long editor into
    // view and announce it without opening a mobile input keyboard.
    if (value) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  };
  function changed(next) {
    draft = next; dirty = true; message = '';
    if (division.resourceId && !draft.resources.some(resource => resource.id === division.resourceId)) division.resourceId = '';
    panel.querySelector('[data-pipeline-dirty]').value = dirtyValue();
    panel.querySelector('[data-pipeline-status]').textContent = 'Unsaved pipeline. Review your inputs and outputs before saving.';
    showError('');
    const choices = panel.querySelector('[data-pipeline-ready-choices]');
    if (choices) {
      const active = document.activeElement;
      const focused = active?.dataset?.inputKind === 'requires' ? active.value : null;
      setHTML(choices, readyChoicesHTML(draft, selectedId) || '<p>No ready states from earlier operations yet.</p>');
      if (focused) choices.querySelector(`[value="${focused}"]`)?.focus();
    }
  }
  function flushFieldEdits() {
    if (!draft || !editing || view !== 'pipeline') return;
    const label = panel.querySelector('[data-operation-field="label"]');
    if (!label) return;
    const next = copy(draft), operation = next.operations.find(item => item.id === selectedId);
    if (!operation) return;
    operation.label = label.value;
    operation.equipment = panel.querySelector('[data-operation-field="equipment"]').value.split('\n').map(value => value.trim()).filter(Boolean);
    for (const field of ['consumes', 'requires']) {
      operation[field] = [...panel.querySelectorAll(`[data-input-kind="${field}"]`)].filter(input => input.checked).map(input => input.value);
    }
    for (const resource of next.resources) {
      const name = panel.querySelector(`[data-resource-name="${resource.id}"]`);
      const quantity = panel.querySelector(`[data-resource-quantity="${resource.id}"]`);
      if (name) resource.name = name.value;
      if (quantity) resource.quantity = quantity.value;
    }
    const min = panel.querySelector('[data-time="min"]').value, max = panel.querySelector('[data-time="max"]').value;
    operation.duration = min === '' && max === '' ? null : { min_seconds: min === '' ? NaN : Number(min) * 60, max_seconds: Number(max === '' ? min : max) * 60 };
    const temperature = panel.querySelector('[data-temperature="value"]').value;
    operation.temperature = temperature === '' ? null : { value: Number(temperature), unit: panel.querySelector('[data-temperature="unit"]').value };
    if (JSON.stringify(next) !== JSON.stringify(draft)) changed(next);
  }
  function cleanupSortable() { sortableGeneration++; sortable?.destroy(); sortable = null; }
  function reorder(operationId, destination) {
    if (busy || !isLive()) return;
    flushFieldEdits(); changed(reorderOperation(draft, operationId, destination)); render();
  }
  function selectOperation(operationId, { flush = true } = {}) {
    if (busy) return;
    if (flush) flushFieldEdits();
    selectedId = operationId; editing = true; view = 'pipeline'; render();
    panel.querySelector('[data-operation-field="label"]')?.focus();
  }
  function startEditing() {
    if (!draft) {
      draft = recipe.pipeline ? copy(recipe.pipeline) : createPipelineDraft(recipe);
      revision = recipe.pipeline_revision; sourceHash = recipe.pipeline_current_source_hash;
      selectedId = draft.operations[0]?.id || null;
    }
    editing = true; view = 'pipeline'; render();
  }
  function render() {
    if (!isLive()) return;
    const active = document.activeElement;
    const focusAttributes = active && panel.contains(active)
      ? [...active.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value]) : [];
    const openDetails = new Set([...panel.querySelectorAll('details[open]')].map(details => details.querySelector('summary')?.textContent));
    graphCleanup(); graphCleanup = () => {};
    cleanupSortable();
    const graph = draft || recipe.pipeline;
    const editable = recipe.pipeline_can_edit;
    panel.querySelector('[data-pipeline-dirty]').value = dirtyValue();
    setHTML(panel.querySelector('[data-pipeline-toolbar]'), `<div class="pipeline-view-buttons" role="group" aria-label="Recipe view">${[['written', 'Written recipe'], ['pipeline', 'Pipeline']].map(([key, label]) => `<button type="button" class="btn btn--${view === key ? 'primary' : 'secondary'}" data-view="${key}" aria-pressed="${view === key}" ${busy ? 'disabled' : ''}>${label}</button>`).join('')}</div>
      ${editable ? `<button type="button" class="btn btn--secondary" data-command="edit" ${busy ? 'disabled' : ''}>${editing ? 'Preview Cooking Map' : graph ? 'Edit pipeline' : 'Build Cooking Map'}</button>` : ''}`);
    panel.querySelector('[data-pipeline-status]').textContent = busy ? busyMessage : message || (hasUnsavedChanges() ? 'Unsaved pipeline. Review your inputs and outputs before saving.' : draft ? 'Build your pipeline by choosing each operation’s inputs and outputs.' : graph ? 'Cooking Map · drawn from the saved inputs and outputs.' : 'An optional view. Your written recipe stays unchanged.');
    const review = panel.querySelector('[data-pipeline-review]');
    review.hidden = !recipe.pipeline_review_needed;
    setHTML(review, `<strong>Needs review</strong><p>The recipe’s ingredients or instructions have changed. Compare the written recipe with this saved pipeline; its labels and quantities have not been changed automatically.</p>${draft ? `<label class="form-check"><input type="checkbox" data-review-confirm ${reviewConfirmed ? 'checked' : ''}><span>I reviewed the pipeline against the current recipe.</span></label>` : ''}`);
    const content = panel.querySelector('[data-pipeline-content]');
    content.inert = busy;
    if (busy && !recipe.pipeline_current_source_hash) content.replaceChildren();
    else if (view === 'written') setHTML(content, writtenRecipe(recipe));
    else if (editing && draft) {
      setHTML(content, editorHTML(draft, selectedId, recipe, division));
      const list = panel.querySelector('[data-pipeline-operations]'), generation = sortableGeneration;
      if (list) makeSortable(list, { handle: '.pipeline-operation-handle', draggable: '[data-operation-row]',
        onEnd: event => reorder(event.item.dataset.operationRow, event.newIndex),
      }).then(instance => { if (generation !== sortableGeneration || !isLive()) instance?.destroy(); else sortable = instance; })
        .catch(() => {}); // The visible, keyboard-accessible chevrons remain available.
      window.lucide?.createIcons({ el: content });
    }
    else if (graph) {
      setHTML(content, '<div data-cooking-map></div>');
      try { graphCleanup = mountPipelineGraph(content.querySelector('[data-cooking-map]'), graph, { onEdit: editable ? operationId => { if (!draft) startEditing(); selectOperation(operationId); } : undefined }); }
      catch (err) { setHTML(content, '<p>The draft is not ready to draw. Edit its operations to resolve the issue below.</p>'); showError(err.message); }
    } else if (recipe.provider_account_id) {
      setHTML(content, `<div class="pipeline-empty"><h3>This recipe is managed by its provider</h3><p>Create an editable copy in Vidamia to build a pipeline. Provider recipes stay unchanged.</p><button type="button" class="btn btn--secondary" data-command="duplicate" ${busy ? 'disabled' : ''}>Duplicate as native recipe</button></div>`);
    } else {
      setHTML(content, `<div class="pipeline-empty"><h3>Build your Cooking Map</h3><p>Choose each operation’s ingredients, ready states and outputs. Vidamia draws the connections from those selections.</p><p>${recipe.pipeline_invalid ? 'The saved pipeline could not be read. Building and saving a replacement requires your review.' : 'There is no structured pipeline yet. Nothing is inferred from the written instructions.'}</p>${!editable && !busy ? '<p>Only the recipe’s creator can edit its pipeline.</p>' : ''}</div>${writtenRecipe(recipe)}`);
    }
    const footer = panel.querySelector('[data-pipeline-footer]');
    footer.hidden = !draft;
    setHTML(footer, `<button type="button" class="btn btn--secondary" data-command="cancel" ${busy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn btn--primary" data-command="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save pipeline'}</button>`);
    panel.querySelectorAll('details').forEach(details => { if (openDetails.has(details.querySelector('summary')?.textContent)) details.open = true; });
    if (focusAttributes.length) {
      const replacement = [...panel.querySelectorAll('button,input,textarea,select,[data-pipeline-error]')].find(element => focusAttributes.every(([name, value]) => element.getAttribute(name) === value));
      if (replacement && !replacement.disabled && replacement.getClientRects().length) replacement.focus();
      else if (!busy) { const title = panel.querySelector('.modal-panel__title'); title.tabIndex = -1; title.focus(); }
    }
    if (!hasUnsavedChanges()) refreshDirtySnapshot({ defer: false });
  }

  async function command(name, button) {
    if (busy || !isLive()) return;
    flushFieldEdits();
    showError('');
    if (name === 'duplicate') {
      busy = true; busyMessage = 'Creating native copy…'; render();
      try {
        const duplicated = await onDuplicate(recipe);
        // Closing/replacing this workspace ends its ownership of navigation,
        // even while the mobile close animation still keeps its panel attached.
        if (duplicated && isLive()) openRecipePipeline(duplicated, { onSaved, onDuplicate });
      } finally { busy = false; if (isLive()) render(); }
      return;
    }
    if (name === 'edit') { if (editing) { editing = false; view = 'pipeline'; render(); } else startEditing(); return; }
    if (!draft) return;
    if (name === 'cancel') {
      if (hasUnsavedChanges() && !await confirmOverModal('Discard your unsaved pipeline changes?', { confirmLabel: 'Discard changes', danger: false, closeOnConfirm: false, detail: 'Your unsaved pipeline edits and unfinished portions will be discarded. The saved Cooking Map stays unchanged.' })) return;
      draft = null; dirty = false; division = emptyDivision(); editing = false; reviewConfirmed = false; message = ''; render(); return;
    }
    if (name === 'save') {
      if (hasDivisionDraft()) throw new Error('Create the portions or clear their fields before saving the pipeline.');
      const validated = validatePipeline(draft);
      if (recipe.pipeline_review_needed && !reviewConfirmed) throw new Error('Review the current written recipe and confirm the review before saving.');
      busy = true; busyMessage = 'Saving pipeline…'; render();
      try {
        const response = await api.put(`/recipes/${recipe.id}/pipeline`, { pipeline: validated, expected_revision: revision, source_hash: sourceHash });
        if (!isLive()) return;
        Object.assign(initialRecipe, response.data); recipe = initialRecipe;
        draft = null; dirty = false; editing = false; reviewConfirmed = false;
        message = 'Pipeline saved. Your written recipe is unchanged.';
        onSaved(recipe);
      } catch (err) { if (isLive()) showError(`${err.message} Your unsaved edits are still here.`); }
      finally { busy = false; if (isLive()) render(); }
      return;
    }
    if (name === 'add') {
      const next = copy(draft), operation = newOperation();
      next.operations.push(operation); selectedId = operation.id; changed(next); render();
      panel.querySelector('[data-operation-field="label"]')?.focus();
    } else if (name === 'remove') {
      const next = removeOperation(draft, selectedId); // Block before confirmation if another operation uses an output.
      if (!await confirmOverModal('Remove this operation and its unused outputs?', { confirmLabel: 'Remove operation', danger: false, closeOnConfirm: false, detail: 'This removes the operation and its unused outputs from your draft. The saved Cooking Map changes only when you save the pipeline.' })) return;
      selectedId = next.operations[0]?.id || null; changed(next); render();
    } else if (name === 'up' || name === 'down') {
      const operationId = button.dataset.moveOperation || selectedId;
      const index = draft.operations.findIndex(item => item.id === operationId);
      reorder(operationId, index + (name === 'up' ? -1 : 1));
    }
    else if (name === 'output-food' || name === 'output-ready') {
      const result = addOutput(draft, selectedId, name === 'output-ready' ? 'readiness' : 'component');
      changed(result.document); render(); panel.querySelector(`[data-resource-name="${result.resourceId}"]`)?.focus();
    } else if (name === 'remove-output') { changed(removeOutput(draft, button.dataset.resourceId)); render(); }
    else if (name === 'divide') {
      const result = divideResource(draft, division.resourceId, division.portions);
      division = emptyDivision();
      changed(result.document); selectOperation(result.operationId, { flush: false });
    } else if (name === 'ingredient') {
      const selection = panel.querySelector('[data-add-ingredient]').value;
      if (selection === '') throw new Error('Choose an ingredient from the written recipe.');
      changed(bindIngredient(draft, null, recipe, Number(selection))); render();
    }
  }

  openModal({ title: `${recipe.title} · Cooking Map`, size: 'xl', initialFocus: 'heading',
    content: `<div class="pipeline-workspace"><input type="hidden" id="pipeline-dirty" data-pipeline-dirty value=""><div data-pipeline-toolbar class="pipeline-toolbar"></div><p data-pipeline-status role="status" class="pipeline-status"></p><div data-pipeline-review class="pipeline-review" hidden></div><p data-pipeline-error role="alert" class="pipeline-error" hidden></p><div data-pipeline-content></div></div><div data-pipeline-footer class="modal-panel__footer modal-panel__footer--plain" hidden></div>`,
    onClose: () => { closed = true; graphCleanup(); cleanupSortable(); },
    onSave(mounted) {
      panel = mounted; render();
      panel.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || busy) return;
        if (button.dataset.view) { flushFieldEdits(); view = button.dataset.view; render(); }
        else if (button.dataset.operation) selectOperation(button.dataset.operation);
        else if (button.dataset.command) command(button.dataset.command, button).catch(err => showError(err.message));
      });
      panel.addEventListener('input', event => {
        if (!draft || busy) return;
        const target = event.target, data = target.dataset;
        if ('divideResource' in data || data.portionName || data.portionQuantity) {
          if ('divideResource' in data) division.resourceId = target.value;
          else division.portions[Number(data.portionName || data.portionQuantity) - 1][data.portionName ? 'name' : 'quantity'] = target.value;
          message = '';
          panel.querySelector('[data-pipeline-dirty]').value = dirtyValue();
          panel.querySelector('[data-pipeline-status]').textContent = hasDivisionDraft()
            ? 'Unfinished portions. Create the portions to add them to the pipeline.'
            : dirty ? 'Unsaved pipeline. Review your inputs and outputs before saving.' : 'Build your pipeline by choosing each operation’s inputs and outputs.';
          showError('');
          if (!hasUnsavedChanges()) refreshDirtySnapshot({ defer: false });
          return;
        }
        const next = copy(draft);
        const operation = next.operations.find(item => item.id === selectedId);
        if (data.operationField && operation) {
          operation[data.operationField] = data.operationField === 'equipment' ? target.value.split('\n').map(value => value.trim()).filter(Boolean) : target.value;
        } else if (data.resourceName || data.resourceQuantity) {
          const resource = next.resources.find(item => item.id === (data.resourceName || data.resourceQuantity));
          resource[data.resourceName ? 'name' : 'quantity'] = target.value;
        } else if (data.time && operation) {
          const min = panel.querySelector('[data-time="min"]').value, max = panel.querySelector('[data-time="max"]').value;
          operation.duration = min === '' && max === '' ? null : { min_seconds: min === '' ? NaN : Number(min) * 60, max_seconds: Number(max === '' ? min : max) * 60 };
        } else if (data.temperature && operation) {
          const value = panel.querySelector('[data-temperature="value"]').value;
          operation.temperature = value === '' ? null : { value: Number(value), unit: panel.querySelector('[data-temperature="unit"]').value };
        } else return;
        changed(next);
        if (data.operationField === 'label') {
          panel.querySelector(`[data-operation="${selectedId}"]`)?.setAttribute('aria-label', operation.label || 'Unnamed operation');
          const label = panel.querySelector(`[data-operation-label="${selectedId}"]`);
          if (label) label.textContent = operation.label || 'Unnamed operation';
        }
      });
      panel.addEventListener('change', event => {
        if (!draft || busy) return;
        if (event.target.matches('[data-review-confirm]')) { reviewConfirmed = event.target.checked; return; }
        if (event.target.dataset.bindIngredient) {
          try {
            if (event.target.value === '') {
              const next = copy(draft);
              next.resources.find(resource => resource.id === event.target.dataset.bindIngredient).source_index = null;
              changed(next);
            } else changed(bindIngredient(draft, event.target.dataset.bindIngredient, recipe, Number(event.target.value)));
            render();
          } catch (err) { render(); showError(err.message); }
          return;
        }
        const field = event.target.dataset.inputKind;
        if (!field) return;
        const next = copy(draft), operation = next.operations.find(item => item.id === selectedId);
        operation[field] = event.target.checked ? [...new Set([...operation[field], event.target.value])] : operation[field].filter(value => value !== event.target.value);
        changed(next);
      });
      api.get(`/recipes/${recipe.id}`).then(response => {
        if (!isLive()) return;
        Object.assign(initialRecipe, response.data); recipe = initialRecipe;
        busy = false; render();
      }).catch(err => { if (isLive()) { busy = false; recipe = { ...recipe, pipeline_can_edit: false }; render(); showError(`Could not load the latest recipe. Close this view and try again. ${err.message}`); } });
    },
  });
}
