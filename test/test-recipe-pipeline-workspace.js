import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as model from '../public/utils/recipe-pipeline.js';
import * as edits from '../public/utils/recipe-pipeline-edit.js';

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const recipe = (id = 1) => ({
  id, title: 'Bread', ingredients: [{ name: 'Flour', quantity: '200 g' }], notes: 'Mix and bake.',
  pipeline_can_edit: true, pipeline_revision: 1, pipeline_current_source_hash: 'a'.repeat(64),
  pipeline_review_needed: false,
  pipeline: { schema_version: 1, resources: [
    { id: 'flour', kind: 'ingredient', name: 'Flour', quantity: '200 g', source_index: 0 },
    { id: 'dough', kind: 'component', name: 'Dough', quantity: '', source_index: null },
    { id: 'loaf', kind: 'component', name: 'Loaf', quantity: '', source_index: null },
  ], operations: [
    { id: 'mix', label: 'Make dough', consumes: ['flour'], requires: [], produces: ['dough'], equipment: [], duration: null, temperature: null },
    { id: 'bake', label: 'Bake', consumes: ['dough'], requires: [], produces: ['loaf'], equipment: [], duration: null, temperature: null },
  ] },
});
const provider = () => ({ ...recipe(), pipeline: null, provider_account_id: 5, pipeline_can_edit: false });

// Run the production workspace and recipe-list callback, with only browser
// surfaces and the network doubled. No editor internals or alternate command
// implementation are exposed: interactions use its delegated DOM listeners.
const editorSource = readFileSync(new URL('../public/components/recipe-pipeline-editor.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ');
const pageSource = readFileSync(new URL('../public/pages/recipes.js', import.meta.url), 'utf8');
const listEntry = pageSource.match(/openRecipePipeline\(recipe, \{ onDuplicate:[\s\S]*?\}\);/)[0];
const duplicateSource = pageSource.slice(pageSource.indexOf('async function duplicateRecipe(recipe)'));
const dataKey = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const decode = text => String(text).replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function matches(element, selector) {
  const match = selector.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
  return Boolean(match && dataKey(match[1]) in element.dataset
    && (match[2] === undefined || element.dataset[dataKey(match[1])] === match[2]));
}
function element(attributes = '', value = '') {
  const dataset = {};
  for (const match of attributes.matchAll(/data-([\w-]+)(?:="([^"]*)")?/g)) dataset[dataKey(match[1])] = decode(match[2] || '');
  return {
    dataset, value: decode(attributes.match(/value="([^"]*)"/)?.[1] ?? value),
    name: attributes.match(/name="([^"]*)"/)?.[1] || '', id: attributes.match(/id="([^"]*)"/)?.[1] || '',
    type: attributes.match(/type="([^"]*)"/)?.[1] || 'text', checked: /\bchecked\b/.test(attributes),
    attributes: [], disabled: /\bdisabled\b/.test(attributes),
    focus() {}, scrollIntoView() {}, getClientRects() { return []; }, closest() { return this; },
    matches(selector) { return matches(this, selector); },
  };
}
function makePanel() {
  const parts = Object.fromEntries(['dirty', 'toolbar', 'status', 'review', 'error', 'content', 'footer'].map(name => [name, {
    ...element(`data-pipeline-${name}${name === 'dirty' ? ' id="pipeline-dirty" type="hidden"' : ''}`),
    controls: [], html: '',
    replaceChildren() { this.html = ''; this.controls = []; },
    insertAdjacentHTML(_position, html) {
      this.html += html;
      for (const match of html.matchAll(/<(input|textarea|select)\b([^>]*)(?:>([\s\S]*?)<\/\1>|>)/g)) {
        const field = element(match[2], match[1] === 'textarea' ? match[3] || '' : '');
        if (match[1] === 'select') {
          const options = [...(match[3] || '').matchAll(/<option\b([^>]*)>/g)];
          const option = options.find(item => /\bselected\b/.test(item[1])) || options[0];
          field.value = decode(option?.[1].match(/value="([^"]*)"/)?.[1] || '');
        }
        this.controls.push(field);
      }
    },
  }]));
  return {
    parts, isConnected: true, listeners: {}, contains() { return true; },
    controls() { return [parts.dirty, ...Object.values(parts).flatMap(part => part.controls)]; },
    querySelector(selector) {
      if (selector === '.modal-panel__title') return element();
      if (selector === '[data-pipeline-operations]' && parts.content.html.includes('data-pipeline-operations')) return element('data-pipeline-operations');
      return [...Object.values(parts), ...this.controls()].find(item => matches(item, selector)) || null;
    },
    querySelectorAll(selector) { return selector.startsWith('input:') ? this.controls() : this.controls().filter(item => matches(item, selector)); },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  };
}
function harness({ get, put, post, confirm } = {}) {
  let current, baseline;
  const panels = [], writes = [], copies = [], confirmations = [], sortables = [];
  const serialize = panel => JSON.stringify(panel.controls().map(field => [field.name || field.id,
    field.type === 'checkbox' ? [field.value, field.checked] : field.value]));
  const api = {
    get: get || (async () => ({ data: recipe() })),
    async put(path, body) {
      writes.push(clone(body));
      return put ? put(path, body) : { data: { ...recipe(), pipeline: body.pipeline, pipeline_revision: 2 } };
    },
    async post(path, body) { copies.push({ path, body }); return post(path, body); },
  };
  const context = vm.createContext({
    ...model, ...edits, api, esc: text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    // The real validator receives an ordinary object in its own JS realm.
    validatePipeline: value => model.validatePipeline(clone(value)),
    document: { activeElement: null }, window: {}, t: key => key, state: { recipes: [] }, renderRecipeList() {},
    mountPipelineGraph() { return () => {}; },
    async makeSortable(list, options) {
      const instance = { list, options, destroyed: false, destroy() { this.destroyed = true; } };
      sortables.push(instance); return instance;
    },
    refreshDirtySnapshot() { baseline = serialize(current); },
    async confirmOverModal(message, options) { confirmations.push({ message, options }); return confirm ? confirm() : true; },
    openModal(options) {
      if (current) { current.onClose(); current.isConnected = false; }
      current = makePanel(); current.onClose = options.onClose; panels.push(current); options.onSave(current);
    },
  });
  vm.runInContext(`${editorSource}\n${duplicateSource}\nthis.open = openRecipePipeline; this.openFromList = recipe => { ${listEntry} };`, context);
  return {
    api, panels, writes, copies, confirmations, sortables,
    get panel() { return current; },
    async open(value = recipe(), options) { context.open(value, options); await tick(); },
    async openFromList(value) { context.openFromList(value); await tick(); },
    dirty() { return serialize(current) !== baseline; },
    async click(command, resourceId) { current.listeners.click({ target: element(`data-command="${command}"${resourceId ? ` data-resource-id="${resourceId}"` : ''}`) }); await tick(); },
    async select(operation) { current.listeners.click({ target: element(`data-operation="${operation}"`) }); await tick(); },
    async move(operation, direction) { current.listeners.click({ target: element(`data-command="${direction}" data-move-operation="${operation}"`) }); await tick(); },
    async drop(operation, index) { sortables.at(-1).options.onEnd({ item: { dataset: { operationRow: operation } }, newIndex: index }); await tick(); },
    async view(view) { current.listeners.click({ target: element(`data-view="${view}"`) }); await tick(); },
    input(selector, value) {
      const target = current.querySelector(selector); assert.ok(target, selector);
      target.value = value; current.listeners.input({ target });
    },
    change(selector, checked) {
      const target = current.querySelector(selector); assert.ok(target, selector);
      target.checked = checked; current.listeners.change({ target });
    },
  };
}

test('opening and entering edit are clean; rejected Cancel retains changes and confirmed Cancel restores the saved map', async () => {
  let discard = false;
  const saved = recipe(), h = harness({ confirm: () => discard });
  await h.open(saved); assert.equal(h.dirty(), false);
  await h.click('edit'); assert.equal(h.dirty(), false);
  h.input('[data-operation-field="label"]', 'Knead dough');
  assert.equal(h.dirty(), true);
  await h.click('cancel'); assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Knead dough');
  discard = true; await h.click('cancel'); await h.click('edit');
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Make dough');
  assert.equal(h.dirty(), false); assert.equal(h.writes.length, 0);
});

test('double Save sends one request, in-flight edits are blocked, and a rejected save keeps its draft for retry', async () => {
  const pending = deferred(); let fail = true;
  const h = harness({ put: (_path, body) => fail ? pending.promise : { data: { ...recipe(), pipeline: body.pipeline, pipeline_revision: 2 } } });
  await h.open(); await h.click('edit'); h.input('[data-operation-field="label"]', 'Knead dough');
  await h.click('save'); await h.click('save'); h.input('[data-operation-field="label"]', 'Blocked while saving');
  assert.equal(h.writes.length, 1);
  pending.reject(new Error('Offline')); await tick();
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Knead dough');
  assert.equal(h.dirty(), true); assert.match(h.panel.parts.error.textContent, /unsaved edits are still here/);
  fail = false; await h.click('save'); assert.equal(h.writes.length, 2); assert.equal(h.dirty(), false);
  await h.click('edit'); assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Knead dough');
});

test('unfinished portions survive view and operation switches, stay dirty, and are not silently saved as graph data', async () => {
  const h = harness(); await h.open(); await h.click('edit');
  h.input('[data-divide-resource]', 'flour'); h.input('[data-portion-name="1"]', 'Flour for dough');
  h.input('[data-portion-quantity="1"]', '180 g');
  assert.equal(h.dirty(), true);
  await h.click('edit'); await h.view('written'); await h.view('pipeline'); await h.click('edit'); await h.select('bake');
  assert.equal(h.panel.querySelector('[data-divide-resource]').value, 'flour');
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, 'Flour for dough');
  assert.equal(h.panel.querySelector('[data-portion-quantity="1"]').value, '180 g');
  assert.equal(h.dirty(), true);
  await h.click('save'); assert.equal(h.writes.length, 0); assert.match(h.panel.parts.error.textContent, /Create the portions/);
});

test('Cancel guards portion-only drafts, retains them on refusal and clears them on discard', async () => {
  let discard = false;
  const h = harness({ confirm: () => discard }); await h.open(); await h.click('edit');
  h.input('[data-portion-name="1"]', 'Flour for dough');
  await h.click('cancel'); assert.equal(h.confirmations.length, 1);
  assert.equal(h.confirmations[0].options.danger, false, 'draft discard follows the shared modal discard treatment');
  assert.match(h.confirmations[0].options.detail, /saved Cooking Map stays unchanged/);
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, 'Flour for dough');
  discard = true; await h.click('cancel'); await h.click('edit');
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, ''); assert.equal(h.dirty(), false);
});

function recipeWithUnusedOutput() {
  const saved = recipe();
  saved.pipeline.resources.push({ id: 'spare', kind: 'component', name: 'Spare dough', quantity: '', source_index: null });
  saved.pipeline.operations[1].produces.push('spare');
  return saved;
}

test('removing the selected division material clears its hidden ID and does not block saving empty portion fields', async () => {
  const saved = recipeWithUnusedOutput(), h = harness({ get: async () => ({ data: saved }) });
  await h.open(saved); await h.click('edit'); await h.select('bake');
  h.input('[data-divide-resource]', 'spare');
  await h.click('remove-output', 'spare');
  assert.equal(h.panel.querySelector('[data-divide-resource]').value, '');
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, '');
  await h.click('save');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].pipeline.resources.some(resource => resource.id === 'spare'), false);
});

test('removing the selected division material keeps named portions visible and guarded until a replacement is chosen', async () => {
  const saved = recipeWithUnusedOutput(), h = harness({ get: async () => ({ data: saved }) });
  await h.open(saved); await h.click('edit'); await h.select('bake');
  h.input('[data-divide-resource]', 'spare');
  h.input('[data-portion-name="1"]', 'For dough'); h.input('[data-portion-quantity="1"]', '180 g');
  h.input('[data-portion-name="2"]', 'For dusting'); h.input('[data-portion-quantity="2"]', '20 g');
  await h.click('remove-output', 'spare');
  assert.equal(JSON.parse(h.panel.parts.dirty.value).division.resourceId, '');
  assert.equal(h.panel.querySelector('[data-divide-resource]').value, '');
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, 'For dough');
  assert.equal(h.panel.querySelector('[data-portion-quantity="1"]').value, '180 g');
  assert.equal(h.panel.querySelector('[data-portion-name="2"]').value, 'For dusting');
  assert.equal(h.panel.querySelector('[data-portion-quantity="2"]').value, '20 g');
  assert.equal(h.dirty(), true);
  await h.click('save'); assert.equal(h.writes.length, 0); assert.match(h.panel.parts.error.textContent, /Create the portions/);
  h.input('[data-divide-resource]', 'flour'); await h.click('divide'); await h.click('save');
  assert.equal(h.writes.length, 1);
});

test('failed Create retains portions; successful Create adds the split once, clears scratch and saves only graph data', async () => {
  const h = harness(); await h.open(); await h.click('edit');
  h.input('[data-divide-resource]', 'flour'); h.input('[data-portion-name="1"]', 'Flour for dough');
  h.input('[data-portion-quantity="1"]', '180 g'); await h.click('divide');
  assert.match(h.panel.parts.error.textContent, /Name at least two/);
  assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, 'Flour for dough');
  h.input('[data-portion-name="2"]', 'Flour for dusting'); h.input('[data-portion-quantity="2"]', '20 g');
  await h.click('divide'); assert.equal(h.panel.querySelector('[data-portion-name="1"]').value, '');
  assert.equal(h.panel.querySelector('[data-divide-resource]').value, ''); assert.equal(h.dirty(), true);
  await h.click('save'); assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.keys(h.writes[0]).sort(), ['expected_revision', 'pipeline', 'source_hash']);
  assert.equal(h.writes[0].pipeline.operations.length, 3);
  const split = h.writes[0].pipeline.operations.find(operation => operation.label === 'Divide Flour');
  assert.equal(h.writes[0].pipeline.operations.find(operation => operation.id === 'mix').consumes[0], split.produces[0]);
  assert.equal(h.dirty(), false);
});

test('double native-copy click from the recipe list sends one POST and opens the completed copy', async () => {
  const pending = deferred(); const h = harness({ get: async () => ({ data: provider() }), post: () => pending.promise });
  await h.openFromList(provider()); await h.click('duplicate'); await h.click('duplicate');
  assert.equal(h.copies.length, 1); assert.equal(h.copies[0].path, '/recipes/1/duplicate');
  h.api.get = async () => ({ data: recipe(3) }); pending.resolve({ data: recipe(3) }); await tick();
  assert.equal(h.panels.length, 2); await h.click('edit'); await h.click('save');
  assert.equal(h.writes.length, 1);
});

test('late native-copy completion cannot replace a newer dirty recipe workspace', async () => {
  const pending = deferred(); const h = harness({ get: async () => ({ data: provider() }), post: () => pending.promise });
  await h.openFromList(provider()); await h.click('duplicate');
  h.api.get = async () => ({ data: recipe(2) }); await h.open(recipe(2)); await h.click('edit');
  h.input('[data-operation-field="label"]', 'Keep this newer draft'); const newer = h.panel;
  pending.resolve({ data: recipe(3) }); await tick();
  assert.equal(h.panels.length, 2); assert.equal(h.panel, newer); assert.equal(newer.isConnected, true);
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Keep this newer draft'); assert.equal(h.dirty(), true);
});

test('native-copy completion during mobile close animation cannot reopen the workspace', async () => {
  const pending = deferred(); const h = harness({ get: async () => ({ data: provider() }), post: () => pending.promise });
  await h.openFromList(provider()); await h.click('duplicate'); h.panel.onClose();
  assert.equal(h.panel.isConnected, true, 'the closing animation has not detached its panel');
  pending.resolve({ data: recipe(3) }); await tick(); assert.equal(h.panels.length, 1);
});

test('failed duplicate unlocks the original workspace for retry', async () => {
  const pending = deferred(); const h = harness({ get: async () => ({ data: provider() }), post: () => pending.promise });
  await h.openFromList(provider()); await h.click('duplicate'); pending.reject(new Error('Offline')); await tick();
  await h.click('duplicate'); assert.equal(h.copies.length, 2); assert.equal(h.panels.length, 1);
});

test('review remains required and source/revision conflicts retain local edits', async () => {
  const current = { ...recipe(), pipeline_review_needed: true };
  const h = harness({ get: async () => ({ data: current }), put: async () => { throw new Error('The recipe ingredients or instructions changed.'); } });
  await h.open(current); await h.click('edit'); h.input('[data-operation-field="label"]', 'Reviewed kneading');
  await h.click('save'); assert.equal(h.writes.length, 0); assert.match(h.panel.parts.error.textContent, /confirm the review/);
  h.change('[data-review-confirm]', true); await h.click('save');
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].source_hash, current.pipeline_current_source_hash);
  assert.equal(h.writes[0].expected_revision, 1);
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Reviewed kneading'); assert.equal(h.dirty(), true);
});

test('lost successful response leaves a safe stale-revision conflict and preserves edits made before retry', async () => {
  let serverRevision = 1;
  const h = harness({ put: async (_path, body) => {
    if (body.expected_revision !== serverRevision) throw new Error('This pipeline was changed elsewhere. Reopen it before saving your changes.');
    serverRevision++; throw new Error('Response lost after commit');
  } });
  await h.open(); await h.click('edit'); h.input('[data-operation-field="label"]', 'Committed draft'); await h.click('save');
  h.input('[data-operation-field="label"]', 'New local work after failed response'); await h.click('save');
  assert.equal(serverRevision, 2); assert.deepEqual(h.writes.map(write => write.expected_revision), [1, 1]);
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'New local work after failed response');
  assert.match(h.panel.parts.error.textContent, /Reopen it before saving/); assert.equal(h.dirty(), true);
});

test('late save response does not update a closed workspace or reset a newer draft dirty baseline', async () => {
  const pending = deferred(), oldRecipe = recipe();
  const h = harness({ put: () => pending.promise }); await h.open(oldRecipe); await h.click('edit');
  h.input('[data-operation-field="label"]', 'Older saved draft'); await h.click('save');
  h.api.get = async () => ({ data: recipe(2) }); await h.open(recipe(2)); await h.click('edit');
  h.input('[data-operation-field="label"]', 'Keep newer draft'); const newer = h.panel;
  pending.resolve({ data: { ...recipe(), pipeline: h.writes[0].pipeline, pipeline_revision: 2 } }); await tick();
  assert.equal(h.panel, newer); assert.equal(oldRecipe.pipeline_revision, 1);
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Keep newer draft'); assert.equal(h.dirty(), true);
});

test('drag reorder flushes field drafts, retains selection and preserves the cooking graph', async () => {
  const h = harness(); await h.open(); await h.click('edit');
  h.panel.querySelector('[data-operation-field="label"]').value = 'Patiently mix dough';
  h.panel.querySelector('[data-operation-field="equipment"]').value = 'Bowl\nWooden spoon';
  h.panel.querySelector('[data-resource-name="dough"]').value = 'Soft dough';
  h.panel.querySelector('[data-resource-quantity="dough"]').value = 'One batch';
  h.panel.querySelector('[data-time="min"]').value = '4';
  h.panel.querySelector('[data-temperature="value"]').value = '22';
  h.panel.querySelector('[data-temperature="unit"]').value = 'C';
  const initialSortable = h.sortables.at(-1);
  await h.drop('mix', 1);
  assert.equal(initialSortable.destroyed, true, 'rerender disposes the old drag instance');
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Patiently mix dough');
  assert.match(h.panel.parts.content.html, /data-operation="mix" aria-pressed="true"/);
  await h.click('save');
  assert.equal(h.writes.length, 1, h.panel.parts.error.textContent);
  const saved = h.writes[0].pipeline;
  assert.deepEqual(saved.operations.map(operation => operation.id), ['bake', 'mix']);
  const mix = saved.operations[1];
  assert.deepEqual(mix.consumes, ['flour']); assert.deepEqual(mix.produces, ['dough']);
  assert.deepEqual(mix.equipment, ['Bowl', 'Wooden spoon']);
  assert.deepEqual(mix.duration, { min_seconds: 240, max_seconds: 240 });
  assert.deepEqual(mix.temperature, { value: 22, unit: 'C' });
  assert.equal(saved.resources.find(resource => resource.id === 'dough').name, 'Soft dough');
  assert.equal(saved.resources.find(resource => resource.id === 'dough').quantity, 'One batch');
  assert.deepEqual(model.derivePipeline(saved).order.map(operation => operation.id), ['mix', 'bake']);
});

test('inline chevrons reorder their own operation while keeping the current operation selected', async () => {
  const h = harness(); await h.open(); await h.click('edit'); await h.select('bake');
  h.panel.querySelector('[data-operation-field="label"]').value = 'Bake until golden';
  await h.move('mix', 'down');
  assert.equal(h.panel.querySelector('[data-operation-field="label"]').value, 'Bake until golden');
  assert.match(h.panel.parts.content.html, /data-operation="bake" aria-pressed="true"/);
  await h.click('save');
  assert.deepEqual(h.writes[0].pipeline.operations.map(operation => operation.id), ['bake', 'mix']);
  assert.equal(h.writes[0].pipeline.operations[0].label, 'Bake until golden');
});
